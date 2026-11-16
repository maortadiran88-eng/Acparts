// ══════════ גיבוי מלא ושחזור (ZIP) ══════════
// גיבוי: קובץ ZIP אחד עם תיקיות לפי שנתון / קטגוריה / דגם, ובכל דגם: התמונות כקבצים אמיתיים + רשימת חלקי חילוף (CSV שנפתח באקסל).
// בנוסף: backup.json (לשחזור בלחיצה), וקובץ Excel אחד עם כל החלקים של כל הדגמים.
const BK_FORMAT = 'tadiran-catalog-backup';
const BK_MIME_EXT = {'image/jpeg':'jpg','image/jpg':'jpg','image/png':'png','image/webp':'webp','image/gif':'gif'};
const BK_EXT_MIME = {jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',webp:'image/webp',gif:'image/gif'};

const bkSafe = (s, max = 40) => {
  let t = String(s == null ? '' : s).replace(/[\\/]/g, '-').replace(/[:*?"<>|\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
  if (!t) t = 'ללא שם';
  return t.slice(0, max).trim() || 'ללא שם';
};
const bkCsv = rows => '\uFEFF' + rows.map(r => r.map(v => {
  v = String(v == null ? '' : v);
  return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}).join(',')).join('\r\n');

function bkEachModel(data, fn) {
  (data.brands || []).forEach(b => (b.categories || []).forEach(c => {
    (c.models || []).forEach(m => fn(b, c, null, m));
    (c.subCategories || []).forEach(sc => (sc.models || []).forEach(m => fn(b, c, sc, m)));
  }));
}
function bkStrip(d) { ['users', 'pass', 'editorPass', 'viewerPass', 'bootError'].forEach(k => { delete d[k]; }); return d; }

function bkDataUrl(u) {
  const i = u.indexOf(',');
  if (i < 0) return null;
  const head = u.slice(5, i), body = u.slice(i + 1);
  const mime = head.split(';')[0] || 'image/jpeg';
  let bin;
  if (/;base64/i.test(head)) bin = atob(body); else bin = decodeURIComponent(body);
  const bytes = new Uint8Array(bin.length);
  for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k) & 255;
  return { mime, bytes };
}

async function bkBuild(data, progress) {
  if (typeof JSZip === 'undefined') throw new Error('ספריית ה-ZIP לא נטענה. בדוק חיבור לאינטרנט ורענן את הדף.');
  const say = progress || (() => {});
  const zip = new JSZip();
  const date = new Date().toISOString().slice(0, 10);
  const root = 'גיבוי-קטלוג-' + date;
  const out = bkStrip(JSON.parse(JSON.stringify(data)));

  const entries = [];
  const used = new Set();
  bkEachModel(out, (b, c, sc, m) => {
    let folder = 'קטלוג/' + bkSafe(b.name) + '/' + bkSafe(c.name) + '/' + (sc ? bkSafe(sc.name) + '/' : '') + bkSafe(m.name);
    let q = folder, n = 2;
    while (used.has(q.toLowerCase())) q = folder + ' (' + (n++) + ')';
    used.add(q.toLowerCase());
    entries.push({ b, c, sc, m, folder: q });
  });

  // תמונות
  const jobs = [];
  entries.forEach(e => (e.m.images || []).forEach((img, i) => jobs.push({ e, i, img })));
  let done = 0, missing = 0, imgCount = 0;
  say('מגבה תמונות 0/' + jobs.length);
  await sbPool(jobs, 4, async j => {
    try {
      let url = j.img, file = null;
      if (typeof url === 'string' && sbIsRef(url)) url = await sbToDataUrl(url);
      if (typeof url === 'string' && url.startsWith('data:')) file = bkDataUrl(url);
      else if (typeof url === 'string' && /^https?:/.test(url)) {
        const r = await fetch(url); if (r.ok) { const blob = await r.blob(); file = { mime: blob.type, bytes: new Uint8Array(await blob.arrayBuffer()) }; }
      }
      if (file) {
        const rel = j.e.folder + '/תמונה-' + (j.i + 1) + '.' + (BK_MIME_EXT[file.mime] || 'jpg');
        zip.file(root + '/' + rel, file.bytes, { compression: 'STORE' });
        j.e.m.images[j.i] = 'zip:' + rel;
        imgCount++;
      } else missing++;
    } catch (err) { missing++; }
    done++; if (done % 3 === 0 || done === jobs.length) say('מגבה תמונות ' + done + '/' + jobs.length);
  });

  // רשימות חלקי חילוף
  say('כותב רשימות חלקים...');
  let partCount = 0;
  const allCols = []; const seenCol = new Set();
  entries.forEach(e => {
    const cols = (e.m.columns && e.m.columns.length) ? e.m.columns : DCOLS();
    const rows = [cols.map(c => c.name).concat(['הופסק', 'תגיות', 'מוסתר'])];
    cols.forEach(c => { if (!seenCol.has(c.name)) { seenCol.add(c.name); allCols.push(c.name); } });
    (e.m.parts || []).forEach(p => {
      rows.push(cols.map(c => (p.values || {})[c.id]).concat([p.discontinued ? 'כן' : '', p.tags || '', p.hidden ? 'כן' : '']));
      partCount++;
    });
    zip.file(root + '/' + e.folder + '/רשימת-חלקים.csv', bkCsv(rows));
    const notes = [e.m.notes || '', (e.m.synonyms || []).length ? 'שמות נוספים: ' + e.m.synonyms.join(', ') : ''].filter(Boolean).join('\n');
    if (notes) zip.file(root + '/' + e.folder + '/הערות.txt', '\uFEFF' + notes);
  });

  // קובץ Excel אחד לכל החלקים
  try {
    if (typeof XLSX !== 'undefined') {
      const aoa = [['שנתון', 'קטגוריה', 'תת-קטגוריה', 'דגם'].concat(allCols, ['הופסק', 'תגיות'])];
      entries.forEach(e => {
        const cols = (e.m.columns && e.m.columns.length) ? e.m.columns : DCOLS();
        (e.m.parts || []).forEach(p => {
          const byName = {}; cols.forEach(c => { if (byName[c.name] == null || byName[c.name] === '') byName[c.name] = (p.values || {})[c.id]; });
          aoa.push([e.b.name, e.c.name, e.sc ? e.sc.name : '', e.m.name].concat(allCols.map(n => byName[n] == null ? '' : byName[n]), [p.discontinued ? 'כן' : '', p.tags || '']));
        });
      });
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'כל החלקים');
      zip.file(root + '/כל-החלקים.xlsx', XLSX.write(wb, { type: 'array', bookType: 'xlsx' }));
    }
  } catch (err) { console.warn('xlsx backup failed', err); }

  // קובץ השחזור
  const info = { models: entries.length, parts: partCount, images: imgCount };
  zip.file(root + '/backup.json', JSON.stringify({ format: BK_FORMAT, version: 1, created: new Date().toISOString(), counts: info, data: out }));
  zip.file(root + '/קראו-אותי.txt', '\uFEFF' + [
    'גיבוי מלא של קטלוג חלקי החילוף (' + date + ')',
    '',
    'מה בפנים:',
    '• תיקיית "קטלוג": תיקייה לכל שנתון / קטגוריה / דגם. בכל דגם: קבצי התמונות ו"רשימת-חלקים.csv" (נפתח באקסל).',
    '• כל-החלקים.xlsx: כל החלקים של כל הדגמים בקובץ אחד.',
    '• backup.json: קובץ השחזור. אסור למחוק אותו ואסור לשנות את מבנה התיקיות. נשארים בתוך אותה תיקייה עם התמונות.',
    '',
    'שחזור: באתר ← תפריט ⋮ ← "שחזור מגיבוי" ← בוחרים את קובץ ה-ZIP הזה.',
    'סיסמאות ומשתמשים לא נכללים בגיבוי.',
    '',
    'בגיבוי: ' + info.models + ' דגמים, ' + info.parts + ' חלקים, ' + info.images + ' תמונות.' + (missing ? ' (' + missing + ' תמונות לא נמצאו ולא גובו)' : '')
  ].join('\r\n'));

  say('אורז לקובץ ZIP... 0%');
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 3 } },
    meta => say('אורז לקובץ ZIP... ' + Math.round(meta.percent) + '%'));
  return { blob, name: root + '.zip', info, missing };
}

async function bkBackupDownload(data, progress) {
  const r = await bkBuild(data, progress);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(r.blob); a.download = r.name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  return r;
}

// מחזיר base64 של קובץ (File) בלי להסתמך על FileReader
async function bkFileB64(f) {
  const u8 = new Uint8Array(await f.arrayBuffer());
  let bin = '';
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(bin);
}
const bkNorm = s => String(s).normalize('NFC');

// קורא גיבוי ומחזיר את נתוני הקטלוג לשחזור, אחרי העלאת התמונות למסד.
// source: קובץ ZIP, קובץ JSON, או רשימת קבצים מתיקייה שחולצה (webkitdirectory)
async function bkRestoreRead(source, progress) {
  const say = progress || (() => {});
  let parsed, getB64 = null, prefix = '';
  say('קורא את הקובץ...');
  const isList = Array.isArray(source);
  if (isList) {
    const map = new Map();
    source.forEach(f => map.set(bkNorm(f.webkitRelativePath || f.name), f));
    const key = [...map.keys()].find(k => /(^|\/)backup\.json$/.test(k));
    if (!key) throw new Error('לא נמצא backup.json בתיקייה שבחרת. בחר את התיקייה "גיבוי-קטלוג-..." שחולצה מה-ZIP.');
    prefix = key.slice(0, key.length - 'backup.json'.length);
    parsed = JSON.parse(await map.get(key).text());
    getB64 = async rel => { const f = map.get(bkNorm(prefix + rel)); return f ? await bkFileB64(f) : null; };
  } else if (/\.json$/i.test(source.name)) {
    parsed = JSON.parse(await source.text());
  } else {
    if (typeof JSZip === 'undefined') throw new Error('ספריית ה-ZIP לא נטענה. בדוק חיבור לאינטרנט ורענן את הדף.');
    const zip = await JSZip.loadAsync(source);
    const map = new Map();
    Object.keys(zip.files).forEach(n => { if (!zip.files[n].dir) map.set(bkNorm(n), zip.files[n]); });
    const key = [...map.keys()].find(k => /(^|\/)backup\.json$/.test(k));
    if (!key) throw new Error('לא נמצא backup.json בתוך ה-ZIP. זה לא קובץ גיבוי של האתר.');
    prefix = key.slice(0, key.length - 'backup.json'.length);
    parsed = JSON.parse(await map.get(key).async('string'));
    getB64 = async rel => { const f = map.get(bkNorm(prefix + rel)); return f ? await f.async('base64') : null; };
  }
  const d = bkStrip(parsed && parsed.format === BK_FORMAT ? parsed.data : parsed);
  if (!d || !Array.isArray(d.brands)) throw new Error('הקובץ אינו גיבוי תקין של הקטלוג.');

  const items = [];
  bkEachModel(d, (b, c, sc, m) => (m.images || []).forEach((img, i) => {
    if (typeof img === 'string' && (img.startsWith('zip:') || isDataImg(img))) items.push({ m, i, img });
  }));
  // קובץ backup.json לבדו לא כולל את התמונות: עוצרים לפני שמשנים משהו
  if (!getB64 && items.some(it => it.img.startsWith('zip:')))
    throw new Error('הקובץ backup.json לבדו לא כולל את התמונות (הן שמורות כקבצים בתיקיות הגיבוי).\n\nכדי לשחזר עם התמונות בחר את קובץ ה-ZIP המלא, או השתמש ב"שחזור מתיקייה" ובחר את התיקייה שחולצה.');

  let done = 0, missing = 0;
  say('מעלה תמונות 0/' + items.length);
  await sbPool(items, 3, async it => {
    let url = it.img;
    if (url.startsWith('zip:')) {
      const rel = url.slice(4);
      const b64 = await getB64(rel);
      if (!b64) { missing++; it.m.images[it.i] = null; done++; return; }
      const ext = (rel.split('.').pop() || 'jpg').toLowerCase();
      url = 'data:' + (BK_EXT_MIME[ext] || 'image/jpeg') + ';base64,' + b64;
    }
    it.m.images[it.i] = await sbUploadImage(url);
    done++; if (done % 3 === 0 || done === items.length) say('מעלה תמונות ' + done + '/' + items.length);
  });
  bkEachModel(d, (b, c, sc, m) => { if (m.images) m.images = m.images.filter(Boolean); });
  let models = 0, parts = 0;
  bkEachModel(d, (b, c, sc, m) => { models++; parts += (m.parts || []).length; });
  return { data: d, info: { models, parts, images: items.length - missing }, missing };
}
