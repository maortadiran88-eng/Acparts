const db = window._db;

// ══════════ תמונות ══════════
// תמונה חדשה (data URL) נשמרת כמסמך נפרד באוסף 'img', ובמסמך הדגם נשמרת רק הפניה "sb:<id>".
// כך מסמכי הדגמים קטנים והקטלוג נטען מהר, ותמונות נטענות רק כשצריך (ראה SbImg ב-helpers.js).
const IMG_CACHE = new Map();   // data URL -> הפניה (כבר הועלתה, לא מעלים שוב)
const isDataImg = s => typeof s === 'string' && s.startsWith('data:image/');
const newImgId = () => 'i' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
async function sbUploadImage(dataUrl) {
  if (IMG_CACHE.has(dataUrl)) return IMG_CACHE.get(dataUrl);
  const id = newImgId();
  await db.collection('img').doc(id).set({ d: dataUrl });
  const ref = 'sb:' + id;
  IMG_CACHE.set(dataUrl, ref);
  return ref;
}
async function packImages(list) {
  const out = [];
  for (const s of (list || [])) out.push(isDataImg(s) ? await sbUploadImage(s) : s);
  return out;
}
// מריץ fn על כל הפריטים, עד n במקביל
async function sbPool(items, n, fn) {
  const res = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; res[i] = await fn(items[i], i); }
  }));
  return res;
}

// צורת מסמך ה-meta כפי שהיא נשמרת (בלי חלקים ותמונות של דגמים רגילים). משווים אותה כדי לא לכתוב את ה-meta כשלא השתנה כלום
// (פחות כתיבות, מהיר יותר, וקטן הסיכוי שעורך אחד ידרוס שינוי מבני של עורך אחר)
let LAST_META = '';
function sbMetaShape(data) {
  return {
    waDefaults:data.waDefaults||['nameHe','tadPn'],
    welcomeTitle:data.welcomeTitle, welcomeSub:data.welcomeSub,
    disclaimer:data.disclaimer, partsDisclaimer:data.partsDisclaimer||DEFAULT_DISCLAIMER,
    tips:data.tips||[], greetings:data.greetings||null, systemMsg:data.systemMsg||null,
    brands:data.brands.map(b=>({...b,categories:b.categories.map(c=>({...c,models:c.models.map(m=>({id:m.id,name:m.name,hidden:m.hidden||false}))}))}))
  };
}

// ── Core catalog ──
async function fbLoad() {
  const md = await db.collection('catalog').doc('meta').get();
  if (!md.exists) return null;
  const d = md.data().d;
  // סיסמאות ומשתמשים נשמרים בשרת בלבד ולא בקטלוג (גם גיבויים ישנים שהכילו אותם מתנקים)
  delete d.users; delete d.pass; delete d.editorPass; delete d.viewerPass;
  if (!d.partsDisclaimer) d.partsDisclaimer = DEFAULT_DISCLAIMER;
  const mids = [];
  d.brands.forEach(b => b.categories.forEach(c => c.models.forEach(m => mids.push(m.id))));
  if (!mids.length) { LAST_META = JSON.stringify(sbMetaShape(d)); return d; }
  const pm = await db.getMany('parts', mids);
  d.brands.forEach(b => b.categories.forEach(c => c.models.forEach(m => {
    const pd = pm[m.id] || {};
    m.parts    = (pd.parts||[]).map(p=>({discontinued:false,tags:'',pinned:false,comments:[],hidden:false,...p}));
    m.images   = pd.images   || [];
    m.columns  = pd.columns  || DCOLS();
    m.synonyms = pd.synonyms || [];
    m.notes    = pd.notes    || '';
  })));
  LAST_META = JSON.stringify(sbMetaShape(d));
  return d;
}
// מגבלת גודל למסמך בודד (השרת מאפשר עד ~14MB, כאן מתריעים מוקדם)
const FS_DOC_LIMIT = 10000000;
function fsBytes(o){ try{ return new TextEncoder().encode(JSON.stringify(o)).length; }catch(e){ return 0; } }
async function fbSave(data, mids) {
  // 1) מעלים תמונות חדשות ובונים את מסמכי הדגמים
  const wanted = [];
  data.brands.forEach(b=>b.categories.forEach(c=>c.models.forEach(m=>{ if(mids.has(m.id)) wanted.push(m); })));
  const tooBig = [];
  const ops = [];
  await sbPool(wanted, 3, async m => {
    const payload = {parts:m.parts||[],images:await packImages(m.images),columns:m.columns||DCOLS(),synonyms:m.synonyms||[],notes:m.notes||''};
    const bytes = fsBytes(payload);
    if (bytes > FS_DOC_LIMIT) { tooBig.push(m.name+' ('+Math.round(bytes/1024)+'KB)'); return; }
    ops.push({op:'set',col:'parts',id:m.id,data:payload});
  });
  // 2) מסמך ה-meta: מותגים, קטגוריות ורשימת הדגמים (דגמים בתת-קטגוריות נשמרים בתוכו במלואם). נכתב רק אם השתנה
  const shape = JSON.stringify(sbMetaShape(data));
  let meta = null;
  if (shape !== LAST_META) {
    const brands = [];
    for (const b of data.brands) {
      const cats = [];
      for (const c of b.categories) {
        const cc = {...c, models:c.models.map(m=>({id:m.id,name:m.name,hidden:m.hidden||false}))};
        if (c.subCategories) cc.subCategories = await Promise.all(c.subCategories.map(async sc=>({...sc, models: await Promise.all((sc.models||[]).map(async m=>({...m, images: await packImages(m.images)})))})));
        cats.push(cc);
      }
      brands.push({...b, categories:cats});
    }
    meta = {...sbMetaShape(data), brands};
    const metaBytes = fsBytes(meta);
    console.info('[fbSave] meta '+Math.round(metaBytes/1024)+'KB · models to write: '+ops.length);
    if (metaBytes > FS_DOC_LIMIT) {
      const err = new Error('מסמך הקטלוג הראשי גדול מדי ('+Math.round(metaBytes/1024)+'KB) — כנראה בגלל דגמים בתת-קטגוריות שנשמרים בתוכו. השמירה נעצרה.');
      err.nonRetryable = true; throw err;
    }
  }
  // 3) כותבים קודם את הדגמים ורק אחר כך את ה-meta, כך שהקטלוג אף פעם לא מפנה לדגם שלא נשמר
  if (ops.length) await sbSendBatch(ops);
  if (meta) { await db.collection('catalog').doc('meta').set({d:meta}); LAST_META = shape; }
  if (tooBig.length) {
    const err = new Error('הדגמים הבאים גדולים מדי לשמירה: '+tooBig.join(', ')+'. שאר השינויים נשמרו.');
    err.nonRetryable = true; throw err;
  }
}
// שליחת פעולות דגמים בקבוצות לפי נפח
async function sbSendBatch(ops) {
  const b = db.batch();
  ops.forEach(o => b.set({__col:o.col,__id:o.id}, o.data));
  await b.commit();
}

// ── Activity log ──
async function fbHist(e) {
  try { await db.collection('history').add({...e,ts:firebase.firestore.FieldValue.serverTimestamp()}); } catch {}
}
async function fbGetHist() {
  try {
    const s = await db.collection('history').orderBy('ts','desc').limit(200).get();
    return s.docs.map(d=>({id:d.id,...d.data(),ts:d.data().ts?.toDate?.()?.toLocaleString('he-IL')||''}));
  } catch { return []; }
}
async function fbClearHist() { try { await SB.rpc('vrf_clear', {c:'history'}); } catch {} }
// ── News ──
async function fbAddNews(text) { return db.collection('news').add({text,ts:firebase.firestore.FieldValue.serverTimestamp()}); }
async function fbGetNews() {
  try {
    const s = await db.collection('news').orderBy('ts','desc').limit(30).get();
    return s.docs.map(d=>({id:d.id,...d.data(),ts:d.data().ts?.toDate?.()?.toLocaleString('he-IL')||''}));
  } catch { return []; }
}
async function fbDeleteNews(id) { return db.collection('news').doc(id).delete(); }

// ── Reports ──
async function fbSaveReport(r) { return db.collection('reports').add({...r,ts:firebase.firestore.FieldValue.serverTimestamp(),resolved:false}); }
async function fbGetReports() {
  try {
    const s = await db.collection('reports').orderBy('ts','desc').limit(100).get();
    return s.docs.map(d=>({id:d.id,...d.data(),ts:d.data().ts?.toDate?.()?.toLocaleString('he-IL')||''}));
  } catch { return []; }
}
async function fbResolveReport(id) { return db.collection('reports').doc(id).update({resolved:true}); }

// ── Tech requests ──
async function fbSaveTechRequest(r) { return db.collection('techRequests').add({...r,ts:firebase.firestore.FieldValue.serverTimestamp(),resolved:false}); }
async function fbGetTechRequests() {
  try {
    const s = await db.collection('techRequests').orderBy('ts','desc').limit(100).get();
    return s.docs.map(d=>({id:d.id,...d.data(),ts:d.data().ts?.toDate?.()?.toLocaleString('he-IL')||''}));
  } catch { return []; }
}
async function fbResolveTechRequest(id) { return db.collection('techRequests').doc(id).update({resolved:true}); }

// ── Broadcast ──
async function fbSetBroadcast(msg) {
  return db.collection('system').doc('broadcast').set({msg,ts:firebase.firestore.FieldValue.serverTimestamp(),active:!!msg});
}
async function fbGetBroadcast() {
  try { const d=await db.collection('system').doc('broadcast').get(); if(!d.exists||!d.data().active)return null; return d.data(); } catch { return null; }
}

// ── Snapshots ──
async function fbSaveSnapshot(data, actor, action) {
  try {
    // גרסה = כל הקטלוג במסמך אחד. אם הוא גדול מדי מדלגים עליה כדי לא להעמיס. השרת שומר רק את 10 האחרונות
    const brandsJson = JSON.stringify(data.brands);
    const bytes = new TextEncoder().encode(brandsJson).length;
    if (bytes > 3000000) {
      console.warn('[snapshot] דילוג: הקטלוג המלא ('+Math.round(bytes/1024)+'KB) גדול מדי לגרסה שמורה.');
      return;
    }
    await db.collection('snapshots').add({actor,action,ts:firebase.firestore.FieldValue.serverTimestamp(),brands:brandsJson});
  } catch {}
}
async function fbGetSnapshots() {
  try {
    const s = await db.collection('snapshots').orderBy('ts','desc').limit(10).get();
    return s.docs.map(d=>({id:d.id,...d.data(),brands:undefined,ts:d.data().ts?.toDate?.()?.toLocaleString('he-IL')||''}));
  } catch { return []; }
}
async function fbRestoreSnapshot(snapId) {
  const doc = await db.collection('snapshots').doc(snapId).get();
  if (!doc.exists) throw new Error('לא נמצא');
  return JSON.parse(doc.data().brands);
}

// ── Views (dashboard) ──
async function fbTrackView(mid, modelName, brandName) {
  try { await SB.rpc('vrf_view_track', {mid, mname:modelName||'', bname:brandName||''}); } catch {}
}
async function fbGetTopViews() {
  try { const s=await db.collection('views').orderBy('count','desc').limit(20).get(); return s.docs.map(d=>({id:d.id,...d.data()})); } catch { return []; }
}
async function fbResetViews() { try { await SB.rpc('vrf_clear', {c:'views'}); } catch {} }
// ── Alerts log (model/part add/delete events) ──
async function fbLogAlert(e) {
  try { await db.collection('alerts').add({...e,ts:firebase.firestore.FieldValue.serverTimestamp()}); } catch {}
}
async function fbGetAlerts() {
  try {
    const s = await db.collection('alerts').orderBy('ts','desc').limit(100).get();
    return s.docs.map(d=>({id:d.id,...d.data(),ts:d.data().ts?.toDate?.()?.toLocaleString('he-IL')||''}));
  } catch { return []; }
}

// ── Bulk resolve/clear for notifications ──
async function fbResolveAllReports() {
  try {
    const s = await db.collection('reports').where('resolved','==',false).get();
    const batch = db.batch();
    s.docs.forEach(d=>batch.update(d.ref,{resolved:true}));
    await batch.commit();
  } catch {}
}
async function fbResolveAllTechRequests() {
  try {
    const s = await db.collection('techRequests').where('resolved','==',false).get();
    const batch = db.batch();
    s.docs.forEach(d=>batch.update(d.ref,{resolved:true}));
    await batch.commit();
  } catch {}
}
async function fbClearAlerts() { try { await SB.rpc('vrf_clear', {c:'alerts'}); } catch {} }
// ── ניקוי תמונות שאינן בשימוש (מנהל) ──
async function fbGcImages() { const r = await SB.rpc('vrf_gc_images', {}); return (r&&r.n)||0; }
