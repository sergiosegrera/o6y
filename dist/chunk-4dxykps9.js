#!/usr/bin/env node
import {
  outgoing
} from "./chunk-9q7vjba0.js";

// src/core/graph.ts
var BODY_MAX = 4000;
var date = (v) => v instanceof Date ? v.toISOString().slice(0, 10) : typeof v === "string" ? v : undefined;
function graphData(store) {
  const links = [];
  const degree = new Map;
  const bump = (id) => degree.set(id, (degree.get(id) ?? 0) + 1);
  for (const obj of store.objects.values()) {
    for (const target of outgoing(obj).keys()) {
      links.push({ source: obj.id, target });
      bump(obj.id);
      bump(target);
    }
  }
  const nodes = [...store.objects.values()].map((o) => {
    const managed = o.data.o6y;
    return {
      id: o.id,
      type: o.type,
      summary: o.summary,
      body: o.body.trim().slice(0, BODY_MAX),
      degree: degree.get(o.id) ?? 0,
      pinned: o.pinned,
      wanted: false,
      created: date(managed?.created),
      updated: date(managed?.updated)
    };
  });
  for (const id of new Set(links.map((l) => l.target))) {
    if (!store.objects.has(id))
      nodes.push({ id, type: id.split("/")[0] ?? "wanted", summary: "", body: "", degree: degree.get(id) ?? 0, pinned: false, wanted: true });
  }
  return { nodes, links, types: [...new Set(nodes.map((n) => n.type))].sort() };
}
function adjacency(data) {
  const adj = new Map(data.nodes.map((n) => [n.id, new Set]));
  for (const { source, target } of data.links) {
    adj.get(source)?.add(target);
    adj.get(target)?.add(source);
  }
  return adj;
}
var PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>o6y graph</title>
<style>
:root { color-scheme: light dark; --bg:#f6f5f1; --panel:#fffefb; --ink:#23221f; --soft:#6d6a62; --line:#d8d5cb; --edge:rgba(60,56,48,.2); --edge-on:#23221f; --wanted:#a29e92; }
@media (prefers-color-scheme: dark) { :root { --bg:#16171a; --panel:#1f2125; --ink:#ece9e2; --soft:#9b988f; --line:#33353b; --edge:rgba(225,220,205,.16); --edge-on:#ece9e2; --wanted:#6f6d67; } }
* { box-sizing:border-box; }
html, body { height:100%; margin:0; background:var(--bg); color:var(--ink); font:14px/1.45 ui-sans-serif,system-ui,sans-serif; overflow:hidden; }
canvas { position:fixed; inset:0; width:100%; height:100%; display:block; touch-action:none; cursor:grab; }
canvas.drag { cursor:grabbing; }
.card { position:fixed; background:var(--panel); border:1px solid var(--line); border-radius:10px; box-shadow:0 6px 24px rgba(0,0,0,.12); }
#controls { top:16px; left:16px; width:244px; padding:12px; max-height:calc(100% - 32px); overflow:auto; }
#controls h1 { font:600 13px ui-monospace,monospace; margin:0 0 8px; }
#controls h1 span { color:var(--soft); font-weight:400; }
input[type=search], select { width:100%; font:inherit; color:inherit; background:var(--bg); border:1px solid var(--line); border-radius:6px; padding:6px 8px; }
label { display:flex; align-items:center; gap:7px; padding:2px 0; cursor:pointer; }
.row { margin-top:10px; }
.row > b { display:block; font-size:12px; color:var(--soft); font-weight:500; margin-bottom:3px; }
.dot { width:10px; height:10px; border-radius:50%; flex:none; }
.count { margin-left:auto; color:var(--soft); font-size:12px; }
#detail { top:16px; right:16px; width:360px; max-height:calc(100% - 32px); overflow:auto; padding:14px; display:none; }
#detail.open { display:block; }
#detail h2 { font:600 14px ui-monospace,monospace; margin:0 28px 4px 0; overflow-wrap:anywhere; }
#close { position:absolute; top:8px; right:8px; border:0; background:none; color:var(--soft); font-size:18px; cursor:pointer; width:28px; height:28px; }
#summary { margin:0 0 8px; }
#meta { font:12px ui-monospace,monospace; color:var(--soft); margin-bottom:8px; }
#body { white-space:pre-wrap; overflow-wrap:anywhere; font-size:13px; border-top:1px solid var(--line); padding-top:8px; margin:0 0 8px; }
#near button { display:block; width:100%; text-align:left; font:12px ui-monospace,monospace; color:inherit; background:none; border:0; padding:3px 0; cursor:pointer; overflow-wrap:anywhere; }
#near button:hover { text-decoration:underline; }
@media (max-width:640px) {
  #controls { left:16px; right:16px; width:auto; max-height:38%; }
  #detail { left:16px; right:16px; width:auto; top:auto; bottom:16px; max-height:45%; }
}
#zoom { position:fixed; right:16px; bottom:16px; display:flex; flex-direction:column; padding:4px; gap:2px; }
#zoom button { width:32px; height:32px; border:0; border-radius:6px; background:none; color:inherit; font:15px ui-monospace,monospace; cursor:pointer; }
#zoom button:hover { background:var(--edge); }
</style>
</head>
<body>
<canvas id="c" role="img" aria-label="Graph of the objects in the o6y store and the links between them"></canvas>
<aside id="controls" class="card">
  <h1>o6y graph <span id="stats"></span></h1>
  <input id="q" type="search" placeholder="Find an object ( / )" aria-label="Find an object">
  <div class="row"><b>Show around selection</b>
    <select id="depth" aria-label="Depth around the selected object"><option value="0">Whole store</option><option value="1">1 hop</option><option value="2">2 hops</option><option value="3">3 hops</option></select>
  </div>
  <div class="row"><b>Types</b><div id="types"></div></div>
  <div class="row"><b>Include</b>
    <label><input id="size" type="checkbox" checked>Size nodes by links</label>
    <label><input id="wanted" type="checkbox" checked>Wanted pages</label>
    <label><input id="orphans" type="checkbox" checked>Unlinked objects</label>
  </div>
</aside>
<aside id="detail" class="card" aria-live="polite">
  <button id="close" aria-label="Close">×</button>
  <h2 id="title"></h2><p id="summary"></p><div id="meta"></div><pre id="body"></pre><div id="near"></div>
</aside>
<div id="zoom" class="card" role="group" aria-label="Zoom">
  <button id="zoom-in" title="Zoom in (+)" aria-label="Zoom in">+</button>
  <button id="zoom-out" title="Zoom out (-)" aria-label="Zoom out">−</button>
  <button id="zoom-fit" title="Fit everything (0)" aria-label="Fit everything">⤢</button>
</div>
<script type="application/json" id="data">__DATA__</script>
<script>
(function () {
  var data = JSON.parse(document.getElementById("data").textContent);
  var FOCUS = data.focus || null;
  var PALETTE = ["#d1495b", "#2e86ab", "#e08e1b", "#3a9d6e", "#8e5bb5", "#c2618f", "#1f9e9e", "#8a7a2e", "#5468c4", "#b5563a", "#6b9a2f", "#7a6c9e"];
  var color = {};
  data.types.forEach(function (t, i) { color[t] = PALETTE[i % PALETTE.length]; });
  var canvas = document.getElementById("c"), ctx = canvas.getContext("2d");
  var byId = {}, n = data.nodes.length, sizeByLinks = true;
  var NODE_MIN = 5, NODE_MAX = 18, LABEL_MAX = 40, LABEL_ZOOM = 1.2, ZOOM_MIN = 0.05, ZOOM_MAX = 8;
  var anim = null, animating = false;
  function radius(d) { return sizeByLinks ? Math.min(NODE_MAX, NODE_MIN + Math.sqrt(d.degree) * 2.4) : NODE_MIN + 1; }
  data.nodes.forEach(function (d, i) {
    var a = i * 2.39996, r = 14 * Math.sqrt(i + 1);
    d.x = r * Math.cos(a); d.y = r * Math.sin(a); d.vx = 0; d.vy = 0;
    d.r = radius(d); d.near = new Set(); byId[d.id] = d;
  });
  var links = data.links.map(function (l) { var s = byId[l.source], t = byId[l.target]; s.near.add(t); t.near.add(s); return { s: s, t: t }; });
  var view = { k: 1, x: 0, y: 0 }, W = 0, H = 0, alpha = 1, running = false, queued = false;
  var hover = null, selected = null, dragging = null, panning = null, moved = false;
  var hiddenTypes = new Set(), query = "";
  var el = function (id) { return document.getElementById(id); };
  var reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

  function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
  var theme = {};
  function readTheme() { ["--edge", "--edge-on", "--ink", "--soft", "--wanted", "--bg"].forEach(function (v) { theme[v] = css(v); }); }

  var shown = new Set();
  function refresh() {
    var depth = +el("depth").value, around = null;
    if (depth && selected) {
      around = new Set([selected]);
      var edge = [selected];
      for (var h = 0; h < depth; h++) {
        var next = [];
        edge.forEach(function (d) { d.near.forEach(function (o) { if (!around.has(o)) { around.add(o); next.push(o); } }); });
        edge = next;
      }
    }
    shown = new Set(data.nodes.filter(function (d) {
      if (hiddenTypes.has(d.type)) return false;
      if (d.wanted && !el("wanted").checked) return false;
      if (!d.degree && !el("orphans").checked) return false;
      return !around || around.has(d);
    }));
    el("stats").textContent = shown.size + " of " + n;
    reheat(0.25);
    draw();
  }

  function tick() {
    var list = Array.from(shown), i, j, a, b, dx, dy, d2, f;
    for (i = 0; i < list.length; i++) {
      a = list[i];
      a.vx -= a.x * 0.012 * alpha; a.vy -= a.y * 0.012 * alpha;
      for (j = i + 1; j < list.length; j++) {
        b = list[j]; dx = b.x - a.x; dy = b.y - a.y; d2 = dx * dx + dy * dy || 1;
        if (d2 > 250000) continue;
        f = 900 * alpha / d2;
        a.vx -= dx * f; a.vy -= dy * f; b.vx += dx * f; b.vy += dy * f;
      }
    }
    links.forEach(function (l) {
      if (!shown.has(l.s) || !shown.has(l.t)) return;
      dx = l.t.x - l.s.x; dy = l.t.y - l.s.y;
      var d = Math.sqrt(dx * dx + dy * dy) || 1;
      f = (d - 70) / d * 0.06 * alpha;
      l.s.vx += dx * f; l.s.vy += dy * f; l.t.vx -= dx * f; l.t.vy -= dy * f;
    });
    list.forEach(function (d) {
      if (d === dragging) { d.vx = d.vy = 0; return; }
      d.vx *= 0.62; d.vy *= 0.62; d.x += d.vx; d.y += d.vy;
    });
    alpha *= 0.985;
  }
  function loop() {
    if (alpha < 0.01 && !dragging) { running = false; return; }
    tick(); draw(); requestAnimationFrame(loop);
  }
  function reheat(a) {
    if (reduced) return;
    alpha = Math.max(alpha, a);
    if (!running) { running = true; requestAnimationFrame(loop); }
  }
  function settle() {
    var steps = Math.min(320, Math.floor(6e7 / Math.max(1, n * n)));
    for (var i = 0; i < steps; i++) tick();
    alpha = 0.01;
  }
  function clampZoom(k) { return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, k)); }
  function step() {
    if (!anim) { animating = false; return; }
    var ease = reduced ? 1 : 0.28, next = view.k * Math.pow(anim.k / view.k, ease), done = Math.abs(Math.log(anim.k / next)) < 0.003;
    if (done) next = anim.k;
    if (anim.fly) {
      var nx = view.x + (anim.x - view.x) * ease, ny = view.y + (anim.y - view.y) * ease;
      done = done && Math.abs(anim.x - nx) < 0.5 && Math.abs(anim.y - ny) < 0.5;
      view.x = done ? anim.x : nx; view.y = done ? anim.y : ny;
    } else {
      view.x = anim.sx - (anim.sx - view.x) * next / view.k; view.y = anim.sy - (anim.sy - view.y) * next / view.k;
    }
    view.k = next; paint();
    if (done) anim = null;
    requestAnimationFrame(step);
  }
  function go(a) { anim = a; if (!animating) { animating = true; requestAnimationFrame(step); } }
  /** Zooms keeping the screen point (sx, sy) still; repeated calls build on where it was heading. */
  function zoomBy(f, sx, sy) { go({ k: clampZoom((anim && !anim.fly ? anim.k : view.k) * f), sx: sx, sy: sy }); }
  function flyTo(d, k) { k = clampZoom(k); go({ fly: true, k: k, x: W / 2 - k * d.x, y: H / 2 - k * d.y }); }
  function fit(animated) {
    var list = Array.from(shown); if (!list.length) return;
    var x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    list.forEach(function (d) { x0 = Math.min(x0, d.x); x1 = Math.max(x1, d.x); y0 = Math.min(y0, d.y); y1 = Math.max(y1, d.y); });
    var k = Math.min(2, 0.82 * Math.min(W / Math.max(120, x1 - x0), H / Math.max(120, y1 - y0)));
    var x = W / 2 - k * (x0 + x1) / 2, y = H / 2 - k * (y0 + y1) / 2;
    if (animated) go({ fly: true, k: k, x: x, y: y });
    else { view.k = k; view.x = x; view.y = y; }
  }
  function resize() {
    var r = devicePixelRatio || 1; W = innerWidth; H = innerHeight;
    canvas.width = W * r; canvas.height = H * r; ctx.setTransform(r, 0, 0, r, 0, 0); draw();
  }
  function draw() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(function () { queued = false; paint(); });
  }
  function matches(d) { return !query || d.id.toLowerCase().indexOf(query) >= 0 || d.summary.toLowerCase().indexOf(query) >= 0; }
  function paint() {
    ctx.clearRect(0, 0, W, H);
    ctx.save(); ctx.translate(view.x, view.y); ctx.scale(view.k, view.k);
    var focus = hover || (selected && selected.near.size ? selected : null);
    // Names appear when zoomed in far enough to read them, or when few nodes are in view anyway.
    var inView = 0;
    shown.forEach(function (d) {
      var sx = d.x * view.k + view.x, sy = d.y * view.k + view.y;
      if (sx > 0 && sx < W && sy > 0 && sy < H && matches(d)) inView++;
    });
    var labelAll = inView <= LABEL_MAX || view.k >= LABEL_ZOOM;
    links.forEach(function (l) {
      if (!shown.has(l.s) || !shown.has(l.t)) return;
      var on = focus && (l.s === focus || l.t === focus);
      ctx.strokeStyle = on ? theme["--edge-on"] : theme["--edge"];
      ctx.lineWidth = (on ? 1.4 : 1) / view.k;
      ctx.beginPath(); ctx.moveTo(l.s.x, l.s.y); ctx.lineTo(l.t.x, l.t.y); ctx.stroke();
    });
    shown.forEach(function (d) {
      var related = !focus || d === focus || focus.near.has(d);
      ctx.globalAlpha = (matches(d) ? 1 : 0.12) * (related ? 1 : 0.28);
      ctx.fillStyle = d.wanted ? theme["--wanted"] : color[d.type];
      ctx.beginPath(); ctx.arc(d.x, d.y, d.r, 0, 6.3); ctx.fill();
      if (d.pinned || d === selected) { ctx.strokeStyle = theme["--ink"]; ctx.lineWidth = 1.6 / view.k; ctx.stroke(); }
      if (d === selected || d === hover || (labelAll && matches(d))) {
        ctx.font = (d === focus || d === selected ? "600 " : "") + 11 / view.k + "px ui-monospace,monospace";
        ctx.fillStyle = theme["--ink"]; ctx.textAlign = "center"; ctx.textBaseline = "top";
        ctx.fillText(d.id.slice(d.id.indexOf("/") + 1), d.x, d.y + d.r + 3 / view.k);
      }
    });
    ctx.globalAlpha = 1; ctx.restore();
  }
  function toWorld(e) { return { x: (e.clientX - view.x) / view.k, y: (e.clientY - view.y) / view.k }; }
  function pick(e) {
    var p = toWorld(e), best = null, dist = Infinity;
    shown.forEach(function (d) {
      var dx = d.x - p.x, dy = d.y - p.y, g = Math.sqrt(dx * dx + dy * dy), reach = d.r + 5 / view.k;
      if (g < reach && g < dist) { best = d; dist = g; }
    });
    return best;
  }
  function select(d) {
    selected = d;
    el("detail").classList.toggle("open", !!d);
    if (d) {
      el("title").textContent = d.id;
      el("summary").textContent = d.wanted ? "Linked, but not written yet." : d.summary;
      var parts = [];
      if (d.pinned) parts.push("pinned");
      if (d.created) parts.push("created " + d.created);
      if (d.updated) parts.push("updated " + d.updated);
      el("meta").textContent = parts.join(" · ");
      el("body").textContent = d.body; el("body").style.display = d.body ? "" : "none";
      var near = el("near"); near.textContent = "";
      Array.from(d.near).sort(function (a, b) { return a.id < b.id ? -1 : 1; }).forEach(function (o) {
        var b = document.createElement("button"); b.textContent = "→ " + o.id;
        b.addEventListener("click", function () { select(o); flyTo(o, Math.max(view.k, 1)); });
        near.appendChild(b);
      });
    }
    if (+el("depth").value) refresh(); else draw();
  }
  canvas.addEventListener("pointerdown", function (e) {
    canvas.setPointerCapture(e.pointerId); moved = false; anim = null;
    var d = pick(e);
    if (d) { dragging = d; reheat(0.3); } else panning = { x: e.clientX - view.x, y: e.clientY - view.y };
    canvas.classList.add("drag");
  });
  canvas.addEventListener("pointermove", function (e) {
    if (dragging) { var p = toWorld(e); dragging.x = p.x; dragging.y = p.y; moved = true; reheat(0.3); draw(); return; }
    if (panning) { view.x = e.clientX - panning.x; view.y = e.clientY - panning.y; moved = true; draw(); return; }
    var h = pick(e);
    if (h !== hover) { hover = h; canvas.style.cursor = h ? "pointer" : ""; draw(); }
  });
  function release(e) {
    if (!moved) select(dragging || null);
    dragging = null; panning = null; canvas.classList.remove("drag");
  }
  canvas.addEventListener("pointerup", release);
  canvas.addEventListener("pointercancel", function () { dragging = null; panning = null; });
  canvas.addEventListener("wheel", function (e) {
    e.preventDefault();
    // Pinches arrive as ctrl+wheel with small deltas; line-based wheels report lines, not pixels.
    var delta = e.deltaY * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? H : 1);
    delta = Math.max(-150, Math.min(150, delta));
    zoomBy(Math.exp(-delta * (e.ctrlKey ? 0.012 : 0.0025)), e.clientX, e.clientY);
  }, { passive: false });
  canvas.addEventListener("dblclick", function (e) {
    var d = pick(e);
    if (d) flyTo(d, Math.max(view.k * 1.6, 1.2)); else zoomBy(2, e.clientX, e.clientY);
  });
  el("zoom-in").addEventListener("click", function () { zoomBy(1.6, W / 2, H / 2); });
  el("zoom-out").addEventListener("click", function () { zoomBy(1 / 1.6, W / 2, H / 2); });
  el("zoom-fit").addEventListener("click", function () { fit(true); });
  el("q").addEventListener("keydown", function (e) {
    if (e.key !== "Enter") return;
    var hit = Array.from(shown).filter(matches)[0];
    if (hit) { select(hit); flyTo(hit, Math.max(view.k, 1.2)); }
  });
  el("q").addEventListener("input", function (e) { query = e.target.value.trim().toLowerCase(); draw(); });
  el("depth").addEventListener("change", refresh);
  el("size").addEventListener("change", function (e) {
    sizeByLinks = e.target.checked;
    data.nodes.forEach(function (d) { d.r = radius(d); });
    draw();
  });
  el("wanted").addEventListener("change", refresh);
  el("orphans").addEventListener("change", refresh);
  el("close").addEventListener("click", function () { select(null); });
  addEventListener("keydown", function (e) {
    if (e.key === "/" && document.activeElement !== el("q")) { e.preventDefault(); el("q").focus(); }
    if (document.activeElement !== el("q")) {
      if (e.key === "+" || e.key === "=") zoomBy(1.6, W / 2, H / 2);
      if (e.key === "-") zoomBy(1 / 1.6, W / 2, H / 2);
      if (e.key === "0") fit(true);
    }
    if (e.key === "Escape") { if (document.activeElement === el("q")) el("q").blur(); select(null); }
  });
  addEventListener("resize", resize);
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function () { readTheme(); draw(); });
  data.types.forEach(function (t) {
    var count = data.nodes.filter(function (d) { return d.type === t; }).length;
    var label = document.createElement("label"), box = document.createElement("input"), dot = document.createElement("span"), name = document.createElement("span"), c = document.createElement("span");
    box.type = "checkbox"; box.checked = true; dot.className = "dot"; dot.style.background = color[t]; name.textContent = t; c.className = "count"; c.textContent = count;
    box.addEventListener("change", function () { if (box.checked) hiddenTypes.delete(t); else hiddenTypes.add(t); refresh(); });
    label.append(box, dot, name, c); el("types").appendChild(label);
  });
  readTheme();
  shown = new Set(data.nodes);
  el("stats").textContent = n + " of " + n;
  W = innerWidth; H = innerHeight;
  settle(); fit(); resize();
  if (FOCUS && byId[FOCUS]) { select(byId[FOCUS]); flyTo(byId[FOCUS], Math.max(view.k, 1)); }
})();
</script>
</body>
</html>
`;
function renderGraphHtml(data, focus) {
  const json = JSON.stringify({ ...data, focus }).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  return PAGE.replace("__DATA__", () => json);
}

export { graphData, adjacency, renderGraphHtml };
