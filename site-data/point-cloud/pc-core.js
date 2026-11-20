/* Point cloud core: readers (LAS, LAZ, PLY, E57 later, XYZ/PTS/TXT), filters, thinning, writers.
   No DOM here, so the same file runs in the browser and in Node tests. Original code by Civil Threaders. */
var PC = (function () {
  "use strict";
  var CHUNK = 8 * 1024 * 1024;
  var BATCH = 65536;

  function tick() { return new Promise(function (r) { setTimeout(r, 0); }); }

  /* ---------- byte source: a browser File/Blob or a Node buffer wrapper ---------- */
  function src(fileLike) {
    return {
      size: fileLike.size,
      name: fileLike.name || "cloud",
      read: function (off, len) {
        len = Math.max(0, Math.min(len, fileLike.size - off));
        return fileLike.slice(off, off + len).arrayBuffer().then(function (ab) { return new Uint8Array(ab); });
      }
    };
  }

  function i64(dv, o) { return dv.getUint32(o, true) + dv.getInt32(o + 4, true) * 4294967296; }
  function u64(dv, o) { return dv.getUint32(o, true) + dv.getUint32(o + 4, true) * 4294967296; }
  function cstr(u8, o, n) { var s = ""; for (var i = 0; i < n; i++) { var c = u8[o + i]; if (!c) break; s += String.fromCharCode(c); } return s; }

  /* ---------- LAS / LAZ header ---------- */
  var BASE_LEN = { 0: 20, 1: 28, 2: 26, 3: 34, 4: 57, 5: 63, 6: 30, 7: 36, 8: 38, 9: 59, 10: 67 };
  var RGB_OFF = { 2: 20, 3: 28, 5: 28, 7: 30, 8: 30, 10: 30 };

  function lasHeader(s) {
    return s.read(0, 375).then(function (h) {
      if (cstr(h, 0, 4) !== "LASF") throw err("notLas");
      var dv = new DataView(h.buffer, h.byteOffset, h.byteLength);
      var H = {
        kind: "las", vMaj: h[24], vMin: h[25], headerSize: dv.getUint16(94, true),
        offData: dv.getUint32(96, true), nVlr: dv.getUint32(100, true),
        pfRaw: h[104], recLen: dv.getUint16(105, true), legacyCount: dv.getUint32(107, true),
        scale: [dv.getFloat64(131, true), dv.getFloat64(139, true), dv.getFloat64(147, true)],
        offset: [dv.getFloat64(155, true), dv.getFloat64(163, true), dv.getFloat64(171, true)],
        max: [dv.getFloat64(179, true), dv.getFloat64(195, true), dv.getFloat64(211, true)],
        min: [dv.getFloat64(187, true), dv.getFloat64(203, true), dv.getFloat64(219, true)],
        software: cstr(h, 58, 32).trim(), system: cstr(h, 26, 32).trim()
      };
      H.rawHeader = h.slice(0, Math.min(H.headerSize, h.length));
      H.pf = H.pfRaw & 0x3f; H.compressed = (H.pfRaw & 0x80) !== 0;
      H.count = H.legacyCount;
      if (H.vMin >= 4 && H.headerSize >= 375) {
        H.evlrStart = u64(dv, 235); H.nEvlr = dv.getUint32(243, true);
        var ext = u64(dv, 247); if (ext) H.count = ext;
      }
      if (BASE_LEN[H.pf] === undefined) throw err("badFormat");
      H.hasRGB = RGB_OFF[H.pf] !== undefined;
      H.vlrs = [];
      return s.read(H.headerSize, Math.max(0, H.offData - H.headerSize)).then(function (v) {
        var dv2 = new DataView(v.buffer, v.byteOffset, v.byteLength), o = 0;
        for (var i = 0; i < H.nVlr && o + 54 <= v.length; i++) {
          var len = dv2.getUint16(o + 20, true);
          H.vlrs.push({ user: cstr(v, o + 2, 16), id: dv2.getUint16(o + 18, true), desc: cstr(v, o + 22, 32), data: v.slice(o + 54, o + 54 + len), raw: v.slice(o, o + 54 + len) });
          o += 54 + len;
        }
        H.evlrs = [];
        var next = Promise.resolve();
        if (H.nEvlr && H.evlrStart && H.evlrStart < s.size) {
          next = s.read(H.evlrStart, s.size - H.evlrStart).then(function (e) {
            var dv3 = new DataView(e.buffer, e.byteOffset, e.byteLength), q = 0;
            for (var j = 0; j < H.nEvlr && q + 60 <= e.length; j++) {
              var L = u64(dv3, q + 20);
              var rec = { user: cstr(e, q + 2, 16), id: dv3.getUint16(q + 18, true), data: e.slice(q + 60, q + 60 + L), raw: e.slice(q, q + 60 + L) };
              H.evlrs.push(rec); q += 60 + L;
            }
          });
        }
        return next.then(function () {
          H.crs = lasCrs(H);
          var lz = H.vlrs.filter(function (r) { return r.user === "laszip encoded" && r.id === 22204; })[0];
          if (H.compressed || lz) {
            H.compressed = true; H.kind = "laz";
            if (!lz) throw err("lazNoVlr");
            var d = new DataView(lz.data.buffer, lz.data.byteOffset, lz.data.byteLength);
            H.lz = { compressor: d.getUint16(0, true), chunkSize: d.getUint32(12, true) };
          }
          return H;
        });
      });
    });
  }

  /* CRS from GeoTIFF keys or WKT. Returns {epsg, name, unit, wkt}. */
  function lasCrs(H) {
    var all = H.vlrs.concat(H.evlrs || []), out = { epsg: 0, name: "", unit: "", vert: 0 };
    var wkt = all.filter(function (r) { return r.id === 2112; })[0];
    if (wkt) {
      var w = ""; for (var i = 0; i < wkt.data.length; i++) { if (!wkt.data[i]) break; w += String.fromCharCode(wkt.data[i]); }
      out.wkt = w;
      var m = /^\s*(?:COMPD_CS|COMPOUNDCRS)\[\s*"[^"]*"\s*,\s*(.*)$/i.exec(w); var main = m ? m[1] : w;
      var nm = /^\s*(PROJCS|PROJCRS|GEOGCS|GEOGCRS|GEODCRS)\[\s*"([^"]*)"/i.exec(main);
      if (nm) out.name = nm[2];
      out.epsg = topAuthority(main);
      var top = firstGroup(main), um, ure = /(?:LENGTHUNIT|UNIT)\[\s*"([^"]+)"/gi, lv = levels(top);
      while ((um = ure.exec(top))) if (lv[um.index] === 1) out.unit = unitName(um[1]);
    }
    var gk = all.filter(function (r) { return r.user === "LASF_Projection" && r.id === 34735; })[0];
    if (gk && gk.data.length >= 8) {
      var d = new DataView(gk.data.buffer, gk.data.byteOffset, gk.data.byteLength);
      var n = d.getUint16(6, true);
      for (var k = 0; k < n && 8 + k * 8 + 8 <= gk.data.length; k++) {
        var o = 8 + k * 8, id = d.getUint16(o, true), loc = d.getUint16(o + 2, true), val = d.getUint16(o + 6, true);
        if (loc !== 0) continue;
        if (id === 3072 && val > 0 && val < 32767 && !out.epsg) out.epsg = val;
        if (id === 2048 && val > 0 && val < 32767 && !out.epsg) out.epsg = val;
        if (id === 3076 && !out.unit) out.unit = val === 9001 ? "m" : val === 9002 ? "ft" : val === 9003 ? "usft" : "";
        if (id === 4099 && !out.unit) out.unit = val === 9001 ? "m" : val === 9002 ? "ft" : val === 9003 ? "usft" : "";
        if (id === 4096) out.vert = val;
      }
    }
    if (/israel/i.test(out.name)) out.name = "";
    if (!out.unit && /\b(?:feet|foot|ft)\b/i.test(out.name)) out.unit = /us/i.test(out.name) ? "usft" : "ft";
    return out;
  }
  function levels(w) { var lvl = [], d = 0; for (var i = 0; i < w.length; i++) { var c = w[i]; if (c === "[") d++; else if (c === "]") d--; lvl[i] = d; } return lvl; }
  function firstGroup(w) { var d = 0, seen = false; for (var i = 0; i < w.length; i++) { var c = w[i]; if (c === "[") { d++; seen = true; } else if (c === "]") { d--; if (seen && d === 0) return w.slice(0, i + 1); } } return w; }
  function unitName(u) { u = u.toLowerCase(); if (/us survey/.test(u)) return "usft"; if (/foot|feet/.test(u)) return "ft"; if (/met/.test(u)) return "m"; if (/degree/.test(u)) return "deg"; return ""; }
  function topAuthority(w) {
    w = firstGroup(w); var lvl = levels(w), last = 0, re = /(AUTHORITY|ID)\[\s*"EPSG"\s*,\s*"?(\d+)"?\s*\]/gi, m;
    while ((m = re.exec(w))) if (lvl[m.index] === 1) last = +m[2];
    return last;
  }

  /* ---------- point record decoding (LAS formats 0-10) ---------- */
  function Batch(n, recLen) {
    return { n: 0, x: new Float64Array(n), y: new Float64Array(n), z: new Float64Array(n), i: new Uint16Array(n), r: new Uint16Array(n), g: new Uint16Array(n), b: new Uint16Array(n), c: new Uint8Array(n), raw: recLen ? new Uint8Array(n * recLen) : null, recLen: recLen || 0 };
  }
  function decodeRecords(H, u8, off, count, B) {
    var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), L = H.recLen, pf = H.pf, sx = H.scale[0], sy = H.scale[1], sz = H.scale[2], ox = H.offset[0], oy = H.offset[1], oz = H.offset[2];
    var ro = RGB_OFF[pf], newer = pf >= 6;
    for (var k = 0; k < count; k++) {
      var o = off + k * L, j = B.n++;
      B.x[j] = dv.getInt32(o, true) * sx + ox; B.y[j] = dv.getInt32(o + 4, true) * sy + oy; B.z[j] = dv.getInt32(o + 8, true) * sz + oz;
      B.i[j] = dv.getUint16(o + 12, true);
      B.c[j] = newer ? u8[o + 16] : (u8[o + 15] & 31);
      if (ro !== undefined) { B.r[j] = dv.getUint16(o + ro, true); B.g[j] = dv.getUint16(o + ro + 2, true); B.b[j] = dv.getUint16(o + ro + 4, true); }
      if (B.raw) B.raw.set(u8.subarray(o, o + L), j * L);
    }
  }

  function iterLAS(s, H, onBatch, onProg, keepRaw) {
    var L = H.recLen, per = Math.max(1, Math.floor(CHUNK / L)), done = 0, total = H.count;
    function step() {
      if (done >= total) return Promise.resolve();
      var n = Math.min(per, total - done);
      return s.read(H.offData + done * L, n * L).then(function (u8) {
        n = Math.min(n, Math.floor(u8.length / L));
        if (!n) { done = total; return; }
        var pos = 0;
        while (pos < n) {
          var m = Math.min(BATCH, n - pos), B = Batch(m, keepRaw ? L : 0);
          decodeRecords(H, u8, pos * L, m, B); pos += m;
          var r = onBatch(B); if (r === false) { done = total; return; }
        }
        done += n; if (onProg) onProg(done / total);
        return tick().then(step);
      });
    }
    return step();
  }

  /* ---------- LAZ: chunk table (LASzip arithmetic coder) + laz-perf chunk decoder ---------- */
  function ArithDec(u8, pos) {
    this.u8 = u8; this.p = pos; this.length = 0xFFFFFFFF;
    this.value = ((u8[this.p++] << 24) | (u8[this.p++] << 16) | (u8[this.p++] << 8) | u8[this.p++]) >>> 0;
  }
  ArithDec.prototype.byte = function () { return this.p < this.u8.length ? this.u8[this.p++] : 0; };
  ArithDec.prototype.renorm = function () {
    do { this.value = ((this.value << 8) | this.byte()) >>> 0; this.length = (this.length * 256) >>> 0; } while (this.length < 0x01000000);
  };
  ArithDec.prototype.bit = function (m) {
    var x = m.p0 * (this.length >>> 13), sym = this.value >= x ? 1 : 0;
    if (!sym) { this.length = x; m.c0++; } else { this.value -= x; this.length -= x; }
    if (this.length < 0x01000000) this.renorm();
    if (--m.until === 0) m.update();
    return sym;
  };
  ArithDec.prototype.sym = function (m) {
    var n, sym, x, y = this.length, k;
    if (m.table) {
      this.length = this.length >>> 15;
      var dv = Math.floor(this.value / this.length), t = dv >>> m.shift;
      sym = m.table[t]; n = m.table[t + 1] + 1;
      while (n > sym + 1) { k = (sym + n) >>> 1; if (m.dist[k] > dv) n = k; else sym = k; }
      x = m.dist[sym] * this.length;
      if (sym !== m.last) y = m.dist[sym + 1] * this.length;
    } else {
      x = sym = 0; this.length = this.length >>> 15; n = m.n; k = n >>> 1;
      do { var z = this.length * m.dist[k]; if (z > this.value) { n = k; y = z; } else { sym = k; x = z; } } while ((k = (sym + n) >>> 1) !== sym);
    }
    this.value -= x; this.length = y - x;
    if (this.length < 0x01000000) this.renorm();
    m.cnt[sym]++;
    if (--m.until === 0) m.update();
    return sym;
  };
  ArithDec.prototype.short = function () {
    this.length = this.length >>> 16; var s = Math.floor(this.value / this.length); this.value -= this.length * s;
    if (this.length < 0x01000000) this.renorm(); return s;
  };
  ArithDec.prototype.bits = function (b) {
    if (b > 19) { var lo = this.short(); var hi = this.bits(b - 16); return hi * 65536 + lo; }
    this.length = this.length >>> b; var s = Math.floor(this.value / this.length); this.value -= this.length * s;
    if (this.length < 0x01000000) this.renorm(); return s;
  };
  function BitModel() { this.c0 = 1; this.total = 2; this.p0 = 1 << 12; this.cycle = this.until = 4; }
  BitModel.prototype.update = function () {
    if ((this.total += this.cycle) > 8192) { this.total = (this.total + 1) >>> 1; this.c0 = (this.c0 + 1) >>> 1; if (this.c0 === this.total) this.total++; }
    var scale = Math.floor(0x80000000 / this.total);
    this.p0 = Math.floor(this.c0 * scale / 262144);
    this.cycle = (5 * this.cycle) >>> 2; if (this.cycle > 64) this.cycle = 64; this.until = this.cycle;
  };
  function SymModel(n) {
    this.n = n; this.last = n - 1; this.dist = new Uint32Array(n); this.cnt = new Uint32Array(n); this.table = null; this.shift = 0; this.tsize = 0;
    if (n > 16) { var tb = 3; while (n > (1 << (tb + 2))) tb++; this.tsize = 1 << tb; this.shift = 15 - tb; this.table = new Uint32Array(this.tsize + 2); }
    for (var k = 0; k < n; k++) this.cnt[k] = 1;
    this.total = 0; this.cycle = n; this.update(); this.until = this.cycle = (n + 6) >>> 1;
  }
  SymModel.prototype.update = function () {
    var n = this.n, k;
    if ((this.total += this.cycle) > 32768) { this.total = 0; for (k = 0; k < n; k++) { this.cnt[k] = (this.cnt[k] + 1) >>> 1; this.total += this.cnt[k]; } }
    var sum = 0, s = 0, scale = Math.floor(0x80000000 / this.total);
    if (!this.table) { for (k = 0; k < n; k++) { this.dist[k] = Math.floor(scale * sum / 65536); sum += this.cnt[k]; } }
    else {
      for (k = 0; k < n; k++) { this.dist[k] = Math.floor(scale * sum / 65536); sum += this.cnt[k]; var w = this.dist[k] >>> this.shift; while (s < w) this.table[++s] = k - 1; }
      this.table[0] = 0; while (s <= this.tsize) this.table[++s] = n - 1;
    }
    this.cycle = (5 * this.cycle) >>> 2; var mx = (n + 6) << 3; if (this.cycle > mx) this.cycle = mx; this.until = this.cycle;
  };
  function IntDec(dec, contexts) {
    this.dec = dec; this.mBits = []; this.mCorr = [new BitModel()];
    for (var c = 0; c < contexts; c++) this.mBits.push(new SymModel(33));
    for (var i = 1; i <= 32; i++) this.mCorr.push(new SymModel(i <= 8 ? (1 << i) : 256));
  }
  IntDec.prototype.decompress = function (pred, ctx) {
    var d = this.dec, k = d.sym(this.mBits[ctx]), c;
    if (k) {
      if (k < 32) {
        if (k <= 8) c = d.sym(this.mCorr[k]);
        else { var k1 = k - 8; c = d.sym(this.mCorr[k]); var c1 = d.bits(k1); c = c * Math.pow(2, k1) + c1; }
        var half = Math.pow(2, k - 1);
        if (c >= half) c += 1; else c -= (Math.pow(2, k) - 1);
      } else c = -2147483648;
    } else c = d.bit(this.mCorr[0]);
    return (pred + c) | 0;
  };

  function lazChunkTable(s, H) {
    var first = H.offData + 8;
    return s.read(H.offData, 8).then(function (b) {
      var pos = i64(new DataView(b.buffer, b.byteOffset, 8), 0);
      if (pos === -1) return s.read(s.size - 8, 8).then(function (e) { return i64(new DataView(e.buffer, e.byteOffset, 8), 0); });
      return pos;
    }).then(function (pos) {
      if (!(pos > H.offData && pos < s.size)) throw err("lazTable");
      return s.read(pos, Math.min(s.size - pos, 64 * 1024 * 1024)).then(function (t) {
        var dv = new DataView(t.buffer, t.byteOffset, t.byteLength);
        if (dv.getUint32(0, true) !== 0) throw err("lazTable");
        var nCh = dv.getUint32(4, true), variable = H.lz.chunkSize === 0xFFFFFFFF;
        var dec = new ArithDec(t, 8), ic = new IntDec(dec, 2), sizes = [], counts = [], pc = 0, ps = 0;
        for (var i = 0; i < nCh; i++) {
          if (variable) { pc = ic.decompress(pc, 0); counts.push(pc >>> 0); }
          ps = ic.decompress(ps, 1); sizes.push(ps >>> 0);
        }
        var chunks = [], at = first, left = H.count;
        for (var j = 0; j < nCh; j++) {
          var cnt = variable ? counts[j] : Math.min(H.lz.chunkSize, left);
          chunks.push({ off: at, bytes: sizes[j], count: cnt }); at += sizes[j]; left -= cnt;
        }
        if (Math.abs(at - pos) > 0 || left !== 0) throw err("lazTable");
        return chunks;
      });
    });
  }

  var lazMod = null;
  function lazPerf() {
    if (lazMod) return lazMod;
    var load = typeof createLazPerf !== "undefined" ? Promise.resolve() : (typeof document === "undefined" ? Promise.reject(err("lazLib")) : new Promise(function (ok, no) {
      var sc = document.createElement("script"); sc.src = PC.lazJs; sc.onload = ok; sc.onerror = function () { lazMod = null; no(err("lazLib")); };
      if (PC.lazSri) { sc.integrity = PC.lazSri; sc.crossOrigin = "anonymous"; }
      document.head.appendChild(sc);
    }));
    lazMod = load.then(function () { return createLazPerf({ locateFile: function (p) { return (PC.lazWasm || p); } }); });
    lazMod.catch(function () { lazMod = null; });
    return lazMod;
  }

  function iterLAZ(s, H, onBatch, onProg, keepRaw) {
    var L = H.recLen, total = H.count;
    return lazPerf().then(function (M) {
      return lazChunkTable(s, H).then(function (chunks) {
        var dec = new M.ChunkDecoder(), outPtr = M._malloc(L), done = 0, ci = 0, inPtr = 0, inCap = 0, stop = false;
        function chunkStep() {
          if (ci >= chunks.length || stop) return Promise.resolve();
          var ch = chunks[ci++];
          return s.read(ch.off, ch.bytes).then(function (u8) {
            if (u8.length > inCap) { if (inPtr) M._free(inPtr); inCap = u8.length + 1024; inPtr = M._malloc(inCap); }
            M.HEAPU8.set(u8, inPtr);
            dec.open(H.pf, L, inPtr);
            var left = ch.count, buf = new Uint8Array(Math.min(BATCH, left) * L);
            while (left > 0 && !stop) {
              var m = Math.min(BATCH, left); if (buf.length < m * L) buf = new Uint8Array(m * L);
              for (var k = 0; k < m; k++) { dec.getPoint(outPtr); buf.set(M.HEAPU8.subarray(outPtr, outPtr + L), k * L); }
              var B = Batch(m, keepRaw ? L : 0); decodeRecords(H, buf, 0, m, B);
              if (onBatch(B) === false) stop = true;
              left -= m; done += m;
            }
            if (onProg) onProg(done / total);
            return tick().then(chunkStep);
          });
        }
        return chunkStep().then(function () { dec.delete(); M._free(outPtr); if (inPtr) M._free(inPtr); });
      }, function (e) {
        if (e && e.code === "lazLib") throw e;
        return iterLAZWhole(M, s, H, onBatch, onProg, keepRaw); // old pointwise files or no chunk table
      });
    });
  }
  function iterLAZWhole(M, s, H, onBatch, onProg, keepRaw) {
    if (s.size > 1200 * 1024 * 1024) return Promise.reject(err("lazBig"));
    return s.read(0, s.size).then(function (all) {
      var L = H.recLen, ptr = M._malloc(all.length), outPtr = M._malloc(L);
      M.HEAPU8.set(all, ptr); all = null;
      var z = new M.LASZip(); z.open(ptr, s.size);
      var total = z.getCount() || H.count, done = 0, stop = false;
      function step() {
        if (done >= total || stop) { z.delete(); M._free(ptr); M._free(outPtr); return Promise.resolve(); }
        var m = Math.min(BATCH * 4, total - done), buf = new Uint8Array(m * L);
        for (var k = 0; k < m; k++) { z.getPoint(outPtr); buf.set(M.HEAPU8.subarray(outPtr, outPtr + L), k * L); }
        for (var p = 0; p < m && !stop; p += BATCH) {
          var q = Math.min(BATCH, m - p), B = Batch(q, keepRaw ? L : 0); decodeRecords(H, buf, p * L, q, B);
          if (onBatch(B) === false) stop = true;
        }
        done += m; if (onProg) onProg(done / total);
        return tick().then(step);
      }
      return step();
    });
  }

  /* ---------- PLY ---------- */
  var PLY_T = { char: [1, "Int8"], int8: [1, "Int8"], uchar: [1, "Uint8"], uint8: [1, "Uint8"], short: [2, "Int16"], int16: [2, "Int16"], ushort: [2, "Uint16"], uint16: [2, "Uint16"], int: [4, "Int32"], int32: [4, "Int32"], uint: [4, "Uint32"], uint32: [4, "Uint32"], float: [4, "Float32"], float32: [4, "Float32"], double: [8, "Float64"], float64: [8, "Float64"] };
  function plyHeader(s) {
    return s.read(0, Math.min(s.size, 65536)).then(function (u8) {
      var txt = ""; for (var i = 0; i < u8.length; i++) txt += String.fromCharCode(u8[i]);
      var end = txt.indexOf("end_header");
      if (txt.slice(0, 3) !== "ply" || end < 0) throw err("badPly");
      var nl = txt.indexOf("\n", end), lines = txt.slice(0, end).split(/\r?\n/), H = { kind: "ply", offData: nl + 1, props: [], count: 0, crs: {} };
      var el = null, before = 0;
      lines.forEach(function (ln) {
        var w = ln.trim().split(/\s+/);
        if (w[0] === "format") H.fmt = w[1];
        else if (w[0] === "element") { el = w[1]; if (el === "vertex") H.count = +w[2]; else if (!H.count) before++; }
        else if (w[0] === "property" && el === "vertex") { if (w[1] === "list") throw err("badPly"); H.props.push({ name: w[2].toLowerCase(), t: PLY_T[w[1]] }); }
      });
      if (before) throw err("badPly");
      var o = 0; H.props.forEach(function (p) { if (!p.t) throw err("badPly"); p.o = o; o += p.t[0]; });
      H.recLen = o;
      function idx(names) { for (var j = 0; j < H.props.length; j++) if (names.indexOf(H.props[j].name) >= 0) return j; return -1; }
      H.ix = idx(["x"]); H.iy = idx(["y"]); H.iz = idx(["z"]);
      H.ir = idx(["red", "r", "diffuse_red"]); H.ig = idx(["green", "g", "diffuse_green"]); H.ib = idx(["blue", "b", "diffuse_blue"]);
      H.ii = idx(["intensity", "scalar_intensity", "reflectance", "scalar_reflectance"]);
      H.ic = idx(["classification", "scalar_classification", "class"]);
      if (H.ix < 0 || H.iy < 0 || H.iz < 0) throw err("badPly");
      H.hasRGB = H.ir >= 0 && H.ig >= 0 && H.ib >= 0;
      H.hasI = H.ii >= 0;
      return H;
    });
  }
  function iterPLY(s, H, onBatch, onProg) {
    if (H.fmt === "ascii") return iterText(s, H, onBatch, onProg, H.offData);
    var le = H.fmt === "binary_little_endian", L = H.recLen, per = Math.max(1, Math.floor(CHUNK / L)), done = 0, total = H.count, P = H.props;
    function g(dv, o, p) { return dv["get" + p.t[1]](o + p.o, le); }
    function step() {
      if (done >= total) return Promise.resolve();
      var n = Math.min(per, total - done);
      return s.read(H.offData + done * L, n * L).then(function (u8) {
        n = Math.min(n, Math.floor(u8.length / L)); if (!n) { done = total; return; }
        var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), pos = 0;
        while (pos < n) {
          var m = Math.min(BATCH, n - pos), B = Batch(m, 0);
          for (var k = 0; k < m; k++) {
            var o = (pos + k) * L, j = B.n++;
            B.x[j] = g(dv, o, P[H.ix]); B.y[j] = g(dv, o, P[H.iy]); B.z[j] = g(dv, o, P[H.iz]);
            if (H.hasRGB) { B.r[j] = g(dv, o, P[H.ir]); B.g[j] = g(dv, o, P[H.ig]); B.b[j] = g(dv, o, P[H.ib]); }
            if (H.hasI) B.i[j] = clampI(g(dv, o, P[H.ii]));
            if (H.ic >= 0) B.c[j] = g(dv, o, P[H.ic]) & 255;
          }
          pos += m; if (onBatch(B) === false) { done = total; return; }
        }
        done += n; if (onProg) onProg(done / total);
        return tick().then(step);
      });
    }
    return step();
  }
  function clampI(v) { if (!(v >= 0)) return 0; if (v <= 1 && v % 1) return Math.round(v * 65535); return v > 65535 ? 65535 : Math.round(v); }

  /* ---------- text: XYZ / PTS / TXT / CSV / ASCII PLY ---------- */
  function textHeader(s) {
    return s.read(0, Math.min(s.size, 262144)).then(function (u8) {
      var txt = new TextDecoder().decode(u8), lines = txt.split(/\r?\n/).slice(0, 60), H = { kind: "text", offData: 0, crs: {}, count: 0 };
      var sample = [], ptsCount = 0;
      for (var i = 0; i < lines.length - 1; i++) {
        var w = splitLine(lines[i]);
        if (!w.length) continue;
        if (i === 0 && w.length === 1 && /^\d+$/.test(w[0])) { ptsCount = +w[0]; continue; }
        if (w.slice(0, 3).some(function (v) { return !isNum(v); })) { if (!sample.length) H.headerLine = lines[i]; continue; }
        sample.push(w.map(Number));
      }
      if (!sample.length || sample[0].length < 3) throw err("badText");
      var nc = sample[0].length, allInt = function (col) { return sample.every(function (r) { return r[col] === undefined || (r[col] % 1 === 0 && r[col] >= 0 && r[col] <= 65535); }); };
      var map = { x: 0, y: 1, z: 2, i: -1, r: -1, g: -1, b: -1 };
      var hdr = (H.headerLine || "").toLowerCase();
      if (hdr) {
        var hw = splitLine(hdr), f = function (re) { for (var q = 0; q < hw.length; q++) if (re.test(hw[q])) return q; return -1; };
        var hx = f(/^(x|east|easting|e)$/), hy = f(/^(y|north|northing|n)$/), hz = f(/^(z|elev|elevation|h|height)$/);
        if (hx >= 0 && hy >= 0 && hz >= 0) { map.x = hx; map.y = hy; map.z = hz; }
        map.i = f(/intens|reflect/); map.r = f(/^(r|red)$/); map.g = f(/^(g|green)$/); map.b = f(/^(b|blue)$/);
      } else if (nc >= 7) { map.i = 3; map.r = 4; map.g = 5; map.b = 6; }
      else if (nc === 6 && allInt(3) && allInt(4) && allInt(5)) { map.r = 3; map.g = 4; map.b = 5; }
      else if (nc === 4 || nc === 5) { map.i = 3; }
      if (nc >= 5 && sample.every(function (r) { return r[0] % 1 === 0; }) && sample.length > 3 && sample[1][0] - sample[0][0] === 1 && !hdr) H.looksLikeSurvey = true;
      H.map = map; H.hasRGB = map.r >= 0 && map.g >= 0 && map.b >= 0; H.hasI = map.i >= 0; H.ptsCount = ptsCount;
      var avg = Math.max(12, (u8.length / Math.max(1, txt.split("\n").length)));
      H.count = ptsCount || Math.round(s.size / avg); H.countIsEstimate = !ptsCount;
      return H;
    });
  }
  function isNum(v) { return v !== "" && !isNaN(+v); }
  function splitLine(l) { l = l.trim(); if (!l) return []; return l.split(/[\s,;]+/); }
  function iterText(s, H, onBatch, onProg, start) {
    var pos = start || 0, rest = "", td = new TextDecoder(), map = H.map || { x: H.ix, y: H.iy, z: H.iz, i: H.ii, r: H.ir, g: H.ig, b: H.ib }, first = !start, stop = false;
    function flush(lines, B) {
      for (var li = 0; li < lines.length; li++) {
        var l = lines[li]; if (!l) continue;
        var w = splitLine(l); if (w.length < 3) continue;
        var x = +w[map.x], y = +w[map.y], z = +w[map.z];
        if (x !== x || y !== y || z !== z) continue;
        if (first && w.length === 1) continue;
        if (B.n === B.x.length) { if (onBatch(B) === false) { stop = true; return B; } B = Batch(BATCH, 0); }
        var j = B.n++; B.x[j] = x; B.y[j] = y; B.z[j] = z;
        if (map.i >= 0) B.i[j] = clampI(+w[map.i] + (H.ptsCount ? 2048 : 0));
        if (map.r >= 0) { B.r[j] = +w[map.r]; B.g[j] = +w[map.g]; B.b[j] = +w[map.b]; }
      }
      return B;
    }
    var B = Batch(BATCH, 0);
    function step() {
      if (pos >= s.size || stop) { if (!stop && rest) B = flush([rest], B); if (!stop && B.n) onBatch(B); return Promise.resolve(); }
      return s.read(pos, CHUNK).then(function (u8) {
        pos += u8.length;
        var txt = rest + td.decode(u8, { stream: pos < s.size }), cut = txt.lastIndexOf("\n");
        if (cut < 0) { rest = txt; } else { rest = txt.slice(cut + 1); B = flush(txt.slice(0, cut).split(/\r?\n/), B); }
        if (onProg) onProg(pos / s.size);
        return tick().then(step);
      });
    }
    return step();
  }

  /* ---------- open any supported file ---------- */
  function open(fileLike) {
    var s = src(fileLike), ext = (s.name.split(".").pop() || "").toLowerCase();
    return s.read(0, 4).then(function (m) {
      var magic = cstr(m, 0, 4);
      var p;
      if (magic === "LASF") p = lasHeader(s);
      else if (magic.slice(0, 3) === "ply") p = plyHeader(s);
      else if (magic === "ASTM" || ext === "e57") return Promise.reject(err("e57Soon"));
      else if (ext === "las" || ext === "laz") return Promise.reject(err("notLas"));
      else p = textHeader(s);
      return p.then(function (H) { H.size = s.size; H.name = s.name; return { s: s, H: H }; });
    });
  }
  function iterate(F, onBatch, onProg, keepRaw) {
    var H = F.H;
    if (H.kind === "las") return iterLAS(F.s, H, onBatch, onProg, keepRaw);
    if (H.kind === "laz") return iterLAZ(F.s, H, onBatch, onProg, keepRaw);
    if (H.kind === "ply") return iterPLY(F.s, H, onBatch, onProg);
    return iterText(F.s, H, onBatch, onProg, 0);
  }

  /* ---------- scan: true bounds, classes, colours, preview sample ---------- */
  function scan(F, onProg, maxPreview) {
    var H = F.H, step = Math.max(1, Math.floor((H.count || 1) / (maxPreview || 300000))), seen = 0;
    var S = { n: 0, min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], cls: new Float64Array(256), rgbMax: 0, iMax: 0, iMin: 65535, prev: { n: 0, x: [], y: [], z: [], i: [], r: [], g: [], b: [], c: [] } };
    return iterate(F, function (B) {
      var P = S.prev;
      for (var j = 0; j < B.n; j++) {
        var x = B.x[j], y = B.y[j], z = B.z[j];
        if (x < S.min[0]) S.min[0] = x; if (x > S.max[0]) S.max[0] = x;
        if (y < S.min[1]) S.min[1] = y; if (y > S.max[1]) S.max[1] = y;
        if (z < S.min[2]) S.min[2] = z; if (z > S.max[2]) S.max[2] = z;
        S.cls[B.c[j]]++;
        var iv = B.i[j]; if (iv > S.iMax) S.iMax = iv; if (iv < S.iMin) S.iMin = iv;
        if (H.hasRGB) { var mx = Math.max(B.r[j], B.g[j], B.b[j]); if (mx > S.rgbMax) S.rgbMax = mx; }
        if (seen++ % step === 0) { P.x.push(x); P.y.push(y); P.z.push(z); P.i.push(iv); P.r.push(B.r[j]); P.g.push(B.g[j]); P.b.push(B.b[j]); P.c.push(B.c[j]); P.n++; }
      }
      S.n += B.n;
    }, onProg).then(function () {
      var P = S.prev; ["x", "y", "z"].forEach(function (k) { P[k] = Float64Array.from(P[k]); });
      ["i", "r", "g", "b"].forEach(function (k) { P[k] = Uint16Array.from(P[k]); }); P.c = Uint8Array.from(P.c);
      S.classes = []; for (var c = 0; c < 256; c++) if (S.cls[c]) S.classes.push([c, S.cls[c]]);
      S.rgb8 = S.rgbMax <= 255; S.hasI = H.kind === "las" || H.kind === "laz" ? S.iMax > 0 : !!H.hasI;
      return S;
    });
  }

  /* ---------- process: crop, class filter, thinning ---------- */
  // opt: {box:[x0,y0,z0,x1,y1,z1]|null, classes:Set|null, spacing:0, mode:"centre"|"low"|"high"|"first", every:1, limit}
  function processCloud(F, S, opt, onProg) {
    var H = F.H, keepRaw = H.kind === "las" || H.kind === "laz", L = H.recLen || 0;
    var cap = opt.limit || 15000000, K = store(Math.min(cap, Math.max(1024, H.count || 1024)), keepRaw ? L : 0);
    var sp = +opt.spacing || 0, mode = opt.mode || "centre", twoD = mode === "low" || mode === "high", box = opt.box, cls = opt.classes, every = Math.max(1, opt.every | 0), cnt = 0;
    var cells = null, ox = S.min[0], oy = S.min[1], oz = S.min[2], nx = 1, ny = 1, nz = 1;
    if (sp > 0) {
      nx = Math.floor((S.max[0] - ox) / sp) + 1; ny = Math.floor((S.max[1] - oy) / sp) + 1; nz = twoD ? 1 : Math.floor((S.max[2] - oz) / sp) + 1;
      if (nx * ny * nz > 9e15) return Promise.reject(err("spacingSmall"));
      cells = new Map();
    }
    var overflow = false, inCount = 0;
    return iterate(F, function (B) {
      for (var j = 0; j < B.n; j++) {
        var x = B.x[j], y = B.y[j], z = B.z[j];
        if (box && (x < box[0] || x > box[3] || y < box[1] || y > box[4] || z < box[2] || z > box[5])) continue;
        if (cls && !cls.has(B.c[j])) continue;
        inCount++;
        if (every > 1 && (cnt++ % every)) continue;
        if (cells) {
          var ix = Math.floor((x - ox) / sp), iy = Math.floor((y - oy) / sp), iz = twoD ? 0 : Math.floor((z - oz) / sp);
          var key = ix + nx * (iy + ny * iz), slot = cells.get(key);
          if (slot === undefined) {
            if (K.n >= cap) { overflow = true; return false; }
            cells.set(key, K.n); put(K, K.n, B, j); K.n++;
          } else if (mode !== "first") {
            var better;
            if (mode === "low") better = z < K.z[slot];
            else if (mode === "high") better = z > K.z[slot];
            else {
              var cx = ox + (ix + 0.5) * sp, cy = oy + (iy + 0.5) * sp, cz = oz + (iz + 0.5) * sp;
              better = sq(x - cx, y - cy, z - cz) < sq(K.x[slot] - cx, K.y[slot] - cy, K.z[slot] - cz);
            }
            if (better) put(K, slot, B, j);
          }
        } else {
          if (K.n >= cap) { overflow = true; return false; }
          put(K, K.n, B, j); K.n++;
        }
      }
    }, onProg, keepRaw).then(function () {
      if (overflow) throw err("tooMany", cap);
      K.inCount = inCount; return K;
    });
  }
  function sq(a, b, c) { return a * a + b * b + c * c; }
  function store(n, L) { return { n: 0, cap: n, L: L, x: new Float64Array(n), y: new Float64Array(n), z: new Float64Array(n), i: new Uint16Array(n), r: new Uint16Array(n), g: new Uint16Array(n), b: new Uint16Array(n), c: new Uint8Array(n), raw: L ? new Uint8Array(n * L) : null }; }
  function grow(K, need) {
    if (need <= K.cap) return;
    var n = Math.max(need, Math.ceil(K.cap * 1.6));
    ["x", "y", "z", "i", "r", "g", "b", "c"].forEach(function (k) { var a = new K[k].constructor(n); a.set(K[k]); K[k] = a; });
    if (K.raw) { var r = new Uint8Array(n * K.L); r.set(K.raw); K.raw = r; }
    K.cap = n;
  }
  function put(K, at, B, j) {
    if (at >= K.cap) grow(K, at + 1);
    K.x[at] = B.x[j]; K.y[at] = B.y[j]; K.z[at] = B.z[j]; K.i[at] = B.i[j]; K.r[at] = B.r[j]; K.g[at] = B.g[j]; K.b[at] = B.b[j]; K.c[at] = B.c[j];
    if (K.raw && B.raw) K.raw.set(B.raw.subarray(j * B.recLen, (j + 1) * B.recLen), at * K.L);
  }

  /* ---------- writers ---------- */
  var CLASS_NAMES = { 0: "never_classified", 1: "unclassified", 2: "ground", 3: "low_vegetation", 4: "medium_vegetation", 5: "high_vegetation", 6: "building", 7: "low_noise", 8: "key_point", 9: "water", 10: "rail", 11: "road_surface", 12: "overlap", 13: "wire_guard", 14: "wire_conductor", 15: "transmission_tower", 16: "wire_connector", 17: "bridge_deck", 18: "high_noise" };
  function className(c) { return CLASS_NAMES[c] || ("class_" + c); }
  function fx(v, d) { return v.toFixed(d); }
  function c8(v, rgb8) { return rgb8 ? v : (v >> 8); }

  // opt: {fmt:"csv"|"xyz"|"dxf"|"las", cols:"xyz"|"xyzi"|"xyzrgb"|"xyzirgb"|"penzd", dec:3, header:true, sep:",", startNo:1, rgb8, layerByClass}
  function write(K, opt, F) {
    if (opt.fmt === "las") return new Blob([writeLAS(K, F)], { type: "application/octet-stream" });
    if (opt.fmt === "dxf") return new Blob(writeDXF(K, opt), { type: "application/dxf" });
    return new Blob(writeText(K, opt), { type: "text/plain" });
  }
  function writeText(K, opt) {
    var d = opt.dec, sep = opt.fmt === "xyz" ? " " : (opt.sep || ","), cols = opt.cols, parts = [], lines = [], rgb8 = opt.rgb8, no = opt.startNo || 1;
    if (opt.header) {
      var h = { xyz: "X,Y,Z", xyzi: "X,Y,Z,Intensity", xyzrgb: "X,Y,Z,R,G,B", xyzirgb: "X,Y,Z,Intensity,R,G,B", xyzc: "X,Y,Z,Class", penzd: "P,E,N,Z,D" }[cols];
      lines.push(h.split(",").join(sep));
    }
    for (var k = 0; k < K.n; k++) {
      var x = fx(K.x[k], d), y = fx(K.y[k], d), z = fx(K.z[k], d), l;
      switch (cols) {
        case "xyzi": l = x + sep + y + sep + z + sep + K.i[k]; break;
        case "xyzrgb": l = x + sep + y + sep + z + sep + c8(K.r[k], rgb8) + sep + c8(K.g[k], rgb8) + sep + c8(K.b[k], rgb8); break;
        case "xyzirgb": l = x + sep + y + sep + z + sep + K.i[k] + sep + c8(K.r[k], rgb8) + sep + c8(K.g[k], rgb8) + sep + c8(K.b[k], rgb8); break;
        case "xyzc": l = x + sep + y + sep + z + sep + K.c[k]; break;
        case "penzd": l = (no + k) + sep + x + sep + y + sep + z + sep + (opt.desc || className(K.c[k])); break;
        default: l = x + sep + y + sep + z;
      }
      lines.push(l);
      if (lines.length >= 50000) { parts.push(lines.join("\r\n") + "\r\n"); lines = []; }
    }
    if (lines.length) parts.push(lines.join("\r\n") + "\r\n");
    return parts;
  }
  var ACI = { 1: 8, 2: 34, 3: 82, 4: 92, 5: 94, 6: 1, 7: 9, 9: 5, 10: 30, 11: 253, 17: 40 };
  function writeDXF(K, opt) {
    var d = opt.dec, byCls = opt.layerByClass, parts = [], layers = {}, k;
    function lname(c) { return byCls ? ("PC_" + className(c).toUpperCase()) : "POINT_CLOUD"; }
    for (k = 0; k < K.n; k++) layers[lname(K.c[k])] = K.c[k];
    var head = ["0", "SECTION", "2", "HEADER", "9", "$ACADVER", "1", "AC1009", "9", "$PDMODE", "70", "0", "0", "ENDSEC", "0", "SECTION", "2", "TABLES", "0", "TABLE", "2", "LAYER", "70", String(Object.keys(layers).length)];
    Object.keys(layers).forEach(function (n) { head.push("0", "LAYER", "2", n, "70", "0", "62", String(byCls ? (ACI[layers[n]] || 7) : 7), "6", "CONTINUOUS"); });
    head.push("0", "ENDTAB", "0", "ENDSEC", "0", "SECTION", "2", "ENTITIES");
    parts.push(head.join("\r\n") + "\r\n");
    var buf = [];
    for (k = 0; k < K.n; k++) {
      buf.push("0\r\nPOINT\r\n8\r\n" + lname(K.c[k]) + "\r\n10\r\n" + fx(K.x[k], d) + "\r\n20\r\n" + fx(K.y[k], d) + "\r\n30\r\n" + fx(K.z[k], d));
      if (buf.length >= 30000) { parts.push(buf.join("\r\n") + "\r\n"); buf = []; }
    }
    if (buf.length) parts.push(buf.join("\r\n") + "\r\n");
    parts.push("0\r\nENDSEC\r\n0\r\nEOF\r\n");
    return parts;
  }
  function writeLAS(K, F) {
    var H = F.H, n = K.n, mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity], k, a;
    for (k = 0; k < n; k++) { var v0 = K.x[k], v1 = K.y[k], v2 = K.z[k];
      if (v0 < mn[0]) mn[0] = v0; if (v0 > mx[0]) mx[0] = v0; if (v1 < mn[1]) mn[1] = v1; if (v1 > mx[1]) mx[1] = v1; if (v2 < mn[2]) mn[2] = v2; if (v2 > mx[2]) mx[2] = v2; }
    if (!n) { mn = [0, 0, 0]; mx = [0, 0, 0]; }
    var fromLas = (H.kind === "las" || H.kind === "laz") && K.raw && H.rawHeader && H.rawHeader.length >= 227;
    var ret = new Float64Array(15), out, dv, hs, L, pf, vl = [], ev = [], nv = 0, ne = 0, o;
    if (fromLas) {
      hs = H.headerSize; pf = H.pf; L = H.recLen;
      H.vlrs.forEach(function (r) { if (r.user !== "laszip encoded") { vl.push(r.raw); nv += r.raw.length; } });
      (H.evlrs || []).forEach(function (r) { ev.push(r.raw); ne += r.raw.length; });
      if (H.vMin < 4) { ev = []; ne = 0; }
      out = new Uint8Array(hs + nv + n * L + ne); dv = new DataView(out.buffer);
      out.set(H.rawHeader.subarray(0, hs), 0);
      o = hs; vl.forEach(function (b) { out.set(b, o); o += b.length; });
      var dataOff = o; out.set(K.raw.subarray(0, n * L), o); o += n * L;
      var evStart = o; ev.forEach(function (b) { out.set(b, o); o += b.length; });
      for (k = 0; k < n; k++) { var rn = pf >= 6 ? (K.raw[k * L + 14] & 15) : (K.raw[k * L + 14] & 7); if (rn >= 1 && rn <= 15) ret[rn - 1]++; }
      out[104] = pf; dv.setUint16(105, L, true); dv.setUint32(96, dataOff, true); dv.setUint32(100, vl.length, true);
      var legacy = pf < 6 && n < 4294967296;
      dv.setUint32(107, legacy ? n : 0, true);
      for (a = 0; a < 5; a++) dv.setUint32(111 + a * 4, legacy ? ret[a] : 0, true);
      if (H.vMin >= 4 && hs >= 375) {
        setU64(dv, 235, ne ? evStart : 0); dv.setUint32(243, ev.length, true);
        setU64(dv, 247, n); for (a = 0; a < 15; a++) setU64(dv, 255 + a * 8, ret[a]);
      }
    } else {
      hs = 227; pf = K.hasRGB ? 2 : 0; L = pf === 2 ? 26 : 20;
      out = new Uint8Array(hs + n * L); dv = new DataView(out.buffer);
      "LASF".split("").forEach(function (c, i) { out[i] = c.charCodeAt(0); });
      out[24] = 1; out[25] = 2;
      "Civil Threaders C3D-CAD".split("").forEach(function (c, i) { out[58 + i] = c.charCodeAt(0); });
      var now = new Date(), doy = Math.floor((now - new Date(now.getFullYear(), 0, 0)) / 864e5);
      dv.setUint16(90, doy, true); dv.setUint16(92, now.getFullYear(), true);
      dv.setUint16(94, hs, true); dv.setUint32(96, hs, true); dv.setUint32(100, 0, true); out[104] = pf; dv.setUint16(105, L, true);
      dv.setUint32(107, n, true); dv.setUint32(111, n, true);
      var sc = 0.001, off = [Math.floor(mn[0]), Math.floor(mn[1]), Math.floor(mn[2])];
      for (a = 0; a < 3; a++) { dv.setFloat64(131 + a * 8, sc, true); dv.setFloat64(155 + a * 8, off[a], true); }
      var rgb16 = !K.rgb8;
      for (k = 0; k < n; k++) {
        o = hs + k * L;
        dv.setInt32(o, Math.round((K.x[k] - off[0]) / sc), true); dv.setInt32(o + 4, Math.round((K.y[k] - off[1]) / sc), true); dv.setInt32(o + 8, Math.round((K.z[k] - off[2]) / sc), true);
        dv.setUint16(o + 12, K.i[k], true); out[o + 14] = 0x09; out[o + 15] = K.c[k] & 31;
        if (pf === 2) { dv.setUint16(o + 20, rgb16 ? K.r[k] : K.r[k] * 257, true); dv.setUint16(o + 22, rgb16 ? K.g[k] : K.g[k] * 257, true); dv.setUint16(o + 24, rgb16 ? K.b[k] : K.b[k] * 257, true); }
      }
    }
    dv.setFloat64(179, mx[0], true); dv.setFloat64(187, mn[0], true); dv.setFloat64(195, mx[1], true); dv.setFloat64(203, mn[1], true); dv.setFloat64(211, mx[2], true); dv.setFloat64(219, mn[2], true);
    return out;
  }
  function setU64(dv, o, v) { dv.setUint32(o, v % 4294967296, true); dv.setUint32(o + 4, Math.floor(v / 4294967296), true); }

  function err(code, a) { var e = new Error(code); e.code = code; e.arg = a; return e; }

  return { _chunks: lazChunkTable, writeLAS: writeLAS, writeText: writeText, writeDXF: writeDXF, open: open, iterate: iterate, scan: scan, process: processCloud, write: write, className: className, err: err, src: src, CLASS_NAMES: CLASS_NAMES, _ArithDec: ArithDec, _IntDec: IntDec };
})();
if (typeof module !== "undefined") module.exports = PC;
