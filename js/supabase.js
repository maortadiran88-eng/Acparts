/* לקוח קל למסד הנתונים (Supabase), בלי ספריות חיצוניות ובלי Supabase Auth.
   הכניסה היא בסיסמה בלבד: הסיסמה נבדקת בתוך מסד הנתונים, שמחזיר אסימון (token) זמני.
   כל הקריאות הן RPC לפונקציות sp_* (ראה sql/schema.sql). המפתח הציבורי לבדו לא נותן גישה לנתונים. */
(function () {
  'use strict';
  const C = window.APP_CONFIG || {};
  const base = String(C.supabaseUrl || '').replace(/\/+$/, '');
  const KEY = C.supabaseKey || '';
  const SK = 'sp-session-v2';
  const CHUNK = 393216;          // 384KB. מכפלה של 3, כדי ש-base64 של חלקים יתחבר נכון. חייב להתאים ל-sql/schema.sql
  let session = null;            // { token, role, exp, remember }

  class SbError extends Error {
    constructor(message, code, status) { super(message); this.code = code || 'HTTP'; this.status = status || 0; }
  }
  const configured = () => !!(base && KEY && /^https?:\/\//.test(base));
  const safeJson = async (r) => { try { return await r.json(); } catch (e) { return null; } };

  const KNOWN = {
    sp_auth: ['AUTH', 'ההתחברות פגה. יש להיכנס מחדש.'],
    sp_denied: ['DENIED', 'אין הרשאה לבצע את הפעולה הזו.'],
    sp_bad_file: ['FILE', 'הקובץ אינו תקין או שסוגו אינו נתמך (PDF, JPG, PNG בלבד).'],
    sp_too_big: ['SIZE', 'הקובץ גדול מדי.'],
    sp_too_many: ['INPUT', 'יותר מדי רשומות בבקשה אחת.'],
    sp_bad_input: ['INPUT', 'הנתונים שנשלחו אינם תקינים.'],
    sp_bad_table: ['INPUT', 'הנתונים שנשלחו אינם תקינים.']
  };
  async function httpError(r, fallback) {
    const body = await safeJson(r);
    const code = String((body && (body.code || body.error_code)) || '');
    const msg = String((body && (body.message || body.msg || body.error_description)) || '');
    for (const k of Object.keys(KNOWN)) if (msg.indexOf(k) === 0) return new SbError(KNOWN[k][1], KNOWN[k][0], r.status);
    if (r.status === 404 || code === 'PGRST202' || code === '42883') return new SbError('פונקציות מסד הנתונים לא נמצאו. יש להריץ את sql/schema.sql ב-Supabase.', 'CONFIG', r.status);
    if (r.status === 401 || /api key|apikey|jwt/i.test(msg)) return new SbError('מפתח ה-Supabase ב-js/config.js אינו תקין.', 'CONFIG', r.status);
    if (code === '23505') return new SbError('הערך כבר קיים (כפילות).', 'DUP', r.status);
    if (code === '23503') return new SbError('הפעולה נכשלה: הרשומה קשורה לרשומה אחרת.', 'FK', r.status);
    if (code === '23514') return new SbError('אחד השדות ריק או אינו תקין.', 'INPUT', r.status);
    if (r.status === 413) return new SbError('הבקשה גדולה מדי.', 'SIZE', r.status);
    if (r.status === 429) return new SbError('יותר מדי בקשות. נסה שוב בעוד רגע.', 'RATE', r.status);
    return new SbError(fallback + (msg ? ': ' + msg : ' (' + r.status + ')'), 'HTTP', r.status);
  }

  async function call(fn, args) {
    let r;
    try {
      r = await fetch(`${base}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(args) });
    } catch (e) { throw new SbError('אין חיבור לשרת. בדוק את החיבור לאינטרנט ונסה שוב.', 'NET', 0); }
    return r;
  }
  // קריאה מאומתת (עם אסימון). מחזיר את תוכן ה-JSON.
  async function rpc(fn, args, fallback) {
    if (!session) throw new SbError('ההתחברות פגה. יש להיכנס מחדש.', 'AUTH', 401);
    const r = await call(fn, Object.assign({ t: session.token }, args));
    if (!r.ok) {
      const e = await httpError(r, fallback || 'הפעולה נכשלה');
      if (e.code === 'AUTH') clearLocal();
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
        if (s && s.token && (s.role === 'admin' || s.role === 'viewer') && s.exp > Date.now()) { session = s; return true; }
      } catch (e) { /* ignore */ }
    }
    clearLocal();
    return false;
  }
  // מחזיר 'admin' | 'viewer' | null (סיסמה שגויה). חורג בחסימה, בהגדרה חסרה ובשגיאות רשת.
  async function login(pw) {
    if (!configured()) throw new SbError('חיבור ה-Supabase לא הוגדר בקובץ js/config.js', 'CONFIG', 0);
    const r = await call('sp_login', { pw });
    if (!r.ok) throw await httpError(r, 'ההתחברות נכשלה');
    const j = await safeJson(r);
    if (j && j.ok) {
      session = { token: j.token, role: j.role, exp: Date.now() + (j.expires_in || 3600) * 1000 - 60000, remember: j.role === 'viewer' && C.rememberViewer !== false };
      persist();
      return j.role;
    }
    if (j && j.reason === 'locked') {
      const m = Math.max(1, Math.ceil((j.wait || 60) / 60));
      throw new SbError(`יותר מדי ניסיונות שגויים. נסה שוב בעוד ${m} דקות.`, 'LOCKED', 429);
    }
    if (j && j.reason === 'setup') throw new SbError('עדיין לא הוגדרו סיסמאות. יש להריץ את sql/set-passwords.sql ב-Supabase.', 'CONFIG', 0);
    return null;
  }
  async function signOut() {
    const t = session && session.token;
    clearLocal();
    if (t) { try { await call('sp_logout', { t }); } catch (e) { /* best effort */ } }
  }

  // ----- נתונים -----
  async function select(table, o) {
    const from = (o && o.from) || 0, to = o && o.to != null ? o.to : 999;
    const j = await rpc('sp_read', { tbl: table, off: from, lim: to - from + 1 }, 'טעינת הנתונים נכשלה');
    return { rows: (j && j.rows) || [], total: j && j.total != null ? Number(j.total) : null };
  }
  async function upsert(table, rows) {
    if (rows.length) await rpc('sp_upsert', { tbl: table, rows }, 'השמירה נכשלה');
  }
  async function remove(table, col, ids) {
    if (ids.length) await rpc('sp_delete', { tbl: table, ids }, 'המחיקה נכשלה');
  }

  // ----- קבצים (נשמרים במסד, בחלקים) -----
  const blobToB64 = (blob) => new Promise((res, rej) => {
    const f = new FileReader();
    f.onload = () => res(String(f.result).slice(String(f.result).indexOf(',') + 1));
    f.onerror = () => rej(new SbError('קריאת הקובץ נכשלה', 'FILE', 0));
    f.readAsDataURL(blob);
  });
  const b64ToBytes = (b64) => { const bin = atob(b64), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };
  async function withRetry(fn) {
    try { return await fn(); } catch (e) { if (e && e.code === 'NET') return fn(); throw e; }
  }
  async function putFile(path, blob) {
    const total = Math.max(1, Math.ceil(blob.size / CHUNK));
    for (let i = 0; i < total; i++) {
      const b64 = await blobToB64(blob.slice(i * CHUNK, (i + 1) * CHUNK));
      await withRetry(() => rpc('sp_file_put', { key: path, mime: blob.type, idx: i, total, b64 }, 'העלאת הקובץ נכשלה'));
    }
  }
  async function getFile(path) {
    const first = await withRetry(() => rpc('sp_file_get', { key: path, idx: 0 }, 'הורדת הקובץ נכשלה'));
    if (!first) return null;
    const parts = new Array(first.total);
    parts[0] = b64ToBytes(first.b64);
    let next = 1;
    await Promise.all(Array.from({ length: Math.min(3, first.total - 1) }, async () => {
      while (next < first.total) {
        const i = next++;
        const j = await withRetry(() => rpc('sp_file_get', { key: path, idx: i }, 'הורדת הקובץ נכשלה'));
        if (!j) throw new SbError('הקובץ השתנה בזמן ההורדה. נסה שוב.', 'FILE', 0);
        parts[i] = b64ToBytes(j.b64);
      }
    }));
    return new Blob(parts, { type: first.mime });
  }
  async function delFile(path) { await rpc('sp_file_del', { key: path }, 'מחיקת הקובץ נכשלה'); }

  window.SB = {
    configured, restore, clearLocal, login, loginWithPassword: login, signOut,
    role: () => (session ? session.role : ''),
    select, upsert, remove, putFile, getFile, delFile, SbError
  };
})();
