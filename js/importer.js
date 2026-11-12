/* ייבוא וייצוא Excel: זיהוי אוטומטי של גיליונות יחידה (מאייד/מעבה), קטלוג מק"טים כללי, וחילוץ סכמות (תמונות) מהגיליונות. */
(function () {
  'use strict';
  const PLACEHOLDERS = new Set(['none', 'null', 'n/a', 'na', '-', '--', '—', '0', 'לאקיים', 'אין']);
  const txt = (v) => {
    if (v === null || v === undefined) return '';
    if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
    return String(v).replace(/\s+/g, ' ').trim();
  };
  const isPlaceholder = (s) => !s || PLACEHOLDERS.has(s.toLowerCase().replace(/\s/g, '')) || /^#(null!|div\/0!|value!|ref!|name\?|num!|n\/a|err)$/i.test(s);
  const cleanSku = (v) => { const s = txt(v); return isPlaceholder(s) ? '' : s; };
  const normH = (v) => txt(v).toLowerCase().replace(/[\s"'״׳`.\-_/\\:;()[\]]/g, '');
  const lc = (s) => String(s || '').trim().toLowerCase();

  function detectUnitSheet(rows) {
    for (let r = 0; r < Math.min(rows.length, 40); r++) {
      const hs = (rows[r] || []).map(normH);
      const t = hs.findIndex((h) => h.includes('tadiranpn') || h.includes('מקטתדיראן') || h === 'tadiran');
      const n = hs.findIndex((h) => h.includes('partdescription') || h.includes('partname') || h === 'שםהחלק' || h === 'שםחלק' || h.includes('תיאורהחלק'));
      if (t >= 0 && n >= 0) {
        const col = (pred) => hs.findIndex(pred);
        return {
          headerRow: r,
          c: {
            item: col((h) => h === 'no' || h === 'מס' || h === 'מספר' || h === 'item' || h === 'itemno' || h === '#' || h === 'פריט' || h.includes('מספרפריט')),
            name: n,
            tSku: t,
            mSku: col((h) => h === 'partcode' || h === 'oempn' || h.includes('מקטיצרן') || h.includes('manufacturer') || h.includes('מספרחלקיצרן')),
            desc: col((h) => /[\u4e00-\u9fff]/.test(h) || h === 'תיאור' || h === 'description'),
            qty: col((h) => h === 'qty' || h === 'כמות' || h === 'quantity'),
            notes: col((h) => h === 'הערות' || h === 'הערה' || h === 'remarks' || h === 'notes' || h === 'note')
          }
        };
      }
    }
    return null;
  }

  function detectCatalog(rows) {
    for (let r = 0; r < Math.min(rows.length, 10); r++) {
      const hs = (rows[r] || []).map(normH);
      const t = hs.findIndex((h) => h === 'חומר' || h === 'material' || h === 'מקטתדיראן' || h === 'מקט');
      const d = hs.findIndex((h) => h === 'תיאור' || h === 'description' || h === 'שםהחלק');
      if (t >= 0 && d >= 0) {
        const m = hs.findIndex((h) => h.includes('מספרחלקיצרן') || h.includes('מקטיצרן'));
        return { headerRow: r, t, d, m };
      }
    }
    return null;
  }

  function readMeta(rows, upto) {
    const meta = {};
    const rx = (s, re) => { const m = s.match(re); return m ? m[1].trim() : ''; };
    for (let r = 0; r < upto; r++) {
      for (const cell of rows[r] || []) {
        const s = txt(cell);
        if (!s) continue;
        meta.model = meta.model || rx(s, /^(?:product\s*model|model|דגם)\s*[:：]\s*(.+)$/i);
        meta.code = meta.code || rx(s, /^(?:product\s*code|קוד\s*מוצר)\s*[:：]\s*(.+)$/i);
        meta.chart = meta.chart || rx(s, /^ev\s*chart\s*[:：]\s*(.+)$/i);
      }
    }
    return meta;
  }

  function detectType(sheetName, model) {
    if (/(^|[^a-z])(idu|indoor)([^a-z]|$)|פנימי|מאייד/i.test(sheetName)) return 'evaporator';
    if (/(^|[^a-z])(odu|outdoor)([^a-z]|$)|חיצוני|מעבה/i.test(sheetName)) return 'condenser';
    if (/\/I(?![A-Za-z0-9])/.test(model || '')) return 'evaporator';
    if (/\/O(?![A-Za-z0-9])/.test(model || '')) return 'condenser';
    return '';
  }

  function seriesFromSheet(name) {
    let s = name
      .replace(/(^|[^a-z])(idu|odu|indoor|outdoor)(?=[^a-z]|$)/gi, '$1')
      .replace(/יחידה\s*(פנימית|חיצונית)|פנימית|חיצונית|מאייד|מעבה/g, '');
    s = s.replace(/^[\s_\-+]+|[\s_\-+]+$/g, '').replace(/\s+/g, ' ');
    return s || name.trim();
  }

  function parseUnitSheet(sheet, rows, det) {
    const { headerRow, c } = det;
    const meta = readMeta(rows, headerRow);
    const model = meta.model || '';
    const type = detectType(sheet, model);
    const good = [], bad = [], dups = [];
    const seen = new Set();
    for (let r = headerRow + 1; r < rows.length; r++) {
      const row = rows[r] || [];
      const name = txt(row[c.name]);
      const rawT = txt(row[c.tSku]);
      const tSku = cleanSku(rawT);
      const mSku = c.mSku >= 0 ? cleanSku(row[c.mSku]) : '';
      if (!name && !rawT && !mSku) continue;
      const p = {
        row: r + 1,
        item: c.item >= 0 ? txt(row[c.item]) : '',
        name,
        desc: c.desc >= 0 ? txt(row[c.desc]) : '',
        qty: c.qty >= 0 ? txt(row[c.qty]) : '',
        tSku,
        mSku,
        notes: c.notes >= 0 ? txt(row[c.notes]) : '',
        rawT
      };
      if (!name) { bad.push({ ...p, reason: 'חסר שם חלק', importable: false }); continue; }
      if (!tSku || /^\d{1,5}$/.test(tSku)) {
        const reason = rawT && !isPlaceholder(rawT) ? `מק״ט תדיראן לא תקין (${rawT})` : 'חסר מק״ט תדיראן';
        bad.push({ ...p, tSku: '', reason, importable: true });
        continue;
      }
      if (seen.has(tSku)) { dups.push({ ...p, reason: 'מק״ט כפול באותה יחידה' }); continue; }
      seen.add(tSku);
      good.push(p);
    }
    return {
      kind: 'unit',
      sheet,
      seriesName: seriesFromSheet(sheet),
      type,
      model: model || sheet,
      modelFromFile: !!model,
      productCode: meta.code || '',
      chartRef: meta.chart || '',
      year: '',
      include: !!type,
      images: [], useImages: true, imageWarn: '',
      good, bad, dups
    };
  }

  function parseCatalog(sheet, rows, det) {
    const out = [];
    const seen = new Set();
    let dup = 0;
    for (let r = det.headerRow + 1; r < rows.length; r++) {
      const row = rows[r] || [];
      const tSku = cleanSku(row[det.t]);
      if (!tSku) continue;
      if (seen.has(tSku)) { dup++; continue; }
      seen.add(tSku);
      out.push({ tSku, desc: txt(row[det.d]), mSku: det.m >= 0 ? cleanSku(row[det.m]) : '' });
    }
    return { kind: 'catalog', sheet, rows: out, dup };
  }

  // book = תוצאת SheetIO.read
  function parseWorkbook(book) {
    const units = [], catalogs = [], ignored = [];
    book.names.forEach((name) => {
      const rows = book.getRows(name);
      if (!rows.length) { ignored.push({ sheet: name, reason: 'גיליון ריק' }); return; }
      const u = detectUnitSheet(rows);
      if (u) { units.push(parseUnitSheet(name, rows, u)); return; }
      const c = detectCatalog(rows);
      if (c) { catalogs.push(parseCatalog(name, rows, c)); return; }
      ignored.push({ sheet: name, reason: 'לא זוהו כותרות מתאימות (נדרשים שם חלק ומק״ט תדיראן)' });
    });
    // איחוד כתיבות שונות של אותו שם דגם (אותיות גדולות/קטנות)
    const best = new Map();
    units.forEach((u) => {
      const k = lc(u.seriesName);
      const score = (u.seriesName.match(/[A-Z]/g) || []).length;
      if (!best.has(k) || score > best.get(k).score) best.set(k, { name: u.seriesName, score });
    });
    units.forEach((u) => { u.seriesName = best.get(lc(u.seriesName)).name; });
    return { units, catalogs, ignored };
  }

  // ===== חילוץ תמונות (סכמות) =====
  const u16 = (b, p) => b[p] | (b[p + 1] << 8);
  const u32 = (b, p) => (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0;
  const i32 = (b, p) => b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24);
  const concat = (parts) => {
    let n = 0; parts.forEach((x) => { n += x.length; });
    const out = new Uint8Array(n); let o = 0;
    parts.forEach((x) => { out.set(x, o); o += x.length; });
    return out;
  };
  function hashBytes(u8) {
    let h1 = 0x811c9dc5, h2 = 0x01000193 ^ u8.length;
    for (let i = 0; i < u8.length; i++) {
      h1 ^= u8[i]; h1 = Math.imul(h1, 16777619);
      h2 = Math.imul(h2 ^ u8[i], 2654435761); h2 ^= h2 >>> 13;
    }
    return (h1 >>> 0).toString(16) + (h2 >>> 0).toString(16) + ':' + u8.length;
  }

  function dibToRgba(bmi, bits) {
    const hs = u32(bmi, 0);
    if (hs < 40) throw new Error('כותרת DIB לא נתמכת');
    const w = i32(bmi, 4), hRaw = i32(bmi, 8), bpp = u16(bmi, 14), comp = u32(bmi, 16);
    let clrUsed = u32(bmi, 32);
    if (comp !== 0 && comp !== 3) throw new Error('דחיסת DIB לא נתמכת');
    const W = Math.abs(w), H = Math.abs(hRaw), bottomUp = hRaw > 0;
    if (!W || !H || W > 12000 || H > 12000) throw new Error('גודל תמונה לא תקין');
    let pal = null;
    if (bpp <= 8) {
      if (!clrUsed) clrUsed = 1 << bpp;
      pal = bmi.subarray(hs, hs + clrUsed * 4);
    } else if (bpp !== 24 && bpp !== 32) throw new Error('עומק צבע לא נתמך: ' + bpp);
    const stride = ((W * bpp + 31) >> 5) << 2;
    if (bits.length < stride * H) throw new Error('נתוני תמונה חסרים');
    const out = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) {
      const src = (bottomUp ? H - 1 - y : y) * stride;
      let d = y * W * 4;
      for (let x = 0; x < W; x++, d += 4) {
        if (bpp === 32 || bpp === 24) {
          const q = src + x * (bpp >> 3);
          out[d] = bits[q + 2]; out[d + 1] = bits[q + 1]; out[d + 2] = bits[q];
        } else {
          const bitPos = x * bpp;
          const idx = (bits[src + (bitPos >> 3)] >> (8 - bpp - (bitPos & 7))) & ((1 << bpp) - 1);
          out[d] = pal[idx * 4 + 2]; out[d + 1] = pal[idx * 4 + 1]; out[d + 2] = pal[idx * 4];
        }
        out[d + 3] = 255;
      }
    }
    return { W, H, rgba: out };
  }
  function rawDibToRgba(dib) {
    const hs = u32(dib, 0), bpp = u16(dib, 14), comp = u32(dib, 16);
    let colors = u32(dib, 32);
    if (bpp <= 8 && !colors) colors = 1 << bpp;
    const off = hs + (bpp <= 8 ? colors * 4 : 0) + (comp === 3 && hs === 40 ? 12 : 0);
    return dibToRgba(dib, dib.subarray(off));
  }
  // EMF שמכיל תמונת bitmap (כך Excel שומר תמונות מודבקות)
  function emfToRgba(emf) {
    let off = 0;
    while (off + 8 <= emf.length) {
      const t = u32(emf, off), size = u32(emf, off + 4);
      if (size < 8) break;
      if (t === 81 || t === 80) { // STRETCHDIBITS / SETDIBITSTODEVICE
        const offBmi = u32(emf, off + 48), cbBmi = u32(emf, off + 52), offBits = u32(emf, off + 56), cbBits = u32(emf, off + 60);
        return dibToRgba(emf.subarray(off + offBmi, off + offBmi + cbBmi), emf.subarray(off + offBits, off + offBits + cbBits));
      }
      if (t === 14) break;
      off += size;
    }
    throw new Error('EMF וקטורי');
  }
  function canvasOf(W, H, rgba) {
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    c.getContext('2d').putImageData(new ImageData(rgba, W, H), 0, 0);
    return c;
  }
  const canvasBlob = (c, type) => new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('המרת תמונה נכשלה'))), type));
  async function makeThumb(source) {
    const bmp = source instanceof Blob ? await createImageBitmap(source) : source;
    const k = Math.min(1, 240 / bmp.width);
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bmp.width * k)); c.height = Math.max(1, Math.round(bmp.height * k));
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    g.drawImage(bmp, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.8);
  }
  async function finishImage(kind, bytes) {
    if (kind === 'png' || kind === 'jpeg') {
      const blob = new Blob([bytes], { type: kind === 'png' ? 'image/png' : 'image/jpeg' });
      const bmp = await createImageBitmap(blob);
      return { blob, ext: kind === 'png' ? 'png' : 'jpg', hash: hashBytes(bytes), w: bmp.width, h: bmp.height, thumb: await makeThumb(bmp) };
    }
    const r = kind === 'emf' ? emfToRgba(bytes) : rawDibToRgba(bytes);
    const canvas = canvasOf(r.W, r.H, r.rgba);
    return { blob: await canvasBlob(canvas, 'image/png'), ext: 'png', hash: hashBytes(new Uint8Array(r.rgba.buffer)), w: r.W, h: r.H, thumb: await makeThumb(canvas) };
  }

  // ---- OfficeArt (תבנית התמונות בקבצי XLS) ----
  function artWalk(b, start, end, visit) {
    let p = start;
    while (p + 8 <= end) {
      const vi = u16(b, p), type = u16(b, p + 2), len = u32(b, p + 4);
      const rec = { ver: vi & 0xf, inst: vi >> 4, type, len, ds: p + 8, end: Math.min(end, p + 8 + len) };
      visit(rec);
      if (rec.ver === 0xf) artWalk(b, rec.ds, rec.end, visit);
      p += 8 + len;
    }
  }
  function decodeBlip(b, p, end) {
    const inst = u16(b, p) >> 4, type = u16(b, p + 2), len = u32(b, p + 4);
    const ds = p + 8, e = Math.min(end, ds + len);
    if (type === 0xf01a || type === 0xf01b || type === 0xf01c) {
      const uid2 = inst === 0x3d5 || inst === 0x217 || inst === 0x543;
      const h = ds + (uid2 ? 32 : 16);
      const cbSave = u32(b, h + 28), comp = b[h + 32];
      let data = b.subarray(h + 34, Math.min(e, h + 34 + cbSave));
      if (comp === 0) data = window.SheetIO.inflateRaw(data.subarray(2)); // zlib: דילוג על כותרת של 2 בתים
      return { kind: type === 0xf01a ? 'emf' : type === 0xf01b ? 'wmf' : 'pict', bytes: data };
    }
    if (type === 0xf01d || type === 0xf01e || type === 0xf01f || type === 0xf029) {
      const uid2 = [0x46b, 0x6e3, 0x6e1, 0x7a9, 0x6e5].includes(inst);
      return { kind: type === 0xf01d ? 'jpeg' : type === 0xf01e ? 'png' : type === 0xf01f ? 'dib' : 'tiff', bytes: b.subarray(ds + (uid2 ? 32 : 16) + 1, e) };
    }
    return null;
  }

  async function imagesFromXls(book) {
    const w = book.workbook;
    const group = [], byOffset = new Map(book.sheetInfo.map((s) => [s.off, s.name]));
    const sheetDraw = [];
    let off = 0, depth = 0, curSheet = null, lastDrawing = null, lastGroup = false;
    while (off + 4 <= w.length) {
      const rt = u16(w, off), ln = u16(w, off + 2), d = w.subarray(off + 4, off + 4 + ln);
      if (rt === 0x809) { if (depth === 0 && byOffset.has(off)) curSheet = byOffset.get(off); depth++; }
      else if (rt === 0x0a) { depth = Math.max(0, depth - 1); if (depth === 0) curSheet = null; }
      if (rt === 0xeb) { group.push(d); lastGroup = true; lastDrawing = null; }
      else if (rt === 0xec) { lastDrawing = { sheet: curSheet, parts: [d] }; sheetDraw.push(lastDrawing); lastGroup = false; }
      else if (rt === 0x3c) { if (lastGroup) group.push(d); else if (lastDrawing) lastDrawing.parts.push(d); }
      else { lastGroup = false; lastDrawing = null; }
      off += 4 + ln;
    }
    const g = concat(group), bse = [];
    artWalk(g, 0, g.length, (r) => { if (r.type === 0xf007) bse.push(r); });
    const blips = bse.map((r) => {
      try {
        const p = r.ds + 36 + g[r.ds + 33];
        if (r.end - p >= 8) return decodeBlip(g, p, r.end);
        const fo = u32(g, r.ds + 28);
        if (fo && fo + 8 < w.length) return decodeBlip(w, fo, w.length);
      } catch (e) { return { error: e.message }; }
      return null;
    });
    const bySheet = new Map(), warns = [];
    for (const dr of sheetDraw) {
      if (!dr.sheet) continue;
      const b = concat(dr.parts), pibs = [];
      artWalk(b, 0, b.length, (r) => {
        if (r.type !== 0xf00b) return;
        for (let i = 0; i < r.inst; i++) { const q = r.ds + i * 6; if ((u16(b, q) & 0x3fff) === 0x104) pibs.push(i32(b, q + 2)); }
      });
      pibs.forEach((pib) => { const bl = blips[pib - 1]; if (bl) { if (!bySheet.has(dr.sheet)) bySheet.set(dr.sheet, []); bySheet.get(dr.sheet).push({ pib, blip: bl }); } });
    }
    const out = new Map();
    for (const [sheet, list] of bySheet) {
      const seen = new Set(), res = [];
      for (const it of list) {
        if (seen.has(it.pib)) continue; seen.add(it.pib);
        if (it.blip.error) { warns.push({ sheet, msg: 'קריאת התמונה נכשלה' }); continue; }
        try { res.push(await finishImage(it.blip.kind, it.blip.bytes)); }
        catch (e) { warns.push({ sheet, msg: 'פורמט תמונה שאינו נתמך (' + it.blip.kind.toUpperCase() + ')' }); }
      }
      if (res.length) out.set(sheet, res);
    }
    return { bySheet: out, warns };
  }

  async function imagesFromXlsx(book) {
    const relOf = (path) => { const dir = path.replace(/[^/]+$/, ''); return { dir, rel: dir + '_rels/' + path.slice(dir.length) + '.rels' }; };
    const targets = (xml) => { const m = {}; (xml.match(/<Relationship\b[^>]*>/g) || []).forEach((x) => { const id = /Id="([^"]+)"/.exec(x), tg = /Target="([^"]+)"/.exec(x); if (id && tg) m[id[1]] = tg[1]; }); return m; };
    const out = new Map(), warns = [];
    for (const sh of book.sheets) {
      if (!sh.path) continue;
      const { dir, rel } = relOf(sh.path);
      const dt = /Target="([^"]*drawings\/[^"]+)"/.exec(book.text(rel));
      if (!dt) continue;
      const drawPath = book.norm(dir, dt[1]);
      const dd = relOf(drawPath);
      const dmap = targets(book.text(dd.rel)), dxml = book.text(drawPath);
      const res = [];
      for (const m of dxml.matchAll(/r:embed="([^"]+)"/g)) {
        const tgt = dmap[m[1]]; if (!tgt) continue;
        const data = book.file(book.norm(dd.dir, tgt)); if (!data) continue;
        try {
          let kind = null;
          if (data[0] === 0x89 && data[1] === 0x50) kind = 'png';
          else if (data[0] === 0xff && data[1] === 0xd8) kind = 'jpeg';
          else if (u32(data, 0) === 1 && data[40] === 0x20 && data[41] === 0x45 && data[42] === 0x4d && data[43] === 0x46) kind = 'emf';
          if (!kind) throw new Error('unsupported');
          res.push(await finishImage(kind, data));
        } catch (e) { warns.push({ sheet: sh.name, msg: 'פורמט תמונה שאינו נתמך' }); }
      }
      if (res.length) out.set(sh.name, res);
    }
    return { bySheet: out, warns };
  }

  async function extractImages(book) {
    try { return book.kind === 'xls' ? await imagesFromXls(book) : await imagesFromXlsx(book); }
    catch (e) { console.error('extractImages', e); return { bySheet: new Map(), warns: [{ sheet: '', msg: 'לא ניתן היה לקרוא תמונות מהקובץ' }] }; }
  }

  /**
   * מיישם ייבוא על עותק עבודה של הנתונים. plan = { units, catalogRows }.
   * opts = { brandId | newBrandName, defaultYear, importBad }.
   */
  function applyImport(work, catalog, plan, opts) {
    const uid = window.Store.uid;
    const rep = { files: [], diagAdded: 0, diagDup: 0, newBrand: false, brandName: '', seriesNew: 0, unitsNew: 0, unitsMerged: 0, partsAdded: 0, partsDup: 0, badSkipped: 0, badAdded: 0, catAdded: 0, catDup: 0, unitsSkipped: 0 };
    let brand = opts.brandId ? work.brands.find((b) => b.id === opts.brandId) : null;
    if (!brand) {
      const nm = (opts.newBrandName || '').trim();
      brand = work.brands.find((b) => lc(b.name) === lc(nm));
      if (!brand) { brand = { id: uid('b'), name: nm, logo: '', created: Date.now() }; work.brands.push(brand); rep.newBrand = true; }
    }
    rep.brandName = brand.name;
    const keysByUnit = new Map();
    work.parts.forEach((p) => {
      if (!p.tSku) return;
      if (!keysByUnit.has(p.unitId)) keysByUnit.set(p.unitId, new Set());
      keysByUnit.get(p.unitId).add(p.tSku);
    });

    plan.units.forEach((u) => {
      if (!u.include || !u.type) { rep.unitsSkipped++; return; }
      const year = (u.year || opts.defaultYear || '').trim();
      let s = work.series.find((x) => x.brandId === brand.id && lc(x.name) === lc(u.seriesName) && (x.year || '') === year);
      if (!s) { s = { id: uid('s'), brandId: brand.id, name: u.seriesName.trim(), year, notes: '' }; work.series.push(s); rep.seriesNew++; }
      let unit = work.units.find((x) => x.brandId === brand.id && x.type === u.type && lc(x.model) === lc(u.model));
      if (unit) {
        rep.unitsMerged++;
        unit.seriesIds = unit.seriesIds || [];
        if (!unit.seriesIds.includes(s.id)) unit.seriesIds.push(s.id);
        if (!unit.productCode && u.productCode) unit.productCode = u.productCode;
        if (!unit.chartRef && u.chartRef) unit.chartRef = u.chartRef;
      } else {
        unit = { id: uid('u'), brandId: brand.id, type: u.type, model: u.model.trim(), productCode: u.productCode, chartRef: u.chartRef, capacity: '', notes: '', seriesIds: [s.id] };
        work.units.push(unit);
        rep.unitsNew++;
      }
      if (!keysByUnit.has(unit.id)) keysByUnit.set(unit.id, new Set());
      const keys = keysByUnit.get(unit.id);
      const add = (p, isBad) => {
        let notes = p.notes;
        if (isBad && p.rawT && !isPlaceholder(p.rawT)) notes = (notes ? notes + ' | ' : '') + `מק״ט תדיראן בקובץ המקור: ${p.rawT}`;
        work.parts.push({ id: uid('p'), unitId: unit.id, item: p.item, name: p.name, desc: p.desc, qty: p.qty, tSku: p.tSku, mSku: p.mSku, notes });
        if (isBad) rep.badAdded++; else rep.partsAdded++;
      };
      u.good.forEach((p) => {
        if (keys.has(p.tSku)) { rep.partsDup++; return; }
        keys.add(p.tSku);
        add(p, false);
      });
      u.bad.forEach((p) => {
        if (opts.importBad && p.importable) add(p, true); else rep.badSkipped++;
      });
      u.dups.forEach(() => { rep.partsDup++; });

      if (u.useImages && u.images && u.images.length) {
        const have = new Set(work.diagrams.filter((d) => d.unitId === unit.id && d.hash).map((d) => d.hash));
        const base = ((u.chartRef || '').replace(/\.[a-z0-9]+$/i, '') || u.model).replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
        u.images.forEach((im, k) => {
          if (have.has(im.hash)) { rep.diagDup++; return; }
          have.add(im.hash);
          const id = uid('d'), many = u.images.length > 1;
          work.diagrams.push({
            id, unitId: unit.id,
            name: (u.type === 'evaporator' ? 'סכמת יחידה פנימית' : 'סכמת יחידה חיצונית') + (many ? ' ' + (k + 1) : ''),
            fileName: base + (many ? '-' + (k + 1) : '') + '.' + im.ext,
            mime: im.blob.type, size: im.blob.size, hash: im.hash, created: Date.now(), source: 'excel'
          });
          rep.files.push({ key: 'dg:' + id, blob: im.blob });
          rep.diagAdded++;
        });
      }
    });

    let newCatalog = catalog;
    if (plan.catalogRows && plan.catalogRows.length) {
      newCatalog = catalog.slice();
      const have = new Set(newCatalog.map((c) => c.tSku));
      plan.catalogRows.forEach((c) => {
        if (have.has(c.tSku)) { rep.catDup++; return; }
        have.add(c.tSku);
        newCatalog.push(c);
        rep.catAdded++;
      });
    }
    return { rep, catalog: newCatalog };
  }

  // ===== ייצוא (מחזיר { blob, name }) =====
  const stamp = () => new Date().toISOString().slice(0, 10);
  function partRows(S, idx, units) {
    const rows = [];
    units.forEach((u) => {
      const b = idx.brand.get(u.brandId);
      const ss = (u.seriesIds || []).map((id) => idx.series.get(id)).filter(Boolean);
      (idx.partsByUnit.get(u.id) || []).forEach((p) => {
        rows.push([b ? b.name : '', ss.map((s) => s.name).join(' | '), ss.map((s) => s.year).filter(Boolean).join(' | '),
          u.type === 'evaporator' ? 'מאייד' : 'מעבה', u.model, u.productCode || '', p.item || '', p.name || '', p.tSku || '', p.mSku || '', p.desc || '', p.qty || '', p.notes || '']);
      });
    });
    return rows;
  }
  const PART_HEAD = ['מותג', 'דגם / סדרה', 'שנתון', 'סוג יחידה', 'דגם היחידה', 'קוד מוצר', 'פריט בסכמה', 'שם החלק', 'מק״ט תדיראן', 'מק״ט יצרן', 'תיאור', 'כמות', 'הערות'];
  const PART_W = [14, 22, 10, 10, 26, 22, 10, 30, 16, 20, 30, 8, 30];

  function exportAll(S, idx, catalog) {
    const sheets = [{ name: 'חלקים', rows: [PART_HEAD, ...partRows(S, idx, S.units)], widths: PART_W }];
    const urows = [['מותג', 'דגם / סדרה', 'שנתון', 'סוג יחידה', 'דגם היחידה', 'קוד מוצר', 'תפוקה', 'הערות', 'מס׳ חלקים']];
    S.units.forEach((u) => {
      const b = idx.brand.get(u.brandId);
      const ss = (u.seriesIds || []).map((id) => idx.series.get(id)).filter(Boolean);
      urows.push([b ? b.name : '', ss.map((s) => s.name).join(' | '), ss.map((s) => s.year).filter(Boolean).join(' | '), u.type === 'evaporator' ? 'מאייד' : 'מעבה', u.model, u.productCode || '', u.capacity || '', u.notes || '', String((idx.partsByUnit.get(u.id) || []).length)]);
    });
    sheets.push({ name: 'יחידות', rows: urows, widths: [14, 22, 10, 10, 26, 22, 12, 30, 10] });
    if (catalog.length) sheets.push({ name: 'קטלוג כללי', rows: [['מק״ט תדיראן', 'תיאור', 'מק״ט יצרן'], ...catalog.map((c) => [c.tSku, c.desc, c.mSku])], widths: [16, 40, 24] });
    return { blob: window.SheetIO.buildXlsx(sheets, { rtl: true }), name: `spare-parts-${stamp()}.xlsx` };
  }
  function exportUnit(S, idx, unit) {
    const safe = unit.model.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
    return { blob: window.SheetIO.buildXlsx([{ name: 'חלקים', rows: [PART_HEAD, ...partRows(S, idx, [unit])], widths: PART_W }], { rtl: true }), name: `${safe}-${stamp()}.xlsx` };
  }

  window.Excel = { parseWorkbook, applyImport, extractImages, exportAll, exportUnit };
})();
