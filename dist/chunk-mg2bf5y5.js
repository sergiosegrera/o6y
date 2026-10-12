#!/usr/bin/env node
import {
  Store,
  displayPath,
  neighbors
} from "./chunk-v9wsvhaf.js";

// src/viewer/run.tsx
import { spawnSync } from "node:child_process";
import { render } from "ink";

// src/viewer/app.tsx
import { Box, Text, useApp, useInput, useWindowSize } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// src/viewer/model.ts
import { stringify } from "yaml";
function matches(store, id, query) {
  if (!query)
    return true;
  const q = query.toLowerCase();
  const obj = store.objects.get(id);
  if (id.toLowerCase().includes(q))
    return true;
  if (!obj)
    return false;
  return obj.summary.toLowerCase().includes(q) || obj.body.toLowerCase().includes(q);
}
function treeRows(store, query = "") {
  const rows = [];
  const types = [...store.types.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const type of types) {
    const objects = store.objectsOfType(type.name).filter((o) => matches(store, o.id, query));
    if (query && !objects.length)
      continue;
    rows.push({ kind: "type", name: type.name, count: objects.length, layer: type.layer.name });
    for (const obj of objects)
      rows.push({ kind: "object", id: obj.id, obj });
  }
  const wanted = [...store.wanted].filter(([id]) => matches(store, id, query)).sort(([a], [b]) => a.localeCompare(b));
  if (wanted.length) {
    rows.push({ kind: "wanted-header", count: wanted.length });
    for (const [id, sources] of wanted)
      rows.push({ kind: "wanted", id, sources: sources.size });
  }
  return rows;
}
var selectable = (row) => row.kind === "object" || row.kind === "wanted";
function truncate(text, width) {
  if (width <= 0)
    return "";
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`;
}
function wrap(text, width) {
  if (width <= 0)
    return [text];
  if (text.length <= width)
    return [text];
  const indent = /^\s*(?:[-*] |\d+\. )?/.exec(text)[0].replace(/\S/g, " ");
  const out = [];
  let line = "";
  for (const word of text.split(/(\s+)/)) {
    if (!word)
      continue;
    if ((line + word).length <= width) {
      line += word;
      continue;
    }
    if (line.trim())
      out.push(line.trimEnd());
    line = /^\s+$/.test(word) ? indent : indent + word;
    while (line.length > width) {
      out.push(line.slice(0, width));
      line = indent + line.slice(width);
    }
  }
  if (line.trim())
    out.push(line.trimEnd());
  return out.length ? out : [""];
}
var LINK_RE = /\[\[([^\]\n]+?)\]\]/g;
function linkSegs(store, text, base = { text: "" }) {
  const segs = [];
  let last = 0;
  for (const m of text.matchAll(LINK_RE)) {
    if (m.index > last)
      segs.push({ ...base, text: text.slice(last, m.index) });
    const target = m[1].split("|")[0].split("#")[0].trim();
    segs.push({ ...base, text: m[0], color: store.objects.has(target) ? "cyan" : "red", underline: true });
    last = m.index + m[0].length;
  }
  if (last < text.length)
    segs.push({ ...base, text: text.slice(last) });
  return segs.length ? segs : [{ ...base, text: "" }];
}
var BLOCK_START = /^\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|>|```|~~~|\||$)/;
function joinParagraphs(lines) {
  const out = [];
  let fence = false;
  let joinable = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line))
      fence = !fence;
    const continuation = !fence && joinable && line.trim() !== "" && !BLOCK_START.test(line);
    if (continuation)
      out[out.length - 1] += ` ${line.trim()}`;
    else
      out.push(line);
    joinable = !fence && line.trim() !== "" && !/^\s*(#{1,6}\s|```|~~~|\|)/.test(line) && !line.endsWith("  ");
  }
  return out;
}
function markdownLines(store, body, width) {
  const lines = [];
  let fence = false;
  for (const raw of joinParagraphs(body.replace(/\s+$/, "").split(`
`))) {
    if (/^\s*(```|~~~)/.test(raw)) {
      fence = !fence;
      lines.push([{ text: raw, dim: true }]);
      continue;
    }
    if (fence) {
      for (const w of wrap(raw, width))
        lines.push([{ text: w, color: "yellow" }]);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(raw);
    if (heading) {
      for (const w of wrap(heading[2], width))
        lines.push([{ text: w, bold: true, color: "magenta" }]);
      continue;
    }
    const quote = /^>\s?/.test(raw);
    for (const w of wrap(raw, width)) {
      const segs = linkSegs(store, w, quote ? { text: "", dim: true } : { text: "" });
      lines.push(segs.flatMap((s) => boldSegs(s)));
    }
  }
  return lines;
}
function boldSegs(seg) {
  if (seg.color || !seg.text.includes("**"))
    return [seg];
  return seg.text.split(/(\*\*[^*]+\*\*)/).filter(Boolean).map((part) => /^\*\*[^*]+\*\*$/.test(part) ? { ...seg, text: part.slice(2, -2), bold: true } : { ...seg, text: part });
}
function formatField(value) {
  if (value instanceof Date)
    return value.toISOString().slice(0, 10);
  if (Array.isArray(value))
    return value.map((v) => Array.isArray(v) ? `[[${v.flat().join("")}]]` : String(v)).join(", ");
  if (value && typeof value === "object")
    return stringify(value).trim();
  return String(value);
}
function renderPage(store, id, width, changed) {
  const obj = store.objects.get(id);
  const lines = [];
  const nb = neighbors(store, id);
  if (!obj) {
    lines.push([{ text: id, bold: true, color: "red" }]);
    lines.push([{ text: "Wanted page: linked but not written yet.", dim: true }]);
  } else {
    const type = store.types.get(obj.type);
    const tags = [{ text: ` ${obj.layer.name}`, dim: true }];
    if (obj.pinned)
      tags.push({ text: " pinned", color: "yellow" });
    if (changed?.has(id))
      tags.push({ text: " changed", color: "green" });
    lines.push([{ text: id, bold: true, color: "cyan" }, ...tags]);
    for (const w of wrap(obj.summary || "(no summary)", width))
      lines.push([{ text: w, italic: true }]);
    lines.push([{ text: displayPath(obj.path), dim: true }]);
    const fields = Object.entries(obj.data).filter(([k]) => k !== "summary" && k !== "pinned");
    if (fields.length) {
      lines.push([]);
      const keyWidth = Math.min(16, Math.max(...fields.map(([k]) => k.length)));
      for (const [key, value] of fields) {
        const declared = !!type?.schema.fields[key];
        const text = formatField(value);
        const isLink = type?.schema.fields[key]?.type === "link";
        const shown = isLink ? text.split(", ").map((t) => t.startsWith("[[") ? t : `[[${t}]]`).join(", ") : text;
        const valueLines = wrap(shown, Math.max(10, width - keyWidth - 2));
        valueLines.forEach((v, i) => {
          const keySeg = i === 0 ? { text: key.padEnd(keyWidth) + "  ", color: declared ? "blue" : "gray" } : { text: " ".repeat(keyWidth + 2) };
          lines.push([keySeg, ...linkSegs(store, v)]);
        });
      }
    }
    if (obj.body.trim()) {
      lines.push([{ text: "─".repeat(Math.max(0, width)), dim: true }]);
      lines.push(...markdownLines(store, obj.body, width));
    }
    const issues = store.issuesFor(obj.path).filter((i) => i.severity !== "info");
    if (issues.length) {
      lines.push([]);
      for (const i of issues) {
        for (const w of wrap(`${i.severity}: ${i.message}`, width)) {
          lines.push([{ text: w, color: i.severity === "error" ? "red" : "yellow" }]);
        }
      }
    }
  }
  const links = [];
  const linkLines = [];
  const section = (title, edges, arrow) => {
    if (!edges.length)
      return;
    lines.push([], [{ text: `${title} (${edges.length})`, bold: true }]);
    for (const e of edges) {
      links.push(e.id);
      linkLines.push(lines.length);
      const summary = store.objects.get(e.id)?.summary ?? "not written yet";
      const head = `${arrow} ${e.id}`;
      const via = ` (${e.via.join(", ")})`;
      lines.push([
        { text: head, color: e.missing ? "red" : "cyan" },
        { text: via, dim: true },
        { text: truncate(` — ${summary}`, Math.max(0, width - head.length - via.length)), dim: true }
      ]);
    }
  };
  section("Links", nb.out, "→");
  section("Backlinks", nb.in, "←");
  return { lines, links, linkLines };
}
function linkTree(store, root, expanded) {
  const rows = [];
  const childrenOf = (id, parent) => {
    const nb = neighbors(store, id);
    const incoming = new Map(nb.in.map((e) => [e.id, e]));
    const children = [];
    for (const e of nb.out) {
      const back = incoming.get(e.id);
      if (back)
        incoming.delete(e.id);
      children.push(back ? { e: { ...e, via: [...new Set([...e.via, ...back.via])] }, dir: "both" } : { e, dir: "out" });
    }
    for (const e of incoming.values())
      children.push({ e, dir: "in" });
    return children.filter((c) => c.e.id !== parent);
  };
  const visit = (id, key, depth, dir, via, last, ancestors) => {
    const cycle = ancestors.includes(id);
    const children = cycle ? [] : childrenOf(id, ancestors[ancestors.length - 1]);
    const isOpen = expanded.has(key) && children.length > 0;
    rows.push({
      key,
      id,
      depth,
      dir,
      via,
      missing: !store.objects.has(id),
      cycle,
      expandable: children.length > 0,
      expanded: isOpen,
      last
    });
    if (!isOpen)
      return;
    const next = [...ancestors, id];
    children.forEach(({ e, dir: d }, i) => visit(e.id, `${key}>${d}:${e.id}`, depth + 1, d, e.via, [...last, i === children.length - 1], next));
  };
  visit(root, root, 0, "root", [], [true], []);
  return rows;
}
function treeLine(store, node, width, selected, changed) {
  let guides = "";
  for (let d = 1;d < node.depth; d++)
    guides += node.last[d] ? "   " : "│  ";
  if (node.depth > 0)
    guides += node.last[node.depth] ? "└─ " : "├─ ";
  const marker = node.cycle ? "↺ " : node.expandable ? node.expanded ? "▾ " : "▸ " : "  ";
  const arrow = { root: "", out: "→ ", in: "← ", both: "↔ " }[node.dir];
  const color = node.missing ? "red" : node.dir === "root" ? "green" : "cyan";
  const used = guides.length + marker.length + arrow.length;
  const id = truncate(node.id, Math.max(4, width - used));
  const segs = [
    { text: guides, dim: true },
    { text: marker, color: node.cycle ? "gray" : "yellow" },
    { text: arrow, dim: true },
    { text: id, color, bold: selected || node.dir === "root", inverse: selected, dim: node.cycle }
  ];
  if (changed?.has(node.id))
    segs.push({ text: " •", color: "green" });
  const room = width - used - id.length - (changed?.has(node.id) ? 2 : 0);
  const summary = node.cycle ? "(already above)" : store.objects.get(node.id)?.summary ?? "not written yet";
  if (room > 12)
    segs.push({ text: truncate(` — ${summary}`, room), dim: true });
  return segs;
}

// src/viewer/watch.ts
import { existsSync, readdirSync, statSync, watch } from "node:fs";
import { join } from "node:path";
function signature(dir, depth = 0) {
  if (depth > 2)
    return "";
  let out = "";
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return "";
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory())
      out += `${full}/
${signature(full, depth + 1)}`;
    else {
      try {
        const s = statSync(full);
        out += `${full}:${s.size}:${s.mtimeMs}
`;
      } catch {}
    }
  }
  return out;
}
function watchStores(layers, onChange, pollMs = 1500) {
  let timer;
  const fire = () => {
    clearTimeout(timer);
    timer = setTimeout(onChange, 80);
  };
  const watchers = [];
  for (const layer of layers) {
    if (!existsSync(layer.root))
      continue;
    try {
      watchers.push(watch(layer.root, { recursive: true }, fire));
    } catch {}
  }
  let last = layers.map((l) => signature(l.root)).join("\x00");
  const poll = setInterval(() => {
    const now = layers.map((l) => signature(l.root)).join("\x00");
    if (now !== last) {
      last = now;
      fire();
    }
  }, pollMs);
  return () => {
    clearTimeout(timer);
    clearInterval(poll);
    for (const w of watchers)
      w.close();
  };
}

// src/viewer/app.tsx
import { jsx, jsxs, Fragment } from "react/jsx-runtime";
var CHANGED_MS = 6000;
function LineView({ line }) {
  return /* @__PURE__ */ jsx(Text, {
    wrap: "truncate",
    children: line.length ? line.map((s, i) => /* @__PURE__ */ jsx(Text, {
      color: s.color,
      bold: s.bold,
      italic: s.italic,
      dimColor: s.dim,
      inverse: s.inverse,
      underline: s.underline,
      children: s.text
    }, i)) : " "
  });
}
function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}
function App({ layers, initial, onEdit }) {
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();
  const [store, setStore] = useState(() => Store.load(layers));
  const [loadedAt, setLoadedAt] = useState(() => new Date);
  const [changed, setChanged] = useState(new Map);
  const [view, setView] = useState(initial.view);
  const [current, setCurrent] = useState(initial.current);
  const [history, setHistory] = useState(initial.history);
  const [focus, setFocus] = useState("list");
  const [linkIdx, setLinkIdx] = useState(0);
  const [scroll, setScroll] = useState(0);
  const [filter, setFilter] = useState(initial.filter);
  const [searching, setSearching] = useState(false);
  const [expanded, setExpanded] = useState(new Set);
  const [treeCursor, setTreeCursor] = useState();
  const treeMemory = useRef(new Map);
  const lastIndex = useRef(0);
  const reload = useCallback(() => {
    setStore((prev) => {
      const next = Store.load(layers);
      const now = Date.now();
      const fresh = [];
      for (const [id2, obj] of next.objects) {
        const before = prev.objects.get(id2);
        if (!before || before.mtimeMs !== obj.mtimeMs)
          fresh.push(id2);
      }
      if (fresh.length) {
        setChanged((m) => {
          const copy = new Map([...m].filter(([, t]) => now - t < CHANGED_MS));
          for (const id2 of fresh)
            copy.set(id2, now);
          return copy;
        });
      }
      return next;
    });
    setLoadedAt(new Date);
  }, [layers]);
  useEffect(() => watchStores(layers, reload), [layers, reload]);
  useEffect(() => {
    if (!changed.size)
      return;
    const t = setTimeout(() => setChanged((m) => new Map([...m].filter(([, at]) => Date.now() - at < CHANGED_MS))), 1000);
    return () => clearTimeout(t);
  }, [changed]);
  const changedIds = useMemo(() => new Set(changed.keys()), [changed]);
  const bodyHeight = Math.max(3, rows - 2);
  const innerHeight = bodyHeight - 2;
  const narrow = columns < 80;
  const leftWidth = narrow ? columns - 2 : clamp(Math.floor(columns * 0.3), 24, 44);
  const rightWidth = narrow ? Math.max(10, columns - 4) : Math.max(10, columns - leftWidth - 6);
  const tree = useMemo(() => treeRows(store, filter), [store, filter]);
  const ids = useMemo(() => tree.filter(selectable).map((r) => r.id), [tree]);
  let cursor = current ? tree.findIndex((r) => selectable(r) && r.id === current) : -1;
  const exists = (id2) => store.objects.has(id2) || store.wanted.has(id2);
  const selected = current && exists(current) && (cursor >= 0 || view === "tree") ? current : undefined;
  if (!selected) {
    const sel = tree.map((r, i) => [r, i]).filter(([r]) => selectable(r));
    const pick = sel.find(([, i]) => i >= lastIndex.current) ?? sel[sel.length - 1];
    cursor = pick ? pick[1] : -1;
  }
  const id = selected ?? (cursor >= 0 ? tree[cursor].id : undefined);
  if (cursor >= 0)
    lastIndex.current = cursor;
  const page = useMemo(() => id ? renderPage(store, id, rightWidth, changedIds) : undefined, [store, id, rightWidth, changedIds]);
  const openKeys = useMemo(() => id && !expanded.size ? new Set([id]) : expanded, [id, expanded]);
  const nodes = useMemo(() => id && view === "tree" ? linkTree(store, id, openKeys) : [], [store, id, openKeys, view]);
  const nodeIndex = Math.max(0, nodes.findIndex((n) => n.key === treeCursor));
  const node = nodes[nodeIndex];
  const go = (target, push = true) => {
    if (target === id)
      return;
    if (push && id)
      setHistory((h) => [...h.slice(-49), id]);
    setCurrent(target);
    setLinkIdx(0);
    setScroll(0);
    if (id)
      treeMemory.current.set(id, { expanded, cursor: treeCursor });
    const saved = treeMemory.current.get(target);
    setExpanded(saved?.expanded ?? new Set);
    setTreeCursor(saved?.cursor);
    if (filter && !treeRows(store, filter).some((r) => selectable(r) && r.id === target))
      setFilter("");
  };
  const back = () => {
    const prev = history[history.length - 1];
    if (!prev)
      return;
    setHistory((h) => h.slice(0, -1));
    go(prev, false);
  };
  const moveList = (delta) => {
    if (!ids.length)
      return;
    const i = id ? ids.indexOf(id) : -1;
    const next = ids[clamp(i + delta, 0, ids.length - 1)];
    if (next !== id) {
      setCurrent(next);
      setLinkIdx(0);
      setScroll(0);
    }
  };
  const ensureVisible = (line) => {
    if (line < scroll)
      setScroll(line);
    else if (line >= scroll + innerHeight)
      setScroll(line - innerHeight + 1);
  };
  const maxScroll = Math.max(0, (page?.lines.length ?? 0) - innerHeight);
  const edit = () => {
    const obj = id ? store.objects.get(id) : undefined;
    if (!obj)
      return;
    onEdit(obj.path, { current: id, view, history, filter });
    exit();
  };
  useInput((input, key) => {
    if (searching) {
      if (key.escape) {
        setSearching(false);
        setFilter("");
      } else if (key.return)
        setSearching(false);
      else if (key.backspace || key.delete)
        setFilter((f) => f.slice(0, -1));
      else if (key.downArrow)
        moveList(1);
      else if (key.upArrow)
        moveList(-1);
      else if (input && !key.ctrl && !key.meta)
        setFilter((f) => f + input);
      return;
    }
    if (input.length > 1 && !key.ctrl && !key.meta) {
      if (input.startsWith("/")) {
        setSearching(true);
        setView("browse");
        setFocus("list");
        setFilter(input.slice(1));
        return;
      }
      if (/^[jk]+$/.test(input) && view === "browse" && focus === "list") {
        return moveList([...input].reduce((n2, ch) => n2 + (ch === "j" ? 1 : -1), 0));
      }
      input = input[input.length - 1];
    }
    if (input === "q")
      return exit();
    if (input === "/") {
      setSearching(true);
      setView("browse");
      setFocus("list");
      return;
    }
    if (input === "t" || input === "g" || input === "2")
      return setView(view === "tree" && input !== "2" ? "browse" : "tree");
    if (input === "1")
      return setView("browse");
    if (input === "e")
      return edit();
    if (input === "r")
      return reload();
    if (input === "b" || key.backspace || key.delete)
      return back();
    if (view === "tree") {
      const toggle = (key2, open) => setExpanded((prev) => {
        const next = new Set(prev.size || !id ? prev : [id]);
        if (open)
          next.add(key2);
        else
          next.delete(key2);
        return next;
      });
      if (!node)
        return key.escape ? setView("browse") : undefined;
      if (key.downArrow || input === "j")
        setTreeCursor(nodes[Math.min(nodes.length - 1, nodeIndex + 1)].key);
      else if (key.upArrow || input === "k")
        setTreeCursor(nodes[Math.max(0, nodeIndex - 1)].key);
      else if (key.rightArrow || input === "l") {
        if (node.expandable && !node.expanded)
          toggle(node.key, true);
        else if (node.expanded)
          setTreeCursor(nodes[nodeIndex + 1]?.key);
      } else if (key.leftArrow || input === "h") {
        if (node.expanded)
          toggle(node.key, false);
        else if (node.depth > 0)
          setTreeCursor(node.key.slice(0, node.key.lastIndexOf(">")));
      } else if (input === " ") {
        if (node.expandable)
          toggle(node.key, !node.expanded);
      } else if (key.return) {
        if (node.depth > 0)
          go(node.id);
      } else if (input === "o" || key.tab) {
        if (node.id !== id)
          go(node.id);
        setView("browse");
        if (narrow)
          setFocus("page");
      } else if (input === "x") {
        setExpanded(new Set);
        setTreeCursor(undefined);
      } else if (key.escape)
        setView("browse");
      return;
    }
    if (key.tab)
      return setFocus(focus === "list" ? "page" : "list");
    if (key.pageDown || input === " " || key.ctrl && input === "d")
      return setScroll((s) => Math.min(maxScroll, s + innerHeight - 2));
    if (key.pageUp || key.ctrl && input === "u")
      return setScroll((s) => Math.max(0, s - innerHeight + 2));
    if (focus === "list") {
      if (key.downArrow || input === "j")
        moveList(1);
      else if (key.upArrow || input === "k")
        moveList(-1);
      else if (input === "J")
        setScroll((s) => Math.min(maxScroll, s + 1));
      else if (input === "K")
        setScroll((s) => Math.max(0, s - 1));
      else if (key.return || key.rightArrow || input === "l") {
        if (narrow)
          setFocus("page");
        else if (page?.links.length) {
          setFocus("page");
          ensureVisible(page.linkLines[linkIdx] ?? 0);
        }
      } else if (key.escape && filter)
        setFilter("");
      return;
    }
    const n = page?.links.length ?? 0;
    if (key.escape || key.leftArrow || input === "h")
      setFocus("list");
    else if (input === "J" || (key.downArrow || input === "j") && !n)
      setScroll((s) => Math.min(maxScroll, s + 1));
    else if (input === "K" || (key.upArrow || input === "k") && !n)
      setScroll((s) => Math.max(0, s - 1));
    else if ((key.downArrow || input === "j") && n) {
      const i = (linkIdx + 1) % n;
      setLinkIdx(i);
      ensureVisible(page.linkLines[i]);
    } else if ((key.upArrow || input === "k") && n) {
      const i = (linkIdx - 1 + n) % n;
      setLinkIdx(i);
      ensureVisible(page.linkLines[i]);
    } else if (key.return && n)
      go(page.links[linkIdx]);
  });
  const errors = store.errors().length;
  const warnings = store.issues.filter((i) => i.severity === "warning").length;
  const stores = layers.map((l) => `${l.name} ${displayPath(l.root)}`).join("  ");
  const time = loadedAt.toLocaleTimeString([], { hour12: false });
  const header = /* @__PURE__ */ jsxs(Box, {
    width: columns,
    children: [
      /* @__PURE__ */ jsx(Box, {
        flexGrow: 1,
        flexShrink: 1,
        overflow: "hidden",
        children: /* @__PURE__ */ jsxs(Text, {
          wrap: "truncate",
          children: [
            /* @__PURE__ */ jsx(Text, {
              inverse: true,
              bold: true,
              color: "cyan",
              children: " o6y "
            }),
            /* @__PURE__ */ jsx(Text, {
              children: " "
            }),
            /* @__PURE__ */ jsx(Text, {
              inverse: view === "browse",
              bold: view === "browse",
              children: narrow ? " 1 " : " 1 browse "
            }),
            /* @__PURE__ */ jsx(Text, {
              inverse: view === "tree",
              bold: view === "tree",
              children: narrow ? " 2 " : " 2 tree "
            }),
            narrow ? null : /* @__PURE__ */ jsxs(Text, {
              dimColor: true,
              children: [
                "  ",
                stores
              ]
            })
          ]
        })
      }),
      /* @__PURE__ */ jsx(Box, {
        flexShrink: 0,
        children: narrow ? /* @__PURE__ */ jsxs(Text, {
          children: [
            /* @__PURE__ */ jsxs(Text, {
              children: [
                " ",
                store.objects.size,
                " · "
              ]
            }),
            /* @__PURE__ */ jsxs(Text, {
              color: errors ? "red" : "green",
              children: [
                errors,
                "e"
              ]
            }),
            /* @__PURE__ */ jsx(Text, {
              children: " "
            }),
            /* @__PURE__ */ jsxs(Text, {
              color: warnings ? "yellow" : undefined,
              children: [
                warnings,
                "w"
              ]
            }),
            /* @__PURE__ */ jsxs(Text, {
              dimColor: true,
              children: [
                " ⟳",
                time.slice(0, 5)
              ]
            }),
            changed.size ? /* @__PURE__ */ jsxs(Text, {
              color: "green",
              children: [
                " •",
                changed.size
              ]
            }) : null
          ]
        }) : /* @__PURE__ */ jsxs(Text, {
          children: [
            /* @__PURE__ */ jsxs(Text, {
              children: [
                "  ",
                store.objects.size,
                " objects · ",
                store.types.size,
                " types · "
              ]
            }),
            /* @__PURE__ */ jsxs(Text, {
              color: errors ? "red" : "green",
              children: [
                errors,
                " err"
              ]
            }),
            /* @__PURE__ */ jsx(Text, {
              children: " · "
            }),
            /* @__PURE__ */ jsxs(Text, {
              color: warnings ? "yellow" : undefined,
              children: [
                warnings,
                " warn"
              ]
            }),
            /* @__PURE__ */ jsxs(Text, {
              dimColor: true,
              children: [
                " · ⟳ ",
                time
              ]
            }),
            changed.size ? /* @__PURE__ */ jsxs(Text, {
              color: "green",
              children: [
                " (",
                changed.size,
                " changed)"
              ]
            }) : null
          ]
        })
      })
    ]
  });
  const footerText = searching ? null : narrow ? view === "tree" ? "↑↓ · →← open/close · ⏎ root · o page · b" : focus === "list" ? "↑↓ · ⏎ open · t tree · / find · b back · q" : "↑↓ link · ⏎ go · J/K␣ scroll · ← list · e edit" : view === "tree" ? "↑↓ move  →/l expand  ←/h collapse  space toggle  enter make root  o open page  x collapse all  b back  q quit" : focus === "list" ? "↑↓ move  enter/→ links  tab focus  space/J/K scroll  t tree  b back  / search  e edit  q quit" : "↑↓ link  enter follow  ←/esc list  space/J/K scroll  t tree  b back  e edit  q quit";
  const footer = searching ? /* @__PURE__ */ jsxs(Text, {
    wrap: "truncate",
    children: [
      /* @__PURE__ */ jsx(Text, {
        color: "yellow",
        children: "/"
      }),
      /* @__PURE__ */ jsx(Text, {
        children: filter
      }),
      /* @__PURE__ */ jsx(Text, {
        inverse: true,
        children: " "
      }),
      /* @__PURE__ */ jsxs(Text, {
        dimColor: true,
        children: [
          "  ",
          ids.length,
          " matches",
          narrow ? "" : " · enter keep · esc clear"
        ]
      })
    ]
  }) : /* @__PURE__ */ jsxs(Text, {
    dimColor: true,
    wrap: "truncate",
    children: [
      filter ? /* @__PURE__ */ jsx(Text, {
        color: "yellow",
        children: narrow ? `/${filter} ` : `filter: ${filter} (esc clears)  `
      }) : null,
      footerText
    ]
  });
  if (view === "tree") {
    const detailLines = rows >= 22 ? 3 : rows >= 14 ? 2 : 0;
    const treeHeight = Math.max(1, innerHeight - (detailLines ? detailLines + 1 : 0));
    const start = clamp(nodeIndex - Math.floor(treeHeight / 2), 0, Math.max(0, nodes.length - treeHeight));
    const detail = node ? store.objects.get(node.id) : undefined;
    const parentId = node && node.depth > 0 ? nodes.find((n) => n.key === node.key.slice(0, node.key.lastIndexOf(">")))?.id : undefined;
    return /* @__PURE__ */ jsxs(Box, {
      flexDirection: "column",
      width: columns,
      height: rows,
      children: [
        header,
        /* @__PURE__ */ jsxs(Box, {
          flexDirection: "column",
          borderStyle: "round",
          borderColor: "cyan",
          height: bodyHeight,
          paddingX: 1,
          children: [
            /* @__PURE__ */ jsxs(Box, {
              flexDirection: "column",
              height: treeHeight,
              children: [
                nodes.slice(start, start + treeHeight).map((n, i) => /* @__PURE__ */ jsx(LineView, {
                  line: treeLine(store, n, columns - 4, start + i === nodeIndex, changedIds)
                }, n.key)),
                !nodes.length ? /* @__PURE__ */ jsx(Text, {
                  dimColor: true,
                  children: "Empty store."
                }) : null
              ]
            }),
            detailLines && node ? /* @__PURE__ */ jsxs(Fragment, {
              children: [
                /* @__PURE__ */ jsx(Text, {
                  dimColor: true,
                  children: "─".repeat(Math.max(0, columns - 4))
                }),
                /* @__PURE__ */ jsxs(Text, {
                  wrap: "truncate",
                  children: [
                    /* @__PURE__ */ jsx(Text, {
                      bold: true,
                      color: detail ? "cyan" : "red",
                      children: node.id
                    }),
                    parentId ? /* @__PURE__ */ jsxs(Text, {
                      dimColor: true,
                      children: [
                        " ",
                        { out: "← linked from", in: "→ links to", both: "↔ linked with", root: "" }[node.dir],
                        " ",
                        parentId,
                        " via ",
                        node.via.join(", ")
                      ]
                    }) : null
                  ]
                }),
                /* @__PURE__ */ jsx(Text, {
                  wrap: "truncate",
                  italic: true,
                  children: detail ? detail.summary : "wanted page: linked but not written yet"
                }),
                detailLines > 2 ? /* @__PURE__ */ jsx(Text, {
                  dimColor: true,
                  wrap: "truncate",
                  children: detail ? detail.body.replace(/\s+/g, " ").trim() : ""
                }) : null
              ]
            }) : null
          ]
        }),
        footer
      ]
    });
  }
  const listStart = clamp(cursor - Math.floor(innerHeight / 2), 0, Math.max(0, tree.length - innerHeight));
  const visibleRows = tree.slice(listStart, listStart + innerHeight);
  const multiLayer = layers.length > 1;
  const visibleLines = page?.lines.slice(scroll, scroll + innerHeight) ?? [];
  const activeLinkLine = focus === "page" && page?.links.length ? page.linkLines[linkIdx] : undefined;
  return /* @__PURE__ */ jsxs(Box, {
    flexDirection: "column",
    width: columns,
    height: rows,
    children: [
      header,
      /* @__PURE__ */ jsxs(Box, {
        height: bodyHeight,
        children: [
          narrow && focus === "page" ? null : /* @__PURE__ */ jsxs(Box, {
            flexDirection: "column",
            width: leftWidth + 2,
            flexShrink: 0,
            borderStyle: "round",
            borderColor: focus === "list" ? "cyan" : "gray",
            paddingX: 0,
            children: [
              !tree.length ? /* @__PURE__ */ jsx(Text, {
                dimColor: true,
                children: filter ? " no matches" : " empty store"
              }) : null,
              visibleRows.map((row, i) => {
                const index = listStart + i;
                const w = leftWidth;
                if (row.kind === "type") {
                  return /* @__PURE__ */ jsxs(Text, {
                    wrap: "truncate",
                    children: [
                      /* @__PURE__ */ jsxs(Text, {
                        bold: true,
                        color: "magenta",
                        children: [
                          "▾ ",
                          row.name
                        ]
                      }),
                      /* @__PURE__ */ jsxs(Text, {
                        dimColor: true,
                        children: [
                          " (",
                          row.count,
                          ")",
                          multiLayer && row.layer === "project" ? " project" : ""
                        ]
                      })
                    ]
                  }, `t:${row.name}`);
                }
                if (row.kind === "wanted-header") {
                  return /* @__PURE__ */ jsxs(Text, {
                    bold: true,
                    color: "red",
                    wrap: "truncate",
                    children: [
                      "▾ wanted (",
                      row.count,
                      ")"
                    ]
                  }, "wh");
                }
                const isCursor = index === cursor;
                const label = row.kind === "object" ? row.id.slice(row.id.indexOf("/") + 1) : row.id;
                const marks = [];
                if (row.kind === "object") {
                  if (changedIds.has(row.id))
                    marks.push({ t: "•", c: "green" });
                  if (row.obj.pinned)
                    marks.push({ t: "★", c: "yellow" });
                  if (store.issuesFor(row.obj.path).some((x) => x.severity === "error"))
                    marks.push({ t: "!", c: "red" });
                }
                const count = row.kind === "object" ? store.backlinks.get(row.id)?.size ?? 0 : row.sources;
                const right = count ? ` ←${count}` : "";
                const marksWidth = marks.length ? marks.length + 1 : 0;
                const name = truncate(label, w - 3 - right.length - marksWidth);
                const gap = " ".repeat(Math.max(0, w - 2 - name.length - right.length - marksWidth));
                return /* @__PURE__ */ jsxs(Text, {
                  wrap: "truncate",
                  children: [
                    /* @__PURE__ */ jsx(Text, {
                      children: " "
                    }),
                    /* @__PURE__ */ jsxs(Text, {
                      inverse: isCursor && focus === "list",
                      bold: isCursor,
                      color: row.kind === "wanted" ? "red" : isCursor ? "cyan" : undefined,
                      children: [
                        " ",
                        name,
                        gap
                      ]
                    }),
                    marks.length ? /* @__PURE__ */ jsx(Text, {
                      children: " "
                    }) : null,
                    marks.map((m, j) => /* @__PURE__ */ jsx(Text, {
                      color: m.c,
                      children: m.t
                    }, j)),
                    /* @__PURE__ */ jsx(Text, {
                      dimColor: true,
                      children: right
                    })
                  ]
                }, `o:${row.id}`);
              })
            ]
          }),
          narrow && focus === "list" ? null : /* @__PURE__ */ jsx(Box, {
            flexDirection: "column",
            flexGrow: 1,
            borderStyle: "round",
            borderColor: focus === "page" ? "cyan" : "gray",
            paddingX: 1,
            children: visibleLines.map((line, i) => {
              const n = scroll + i;
              return n === activeLinkLine ? /* @__PURE__ */ jsx(LineView, {
                line: line.map((s) => ({ ...s, inverse: true }))
              }, n) : /* @__PURE__ */ jsx(LineView, {
                line
              }, n);
            })
          })
        ]
      }),
      footer
    ]
  });
}

// src/viewer/run.tsx
import { jsx as jsx2 } from "react/jsx-runtime";
async function runViewer(layers, initial) {
  let state = initial;
  for (;; ) {
    let editing;
    const app = render(/* @__PURE__ */ jsx2(App, {
      layers,
      initial: state,
      onEdit: (path, s) => {
        editing = path;
        state = s;
      }
    }), { alternateScreen: true, exitOnCtrlC: true });
    await app.waitUntilExit();
    if (!editing)
      return;
    const editor = process.env.VISUAL || process.env.EDITOR || "vi";
    spawnSync(`${editor} "$O6Y_FILE"`, { shell: true, stdio: "inherit", env: { ...process.env, O6Y_FILE: editing } });
    process.stdout.write("\x1B[2J\x1B[H");
  }
}
export {
  runViewer
};
