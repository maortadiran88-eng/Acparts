/* supabasedb.js — מחליף את localdb.js. אחסון הקטלוג ב-Supabase, בלי ספריות חיצוניות ובלי Supabase Auth.
   מחקה את חלק ה-Firestore שהאתר משתמש בו (collection / doc / get / set / update / delete / add / batch / where / orderBy / limit),
   כך ששאר הקוד נשאר כמעט זהה. כל קריאה היא RPC לפונקציה vrf_* במסד, שבודקת אסימון וקובעת הרשאות לפי תפקיד.
   הכניסה בסיסמה בלבד: הסיסמה נבדקת בתוך מסד הנתונים (לא בדפדפן), ואז מתקבל אסימון זמני. */
(function () {
  'use strict';
  const C = window.APP_CONFIG || {};
  const base = String(C.supabaseUrl || '').replace(/\/+$/, '');
  const KEY = C.supabaseKey || '';
  const SK = 'vrf-session-v1';
  let session = null;                 // { token, role, id, label, exp, remember }

  class SbError extends Error {
    constructor(message, code, status) { super(message); this.code = code || 'HTTP'; this.status = status || 0; }
  }
  const configured = () => !!(base && KEY && /^https?:\/\//.test(base));
  const safeJson = async (r) => { try { return await r.json(); } catch (e) { return null; } };

  const KNOWN = {
    vrf_auth: ['AUTH', 'ההתחברות פגה. יש להיכנס מחדש.'],
    vrf_denied: ['DENIED', 'אין הרשאה לבצע את הפעולה הזו.'],
    vrf_notfound: ['NOTFOUND', 'הרשומה לא נמצאה.'],
    vrf_bad_input: ['INPUT', 'הנתונים שנשלחו אינם תקינים.'],
    vrf_bad_col: ['INPUT', 'הנתונים שנשלחו אינם תקינים.'],
    vrf_bad_image: ['INPUT', 'התמונה אינה תקינה (רק JPG / PNG / WebP / GIF).'],
    vrf_too_big: ['SIZE', 'המסמך גדול מדי לשמירה.']
  };
  async function httpError(r, fallback) {
    const body = await safeJson(r);
    const code = String((body && (body.code || body.error_code)) || '');
    const msg = String((body && (body.message || body.msg || body.error_description)) || '');
    for (const k of Object.keys(KNOWN)) if (msg.indexOf(k) === 0) return new SbError(KNOWN[k][1], KNOWN[k][0], r.status);
    if (r.status === 404 || code === 'PGRST202' || code === '42883') return new SbError('פונקציות מסד הנתונים לא נמצאו. יש להריץ את הקובץ 1-schema.sql ב-Supabase.', 'CONFIG', r.status);
    if (r.status === 401 || /api key|apikey|jwt/i.test(msg)) return new SbError('מפתח ה-Supabase ב-js/config.js אינו תקין.', 'CONFIG', r.status);
    if (r.status === 413) return new SbError('הבקשה גדולה מדי לשרת.', 'SIZE', r.status);
    if (r.status === 429) return new SbError('יותר מדי בקשות. נסה שוב בעוד רגע.', 'RATE', r.status);
    return new SbError((fallback || 'הפעולה נכשלה') + (msg ? ': ' + msg : ' (' + r.status + ')'), 'HTTP', r.status);
  }

  async function call(fn, args) {
    try {
      return await fetch(`${base}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(args || {}) });
    } catch (e) { throw new SbError('אין חיבור לשרת. בדוק את החיבור לאינטרנט ונסה שוב.', 'NET', 0); }
  }
  // קריאה מאומתת (עם האסימון). מחזיר את תוכן ה-JSON
  async function rpc(fn, args) {
    if (!session) throw new SbError('ההתחברות פגה. יש להיכנס מחדש.', 'AUTH', 401);
    let r;
    try { r = await call(fn, Object.assign({ t: session.token }, args)); }
    catch (e) { if (e.code === 'NET') r = await call(fn, Object.assign({ t: session.token }, args)); else throw e; }   // ניסיון חוזר אחד על תקלת רשת רגעית
    if (!r.ok) {
      const e = await httpError(r);
      if (e.code === 'AUTH') { clearLocal(); try { window.dispatchEvent(new Event('sb-expired')); } catch (x) { /* ignore */ } }
      throw e;
    }
    return safeJson(r);
  }

  // ----- כניסה -----
  function persist() {
    try { localStorage.removeItem(SK); sessionStorage.removeItem(SK); } catch (e) { /* ignore */ }
    if (!session) return;
    try { (session.remember ? localStorage : sessionStorage).setItem(SK, JSON.stringify(session)); } catch (e) { /* ignore */ }
  }
  function clearLocal() {
    session = null;
    try { localStorage.removeItem(SK); sessionStorage.removeItem(SK); } catch (e) { /* ignore */ }
  }
  function restore() {
    for (const st of [sessionStorage, localStorage]) {
      try {
        const s = JSON.parse(st.getItem(SK) || 'null');
        if (s && s.token && ['admin', 'editor', 'viewer'].includes(s.role) && s.exp > Date.now()) { session = s; return true; }
      } catch (e) { /* ignore */ }
    }
    clearLocal();
    return false;
  }
  // מידע ציבורי למסך הכניסה (כותרת, אזהרה, והאם המערכת כבר הוגדרה)
  async function publicInfo() {
    if (!configured()) throw new SbError('חיבור ה-Supabase לא הוגדר בקובץ js/config.js', 'CONFIG', 0);
    const r = await call('vrf_public', {});
    if (!r.ok) throw await httpError(r, 'טעינת מסך הכניסה נכשלה');
    return (await safeJson(r)) || {};
  }
  // מחזיר { role, id, label } | null (סיסמה שגויה). חורג בחסימה, בהגדרה חסרה ובשגיאות רשת
  async function login(pw) {
    if (!configured()) throw new SbError('חיבור ה-Supabase לא הוגדר בקובץ js/config.js', 'CONFIG', 0);
    const r = await call('vrf_login', { pw });
    if (!r.ok) throw await httpError(r, 'ההתחברות נכשלה');
    const j = await safeJson(r);
    if (j && j.ok) {
      session = { token: j.token, role: j.role, id: j.id, label: j.label, exp: Date.now() + (j.expires_in || 3600) * 1000 - 60000, remember: j.role === 'viewer' && C.rememberViewer !== false };
      persist();
      return { role: j.role, id: j.id, label: j.label };
    }
    if (j && j.reason === 'locked') {
      const m = Math.max(1, Math.ceil((j.wait || 60) / 60));
      throw new SbError(`יותר מדי ניסיונות שגויים. נסה שוב בעוד ${m} דקות.`, 'LOCKED', 429);
    }
    if (j && j.reason === 'setup') throw new SbError('עדיין לא הוגדרו משתמשים. יש להריץ את הקובץ 2-first-users.sql ב-Supabase.', 'CONFIG', 0);
    return null;
  }
  // בודק שהאסימון ששוחזר עדיין תקף. מחזיר true/false. שגיאת רשת נזרקת
  async function validate() {
    if (!session) return false;
    const r = await call('vrf_whoami', { t: session.token });
    if (r.ok) {
      const j = await safeJson(r);
      if (j && j.ok) { session.role = j.role; session.label = j.label; session.id = j.id; persist(); return true; }
    }
    const e = r.ok ? null : await httpError(r);
    if (!e || e.code === 'AUTH' || e.code === 'DENIED') { clearLocal(); return false; }
    throw e;
  }
  async function logout() {
    const t = session && session.token;
    clearLocal();
    if (t) { try { await call('vrf_logout', { t }); } catch (e) { /* best effort */ } }
  }

  // ===== שכבת תאימות ל-Firestore (חלק מ-localdb.js נשמר כמו שהוא) =====
  const isTs = (v) => v && typeof v === 'object' && v.__ts !== undefined;
  const SERVER_TS = { __sentinel: 'ts' };
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  const clone = (o) => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));
  const stamp = (o) => {            // sentinel -> שעה אמיתית
    if (o && typeof o === 'object') { for (const k in o) { if (o[k] && o[k].__sentinel === 'ts') o[k] = { __ts: Date.now() }; else if (typeof o[k] === 'object') stamp(o[k]); } }
    return o;
  };
  const view = (o) => {             // __ts -> אובייקט עם toDate()
    if (Array.isArray(o)) return o.map(view);
    if (isTs(o)) return { toDate: () => new Date(o.__ts), toMillis: () => o.__ts };
    if (o && typeof o === 'object') { const r = {}; for (const k in o) r[k] = view(o[k]); return r; }
    return o;
  };
  const snap = (col, id, raw) => ({ id, exists: raw !== null && raw !== undefined, data: () => view(raw === null || raw === undefined ? undefined : raw), ref: { __col: col, __id: id } });

  function docRef(col, id) {
    return {
      id, __col: col, __id: id,
      async get() { return snap(col, id, await rpc('vrf_doc_get', { c: col, i: id })); },
      async set(data, opt) { await rpc('vrf_doc_set', { c: col, i: id, d: stamp(clone(data)), merge: !!(opt && opt.merge) }); },
      async update(data) { await rpc('vrf_doc_update', { c: col, i: id, d: stamp(clone(data)) }); },
      async delete() { await rpc('vrf_doc_delete', { c: col, i: id }); }
    };
  }
  function query(col, filters, order, lim) {
    return {
      orderBy(f, dir) { return query(col, filters, { f, dir: dir || 'asc' }, lim); },
      limit(k) { return query(col, filters, order, k); },
      where(f, op, v) { return query(col, [...filters, { f, op, v }], order, lim); },
      async get() {
        const rows = await rpc('vrf_query', { c: col, filters, ord: order ? order.f : null, dir: order ? order.dir : null, lim: lim || 1000 });
        const docs = (rows || []).map((x) => snap(col, x.id, x.data));
        return { docs, empty: !docs.length, size: docs.length, forEach(fn) { this.docs.forEach(fn); } };
      }
    };
  }

  // שליחת פעולות בקבוצות (עד ~3MB ו-400 פעולות לבקשה). כל קבוצה היא עסקה אחת במסד
  async function sendOps(ops) {
    let cur = [], size = 0;
    const flush = async () => { if (cur.length) { const part = cur; cur = []; size = 0; await rpc('vrf_batch', { ops: part }); } };
    for (const o of ops) {
      const n = JSON.stringify(o).length;
      if (cur.length && (cur.length >= 400 || size + n > 3000000)) await flush();
      cur.push(o); size += n;
    }
    await flush();
  }

  const db = {
    collection(n) {
      const base0 = query(n, [], null, null);
      return Object.assign(base0, {
        doc(id) { return docRef(n, id || uid()); },
        async add(data) { const r = await rpc('vrf_doc_add', { c: n, d: stamp(clone(data)) }); return docRef(n, r.id); }
      });
    },
    batch() {
      const ops = [];
      return {
        set(ref, data) { ops.push({ op: 'set', col: ref.__col, id: ref.__id, data: stamp(clone(data)) }); return this; },
        update(ref, data) { ops.push({ op: 'update', col: ref.__col, id: ref.__id, data: stamp(clone(data)) }); return this; },
        delete(ref) { ops.push({ op: 'delete', col: ref.__col, id: ref.__id }); return this; },
        async commit() { await sendOps(ops); }
      };
    },
    // תוספת: קריאה מהירה של הרבה מסמכים (כמה בקשות במקביל, עם תקרת נפח לכל בקשה). מחזיר { id: data }
    async getMany(col, ids, onProgress) {
      const out = {}; let done = 0; const queue = ids.slice();
      const worker = async () => {
        while (queue.length) {
          let pending = queue.splice(0, 12);
          while (pending.length) {
            const r = await rpc('vrf_docs_get', { c: col, ids: pending, max_bytes: 3000000 });
            Object.assign(out, (r && r.docs) || {});
            done += pending.length - ((r && r.rest) || []).length;
            pending = (r && r.rest) || [];
            if (onProgress) onProgress(done, ids.length);
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, Math.max(1, ids.length)) }, worker));
      return out;
    }
  };

  window.SB = { configured, restore, publicInfo, login, logout, validate, rpc, SbError,
    role: () => (session ? session.role : ''), label: () => (session ? session.label : ''), id: () => (session ? session.id : '') };
  window._db = db;
  window.firebase = { firestore: { FieldValue: { serverTimestamp: () => SERVER_TS } } };
})();
