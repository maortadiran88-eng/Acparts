const db = window._db;

// ══════════ תמונות ══════════
const IMG_CACHE = new Map();
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
async function sbPool(items, n, fn) {
  const res = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; res[i] = await fn(items[i], i); }
  }));
  return res;
}

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
const FS_DOC_LIMIT = 10000000;
function fsBytes(o){ try{ return new TextEncoder().encode(JSON.stringify(o)).length; }catch(e){ return 0; } }
async function fbSave(data, mids) {
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
    if (fsBytes(meta) > FS_DOC_LIMIT) { const err = new Error('מסמך הקטלוג הראשי גדול מדי'); err.nonRetryable = true; throw err; }
  }
  if (ops.length) await sbSendBatch(ops);
  if (meta) { await db.collection('catalog').doc('meta').set({d:meta}); LAST_META = shape; }
  if (tooBig.length) {
    const err = new Error('הדגמים הבאים גדולים מדי לשמירה: '+tooBig.join(', ')+'. שאר השינויים נשמרו.');
    err.nonRetryable = true; throw err;
  }
}
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
    const brandsJson = JSON.stringify(data.brands);
    const bytes = new TextEncoder().encode(brandsJson).length;
    if (bytes > 3000000) { console.warn('[snapshot] skip'); return; }
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
async function fbGcImages() { const r = await SB.rpc('vrf_gc_images', {}); return (r&&r.n)||0; }

// ══════════ סל מחזור (מנהל בלבד) ══════════
// דגם / תת-קטגוריה / קטגוריה / מותג שנמחקים נשמרים קודם באוסף 'trash' ורק אחר כך נמחקים מהקטלוג, כך שאפשר לשחזר אותם.
// פריט בסל = מסמך מידע קטן m_<tid> (זה מה שהרשימה טוענת) + מסמך מבנה s_<tid> + מסמך לכל דגם d_<tid>_<מזהה דגם>.
// המסמך הקטן נכתב אחרון: פריט מופיע ברשימה רק אחרי שכל שאר המסמכים שלו נשמרו.
const TRASH_KIND = {model:'דגם', sub:'תת-קטגוריה', cat:'קטגוריה', brand:'מותג'};
const trashNewId = () => 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const trashStub = m => ({id:m.id, name:m.name, hidden:!!m.hidden});
// כשה-SQL של הסל עוד לא הורץ השרת דוחה את האוסף 'trash': מסבירים מה לעשות במקום הודעה כללית
const trashHint = e => {
  if (e && (e.code === 'INPUT' || e.code === 'DENIED') && !/3-update-trash/.test(e.message||''))
    e.message = 'סל המחזור עוד לא הופעל בשרת. יש להריץ פעם אחת את הקובץ 3-update-trash.sql ב-Supabase (SQL Editor). (' + e.message + ')';
  return e;
};

// מחליף כל דגם בעץ בתוצאה של fn(דגם) ומחזיר עץ חדש (המקור לא משתנה)
function trashMapModels(kind, node, fn) {
  const mm = ms => (ms||[]).map(fn);
  const cat = c => ({...c, models: mm(c.models), ...(c.subCategories ? {subCategories: c.subCategories.map(sc => ({...sc, models: mm(sc.models)}))} : {})});
  if (kind === 'model') return fn(node);
  if (kind === 'sub')   return {...node, models: mm(node.models)};
  if (kind === 'cat')   return cat(node);
  if (kind === 'brand') return {...node, categories: (node.categories||[]).map(cat)};
  return node;
}
function trashModelsOf(kind, node) { const out = []; trashMapModels(kind, node, m => { out.push(m); return m; }); return out; }
const trashCountParts = ms => ms.reduce((n, m) => n + (m.parts||[]).length, 0);

// שומר פריט בסל. מחזיר "חבילה" שאפשר לשחזר ממנה גם בלי לגשת שוב לשרת (לכפתור "בטל")
async function fbTrashPut({kind, loc, node, path, by}) {
  try {
    const tid = trashNewId();
    const mdocs = {};
    for (const m of trashModelsOf(kind, node)) mdocs[m.id] = {...m, images: await packImages(m.images)};   // תמונה חדשה שעוד לא הועלתה מועלית עכשיו
    const tree = kind === 'model' ? null : trashMapModels(kind, node, trashStub);
    const mids = Object.keys(mdocs);
    const meta = {t:'meta', tid, kind, name:node.name||'', path:path||'', loc:loc||{}, by:by||'', mids, nModels:mids.length, nParts:trashCountParts(Object.values(mdocs))};
    const b = db.batch();
    mids.forEach(id => b.set(db.collection('trash').doc('d_'+tid+'_'+id), {t:'mdoc', tid, mid:id, model:mdocs[id]}));
    b.set(db.collection('trash').doc('s_'+tid), {t:'struct', tid, tree});
    b.set(db.collection('trash').doc('m_'+tid), {...meta, ts:firebase.firestore.FieldValue.serverTimestamp()});
    await b.commit();
    return {meta:{...meta, ts:Date.now()}, tree, mdocs};
  } catch (e) { throw trashHint(e); }
}
// רשימת הפריטים בסל (רק המסמכים הקטנים), החדשים ראשונים
async function fbTrashList() {
  try {
    const s = await db.collection('trash').where('t', '==', 'meta').orderBy('ts', 'desc').limit(300).get();
    return s.docs.map(d => { const x = d.data(); return {...x, ts: x.ts && x.ts.toMillis ? x.ts.toMillis() : 0}; });
  } catch (e) { throw trashHint(e); }
}
// טוען את כל המסמכים של פריט אחד
async function fbTrashLoad(meta) {
  const sid = 's_' + meta.tid, ids = [sid, ...meta.mids.map(id => 'd_' + meta.tid + '_' + id)];
  const docs = await db.getMany('trash', ids);
  if (!docs[sid]) throw new Error('נתוני הפריט בסל חסרים, ולכן אי אפשר לשחזר אותו.');
  const mdocs = {};
  for (const id of meta.mids) { const d = docs['d_' + meta.tid + '_' + id]; if (!d) throw new Error('חלק מנתוני הפריט בסל חסרים, ולכן אי אפשר לשחזר אותו.'); mdocs[id] = d.model; }
  return {meta, tree: docs[sid].tree, mdocs};
}
async function fbTrashDelete(meta) {
  const b = db.batch();
  b.delete(db.collection('trash').doc('m_' + meta.tid));          // קודם המסמך הקטן, כדי שהפריט ייעלם מהרשימה מיד
  b.delete(db.collection('trash').doc('s_' + meta.tid));
  meta.mids.forEach(id => b.delete(db.collection('trash').doc('d_' + meta.tid + '_' + id)));
  await b.commit();
}
async function fbTrashEmpty() { await SB.rpc('vrf_clear', {c:'trash'}); }

// מחזיר את הפריט לקטלוג (פונקציה טהורה: מקבלת את הנתונים ומחזירה נתונים חדשים). {data, mids} או {error}
function trashApply(data, bundle) {
  const {meta, tree, mdocs} = bundle, kind = meta.kind, loc = meta.loc || {};
  const node = kind === 'model' ? mdocs[meta.mids[0]] : trashMapModels(kind, tree, st => mdocs[st.id] || st);
  const ins = (arr, item, idx) => { const a = (arr||[]).slice(); a.splice(Math.max(0, Math.min(idx == null ? a.length : idx, a.length)), 0, item); return a; };
  const have = new Set();
  data.brands.forEach(b => b.categories.forEach(c => { c.models.forEach(m => have.add(m.id)); (c.subCategories||[]).forEach(sc => sc.models.forEach(m => have.add(m.id))); }));
  const mids = trashModelsOf(kind, node).map(m => m.id);
  if (mids.some(id => have.has(id))) return {error: 'פריט כזה כבר קיים בקטלוג (כנראה שוחזר כבר). אפשר למחוק אותו מהסל.'};
  const gone = what => ({error: 'אי אפשר לשחזר: ' + what + ' כבר לא קיים' + (meta.path ? ' (' + meta.path + ')' : '') + '. אם הוא נמחק גם הוא, שחזר אותו קודם מהסל.'});
  if (kind === 'brand') {
    if (data.brands.some(b => b.id === node.id)) return {error: 'מותג כזה כבר קיים בקטלוג.'};
    return {data: {...data, brands: ins(data.brands, node, loc.idx)}, mids};
  }
  const bi = data.brands.findIndex(b => b.id === loc.bid);
  if (bi < 0) return gone('המותג');
  const brand = data.brands[bi];
  const put = nb => ({...data, brands: data.brands.map((b, i) => i === bi ? nb : b)});
  if (kind === 'cat') {
    if (brand.categories.some(c => c.id === node.id)) return {error: 'קטגוריה כזו כבר קיימת במותג.'};
    return {data: put({...brand, categories: ins(brand.categories, node, loc.idx)}), mids};
  }
  const ci = brand.categories.findIndex(c => c.id === loc.cid);
  if (ci < 0) return gone('הקטגוריה');
  const cat = brand.categories[ci];
  const putCat = nc => put({...brand, categories: brand.categories.map((c, i) => i === ci ? nc : c)});
  if (kind === 'sub') {
    if ((cat.subCategories||[]).some(s => s.id === node.id)) return {error: 'תת-קטגוריה כזו כבר קיימת.'};
    return {data: putCat({...cat, subCategories: ins(cat.subCategories, node, loc.idx)}), mids};
  }
  if (loc.scid) {
    const si = (cat.subCategories||[]).findIndex(s => s.id === loc.scid);
    if (si < 0) return gone('תת-הקטגוריה');
    const sub = cat.subCategories[si];
    return {data: putCat({...cat, subCategories: cat.subCategories.map((s, i) => i === si ? {...sub, models: ins(sub.models, node, loc.idx)} : s)}), mids};
  }
  return {data: putCat({...cat, models: ins(cat.models, node, loc.idx)}), mids};
}
