/* לקוח Supabase קל (בלי ספריות חיצוניות): הזדהות, טבלאות (PostgREST) ואחסון קבצים (Storage). */
(function () {
  'use strict';
  const C = window.APP_CONFIG || {};
  const base = String(C.supabaseUrl || '').replace(/\/+$/, '');
  const KEY = C.supabaseKey || '';
  const SK = 'sp-supabase-session';
  let session = null;
  let refreshing = null;

  class SbError extends Error {
    constructor(message, code, status) { super(message); this.code = code || 'HTTP'; this.status = status || 0; }
  }
  const netError = () => new SbError('אין חיבור לשרת. בדוק את החיבור לאינטרנט ונסה שוב.', 'NET', 0);
  const configured = () => !!(base && KEY && /^https?:\/\//.test(base));
  const safeJson = async (r) => { try { return await r.json(); } catch (e) { return null; } };

  async function httpError(r, fallback) {
    const body = await safeJson(r);
    const code = body && (body.code || body.error_code || body.error);
    const msg = body && (body.message || body.msg || body.error_description || (typeof body.error === 'string' ? body.error : ''));
    if (r.status === 401) return new SbError('ההתחברות פגה. יש להיכנס מחדש.', 'AUTH', 401);
    if (r.status === 403 || String(code) === '42501') return new SbError('אין הרשאה לבצע את הפעולה הזו.', 'DENIED', r.status);
    if (String(code) === '23505') return new SbError('הערך כבר קיים (כפילות). ' + (msg || ''), 'DUP', r.status);
    if (String(code) === '23503') return new SbError('הפעולה נכשלה: הרשומה קשורה לרשומה אחרת.', 'FK', r.status);
    if (r.status === 413) return new SbError('הקובץ גדול מדי.', 'SIZE', r.status);
    if (r.status === 429) return new SbError('יותר מדי בקשות. נסה שוב בעוד רגע.', 'RATE', r.status);
    return new SbError(fallback + (msg ? ': ' + msg : ' (' + r.status + ')'), 'HTTP', r.status);
  }

  // ----- הזדהות -----
  function persist() {
    if (!session) return;
    try { localStorage.removeItem(SK); sessionStorage.removeItem(SK); } catch (e) { /* ignore */ }
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
        if (s && s.refresh_token && s.email) { session = s; return true; }
      } catch (e) { /* ignore */ }
    }
    return false;
  }
  const roleOf = (email) => {
    const e = String(email || '').toLowerCase();
    if (e === String(C.adminEmail || '').toLowerCase()) return 'admin';
    if (e === String(C.viewerEmail || '').toLowerCase()) return 'viewer';
    return '';
  };
  function setSession(j, email) {
    const role = roleOf(email);
    session = {
      access_token: j.access_token,
      refresh_token: j.refresh_token,
      expires_at: j.expires_at || Math.floor(Date.now() / 1000) + (j.expires_in || 3600),
      email,
      remember: role === 'viewer' && C.rememberViewer !== false
    };
    persist();
  }
  async function rawFetch(path, init) {
    try { return await fetch(base + path, init); } catch (e) { throw netError(); }
  }
  // true = נכנס, false = סיסמה שגויה, חריגה = בעיה אחרת
  async function passwordGrant(email, password) {
    const r = await rawFetch('/auth/v1/token?grant_type=password', {
      method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password })
    });
    if (r.ok) { setSession(await r.json(), email); return true; }
    const body = await safeJson(r);
    const code = body && (body.error_code || body.code || body.error);
    if (r.status === 400 && (code === 'invalid_credentials' || code === 'invalid_grant' || code === 400 || /invalid login/i.test((body && (body.msg || body.message || body.error_description)) || ''))) return false;
    if (code === 'email_not_confirmed') throw new SbError('המשתמש קיים אבל לא מאושר. ב-Supabase יש ליצור משתמשים עם Auto Confirm.', 'CONFIG', 400);
    if (r.status === 429) throw new SbError('יותר מדי ניסיונות כניסה. נסה שוב בעוד כמה דקות.', 'RATE', 429);
    if (r.status === 401 || r.status === 403) throw new SbError('מפתח ה-Supabase ב-js/config.js אינו תקין.', 'CONFIG', r.status);
    throw await httpError(r, 'ההתחברות נכשלה');
  }
  // מנסה את הסיסמה מול חשבון המנהל ואז חשבון הצפייה. מחזיר 'admin' | 'viewer' | null
  async function loginWithPassword(pw) {
    if (!configured()) throw new SbError('חיבור ה-Supabase לא הוגדר בקובץ js/config.js', 'CONFIG', 0);
    if (await passwordGrant(C.adminEmail, pw)) return 'admin';
    if (await passwordGrant(C.viewerEmail, pw)) return 'viewer';
    return null;
  }
  function refresh() {
    if (!session) return Promise.reject(new SbError('לא מחובר', 'AUTH', 401));
    if (!refreshing) {
      const email = session.email, rt = session.refresh_token;
      refreshing = (async () => {
        const r = await rawFetch('/auth/v1/token?grant_type=refresh_token', {
          method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: rt })
        });
        if (!r.ok) { if (r.status === 400 || r.status === 401 || r.status === 403) clearLocal(); throw new SbError('ההתחברות פגה. יש להיכנס מחדש.', 'AUTH', 401); }
        setSession(await r.json(), email);
      })().finally(() => { refreshing = null; });
    }
    return refreshing;
  }
  async function ensureFresh() {
    if (session && session.expires_at - Math.floor(Date.now() / 1000) < 60) await refresh();
  }
  async function signOut() {
    const tok = session && session.access_token;
    clearLocal();
    if (tok) { try { await fetch(base + '/auth/v1/logout', { method: 'POST', headers: { apikey: KEY, Authorization: 'Bearer ' + tok } }); } catch (e) { /* best effort */ } }
  }

  // ----- בקשות מאומתות -----
  async function api(path, init, retry) {
    if (!session) throw new SbError('ההתחברות פגה. יש להיכנס מחדש.', 'AUTH', 401);
    await ensureFresh();
    const o = Object.assign({}, init || {});
    o.headers = Object.assign({ apikey: KEY, Authorization: 'Bearer ' + session.access_token }, o.headers || {});
    let r;
    try { r = await fetch(base + path, o); } catch (e) { throw netError(); }
    if (r.status === 401 && retry !== false) { await refresh(); return api(path, init, false); }
    return r;
  }

  // ----- טבלאות -----
  const quote = (v) => '"' + String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  // עמודים באמצעות limit/offset וספירה ב-Prefer (כמו הספרייה הרשמית), בלי כותרות מותאמות שעלולות להיחסם ב-CORS
  async function select(table, o) {
    const from = (o && o.from) || 0, to = o && o.to != null ? o.to : 999;
    const r = await api(`/rest/v1/${table}?select=*&order=${encodeURIComponent(o.order)}.asc&limit=${to - from + 1}&offset=${from}`, { headers: { Prefer: 'count=exact' } });
    if (!r.ok) throw await httpError(r, 'טעינת הנתונים נכשלה');
    const rows = await r.json();
    const m = /\/(\d+)$/.exec(r.headers.get('Content-Range') || '');
    return { rows, total: m ? Number(m[1]) : null };
  }
  async function upsert(table, rows, conflict) {
    if (!rows.length) return;
    const r = await api(`/rest/v1/${table}?on_conflict=${encodeURIComponent(conflict)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(rows)
    });
    if (!r.ok) throw await httpError(r, 'השמירה נכשלה');
  }
  async function remove(table, col, ids) {
    if (!ids.length) return;
    const r = await api(`/rest/v1/${table}?${col}=in.(${encodeURIComponent(ids.map(quote).join(','))})`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
    if (!r.ok) throw await httpError(r, 'המחיקה נכשלה');
  }

  // ----- אחסון קבצים -----
  const objUrl = (path) => `/storage/v1/object/${C.bucket}/${path.split('/').map(encodeURIComponent).join('/')}`;
  async function putFile(path, blob) {
    const body = await blob.arrayBuffer();   // גוף בינארי רגיל + Content-Type (כמו העלאת ArrayBuffer בספרייה הרשמית)
    const r = await api(objUrl(path), { method: 'POST', headers: { 'Content-Type': blob.type || 'application/octet-stream', 'x-upsert': 'true' }, body });
    if (!r.ok) throw await httpError(r, 'העלאת הקובץ נכשלה');
  }
  async function getFile(path) {
    const r = await api(objUrl(path).replace('/object/', '/object/authenticated/'));
    if (r.status === 404 || r.status === 400) return null;
    if (!r.ok) throw await httpError(r, 'הורדת הקובץ נכשלה');
    return r.blob();
  }
  async function delFile(path) {
    const r = await api(objUrl(path), { method: 'DELETE' });
    if (r.ok || r.status === 404 || r.status === 400) return;
    throw await httpError(r, 'מחיקת הקובץ נכשלה');
  }

  window.SB = {
    configured, restore, clearLocal, loginWithPassword, signOut, refresh,
    role: () => (session ? roleOf(session.email) : ''),
    email: () => (session ? session.email : ''),
    select, upsert, remove, putFile, getFile, delFile, SbError
  };
})();
