/* Point cloud tools page: interface, 3D viewer, processing and export. Original code by Civil Threaders. */
(function () {
  "use strict";
  var LANGS = [["ar", "العربية"], ["en", "English"], ["es", "Español"], ["pt", "Português"], ["fr", "Français"], ["tr", "Türkçe"], ["ru", "Русский"]];
  var lang = "";
  try { lang = JSON.parse(localStorage.getItem("lang")) || ""; } catch (e) {}
  if (!PC_I18N[lang]) { var nl = (navigator.language || "en").slice(0, 2); lang = PC_I18N[nl] ? nl : "en"; }
  function t(k) { var s = (PC_I18N[lang] && PC_I18N[lang][k]) || PC_I18N.en[k] || k; for (var i = 1; i < arguments.length; i++) s = s.split("{" + (i - 1) + "}").join(arguments[i]); return s; }
  function $(id) { return document.getElementById(id); }
  function el(tag, o, kids) {
    var e = document.createElement(tag); o = o || {};
    if (o.cls) e.className = o.cls; if (o.text != null) e.textContent = o.text; if (o.html) e.innerHTML = o.html;
    Object.keys(o).forEach(function (k) { if (["cls", "text", "html"].indexOf(k) < 0) e.setAttribute(k, o[k]); });
    (kids || []).forEach(function (c) { if (c) e.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return e;
  }
  function clear(e) { while (e.firstChild) e.removeChild(e.firstChild); }
  function num(v, d) { return Number(v).toLocaleString("en-US", { maximumFractionDigits: d == null ? 0 : d, minimumFractionDigits: d == null ? 0 : d }); }
  function bytes(b) { var u = ["B", "KB", "MB", "GB"], i = 0; while (b >= 1024 && i < 3) { b /= 1024; i++; } return num(b, i ? 1 : 0) + " " + u[i]; }
  function toast(msg, bad) { var e = $("toast"); e.textContent = msg; e.className = "pt-toast show" + (bad ? " bad" : ""); clearTimeout(toast.h); toast.h = setTimeout(function () { e.className = "pt-toast"; }, 3600); }
  function pnum(v) { v = String(v || "").trim().replace(/[٠-٩]/g, function (d) { return "٠١٢٣٤٥٦٧٨٩".indexOf(d); }).replace(/٫/g, ".").replace(/,/g, ""); return v === "" ? NaN : +v; }

  // library locations (overridden on the live page)
  PC.lazJs = PC.lazJs || "lib/laz-perf.js";
  PC.lazWasm = PC.lazWasm || "lib/laz-perf.wasm";

  var st = { F: null, S: null, K: null, busy: false, cancel: false, dirty: true, showResult: false };

  /* ---------------- language ---------------- */
  function applyLang() {
    var L = PC_I18N[lang] || PC_I18N.en;
    document.documentElement.lang = lang; document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
    document.title = t("pageTitle");
    var md = document.querySelector('meta[name="description"]'); if (md) md.setAttribute("content", t("metaDesc"));
    document.querySelectorAll("[data-t]").forEach(function (e) { e.textContent = t(e.getAttribute("data-t")); });
    document.querySelectorAll("[data-ta]").forEach(function (e) { e.setAttribute("aria-label", t(e.getAttribute("data-ta"))); });
    void L;
    if (st.S) { renderSummary(); renderClasses(); renderLegend(); renderResult(); }
    unitLabels(); thinHelp(); fmtUi();
  }

  /* ---------------- progress ---------------- */
  function prog(label) {
    $("prog").hidden = false; $("progBar").style.width = "0%"; $("progTxt").textContent = label;
    return function (f) {
      if (st.cancel) throw PC.err("cancelled");
      var p = Math.max(0, Math.min(1, f)); $("progBar").style.width = (p * 100).toFixed(1) + "%"; $("progTxt").textContent = label + " " + Math.round(p * 100) + "%";
    };
  }
  function progDone() { $("prog").hidden = true; st.busy = false; st.cancel = false; setBusy(false); }
  function setBusy(b) { ["runBtn", "dlBtn", "file"].forEach(function (id) { $(id).disabled = b; }); }

  function errMsg(e) {
    var c = e && e.code;
    if (c === "cancelled") return t("cancelled");
    if (c === "tooMany") return t("errTooMany", num(e.arg));
    if (c && PC_I18N.en["err_" + c]) return t("err_" + c);
    console.error(e);
    return t("errGeneric") + (e && e.message ? " (" + e.message + ")" : "");
  }

  /* ---------------- open file ---------------- */
  function openFile(file) {
    if (!file || st.busy) return;
    st.busy = true; setBusy(true); clear($("fileNote"));
    st.F = st.S = st.K = null; st.dirty = true; st.showResult = false;
    document.querySelectorAll(".needs-data").forEach(function (e) { e.hidden = true; });
    var p = prog(t("reading"));
    PC.open(file).then(function (F) {
      st.F = F;
      return PC.scan(F, p, 300000).then(function (S) {
        st.S = S;
        if (!S.n) throw PC.err("empty");
        progDone();
        afterLoad();
      });
    }).catch(function (e) {
      progDone();
      $("fileNote").appendChild(el("div", { cls: "pt-note warn", role: "alert" }, [el("span", { text: errMsg(e) })]));
      $("file").value = "";
    });
  }

  function afterLoad() {
    var F = st.F, S = st.S, H = F.H;
    document.querySelectorAll(".needs-data").forEach(function (e) { e.hidden = false; });
    $("fname").textContent = H.name + " · " + bytes(H.size);
    // crop defaults
    resetCrop();
    // classes
    st.sel = new Set(S.classes.map(function (c) { return c[0]; }));
    // colour default
    var cb = $("colorBy");
    cb.querySelector('[value="rgb"]').disabled = !H.hasRGB;
    cb.querySelector('[value="i"]').disabled = !S.hasI;
    cb.querySelector('[value="c"]').disabled = S.classes.length < 2;
    cb.value = H.hasRGB ? "rgb" : (S.classes.length > 1 ? "c" : "z");
    // export defaults
    var base = H.name.replace(/\.[^.]+$/, "");
    $("outName").value = base + "_out";
    var cols = $("cols");
    cols.querySelector('[value="xyzi"]').disabled = !S.hasI;
    cols.querySelector('[value="xyzrgb"]').disabled = !H.hasRGB;
    cols.querySelector('[value="xyzirgb"]').disabled = !(H.hasRGB && S.hasI);
    cols.querySelector('[value="xyzc"]').disabled = S.classes.length < 2;
    cols.value = "xyz";
    // spacing suggestion: aim for ~ 1-3M points
    var area = Math.max(1e-9, (S.max[0] - S.min[0]) * (S.max[1] - S.min[1]));
    var sp = Math.sqrt(area / Math.min(S.n, 2000000)); var nice = [0.01, 0.02, 0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10];
    var pick = nice.filter(function (v) { return v >= sp; })[0] || 10;
    $("spacing").value = String(pick);
    $("thinMode").value = S.n > 300000 ? "centre" : "none";
    unitLabels(); thinHelp(); fmtUi();
    renderSummary(); renderClasses(); clear($("result"));
    view.setData(S.prev); view.fit(); renderLegend();
    $("drop").scrollIntoView ? null : null;
  }

  function unitName() {
    var u = st.F && st.F.H.crs && st.F.H.crs.unit;
    return u ? t("u_" + u) : t("u_file");
  }
  function unitLabels() { document.querySelectorAll(".pc-unit").forEach(function (e) { e.textContent = unitName(); }); }

  function renderSummary() {
    var F = st.F, S = st.S, H = F.H, sb = $("stats"); clear(sb);
    function stat(k, v, wide) { sb.appendChild(el("div", { cls: "pt-stat" + (wide ? " pc-wide" : "") }, [el("b", { text: v, dir: "auto" }), el("span", { text: t(k) })])); }
    var fmt = H.kind === "las" || H.kind === "laz" ? (H.kind.toUpperCase() + " " + H.vMaj + "." + H.vMin + " · PDRF " + H.pf) : H.kind === "ply" ? "PLY " + (H.fmt === "ascii" ? "ASCII" : "binary") : t("textFile");
    stat("stPoints", num(S.n)); stat("stFormat", fmt);
    var dx = S.max[0] - S.min[0], dy = S.max[1] - S.min[1], u = (H.crs && H.crs.unit) || "";
    stat("stExtent", num(dx, dx < 100 ? 2 : 1) + " × " + num(dy, dy < 100 ? 2 : 1) + (u && u !== "deg" ? " " + t("us_" + u) : ""));
    stat("stZ", num(S.min[2], 2) + " … " + num(S.max[2], 2));
    if (u !== "deg" && dx * dy > 0) stat("stDensity", num(S.n / (dx * dy), S.n / (dx * dy) < 10 ? 2 : 0) + " / " + (u ? t("us_" + u) + "²" : t("u2_file")));
    var crs = H.crs || {}, cname = crs.epsg ? "EPSG:" + crs.epsg + (crs.name ? " · " + crs.name : "") : (crs.name || t("crsNone"));
    stat("stCrs", cname, true);
    stat("stAttrs", [H.hasRGB ? t("aRgb") : "", S.hasI ? t("aI") : "", S.classes.length > 1 ? t("aCls") : ""].filter(Boolean).join(" · ") || "—", true);
    var nb = $("notes"); clear(nb);
    function note(k, warn, a) { nb.appendChild(el("div", { cls: "pt-note " + (warn ? "warn" : "ok") }, [el("span", { text: t(k, a) })])); }
    if (!crs.epsg && !crs.name) note("nCrs", true);
    if (H.kind === "text" && H.looksLikeSurvey) note("nSurvey", true);
    if (!(H.crs && H.crs.unit)) note("nUnits", false);
    if (S.n > 300000) note("nSample", false, num(S.prev.n));
  }

  var CLS_COL = { 0: "#9aa5ad", 1: "#c9d1d6", 2: "#c8913a", 3: "#9ad16f", 4: "#5fb34f", 5: "#2e8b3a", 6: "#e0614f", 7: "#ff4fd8", 8: "#ffffff", 9: "#3d8bfd", 10: "#a07de0", 11: "#8c8c8c", 12: "#ffd166", 13: "#f5c518", 14: "#f5a518", 15: "#e07b18", 16: "#e0b318", 17: "#d4a017", 18: "#ff2fa8" };
  function clsColor(c) { if (CLS_COL[c]) return CLS_COL[c]; var h = (c * 47) % 360; return "hsl(" + h + ",65%,60%)"; }
  function clsName(c) { var k = "cl" + c; return PC_I18N.en[k] ? t(k) : t("clN", c); }

  function renderClasses() {
    var S = st.S, box = $("clsSummary"), list = $("clsList"); clear(box); clear(list);
    var multi = S.classes.length > 1;
    $("clsTool").hidden = !multi;
    if (multi) S.classes.forEach(function (c) {
      box.appendChild(el("span", {}, [el("i", { style: "background:" + clsColor(c[0]) }), clsName(c[0]) + " · " + num(c[1])]));
      var cbx = el("input", { type: "checkbox" }); cbx.checked = st.sel.has(c[0]);
      cbx.onchange = function () { if (cbx.checked) st.sel.add(c[0]); else st.sel.delete(c[0]); st.dirty = true; view.draw(); };
      list.appendChild(el("label", { cls: "pt-code" }, [cbx, el("i", { cls: "pc-sw", style: "background:" + clsColor(c[0]) }), clsName(c[0]), el("small", { text: num(c[1]) })]));
    });
    $("clsGround").hidden = !S.classes.some(function (c) { return c[0] === 2; });
  }

  /* ---------------- crop ---------------- */
  var CROP = ["x0", "y0", "z0", "x1", "y1", "z1"];
  function resetCrop() {
    var S = st.S; if (!S) return;
    var d = [S.min[0], S.min[1], S.min[2], S.max[0], S.max[1], S.max[2]];
    CROP.forEach(function (id, i) { $(id).value = d[i].toFixed(i % 3 === 2 ? 2 : 3); });
    st.dirty = true; if (view.ready) view.draw();
  }
  function cropBox() {
    var S = st.S, v = CROP.map(function (id) { return pnum($(id).value); });
    var full = [S.min[0], S.min[1], S.min[2], S.max[0], S.max[1], S.max[2]];
    var any = false;
    for (var i = 0; i < 6; i++) { if (!isFinite(v[i])) v[i] = full[i]; if (Math.abs(v[i] - full[i]) > 1e-6 * Math.max(1, Math.abs(full[i])) + 1e-4) any = true; }
    for (var a = 0; a < 3; a++) if (v[a] > v[a + 3]) { var tmp = v[a]; v[a] = v[a + 3]; v[a + 3] = tmp; }
    return any ? v : null;
  }

  /* ---------------- thinning help ---------------- */
  function thinHelp() {
    var m = $("thinMode").value;
    $("spWrap").hidden = m === "none" || m === "every"; $("evWrap").hidden = m !== "every";
    $("thinHelp").textContent = t("th_" + m + "_help");
  }

  /* ---------------- run ---------------- */
  function options() {
    var m = $("thinMode").value, o = { box: cropBox(), classes: null, spacing: 0, mode: "centre", every: 1 };
    if (st.S.classes.length > 1 && st.sel.size < st.S.classes.length) o.classes = new Set(st.sel);
    if (m === "every") o.every = Math.max(1, Math.round(pnum($("everyN").value)) || 1);
    else if (m !== "none") {
      o.mode = m; o.spacing = pnum($("spacing").value);
      if (!(o.spacing > 0)) throw PC.err("spacing");
    }
    return o;
  }
  function run() {
    if (!st.F || st.busy) return Promise.reject(PC.err("busy"));
    var o;
    try { o = options(); } catch (e) { toast(errMsg(e), true); return Promise.reject(e); }
    if (o.classes && !o.classes.size) { toast(t("err_noClass"), true); return Promise.reject(PC.err("noClass")); }
    st.busy = true; setBusy(true);
    var p = prog(t("working"));
    var t0 = Date.now();
    return PC.process(st.F, st.S, o, p).then(function (K) {
      K.hasRGB = st.F.H.hasRGB; K.rgb8 = st.S.rgb8; K.secs = (Date.now() - t0) / 1000;
      st.K = K; st.dirty = false; progDone();
      renderResult();
      // show the result in the viewer
      var step = Math.max(1, Math.floor(K.n / 300000)), P = { n: 0, x: [], y: [], z: [], i: [], r: [], g: [], b: [], c: [] };
      for (var k = 0; k < K.n; k += step) { P.x.push(K.x[k]); P.y.push(K.y[k]); P.z.push(K.z[k]); P.i.push(K.i[k]); P.r.push(K.r[k]); P.g.push(K.g[k]); P.b.push(K.b[k]); P.c.push(K.c[k]); P.n++; }
      st.resPrev = P; st.showResult = true; view.setData(P); renderLegend(); srcBtn();
      fmtUi();
      return K;
    }).catch(function (e) { progDone(); toast(errMsg(e), true); throw e; });
  }
  function renderResult() {
    var r = $("result"); clear(r); var K = st.K; if (!K) return;
    var pct = st.S.n ? (K.n / st.S.n * 100) : 0;
    r.appendChild(el("div", { cls: "pc-res" }, [el("b", { text: num(K.n), dir: "ltr" }), " ", el("span", { text: t("resPts", num(pct, pct < 1 ? 2 : 1), num(st.S.n)) })]));
  }
  function srcBtn() { var b = $("vSrc"); if (!b) return; b.hidden = !st.K; b.textContent = st.showResult ? t("showOrig") : t("showRes"); }

  /* ---------------- export ---------------- */
  function fmt() { var f = document.querySelector('input[name="fmt"]:checked'); return f ? f.value : "csv"; }
  function fmtUi() {
    var f = fmt();
    $("colsWrap").hidden = f === "dxf" || f === "las"; $("decWrap").hidden = f === "las"; $("headWrap").hidden = !(f === "csv" || f === "xyz");
    $("dxfClsWrap").hidden = !(f === "dxf" && st.S && st.S.classes.length > 1);
    $("fmtHelp").textContent = t("fh_" + f) + (f === "las" && st.F && st.F.H.kind === "laz" ? " " + t("fh_lasFromLaz") : "");
    var n = st.K && !st.dirty ? st.K.n : null, w = $("bigWarn");
    var big = n != null && ((f === "dxf" && n > 1000000) || (f !== "las" && $("cols").value === "penzd" && n > 200000));
    w.hidden = !big; if (big) w.textContent = t(f === "dxf" ? "wBigDxf" : "wBigPenzd", num(n));
    $("dlCount").textContent = n != null ? t("dlCount", num(n)) : (st.S ? t("dlWillRun") : "");
  }
  function download() {
    if (!st.F || st.busy) return;
    var go = st.K && !st.dirty ? Promise.resolve(st.K) : run();
    go.then(function (K) {
      if (!K.n) { toast(t("err_emptyResult"), true); return; }
      var f = fmt(), name = ($("outName").value.trim() || "point-cloud").replace(/[\\/:*?"<>|]+/g, "_");
      var ext = { csv: ".csv", xyz: ".xyz", dxf: ".dxf", las: ".las" }[f];
      if (!new RegExp("\\" + ext + "$", "i").test(name)) name += ext;
      $("dlCount").textContent = t("preparing");
      setTimeout(function () {
        try {
          var blob = PC.write(K, { fmt: f, cols: $("cols").value, dec: +$("dec").value, header: $("outHead").checked, rgb8: st.S.rgb8, layerByClass: $("dxfCls").checked }, st.F);
          var a = el("a", { href: URL.createObjectURL(blob), download: name }); document.body.appendChild(a); a.click(); a.remove();
          setTimeout(function () { URL.revokeObjectURL(a.href); }, 60000);
          toast(t("saved", name, bytes(blob.size)));
        } catch (e) { toast(errMsg(e), true); }
        fmtUi();
      }, 30);
    }).catch(function () {});
  }

  /* ---------------- 3D viewer (canvas, orthographic) ---------------- */
  var view = (function () {
    var cv = $("view"), ctx = cv.getContext("2d"), wrap = $("viewWrap");
    var D = null, cols = null, n = 0, cx = 0, cy = 0, cz = 0, diag = 1;
    var yaw = -0.5, tilt = 0.95, zoom = 1, panX = 0, panY = 0, img = null, depth = null, W = 0, H = 0, dpr = 1, raf = 0;
    var selecting = false, sel0 = null;
    function size() {
      dpr = Math.min(2, window.devicePixelRatio || 1);
      var r = cv.getBoundingClientRect(), w = Math.max(50, Math.round(r.width * dpr)), h = Math.max(50, Math.round(r.height * dpr));
      if (w !== W || h !== H) { W = cv.width = w; H = cv.height = h; img = ctx.createImageData(W, H); depth = new Float32Array(W * H); }
    }
    function setData(P) {
      n = P.n; D = { x: new Float32Array(n), y: new Float32Array(n), z: new Float32Array(n), src: P };
      var S = st.S; cx = (S.min[0] + S.max[0]) / 2; cy = (S.min[1] + S.max[1]) / 2; cz = (S.min[2] + S.max[2]) / 2;
      diag = Math.max(1e-9, Math.hypot(S.max[0] - S.min[0], S.max[1] - S.min[1], S.max[2] - S.min[2]));
      for (var k = 0; k < n; k++) { D.x[k] = P.x[k] - cx; D.y[k] = P.y[k] - cy; D.z[k] = P.z[k] - cz; }
      colour(); api.ready = true; draw();
    }
    function pct(arr, a, b) {
      var m = Math.min(arr.length, 20000), s = new Float64Array(m), step = Math.max(1, Math.floor(arr.length / m));
      for (var i = 0; i < m; i++) s[i] = arr[i * step] || 0; s.sort();
      return [s[Math.floor(m * a)] || 0, s[Math.min(m - 1, Math.floor(m * b))] || 1];
    }
    function hex(c) {
      if (c[0] === "#") return [parseInt(c.substr(1, 2), 16), parseInt(c.substr(3, 2), 16), parseInt(c.substr(5, 2), 16)];
      var m = /hsl\((\d+),(\d+)%,(\d+)%\)/.exec(c), h = +m[1] / 360, s = +m[2] / 100, l = +m[3] / 100;
      function f(p, q, t2) { if (t2 < 0) t2 += 1; if (t2 > 1) t2 -= 1; if (t2 < 1 / 6) return p + (q - p) * 6 * t2; if (t2 < 1 / 2) return q; if (t2 < 2 / 3) return p + (q - p) * (2 / 3 - t2) * 6; return p; }
      var q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q; return [f(p, q, h + 1 / 3) * 255, f(p, q, h) * 255, f(p, q, h - 1 / 3) * 255];
    }
    var RAMP = [[44, 123, 182], [0, 166, 202], [0, 204, 188], [144, 235, 157], [255, 255, 140], [249, 208, 87], [242, 158, 46], [231, 104, 38], [215, 25, 28]];
    function ramp(f) { f = Math.max(0, Math.min(1, f)) * (RAMP.length - 1); var i = Math.floor(f), u = f - i, a = RAMP[i], b = RAMP[Math.min(RAMP.length - 1, i + 1)]; return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u]; }
    function colour() {
      if (!D) return; var P = D.src, mode = $("colorBy").value; cols = new Uint32Array(n);
      var zr = pct(P.z, 0.02, 0.98), ir = pct(P.i, 0.02, 0.98), sh = st.S.rgb8 ? 0 : 8, cc = {};
      api.zr = zr;
      for (var k = 0; k < n; k++) {
        var c;
        if (mode === "rgb") c = [P.r[k] >> sh, P.g[k] >> sh, P.b[k] >> sh];
        else if (mode === "i") { var v = (P.i[k] - ir[0]) / Math.max(1e-9, ir[1] - ir[0]); v = Math.max(0, Math.min(1, v)) * 235 + 20; c = [v, v, v]; }
        else if (mode === "c") { var q = P.c[k]; c = cc[q] || (cc[q] = hex(clsColor(q))); }
        else c = ramp((P.z[k] - zr[0]) / Math.max(1e-9, zr[1] - zr[0]));
        cols[k] = (255 << 24 | (c[2] & 255) << 16 | (c[1] & 255) << 8 | (c[0] & 255)) >>> 0;
      }
    }
    function draw() { if (!raf) raf = requestAnimationFrame(render); }
    var fitS = 0;
    function scale() { return zoom * (fitS || 0.92 * Math.min(W, H) / diag); }
    function computeFit() {
      size(); var S = st.S; if (!S) return;
      var cyw = Math.cos(yaw), syw = Math.sin(yaw), ct = Math.cos(tilt), stl = Math.sin(tilt), mx = 0, my = 0;
      for (var i = 0; i < 8; i++) {
        var x = (i & 1 ? S.max[0] : S.min[0]) - cx, y = (i & 2 ? S.max[1] : S.min[1]) - cy, z = (i & 4 ? S.max[2] : S.min[2]) - cz;
        var x1 = x * cyw - y * syw, y1 = x * syw + y * cyw; mx = Math.max(mx, Math.abs(x1)); my = Math.max(my, Math.abs(y1 * ct + z * stl));
      }
      fitS = Math.min((W * 0.46) / Math.max(1e-9, mx), (H * 0.42) / Math.max(1e-9, my));
    }
    function render() {
      raf = 0; if (!D) return; size();
      var buf = new Uint32Array(img.data.buffer); buf.fill(0xFF201A14); depth.fill(Infinity);
      var cyw = Math.cos(yaw), syw = Math.sin(yaw), ct = Math.cos(tilt), stl = Math.sin(tilt), s = scale(), hx = W / 2 + panX, hy = H / 2 + panY;
      var ps = Math.max(1, Math.round(dpr * (n > 150000 ? 1 : n > 40000 ? 1.5 : 2.2)));
      var box = st.S && !st.showResult ? cropBox() : null, cls = st.S && !st.showResult && st.S.classes.length > 1 && st.sel.size < st.S.classes.length ? st.sel : null, P = D.src;
      for (var k = 0; k < n; k++) {
        var px = D.x[k], py = D.y[k], pz = D.z[k];
        var x1 = px * cyw - py * syw, y1 = px * syw + py * cyw;
        var X = (hx + x1 * s) | 0, Y = (hy - (y1 * ct + pz * stl) * s) | 0;
        if (X < 0 || Y < 0 || X >= W - ps + 1 || Y >= H - ps + 1) continue;
        var d = y1 * stl - pz * ct, col = cols[k];
        if ((box && (P.x[k] < box[0] || P.x[k] > box[3] || P.y[k] < box[1] || P.y[k] > box[4] || P.z[k] < box[2] || P.z[k] > box[5])) || (cls && !cls.has(P.c[k]))) {
          col = (0xFF000000 | ((col >> 2) & 0x3F3F3F)) >>> 0; d += diag * 0.001;
        }
        for (var a = 0; a < ps; a++) { var row = (Y + a) * W + X; for (var b = 0; b < ps; b++) { var ix = row + b; if (d < depth[ix]) { depth[ix] = d; buf[ix] = col; } } }
      }
      ctx.putImageData(img, 0, 0);
      if (box) drawBox(box, cyw, syw, ct, stl, s, hx, hy);
      var ang = Math.atan2(-syw, cyw * ct || 1e-6) * 180 / Math.PI;
      $("north").style.transform = "rotate(" + ang.toFixed(1) + "deg)";
    }
    function proj(x, y, z, cyw, syw, ct, stl, s, hx, hy) { x -= cx; y -= cy; z -= cz; var x1 = x * cyw - y * syw, y1 = x * syw + y * cyw; return [hx + x1 * s, hy - (y1 * ct + z * stl) * s]; }
    function drawBox(b, cyw, syw, ct, stl, s, hx, hy) {
      var c = [], i; for (i = 0; i < 8; i++) c.push(proj(i & 1 ? b[3] : b[0], i & 2 ? b[4] : b[1], i & 4 ? b[5] : b[2], cyw, syw, ct, stl, s, hx, hy));
      var E = [[0, 1], [1, 3], [3, 2], [2, 0], [4, 5], [5, 7], [7, 6], [6, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
      ctx.strokeStyle = "#f5c518"; ctx.lineWidth = 1.5 * dpr; ctx.beginPath();
      E.forEach(function (e) { ctx.moveTo(c[e[0]][0], c[e[0]][1]); ctx.lineTo(c[e[1]][0], c[e[1]][1]); }); ctx.stroke();
    }
    function fit() { zoom = 1; panX = panY = 0; computeFit(); draw(); }
    function setView(v) {
      if (v === "top") { yaw = 0; tilt = 0; } else { yaw = -0.5; tilt = 0.95; }
      fit(); vbtns();
    }
    function vbtns() { $("vTop").classList.toggle("on", tilt === 0 && yaw === 0); $("v3d").classList.toggle("on", !(tilt === 0 && yaw === 0)); $("vSel").classList.toggle("on", selecting); wrap.classList.toggle("selecting", selecting); }
    function startSelect() { if (st.showResult && st.K) { st.showResult = false; setData(st.S.prev); srcBtn(); renderLegend(); } selecting = true; yaw = 0; tilt = 0; fit(); vbtns(); toast(t("selHint")); }

    // pointer handling: drag rotate, shift/right/two-finger pan, wheel/pinch zoom, rectangle select in top view
    var ptrs = {}, last = null, pinch = null;
    function devXY(e) { var r = cv.getBoundingClientRect(); return [(e.clientX - r.left) * dpr, (e.clientY - r.top) * dpr, e.clientX - r.left, e.clientY - r.top]; }
    cv.addEventListener("contextmenu", function (e) { e.preventDefault(); });
    cv.addEventListener("pointerdown", function (e) {
      cv.setPointerCapture(e.pointerId); ptrs[e.pointerId] = devXY(e);
      var ids = Object.keys(ptrs);
      if (selecting && ids.length === 1) { sel0 = devXY(e); var sb = $("selBox"); sb.hidden = false; sb.style.left = sel0[2] + "px"; sb.style.top = sel0[3] + "px"; sb.style.width = sb.style.height = "0px"; return; }
      if (ids.length === 2) { var a = ptrs[ids[0]], b = ptrs[ids[1]]; pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), z: zoom, m: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] }; sel0 = null; $("selBox").hidden = true; }
      last = { x: e.clientX, y: e.clientY, pan: e.shiftKey || e.button === 2 };
    });
    cv.addEventListener("pointermove", function (e) {
      if (!ptrs[e.pointerId]) return; ptrs[e.pointerId] = devXY(e);
      var ids = Object.keys(ptrs);
      if (sel0 && selecting) { var p = devXY(e), sb = $("selBox"); sb.style.left = Math.min(sel0[2], p[2]) + "px"; sb.style.top = Math.min(sel0[3], p[3]) + "px"; sb.style.width = Math.abs(p[2] - sel0[2]) + "px"; sb.style.height = Math.abs(p[3] - sel0[3]) + "px"; return; }
      if (ids.length === 2 && pinch) {
        var a = ptrs[ids[0]], b = ptrs[ids[1]], d = Math.hypot(a[0] - b[0], a[1] - b[1]), m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        zoomAt(pinch.m[0], pinch.m[1], pinch.z * d / Math.max(1, pinch.d) / zoom); panX += m[0] - pinch.m[0]; panY += m[1] - pinch.m[1]; pinch.m = m; pinch.z = zoom; pinch.d = d; draw(); return;
      }
      if (!last) return;
      var dx = e.clientX - last.x, dy = e.clientY - last.y; last.x = e.clientX; last.y = e.clientY;
      if (last.pan || selecting) { panX += dx * dpr; panY += dy * dpr; }
      else { yaw += dx * 0.008; tilt = Math.max(0, Math.min(1.5, tilt + dy * 0.006)); vbtns(); }
      draw();
    });
    function up(e) {
      if (sel0 && selecting && ptrs[e.pointerId]) {
        var p = devXY(e); $("selBox").hidden = true;
        if (Math.abs(p[0] - sel0[0]) > 8 && Math.abs(p[1] - sel0[1]) > 8) {
          var s = scale(), hx = W / 2 + panX, hy = H / 2 + panY;
          var xa = (Math.min(p[0], sel0[0]) - hx) / s + cx, xb = (Math.max(p[0], sel0[0]) - hx) / s + cx;
          var ya = -(Math.max(p[1], sel0[1]) - hy) / s + cy, yb = -(Math.min(p[1], sel0[1]) - hy) / s + cy;
          $("x0").value = xa.toFixed(3); $("x1").value = xb.toFixed(3); $("y0").value = ya.toFixed(3); $("y1").value = yb.toFixed(3);
          $("cropTool").open = true; st.dirty = true; fmtUi(); toast(t("selDone"));
          selecting = false; vbtns();
        }
        sel0 = null;
      }
      delete ptrs[e.pointerId]; if (Object.keys(ptrs).length < 2) pinch = null; if (!Object.keys(ptrs).length) last = null;
      draw();
    }
    cv.addEventListener("pointerup", up); cv.addEventListener("pointercancel", up);
    function zoomAt(mx, my, f) { var nz = Math.max(0.2, Math.min(400, zoom * f)); f = nz / zoom; panX = mx - (mx - (W / 2 + panX)) * f - W / 2; panY = my - (my - (H / 2 + panY)) * f - H / 2; zoom = nz; }
    cv.addEventListener("wheel", function (e) { e.preventDefault(); var p = devXY(e); zoomAt(p[0], p[1], Math.exp(-e.deltaY * 0.0015)); draw(); }, { passive: false });
    window.addEventListener("resize", draw);
    var api = { setData: setData, draw: draw, fit: fit, setView: setView, startSelect: startSelect, colour: function () { colour(); draw(); }, ready: false, zr: [0, 1] };
    return api;
  })();

  function renderLegend() {
    var lg = $("legend"); clear(lg); if (!st.S) return;
    var m = $("colorBy").value;
    if (m === "z") { var zr = view.zr; lg.appendChild(el("span", {}, [num(zr[0], 1), el("i", { cls: "ramp", style: "background:linear-gradient(90deg,#2c7bb6,#00a6ca,#00ccbc,#90eb9d,#ffff8c,#f9d057,#f29e2e,#e76826,#d7191c)" }), num(zr[1], 1)])); }
    else if (m === "c") st.S.classes.slice(0, 10).forEach(function (c) { lg.appendChild(el("span", {}, [el("i", { cls: "pc-sw", style: "background:" + clsColor(c[0]) }), clsName(c[0])])); });
  }

  /* ---------------- wiring ---------------- */
  function init() {
    var ls = $("langSel");
    LANGS.forEach(function (l) { var o = el("option", { value: l[0], text: l[1] }); ls.appendChild(o); });
    ls.value = lang;
    ls.onchange = function () { lang = ls.value; try { localStorage.setItem("lang", JSON.stringify(lang)); } catch (e) {} applyLang(); };
    var vb = document.querySelector(".pc-vbtns"), srcB = el("button", { type: "button", cls: "pc-vb", id: "vSrc" }); srcB.hidden = true; vb.appendChild(srcB);
    srcB.onclick = function () { if (!st.K) return; st.showResult = !st.showResult; view.setData(st.showResult ? st.resPrev : st.S.prev); renderLegend(); srcBtn(); };
    applyLang();
    $("file").onchange = function () { openFile(this.files[0]); };
    var drop = $("drop");
    ["dragenter", "dragover"].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add("over"); }); });
    ["dragleave", "drop"].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove("over"); }); });
    drop.addEventListener("drop", function (e) { var f = e.dataTransfer && e.dataTransfer.files[0]; if (f) openFile(f); });
    $("cancelBtn").onclick = function () { st.cancel = true; };
    $("colorBy").onchange = function () { view.colour(); renderLegend(); };
    $("v3d").onclick = function () { view.setView("3d"); };
    $("vTop").onclick = function () { view.setView("top"); };
    $("vFit").onclick = function () { view.fit(); };
    $("vSel").onclick = function () { view.startSelect(); };
    $("cropDraw").onclick = function () { $("viewWrap").scrollIntoView({ behavior: "smooth", block: "center" }); view.startSelect(); };
    $("cropReset").onclick = function () { resetCrop(); fmtUi(); };
    CROP.forEach(function (id) { $(id).addEventListener("input", function () { st.dirty = true; view.draw(); fmtUi(); }); });
    $("clsAll").onclick = function () { st.sel = new Set(st.S.classes.map(function (c) { return c[0]; })); renderClasses(); st.dirty = true; view.draw(); fmtUi(); };
    $("clsGround").onclick = function () { st.sel = new Set([2]); renderClasses(); st.dirty = true; view.draw(); fmtUi(); };
    $("thinMode").onchange = function () { thinHelp(); st.dirty = true; fmtUi(); };
    ["spacing", "everyN"].forEach(function (id) { $(id).addEventListener("input", function () { st.dirty = true; fmtUi(); }); });
    $("runBtn").onclick = function () { run().catch(function () {}); };
    document.querySelectorAll('input[name="fmt"]').forEach(function (r) { r.onchange = function () { if (fmt() === "xyz") $("outHead").checked = false; else if (fmt() === "csv") $("outHead").checked = true; fmtUi(); }; });
    $("cols").onchange = fmtUi;
    $("dlBtn").onclick = download;
    window.addEventListener("beforeunload", function (e) { if (st.busy) { e.preventDefault(); e.returnValue = ""; } });
  }
  init();
})();
