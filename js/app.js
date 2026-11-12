/* מרכז חלקי חילוף: ממשק. היררכיה: מותג > דגם/שנתון > מעבה + מאיידים > חלקים. הנתונים בענן (Supabase). */
(function () {
  'use strict';
  const CFG = window.APP_CONFIG;
  const SB = window.SB;
  const S = Store.state;
  const I = Store.idx;
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => [...(r || document).querySelectorAll(s)];
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ltr = (s) => `<bdi class="ltr" dir="ltr">${esc(s)}</bdi>`;
  const nat = (a, b) => String(a).localeCompare(String(b), 'he', { numeric: true, sensitivity: 'base' });
  const lc = (s) => String(s || '').trim().toLowerCase();
  const TYPE = { evaporator: { label: 'מאייד', sub: 'יחידה פנימית', cls: 'ev' }, condenser: { label: 'מעבה', sub: 'יחידה חיצונית', cls: 'co' } };
  let role = '';
  const isAdmin = () => role === 'admin';
  const urlCache = new Map();

  // ===== כלי עזר לממשק =====
  function toast(msg, kind) {
    const t = document.createElement('div');
    t.className = 'toast ' + (kind || '');
    t.textContent = msg;
    $('#toasts').appendChild(t);
    setTimeout(() => t.remove(), kind === 'err' ? 7000 : 3200);
  }
  const saveErr = (e) => {
    console.error(e);
    if (e && e.code === 'AUTH') { toast('ההתחברות פגה. יש להיכנס מחדש.', 'err'); logout(); return; }
    toast(e && e.message ? e.message : 'שגיאה בשמירה', 'err');
  };
  function openModal({ title, body, wide, actions = [], onMount }) {
    const wrap = document.createElement('div');
    wrap.className = 'modal';
    wrap.innerHTML = `<div class="mbox${wide ? ' wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="mhead"><h2>${esc(title)}</h2><button type="button" class="x" data-close aria-label="סגירה">×</button></div><div class="mbody">${body}</div><div class="mfoot"></div></div>`;
    const api = {
      el: wrap,
      q: (s) => wrap.querySelector(s),
      qa: (s) => [...wrap.querySelectorAll(s)],
      close() { wrap.remove(); document.removeEventListener('keydown', onKey); }
    };
    const onKey = (e) => { if (e.key === 'Escape') api.close(); };
    actions.forEach((a) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn ' + (a.cls || '');
      b.textContent = a.label;
      b.addEventListener('click', async () => {
        if (b.disabled) return;
        b.disabled = true;
        try { const r = await a.run(api); if (r !== false) api.close(); } catch (e) { saveErr(e); } finally { b.disabled = false; }
      });
      $('.mfoot', wrap).appendChild(b);
    });
    if (!actions.length) $('.mfoot', wrap).remove();
    let downOnBg = false;
    wrap.addEventListener('mousedown', (e) => { downOnBg = e.target === wrap; });
    wrap.addEventListener('click', (e) => { if (downOnBg && e.target === wrap) api.close(); });
    $('[data-close]', wrap).addEventListener('click', api.close);
    document.addEventListener('keydown', onKey);
    document.body.appendChild(wrap);
    if (onMount) onMount(api);
    const first = wrap.querySelector('input:not([type=file]):not([type=checkbox]),select,textarea');
    if (first) first.focus();
    return api;
  }
  const fld = (label, input, hint) => `<div class="fld"><label>${label}</label>${input}${hint ? `<small>${hint}</small>` : ''}</div>`;
  const val = (m, s) => (m.q(s).value || '').trim();

  function resizeImage(file, max, type, q) {
    return new Promise((res, rej) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const k = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(img.width * k));
        c.height = Math.max(1, Math.round(img.height * k));
        const g = c.getContext('2d');
        if (type === 'image/jpeg') { g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); }
        g.drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        c.toBlob((b) => (b ? res(b) : rej(new Error('עיבוד התמונה נכשל'))), type, q);
      };
      img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('קובץ התמונה אינו תקין')); };
      img.src = url;
    });
  }
  const blobToDataUrl = (b) => new Promise((res, rej) => { const f = new FileReader(); f.onload = () => res(f.result); f.onerror = () => rej(f.error); f.readAsDataURL(b); });
  function checkImageFile(f) {
    if (!f) return;
    if (!/^image\/(png|jpe?g|webp|gif)$/i.test(f.type)) throw new Error('יש לבחור קובץ תמונה (JPG / PNG)');
    if (f.size > CFG.maxImageMB * 1048576) throw new Error(`התמונה גדולה מ-${CFG.maxImageMB}MB`);
  }
  async function blobUrl(key) {
    if (urlCache.has(key)) return urlCache.get(key);
    const b = await Store.getFile(key);
    if (!b) return '';
    const u = URL.createObjectURL(b);
    urlCache.set(key, u);
    return u;
  }
  function dropUrl(key) { const u = urlCache.get(key); if (u) { URL.revokeObjectURL(u); urlCache.delete(key); } }
  async function hydrate(root) {
    await Promise.all($$('img[data-bkey]', root).map(async (img) => {
      try { const u = await blobUrl(img.dataset.bkey); if (u && img.isConnected) img.src = u; } catch (e) { console.warn('image load failed', img.dataset.bkey, e); }
    }));
  }
  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  // ===== סטטוס סנכרון לענן =====
  let syncTimer = null;
  Store.onStatus = (s, msg) => {
    const el = $('#syncbar');
    clearTimeout(syncTimer);
    if (s === 'ok') { el.hidden = true; return; }
    if (s === 'saving') { syncTimer = setTimeout(() => { el.className = 'syncbar'; el.textContent = 'שומר בענן…'; el.hidden = false; }, 350); return; }
    el.className = 'syncbar err';
    el.innerHTML = `${esc(msg)} <button class="btn sm" type="button" data-act="retrySync">נסה שוב</button>`;
    el.hidden = false;
  };
  Store.onReload = () => render();

  // ===== כניסה ויציאה =====
  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const pw = $('#pw').value, btn = $('#loginForm button');
    if (!pw) return;
    btn.disabled = true; $('#loginErr').textContent = '';
    try {
      const r = await SB.loginWithPassword(pw);
      if (!r) { $('#loginErr').textContent = 'סיסמה שגויה'; $('#pw').select(); return; }
      role = r;
      $('#pw').value = '';
      await startSession();
    } catch (err) {
      console.error(err);
      role = '';
      $('#loginErr').textContent = err && err.message ? err.message : 'ההתחברות נכשלה';
    } finally { btn.disabled = false; }
  });
  async function startSession() {
    $('#loading').hidden = false;
    try { await Store.load(); }
    catch (e) { $('#loading').hidden = true; await SB.signOut(); throw e; }
    $('#loading').hidden = true;
    start();
  }
  async function logout() {
    $$('.modal').forEach((m) => m.remove());
    await SB.signOut();
    Store.clear();
    role = '';
    $('#syncbar').hidden = true;
    $('#app').hidden = true; $('#login').hidden = false; $('#pw').focus();
  }

  // ===== כותרת =====
  function renderTop() {
    $('#topin').innerHTML = `
      <a class="logo" href="#/">${esc(CFG.appName)}<small>מזגנים מפוצלים</small></a>
      <div class="gsbox"><input class="gs" id="gsTop" type="search" placeholder="חיפוש: דגם, שם חלק, מק״ט תדיראן או מק״ט יצרן" aria-label="חיפוש"></div>
      <span class="spacer"></span>
      <span class="chip-role">${isAdmin() ? 'מנהל מערכת' : 'צפייה'}</span>
      <button class="btn" type="button" data-act="reload" title="רענון נתונים מהענן" aria-label="רענון נתונים">⟳</button>
      ${isAdmin() ? `<div class="menuwrap"><button class="btn" id="menuBtn" type="button" aria-haspopup="true">ניהול ▾</button><div class="menu" id="menu" hidden>
        <button type="button" data-act="import">ייבוא מ-Excel</button>
        <button type="button" data-act="exportAll">ייצוא הכל ל-Excel</button>
        <button type="button" data-act="backup">גיבוי נתונים (JSON)</button>
        <button type="button" data-act="restore">שחזור מגיבוי</button>
        <div class="hint" id="storeInfo"></div></div></div>` : ''}
      <button class="btn" type="button" data-act="logout">יציאה</button>`;
    $$('.gs').forEach(bindSearch);
    const mb = $('#menuBtn');
    if (mb) mb.addEventListener('click', (e) => {
      e.stopPropagation();
      const m = $('#menu');
      m.hidden = !m.hidden;
      if (!m.hidden) $('#storeInfo').textContent = `נתונים בענן · עודכן ${new Date(Store.lastLoad).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })}`;
    });
  }
  document.addEventListener('click', (e) => { const m = $('#menu'); if (m && !m.hidden && !e.target.closest('.menuwrap')) m.hidden = true; });

  let searchTimer = null;
  function bindSearch(inp) {
    inp.addEventListener('input', () => {
      $$('.gs').forEach((o) => { if (o !== inp) o.value = inp.value; });
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => goSearch(inp.value), 220);
    });
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(searchTimer); goSearch(inp.value); } });
  }
  function goSearch(v) {
    v = v.trim();
    const target = v ? '#/search/' + encodeURIComponent(v) : '#/';
    if (location.hash.startsWith('#/search/') && v) { history.replaceState(null, '', target); render(); } else location.hash = target;
  }

  // ===== ניתוב =====
  function parseRoute() {
    const raw = location.hash.replace(/^#/, '') || '/';
    const [path, qs] = raw.split('?');
    const p = path.split('/').filter(Boolean);
    return { p, q: new URLSearchParams(qs || '') };
  }
  let prevTop = '';
  window.addEventListener('hashchange', () => {
    const top = parseRoute().p[0] || '';
    if (top === 'b' && prevTop !== 'b') { bf.year = 'all'; bf.q = ''; } // מסננים לא נשארים בין כניסות לעמוד מותג
    prevTop = top;
    render(); window.scrollTo(0, 0);
  });

  function render() {
    if (!role) return;
    const { p, q } = parseRoute();
    const v = $('#view');
    document.body.classList.toggle('home-page', !p.length);
    let html = '';
    try {
      if (!p.length) html = viewHome();
      else if (p[0] === 'b') html = viewBrand(p[1]);
      else if (p[0] === 's') html = viewSeries(p[1]);
      else if (p[0] === 'u') html = viewUnit(p[1], q.get('s'));
      else if (p[0] === 'search') html = viewSearch(decodeURIComponent(p.slice(1).join('/')));
      else html = '<div class="empty">העמוד לא נמצא. <a href="#/">חזרה לדף הבית</a></div>';
    } catch (e) { console.error(e); html = '<div class="empty">אירעה שגיאה בהצגת העמוד.</div>'; }
    v.innerHTML = html;
    hydrate(v);
    if (p[0] === 'u') afterUnitRender(p[1]);
    if (p[0] === 'search') { $$('.gs').forEach((i) => { i.value = decodeURIComponent(p.slice(1).join('/')); }); }
    if (!p.length) $$('.gs').forEach((i) => { i.value = ''; });
    $$('#view .gs').forEach(bindSearch);
  }

  const crumbs = (items) => `<nav class="crumbs" aria-label="מיקום">${items.map((x, i) => (i === items.length - 1 ? `<b>${esc(x[0])}</b>` : `<a href="${x[1]}">${esc(x[0])}</a><span>›</span>`)).join('')}</nav>`;
  const typeBadge = (t) => `<span class="badge ${TYPE[t].cls}">${TYPE[t].label}</span>`;
  const countUnits = (units) => {
    const ev = units.filter((u) => u.type === 'evaporator').length, co = units.filter((u) => u.type === 'condenser').length;
    const a = [];
    if (co) a.push(`${co} ${co === 1 ? 'מעבה' : 'מעבים'}`);
    if (ev) a.push(`${ev} ${ev === 1 ? 'מאייד' : 'מאיידים'}`);
    return a.join(' · ') || 'אין יחידות עדיין';
  };

  // ===== דף הבית =====
  function viewHome() {
    const cat = Store.getCatalog().length;
    const brands = S.brands.slice().sort((a, b) => nat(a.name, b.name));
    return `
      <section class="hero"><h1>מצא את החלק הנכון, מהר.</h1>
        <p>חיפוש לפי דגם, שם חלק, מק״ט תדיראן או מק״ט יצרן, בכל המותגים.</p>
        <input class="gs" type="search" placeholder="הקלד דגם, שם חלק או מק״ט" aria-label="חיפוש ראשי">
        <div class="stats"><span>${S.brands.length === 1 ? 'מותג אחד' : S.brands.length + ' מותגים'}</span><span>·</span><span>${S.units.length === 1 ? 'יחידה אחת' : S.units.length + ' יחידות'}</span><span>·</span><span>${S.parts.length.toLocaleString('he-IL')} חלקים</span>${cat ? `<span>·</span><span>${cat.toLocaleString('he-IL')} מק״טים בקטלוג הכללי</span>` : ''}</div>
      </section>
      <div class="sect"><h2>מותגים</h2><div class="acts">${isAdmin() ? '<button class="btn primary" data-act="addBrand">+ מותג חדש</button><button class="btn admin-only" data-act="import">ייבוא מ-Excel</button>' : ''}</div></div>
      ${brands.length ? `<div class="brands">${brands.map(brandCard).join('')}</div>` : `<div class="card empty">עדיין אין מותגים במערכת.${isAdmin() ? '<br>אפשר להוסיף מותג ידנית, או לייבא קובץ Excel והמערכת תסדר אותו לפי דגם, מאייד ומעבה.' : '<br>מנהל המערכת יוסיף מידע בקרוב.'}</div>`}`;
  }
  function brandCard(b) {
    const sc = (I.seriesByBrand.get(b.id) || []).length;
    const uc = (I.unitsByBrand.get(b.id) || []).length;
    return `<a class="card bcard" href="#/b/${b.id}"><div class="bmark">${b.logo ? `<img src="${esc(b.logo)}" alt="">` : esc((b.name || '?').trim().charAt(0).toUpperCase())}</div><h3>${esc(b.name)}</h3><span class="muted">${sc} דגמים · ${uc} יחידות</span></a>`;
  }

  // ===== עמוד מותג =====
  const bf = { id: '', year: 'all', q: '' };
  function viewBrand(id) {
    const b = I.brand.get(id);
    if (!b) return '<div class="empty">המותג לא נמצא. <a href="#/">חזרה</a></div>';
    if (bf.id !== id) { bf.id = id; bf.year = 'all'; bf.q = ''; }
    const all = (I.seriesByBrand.get(id) || []);
    const years = [...new Set(all.map((s) => s.year).filter(Boolean))].sort((a, c) => nat(c, a));
    const hasNoYear = all.some((s) => !s.year);
    if (bf.year !== 'all' && bf.year !== 'none' && !years.includes(bf.year)) bf.year = 'all';
    if (bf.year === 'none' && !hasNoYear) bf.year = 'all';
    const q = lc(bf.q);
    const list = all.filter((s) => {
      if (bf.year !== 'all' && (bf.year === 'none' ? s.year : s.year !== bf.year)) return false;
      if (!q) return true;
      const models = (I.unitsBySeries.get(s.id) || []).map((u) => u.model + ' ' + (u.productCode || '')).join(' ');
      return lc(s.name + ' ' + (s.year || '') + ' ' + models).includes(q);
    });
    const groups = new Map();
    list.forEach((s) => { const k = s.year || ''; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(s); });
    const keys = [...groups.keys()].sort((a, c) => (a === '' ? 1 : c === '' ? -1 : nat(c, a)));
    const body = keys.map((k) => `${keys.length > 1 || k ? `<h2 class="ygroup">${k ? 'שנתון ' + esc(k) : 'ללא שנתון'}</h2>` : ''}<div class="slist">${groups.get(k).sort((a, c) => nat(a.name, c.name)).map(seriesCard).join('')}</div>`).join('');
    return `${crumbs([['דף הבית', '#/'], [b.name]])}
      <div class="pagehead"><div style="display:flex;gap:14px;align-items:center"><div class="bmark">${b.logo ? `<img src="${esc(b.logo)}" alt="">` : esc(b.name.trim().charAt(0).toUpperCase())}</div><div><h1>${esc(b.name)}</h1><span class="muted">${all.length} דגמים · ${(I.unitsByBrand.get(id) || []).length} יחידות</span></div></div>
        <div class="acts">${isAdmin() ? `<button class="btn primary" data-act="addSeries" data-id="${id}">+ דגם חדש</button><button class="btn admin-only" data-act="import" data-brand="${id}">ייבוא מ-Excel</button><button class="btn admin-only" data-act="editBrand" data-id="${id}">עריכת מותג</button><button class="btn danger" data-act="delBrand" data-id="${id}">מחיקת מותג</button>` : ''}</div></div>
      ${all.length ? `<div class="filters">
        ${years.length ? `<button class="fchip ${bf.year === 'all' ? 'on' : ''}" data-act="yfilter" data-v="all">הכל</button>${years.map((y) => `<button class="fchip ${bf.year === y ? 'on' : ''}" data-act="yfilter" data-v="${esc(y)}">${esc(y)}</button>`).join('')}${hasNoYear ? `<button class="fchip ${bf.year === 'none' ? 'on' : ''}" data-act="yfilter" data-v="none">ללא שנתון</button>` : ''}` : ''}
        <input class="inp" id="bfq" type="search" placeholder="סינון דגמים לפי שם או מספר דגם" value="${esc(bf.q)}" style="flex:1;max-width:360px"></div>` : ''}
      ${body || `<div class="card empty">${all.length ? 'לא נמצאו דגמים תואמים.' : 'אין דגמים במותג הזה עדיין.'}${isAdmin() && !all.length ? '<br>הוסף דגם חדש או ייבא קובץ Excel.' : ''}</div>`}`;
  }
  function seriesCard(s) {
    const units = (I.unitsBySeries.get(s.id) || []).slice().sort((a, b) => (a.type === b.type ? nat(a.model, b.model) : a.type === 'condenser' ? -1 : 1));
    return `<article class="card scard"><div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><a class="stitle" href="#/s/${s.id}">${esc(s.name)}</a>${s.year ? `<span class="badge year">${esc(s.year)}</span>` : ''}</div>
      <div class="sstats">${countUnits(units)}</div>
      <div class="uchips">${units.map((u) => `<a class="chip ${TYPE[u.type].cls}" href="#/u/${u.id}?s=${s.id}"><b>${TYPE[u.type].label}</b>${ltr(u.model)}</a>`).join('')}</div>
      ${isAdmin() ? `<div class="uact"><a class="btn sm" href="#/s/${s.id}">פתיחה</a><button class="btn sm" data-act="editSeries" data-id="${s.id}">עריכת שם/שנתון</button><button class="btn sm danger" data-act="delSeries" data-id="${s.id}">מחיקה</button></div>` : ''}</article>`;
  }

  // ===== עמוד דגם (סדרה) =====
  function viewSeries(id) {
    const s = I.series.get(id);
    if (!s) return '<div class="empty">הדגם לא נמצא. <a href="#/">חזרה</a></div>';
    const b = I.brand.get(s.brandId);
    const units = I.unitsBySeries.get(id) || [];
    const col = (type) => {
      const list = units.filter((u) => u.type === type).sort((a, c) => nat(a.model, c.model));
      return `<section><div class="colhead"><h2>${typeBadge(type)} ${type === 'condenser' ? 'מעבים' : 'מאיידים'} <span class="muted" style="font-size:15px">(${list.length})</span></h2>${isAdmin() ? `<button class="btn sm primary" data-act="addUnit" data-sid="${id}" data-type="${type}">+ ${TYPE[type].label}</button>` : ''}</div>
        <div class="ulist">${list.length ? list.map((u) => unitCard(u, s)).join('') : `<div class="card empty">${type === 'condenser' ? 'לא הוגדר מעבה לדגם הזה.' : 'לא הוגדר מאייד לדגם הזה.'}</div>`}</div></section>`;
    };
    return `${crumbs([['דף הבית', '#/'], [b ? b.name : '', b ? '#/b/' + b.id : '#/'], [s.name]])}
      <div class="pagehead"><div><h1>${esc(s.name)} ${s.year ? `<span class="badge year">שנתון ${esc(s.year)}</span>` : ''}</h1>${s.notes ? `<div class="muted">${esc(s.notes)}</div>` : ''}</div>
        <div class="acts">${isAdmin() ? `<button class="btn admin-only" data-act="linkUnit" data-sid="${id}">שיוך יחידה קיימת</button><button class="btn admin-only" data-act="editSeries" data-id="${id}">עריכת דגם</button><button class="btn danger" data-act="delSeries" data-id="${id}">מחיקת דגם</button>` : ''}</div></div>
      <div class="cols">${col('condenser')}${col('evaporator')}</div>`;
  }
  function unitCard(u, s) {
    const pc = (I.partsByUnit.get(u.id) || []).length;
    const dc = (I.diagByUnit.get(u.id) || []).length;
    return `<div class="card ucard ${TYPE[u.type].cls}"><a href="#/u/${u.id}?s=${s.id}" style="color:inherit;text-decoration:none"><div class="umodel">${ltr(u.model)}</div>
      <div class="umeta">${u.productCode ? `<span>קוד מוצר: ${ltr(u.productCode)}</span>` : ''}${u.capacity ? `<span>תפוקה: ${esc(u.capacity)}</span>` : ''}<span>${pc} חלקים</span><span>${dc} סכמות</span></div></a>
      ${isAdmin() ? `<div class="uact"><button class="btn sm" data-act="editUnit" data-id="${u.id}">עריכה</button>${(u.seriesIds || []).length > 1 ? `<button class="btn sm" data-act="unlinkUnit" data-id="${u.id}" data-sid="${s.id}">הסרה מהדגם (היחידה משותפת)</button>` : ''}<button class="btn sm danger" data-act="delUnit" data-id="${u.id}">מחיקה</button></div>` : ''}</div>`;
  }

  // ===== עמוד יחידה =====
  const tbl = { unitId: '', q: '', sort: 'item', dir: 1 };
  const dg = { unitId: '', id: '', zoom: 100, url: null, tok: 0 };
  function viewUnit(id, sid) {
    const u = I.unit.get(id);
    if (!u) return '<div class="empty">היחידה לא נמצאה. <a href="#/">חזרה</a></div>';
    if (tbl.unitId !== id) { tbl.unitId = id; tbl.q = ''; tbl.sort = 'item'; tbl.dir = 1; }
    const b = I.brand.get(u.brandId);
    const ctx = I.series.get(sid && (u.seriesIds || []).includes(sid) ? sid : (u.seriesIds || [])[0]);
    const allSeries = (u.seriesIds || []).map((x) => I.series.get(x)).filter(Boolean);
    const sibs = ctx ? (I.unitsBySeries.get(ctx.id) || []).slice().sort((a, c) => (a.type === c.type ? nat(a.model, c.model) : a.type === 'condenser' ? -1 : 1)) : [];
    return `${crumbs([['דף הבית', '#/'], [b ? b.name : '', b ? '#/b/' + b.id : '#/'], ...(ctx ? [[ctx.name, '#/s/' + ctx.id]] : []), [u.model]])}
      <section class="card uhead">${u.hasImg ? `<img class="uimg" data-bkey="ui:${u.id}" data-act="zoomimg" alt="תמונת הדגם">` : ''}<div style="${u.hasImg ? '' : 'grid-column:1/-1'}">
        <h1>${typeBadge(u.type)} ${ltr(u.model)}</h1>
        <div class="facts">
          <div class="fact"><small>מותג</small><b>${esc(b ? b.name : '')}</b></div>
          <div class="fact"><small>סוג יחידה</small><b>${TYPE[u.type].sub}</b></div>
          ${allSeries.length ? `<div class="fact"><small>דגם / שנתון</small><b>${allSeries.map((s) => `<a href="#/s/${s.id}">${esc(s.name)}${s.year ? ' · ' + esc(s.year) : ''}</a>`).join('<br>')}</b></div>` : ''}
          ${u.productCode ? `<div class="fact"><small>קוד מוצר</small><b>${ltr(u.productCode)}</b></div>` : ''}
          ${u.capacity ? `<div class="fact"><small>תפוקה</small><b>${esc(u.capacity)}</b></div>` : ''}
          ${u.notes ? `<div class="fact" style="grid-column:1/-1"><small>הערות טכניות</small><b>${esc(u.notes)}</b></div>` : ''}
        </div>
        ${isAdmin() ? `<div class="acts" style="margin-top:12px"><button class="btn sm" data-act="editUnit" data-id="${u.id}">עריכת יחידה</button><button class="btn sm" data-act="exportUnit" data-id="${u.id}">ייצוא חלקים ל-Excel</button><button class="btn sm danger" data-act="delUnit" data-id="${u.id}">מחיקת יחידה</button></div>` : ''}
      </div></section>
      ${sibs.length > 1 ? `<div class="sibs"><span class="lbl">יחידות בדגם:</span>${sibs.map((x) => `<a class="sib ${x.id === u.id ? 'on' : ''}" href="#/u/${x.id}?s=${ctx.id}">${typeBadge(x.type)}${ltr(x.model)}</a>`).join('')}</div>` : '<div style="height:14px"></div>'}
      <div class="dgbox" id="dgBox"><div class="dgbar" id="dgBar"></div><div class="dgview" id="dgView"></div></div>
      <section class="card" style="margin-top:18px"><div class="ptools"><h2 style="font-size:20px">חלקי חילוף <span class="muted" id="pcount" style="font-size:15px"></span></h2>
        <input class="inp" id="pq" type="search" placeholder="חיפוש בטבלה: שם, מק״ט, הערות" value="${esc(tbl.q)}">
        ${isAdmin() ? `<button class="btn primary" data-act="addPart" data-id="${u.id}">+ הוספת חלק</button>` : ''}</div>
        ${isAdmin() ? `<form class="qa" id="qaForm" autocomplete="off" data-unit="${u.id}"><b>הוספה מהירה</b><input class="inp" id="qa_item" placeholder="פריט" aria-label="פריט" style="width:80px"><input class="inp" id="qa_name" placeholder="שם החלק *" aria-label="שם החלק"><input class="inp ltr" dir="ltr" id="qa_t" placeholder="מק״ט תדיראן *" aria-label="מק״ט תדיראן"><input class="inp ltr" dir="ltr" id="qa_m" placeholder="מק״ט יצרן" aria-label="מק״ט יצרן"><button class="btn primary" type="submit">הוסף ↵</button></form>` : ''}
        <div class="tscroll"><table class="parts"><thead><tr>${[['item', 'פריט בסכמה'], ['name', 'שם החלק'], ['tSku', 'מק״ט תדיראן'], ['mSku', 'מק״ט יצרן']].map(([k, l]) => `<th><button type="button" data-act="sort" data-k="${k}">${l}<span data-sk="${k}"></span></button></th>`).join('')}<th>תמונה</th><th><button type="button" data-act="sort" data-k="notes">הערות<span data-sk="notes"></span></button></th>${isAdmin() ? '<th></th>' : ''}</tr></thead><tbody id="pbody"></tbody></table></div></section>`;
  }
  function afterUnitRender(id) {
    const u = I.unit.get(id);
    if (!u) return;
    if (dg.unitId !== id) { dg.unitId = id; dg.id = ''; dg.zoom = 100; }
    renderParts();
    renderDiagramBar();
    showDiagram();
    const pq = $('#pq');
    if (pq) pq.addEventListener('input', () => { tbl.q = pq.value; renderParts(); });
    qaPrefill();
    const qt = $('#qa_t');
    if (qt) qt.addEventListener('blur', () => {
      const c = I.cat.get(qt.value.trim());
      if (!c) return;
      if (!$('#qa_name').value.trim()) $('#qa_name').value = c.desc;
      if (!$('#qa_m').value.trim() && c.mSku) $('#qa_m').value = c.mSku;
    });
  }
  function qaPrefill() {
    const it = $('#qa_item');
    if (!it) return;
    const nums = (I.partsByUnit.get(tbl.unitId) || []).map((p) => parseInt(p.item, 10)).filter((n) => Number.isFinite(n));
    it.value = nums.length ? String(Math.max(...nums) + 1) : '1';
  }
  function partRow(p) {
    const cat = I.cat.get(p.tSku);
    const cd = cat && cat.desc && lc(cat.desc) !== lc(p.name) ? cat.desc : '';
    const skuBtn = (v) => `<button type="button" class="sku" data-act="copy" data-v="${esc(v)}" title="לחץ להעתקה">${ltr(v)}</button>`;
    return `<tr data-id="${p.id}">
      <td data-l="פריט">${esc(p.item) || '—'}</td>
      <td data-l="שם החלק"><div style="text-align:start"><div class="pname">${esc(p.name)}</div>${p.desc ? `<div class="psub">${esc(p.desc)}</div>` : ''}${cd ? `<div class="psub cat">בקטלוג: ${esc(cd)}</div>` : ''}</div></td>
      <td data-l="מק״ט תדיראן">${p.tSku ? skuBtn(p.tSku) : '<span class="badge warn">חסר</span>'}</td>
      <td data-l="מק״ט יצרן">${p.mSku ? skuBtn(p.mSku) : '—'}</td>
      <td data-l="תמונה">${p.hasImg ? `<img class="pthumb" data-bkey="pi:${p.id}" data-act="zoomimg" alt="תמונת החלק">` : '—'}</td>
      <td data-l="הערות"><div style="text-align:start">${esc(p.notes) || '—'}${p.qty ? `<br><span class="qty">כמות: ${esc(p.qty)}</span>` : ''}</div></td>
      ${isAdmin() ? `<td class="acts-td"><button class="btn sm" data-act="editPart" data-id="${p.id}">עריכה</button> <button class="btn sm danger" data-act="delPart" data-id="${p.id}">מחיקה</button></td>` : ''}</tr>`;
  }
  function renderParts() {
    const body = $('#pbody');
    if (!body) return;
    const all = I.partsByUnit.get(tbl.unitId) || [];
    const q = lc(tbl.q);
    const k = tbl.sort;
    const list = all.filter((p) => !q || lc([p.item, p.name, p.desc, p.tSku, p.mSku, p.notes].join(' ')).includes(q))
      .sort((a, b) => tbl.dir * nat(a[k] || '', b[k] || ''));
    body.innerHTML = list.length ? list.map(partRow).join('') : `<tr><td colspan="7" class="empty" style="display:table-cell">${all.length ? 'לא נמצאו חלקים תואמים.' : 'עדיין אין חלקי חילוף ליחידה הזו.'}</td></tr>`;
    $('#pcount').textContent = `(${list.length}${list.length !== all.length ? ' מתוך ' + all.length : ''})`;
    $$('[data-sk]').forEach((s) => { s.textContent = s.dataset.sk === k ? (tbl.dir > 0 ? ' ▲' : ' ▼') : ''; });
    hydrate(body);
  }

  // ----- סכמות -----
  function renderDiagramBar() {
    const bar = $('#dgBar');
    if (!bar) return;
    const list = I.diagByUnit.get(dg.unitId) || [];
    if (!list.find((d) => d.id === dg.id)) dg.id = list[0] ? list[0].id : '';
    const cur = list.find((d) => d.id === dg.id);
    const isImg = cur && cur.mime !== 'application/pdf';
    bar.innerHTML = `<div class="dgtabs">${list.length ? list.map((d) => `<button type="button" class="dgtab ${d.id === dg.id ? 'on' : ''}" data-act="dgTab" data-id="${d.id}">${esc(d.name)}</button>`).join('') : '<b>סכמת פיצוץ</b>'}</div>
      <div class="dgtools">${cur ? `${isImg ? '<button class="btn sm" data-act="dgZoom" data-d="-25" aria-label="הקטנה">−</button><button class="btn sm" data-act="dgZoom" data-d="0" id="dgZ">' + dg.zoom + '%</button><button class="btn sm" data-act="dgZoom" data-d="25" aria-label="הגדלה">+</button>' : ''}<button class="btn sm" data-act="dgFull">מסך מלא</button><button class="btn sm" data-act="dgOpen">פתיחה בלשונית</button><button class="btn sm" data-act="dgDownload">הורדת המקור</button>` : ''}
      ${isAdmin() ? `<button class="btn sm primary" data-act="addDiagram">+ העלאת סכמה</button>${cur ? '<button class="btn sm" data-act="renameDiagram">שינוי שם</button><button class="btn sm danger" data-act="delDiagram">מחיקה</button>' : ''}` : ''}</div>`;
  }
  async function showDiagram() {
    const view = $('#dgView');
    if (!view) return;
    const tok = ++dg.tok;
    if (dg.url) { URL.revokeObjectURL(dg.url); dg.url = null; }
    const list = I.diagByUnit.get(dg.unitId) || [];
    const d = list.find((x) => x.id === dg.id);
    const u = I.unit.get(dg.unitId);
    if (!d) {
      view.innerHTML = `<div class="dgempty">אין סכמת פיצוץ ליחידה הזו עדיין.${u && u.chartRef ? `<br><span class="muted">קובץ הסכמה לפי הייבוא: ${ltr(u.chartRef)}</span>` : ''}${isAdmin() ? '<br>אפשר להעלות PDF, JPG או PNG.' : ''}</div>`;
      return;
    }
    view.innerHTML = '<div class="dgempty">טוען סכמה…</div>';
    let blob = null;
    try { blob = await Store.getFile('dg:' + d.id); } catch (e) { if (tok === dg.tok) { view.innerHTML = `<div class="dgempty">טעינת הסכמה נכשלה: ${esc(e.message)}</div>`; } return; }
    if (tok !== dg.tok) return;
    if (!blob) { view.innerHTML = '<div class="dgempty">קובץ הסכמה לא נמצא באחסון.</div>'; return; }
    dg.url = URL.createObjectURL(blob);
    view.innerHTML = d.mime === 'application/pdf'
      ? `<iframe class="dgpdf" src="${dg.url}" title="${esc(d.name)}"></iframe>`
      : `<div class="dgimgwrap"><img class="dgimg" src="${dg.url}" alt="${esc(d.name)}" style="width:${dg.zoom}%"></div>`;
  }

  // ===== חיפוש =====
  const sr = { limit: 40, brand: '' };
  function viewSearch(qs) {
    const tokens = lc(qs).split(/\s+/).filter((t) => t && /[^\-_.]/.test(t));
    if (!tokens.length) return '<div class="empty">הקלד דגם, שם חלק או מק״ט.</div>';
    const match = (h, hs) => tokens.every((t) => h.includes(t) || hs.includes(t.replace(/[\s\-_.]/g, '')));
    const strip = (s) => s.replace(/[\s\-_.]/g, '');
    const brandOk = (bid) => !sr.brand || bid === sr.brand;
    const brands = S.brands.filter((b) => (!sr.brand || b.id === sr.brand) && match(lc(b.name), ''));
    const series = S.series.filter((s) => brandOk(s.brandId) && match(lc(s.name + ' ' + (s.year || '') + ' ' + ((I.brand.get(s.brandId) || {}).name || '')), ''));
    const units = S.units.filter((u) => brandOk(u.brandId) && match(lc(u.model + ' ' + (u.productCode || '') + ' ' + ((I.brand.get(u.brandId) || {}).name || '')), strip(lc(u.model + (u.productCode || '')))));
    const groups = new Map();
    S.parts.forEach((p) => {
      const u = I.unit.get(p.unitId);
      if (!u || !brandOk(u.brandId)) return;
      if (!p._h) { p._h = lc([p.name, p.desc, p.tSku, p.mSku, p.notes, p.item].join(' ')); p._hs = strip(lc(p.tSku + p.mSku)); }
      if (!match(p._h, p._hs)) return;
      const key = p.tSku || 'np:' + p.id;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { name: p.name, tSku: p.tSku, mSku: p.mSku, desc: p.desc, lines: [] }));
      if (!g.mSku && p.mSku) g.mSku = p.mSku;
      g.lines.push({ u, p });
    });
    const gl = [...groups.values()].sort((a, b) => nat(a.tSku || a.name, b.tSku || b.name));
    let cat = [], catTotal = 0;
    if (!sr.brand) {
      const all = Store.getCatalog().filter((c) => !I.partSkus.has(c.tSku) && match(lc(c.tSku + ' ' + c.desc + ' ' + c.mSku), strip(lc(c.tSku + c.mSku))));
      catTotal = all.length;
      cat = all.slice(0, 60);
    }
    const unitPath = (u) => {
      const ss = (u.seriesIds || []).map((x) => I.series.get(x)).filter(Boolean);
      const b = I.brand.get(u.brandId);
      const s0 = ss[0];
      return `<a class="path" href="#/u/${u.id}${s0 ? '?s=' + s0.id : ''}">${esc(b ? b.name : '')} › ${esc(ss.map((s) => s.name + (s.year ? ' ' + s.year : '')).join(' / ') || '—')} › ${esc(TYPE[u.type].label)} ${ltr(u.model)}</a>`;
    };
    const total = gl.length;
    const shown = gl.slice(0, sr.limit);
    const none = !brands.length && !series.length && !units.length && !gl.length && !cat.length;
    return `<div class="pagehead"><h1>תוצאות חיפוש: ${esc(qs)}</h1>
        <select class="inp" id="srBrand" aria-label="סינון לפי מותג"><option value="">כל המותגים</option>${S.brands.slice().sort((a, b) => nat(a.name, b.name)).map((b) => `<option value="${b.id}" ${sr.brand === b.id ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select></div>
      ${none ? '<div class="card empty">לא נמצאו תוצאות.</div>' : `<p class="rsum">${total} חלקים · ${series.length} דגמים · ${units.length} יחידות${brands.length ? ' · ' + brands.length + ' מותגים' : ''}${catTotal ? ' · ' + catTotal.toLocaleString('he-IL') + ' מק״טים בקטלוג הכללי' : ''}</p>`}
      ${brands.length ? `<div class="card rgroup"><h3>מותגים</h3>${brands.map((b) => `<div class="rline"><a class="path" href="#/b/${b.id}">${esc(b.name)}</a></div>`).join('')}</div>` : ''}
      ${series.length || units.length ? `<div class="card rgroup"><h3>דגמים ויחידות</h3>
        ${series.slice(0, 30).map((s) => `<div class="rline"><a class="path" href="#/s/${s.id}">${esc((I.brand.get(s.brandId) || {}).name || '')} › ${esc(s.name)}${s.year ? ' · ' + esc(s.year) : ''}</a><span class="muted">${countUnits(I.unitsBySeries.get(s.id) || [])}</span></div>`).join('')}
        ${units.slice(0, 40).map((u) => `<div class="rline">${unitPath(u)}</div>`).join('')}</div>` : ''}
      ${shown.map((g) => `<div class="card rgroup"><h3>${esc(g.name)}</h3>
        <div class="rline" style="border:0;padding-top:0">${g.tSku ? `<span>מק״ט תדיראן: <button class="sku" data-act="copy" data-v="${esc(g.tSku)}">${ltr(g.tSku)}</button></span>` : '<span class="badge warn">ללא מק״ט תדיראן</span>'}${g.mSku ? `<span>מק״ט יצרן: <button class="sku" data-act="copy" data-v="${esc(g.mSku)}">${ltr(g.mSku)}</button></span>` : ''}${g.desc ? `<span class="muted">${esc(g.desc)}</span>` : ''}</div>
        <div class="muted" style="margin:4px 0">מופיע ב-${g.lines.length} ${g.lines.length === 1 ? 'יחידה' : 'יחידות'}:</div>
        ${g.lines.slice(0, 25).map((l) => `<div class="rline">${unitPath(l.u)}${l.p.item ? `<span class="muted">פריט ${esc(l.p.item)}</span>` : ''}</div>`).join('')}${g.lines.length > 25 ? `<div class="muted">ועוד ${g.lines.length - 25}…</div>` : ''}</div>`).join('')}
      ${total > shown.length ? `<div style="text-align:center"><button class="btn" data-act="moreResults">הצג עוד (${total - shown.length})</button></div>` : ''}
      ${cat.length ? `<div class="card rgroup"><h3>קטלוג מק״טים כללי <span class="muted" style="font-size:14px">(לא משויך לדגם${catTotal > cat.length ? ', מוצגים ' + cat.length + ' הראשונים. צמצם את החיפוש' : ''})</span></h3>${cat.map((c) => `<div class="rline"><button class="sku" data-act="copy" data-v="${esc(c.tSku)}">${ltr(c.tSku)}</button><span>${esc(c.desc)}</span>${c.mSku ? `<span class="muted">יצרן: ${ltr(c.mSku)}</span>` : ''}</div>`).join('')}</div>` : ''}`;
  }

  // ===== פעולות (האצלה) =====
  const A = {};
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-act]');
    if (!t) return;
    const fn = A[t.dataset.act];
    if (!fn) return;
    const adminActs = ['addBrand', 'editBrand', 'delBrand', 'addSeries', 'editSeries', 'delSeries', 'addUnit', 'editUnit', 'delUnit', 'linkUnit', 'unlinkUnit', 'addPart', 'editPart', 'delPart', 'addDiagram', 'renameDiagram', 'delDiagram', 'import', 'exportAll', 'exportUnit', 'backup', 'restore'];
    if (adminActs.includes(t.dataset.act) && !isAdmin()) return;
    const m = $('#menu');
    if (m) m.hidden = true;
    Promise.resolve(fn(t.dataset, t, e)).catch(saveErr);
  });
  document.addEventListener('input', (e) => { if (e.target.id === 'bfq') { bf.q = e.target.value; render(); const i = $('#bfq'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } } });
  document.addEventListener('change', (e) => { if (e.target.id === 'srBrand') { sr.brand = e.target.value; sr.limit = 40; render(); } });
  document.addEventListener('submit', async (e) => {
    if (e.target.id !== 'qaForm' || !isAdmin()) return;
    e.preventDefault();
    try {
      const unitId = e.target.dataset.unit;
      const name = $('#qa_name').value.trim(), tSku = $('#qa_t').value.trim();
      if (!name) { toast('יש להזין שם חלק', 'err'); $('#qa_name').focus(); return; }
      if (!tSku) { toast('מק״ט תדיראן הוא שדה חובה', 'err'); $('#qa_t').focus(); return; }
      if ((I.partsByUnit.get(unitId) || []).some((x) => x.tSku === tSku)) { toast('מק״ט תדיראן זה כבר קיים ביחידה הזו', 'err'); $('#qa_t').select(); return; }
      S.parts.push({ id: Store.uid('p'), unitId, item: $('#qa_item').value.trim(), qty: '', name, tSku, mSku: $('#qa_m').value.trim(), desc: '', notes: '' });
      const saving = Store.commit();   // מעדכן את הזיכרון מיד ושולח לענן ברקע, כדי שאפשר להמשיך להקליד
      ['qa_name', 'qa_t', 'qa_m'].forEach((id) => { $('#' + id).value = ''; });
      renderParts(); qaPrefill();
      $('#qa_name').focus();
      await saving;
      toast('החלק נוסף', 'ok');
    } catch (err) { saveErr(err); }
  });
  document.addEventListener('dblclick', (e) => {
    const tr = e.target.closest('table.parts tr[data-id]');
    if (tr && isAdmin() && !e.target.closest('button,input,img')) Promise.resolve(A.editPart({ id: tr.dataset.id })).catch(saveErr);
  });

  A.logout = () => logout();
  A.yfilter = (d) => { bf.year = d.v; render(); };
  A.sort = (d) => { if (tbl.sort === d.k) tbl.dir = -tbl.dir; else { tbl.sort = d.k; tbl.dir = 1; } renderParts(); };
  A.moreResults = () => { sr.limit += 40; render(); };
  A.copy = async (d) => {
    try { await navigator.clipboard.writeText(d.v); toast('הועתק: ' + d.v, 'ok'); } catch (e) { toast(d.v); }
  };
  A.zoomimg = async (d, el) => {
    const src = el.src;
    if (!src) return;
    openModal({ title: 'תמונה', body: `<img class="lightbox" src="${src}" alt="">`, wide: true });
  };
  A.reload = async () => {
    if ($('.modal')) { toast('סגור את החלון הפתוח ונסה שוב'); return; }
    await Store.reload();
    render();
    toast('הנתונים עודכנו מהענן', 'ok');
  };
  A.retrySync = async () => { await Store.retry(); toast('נשמר בענן', 'ok'); render(); };

  // ---- מותגים ----
  function brandForm(b) {
    return `${fld('שם המותג *', `<input class="inp" id="f_name" value="${esc(b ? b.name : '')}" maxlength="60">`)}
      ${fld('לוגו (אופציונלי)', '<input type="file" id="f_logo" accept="image/png,image/jpeg,image/webp">', b && b.logo ? '<label><input type="checkbox" id="f_rmlogo"> הסר את הלוגו הקיים</label>' : 'מומלץ קובץ ריבועי או שקוף')}`;
  }
  async function readBrand(m, b) {
    const name = val(m, '#f_name');
    if (!name) throw new Error('יש להזין שם מותג');
    if (S.brands.some((x) => x.id !== (b && b.id) && lc(x.name) === lc(name))) throw new Error('מותג בשם הזה כבר קיים');
    const f = m.q('#f_logo').files[0];
    let logo = b ? b.logo : '';
    if (f) { checkImageFile(f); logo = await blobToDataUrl(await resizeImage(f, 256, 'image/png')); }
    if (b && m.q('#f_rmlogo') && m.q('#f_rmlogo').checked) logo = '';
    return { name, logo };
  }
  A.addBrand = () => openModal({
    title: 'מותג חדש', body: brandForm(null),
    actions: [{ label: 'שמירה', cls: 'primary', run: async (m) => { const d = await readBrand(m, null); const b = { id: Store.uid('b'), ...d, created: Date.now() }; S.brands.push(b); await Store.commit(); toast('המותג נוסף', 'ok'); location.hash = '#/b/' + b.id; render(); } }, { label: 'ביטול', run: (m) => { m.close(); return false; } }]
  });
  A.editBrand = (d) => {
    const b = I.brand.get(d.id);
    openModal({ title: 'עריכת מותג', body: brandForm(b), actions: [{ label: 'שמירה', cls: 'primary', run: async (m) => { Object.assign(b, await readBrand(m, b)); await Store.commit(); toast('נשמר', 'ok'); render(); } }, { label: 'ביטול', run: () => true }] });
  };
  A.delBrand = async (d) => {
    const b = I.brand.get(d.id);
    const units = I.unitsByBrand.get(b.id) || [];
    const pc = units.reduce((n, u) => n + (I.partsByUnit.get(u.id) || []).length, 0);
    if (!confirm(`למחוק את המותג "${b.name}" וכל המידע שבו?\n${(I.seriesByBrand.get(b.id) || []).length} דגמים, ${units.length} יחידות, ${pc} חלקים.\nלא ניתן לשחזר.`)) return;
    for (const u of units.slice()) await removeUnit(u.id, true);
    S.series = S.series.filter((s) => s.brandId !== b.id);
    S.brands = S.brands.filter((x) => x.id !== b.id);
    await Store.commit();
    toast('המותג נמחק', 'ok');
    location.hash = '#/';
  };

  // ---- סדרות / דגמים ----
  function seriesForm(s, brandId) {
    const years = [...new Set(S.series.filter((x) => !brandId || x.brandId === brandId || (s && x.brandId === s.brandId)).map((x) => x.year).filter(Boolean))].sort((a, c) => nat(c, a));
    return `${fld('שם הדגם *', `<input class="inp" id="f_name" value="${esc(s ? s.name : '')}" maxlength="80">`, 'לדוגמה: AMCOR 10 NEW')}
      <div class="row2">${fld('שנתון (אופציונלי)', `<input class="inp" id="f_year" list="yearlist" value="${esc(s ? s.year : '')}" maxlength="20" placeholder="2022"><datalist id="yearlist">${years.map((y) => `<option value="${esc(y)}">`).join('')}</datalist>`)}</div>
      ${fld('הערות', `<textarea id="f_notes" maxlength="500">${esc(s ? s.notes : '')}</textarea>`)}
      ${s ? '' : `<div class="note" style="background:#f8fafc;border-color:var(--line);color:var(--text)"><b>יחידות (אופציונלי)</b> אפשר להוסיף כבר עכשיו, או בהמשך מתוך עמוד הדגם.</div>
      ${fld('מעבה: מספר דגם', '<input class="inp ltr" dir="ltr" id="f_co" maxlength="80">', 'אם המעבה כבר קיים במותג, הוא ישויך לדגם בלי ליצור אותו פעם נוספת')}
      ${fld('מאיידים: מספר דגם בכל שורה', '<textarea class="ltr" dir="ltr" id="f_evs" placeholder="EV-1&#10;EV-2"></textarea>', 'אפשר כמה מאיידים לאותו מעבה')}`}`;
  }
  function readSeries(m, brandId, s) {
    const name = val(m, '#f_name'), year = val(m, '#f_year');
    if (!name) throw new Error('יש להזין שם דגם');
    if (S.series.some((x) => x.id !== (s && s.id) && x.brandId === brandId && lc(x.name) === lc(name) && (x.year || '') === year)) throw new Error('דגם בשם ושנתון הזהים כבר קיים במותג');
    return { name, year, notes: val(m, '#f_notes') };
  }
  A.addSeries = (d) => openModal({
    title: 'דגם חדש', body: seriesForm(null, d.id),
    actions: [{ label: 'שמירה', cls: 'primary', run: async (m) => {
      const s = { id: Store.uid('s'), brandId: d.id, ...readSeries(m, d.id, null) };
      const co = val(m, '#f_co');
      const evs = [...new Set((m.q('#f_evs').value || '').split(/\n/).map((x) => x.trim()).filter(Boolean))];
      S.series.push(s);
      const addU = (type, model) => {
        const ex = S.units.find((u) => u.brandId === d.id && u.type === type && lc(u.model) === lc(model));
        if (ex) { if (!(ex.seriesIds || []).includes(s.id)) ex.seriesIds.push(s.id); return; }
        S.units.push({ id: Store.uid('u'), brandId: d.id, type, model, productCode: '', chartRef: '', capacity: '', notes: '', seriesIds: [s.id] });
      };
      if (co) addU('condenser', co);
      evs.forEach((e) => addU('evaporator', e));
      bf.year = 'all'; bf.q = '';
      await Store.commit();
      toast('הדגם נוסף', 'ok');
      location.hash = '#/s/' + s.id;
    } }, { label: 'ביטול', run: () => true }]
  });
  A.editSeries = (d) => {
    const s = I.series.get(d.id);
    openModal({ title: 'עריכת דגם', body: seriesForm(s), actions: [{ label: 'שמירה', cls: 'primary', run: async (m) => { Object.assign(s, readSeries(m, s.brandId, s)); bf.year = 'all'; await Store.commit(); toast('נשמר', 'ok'); render(); } }, { label: 'ביטול', run: () => true }] });
  };
  A.delSeries = async (d) => {
    const s = I.series.get(d.id);
    const units = I.unitsBySeries.get(s.id) || [];
    const only = units.filter((u) => (u.seriesIds || []).length <= 1);
    const pc = only.reduce((n, u) => n + (I.partsByUnit.get(u.id) || []).length, 0);
    if (!confirm(`למחוק את הדגם "${s.name}"?\nיימחקו ${only.length} יחידות השייכות רק לדגם הזה, עם ${pc} חלקים.${units.length - only.length ? `\n${units.length - only.length} יחידות משותפות יישארו בדגמים האחרים.` : ''}\nלא ניתן לשחזר.`)) return;
    for (const u of only) await removeUnit(u.id, true);
    S.units.forEach((u) => { u.seriesIds = (u.seriesIds || []).filter((x) => x !== s.id); });
    S.series = S.series.filter((x) => x.id !== s.id);
    await Store.commit();
    toast('הדגם נמחק', 'ok');
    location.hash = '#/b/' + s.brandId;
  };

  // ---- יחידות ----
  function unitForm(u, type) {
    const t = u ? u.type : type || 'evaporator';
    return `${fld('סוג יחידה *', `<div class="radios"><label><input type="radio" name="f_type" value="condenser" ${t === 'condenser' ? 'checked' : ''}> מעבה (חיצונית)</label><label><input type="radio" name="f_type" value="evaporator" ${t === 'evaporator' ? 'checked' : ''}> מאייד (פנימית)</label></div>`)}
      ${fld('מספר דגם היחידה *', `<input class="inp ltr" dir="ltr" id="f_model" value="${esc(u ? u.model : '')}" maxlength="80">`)}
      <div class="row2">${fld('קוד מוצר', `<input class="inp ltr" dir="ltr" id="f_code" value="${esc(u ? u.productCode : '')}" maxlength="80">`)}${fld('תפוקה', `<input class="inp" id="f_cap" value="${esc(u ? u.capacity : '')}" maxlength="40" placeholder="לדוגמה: 9000 BTU">`)}</div>
      ${fld('הערות טכניות', `<textarea id="f_notes" maxlength="1000">${esc(u ? u.notes : '')}</textarea>`)}
      ${fld('תמונת הדגם (אופציונלי)', '<input type="file" id="f_img" accept="image/png,image/jpeg,image/webp">', u && u.hasImg ? '<label><input type="checkbox" id="f_rmimg"> הסר את התמונה הקיימת</label>' : '')}`;
  }
  async function readUnit(m, brandId, u) {
    const type = (m.q('input[name=f_type]:checked') || {}).value;
    const model = val(m, '#f_model');
    if (!type) throw new Error('יש לבחור סוג יחידה');
    if (!model) throw new Error('יש להזין מספר דגם');
    if (S.units.some((x) => x.id !== (u && u.id) && x.brandId === brandId && x.type === type && lc(x.model) === lc(model))) throw new Error('יחידה כזו כבר קיימת במותג. אפשר לשייך אותה לדגם דרך "שיוך יחידה קיימת".');
    const f = m.q('#f_img').files[0];
    if (f) checkImageFile(f);
    return { type, model, productCode: val(m, '#f_code'), capacity: val(m, '#f_cap'), notes: val(m, '#f_notes'), file: f, rm: !!(m.q('#f_rmimg') && m.q('#f_rmimg').checked) };
  }
  async function saveUnitImage(u, d) {
    if (d.file) { await Store.putFile('ui:' + u.id, await resizeImage(d.file, 900, 'image/jpeg', 0.85)); dropUrl('ui:' + u.id); u.hasImg = true; }
    else if (d.rm && u.hasImg) { await Store.delFile('ui:' + u.id); dropUrl('ui:' + u.id); u.hasImg = false; }
  }
  A.addUnit = (d) => {
    const s = I.series.get(d.sid);
    openModal({
      title: 'יחידה חדשה', body: unitForm(null, d.type),
      actions: [{ label: 'שמירה', cls: 'primary', run: async (m) => {
        const x = await readUnit(m, s.brandId, null);
        const u = { id: Store.uid('u'), brandId: s.brandId, type: x.type, model: x.model, productCode: x.productCode, chartRef: '', capacity: x.capacity, notes: x.notes, seriesIds: [s.id] };
        await saveUnitImage(u, x);
        S.units.push(u);
        await Store.commit();
        toast('היחידה נוספה', 'ok');
        location.hash = `#/u/${u.id}?s=${s.id}`;
      } }, { label: 'ביטול', run: () => true }]
    });
  };
  A.editUnit = (d) => {
    const u = I.unit.get(d.id);
    openModal({ title: 'עריכת יחידה', body: unitForm(u), actions: [{ label: 'שמירה', cls: 'primary', run: async (m) => {
      const x = await readUnit(m, u.brandId, u);
      Object.assign(u, { type: x.type, model: x.model, productCode: x.productCode, capacity: x.capacity, notes: x.notes });
      await saveUnitImage(u, x);
      await Store.commit();
      toast('נשמר', 'ok');
      render();
    } }, { label: 'ביטול', run: () => true }] });
  };
  async function removeUnit(id, skipCommit) {
    for (const p of (I.partsByUnit.get(id) || []).slice()) if (p.hasImg) { await Store.delFile('pi:' + p.id); dropUrl('pi:' + p.id); }
    for (const g of (I.diagByUnit.get(id) || []).slice()) await Store.delFile('dg:' + g.id);
    const u = I.unit.get(id);
    if (u && u.hasImg) { await Store.delFile('ui:' + id); dropUrl('ui:' + id); }
    S.parts = S.parts.filter((p) => p.unitId !== id);
    S.diagrams = S.diagrams.filter((g) => g.unitId !== id);
    S.units = S.units.filter((x) => x.id !== id);
    if (!skipCommit) await Store.commit();
  }
  A.delUnit = async (d) => {
    const u = I.unit.get(d.id);
    const pc = (I.partsByUnit.get(u.id) || []).length, dc = (I.diagByUnit.get(u.id) || []).length;
    if (!confirm(`למחוק את היחידה ${u.model}?\n${pc} חלקים ו-${dc} סכמות יימחקו. לא ניתן לשחזר.`)) return;
    const sid = (u.seriesIds || [])[0];
    await removeUnit(u.id);
    toast('היחידה נמחקה', 'ok');
    location.hash = sid ? '#/s/' + sid : '#/';
  };
  A.linkUnit = (d) => {
    const s = I.series.get(d.sid);
    const free = (I.unitsByBrand.get(s.brandId) || []).filter((u) => !(u.seriesIds || []).includes(s.id));
    if (!free.length) { toast('אין יחידות נוספות במותג לשיוך'); return; }
    const opt = (t) => free.filter((u) => u.type === t).sort((a, b) => nat(a.model, b.model)).map((u) => `<option value="${u.id}">${esc(u.model)}</option>`).join('');
    openModal({
      title: 'שיוך יחידה קיימת לדגם',
      body: `<div class="note">מתאים למעבה אחד שמשרת כמה דגמים או מאיידים. היחידה לא תשוכפל, והחלקים שלה יוצגו בכל הדגמים המשויכים.</div>${fld('יחידה', `<select class="inp" id="f_unit"><optgroup label="מעבים">${opt('condenser')}</optgroup><optgroup label="מאיידים">${opt('evaporator')}</optgroup></select>`)}`,
      actions: [{ label: 'שיוך', cls: 'primary', run: async (m) => { const u = I.unit.get(m.q('#f_unit').value); if (!u) throw new Error('יש לבחור יחידה'); u.seriesIds.push(s.id); await Store.commit(); toast('היחידה שויכה', 'ok'); render(); } }, { label: 'ביטול', run: () => true }]
    });
  };
  A.unlinkUnit = async (d) => {
    const u = I.unit.get(d.id);
    if ((u.seriesIds || []).length < 2) return;
    if (!confirm('להסיר את היחידה מהדגם הזה? היחידה והחלקים שלה יישארו בדגמים האחרים.')) return;
    u.seriesIds = u.seriesIds.filter((x) => x !== d.sid);
    await Store.commit();
    render();
  };
  A.exportUnit = (d) => { const r = Excel.exportUnit(S, I, I.unit.get(d.id)); download(r.blob, r.name); };

  // ---- חלקים ----
  function partForm(p) {
    return `<div class="row2">${fld('מספר פריט בסכמה', `<input class="inp" id="f_item" value="${esc(p ? p.item : '')}" maxlength="20">`)}${fld('כמות', `<input class="inp" id="f_qty" value="${esc(p ? p.qty : '')}" maxlength="10">`)}</div>
      ${fld('שם החלק *', `<input class="inp" id="f_name" value="${esc(p ? p.name : '')}" maxlength="200">`)}
      <div class="row2">${fld('מק״ט תדיראן *', `<input class="inp ltr" dir="ltr" id="f_t" value="${esc(p ? p.tSku : '')}" maxlength="60">`, '<span id="catHint"></span>')}${fld('מק״ט יצרן מקורי (אופציונלי)', `<input class="inp ltr" dir="ltr" id="f_m" value="${esc(p ? p.mSku : '')}" maxlength="80">`)}</div>
      ${fld('תיאור', `<textarea id="f_desc" maxlength="500">${esc(p ? p.desc : '')}</textarea>`)}
      ${fld('הערות', `<textarea id="f_notes" maxlength="1000">${esc(p ? p.notes : '')}</textarea>`)}
      ${fld('תמונת החלק (אופציונלי)', '<input type="file" id="f_img" accept="image/png,image/jpeg,image/webp">', p && p.hasImg ? '<label><input type="checkbox" id="f_rmimg"> הסר את התמונה הקיימת</label>' : '')}`;
  }
  function partMount(m) {
    const t = m.q('#f_t');
    t.addEventListener('blur', () => {
      const c = I.cat.get(t.value.trim());
      const hint = m.q('#catHint');
      if (!c) { hint.textContent = ''; return; }
      hint.textContent = 'נמצא בקטלוג הכללי: ' + c.desc;
      if (!m.q('#f_name').value.trim()) m.q('#f_name').value = c.desc;
      if (!m.q('#f_m').value.trim() && c.mSku) m.q('#f_m').value = c.mSku;
    });
  }
  async function readPart(m, unitId, p) {
    const name = val(m, '#f_name'), tSku = val(m, '#f_t');
    if (!name) throw new Error('יש להזין שם חלק');
    if (!tSku) throw new Error('מק״ט תדיראן הוא שדה חובה');
    if ((I.partsByUnit.get(unitId) || []).some((x) => x.id !== (p && p.id) && x.tSku === tSku)) throw new Error('מק״ט תדיראן זה כבר קיים ביחידה הזו');
    const f = m.q('#f_img').files[0];
    if (f) checkImageFile(f);
    return { item: val(m, '#f_item'), qty: val(m, '#f_qty'), name, tSku, mSku: val(m, '#f_m'), desc: val(m, '#f_desc'), notes: val(m, '#f_notes'), file: f, rm: !!(m.q('#f_rmimg') && m.q('#f_rmimg').checked) };
  }
  async function savePartImage(p, d) {
    if (d.file) { await Store.putFile('pi:' + p.id, await resizeImage(d.file, 600, 'image/jpeg', 0.85)); dropUrl('pi:' + p.id); p.hasImg = true; }
    else if (d.rm && p.hasImg) { await Store.delFile('pi:' + p.id); dropUrl('pi:' + p.id); p.hasImg = false; }
  }
  A.addPart = (d) => openModal({
    title: 'הוספת חלק', body: partForm(null), onMount: partMount,
    actions: [{ label: 'שמירה', cls: 'primary', run: async (m) => {
      const x = await readPart(m, d.id, null);
      const p = { id: Store.uid('p'), unitId: d.id, item: x.item, qty: x.qty, name: x.name, tSku: x.tSku, mSku: x.mSku, desc: x.desc, notes: x.notes };
      await savePartImage(p, x);
      S.parts.push(p);
      await Store.commit();
      toast('החלק נוסף', 'ok');
      renderParts(); qaPrefill();
    } }, { label: 'ביטול', run: () => true }]
  });
  A.editPart = (d) => {
    const p = S.parts.find((x) => x.id === d.id);
    openModal({ title: 'עריכת חלק', body: partForm(p), onMount: partMount, actions: [{ label: 'שמירה', cls: 'primary', run: async (m) => {
      const x = await readPart(m, p.unitId, p);
      Object.assign(p, { item: x.item, qty: x.qty, name: x.name, tSku: x.tSku, mSku: x.mSku, desc: x.desc, notes: x.notes });
      delete p._h; delete p._hs;
      await savePartImage(p, x);
      await Store.commit();
      toast('נשמר', 'ok');
      renderParts();
    } }, { label: 'ביטול', run: () => true }] });
  };
  A.delPart = async (d) => {
    const p = S.parts.find((x) => x.id === d.id);
    if (!confirm(`למחוק את החלק "${p.name}" (${p.tSku || 'ללא מק״ט'})?`)) return;
    if (p.hasImg) { await Store.delFile('pi:' + p.id); dropUrl('pi:' + p.id); }
    S.parts = S.parts.filter((x) => x.id !== p.id);
    await Store.commit();
    toast('החלק נמחק', 'ok');
    renderParts(); qaPrefill();
  };

  // ---- סכמות ----
  const DG_OK = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png' };
  A.dgTab = (d) => { dg.id = d.id; dg.zoom = 100; renderDiagramBar(); showDiagram(); };
  A.dgZoom = (d) => {
    const dl = Number(d.d);
    dg.zoom = dl === 0 ? 100 : Math.max(25, Math.min(400, dg.zoom + dl));
    const img = $('.dgimg');
    if (img) img.style.width = dg.zoom + '%';
    const z = $('#dgZ');
    if (z) z.textContent = dg.zoom + '%';
  };
  A.dgFull = () => { const b = $('#dgBox'); if (b.requestFullscreen) b.requestFullscreen().catch(() => toast('הדפדפן לא אפשר מסך מלא')); else toast('הדפדפן לא תומך במסך מלא'); };
  A.dgOpen = () => { if (dg.url) window.open(dg.url, '_blank'); };
  A.dgDownload = () => {
    const d = (I.diagByUnit.get(dg.unitId) || []).find((x) => x.id === dg.id);
    if (!d) return;
    return Store.getFile('dg:' + d.id).then((b) => b && download(b, d.fileName || d.name));
  };
  A.addDiagram = () => {
    const unitId = dg.unitId;
    openModal({
      title: 'העלאת סכמת פיצוץ',
      body: `${fld('שם הסכמה *', '<input class="inp" id="f_name" list="dgnames" maxlength="80" placeholder="לדוגמה: סכמת יחידה פנימית"><datalist id="dgnames"><option value="סכמת יחידה פנימית"><option value="סכמת יחידה חיצונית"><option value="סכמת מכלול חשמלי"><option value="סכמת מכלול מכני"></datalist>')}${fld('קובץ *', '<input type="file" id="f_file" accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png">', `PDF, JPG או PNG, עד ${CFG.maxDiagramMB}MB`)}`,
      actions: [{ label: 'העלאה', cls: 'primary', run: async (m) => {
        const name = val(m, '#f_name'), f = m.q('#f_file').files[0];
        if (!name) throw new Error('יש להזין שם לסכמה');
        if (!f) throw new Error('יש לבחור קובץ');
        const ext = f.name.split('.').pop().toLowerCase();
        if (!DG_OK[ext]) throw new Error('סוג הקובץ אינו נתמך. יש להעלות PDF, JPG או PNG.');
        if (f.size > CFG.maxDiagramMB * 1048576) throw new Error(`הקובץ גדול מ-${CFG.maxDiagramMB}MB`);
        const d = { id: Store.uid('d'), unitId, name, fileName: f.name, mime: DG_OK[ext], size: f.size, created: Date.now() };
        await Store.putFile('dg:' + d.id, new Blob([await f.arrayBuffer()], { type: d.mime }));
        S.diagrams.push(d);
        try { await Store.commit(); } catch (e) { try { await Store.delFile('dg:' + d.id); } catch (e2) { /* ignore */ } throw e; }
        dg.id = d.id; dg.zoom = 100;
        toast('הסכמה נשמרה', 'ok');
        renderDiagramBar(); showDiagram();
      } }, { label: 'ביטול', run: () => true }]
    });
  };
  A.renameDiagram = () => {
    const d = (I.diagByUnit.get(dg.unitId) || []).find((x) => x.id === dg.id);
    if (!d) return;
    openModal({ title: 'שינוי שם סכמה', body: fld('שם', `<input class="inp" id="f_name" value="${esc(d.name)}" maxlength="80">`), actions: [{ label: 'שמירה', cls: 'primary', run: async (m) => { const n = val(m, '#f_name'); if (!n) throw new Error('יש להזין שם'); d.name = n; await Store.commit(); renderDiagramBar(); } }, { label: 'ביטול', run: () => true }] });
  };
  A.delDiagram = async () => {
    const d = (I.diagByUnit.get(dg.unitId) || []).find((x) => x.id === dg.id);
    if (!d || !confirm(`למחוק את הסכמה "${d.name}"?`)) return;
    await Store.delFile('dg:' + d.id);
    S.diagrams = S.diagrams.filter((x) => x.id !== d.id);
    await Store.commit();
    dg.id = '';
    renderDiagramBar(); showDiagram();
    toast('הסכמה נמחקה', 'ok');
  };

  // ===== ייבוא Excel (קבצים ותיקיות; שם התיקייה = שנתון) =====
  const imp = { files: [], folders: new Map(), groups: [], brand: '', newBrand: '', defYear: '', importBad: false, importCat: true, skipped: [], catalogRows: [], busy: false };
  const isExcelName = (n) => /\.(xls|xlsx|xlsm)$/i.test(n) && !/^~\$/.test(n);
  const yearFromFolder = (name) => { const c = String(name || '').replace(/שנתון/g, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim(); return c || String(name || '').trim(); };
  const tick = () => new Promise((r) => setTimeout(r, 0));

  A.import = (d) => {
    Object.assign(imp, { files: [], folders: new Map(), groups: [], brand: d && d.brand ? d.brand : '', newBrand: '', defYear: '', importBad: false, importCat: true, skipped: [], catalogRows: [], busy: false });
    const m = openModal({
      title: 'ייבוא מ-Excel', wide: true,
      body: `<div id="impBody"><div class="note">אפשר לבחור <b>תיקייה שלמה</b> (למשל תיקיית אב שבתוכה תיקיות של שנתונים), או כמה קבצי Excel. המערכת עוברת על כל הקבצים והגיליונות, מזהה דגמים, מאיידים ומעבים, חלקי חילוף ותמונות (סכמות פיצוץ), ו<b>שם התיקייה הופך לשנתון</b> (אפשר לתקן). לפני השמירה תוצג תצוגה מקדימה, ושום דבר לא נשמר או נדרס לפני האישור שלך.</div>
        <div class="pickrow"><label class="btn primary pick">בחירת תיקייה<input type="file" id="impDir" webkitdirectory directory multiple hidden></label>
        <label class="btn pick">בחירת קבצי Excel<input type="file" id="impFile" accept=".xls,.xlsx,.xlsm" multiple hidden></label></div>
        <p class="muted">נתמכים XLS ו-XLSX. קבצי עבודה זמניים של Excel (שמתחילים ב-~$) ושאר סוגי קבצים מדולגים.</p></div>`,
      actions: [{ label: 'אישור ושמירה', cls: 'primary', run: commitImport }, { label: 'ביטול', run: () => true }]
    });
    m.el.querySelector('.mfoot .primary').disabled = true;
    const onPick = (e) => { const fl = [...e.target.files]; if (fl.length) loadImportFiles(m, fl); };
    $('#impDir', m.el).addEventListener('change', onPick);
    $('#impFile', m.el).addEventListener('change', onPick);
    m.el.addEventListener('input', (e) => onImportInput(e, m));
    m.el.addEventListener('change', (e) => onImportInput(e, m));
    m.el.addEventListener('toggle', (e) => { const d2 = e.target; if (d2.classList && d2.classList.contains('impfd') && d2.open && !d2.dataset.done) { d2.dataset.done = '1'; $('.impfbody', d2).innerHTML = renderFileBody(Number(d2.dataset.fi)); } }, true);
  };

  async function loadImportFiles(m, list) {
    if (imp.busy) return;
    imp.busy = true;
    const body = $('#impBody', m.el);
    const excel = list.filter((f) => isExcelName(f.name));
    const skipped = list.filter((f) => !isExcelName(f.name)).map((f) => f.name);
    if (!excel.length) { toast('לא נמצאו קבצי Excel בבחירה', 'err'); imp.busy = false; return; }
    excel.sort((a, b) => nat(a.webkitRelativePath || a.name, b.webkitRelativePath || b.name));
    body.innerHTML = '<p id="impProg" class="muted"></p><div class="prog"><div id="impBar"></div></div>';
    const files = [], catMap = new Map();
    for (let i = 0; i < excel.length; i++) {
      const f = excel[i];
      $('#impProg', m.el).textContent = `קורא קובץ ${i + 1} מתוך ${excel.length}: ${f.name}`;
      $('#impBar', m.el).style.width = Math.round((i / excel.length) * 100) + '%';
      await tick();
      const path = f.webkitRelativePath || f.name;
      const parts = path.split('/');
      const folder = parts.length > 1 ? parts.slice(0, -1).join('/') : '';
      const rec = { name: f.name, path, folder, folderKey: folder, include: true, units: [], catalogs: 0, ignored: [], error: '', imgWarn: 0 };
      try {
        const book = SheetIO.read(await f.arrayBuffer());
        const P = Excel.parseWorkbook(book);
        const ex = await Excel.extractImages(book);
        P.units.forEach((u) => { u.images = ex.bySheet.get(u.sheet) || []; const w = ex.warns.find((x) => x.sheet === u.sheet); u.imageWarn = w ? w.msg : ''; if (w) rec.imgWarn++; });
        rec.units = P.units; rec.ignored = P.ignored;
        P.catalogs.forEach((c) => { rec.catalogs += c.rows.length; c.rows.forEach((r) => { if (!catMap.has(r.tSku)) catMap.set(r.tSku, r); }); });
      } catch (err) { console.error(f.name, err); rec.error = err && err.message ? err.message : 'קריאת הקובץ נכשלה'; }
      files.push(rec);
    }
    imp.files = files; imp.skipped = skipped; imp.catalogRows = [...catMap.values()];
    imp.folders = new Map();
    files.forEach((f) => {
      if (!imp.folders.has(f.folderKey)) { const parent = f.folder ? f.folder.split('/').pop() : ''; imp.folders.set(f.folderKey, { key: f.folderKey, label: f.folder || 'ללא תיקייה', year: parent ? yearFromFolder(parent) : '' }); }
    });
    // קבוצות = דגם בתוך קובץ (מאייד ומעבה של אותו דגם יחד)
    imp.groups = [];
    files.forEach((f, fi) => {
      const map = new Map();
      f.units.forEach((u) => { const k = lc(u.seriesName); if (!map.has(k)) map.set(k, { fi, name: u.seriesName, units: [] }); map.get(k).units.push(u); });
      map.forEach((g) => { g.gi = imp.groups.length; imp.groups.push(g); });
      f.groups = imp.groups.filter((g) => g.fi === fi);
    });
    imp.busy = false;
    renderImport(m);
  }

  const fileStats = (f) => ({ sheets: f.units.length, parts: f.units.reduce((n, u) => n + u.good.length, 0), bad: f.units.reduce((n, u) => n + u.bad.length, 0), imgs: f.units.reduce((n, u) => n + u.images.length, 0) });

  function renderFileBody(fi) {
    const f = imp.files[fi];
    if (f.error) return `<div class="note err">${esc(f.error)}</div>`;
    return f.groups.map((g) => `<div class="impgroup"><div class="imphead"><b>דגם:</b><input class="inp" data-g="${g.gi}" data-f="name" value="${esc(g.name)}" aria-label="שם הדגם"></div>
        ${g.units.map((u, ui) => `<div class="improw ${u.include ? '' : 'off'}"><input type="checkbox" data-g="${g.gi}" data-ui="${ui}" data-f="include" ${u.include ? 'checked' : ''} aria-label="כלול"><select class="inp" data-g="${g.gi}" data-ui="${ui}" data-f="type" aria-label="סוג יחידה"><option value="" ${u.type ? '' : 'selected'}>בחר סוג…</option><option value="condenser" ${u.type === 'condenser' ? 'selected' : ''}>מעבה</option><option value="evaporator" ${u.type === 'evaporator' ? 'selected' : ''}>מאייד</option></select><input class="inp ltr" dir="ltr" data-g="${g.gi}" data-ui="${ui}" data-f="model" value="${esc(u.model)}" aria-label="דגם היחידה"><span class="meta">${u.productCode ? 'קוד מוצר: ' + esc(u.productCode) + ' · ' : ''}גיליון: ${esc(u.sheet)}${u.modelFromFile ? '' : ' · לא נמצא דגם בקובץ, נלקח שם הגיליון'}</span><span><b>${u.good.length}</b> חלקים תקינים</span></div>
        ${!u.type ? '<div class="note" style="margin:0 12px 8px">לא ניתן היה לזהות אם זה מאייד או מעבה. בחר סוג כדי לכלול את היחידה.</div>' : ''}
        <div class="impimg">${u.images.length ? `<label><input type="checkbox" data-g="${g.gi}" data-ui="${ui}" data-f="useImages" ${u.useImages ? 'checked' : ''}> ייבוא סכמת פיצוץ מהגיליון (${u.images.length === 1 ? 'תמונה אחת' : u.images.length + ' תמונות'})</label>${u.images.map((im) => `<img src="${im.thumb}" alt="סכמה (${im.w}×${im.h})" title="${im.w}×${im.h}">`).join('')}` : `<span class="muted">${u.imageWarn ? esc(u.imageWarn) : 'לא נמצאה תמונה בגיליון הזה'}</span>`}</div>
        ${u.bad.length || u.dups.length ? `<details class="bad"><summary>${u.bad.length ? u.bad.length + ' שורות עם מק״ט תדיראן חסר/לא תקין' : ''}${u.bad.length && u.dups.length ? ' · ' : ''}${u.dups.length ? u.dups.length + ' כפילויות' : ''}</summary><table><tr><th>שורה</th><th>פריט</th><th>שם</th><th>מק״ט יצרן</th><th>סיבה</th></tr>${[...u.bad, ...u.dups].slice(0, 60).map((r) => `<tr><td>${r.row}</td><td>${esc(r.item)}</td><td>${esc(r.name)}</td><td>${esc(r.mSku)}</td><td>${esc(r.reason)}</td></tr>`).join('')}</table></details>` : ''}`).join('')}</div>`).join('') +
      (f.ignored.length ? `<div class="muted" style="font-size:13px;margin:6px 0">גיליונות שהוזנחו: ${f.ignored.map((x) => esc(x.sheet) + ' (' + esc(x.reason) + ')').join(' · ')}</div>` : '');
  }

  function renderImport(m) {
    const brandOpts = `<option value="">— בחר מותג —</option>${S.brands.slice().sort((a, b) => nat(a.name, b.name)).map((b) => `<option value="${b.id}" ${imp.brand === b.id ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}<option value="__new" ${imp.brand === '__new' ? 'selected' : ''}>+ מותג חדש…</option>`;
    const okFiles = imp.files.filter((f) => !f.error);
    const tot = okFiles.reduce((a, f) => { const s = fileStats(f); a.sheets += s.sheets; a.parts += s.parts; a.imgs += s.imgs; return a; }, { sheets: 0, parts: 0, imgs: 0 });
    const noYear = [...imp.folders.values()].some((x) => !x.year);
    const byFolder = new Map();
    imp.files.forEach((f, fi) => { if (!byFolder.has(f.folderKey)) byFolder.set(f.folderKey, []); byFolder.get(f.folderKey).push(fi); });
    $('#impBody', m.el).innerHTML = `
      <p><b>${imp.files.length}</b> קבצים · ${tot.sheets} גיליונות יחידה · ${tot.parts.toLocaleString('he-IL')} חלקים · ${tot.imgs} סכמות (תמונות)${imp.catalogRows.length ? ` · ${imp.catalogRows.length.toLocaleString('he-IL')} מק״טים בקטלוג כללי` : ''}${imp.skipped.length ? ` · ${imp.skipped.length} קבצים שאינם Excel דולגו` : ''}</p>
      <div class="row2">${fld('מותג *', `<select class="inp" id="i_brand">${brandOpts}</select>`)}<div class="fld" id="i_newwrap" ${imp.brand === '__new' ? '' : 'hidden'}><label>שם המותג החדש *</label><input class="inp" id="i_newname" value="${esc(imp.newBrand)}" maxlength="60"></div></div>
      ${noYear ? `<div class="row2">${fld('שנתון לקבצים שאינם בתוך תיקייה (אופציונלי)', `<input class="inp" id="i_year" value="${esc(imp.defYear)}" maxlength="20">`)}<div></div></div>` : ''}
      ${[...byFolder.entries()].map(([fk, idxs]) => { const fo = imp.folders.get(fk); return `<section class="impfolder"><div class="impfh"><span>📁 <b dir="auto">${esc(fo.label)}</b></span><label class="yr">שנתון: <input class="inp" style="width:110px" data-fk="${esc(fk)}" value="${esc(fo.year)}" maxlength="20" placeholder="ללא שנתון" aria-label="שנתון"></label></div>
        ${idxs.map((fi) => { const f = imp.files[fi], st = fileStats(f); return `<div class="impfile ${f.include ? '' : 'off'}"><input type="checkbox" data-fi="${fi}" data-f="fileInclude" ${f.include && !f.error ? 'checked' : ''} ${f.error ? 'disabled' : ''} aria-label="כלול קובץ"><details class="impfd" data-fi="${fi}"><summary><b dir="auto">${esc(f.name)}</b> ${f.error ? '<span class="badge warn">שגיאה</span>' : `<span class="muted">· ${st.sheets} גיליונות · ${st.parts} חלקים · ${st.imgs} סכמות${st.bad ? ` · <span style="color:var(--warn)">${st.bad} שורות לא תקינות</span>` : ''}</span>`}</summary><div class="impfbody"></div></details></div>`; }).join('')}</section>`; }).join('')}
      ${imp.catalogRows.length ? `<div class="impgroup"><div class="imphead"><label><input type="checkbox" id="i_cat" ${imp.importCat ? 'checked' : ''}> ייבוא קטלוג מק״טים כללי (${imp.catalogRows.length.toLocaleString('he-IL')} מק״טים)</label><span class="muted">משמש לחיפוש ולהשלמת שם חלק, לא משויך לדגם.</span></div></div>` : ''}
      <label style="display:flex;gap:8px;align-items:center;margin-top:10px"><input type="checkbox" id="i_bad" ${imp.importBad ? 'checked' : ''}> לייבא גם שורות ללא מק״ט תדיראן תקין (יסומנו "חסר"). ברירת המחדל: לדלג עליהן.</label>
      <div class="summary" id="impSummary"></div>`;
    refreshImportSummary(m);
  }
  function onImportInput(e, m) {
    const t = e.target;
    if (!imp.files.length) return;
    if (t.id === 'i_brand') { imp.brand = t.value; $('#i_newwrap', m.el).hidden = t.value !== '__new'; }
    else if (t.id === 'i_newname') imp.newBrand = t.value;
    else if (t.id === 'i_year') imp.defYear = t.value;
    else if (t.id === 'i_cat') imp.importCat = t.checked;
    else if (t.id === 'i_bad') imp.importBad = t.checked;
    else if (t.dataset.fk !== undefined) imp.folders.get(t.dataset.fk).year = t.value;
    else if (t.dataset.f === 'fileInclude') { const f = imp.files[Number(t.dataset.fi)]; f.include = t.checked; t.closest('.impfile').classList.toggle('off', !t.checked); }
    else if (t.dataset.g !== undefined) {
      const g = imp.groups[Number(t.dataset.g)];
      const f = t.dataset.f;
      if (t.dataset.ui === undefined) g[f] = t.value;
      else {
        const u = g.units[Number(t.dataset.ui)];
        if (f === 'include') u.include = t.checked;
        else if (f === 'useImages') u.useImages = t.checked;
        else u[f] = t.value;
        if (f === 'type' && t.value && e.type === 'change') u.include = true;
        if (f === 'include' && t.checked && !u.type) { u.include = false; t.checked = false; toast('יש לבחור קודם סוג יחידה'); }
        if (e.type === 'change' && (f === 'type' || f === 'include')) { const det = t.closest('details.impfd'); if (det) $('.impfbody', det).innerHTML = renderFileBody(Number(det.dataset.fi)); }
      }
    }
    refreshImportSummary(m);
  }
  const activeUnits = () => imp.files.filter((f) => f.include && !f.error).flatMap((f) => f.units);
  let sumTimer = null;
  function refreshImportSummary(m) {
    clearTimeout(sumTimer);
    sumTimer = setTimeout(() => {
      const box = $('#impSummary', m.el);
      const btn = m.el.querySelector('.mfoot .primary');
      if (!box || !imp.files.length) return;
      const brandReady = imp.brand && (imp.brand !== '__new' || imp.newBrand.trim());
      const included = activeUnits().filter((u) => u.include && u.type);
      if (!brandReady) { box.textContent = 'בחר מותג (או הזן שם למותג חדש) כדי להמשיך.'; btn.disabled = true; return; }
      if (!included.length && !(imp.importCat && imp.catalogRows.length)) { box.textContent = 'לא נבחרו יחידות לייבוא.'; btn.disabled = true; return; }
      if (included.some((u) => !u.model.trim())) { box.textContent = 'יש יחידה ללא מספר דגם.'; btn.disabled = true; return; }
      if (imp.groups.some((g) => imp.files[g.fi].include && g.units.some((u) => u.include) && !g.name.trim())) { box.textContent = 'יש דגם ללא שם.'; btn.disabled = true; return; }
      const r = runImport();
      box.innerHTML = `סיכום (לפני שמירה): ${r.rep.newBrand ? 'מותג חדש · ' : ''}${r.rep.seriesNew} דגמים חדשים · ${r.rep.unitsNew} יחידות חדשות${r.rep.unitsMerged ? ` · ${r.rep.unitsMerged} הופעות של יחידות קיימות (משותפות או כפולות) יקבלו רק חלקים חדשים` : ''} · ${(r.rep.partsAdded + r.rep.badAdded).toLocaleString('he-IL')} חלקים יתווספו · ${r.rep.partsDup} כפילויות ידולגו${r.rep.badSkipped ? ` · ${r.rep.badSkipped} שורות לא תקינות ידולגו` : ''} · ${r.rep.diagAdded} סכמות יתווספו${r.rep.diagDup ? ` (${r.rep.diagDup} כבר קיימות)` : ''}${r.rep.catAdded ? ` · ${r.rep.catAdded.toLocaleString('he-IL')} מק״טים לקטלוג הכללי` : ''}`;
      btn.disabled = false;
    }, 250);
  }
  function runImport() {
    imp.files.forEach((f) => { const yr = ((imp.folders.get(f.folderKey) || {}).year || '').trim(); f.groups && f.groups.forEach((g) => g.units.forEach((u) => { u.seriesName = g.name.trim(); u.year = yr; })); });
    const work = Store.cloneState();
    const r = Excel.applyImport(work, Store.getCatalog(), { units: activeUnits(), catalogRows: imp.importCat ? imp.catalogRows : [] }, {
      brandId: imp.brand && imp.brand !== '__new' ? imp.brand : '', newBrandName: imp.newBrand, defaultYear: imp.defYear, importBad: imp.importBad
    });
    return { work, ...r };
  }
  async function commitImport(m) {
    const r = runImport();
    const total = r.rep.files.length;
    const written = [];
    const prog = (txt) => { $('#loadMsg').textContent = txt; $('#loading').hidden = false; };
    try {
      for (let i = 0; i < r.rep.files.length; i++) {
        const f = r.rep.files[i];
        prog(`מעלה סכמות לענן ${i + 1} מתוך ${total}…`);
        await Store.putFile(f.key, f.blob); written.push(f.key);
      }
      prog('שומר נתונים בענן…');
      await Store.replaceState(r.work);
      if (r.catalog !== Store.getCatalog()) await Store.setCatalog(r.catalog);
    } catch (err) {
      for (const k of written) { try { await Store.delFile(k); } catch (e) { /* ignore */ } }
      throw err;
    } finally { $('#loading').hidden = true; $('#loadMsg').textContent = 'טוען נתונים מהענן…'; }
    const x = r.rep;
    toast('הייבוא הושלם', 'ok');
    openModal({
      title: 'הייבוא הושלם', body: `<div class="note ok"><b>${esc(x.brandName)}</b><br>${x.seriesNew} דגמים חדשים · ${x.unitsNew} יחידות חדשות${x.unitsMerged ? ` · ${x.unitsMerged} הופעות של יחידות קיימות עודכנו בחלקים חדשים בלבד` : ''}<br>${(x.partsAdded + x.badAdded).toLocaleString('he-IL')} חלקים נוספו${x.badAdded ? ` (מתוכם ${x.badAdded} ללא מק״ט תדיראן תקין)` : ''}<br>${x.diagAdded} סכמות פיצוץ נוספו${x.diagDup ? ` · ${x.diagDup} כבר היו קיימות` : ''}<br>${x.partsDup} כפילויות דולגו${x.badSkipped ? ` · ${x.badSkipped} שורות לא תקינות דולגו` : ''}${x.catAdded ? `<br>${x.catAdded.toLocaleString('he-IL')} מק״טים נוספו לקטלוג הכללי${x.catDup ? ` (${x.catDup} כבר היו קיימים)` : ''}` : ''}</div>`,
      actions: [{ label: 'סגירה', cls: 'primary', run: () => true }]
    });
    const b = S.brands.find((z) => lc(z.name) === lc(x.brandName));
    if (b) location.hash = '#/b/' + b.id;
    render();
  }

  // ===== ייצוא וגיבוי =====
  A.exportAll = () => { const r = Excel.exportAll(S, I, Store.getCatalog()); download(r.blob, r.name); };
  A.backup = () => {
    download(new Blob([Store.exportJSON()], { type: 'application/json' }), `spare-parts-backup-${new Date().toISOString().slice(0, 10)}.json`);
    toast('הגיבוי הורד. שים לב: הגיבוי כולל נתונים אך לא קובצי סכמות ותמונות.');
  };
  A.restore = () => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.json,application/json';
    inp.onchange = async () => {
      const f = inp.files[0];
      if (!f) return;
      try {
        const d = JSON.parse(await f.text());
        if (!d.state || !Array.isArray(d.state.brands) || !Array.isArray(d.state.parts)) throw new Error('הקובץ אינו גיבוי תקין של המערכת');
        const msg = `אזהרה: השחזור מחליף את כל הנתונים בענן, וכל מה שלא נמצא בגיבוי יימחק לכולם.\nבגיבוי: ${d.state.brands.length} מותגים, ${(d.state.units || []).length} יחידות, ${d.state.parts.length} חלקים.\nסכמות ותמונות שהועלו אינן חלק מהגיבוי.\nלהמשיך?`;
        if (!confirm(msg)) return;
        await Store.replaceState(d.state);
        await Store.setCatalog(Array.isArray(d.catalog) ? d.catalog : []);
        toast('השחזור הושלם', 'ok');
        location.hash = '#/';
        render();
      } catch (e) { saveErr(e); }
    };
    inp.click();
  };

  // ===== רענון אוטומטי לצופים כשחוזרים ללשונית =====
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || role !== 'viewer') return;
    if (Date.now() - Store.lastLoad < (CFG.autoRefreshMinutes || 3) * 60000 || $('.modal')) return;
    Store.reload().then(render).catch(() => { /* נסה שוב בפעם הבאה */ });
  });

  // ===== התחלה =====
  function start() {
    prevTop = parseRoute().p[0] || '';
    $('#login').hidden = true;
    $('#app').hidden = false;
    renderTop();
    render();
  }
  (async function boot() {
    if (!SB.configured()) { $('#loginErr').textContent = 'חיבור ה-Supabase לא הוגדר בקובץ js/config.js'; return; }
    if (SB.restore()) {
      role = SB.role();
      if (!role) { SB.clearLocal(); $('#pw').focus(); return; }
      try { await startSession(); return; }
      catch (e) { console.error(e); role = ''; if (e && e.code !== 'AUTH') $('#loginErr').textContent = e.message || ''; SB.clearLocal(); }
    }
    $('#pw').focus();
  })();
})();
