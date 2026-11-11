#!/usr/bin/env node
import {
  outgoing
} from "./chunk-angs7n4p.js";
import {
  LOG_LINE
} from "./chunk-asv2qy3p.js";
import {
  ID_RE,
  LOG_FILE,
  RESERVED_FIELDS
} from "./chunk-a8qzjqdm.js";

// src/core/graph.ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
var BODY_MAX = 20000;
var EVENTS_MAX = 5000;
var date = (v) => v instanceof Date ? v.toISOString().slice(0, 10) : typeof v === "string" ? v : undefined;
function display(v) {
  if (Array.isArray(v))
    return v.flatMap(display);
  if (v instanceof Date)
    return [v.toISOString().slice(0, 10)];
  if (v === null || v === undefined)
    return [];
  if (typeof v === "object")
    return [JSON.stringify(v)];
  return [String(v)];
}
function readEvents(store) {
  const events = [];
  for (const layer of store.layers) {
    const path = join(layer.root, LOG_FILE);
    if (!existsSync(path))
      continue;
    for (const line of readFileSync(path, "utf8").split(`
`)) {
      const m = LOG_LINE.exec(line);
      if (!m || !ID_RE.test(m[3]))
        continue;
      events.push({ at: m[1], action: m[2], id: m[3], via: m[4] });
    }
  }
  events.sort((a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : 0);
  return events.slice(-EVENTS_MAX);
}
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
    const body = o.body.trim();
    return {
      id: o.id,
      type: o.type,
      summary: o.summary,
      body: body.slice(0, BODY_MAX),
      ...body.length > BODY_MAX ? { truncated: true } : {},
      degree: degree.get(o.id) ?? 0,
      pinned: o.pinned,
      wanted: false,
      layer: o.layer.name,
      path: o.path,
      fields: Object.entries(o.data).filter(([k]) => !RESERVED_FIELDS.includes(k)).map(([k, v]) => [k, display(v)]),
      created: date(managed?.created),
      updated: date(managed?.updated)
    };
  });
  for (const id of new Set(links.map((l) => l.target))) {
    if (!store.objects.has(id))
      nodes.push({ id, type: id.split("/")[0] ?? "wanted", summary: "", body: "", degree: degree.get(id) ?? 0, pinned: false, wanted: true });
  }
  return { nodes, links, types: [...new Set(nodes.map((n) => n.type))].sort(), events: readEvents(store) };
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
<link rel="icon" href="data:,">
<style>
:root { color-scheme: light dark; --bg:#f6f5f1; --panel:#fffefb; --ink:#23221f; --soft:#6d6a62; --line:#d8d5cb; --edge:rgba(60,56,48,.2); --edge-on:#23221f; --wanted:#a29e92; --accent:#d9480f; --code:#efece4; --link:#1f6fb2; }
@media (prefers-color-scheme: dark) { :root { --bg:#16171a; --panel:#1f2125; --ink:#ece9e2; --soft:#9b988f; --line:#33353b; --edge:rgba(225,220,205,.16); --edge-on:#ece9e2; --wanted:#6f6d67; --accent:#ff922b; --code:#2a2c31; --link:#74b4ef; } }
* { box-sizing:border-box; }
[hidden] { display:none !important; }
html, body { height:100%; margin:0; background:var(--bg); color:var(--ink); font:14px/1.45 ui-sans-serif,system-ui,sans-serif; overflow:hidden; }
canvas#c { position:fixed; inset:0; width:100%; height:100%; display:block; touch-action:none; cursor:grab; }
canvas#c.drag { cursor:grabbing; }
button { font:inherit; color:inherit; }
.card { position:fixed; background:var(--panel); border:1px solid var(--line); border-radius:10px; box-shadow:0 6px 24px rgba(0,0,0,.12); }
.soft { color:var(--soft); }
.icon { width:30px; height:30px; border:0; border-radius:6px; background:none; color:var(--soft); font:15px ui-monospace,monospace; cursor:pointer; display:inline-flex; align-items:center; justify-content:center; flex:none; }
.icon:hover, .icon[aria-pressed=true] { background:var(--edge); color:var(--ink); }
.chip { display:inline-flex; align-items:center; gap:5px; border:1px solid var(--line); border-radius:999px; padding:1px 8px; font:11px ui-monospace,monospace; color:var(--soft); white-space:nowrap; }
#controls { top:16px; left:16px; width:248px; padding:12px; max-height:calc(100% - 32px); overflow:auto; }
#controls h1 { display:flex; align-items:center; gap:6px; font:600 13px ui-monospace,monospace; margin:0 0 8px; }
#controls h1 #stats { color:var(--soft); font-weight:400; }
#live { margin-left:auto; }
#live .dot { width:7px; height:7px; background:#2f9e44; }
#live.off .dot { background:var(--wanted); }
input[type=search], select { width:100%; font:inherit; color:inherit; background:var(--bg); border:1px solid var(--line); border-radius:6px; padding:6px 8px; }
label { display:flex; align-items:center; gap:7px; padding:2px 0; cursor:pointer; }
.row { margin-top:10px; }
.row > b { display:block; font-size:12px; color:var(--soft); font-weight:500; margin-bottom:3px; }
.dot { width:10px; height:10px; border-radius:50%; flex:none; display:inline-block; }
.count { margin-left:auto; color:var(--soft); font-size:12px; }
.keys { margin-top:12px; padding-top:8px; border-top:1px solid var(--line); font:11px/1.7 ui-monospace,monospace; color:var(--soft); }
kbd { font:inherit; border:1px solid var(--line); border-bottom-width:2px; border-radius:4px; padding:0 4px; }

#detail { top:16px; right:16px; width:420px; max-height:calc(100% - 32px); overflow:auto; padding:14px 16px 16px; display:none; }
#detail.open { display:block; }
#detail .tools { position:sticky; top:-14px; float:right; display:flex; gap:2px; margin:-6px -8px 0 8px; background:var(--panel); border-radius:8px; z-index:1; }
#detail h2 { font:600 15px ui-monospace,monospace; margin:6px 0 4px; overflow-wrap:anywhere; }
.chips { display:flex; flex-wrap:wrap; gap:4px; }
#summary { margin:0 0 6px; font-size:15px; }
#meta { font:12px ui-monospace,monospace; color:var(--soft); margin-bottom:10px; overflow-wrap:anywhere; }
#fields { display:grid; grid-template-columns:max-content 1fr; gap:3px 12px; margin:0 0 10px; font-size:13px; }
#fields:empty { display:none; }
#fields dt { color:var(--soft); font:12px ui-monospace,monospace; padding-top:1px; }
#fields dd { margin:0; overflow-wrap:anywhere; }
#fields dd > * + * { margin-left:6px; }
#near { border-top:1px solid var(--line); margin-top:12px; padding-top:8px; }
#near h3 { font-size:12px; font-weight:500; color:var(--soft); margin:8px 0 2px; }
#near button { display:flex; gap:7px; align-items:baseline; width:100%; text-align:left; font:12px ui-monospace,monospace; background:none; border:0; padding:3px 0; cursor:pointer; overflow-wrap:anywhere; }
#near button .dot { width:8px; height:8px; transform:translateY(-1px); }
#near button span.s { color:var(--soft); font-family:ui-sans-serif,system-ui,sans-serif; }
#near button:hover b { text-decoration:underline; }

.md { font-size:13.5px; line-height:1.6; overflow-wrap:anywhere; border-top:1px solid var(--line); padding-top:4px; }
.md:empty { display:none; }
.md > :first-child { margin-top:8px; }
.md h1, .md h2, .md h3, .md h4, .md h5, .md h6 { font-family:ui-sans-serif,system-ui,sans-serif; line-height:1.3; margin:1.1em 0 .4em; }
.md h1 { font-size:1.45em; } .md h2 { font-size:1.25em; } .md h3 { font-size:1.1em; } .md h4, .md h5, .md h6 { font-size:1em; color:var(--soft); }
.md p, .md ul, .md ol, .md pre, .md blockquote, .md .table { margin:.55em 0; }
.md ul, .md ol { padding-left:1.4em; }
.md li > ul, .md li > ol { margin:.15em 0; }
.md li.task { list-style:none; margin-left:-1.3em; }
.md li.task input { margin:0 .45em 0 0; vertical-align:-1px; }
.md code { font:.9em ui-monospace,monospace; background:var(--code); border-radius:4px; padding:.1em .35em; }
.md pre { background:var(--code); border-radius:8px; padding:10px 12px; overflow:auto; white-space:pre; }
.md pre code { background:none; padding:0; font-size:.88em; }
.md blockquote { border-left:3px solid var(--line); margin-left:0; padding:0 0 0 12px; color:var(--soft); }
.md hr { border:0; border-top:1px solid var(--line); margin:1.2em 0; }
.md .table { overflow:auto; }
.md table { border-collapse:collapse; font-size:.95em; }
.md th, .md td { border:1px solid var(--line); padding:4px 8px; text-align:left; vertical-align:top; }
.md th { background:var(--code); }
.md a.ext, .md a.ext:visited { color:var(--link); }
a.wiki { color:inherit; text-decoration:none; border-bottom:1.5px solid var(--c, var(--soft)); cursor:pointer; font-weight:500; }
a.wiki:hover { background:var(--edge); }
a.wiki.missing { border-bottom-style:dashed; color:var(--soft); font-weight:400; }
.note { font-size:12px; color:var(--soft); font-style:italic; }

#detail.full { inset:0; width:auto; max-height:none; border-radius:0; border:0; padding:28px 24px 64px; z-index:20; box-shadow:none; }
#detail.full .tools { position:fixed; top:14px; right:16px; float:none; margin:0; background:var(--panel); }
#detail.full .inner { max-width:780px; margin:0 auto; }
#detail.full h2 { font-size:22px; margin-top:14px; }
#detail.full #summary { font-size:18px; color:var(--soft); }
#detail.full .md { font-size:16.5px; line-height:1.7; }
#detail.full #near { display:grid; grid-template-columns:1fr 1fr; gap:0 24px; }
#detail.full #near > div { min-width:0; }

#zoom { position:fixed; right:16px; bottom:16px; display:flex; flex-direction:column; padding:4px; gap:2px; }
#detail.open:not(.full) ~ #zoom { right:452px; }
#path { font:11px ui-monospace,monospace; color:var(--soft); opacity:.8; margin:-6px 0 10px; overflow-wrap:anywhere; }
#path:empty { display:none; }
#zoom hr { border:0; border-top:1px solid var(--line); margin:2px 4px; }

#timeline { left:50%; transform:translateX(-50%); bottom:16px; width:min(760px, calc(100% - 100px)); padding:8px 12px 10px; display:none; }
#timeline.open { display:block; }
.tl-head { display:flex; align-items:center; gap:8px; }
.tl-head b { font:600 13px ui-monospace,monospace; }
.tl-head .grow { flex:1; }
.tl-track { position:relative; height:40px; margin:4px 0 2px; }
.tl-track canvas { position:absolute; left:8px; right:8px; top:0; width:calc(100% - 16px); height:28px; }
.tl-track input { position:absolute; left:0; right:0; bottom:-2px; width:100%; margin:0; accent-color:var(--accent); }
.tl-ends { display:flex; justify-content:space-between; font:11px ui-monospace,monospace; color:var(--soft); }
#feed { list-style:none; margin:6px 0 0; padding:6px 0 0; border-top:1px solid var(--line); max-height:116px; overflow:auto; }
#feed li { display:flex; gap:8px; align-items:baseline; font:12px ui-monospace,monospace; padding:1px 0; }
#feed time { color:var(--soft); flex:none; }
#feed .act { flex:none; width:52px; }
#feed .create { color:#2f9e44; } #feed .update { color:var(--link); } #feed .delete { color:#e03131; }
#feed button { background:none; border:0; padding:0; cursor:pointer; font:inherit; text-align:left; overflow-wrap:anywhere; }
#feed button:hover { text-decoration:underline; }
#feed button:disabled { cursor:default; text-decoration:line-through; color:var(--soft); }
#feed .via { color:var(--soft); margin-left:auto; flex:none; }
#feed .empty { color:var(--soft); font-family:ui-sans-serif,system-ui,sans-serif; }

@media (max-width:640px) {
  #controls { left:16px; right:16px; width:auto; max-height:38%; }
  #detail { left:16px; right:16px; width:auto; top:auto; bottom:16px; max-height:50%; }
  #detail.open:not(.full) ~ #zoom { right:16px; }
  #timeline { left:16px; right:16px; width:auto; transform:none; bottom:16px; }
  #feed .via { display:none; }
  #detail.full #near { display:block; }
}
</style>
</head>
<body>
<canvas id="c" role="img" aria-label="Graph of the objects in the o6y store and the links between them"></canvas>
<aside id="controls" class="card">
  <h1>o6y <span id="stats"></span><span id="live" class="chip" hidden><span class="dot"></span><span id="live-text">live</span></span></h1>
  <input id="q" type="search" placeholder="Find an object ( / )" aria-label="Find an object">
  <div class="row"><b>Show around selection</b>
    <select id="depth" aria-label="Depth around the selected object"><option value="0">Whole store</option><option value="1">1 hop</option><option value="2">2 hops</option><option value="3">3 hops</option></select>
  </div>
  <div class="row"><b>Types</b><div id="types"></div></div>
  <div class="row"><b>Include</b>
    <label><input id="size" type="checkbox" checked>Size nodes by links</label>
    <label><input id="wanted" type="checkbox" checked>Wanted pages</label>
    <label><input id="orphans" type="checkbox" checked>Unlinked objects</label>
    <label><input id="arrows" type="checkbox" checked>Link direction</label>
  </div>
  <div class="keys"><kbd>/</kbd> find &middot; <kbd>f</kbd> read &middot; <kbd>t</kbd> history<br><kbd>+</kbd><kbd>-</kbd><kbd>0</kbd> zoom &middot; <kbd>Esc</kbd> back</div>
</aside>
<aside id="detail" class="card" aria-live="polite">
  <div class="tools">
    <button id="expand" class="icon" title="Read full screen (f)" aria-label="Read full screen" aria-pressed="false">&#x2197;</button>
    <button id="copy" class="icon" title="Copy id" aria-label="Copy id">&#x29C9;</button>
    <button id="close" class="icon" title="Close (Esc)" aria-label="Close">&times;</button>
  </div>
  <article class="inner">
    <div id="chips" class="chips"></div>
    <h2 id="title"></h2><p id="summary"></p><div id="meta"></div><div id="path"></div>
    <dl id="fields"></dl>
    <div id="body" class="md"></div>
    <p id="trunc" class="note" hidden>The rest of this page is in its file.</p>
    <div id="near"></div>
  </article>
</aside>
<section id="timeline" class="card" aria-label="History">
  <div class="tl-head">
    <button id="play" class="icon" title="Play history" aria-label="Play history">&#x25B6;</button>
    <b id="when">Now</b><span id="tl-count" class="soft"></span><span class="grow"></span>
    <button id="tl-now" class="icon" title="Back to now" aria-label="Back to now">&#x23ED;</button>
    <button id="tl-close" class="icon" title="Close history (t)" aria-label="Close history">&times;</button>
  </div>
  <div class="tl-track"><canvas id="hist" aria-hidden="true"></canvas><input id="scrub" type="range" min="0" max="1000" value="1000" aria-label="Point in time"></div>
  <div class="tl-ends"><span id="t0"></span><span id="t1"></span></div>
  <ol id="feed" aria-label="Changes up to this point"></ol>
</section>
<div id="zoom" class="card" role="group" aria-label="View">
  <button id="zoom-in" class="icon" title="Zoom in (+)" aria-label="Zoom in">+</button>
  <button id="zoom-out" class="icon" title="Zoom out (-)" aria-label="Zoom out">&minus;</button>
  <button id="zoom-fit" class="icon" title="Fit everything (0)" aria-label="Fit everything">&#x2922;</button>
  <hr>
  <button id="history" class="icon" title="History (t)" aria-label="History" aria-pressed="false">&#x25F7;</button>
  <button id="fullscreen" class="icon" title="Full screen" aria-label="Full screen" aria-pressed="false">&#x26F6;</button>
</div>
<script type="application/json" id="data">__DATA__</script>
<script>
(function () {
  var el = function (id) { return document.getElementById(id); };
  var data = JSON.parse(el("data").textContent);
  var FOCUS = data.focus || null, LIVE = !!data.live;
  var PALETTE = ["#d1495b", "#2e86ab", "#e08e1b", "#3a9d6e", "#8e5bb5", "#c2618f", "#1f9e9e", "#8a7a2e", "#5468c4", "#b5563a", "#6b9a2f", "#7a6c9e"];
  var color = {}, colors = 0;
  var canvas = el("c"), ctx = canvas.getContext("2d");
  var byId = {}, n = 0, links = [], sizeByLinks = true;
  var NODE_MIN = 5, NODE_MAX = 18, LABEL_MAX = 40, LABEL_ZOOM = 1.2, ZOOM_MIN = 0.05, ZOOM_MAX = 8, MAX_SPEED = 40, FLASH_MS = 4000;
  var anim = null, animating = false;
  function radius(d) { return sizeByLinks ? Math.min(NODE_MAX, NODE_MIN + Math.sqrt(d.degree) * 2.4) : NODE_MIN + 1; }
  var view = { k: 1, x: 0, y: 0 }, W = 0, H = 0, alpha = 1, running = false, queued = false;
  var hover = null, selected = null, dragging = null, panning = null, moved = false;
  var hiddenTypes = new Set(), query = "";
  var reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  var events = [], T0 = 0, T1 = 0, timeAt = null, playing = false;

  function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
  var theme = {};
  function readTheme() { ["--edge", "--edge-on", "--ink", "--soft", "--wanted", "--bg", "--accent"].forEach(function (v) { theme[v] = css(v); }); }
  function h(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

  /** Takes in a (new) snapshot, keeping positions of nodes already on screen and flashing what changed. */
  function ingest(next, first) {
    var old = byId, now = performance.now();
    byId = {};
    next.nodes.forEach(function (d, i) {
      var o = old[d.id];
      if (o) {
        d.x = o.x; d.y = o.y; d.vx = o.vx; d.vy = o.vy;
        d.flash = o.flash;
        if (o.body !== d.body || o.summary !== d.summary || o.updated !== d.updated || o.wanted !== d.wanted || o.pinned !== d.pinned) d.flash = now;
      } else if (first) {
        var a = i * 2.39996, r = 14 * Math.sqrt(i + 1);
        d.x = r * Math.cos(a); d.y = r * Math.sin(a); d.vx = 0; d.vy = 0;
      } else { d.fresh = true; d.flash = now; d.vx = 0; d.vy = 0; }
      d.near = new Set(); d.out = new Set(); d.inn = new Set(); d.r = radius(d); byId[d.id] = d;
      if (!(d.type in color)) color[d.type] = PALETTE[colors++ % PALETTE.length];
    });
    links = [];
    next.links.forEach(function (l) {
      var s = byId[l.source], t = byId[l.target];
      if (!s || !t) return;
      s.near.add(t); t.near.add(s); s.out.add(t); t.inn.add(s); links.push({ s: s, t: t });
    });
    next.nodes.forEach(function (d) {
      if (!d.fresh) return;
      var anchor = Array.from(d.near).filter(function (o) { return !o.fresh; })[0];
      d.x = (anchor ? anchor.x : 0) + (Math.random() - 0.5) * 60; d.y = (anchor ? anchor.y : 0) + (Math.random() - 0.5) * 60;
      d.fresh = false;
    });
    if (next.events) data.events = next.events;
    data.nodes = next.nodes; data.links = next.links; data.types = next.types;
    n = data.nodes.length;
    computeHistory();
    buildTypes();
  }

  function buildTypes() {
    var box = el("types"); box.textContent = "";
    data.types.forEach(function (t) {
      var count = data.nodes.filter(function (d) { return d.type === t; }).length;
      var label = h("label"), cb = h("input"), dot = h("span", "dot"), c = h("span", "count", String(count));
      cb.type = "checkbox"; cb.checked = !hiddenTypes.has(t); dot.style.background = color[t];
      cb.addEventListener("change", function () { if (cb.checked) hiddenTypes.delete(t); else hiddenTypes.add(t); refresh(); });
      label.append(cb, dot, h("span", null, t), c); box.appendChild(label);
    });
  }

  // ── history ──
  function computeHistory() {
    events = (data.events || []).map(function (e) { return { at: Date.parse(e.at), action: e.action, id: e.id, via: e.via }; }).filter(function (e) { return !isNaN(e.at); });
    data.nodes.forEach(function (d) { d.born = Infinity; d.times = []; });
    events.forEach(function (e) {
      var d = byId[e.id]; if (!d) return;
      d.times.push(e.at);
      if (e.action === "create" && e.at < d.born) d.born = e.at;
    });
    data.nodes.forEach(function (d) {
      var c = d.created ? Date.parse(d.created) : NaN, u = d.updated ? Date.parse(d.updated) : NaN;
      if (!isNaN(c) && c < d.born) d.born = c;
      if (!isNaN(u) && !d.times.length) d.times.push(u);
      if (d.born === Infinity && d.times.length) d.born = Math.min.apply(null, d.times);
      if (d.born === Infinity && !d.wanted) d.born = -Infinity;
    });
    // A wanted page appears with the first object that links to it.
    data.nodes.forEach(function (d) {
      if (!d.wanted) return;
      d.born = Array.from(d.inn).reduce(function (m, s) { return Math.min(m, s.born); }, Infinity);
      if (d.born === Infinity) d.born = -Infinity;
    });
    var known = events.map(function (e) { return e.at; });
    data.nodes.forEach(function (d) { if (isFinite(d.born)) known.push(d.born); });
    T1 = Math.max(Date.now(), known.length ? Math.max.apply(null, known) : 0);
    T0 = known.length ? Math.min.apply(null, known) : T1 - 864e5;
    if (T1 - T0 < 36e5) T0 = T1 - 36e5;
    el("t0").textContent = fmt(T0, true); el("t1").textContent = "now";
    if (el("timeline").classList.contains("open")) { drawHist(); renderFeed(); }
  }
  function exists(d) { return timeAt === null || d.born <= timeAt; }
  function recent(d) {
    if (timeAt === null) return false;
    var span = (T1 - T0) / 40;
    return d.times.some(function (t) { return t <= timeAt && t > timeAt - span; });
  }
  function fmt(t, short) {
    try { return new Date(t).toLocaleString(undefined, short ? { dateStyle: "medium" } : { dateStyle: "medium", timeStyle: "short" }); }
    catch (e) { return new Date(t).toISOString(); }
  }
  function drawHist() {
    var c = el("hist"), r = devicePixelRatio || 1, w = c.clientWidth, ht = c.clientHeight;
    if (!w) return;
    c.width = w * r; c.height = ht * r;
    var g = c.getContext("2d"); g.setTransform(r, 0, 0, r, 0, 0); g.clearRect(0, 0, w, ht);
    var bins = Math.max(10, Math.min(120, Math.floor(w / 6))), counts = new Array(bins).fill(0), max = 0;
    var stamps = events.map(function (e) { return e.at; });
    if (!stamps.length) data.nodes.forEach(function (d) { if (isFinite(d.born)) stamps.push(d.born); });
    stamps.forEach(function (t) { var b = Math.min(bins - 1, Math.max(0, Math.floor((t - T0) / (T1 - T0) * bins))); counts[b]++; max = Math.max(max, counts[b]); });
    var bw = w / bins, cut = timeAt === null ? Infinity : (timeAt - T0) / (T1 - T0) * w;
    counts.forEach(function (v, i) {
      if (!v) return;
      var bh = Math.max(2, (ht - 2) * Math.sqrt(v / max));
      g.fillStyle = i * bw <= cut ? theme["--accent"] : theme["--wanted"];
      g.globalAlpha = i * bw <= cut ? 0.85 : 0.5;
      g.fillRect(i * bw + 1, ht - bh, Math.max(1, bw - 2), bh);
    });
    g.globalAlpha = 1;
  }
  function renderFeed() {
    var feed = el("feed"), upto = timeAt === null ? Infinity : timeAt; feed.textContent = "";
    var list = events.filter(function (e) { return e.at <= upto; }).slice(-40).reverse();
    if (!list.length) { feed.appendChild(h("li", "empty", events.length ? "Nothing changed before this point." : "No changes logged yet. Writes through o6y go to log.md and show up here.")); return; }
    list.forEach(function (e) {
      var li = h("li"), b = h("button", null, e.id), d = byId[e.id];
      li.append(h("time", null, fmt(e.at)), h("span", "act " + e.action, e.action), b, h("span", "via", e.via));
      if (d) b.addEventListener("click", function () { navigate(d); }); else { b.disabled = true; b.title = "No longer in the store"; }
      feed.appendChild(li);
    });
  }
  function setTime(v) {
    v = Math.max(0, Math.min(1000, v));
    el("scrub").value = String(v);
    timeAt = v >= 1000 ? null : T0 + (T1 - T0) * v / 1000;
    el("when").textContent = timeAt === null ? "Now" : fmt(timeAt);
    refresh(true); drawHist(); renderFeed();
  }
  function toggleTimeline(open) {
    var tl = el("timeline"); open = open == null ? !tl.classList.contains("open") : open;
    tl.classList.toggle("open", open); el("history").setAttribute("aria-pressed", String(open));
    if (open) { computeHistory(); drawHist(); renderFeed(); }
    else { stopPlay(); if (timeAt !== null) setTime(1000); }
  }
  function stopPlay() { playing = false; el("play").textContent = "▶"; el("play").title = "Play history"; }
  function play() {
    if (playing) return stopPlay();
    if (timeAt === null) setTime(0);
    playing = true; el("play").textContent = "❚❚"; el("play").title = "Pause";
    var last = performance.now();
    (function frame(now) {
      if (!playing) return;
      var v = +el("scrub").value + (now - last) / 12000 * 1000; last = now;
      setTime(v);
      if (v >= 1000) return stopPlay();
      requestAnimationFrame(frame);
    })(last);
  }

  // ── layout ──
  var shown = new Set();
  function refresh(still) {
    var depth = +el("depth").value, around = null;
    if (depth && selected) {
      around = new Set([selected]);
      var edge = [selected];
      for (var hop = 0; hop < depth; hop++) {
        var next = [];
        edge.forEach(function (d) { d.near.forEach(function (o) { if (!around.has(o)) { around.add(o); next.push(o); } }); });
        edge = next;
      }
    }
    shown = new Set(data.nodes.filter(function (d) {
      if (hiddenTypes.has(d.type)) return false;
      if (d.wanted && !el("wanted").checked) return false;
      if (!d.degree && !el("orphans").checked) return false;
      if (!exists(d)) return false;
      return !around || around.has(d);
    }));
    el("stats").textContent = shown.size + " of " + n;
    el("tl-count").textContent = shown.size + " objects";
    if (!still) reheat(0.25);
    draw();
  }

  function tick() {
    var list = Array.from(shown), i, j, a, b, dx, dy, d2, f;
    for (i = 0; i < list.length; i++) {
      a = list[i];
      a.vx -= a.x * 0.012 * alpha; a.vy -= a.y * 0.012 * alpha;
      for (j = i + 1; j < list.length; j++) {
        b = list[j]; dx = b.x - a.x; dy = b.y - a.y; d2 = Math.max(25, dx * dx + dy * dy);
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
      // A link moves its less connected end; a hub summing every pull at full strength would diverge.
      var ds = l.s.near.size, dt = l.t.near.size, fs = f * 2 * dt / (ds + dt), ft = f * 2 * ds / (ds + dt);
      l.s.vx += dx * fs; l.s.vy += dy * fs; l.t.vx -= dx * ft; l.t.vy -= dy * ft;
    });
    list.forEach(function (d) {
      if (d === dragging) { d.vx = d.vy = 0; return; }
      d.vx *= 0.62; d.vy *= 0.62;
      var v = Math.sqrt(d.vx * d.vx + d.vy * d.vy);
      if (v > MAX_SPEED) { d.vx *= MAX_SPEED / v; d.vy *= MAX_SPEED / v; }
      d.x += d.vx; d.y += d.vy;
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
    if (el("timeline").classList.contains("open")) drawHist();
  }
  function draw() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(function () { queued = false; paint(); });
  }
  function matches(d) { return !query || d.id.toLowerCase().indexOf(query) >= 0 || d.summary.toLowerCase().indexOf(query) >= 0; }
  function arrow(l) {
    var dx = l.t.x - l.s.x, dy = l.t.y - l.s.y, d = Math.sqrt(dx * dx + dy * dy);
    if (d < l.t.r * 2) return;
    var ux = dx / d, uy = dy / d, tipX = l.t.x - ux * (l.t.r + 1.5 / view.k), tipY = l.t.y - uy * (l.t.r + 1.5 / view.k), s = 6 / view.k;
    ctx.beginPath(); ctx.moveTo(tipX, tipY);
    ctx.lineTo(tipX - ux * s - uy * s * 0.55, tipY - uy * s + ux * s * 0.55);
    ctx.lineTo(tipX - ux * s + uy * s * 0.55, tipY - uy * s - ux * s * 0.55);
    ctx.closePath(); ctx.fill();
  }
  function paint() {
    ctx.clearRect(0, 0, W, H);
    ctx.save(); ctx.translate(view.x, view.y); ctx.scale(view.k, view.k);
    var focus = hover || (selected && selected.near.size ? selected : null), now = performance.now(), flashing = false;
    var arrows = el("arrows").checked;
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
      ctx.fillStyle = ctx.strokeStyle;
      ctx.lineWidth = (on ? 1.4 : 1) / view.k;
      ctx.beginPath(); ctx.moveTo(l.s.x, l.s.y); ctx.lineTo(l.t.x, l.t.y); ctx.stroke();
      if (arrows && (on || view.k >= 0.9)) arrow(l);
    });
    shown.forEach(function (d) {
      var related = !focus || d === focus || focus.near.has(d);
      ctx.globalAlpha = (matches(d) ? 1 : 0.12) * (related ? 1 : 0.28);
      ctx.fillStyle = d.wanted ? theme["--wanted"] : color[d.type];
      ctx.beginPath(); ctx.arc(d.x, d.y, d.r, 0, 6.3); ctx.fill();
      if (d.pinned || d === selected) { ctx.strokeStyle = theme["--ink"]; ctx.lineWidth = 1.6 / view.k; ctx.stroke(); }
      if (recent(d)) {
        ctx.strokeStyle = theme["--accent"]; ctx.lineWidth = 2.5 / view.k;
        ctx.beginPath(); ctx.arc(d.x, d.y, d.r + 4 / view.k, 0, 6.3); ctx.stroke();
      }
      var age = d.flash ? now - d.flash : Infinity;
      if (age < FLASH_MS) {
        flashing = true;
        var p = age / FLASH_MS;
        ctx.globalAlpha = 1 - p; ctx.strokeStyle = theme["--accent"]; ctx.lineWidth = 2.5 / view.k;
        ctx.beginPath(); ctx.arc(d.x, d.y, d.r + (4 + 22 * ((age % 1000) / 1000)) / view.k, 0, 6.3); ctx.stroke();
        ctx.globalAlpha = 1;
      }
      if (d === selected || d === hover || age < FLASH_MS || (labelAll && matches(d))) {
        ctx.globalAlpha = (matches(d) ? 1 : 0.12) * (related ? 1 : 0.28);
        ctx.font = (d === focus || d === selected ? "600 " : "") + 11 / view.k + "px ui-monospace,monospace";
        ctx.fillStyle = theme["--ink"]; ctx.textAlign = "center"; ctx.textBaseline = "top";
        ctx.fillText(d.id.slice(d.id.indexOf("/") + 1), d.x, d.y + d.r + 3 / view.k);
      }
    });
    ctx.globalAlpha = 1; ctx.restore();
    if (flashing) draw();
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

  // ── markdown: built as DOM nodes, never parsed as HTML ──
  var FENCE = /^\s*(\x60{3,}|~{3,})\s*([\w+#.-]*)/, HEAD = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/, HR = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/, QUOTE = /^\s{0,3}>\s?/;
  var ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/, TSEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
  var INLINE = /\x60([^\x60\n]+)\x60|\[\[([^\]\n]+?)\]\]|!\[([^\]]*)\]\(([^()\s]+)(?:\s+"[^"]*")?\)|\[([^\]]+)\]\(([^()\s]+)(?:\s+"[^"]*")?\)|\*\*(?!\s)(.+?)\*\*|__(?!\s)(.+?)__|~~(.+?)~~|\*(?![\s*])(.+?)\*|(?<![\w])_(?![\s_])(.+?)_(?![\w])|<((?:https?|mailto):[^>\s]+)>/g;
  function blank(l) { return !l.trim(); }
  function indent(l) { return /^\s*/.exec(l)[0].replace(/\t/g, "    ").length; }
  function startsBlock(l) { return FENCE.test(l) || HEAD.test(l) || HR.test(l) || QUOTE.test(l) || ITEM.test(l); }
  function markdown(src, root) { blocks(src.replace(/\r\n?/g, "\n").split("\n"), root); }
  function blocks(lines, root) {
    var i = 0, m;
    while (i < lines.length) {
      var l = lines[i];
      if (blank(l)) { i++; continue; }
      if ((m = FENCE.exec(l))) {
        var fence = m[1], code = [];
        i++;
        while (i < lines.length && lines[i].trim().slice(0, fence.length) !== fence) code.push(lines[i++]);
        i++;
        var pre = h("pre"), c = h("code", null, code.join("\n"));
        if (m[2]) pre.title = m[2];
        pre.appendChild(c); root.appendChild(pre); continue;
      }
      if ((m = HEAD.exec(l))) { var hd = h("h" + m[1].length); inline(m[2], hd); root.appendChild(hd); i++; continue; }
      if (HR.test(l)) { root.appendChild(h("hr")); i++; continue; }
      if (QUOTE.test(l)) {
        var q = [];
        while (i < lines.length && (QUOTE.test(lines[i]) || (q.length && !blank(lines[i]) && !startsBlock(lines[i])))) q.push(lines[i++].replace(QUOTE, ""));
        var bq = h("blockquote"); blocks(q, bq); root.appendChild(bq); continue;
      }
      if (ITEM.test(l)) { i = list(lines, i, root); continue; }
      if (l.indexOf("|") >= 0 && i + 1 < lines.length && TSEP.test(lines[i + 1])) { i = table(lines, i, root); continue; }
      var para = [];
      while (i < lines.length && !blank(lines[i]) && !(para.length && startsBlock(lines[i]))) para.push(lines[i++]);
      var p = h("p"); inlineLines(para, p); root.appendChild(p);
    }
  }
  function inlineLines(lines, parent) {
    lines.forEach(function (l, j) {
      var hard = / {2,}$|\\$/.test(l);
      inline(l.trim().replace(/\\$/, ""), parent);
      if (j < lines.length - 1) parent.appendChild(hard ? h("br") : document.createTextNode(" "));
    });
  }
  function list(lines, i, root) {
    var first = ITEM.exec(lines[i]), base = indent(first[1]), ordered = /\d/.test(first[2]);
    var box = h(ordered ? "ol" : "ul");
    if (ordered && parseInt(first[2], 10) !== 1) box.start = parseInt(first[2], 10);
    while (i < lines.length) {
      var m = ITEM.exec(lines[i]);
      if (!m || indent(m[1]) < base || /\d/.test(m[2]) !== ordered) break;
      var li = h("li"), content = [m[3]], ci = indent(m[1]) + m[2].length + 1;
      i++;
      while (i < lines.length) {
        var l = lines[i];
        if (blank(l)) {
          if (i + 1 < lines.length && !blank(lines[i + 1]) && indent(lines[i + 1]) > base) { content.push(""); i++; continue; }
          break;
        }
        var mi = ITEM.exec(l);
        if (mi && indent(mi[1]) <= base) break;
        if (!mi && indent(l) <= base && startsBlock(l)) break;
        content.push(indent(l) > base ? l.replace(/\t/g, "    ").slice(Math.min(indent(l), ci)) : l.trim());
        i++;
      }
      var task = /^\[([ xX])\]\s+/.exec(content[0]);
      if (task) {
        content[0] = content[0].slice(task[0].length);
        var cb = h("input"); cb.type = "checkbox"; cb.disabled = true; cb.checked = task[1] !== " ";
        li.className = "task"; li.appendChild(cb);
      }
      if (content.indexOf("") < 0) {
        var k = 1;
        while (k < content.length && !startsBlock(content[k])) k++;
        inlineLines(content.slice(0, k), li);
        blocks(content.slice(k), li);
      } else blocks(content, li);
      box.appendChild(li);
      if (i + 1 < lines.length && blank(lines[i])) { var nx = ITEM.exec(lines[i + 1]); if (nx && indent(nx[1]) === base) i++; }
    }
    root.appendChild(box);
    return i;
  }
  function cells(l) { return l.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map(function (s) { return s.trim().replace(/\\\|/g, "|"); }); }
  function table(lines, i, root) {
    var head = cells(lines[i]), align = cells(lines[i + 1]).map(function (a) { return /^:-+:$/.test(a) ? "center" : /-:$/.test(a) ? "right" : ""; });
    var wrap = h("div", "table"), t = h("table"), thead = h("thead"), tr = h("tr"), tb = h("tbody");
    head.forEach(function (c, j) { var th = h("th"); if (align[j]) th.style.textAlign = align[j]; inline(c, th); tr.appendChild(th); });
    thead.appendChild(tr); t.appendChild(thead);
    i += 2;
    while (i < lines.length && !blank(lines[i]) && lines[i].indexOf("|") >= 0) {
      var row = h("tr");
      cells(lines[i]).forEach(function (c, j) { var td = h("td"); if (align[j]) td.style.textAlign = align[j]; inline(c, td); row.appendChild(td); });
      tb.appendChild(row); i++;
    }
    t.appendChild(tb); wrap.appendChild(t); root.appendChild(wrap);
    return i;
  }
  function unescape(s) { return s.replace(/\\([\\\x60*_{}\[\]()#+\-.!|~>])/g, "$1"); }
  function inline(text, parent) {
    var re = new RegExp(INLINE.source, "g"), last = 0, m, x;
    while ((m = re.exec(text))) {
      if (m.index > last) parent.appendChild(document.createTextNode(unescape(text.slice(last, m.index))));
      last = re.lastIndex;
      if (m[1] != null) parent.appendChild(h("code", null, m[1]));
      else if (m[2] != null) parent.appendChild(wiki(m[2]));
      else if (m[3] != null) { x = href(m[4]); x.textContent = "image: " + (m[3] || m[4]); parent.appendChild(x); }
      else if (m[5] != null) { x = href(m[6]); inline(m[5], x); parent.appendChild(x); }
      else if (m[7] != null || m[8] != null) { x = h("strong"); inline(m[7] != null ? m[7] : m[8], x); parent.appendChild(x); }
      else if (m[9] != null) { x = h("del"); inline(m[9], x); parent.appendChild(x); }
      else if (m[10] != null || m[11] != null) { x = h("em"); inline(m[10] != null ? m[10] : m[11], x); parent.appendChild(x); }
      else if (m[12] != null) { x = href(m[12]); x.textContent = m[12].replace(/^mailto:/, ""); parent.appendChild(x); }
    }
    if (last < text.length) parent.appendChild(document.createTextNode(unescape(text.slice(last))));
  }
  /** A link: to an object when it names one's file, to the web for http(s) and mailto, otherwise plain text. */
  function href(url) {
    var file = /([a-z0-9]+(?:-[a-z0-9]+)*)\/([a-z0-9]+(?:-[a-z0-9]+)*)\.md(?:#.*)?$/.exec(url);
    if (file && byId[file[1] + "/" + file[2]]) { var w = wiki(file[1] + "/" + file[2]); w.textContent = ""; return w; }
    if (!/^(https?|mailto):/i.test(url)) return h("span");
    var a = h("a", "ext"); a.href = url; a.target = "_blank"; a.rel = "noopener noreferrer"; a.title = url;
    return a;
  }
  function wiki(raw) {
    var bar = raw.indexOf("|"), target = raw.split("|")[0].split("#")[0].trim(), label = bar >= 0 ? raw.slice(bar + 1).trim() : raw.trim();
    var d = byId[target], a = h("a", "wiki" + (d && !d.wanted ? "" : " missing"), label);
    a.href = "#" + encodeURIComponent(target);
    if (d) { a.style.setProperty("--c", color[d.type]); a.title = d.wanted ? "Linked, but not written yet" : d.summary; }
    else a.title = "Not in the store";
    a.addEventListener("click", function (e) { e.preventDefault(); if (d) navigate(d); });
    return a;
  }

  // ── detail ──
  function selectedHash() { try { return decodeURIComponent(location.hash.slice(1)); } catch (e) { return ""; } }
  function setHash(d, push) {
    try {
      var url = location.pathname + location.search + (d ? "#" + encodeURIComponent(d.id) : "");
      if (push) window.history.pushState(null, "", url); else window.history.replaceState(null, "", url);
    } catch (e) {}
  }
  function navigate(d) {
    setHash(d, true);
    select(d, { keepHash: true });
    if (!el("detail").classList.contains("full")) flyTo(d, Math.max(view.k, 1));
    else el("detail").scrollTop = 0;
  }
  function chip(text, dot) {
    var c = h("span", "chip");
    if (dot) { var s = h("span", "dot"); s.style.background = dot; s.style.width = s.style.height = "8px"; c.appendChild(s); }
    c.appendChild(document.createTextNode(text));
    return c;
  }
  function nearList(title, set) {
    var box = h("div");
    box.appendChild(h("h3", null, title + " (" + set.size + ")"));
    Array.from(set).sort(function (a, b) { return a.id < b.id ? -1 : 1; }).forEach(function (o) {
      var b = h("button"), dot = h("span", "dot"), text = h("span");
      dot.style.background = o.wanted ? theme["--wanted"] : color[o.type];
      text.append(h("b", null, o.id), document.createTextNode(" "), h("span", "s", o.wanted ? "not written yet" : o.summary));
      b.append(dot, text);
      b.addEventListener("click", function () { navigate(o); });
      box.appendChild(b);
    });
    return box;
  }
  function renderDetail(d) {
    el("chips").textContent = "";
    el("chips").append(chip(d.type, d.wanted ? theme["--wanted"] : color[d.type]));
    if (d.layer) el("chips").append(chip(d.layer));
    if (d.pinned) el("chips").append(chip("pinned"));
    if (d.wanted) el("chips").append(chip("wanted"));
    el("title").textContent = d.id;
    el("summary").textContent = d.wanted ? "Linked, but not written yet." : d.summary;
    var parts = [];
    if (d.created) parts.push("created " + d.created);
    if (d.updated) parts.push("updated " + d.updated);
    var changes = events.filter(function (e) { return e.id === d.id; }).length;
    if (changes) parts.push(changes + (changes === 1 ? " logged change" : " logged changes"));
    el("meta").textContent = parts.join(" · ");
    el("path").textContent = d.path || "";
    var fields = el("fields"); fields.textContent = "";
    (d.fields || []).forEach(function (f) {
      var dd = h("dd");
      f[1].forEach(function (v) {
        var span = h("span");
        if (byId[v]) span.appendChild(wiki(v)); else inline(v, span);
        dd.appendChild(span);
      });
      fields.append(h("dt", null, f[0]), dd);
    });
    var body = el("body"); body.textContent = "";
    if (d.body) markdown(d.body, body);
    el("trunc").hidden = !d.truncated;
    var near = el("near"); near.textContent = "";
    if (d.out.size) near.appendChild(nearList("Links to", d.out));
    if (d.inn.size) near.appendChild(nearList("Linked from", d.inn));
    near.hidden = !d.near.size;
  }
  function select(d, opts) {
    opts = opts || {};
    selected = d;
    el("detail").classList.toggle("open", !!d);
    if (d) renderDetail(d); else reader(false);
    if (!opts.keepHash) setHash(d, false);
    if (+el("depth").value) refresh(); else draw();
  }
  function reader(on) {
    var box = el("detail");
    on = on == null ? !box.classList.contains("full") : on;
    if (on && !selected) return;
    box.classList.toggle("full", on);
    el("expand").setAttribute("aria-pressed", String(on));
    el("expand").textContent = on ? "↙" : "↗";
    el("expand").title = on ? "Back to the graph (f)" : "Read full screen (f)";
    if (on) box.scrollTop = 0;
  }

  // ── input ──
  canvas.addEventListener("pointerdown", function (e) {
    canvas.setPointerCapture(e.pointerId); moved = false; anim = null;
    var d = pick(e);
    if (d) { dragging = d; reheat(0.3); } else panning = { x: e.clientX - view.x, y: e.clientY - view.y };
    canvas.classList.add("drag");
  });
  canvas.addEventListener("pointermove", function (e) {
    if (dragging) { var p = toWorld(e); dragging.x = p.x; dragging.y = p.y; moved = true; reheat(0.3); draw(); return; }
    if (panning) { view.x = e.clientX - panning.x; view.y = e.clientY - panning.y; moved = true; draw(); return; }
    var hv = pick(e);
    if (hv !== hover) { hover = hv; canvas.style.cursor = hv ? "pointer" : ""; draw(); }
  });
  function release() {
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
    if (d) { select(d); reader(true); } else zoomBy(2, e.clientX, e.clientY);
  });
  el("zoom-in").addEventListener("click", function () { zoomBy(1.6, W / 2, H / 2); });
  el("zoom-out").addEventListener("click", function () { zoomBy(1 / 1.6, W / 2, H / 2); });
  el("zoom-fit").addEventListener("click", function () { fit(true); });
  el("history").addEventListener("click", function () { toggleTimeline(); });
  el("fullscreen").addEventListener("click", function () {
    if (document.fullscreenElement) document.exitFullscreen();
    else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(function () {});
  });
  document.addEventListener("fullscreenchange", function () { el("fullscreen").setAttribute("aria-pressed", String(!!document.fullscreenElement)); });
  el("q").addEventListener("keydown", function (e) {
    if (e.key !== "Enter") return;
    var hit = Array.from(shown).filter(matches)[0];
    if (hit) { navigate(hit); el("q").blur(); }
  });
  el("q").addEventListener("input", function (e) { query = e.target.value.trim().toLowerCase(); draw(); });
  el("depth").addEventListener("change", function () { refresh(); });
  el("size").addEventListener("change", function (e) {
    sizeByLinks = e.target.checked;
    data.nodes.forEach(function (d) { d.r = radius(d); });
    draw();
  });
  el("wanted").addEventListener("change", function () { refresh(); });
  el("orphans").addEventListener("change", function () { refresh(); });
  el("arrows").addEventListener("change", draw);
  el("close").addEventListener("click", function () { select(null); });
  el("expand").addEventListener("click", function () { reader(); });
  el("copy").addEventListener("click", function () {
    if (!selected || !navigator.clipboard) return;
    navigator.clipboard.writeText(selected.id).then(function () { el("copy").textContent = "✓"; setTimeout(function () { el("copy").textContent = "⧉"; }, 1200); }, function () {});
  });
  el("scrub").addEventListener("input", function (e) { stopPlay(); setTime(+e.target.value); });
  el("play").addEventListener("click", play);
  el("tl-now").addEventListener("click", function () { stopPlay(); setTime(1000); });
  el("tl-close").addEventListener("click", function () { toggleTimeline(false); });
  addEventListener("keydown", function (e) {
    var typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName) && document.activeElement.type !== "checkbox" && document.activeElement.type !== "range";
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "/" && !typing) { e.preventDefault(); reader(false); el("q").focus(); el("q").select(); return; }
    if (e.key === "Escape") {
      if (typing) { document.activeElement.blur(); return; }
      if (el("detail").classList.contains("full")) reader(false);
      else if (selected) select(null);
      else if (el("timeline").classList.contains("open")) toggleTimeline(false);
      return;
    }
    if (typing) return;
    if (e.key === "f") reader();
    else if (e.key === "t") toggleTimeline();
    else if (el("detail").classList.contains("full")) return;
    else if (e.key === "+" || e.key === "=") zoomBy(1.6, W / 2, H / 2);
    else if (e.key === "-") zoomBy(1 / 1.6, W / 2, H / 2);
    else if (e.key === "0") fit(true);
  });
  addEventListener("popstate", function () {
    var d = byId[selectedHash()] || null;
    select(d, { keepHash: true });
    if (d && !el("detail").classList.contains("full")) flyTo(d, Math.max(view.k, 1));
  });
  addEventListener("resize", resize);
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function () { readTheme(); draw(); if (selected) renderDetail(selected); });

  // ── live updates from o6y graph --live ──
  function setLive(on, text) { el("live").hidden = false; el("live").classList.toggle("off", !on); el("live-text").textContent = text; }
  if (LIVE && window.EventSource) {
    var source = new EventSource("events"), loading = false, again = false;
    var pull = function () {
      if (loading) { again = true; return; }
      loading = true;
      fetch("data", { cache: "no-store" }).then(function (r) { return r.json(); }).then(function (next) {
        var id = selected && selected.id, scroll = el("detail").scrollTop;
        ingest(next, false);
        selected = id ? byId[id] || null : null;
        if (id && !selected) select(null);
        else if (selected) { renderDetail(selected); el("detail").scrollTop = scroll; }
        refresh(timeAt !== null);
        setLive(true, "live · " + new Date().toLocaleTimeString(undefined, { timeStyle: "short" }));
      }).catch(function (e) { console.error("o6y: update failed", e); }).then(function () { loading = false; if (again) { again = false; pull(); } });
    };
    source.addEventListener("change", pull);
    source.addEventListener("open", function () { setLive(true, "live"); });
    source.addEventListener("error", function () { setLive(false, "reconnecting"); });
  }

  readTheme();
  ingest({ nodes: data.nodes, links: data.links, types: data.types, events: data.events }, true);
  shown = new Set(data.nodes);
  el("stats").textContent = n + " of " + n;
  W = innerWidth; H = innerHeight;
  settle(); fit(); resize();
  var start = byId[selectedHash()] || (FOCUS && byId[FOCUS]);
  if (start) { select(start, { keepHash: true }); setHash(start, false); flyTo(start, Math.max(view.k, 1)); }
})();
</script>
</body>
</html>
`;
function graphJson(data, extra = {}) {
  return JSON.stringify({ ...data, ...extra }).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}
function renderGraphHtml(data, focus, live = false) {
  const json = graphJson(data, { focus, ...live ? { live: true } : {} });
  return PAGE.replace("__DATA__", () => json);
}

export { readEvents, graphData, adjacency, graphJson, renderGraphHtml };
