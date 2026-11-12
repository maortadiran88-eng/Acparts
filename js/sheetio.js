/* SheetIO: קריאת XLS (BIFF8) ו-XLSX, כתיבת XLSX, ו-inflate. ללא תלות בספריות חיצוניות. */
(function () {
  'use strict';
  const u16 = (b, p) => b[p] | (b[p + 1] << 8);
  const u32 = (b, p) => (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0;
  const f64 = (b, p) => new DataView(b.buffer, b.byteOffset + p, 8).getFloat64(0, true);
  const dec16 = (b, p, n) => new TextDecoder('utf-16le').decode(b.subarray(p, p + n * 2));
  const latin1 = (b, p, n) => { let s = ''; for (let i = 0; i < n; i += 8192) s += String.fromCharCode.apply(null, b.subarray(p + i, p + Math.min(n, i + 8192))); return s; };
  const utf8 = (b) => new TextDecoder('utf-8').decode(b);

  // ===== inflate (RFC 1951) =====
  const LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
  const LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
  const DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
  const DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
  const CLORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
  function huff(lengths, n) {
    const count = new Uint16Array(16), offs = new Uint16Array(16), symbol = new Uint16Array(n);
    for (let i = 0; i < n; i++) count[lengths[i]]++;
    for (let l = 1; l < 15; l++) offs[l + 1] = offs[l] + count[l];
    for (let s = 0; s < n; s++) if (lengths[s]) symbol[offs[lengths[s]]++] = s;
    return { count, symbol };
  }
  let FIXED = null;
  function inflateRaw(src) {
    let pos = 0, bitBuf = 0, bitCnt = 0;
    let out = new Uint8Array(Math.max(4096, src.length * 4)), outLen = 0;
    const ensure = (n) => { if (outLen + n > out.length) { const nb = new Uint8Array(Math.max(out.length * 2, outLen + n)); nb.set(out.subarray(0, outLen)); out = nb; } };
    const bits = (n) => {
      while (bitCnt < n) { if (pos >= src.length) throw new Error('inflate: נתונים קטועים'); bitBuf |= src[pos++] << bitCnt; bitCnt += 8; }
      const v = bitBuf & ((1 << n) - 1); bitBuf >>>= n; bitCnt -= n; return v;
    };
    const decode = (h) => {
      let code = 0, first = 0, index = 0;
      for (let len = 1; len <= 15; len++) {
        code |= bits(1);
        const c = h.count[len];
        if (code - c < first) return h.symbol[index + (code - first)];
        index += c; first += c; first <<= 1; code <<= 1;
      }
      throw new Error('inflate: קוד לא תקין');
    };
    const codes = (lh, dh) => {
      for (;;) {
        let sym = decode(lh);
        if (sym < 256) { ensure(1); out[outLen++] = sym; }
        else if (sym === 256) return;
        else {
          sym -= 257; if (sym >= 29) throw new Error('inflate: סמל לא תקין');
          const len = LBASE[sym] + bits(LEXT[sym]);
          const ds = decode(dh); if (ds >= 30) throw new Error('inflate: מרחק לא תקין');
          const dist = DBASE[ds] + bits(DEXT[ds]);
          if (dist > outLen) throw new Error('inflate: מרחק חורג');
          ensure(len);
          for (let i = 0; i < len; i++) { out[outLen] = out[outLen - dist]; outLen++; }
        }
      }
    };
    let last;
    do {
      last = bits(1);
      const type = bits(2);
      if (type === 0) {
        bitBuf = 0; bitCnt = 0;
        const len = src[pos] | (src[pos + 1] << 8); pos += 4;
        ensure(len); out.set(src.subarray(pos, pos + len), outLen); outLen += len; pos += len;
      } else if (type === 1) {
        if (!FIXED) {
          const l = new Uint8Array(288);
          for (let i = 0; i < 144; i++) l[i] = 8;
          for (let i = 144; i < 256; i++) l[i] = 9;
          for (let i = 256; i < 280; i++) l[i] = 7;
          for (let i = 280; i < 288; i++) l[i] = 8;
          const d = new Uint8Array(30).fill(5);
          FIXED = [huff(l, 288), huff(d, 30)];
        }
        codes(FIXED[0], FIXED[1]);
      } else if (type === 2) {
        const nlen = bits(5) + 257, ndist = bits(5) + 1, ncode = bits(4) + 4;
        const lengths = new Uint8Array(320);
        for (let i = 0; i < ncode; i++) lengths[CLORDER[i]] = bits(3);
        const lenh = huff(lengths.subarray(0, 19), 19);
        const ll = new Uint8Array(nlen + ndist);
        let idx = 0;
        while (idx < nlen + ndist) {
          let sym = decode(lenh);
          if (sym < 16) ll[idx++] = sym;
          else {
            let rep, val = 0;
            if (sym === 16) { if (!idx) throw new Error('inflate: אורך לא תקין'); val = ll[idx - 1]; rep = 3 + bits(2); }
            else if (sym === 17) rep = 3 + bits(3);
            else rep = 11 + bits(7);
            if (idx + rep > nlen + ndist) throw new Error('inflate: חזרה חורגת');
            while (rep--) ll[idx++] = val;
          }
        }
        codes(huff(ll.subarray(0, nlen), nlen), huff(ll.subarray(nlen), ndist));
      } else throw new Error('inflate: סוג בלוק לא תקין');
    } while (!last);
    return out.subarray(0, outLen);
  }

  // ===== ZIP =====
  function zipEntries(u8) {
    let e = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65600); i--) if (u32(u8, i) === 0x06054b50) { e = i; break; }
    if (e < 0) throw new Error('קובץ ZIP לא תקין');
    const n = u16(u8, e + 10); let p = u32(u8, e + 16);
    const map = new Map();
    for (let i = 0; i < n; i++) {
      if (u32(u8, p) !== 0x02014b50) break;
      const method = u16(u8, p + 10), csize = u32(u8, p + 20), nl = u16(u8, p + 28), xl = u16(u8, p + 30), cl = u16(u8, p + 32), off = u32(u8, p + 42);
      const name = utf8(u8.subarray(p + 46, p + 46 + nl));
      map.set(name, { method, csize, off });
      p += 46 + nl + xl + cl;
    }
    return map;
  }
  function zipGet(u8, map, name) {
    const ent = map.get(name); if (!ent) return null;
    const lo = ent.off, start = lo + 30 + u16(u8, lo + 26) + u16(u8, lo + 28);
    const data = u8.subarray(start, start + ent.csize);
    if (ent.method === 0) return data;
    if (ent.method === 8) return inflateRaw(data);
    throw new Error('שיטת דחיסה לא נתמכת בקובץ');
  }
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = (b) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  function zipStore(files) { // files: [{name, data(Uint8Array)}]
    const enc = new TextEncoder(), parts = [], central = [];
    let off = 0;
    files.forEach((f) => {
      const nm = enc.encode(f.name), crc = crc32(f.data), sz = f.data.length;
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
      lh.setUint16(10, 0, true); lh.setUint16(12, 0x21, true); lh.setUint32(14, crc, true); lh.setUint32(18, sz, true); lh.setUint32(22, sz, true);
      lh.setUint16(26, nm.length, true); lh.setUint16(28, 0, true);
      parts.push(new Uint8Array(lh.buffer), nm, f.data);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
      ch.setUint16(12, 0, true); ch.setUint16(14, 0x21, true); ch.setUint32(16, crc, true); ch.setUint32(20, sz, true); ch.setUint32(24, sz, true);
      ch.setUint16(28, nm.length, true); ch.setUint32(42, off, true);
      central.push(new Uint8Array(ch.buffer), nm);
      off += 30 + nm.length + sz;
    });
    const csize = central.reduce((n, x) => n + x.length, 0);
    const eo = new DataView(new ArrayBuffer(22));
    eo.setUint32(0, 0x06054b50, true); eo.setUint16(8, files.length, true); eo.setUint16(10, files.length, true); eo.setUint32(12, csize, true); eo.setUint32(16, off, true);
    return new Blob([...parts, ...central, new Uint8Array(eo.buffer)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }

  // ===== OLE2 / Compound File =====
  function readCfb(u8) {
    const sig = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
    for (let i = 0; i < 8; i++) if (u8[i] !== sig[i]) throw new Error('לא קובץ OLE');
    const ss = 1 << u16(u8, 30), mss = 1 << u16(u8, 32);
    const sect = (i) => u8.subarray(512 + i * ss, 512 + (i + 1) * ss);
    const difat = [];
    for (let i = 0; i < 109; i++) { const v = u32(u8, 76 + i * 4); if (v < 0xfffffffa) difat.push(v); }
    let dn = u32(u8, 68), dcount = u32(u8, 72);
    while (dcount-- > 0 && dn < 0xfffffffa) {
      const s = sect(dn);
      for (let i = 0; i < ss / 4 - 1; i++) { const v = u32(s, i * 4); if (v < 0xfffffffa) difat.push(v); }
      dn = u32(s, ss - 4);
    }
    const fat = [];
    difat.forEach((id) => { const s = sect(id); for (let i = 0; i < ss / 4; i++) fat.push(u32(s, i * 4)); });
    const chain = (start) => { const r = []; let c = start, guard = 0; while (c < 0xfffffffa && guard++ < 1e6) { r.push(c); c = fat[c]; } return r; };
    const readChain = (start, size) => {
      const ids = chain(start), out = new Uint8Array(ids.length * ss);
      ids.forEach((id, i) => out.set(sect(id), i * ss));
      return size != null ? out.subarray(0, size) : out;
    };
    const dir = readChain(u32(u8, 48));
    const entries = [];
    for (let p = 0; p + 128 <= dir.length; p += 128) {
      const nl = u16(dir, p + 64), type = dir[p + 66];
      if (!type) continue;
      entries.push({ name: dec16(dir, p, Math.max(0, nl / 2 - 1)), type, start: u32(dir, p + 116), size: u32(dir, p + 120) });
    }
    const root = entries.find((e) => e.type === 5);
    let mini = null, miniFat = null;
    const cutoff = u32(u8, 56);
    function stream(name) {
      const e = entries.find((x) => x.type === 2 && x.name === name);
      if (!e) return null;
      if (e.size >= cutoff) return readChain(e.start, e.size);
      if (!mini) {
        mini = readChain(root.start, root.size);
        const mf = readChain(u32(u8, 60));
        miniFat = []; for (let i = 0; i < mf.length; i += 4) miniFat.push(u32(mf, i));
      }
      const out = new Uint8Array(e.size); let c = e.start, o = 0, guard = 0;
      while (c < 0xfffffffa && o < e.size && guard++ < 1e6) {
        const part = mini.subarray(c * mss, c * mss + mss);
        out.set(part.subarray(0, Math.min(mss, e.size - o)), o); o += mss; c = miniFat[c];
      }
      return out;
    }
    return { stream };
  }

  // ===== BIFF8 (XLS) =====
  function rkVal(v) {
    let x;
    if (v & 2) x = v >> 2;
    else { const dv = new DataView(new ArrayBuffer(8)); dv.setUint32(4, (v & 0xfffffffc) >>> 0, true); x = dv.getFloat64(0, true); }
    return v & 1 ? x / 100 : x;
  }
  const ERRS = { 0x00: '#NULL!', 0x07: '#DIV/0!', 0x0f: '#VALUE!', 0x17: '#REF!', 0x1d: '#NAME?', 0x24: '#NUM!', 0x2a: '#N/A' };
  const errText = (c) => ERRS[c] || '#ERR';
  function biffString(d, p, cch) { // [grbit][chars]
    const fl = d[p]; p++;
    const uni = fl & 1;
    return uni ? dec16(d, p, cch) : latin1(d, p, cch);
  }
  function parseSst(segs) {
    let si = 0, seg = segs[0], p = 8, end = seg.length;
    const out = [], uniq = u32(seg, 4);
    const nextSeg = () => { si++; seg = segs[si]; p = 0; end = seg ? seg.length : 0; return !!seg; };
    const rd8 = () => { if (p >= end && !nextSeg()) return 0; return seg[p++]; };
    const skip = (n) => { while (n > 0) { if (p >= end && !nextSeg()) return; const t = Math.min(n, end - p); p += t; n -= t; } };
    for (let k = 0; k < uniq; k++) {
      if (p >= end && !nextSeg()) break;
      const cch = rd8() | (rd8() << 8), flags = rd8();
      let uni = flags & 1, runs = 0, extLen = 0;
      if (flags & 8) runs = rd8() | (rd8() << 8);
      if (flags & 4) extLen = (rd8() | (rd8() << 8) | (rd8() << 16) | (rd8() << 24)) >>> 0;
      let s = '', rem = cch;
      while (rem > 0) {
        if (p >= end) { if (!nextSeg()) break; uni = seg[p++] & 1; if (p >= end) continue; }
        const bpc = uni ? 2 : 1, n = Math.min(rem, ((end - p) / bpc) | 0);
        if (n === 0) { p = end; continue; }
        s += uni ? dec16(seg, p, n) : latin1(seg, p, n);
        p += n * bpc; rem -= n;
      }
      skip(runs * 4 + extLen);
      out.push(s);
    }
    return out;
  }
  function readXls(u8) {
    const cfb = readCfb(u8);
    const w = cfb.stream('Workbook') || cfb.stream('Book');
    if (!w) throw new Error('לא נמצא גיליון עבודה בקובץ');
    const sheets = [];
    let sstSegs = null, sst = [], off = 0;
    let depth = 0, lastSst = false, version = 0;
    while (off + 4 <= w.length) {
      const rt = u16(w, off), ln = u16(w, off + 2), d = w.subarray(off + 4, off + 4 + ln);
      if (rt === 0x809) { if (depth === 0 && !version) version = u16(d, 0); depth++; }
      else if (rt === 0x0a) { depth = Math.max(0, depth - 1); }
      else if (rt === 0x2f) throw new Error('הקובץ מוגן בסיסמה');
      else if (rt === 0x85) {
        const type = d[5], nl = d[6], fl = d[7];
        sheets.push({ off: u32(d, 0), type, name: fl & 1 ? dec16(d, 8, nl) : latin1(d, 8, nl) });
      } else if (rt === 0xfc) { sstSegs = [d]; lastSst = true; }
      else if (rt === 0x3c && lastSst) sstSegs.push(d);
      if (rt !== 0xfc && rt !== 0x3c) lastSst = false;
      off += 4 + ln;
      if (rt === 0x0a && depth === 0 && sheets.length) break; // סוף ה-globals
    }
    if (version && version !== 0x0600) throw new Error('פורמט XLS ישן (לפני Excel 97). יש לשמור את הקובץ כ-XLSX או כ-XLS חדש.');
    if (sstSegs) sst = parseSst(sstSegs);
    const names = sheets.filter((s) => s.type === 0).map((s) => s.name);
    const cache = new Map();
    function getRows(name) {
      if (cache.has(name)) return cache.get(name);
      const sh = sheets.find((s) => s.name === name && s.type === 0);
      if (!sh) return [];
      const rows = []; let maxC = 0;
      const put = (r, c, v) => { (rows[r] || (rows[r] = []))[c] = v; if (c > maxC) maxC = c; };
      let p = sh.off, dp = 0, lastF = null;
      while (p + 4 <= w.length) {
        const rt = u16(w, p), ln = u16(w, p + 2), d = w.subarray(p + 4, p + 4 + ln);
        if (rt === 0x809) dp++;
        else if (rt === 0x0a) { dp--; if (dp <= 0) break; }
        else if (rt === 0xfd) put(u16(d, 0), u16(d, 2), sst[u32(d, 6)] == null ? '' : sst[u32(d, 6)]);
        else if (rt === 0x204) { const cch = u16(d, 6); put(u16(d, 0), u16(d, 2), biffString(d, 8, cch)); }
        else if (rt === 0x203) put(u16(d, 0), u16(d, 2), f64(d, 6));
        else if (rt === 0x27e) put(u16(d, 0), u16(d, 2), rkVal(u32(d, 6)));
        else if (rt === 0xbd) {
          const r = u16(d, 0), c0 = u16(d, 2), n = (ln - 6) / 6;
          for (let i = 0; i < n; i++) put(r, c0 + i, rkVal(u32(d, 4 + i * 6 + 2)));
        } else if (rt === 0x06) {
          const r = u16(d, 0), c = u16(d, 2);
          if (d[12] === 0xff && d[13] === 0xff) {
            const t = d[6];
            if (t === 0) lastF = [r, c]; else if (t === 1) put(r, c, !!d[8]); else if (t === 3) put(r, c, ''); else put(r, c, errText(d[8]));
          } else put(r, c, f64(d, 6));
        } else if (rt === 0x207 && lastF) { put(lastF[0], lastF[1], biffString(d, 2, u16(d, 0))); lastF = null; }
        else if (rt === 0x205) put(u16(d, 0), u16(d, 2), d[7] ? errText(d[6]) : !!d[6]);
        p += 4 + ln;
      }
      const out = [];
      for (let r = 0; r < rows.length; r++) {
        const src = rows[r] || [], row = new Array(maxC + 1);
        for (let c = 0; c <= maxC; c++) row[c] = src[c] === undefined ? '' : src[c];
        out.push(row);
      }
      cache.set(name, out);
      return out;
    }
    return { kind: 'xls', names, getRows, workbook: w, sheetInfo: sheets };
  }

  // ===== XLSX =====
  function colIndex(ref) { let n = 0; for (let i = 0; i < ref.length; i++) { const c = ref.charCodeAt(i); if (c < 65 || c > 90) break; n = n * 26 + (c - 64); } return n - 1; }
  function readXlsx(u8) {
    const map = zipEntries(u8);
    const text = (n) => { const d = zipGet(u8, map, n); return d ? utf8(d) : ''; };
    const parse = (s) => new DOMParser().parseFromString(s, 'application/xml');
    const all = (doc, tag) => Array.from(doc.getElementsByTagNameNS('*', tag));
    const wb = parse(text('xl/workbook.xml'));
    const relDoc = parse(text('xl/_rels/workbook.xml.rels'));
    const rel = {};
    all(relDoc, 'Relationship').forEach((r) => { rel[r.getAttribute('Id')] = r.getAttribute('Target'); });
    const norm = (base, t) => { if (t.startsWith('/')) return t.slice(1); const parts = (base + t).split('/'), o = []; parts.forEach((x) => { if (x === '..') o.pop(); else if (x !== '.') o.push(x); }); return o.join('/'); };
    const sheets = all(wb, 'sheet').map((s) => ({ name: s.getAttribute('name'), path: norm('xl/', rel[s.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id') || s.getAttribute('r:id')] || '') }));
    let sst = null;
    const getSst = () => {
      if (sst) return sst;
      sst = [];
      const t = text('xl/sharedStrings.xml');
      if (t) all(parse(t), 'si').forEach((si) => {
        let s = '';
        all(si, 't').forEach((x) => { if (!x.parentNode || x.parentNode.localName !== 'rPh') s += x.textContent; });
        sst.push(s);
      });
      return sst;
    };
    const cache = new Map();
    function getRows(name) {
      if (cache.has(name)) return cache.get(name);
      const sh = sheets.find((s) => s.name === name);
      if (!sh || !text(sh.path)) return [];
      const doc = parse(text(sh.path)), rows = []; let maxC = 0;
      all(doc, 'c').forEach((c) => {
        const ref = c.getAttribute('r') || '';
        const m = /^([A-Z]+)(\d+)$/.exec(ref); if (!m) return;
        const ci = colIndex(m[1]), ri = Number(m[2]) - 1, t = c.getAttribute('t');
        const vEl = all(c, 'v')[0];
        let val = '';
        if (t === 'inlineStr') { val = all(c, 't').map((x) => x.textContent).join(''); }
        else if (vEl) {
          const raw = vEl.textContent;
          if (t === 's') val = getSst()[Number(raw)] || '';
          else if (t === 'str' || t === 'e') val = raw;
          else if (t === 'b') val = raw === '1';
          else { const n = Number(raw); val = Number.isFinite(n) ? n : raw; }
        }
        (rows[ri] || (rows[ri] = []))[ci] = val;
        if (ci > maxC) maxC = ci;
      });
      const out = [];
      for (let r = 0; r < rows.length; r++) {
        const src = rows[r] || [], row = new Array(maxC + 1);
        for (let c = 0; c <= maxC; c++) row[c] = src[c] === undefined ? '' : src[c];
        out.push(row);
      }
      cache.set(name, out);
      return out;
    }
    return { kind: 'xlsx', names: sheets.map((s) => s.name), getRows, file: (n) => zipGet(u8, map, n), text, parse, sheets, norm };
  }

  function read(arrayBuffer) {
    const u8 = new Uint8Array(arrayBuffer);
    if (u8[0] === 0x50 && u8[1] === 0x4b) return readXlsx(u8);
    if (u8[0] === 0xd0 && u8[1] === 0xcf) return readXls(u8);
    throw new Error('הקובץ אינו קובץ Excel תקין (XLS או XLSX).');
  }

  // ===== כתיבת XLSX =====
  const xmlEsc = (s) => String(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  function colName(i) { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = ((i - 1) / 26) | 0; } return s; }
  function buildXlsx(sheets, opts) { // sheets: [{name, rows, widths}]
    const rtl = !opts || opts.rtl !== false, enc = new TextEncoder();
    const files = [];
    const add = (name, str) => files.push({ name, data: enc.encode(str) });
    const H = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
    add('[Content_Types].xml', H + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      sheets.map((s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') + '</Types>');
    add('_rels/.rels', H + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
    add('xl/workbook.xml', H + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets>' +
      sheets.map((s, i) => `<sheet name="${xmlEsc(s.name.slice(0, 31))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') + '</sheets></workbook>');
    add('xl/_rels/workbook.xml.rels', H + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
      `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
    add('xl/styles.xml', H + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE6F1FF"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>');
    sheets.forEach((s, i) => {
      let x = H + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">';
      x += `<sheetViews><sheetView ${rtl ? 'rightToLeft="1" ' : ''}workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/>`;
      if (s.widths) x += '<cols>' + s.widths.map((w, k) => `<col min="${k + 1}" max="${k + 1}" width="${w}" customWidth="1"/>`).join('') + '</cols>';
      x += '<sheetData>';
      s.rows.forEach((row, r) => {
        x += `<row r="${r + 1}">`;
        row.forEach((v, c) => {
          if (v === '' || v == null) return;
          const ref = colName(c) + (r + 1), st = r === 0 ? ' s="1"' : ' s="2"';
          x += `<c r="${ref}"${st} t="inlineStr"><is><t xml:space="preserve">${xmlEsc(v)}</t></is></c>`;
        });
        x += '</row>';
      });
      x += '</sheetData></worksheet>';
      add(`xl/worksheets/sheet${i + 1}.xml`, x);
    });
    return zipStore(files);
  }

  window.SheetIO = { read, buildXlsx, inflateRaw, readCfb, zipStore, crc32 };
})();
