/* שכבת נתונים בענן (Supabase). האפליקציה עובדת על state בזיכרון, וכל commit() שולח לענן רק את מה ששונה. */
(function () {
  'use strict';
  const SB = window.SB;
  const state = { brands: [], series: [], units: [], parts: [], diagrams: [] };
  let catalog = [];
  const idx = {};
  const ORDER = ['brands', 'series', 'units', 'parts', 'diagrams'];     // סדר התלויות (הורה לפני ילד)
  const UP_CHUNK = 500, DEL_CHUNK = 100, CAT_CHUNK = 1000;
  const uid = (p) => (p || 'i') + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const T = (v) => (v == null ? '' : String(v));
  const N = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const replacer = (k, v) => (k && k[0] === '_' ? undefined : v);

  // המרה בין אובייקטי האפליקציה לעמודות הטבלה
  const MAP = {
    brands: {
      parent: null,
      to: (o) => ({ id: o.id, name: T(o.name), logo: T(o.logo), created: N(o.created) }),
      from: (r) => ({ id: r.id, name: r.name, logo: r.logo || '', created: N(r.created) })
    },
    series: {
      parent: 'brand_id',
      to: (o) => ({ id: o.id, brand_id: o.brandId, name: T(o.name), year_label: T(o.year), notes: T(o.notes) }),
      from: (r) => ({ id: r.id, brandId: r.brand_id, name: r.name, year: r.year_label || '', notes: r.notes || '' })
    },
    units: {
      parent: 'brand_id',
      to: (o) => ({ id: o.id, brand_id: o.brandId, unit_type: o.type, model: T(o.model), product_code: T(o.productCode), chart_ref: T(o.chartRef), capacity: T(o.capacity), notes: T(o.notes), series_ids: Array.isArray(o.seriesIds) ? o.seriesIds.map(T) : [], has_img: !!o.hasImg }),
      from: (r) => ({ id: r.id, brandId: r.brand_id, type: r.unit_type, model: r.model, productCode: r.product_code || '', chartRef: r.chart_ref || '', capacity: r.capacity || '', notes: r.notes || '', seriesIds: Array.isArray(r.series_ids) ? r.series_ids : [], hasImg: !!r.has_img })
    },
    parts: {
      parent: 'unit_id',
      to: (o) => ({ id: o.id, unit_id: o.unitId, item: T(o.item), qty: T(o.qty), name: T(o.name), description: T(o.desc), t_sku: T(o.tSku), m_sku: T(o.mSku), notes: T(o.notes), has_img: !!o.hasImg }),
      from: (r) => ({ id: r.id, unitId: r.unit_id, item: r.item || '', qty: r.qty || '', name: r.name, desc: r.description || '', tSku: r.t_sku || '', mSku: r.m_sku || '', notes: r.notes || '', hasImg: !!r.has_img })
    },
    diagrams: {
      parent: 'unit_id',
      to: (o) => ({ id: o.id, unit_id: o.unitId, name: T(o.name), file_name: T(o.fileName), mime: T(o.mime), size: N(o.size), hash: T(o.hash), created: N(o.created), source: T(o.source) }),
      from: (r) => ({ id: r.id, unitId: r.unit_id, name: r.name, fileName: r.file_name || '', mime: r.mime || '', size: N(r.size), hash: r.hash || '', created: N(r.created), source: r.source || '' })
    }
  };
  let snap = {};          // table -> Map(id -> { j: json, parent })  מה שנמצא כרגע בענן
  let catSnap = new Map();
  ORDER.forEach((t) => { snap[t] = new Map(); });
  const catRow = (c) => ({ t_sku: T(c.tSku), descr: T(c.desc), m_sku: T(c.mSku) });

  const push = (map, key, val) => { let a = map.get(key); if (!a) map.set(key, (a = [])); a.push(val); };
  function rebuild() {
    idx.brand = new Map(state.brands.map((b) => [b.id, b]));
    idx.series = new Map(state.series.map((s) => [s.id, s]));
    idx.unit = new Map(state.units.map((u) => [u.id, u]));
    idx.partsByUnit = new Map();
    idx.partSkus = new Set();
    state.parts.forEach((p) => { push(idx.partsByUnit, p.unitId, p); if (p.tSku) idx.partSkus.add(p.tSku); });
    idx.unitsBySeries = new Map();
    idx.unitsByBrand = new Map();
    state.units.forEach((u) => {
      push(idx.unitsByBrand, u.brandId, u);
      (u.seriesIds || []).forEach((sid) => push(idx.unitsBySeries, sid, u));
    });
    idx.seriesByBrand = new Map();
    state.series.forEach((s) => push(idx.seriesByBrand, s.brandId, s));
    idx.diagByUnit = new Map();
    state.diagrams.forEach((d) => push(idx.diagByUnit, d.unitId, d));
    idx.cat = new Map(catalog.map((c) => [c.tSku, c]));
  }

  // ----- טעינה מהענן -----
  async function fetchAll(table, order) {
    const PAGE = 1000;
    const first = await SB.select(table, { order, from: 0, to: PAGE - 1 });
    const rows = first.rows.slice();
    if (first.total != null && first.total > PAGE) {
      const starts = [];
      for (let s = PAGE; s < first.total; s += PAGE) starts.push(s);
      const pages = new Array(starts.length);
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(4, starts.length) }, async () => {
        while (next < starts.length) { const i = next++; pages[i] = (await SB.select(table, { order, from: starts[i], to: starts[i] + PAGE - 1 })).rows; }
      }));
      pages.forEach((p) => { for (const r of p) rows.push(r); });
    } else if (first.total == null && rows.length === PAGE) {
      for (let from = PAGE; ; from += PAGE) {
        const pg = (await SB.select(table, { order, from, to: from + PAGE - 1 })).rows;
        for (const r of pg) rows.push(r);
        if (pg.length < PAGE) break;
      }
    }
    return rows;
  }
  async function loadAll() {
    const res = {};
    for (const t of ORDER) res[t] = await fetchAll(t, 'id');
    const cat = await fetchAll('catalog', 't_sku');
    // מחליפים רק אחרי שהכל נטען בהצלחה
    ORDER.forEach((t) => {
      state[t] = res[t].map(MAP[t].from);
      snap[t] = new Map();
      state[t].forEach((o) => { const row = MAP[t].to(o); snap[t].set(row.id, { j: JSON.stringify(row), parent: MAP[t].parent ? row[MAP[t].parent] : null }); });
    });
    catalog = cat.map((r) => ({ tSku: r.t_sku, desc: r.descr || '', mSku: r.m_sku || '' }));
    catSnap = new Map();
    catalog.forEach((c) => { const row = catRow(c); catSnap.set(row.t_sku, JSON.stringify(row)); });
    rebuild();
    Store.lastLoad = Date.now();
  }

  // ----- סנכרון שינויים לענן -----
  function diffTable(t) {
    const m = MAP[t], old = snap[t], cur = new Set(), ups = [];
    for (const o of state[t]) {
      const row = m.to(o);
      if (cur.has(row.id)) continue;
      cur.add(row.id);
      const j = JSON.stringify(row), prev = old.get(row.id);
      if (!prev || prev.j !== j) ups.push({ row, j });
    }
    const dels = [];
    for (const id of old.keys()) if (!cur.has(id)) dels.push(id);
    return { ups, dels };
  }
  async function doSync() {
    const plan = {};
    ORDER.forEach((t) => { plan[t] = diffTable(t); });
    // כשהורה נמחק, המסד מוחק את הילדים לבד (cascade). אין צורך לשלוח מחיקה לכל אחד.
    const delBrands = new Set(plan.brands.dels), delUnits = new Set(plan.units.dels);
    const cascaded = { series: [], units: [], parts: [], diagrams: [] };
    const skipChildren = (t, parents) => {
      const keep = [];
      plan[t].dels.forEach((id) => { if (parents.has(snap[t].get(id).parent)) cascaded[t].push(id); else keep.push(id); });
      plan[t].dels = keep;
    };
    skipChildren('series', delBrands); skipChildren('units', delBrands);
    skipChildren('parts', delUnits); skipChildren('diagrams', delUnits);
    // קודם מחיקות (מהילד להורה), אחר כך הוספות ועדכונים (מההורה לילד)
    for (const t of [...ORDER].reverse()) {
      const ids = plan[t].dels;
      for (let i = 0; i < ids.length; i += DEL_CHUNK) {
        const chunk = ids.slice(i, i + DEL_CHUNK);
        await SB.remove(t, 'id', chunk);
        chunk.forEach((id) => snap[t].delete(id));
      }
    }
    for (const t of ORDER) {
      const ups = plan[t].ups;
      for (let i = 0; i < ups.length; i += UP_CHUNK) {
        const chunk = ups.slice(i, i + UP_CHUNK);
        await SB.upsert(t, chunk.map((x) => x.row));
        chunk.forEach((x) => snap[t].set(x.row.id, { j: x.j, parent: MAP[t].parent ? x.row[MAP[t].parent] : null }));
      }
    }
    Object.keys(cascaded).forEach((t) => cascaded[t].forEach((id) => snap[t].delete(id)));
  }
  async function doCatalogSync() {
    const cur = new Set(), ups = [];
    for (const c of catalog) {
      const row = catRow(c);
      if (!row.t_sku || cur.has(row.t_sku)) continue;
      cur.add(row.t_sku);
      const j = JSON.stringify(row);
      if (catSnap.get(row.t_sku) !== j) ups.push({ row, j });
    }
    const dels = [...catSnap.keys()].filter((k) => !cur.has(k));
    for (let i = 0; i < dels.length; i += DEL_CHUNK) {
      const chunk = dels.slice(i, i + DEL_CHUNK);
      await SB.remove('catalog', 't_sku', chunk);
      chunk.forEach((k) => catSnap.delete(k));
    }
    for (let i = 0; i < ups.length; i += CAT_CHUNK) {
      const chunk = ups.slice(i, i + CAT_CHUNK);
      await SB.upsert('catalog', chunk.map((x) => x.row));
      chunk.forEach((x) => catSnap.set(x.row.t_sku, x.j));
    }
  }

  let pending = 0, chain = Promise.resolve();
  const status = (s, msg) => { if (Store.onStatus) Store.onStatus(s, msg); };
  function enqueue(fn) {
    pending++;
    status('saving');
    const run = chain.then(fn);
    chain = run.catch(() => {});
    return run.then(() => { if (--pending === 0) status('ok'); }, async (err) => {
      pending--;
      let reloaded = false;
      if (!(err && err.code === 'AUTH')) {
        try { await loadAll(); reloaded = true; if (Store.onReload) Store.onReload(); status(pending ? 'saving' : 'ok'); }
        catch (e2) {
          status('error', 'יש שינויים שלא נשמרו בענן. בדוק את החיבור ולחץ "נסה שוב".');
          if (Store.onReload) Store.onReload();    // מציג את השינויים הממתינים במקום להסתיר אותם
        }
      }
      if (err && err.code !== 'AUTH') {
        const named = /^(השמירה|המחיקה|העלאת)/.test(err.message);
        err.message = (named ? '' : 'השמירה בענן נכשלה: ') + err.message + (reloaded ? ' (הנתונים נטענו מחדש מהענן)' : '');
      }
      throw err;
    });
  }

  const fileCache = new Map();
  const fpath = (key) => key.replace(':', '/');
  function cacheSet(key, blob) { fileCache.delete(key); fileCache.set(key, blob); while (fileCache.size > 24) fileCache.delete(fileCache.keys().next().value); }

  const Store = {
    state, idx, uid, lastLoad: 0, onStatus: null, onReload: null,
    async load() { await loadAll(); },
    async reload() { await chain.catch(() => {}); await loadAll(); },
    clear() { ORDER.forEach((t) => { state[t] = []; snap[t] = new Map(); }); catalog = []; catSnap = new Map(); fileCache.clear(); rebuild(); },
    commit() { rebuild(); return enqueue(doSync); },
    retry() { return enqueue(async () => { await doSync(); await doCatalogSync(); }); },
    getCatalog: () => catalog,
    setCatalog(arr) { catalog = arr; idx.cat = new Map(catalog.map((c) => [c.tSku, c])); return enqueue(doCatalogSync); },
    cloneState() { return JSON.parse(JSON.stringify(state, replacer)); },
    replaceState(obj) {
      ORDER.forEach((t) => { state[t] = Array.isArray(obj[t]) ? obj[t] : []; });
      rebuild();
      return enqueue(doSync);
    },
    exportJSON() { return JSON.stringify({ v: 1, exported: new Date().toISOString(), state, catalog }, replacer); },
    async putFile(key, blob) { await SB.putFile(fpath(key), blob); cacheSet(key, blob); },
    async getFile(key) {
      if (fileCache.has(key)) return fileCache.get(key);
      const b = await SB.getFile(fpath(key));
      if (b) cacheSet(key, b);
      return b;
    },
    async delFile(key) { fileCache.delete(key); await SB.delFile(fpath(key)); }
  };
  window.Store = Store;
})();
