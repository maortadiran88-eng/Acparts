/* localdb.js — אחסון מקומי בדפדפן (IndexedDB) במקום Firebase.
   מחקה את חלק ה-Firestore שהאתר משתמש בו, כך שכל שאר הקוד נשאר זהה.
   נתונים נשמרים בדפדפן של כל משתמש. לשיתוף: ייצוא גיבוי (JSON) מהתפריט,
   ואז העלאת הקובץ לתיקיית האתר בשם catalog-data.json — הוא נטען כברירת מחדל. */
(function(){
  const IDB='parts-catalog-local', STORE='cols';
  const cols={}; let dirty=new Set(), timer=null, idb=null;
  const isTs=v=>v&&typeof v==='object'&&v.__ts!==undefined;
  const SERVER_TS={__sentinel:'ts'};
  const uid=()=>Date.now().toString(36)+Math.random().toString(36).slice(2,10);
  const clone=o=>o===undefined?undefined:JSON.parse(JSON.stringify(o));
  const stamp=o=>{ // sentinel -> real time
    if(o&&typeof o==='object'){ for(const k in o){ if(o[k]&&o[k].__sentinel==='ts') o[k]={__ts:Date.now()}; else if(typeof o[k]==='object') stamp(o[k]); } }
    return o;
  };
  const view=o=>{ // __ts -> Timestamp-like (toDate)
    if(Array.isArray(o)) return o.map(view);
    if(isTs(o)) return {toDate:()=>new Date(o.__ts),toMillis:()=>o.__ts};
    if(o&&typeof o==='object'){ const r={}; for(const k in o) r[k]=view(o[k]); return r; }
    return o;
  };
  const tsNum=v=>isTs(v)?v.__ts:v;

  function openIdb(){ return new Promise(res=>{
    try{ const r=indexedDB.open(IDB,1);
      r.onupgradeneeded=()=>r.result.createObjectStore(STORE);
      r.onsuccess=()=>{idb=r.result;res();}; r.onerror=()=>res();
    }catch(e){res();}
  });}
  const idbGet=k=>new Promise(res=>{ if(!idb)return res(); const q=idb.transaction(STORE).objectStore(STORE).get(k); q.onsuccess=()=>res(q.result); q.onerror=()=>res(); });
  const idbAll=()=>new Promise(res=>{ if(!idb)return res([]); const out=[]; const q=idb.transaction(STORE).objectStore(STORE).openCursor();
    q.onsuccess=()=>{const c=q.result; if(c){out.push([c.key,c.value]);c.continue();} else res(out);}; q.onerror=()=>res(out); });
  function flush(){ timer=null; if(!idb)return; const names=[...dirty]; dirty=new Set();
    const tx=idb.transaction(STORE,'readwrite'); const s=tx.objectStore(STORE);
    names.forEach(n=>s.put(cols[n]||{},n)); }
  function touch(n){ dirty.add(n); if(!timer) timer=setTimeout(flush,250); }
  window.addEventListener('pagehide',()=>{ if(timer){clearTimeout(timer);flush();} });

  const ready=(async()=>{
    await openIdb();
    (await idbAll()).forEach(([k,v])=>{cols[k]=v;});
    if(!cols.catalog||!cols.catalog.meta){ // first run: try a shared seed file
      try{ const r=await fetch('catalog-data.json',{cache:'no-store'});
        if(r.ok){ const seed=await r.json(); Object.keys(seed).forEach(n=>{cols[n]=seed[n];touch(n);}); } }catch(e){}
    }
  })();

  const col=n=>cols[n]||(cols[n]={});
  function snap(n,id){ const raw=col(n)[id]; return { id, exists:raw!==undefined, data:()=>view(clone(raw)), ref:{__col:n,__id:id} }; }

  function docRef(n,id){
    return {
      id, __col:n, __id:id,
      async get(){ await ready; return snap(n,id); },
      async set(data,opt){ await ready; const d=stamp(clone(data)); col(n)[id]=(opt&&opt.merge)?{...(col(n)[id]||{}),...d}:d; touch(n); },
      async update(data){ await ready; const cur=col(n)[id]; if(cur===undefined) throw new Error('not-found'); col(n)[id]={...cur,...stamp(clone(data))}; touch(n); },
      async delete(){ await ready; delete col(n)[id]; touch(n); }
    };
  }
  function query(n,filters,order,lim){
    const q={
      orderBy(f,dir){ return query(n,filters,{f,dir:dir||'asc'},lim); },
      limit(k){ return query(n,filters,order,k); },
      where(f,op,v){ return query(n,[...filters,{f,op,v}],order,lim); },
      async get(){ await ready;
        let ids=Object.keys(col(n));
        filters.forEach(({f,op,v})=>{ ids=ids.filter(id=>{ const x=tsNum(col(n)[id][f]); return op==='=='?x===v:op==='!='?x!==v:op==='>'?x>v:op==='<'?x<v:true; }); });
        if(order){ ids.sort((a,b)=>{ const x=tsNum(col(n)[a][order.f])??0, y=tsNum(col(n)[b][order.f])??0; return (x>y?1:x<y?-1:0)*(order.dir==='desc'?-1:1); }); }
        if(lim) ids=ids.slice(0,lim);
        return { docs:ids.map(id=>snap(n,id)), empty:!ids.length, size:ids.length, forEach(fn){this.docs.forEach(fn);} };
      }
    };
    return q;
  }
  const db={
    collection(n){ const base=query(n,[],null,null);
      return Object.assign(base,{
        doc(id){ return docRef(n,id||uid()); },
        async add(data){ await ready; const id=uid(); col(n)[id]=stamp(clone(data)); touch(n); return docRef(n,id); }
      }); },
    batch(){ const ops=[]; return {
      set(ref,data){ ops.push(()=>{col(ref.__col)[ref.__id]=stamp(clone(data));touch(ref.__col);}); return this; },
      update(ref,data){ ops.push(()=>{const c=col(ref.__col)[ref.__id]||{};col(ref.__col)[ref.__id]={...c,...stamp(clone(data))};touch(ref.__col);}); return this; },
      delete(ref){ ops.push(()=>{delete col(ref.__col)[ref.__id];touch(ref.__col);}); return this; },
      async commit(){ await ready; ops.forEach(f=>f()); }
    };}
  };
  window._db=db;
  window.firebase={firestore:{FieldValue:{serverTimestamp:()=>SERVER_TS}}};
  window._localdbReady=ready;
})();
