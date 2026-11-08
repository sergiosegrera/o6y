#!/usr/bin/env node
import {
  dreamInvocation
} from "./chunk-v6va4yga.js";
import {
  dreamRunning,
  dreamStatus,
  dreamsDir,
  readRuns
} from "./chunk-21mbrgke.js";
import {
  displayPath
} from "./chunk-j881ctwp.js";
import {
  LOG_LINE,
  storeSignature
} from "./chunk-w5dq0wfg.js";
import {
  adjacency,
  graphData
} from "./chunk-g81sfh45.js";
import {
  neighbors
} from "./chunk-9q7vjba0.js";
import {
  cacheRoot,
  embedderFor,
  search,
  semanticUnavailable,
  syncIndex
} from "./chunk-xg2qjjsk.js";
import {
  LOG_FILE,
  RESERVED_FIELDS,
  Store
} from "./chunk-h52xt07b.js";

// src/viewer/run.tsx
import { spawnSync } from "node:child_process";
import { render } from "ink";

// src/viewer/app.tsx
import { Box, Text, useApp, useInput, useWindowSize } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { spawn } from "node:child_process";

// src/viewer/dreamForm.ts
var DEFAULT_CAP = 5;
var dreamFormMax = (f) => f.scope === "here" ? f.here : f.all;
function newDreamForm(all, here) {
  return { all, here, scope: all ? "all" : "here", cap: Math.min(DEFAULT_CAP, all), field: "cap", typed: "" };
}
function updateDreamForm(f, key) {
  const clampCap = (cap, form = f) => Math.max(1, Math.min(dreamFormMax(form), cap));
  if (/^\d$/.test(key)) {
    const typed = `${f.typed}${key}`.replace(/^0+/, "");
    return typed ? { ...f, field: "cap", typed, cap: clampCap(Number(typed)) } : f;
  }
  const next = { ...f, typed: "" };
  if (key === "up" || key === "down")
    return { ...next, field: f.field === "cap" ? "scope" : "cap" };
  if (key === "all")
    return { ...next, field: "cap", cap: dreamFormMax(f) };
  if (f.field === "cap")
    return { ...next, cap: clampCap(f.cap + (key === "right" ? 1 : -1)) };
  const scope = f.scope === "all" ? "here" : "all";
  if (!(scope === "here" ? f.here : f.all))
    return next;
  const moved = { ...next, scope };
  return { ...moved, cap: clampCap(f.cap, moved) };
}
function dreamFormFlags(f) {
  return [...f.scope === "here" ? ["--here"] : [], ...f.cap < dreamFormMax(f) ? ["--limit", String(f.cap)] : []];
}
function costPerSession(runs) {
  const paid = runs.filter((r) => r.cost > 0 && r.sessions.some((s) => s.ok));
  const sessions = paid.reduce((n, r) => n + r.sessions.filter((s) => s.ok).length, 0);
  return sessions ? paid.reduce((n, r) => n + r.cost, 0) / sessions : undefined;
}
function dreamFormLines(f, info, width) {
  const fill = (line) => {
    let room = width;
    const fitted = [];
    for (const seg of line) {
      const text = seg.text.slice(0, room);
      room -= text.length;
      if (text)
        fitted.push({ ...seg, text });
    }
    return [...fitted, { text: " ".repeat(room) }];
  };
  const row = (field, label, value) => {
    const on = f.field === field;
    return [{ text: on ? " ▸ " : "   ", color: "cyan" }, { text: label.padEnd(10), dim: !on }, { text: ` ‹ ${value} › `, inverse: on, bold: on }];
  };
  const max = dreamFormMax(f);
  const count = (n) => `${n} session${n === 1 ? "" : "s"}`;
  const scope = f.scope === "here" ? `this directory (${f.here})` : `all directories (${f.all})`;
  const capText = f.cap >= max ? `no cap, all ${max}` : `${f.cap} of ${max}`;
  const blank = [];
  return [
    [{ text: " Run a dream", bold: true }],
    blank,
    row("scope", "Sessions", scope),
    row("cap", "Cap", capText),
    blank,
    [{ text: ` Reads ${count(f.cap)}, oldest first.`, dim: true }],
    [{ text: ` Model: ${info.model}`, dim: true }],
    ...info.perSession === undefined ? [] : [[{ text: ` About $${(info.perSession * f.cap).toFixed(2)}, going by past dreams.`, dim: true }]],
    [{ text: " Changes apply to memory without review.", color: "yellow" }],
    blank,
    [{ text: " ⏎ start  ↑↓ field  ←→ change  0-9 cap  a all  esc", dim: true }]
  ].map(fill);
}

// src/viewer/model.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
var plain = (line) => line.map((s) => s.text).join("");
var typeKey = (name) => `type:${name}`;
var WANTED_KEY = "wanted:";
function rowKey(row) {
  if (row.kind === "type")
    return typeKey(row.name);
  if (row.kind === "wanted-header")
    return WANTED_KEY;
  return row.id;
}
function parentKey(store, key) {
  if (key.startsWith("type:") || key === WANTED_KEY)
    return;
  const obj = store.objects.get(key);
  return obj ? typeKey(obj.type) : WANTED_KEY;
}
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
function treeRows(store, query = "", open = "all") {
  const isOpen = (key) => open === "all" || !!query || open.has(key);
  const byType = new Map;
  for (const obj of store.objects.values()) {
    if (!matches(store, obj.id, query))
      continue;
    const list = byType.get(obj.type) ?? [];
    list.push(obj);
    byType.set(obj.type, list);
  }
  const rows = [];
  const types = [...store.types.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const type of types) {
    const objects = (byType.get(type.name) ?? []).sort((a, b) => a.id.localeCompare(b.id));
    if (query && !objects.length)
      continue;
    const open2 = isOpen(typeKey(type.name));
    rows.push({ kind: "type", name: type.name, count: objects.length, layer: type.layer.name, open: open2 });
    if (open2)
      for (const obj of objects)
        rows.push({ kind: "object", id: obj.id, obj });
  }
  const wanted = [...store.wanted].filter(([id]) => matches(store, id, query)).sort(([a], [b]) => a.localeCompare(b));
  if (wanted.length) {
    const open2 = isOpen(WANTED_KEY);
    rows.push({ kind: "wanted-header", count: wanted.length, open: open2 });
    if (open2)
      for (const [id, sources] of wanted)
        rows.push({ kind: "wanted", id, sources: sources.size });
  }
  return rows;
}
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
var managedDate = (value) => value instanceof Date ? value.toISOString().slice(0, 10) : typeof value === "string" ? value : undefined;
function daysAgo(date, now) {
  const days = Math.round((new Date(now).setHours(0, 0, 0, 0) - new Date(`${date}T00:00:00`).getTime()) / 86400000);
  return Number.isNaN(days) ? "" : days <= 0 ? " (today)" : days === 1 ? " (yesterday)" : ` (${days}d ago)`;
}
function managedLine(value, now = new Date) {
  const block = value ?? {};
  const created = managedDate(block.created);
  const updated = managedDate(block.updated);
  if (!created && !updated)
    return;
  const line = [{ text: " o6y ", inverse: true, bold: true, color: "magenta" }];
  if (created)
    line.push({ text: " created ", color: "magenta" }, { text: created, bold: true });
  if (updated)
    line.push({ text: " updated ", color: "magenta" }, { text: updated, bold: true }, { text: daysAgo(updated, now), dim: true });
  return line;
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
    const tags = [];
    if (obj.pinned)
      tags.push({ text: " pinned", color: "yellow" });
    if (changed?.has(id))
      tags.push({ text: " changed", color: "green" });
    lines.push([{ text: id, bold: true, color: "cyan" }, ...tags]);
    for (const w of wrap(obj.summary || "(no summary)", width))
      lines.push([{ text: w, italic: true }]);
    lines.push([{ text: displayPath(obj.path), dim: true }]);
    const managed = managedLine(obj.data.o6y);
    if (managed)
      lines.push(managed);
    const fields = Object.entries(obj.data).filter(([k]) => !RESERVED_FIELDS.includes(k));
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
function renderTypePage(store, typeName, width) {
  const type = store.types.get(typeName);
  const lines = [];
  const links = [];
  const linkLines = [];
  if (!type)
    return { lines: [[{ text: `no type ${typeName}`, color: "red" }]], links, linkLines };
  const objects = store.objectsOfType(typeName);
  lines.push([{ text: typeName, bold: true, color: "magenta" }, { text: ` ${objects.length} objects`, dim: true }]);
  for (const w of wrap(type.schema.description, width))
    lines.push([{ text: w, italic: true }]);
  lines.push([{ text: displayPath(type.path), dim: true }]);
  const fields = Object.entries(type.schema.fields);
  if (fields.length) {
    lines.push([]);
    const keyWidth = Math.min(16, Math.max(...fields.map(([k]) => k.length)));
    for (const [name, f] of fields) {
      const spec = [f.type === "link" ? `link→${f.to === "any" || !f.to ? "any" : f.to.join("|")}${f.many ? "[]" : ""}` : f.type === "enum" ? `enum(${f.values.join("|")})` : f.type, f.required ? "required" : ""].filter(Boolean).join(", ");
      lines.push([{ text: name.padEnd(keyWidth) + "  ", color: "blue" }, { text: truncate(spec + (f.description ? ` — ${f.description}` : ""), width - keyWidth - 2) }]);
    }
  }
  if (type.schema.guidance) {
    lines.push([{ text: "─".repeat(Math.max(0, width)), dim: true }]);
    lines.push(...markdownLines(store, type.schema.guidance, width));
  }
  if (objects.length) {
    lines.push([], [{ text: `Objects (${objects.length})`, bold: true }]);
    for (const obj of objects) {
      links.push(obj.id);
      linkLines.push(lines.length);
      const slug = obj.slug;
      lines.push([{ text: `  ${slug}`, color: "cyan" }, { text: truncate(` — ${obj.summary}`, Math.max(0, width - slug.length - 2)), dim: true }]);
    }
  }
  return { lines, links, linkLines };
}
function renderWantedPage(store, width) {
  const lines = [[{ text: "Wanted pages", bold: true, color: "red" }, { text: ` ${store.wanted.size}`, dim: true }]];
  lines.push([{ text: "Linked from somewhere but not written yet.", dim: true }], []);
  const links = [];
  const linkLines = [];
  for (const [id, sources] of [...store.wanted].sort(([a], [b]) => a.localeCompare(b))) {
    links.push(id);
    linkLines.push(lines.length);
    lines.push([{ text: `  ${id}`, color: "red" }, { text: truncate(` ← ${[...sources].sort().join(", ")}`, Math.max(0, width - id.length - 2)), dim: true }]);
  }
  return { lines, links, linkLines };
}
function parseLog(text, layer) {
  const out = [];
  for (const line of text.split(`
`)) {
    const m = LOG_LINE.exec(line);
    const at = m ? Date.parse(m[1]) : NaN;
    if (m && !Number.isNaN(at))
      out.push({ at, action: m[2], target: m[3], via: m[4], layer, source: m[5] });
  }
  return out;
}
function readActivity(layers) {
  const entries = [];
  for (const layer of layers) {
    try {
      entries.push(...parseLog(readFileSync(join(layer.root, LOG_FILE), "utf8"), layer.name));
    } catch {}
  }
  return entries.sort((a, b) => b.at - a.at);
}
var BATCH_MIN = 3;
var dayKey = (at) => {
  const d = new Date(at);
  return `day:${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
function dayLabel(at, now) {
  const d = new Date(at);
  const days = Math.round((new Date(now).setHours(0, 0, 0, 0) - new Date(at).setHours(0, 0, 0, 0)) / 86400000);
  if (days === 0)
    return "Today";
  if (days === 1)
    return "Yesterday";
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", ...days > 300 ? { year: "numeric" } : {} });
}
function activityRows(entries, open, query = "", now = new Date) {
  const q = query.toLowerCase();
  const shown = q ? entries.filter((e) => e.target.toLowerCase().includes(q) || e.via.toLowerCase().includes(q)) : entries;
  const days = [];
  for (const e of shown) {
    const key = dayKey(e.at);
    let day = days[days.length - 1];
    if (day?.key !== key)
      days.push(day = { key, at: e.at, groups: [] });
    const g = day.groups[day.groups.length - 1];
    if (g && g[0].at === e.at && g[0].via === e.via)
      g.push(e);
    else
      day.groups.push([e]);
  }
  const rows = [];
  const seen = new Map;
  const unique = (base) => {
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n ? `${base}#${n}` : base;
  };
  const entryRow = (e, nested) => ({
    kind: "entry",
    key: unique(`${e.at}|${e.action}|${e.target}|${e.via}`),
    entry: e,
    nested
  });
  for (const day of days) {
    const isOpen = !!q || open.has(day.key);
    rows.push({ kind: "day", key: day.key, label: dayLabel(day.at, now), entries: day.groups.flat(), open: isOpen });
    if (!isOpen)
      continue;
    for (const g of day.groups) {
      if (g.length < BATCH_MIN) {
        for (const e of g)
          rows.push(entryRow(e, false));
        continue;
      }
      const key = unique(`batch:${g[0].at}|${g[0].via}`);
      const batchOpen = open.has(key);
      rows.push({ kind: "batch", key, entries: g, open: batchOpen });
      if (batchOpen)
        for (const e of g)
          rows.push(entryRow(e, true));
    }
  }
  return rows;
}
var ACTION_MARK = {
  create: { mark: "+", color: "green", verb: "created" },
  update: { mark: "~", color: "yellow", verb: "updated" },
  delete: { mark: "−", color: "red", verb: "deleted" }
};
var clock = (at) => new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
function batchSummary(entries) {
  const counts = new Map;
  for (const e of entries)
    counts.set(e.action, (counts.get(e.action) ?? 0) + 1);
  return [...counts].map(([a, n]) => `${ACTION_MARK[a].mark}${n}`).join(" ");
}
function activityLine(store, row, width, selected, changed) {
  if (row.kind === "day") {
    const label = `${row.open ? "▾" : "▸"} ${row.label}`;
    const count = ` ${batchSummary(row.entries)}`;
    return [
      { text: label, bold: true, color: "magenta", inverse: selected },
      { text: " ".repeat(Math.max(1, width - label.length - count.length)) },
      { text: truncate(count, Math.max(0, width - label.length - 1)), dim: true }
    ];
  }
  if (row.kind === "batch") {
    const head = row.entries[0];
    const left = `${clock(head.at)} ${row.open ? "▾" : "▸"} ${row.entries.length} changes `;
    const right = ` ${batchSummary(row.entries)} · ${head.via}`;
    return [
      { text: left, bold: selected, inverse: selected, color: selected ? "cyan" : undefined },
      { text: truncate(right, Math.max(0, width - left.length)), dim: true }
    ];
  }
  const e = row.entry;
  const a = ACTION_MARK[e.action];
  const time = row.nested ? "   " : clock(e.at);
  const missing = !e.target.includes(" ") && e.target.includes("/") && !store.objects.has(e.target);
  const source = ` ${e.via}`;
  const mark = changed?.has(e.target) ? " •" : "";
  const nameWidth = Math.max(4, width - time.length - 3 - mark.length - (width > 34 ? source.length : 0));
  const segs = [
    { text: `${time} `, dim: true },
    { text: `${a.mark} `, color: a.color },
    { text: truncate(e.target, nameWidth), color: missing ? "red" : e.target.includes(" ") ? "magenta" : selected ? "cyan" : undefined, bold: selected, inverse: selected }
  ];
  if (mark)
    segs.push({ text: mark, color: "green" });
  const room = width - plain(segs).length;
  if (room >= source.length)
    segs.push({ text: source.padStart(room), dim: true });
  return segs;
}
function activityTarget(store, row) {
  if (row.kind !== "entry")
    return {};
  const t = row.entry.target;
  if (t.startsWith("schema "))
    return store.types.has(t.slice(7)) ? { type: t.slice(7) } : {};
  return store.objects.has(t) ? { object: t } : {};
}
function renderActivityPage(store, row, width, changed) {
  const links = [];
  const linkLines = [];
  const lines = [];
  const stamp = (at) => new Date(at).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "medium" });
  const describeEntry = (e) => {
    const a = ACTION_MARK[e.action];
    return [{ text: `${a.mark} ${a.verb}`, color: a.color }, { text: ` ${stamp(e.at)} · ${e.via}${e.source ? ` · ${e.source}` : ""}`, dim: true }];
  };
  if (row.kind === "entry") {
    const { object, type } = activityTarget(store, row);
    const page = object ? renderPage(store, object, width, changed) : type ? renderTypePage(store, type, width) : undefined;
    const head2 = [describeEntry(row.entry), []];
    if (page)
      return { lines: [...head2, ...page.lines], links: page.links, linkLines: page.linkLines.map((n) => n + head2.length) };
    lines.push(...head2, [{ text: row.entry.target, bold: true, color: "red" }]);
    lines.push([{ text: row.entry.action === "delete" || !store.objects.has(row.entry.target) ? "No longer in the store." : "", dim: true }]);
    return { lines, links, linkLines };
  }
  const entries = row.entries;
  const head = entries[0];
  if (row.kind === "day") {
    const date = new Date(head.at).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
    lines.push([{ text: row.label, bold: true, color: "magenta" }, { text: ` ${date} · ${entries.length} changes (${batchSummary(entries)})`, dim: true }], []);
  } else
    lines.push([{ text: `${entries.length} changes`, bold: true }, { text: ` ${stamp(head.at)} · ${head.via}`, dim: true }], []);
  for (const e of entries) {
    const a = ACTION_MARK[e.action];
    const exists = store.objects.has(e.target);
    if (exists) {
      links.push(e.target);
      linkLines.push(lines.length);
    }
    const summary = store.objects.get(e.target)?.summary;
    const time = row.kind === "day" ? `${clock(e.at)} ` : "";
    const via = row.kind === "day" ? ` (${e.via})` : "";
    lines.push([
      { text: time, dim: true },
      { text: `${a.mark} `, color: a.color },
      { text: e.target, color: exists ? "cyan" : "red" },
      { text: via, dim: true },
      { text: truncate(summary ? ` — ${summary}` : "", Math.max(0, width - time.length - e.target.length - via.length - 2)), dim: true }
    ]);
  }
  return { lines, links, linkLines };
}
var DREAM_COLOR = { running: "cyan", done: "green", partial: "yellow", aborted: "yellow", failed: "red" };
var dreamWhen = (run) => new Date(run.startedAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
function dreamLine(run, width, selected) {
  const left = `${dreamWhen(run)} `;
  const done = run.sessions.filter((s) => s.ok || s.summary).length;
  const right = run.status === "running" ? ` dreaming ${done}/${run.planned ?? "?"}` : ` ${run.status} · ${run.changes.length}Δ`;
  return [
    { text: truncate(left, width), color: selected ? "cyan" : undefined, bold: selected, inverse: selected },
    { text: truncate(right.padStart(Math.max(0, width - left.length)), Math.max(0, width - left.length)), color: DREAM_COLOR[run.status], dim: !selected }
  ];
}
function renderDreamPage(store, run, width) {
  const links = [];
  const linkLines = [];
  const lines = [];
  const wrapped = (text, indent = "  ") => lines.push(...wrap(text.trim().replace(/\s+/g, " "), Math.max(10, width - indent.length)).map((t) => [{ text: indent + t, dim: true }]));
  const heading = (text) => lines.push([], [{ text, bold: true, color: "magenta" }]);
  const ok = run.sessions.filter((s) => s.ok).length;
  lines.push([{ text: dreamWhen(run), bold: true }, { text: ` ${run.status}`, color: DREAM_COLOR[run.status], bold: true }]);
  if (run.status === "running")
    lines.push([{ text: `now: ${run.step ?? "starting"}`, color: "cyan" }]);
  lines.push([{ text: `${ok}/${run.planned ?? run.sessions.length} sessions · ${run.changes.length} changes · $${run.cost.toFixed(4)} · ${run.tokens} tokens`, dim: true }]);
  const model = run.models.analyzer === run.models.organizer ? run.models.analyzer || "session model" : `${run.models.analyzer || "session model"} / ${run.models.organizer || "session model"}`;
  lines.push([{ text: truncate(model, width), dim: true }]);
  if (run.error) {
    heading("Not applied");
    wrapped(run.error);
  }
  heading("Changes");
  if (!run.changes.length)
    lines.push([{ text: run.status === "running" ? "  applied when the dream finishes" : "  none", dim: true }]);
  for (const c of run.changes) {
    const id = c.path.split("/").slice(-2).join("/").replace(/\.md$/, "");
    const exists = store.objects.has(id);
    if (exists) {
      links.push(id);
      linkLines.push(lines.length);
    }
    const mark = ACTION_MARK[c.action];
    const summary = store.objects.get(id)?.summary;
    lines.push([
      { text: `  ${mark?.mark ?? "?"} `, color: mark?.color },
      { text: id, color: exists ? "cyan" : "red" },
      { text: truncate(summary ? ` — ${summary}` : "", Math.max(0, width - id.length - 4)), dim: true }
    ]);
  }
  if (run.conflicts.length) {
    heading("Kept the live version (edited during the dream)");
    for (const path of run.conflicts)
      lines.push([{ text: `  ${truncate(path.split("/").slice(-2).join("/"), width - 2)}`, color: "yellow" }]);
  }
  heading("Sessions");
  for (const s of run.sessions) {
    const working = run.status === "running" && !s.ok && !s.summary;
    lines.push([{ text: working ? "  ⋯ " : s.ok ? "  ✓ " : "  ✗ ", color: working ? "cyan" : s.ok ? "green" : "red" }, { text: truncate(s.cwd, Math.max(4, width - 4)) }]);
    lines.push([{ text: `    ${truncate(s.id, Math.max(4, width - 4))}`, dim: true }]);
    if (s.summary)
      wrapped(s.summary, "    ");
  }
  if (run.organizer) {
    heading(run.organizer.ok ? "Organizer" : run.status === "running" ? "Organizer (working)" : "Organizer failed");
    if (run.organizer.summary)
      wrapped(run.organizer.summary);
  }
  if (run.snapshot) {
    heading("Store before this dream");
    wrapped(run.snapshot);
  }
  return { lines, links, linkLines };
}
function searchLine(store, hit, width, selected, threshold) {
  const score = `${hit.score.toFixed(2)} `;
  const below = hit.score < threshold;
  return [
    { text: score, color: below ? "gray" : "green" },
    { text: truncate(hit.id, Math.max(4, width - score.length)), color: selected ? "cyan" : undefined, bold: selected, inverse: selected, dim: below && !selected }
  ];
}

// src/viewer/graph.ts
var COLORS = ["cyan", "green", "yellow", "magenta", "blue", "red"];
var LIST_MAX = 80;
function busiest(adj) {
  let best;
  for (const [id, near] of adj)
    if (!best || near.size > adj.get(best).size || near.size === adj.get(best).size && id < best)
      best = id;
  return best;
}
function localGraph(adj, center, depth) {
  if (!adj.has(center))
    return [];
  const out = [{ id: center, hop: 0 }];
  const seen = new Set([center]);
  let edge = [center];
  for (let hop = 1;hop <= depth && out.length < LIST_MAX; hop++) {
    const next = [];
    for (const from of edge) {
      const near = [...adj.get(from) ?? []].filter((id) => !seen.has(id)).sort((a, b) => adj.get(b).size - adj.get(a).size || a.localeCompare(b));
      for (const id of near) {
        if (out.length >= LIST_MAX)
          break;
        seen.add(id);
        out.push({ id, hop, parent: from });
        next.push(id);
      }
    }
    edge = next;
  }
  return out;
}
var typeColor = (store) => {
  const types = [...store.types.keys()].sort();
  return (id) => store.objects.has(id) ? COLORS[types.indexOf(id.split("/")[0]) % COLORS.length] : "red";
};
function graphLine(store, node, adj, width, selected) {
  const color = typeColor(store)(node.id);
  const lead = node.hop === 0 ? "◉ " : `${"  ".repeat(node.hop - 1)}· `;
  const count = ` ${adj.get(node.id)?.size ?? 0}`;
  const name = truncate(node.id, Math.max(4, width - lead.length - count.length));
  return [
    { text: lead, color },
    { text: name, bold: selected || node.hop === 0, inverse: selected, color: selected ? "cyan" : undefined },
    { text: count.padStart(width - lead.length - name.length), dim: true }
  ];
}
function renderLocalGraph(store, nodes, adj, selected, width, height) {
  const rows = Math.max(3, height - 1);
  const grid = Array.from({ length: rows }, () => Array(width).fill(undefined));
  const color = typeColor(store);
  const room = Math.max(4, Math.floor(rows * 0.8));
  const picked = selected && nodes.findIndex((n) => n.id === selected) >= room ? [...nodes.slice(0, room - 1), nodes.find((n) => n.id === selected)] : nodes.slice(0, room);
  const depth = Math.max(...picked.map((n) => n.hop), 1);
  const rings = depth === 1 ? [0, 0.4] : [0, 0.24, 0.38, 0.47];
  const cx = (width - 1) / 2;
  const cy = (rows - 1) / 2;
  const angle = new Map;
  const place = new Map;
  const put = (id, a, ring) => {
    angle.set(id, a);
    place.set(id, { x: Math.round(cx + Math.cos(a) * ring * (width - 2)), y: Math.round(cy + Math.sin(a) * ring * (rows - 1)) });
  };
  put(picked[0].id, 0, 0);
  const first = picked.filter((n) => n.hop === 1);
  first.forEach((n, i) => put(n.id, i / first.length * Math.PI * 2 - Math.PI / 2, rings[1]));
  for (const hop of [2, 3]) {
    const level = picked.filter((n) => n.hop === hop);
    const groups = new Map;
    for (const n of level)
      groups.set(n.parent, [...groups.get(n.parent) ?? [], n]);
    for (const [parent, kids] of groups) {
      const spread = Math.min(0.45, Math.PI * 2 / Math.max(1, first.length) / Math.max(1, kids.length));
      kids.forEach((n, k) => put(n.id, (angle.get(parent) ?? 0) + spread * (k - (kids.length - 1) / 2), rings[hop]));
    }
  }
  const drawn = new Set(place.keys());
  const line = (a, b, on) => {
    const steps = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y), 1);
    for (let i = 1;i < steps; i++) {
      const x = Math.round(a.x + (b.x - a.x) * i / steps);
      const y = Math.round(a.y + (b.y - a.y) * i / steps);
      const cell = grid[y]?.[x];
      if (y < 0 || y >= rows || x < 0 || x >= width || cell && !on)
        continue;
      grid[y][x] = { ch: on ? "•" : "·", style: on ? { color: "cyan" } : { dim: true }, label: false };
    }
  };
  for (const id of drawn)
    for (const other of adj.get(id) ?? [])
      if (drawn.has(other) && id < other && id !== selected && other !== selected)
        line(place.get(id), place.get(other), false);
  if (selected && drawn.has(selected)) {
    for (const other of adj.get(selected) ?? [])
      if (drawn.has(other))
        line(place.get(selected), place.get(other), true);
  }
  const fits = (x, y, len) => {
    if (y < 0 || y >= rows || x < 0 || x + len > width)
      return false;
    for (let i = Math.max(0, x - 1);i < Math.min(width, x + len + 1); i++)
      if (grid[y][i]?.label)
        return false;
    return true;
  };
  const label = (id, center, isSelected) => {
    const p = place.get(id);
    const text = truncate(center ? id : id.slice(id.indexOf("/") + 1), center ? 34 : 20);
    const style = isSelected ? { inverse: true, bold: true, color: "cyan" } : center ? { bold: true, color: color(id) } : { color: color(id) };
    const decorated = isSelected || center ? ` ${text} ` : text;
    for (const dy of [0, -1, 1, -2, 2]) {
      for (const dx of [0, -6, 6, -12, 12]) {
        const x = Math.min(width - decorated.length, Math.max(0, p.x + dx - Math.floor(decorated.length / 2)));
        if (!fits(x, p.y + dy, decorated.length))
          continue;
        [...decorated].forEach((ch, i) => grid[p.y + dy][x + i] = { ch, style, label: true });
        return;
      }
    }
    if (p.y >= 0 && p.y < rows && p.x >= 0 && p.x < width && !grid[p.y][p.x]?.label)
      grid[p.y][p.x] = { ch: "●", style, label: true };
  };
  label(picked[0].id, true, picked[0].id === selected);
  if (selected && selected !== picked[0].id && drawn.has(selected))
    label(selected, false, true);
  for (const n of picked.slice(1))
    if (n.id !== selected)
      label(n.id, false, false);
  const lines = grid.map((row) => {
    const segs = [];
    let current;
    let key = "";
    for (const cell of row) {
      const k = JSON.stringify(cell?.style ?? null);
      if (!current || k !== key) {
        current = { text: "", ...cell?.style ?? {} };
        key = k;
        segs.push(current);
      }
      current.text += cell?.ch ?? " ";
    }
    return segs;
  });
  const hidden = nodes.length - picked.length;
  const note = `${nodes.length - 1} linked${hidden > 0 ? ` · ${hidden} only in the list` : ""}`;
  lines.push([{ text: truncate(note, width), dim: true }]);
  return lines;
}

// src/viewer/watch.ts
import { existsSync, watch } from "node:fs";
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
  let last = storeSignature(layers);
  const poll = setInterval(() => {
    const now = storeSignature(layers);
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
import { jsx, jsxs } from "react/jsx-runtime";
var SEARCH_LIMIT = 20;
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
  const [open, setOpen] = useState(() => new Set(initial.open ?? []));
  const [sideKey, setSideKey] = useState(initial.sideKey);
  const [activityOpen, setActivityOpen] = useState(() => new Set(initial.activityOpen ?? []));
  const [asking, setAsking] = useState(false);
  const [question, setQuestion] = useState(initial.results?.query ?? "");
  const [results, setResults] = useState(initial.results?.status === "done" ? initial.results : undefined);
  const searchRun = useRef(0);
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
  const leftWidth = narrow ? columns - 2 : view === "activity" || view === "dreams" || view === "graph" ? clamp(Math.floor(columns * 0.4), 30, 56) : clamp(Math.floor(columns * 0.3), 24, 44);
  const rightWidth = narrow ? Math.max(10, columns - 4) : Math.max(10, columns - leftWidth - 6);
  const tree = useMemo(() => treeRows(store, filter, open), [store, filter, open]);
  const keys = useMemo(() => tree.map(rowKey), [tree]);
  let cursor = current ? keys.indexOf(current) : -1;
  const exists = (key) => key.startsWith("type:") ? store.types.has(key.slice(5)) : key === WANTED_KEY ? store.wanted.size > 0 : store.objects.has(key) || store.wanted.has(key);
  const selected = current && exists(current) && cursor >= 0 ? current : undefined;
  if (!selected)
    cursor = keys.length ? clamp(lastIndex.current, 0, keys.length - 1) : -1;
  const selectedKey = selected ?? (cursor >= 0 ? keys[cursor] : undefined);
  const row = cursor >= 0 ? tree[cursor] : undefined;
  const isHeader = (key) => !!key && (key.startsWith("type:") || key === WANTED_KEY);
  const id = isHeader(selectedKey) ? undefined : selectedKey;
  if (cursor >= 0)
    lastIndex.current = cursor;
  useEffect(() => {
    const parent = current ? parentKey(store, current) : undefined;
    if (parent && !open.has(parent))
      setOpen((prev) => new Set(prev).add(parent));
  }, [current, store]);
  const toggle = (key, on) => setOpen((prev) => {
    const next = new Set(prev);
    if (on)
      next.add(key);
    else
      next.delete(key);
    return next;
  });
  const activity = useMemo(() => readActivity(layers), [layers, loadedAt]);
  const actRows = useMemo(() => activityRows(activity, activityOpen), [activity, activityOpen]);
  const hits = results?.hits ?? [];
  const adj = useMemo(() => adjacency(graphData(store)), [store]);
  const [graphCenter, setGraphCenter] = useState(initial.graphCenter);
  const [graphBack, setGraphBack] = useState([]);
  const [graphDepth, setGraphDepth] = useState(1);
  const center = graphCenter && adj.has(graphCenter) ? graphCenter : busiest(adj);
  const graphNodes = useMemo(() => view === "graph" && center ? localGraph(adj, center, graphDepth) : [], [view, adj, center, graphDepth]);
  const [dreamAsk, setDreamAsk] = useState();
  const [dreamNote, setDreamNote] = useState();
  const [dreamLive, setDreamLive] = useState(false);
  const [dreamTick, setDreamTick] = useState(0);
  const dreamWasRunning = useRef(false);
  useEffect(() => {
    if (view !== "dreams")
      return;
    const timer = setInterval(() => {
      const running = dreamRunning(dreamsDir(process.env));
      if (running || dreamWasRunning.current)
        setDreamTick((n) => n + 1);
      dreamWasRunning.current = running;
    }, 2000);
    return () => clearInterval(timer);
  }, [view]);
  const startDream = (flags) => {
    setDreamAsk(undefined);
    setSideKey(undefined);
    setDreamNote(undefined);
    setDreamLive(true);
    const { args, env } = dreamInvocation(layers[0].root, flags, process.env);
    const child = spawn("pi", args, { env, stdio: "ignore", detached: true });
    child.unref();
    child.on("error", (err) => {
      setDreamLive(false);
      setDreamNote(`could not start pi: ${err.message}`);
    });
    child.on("close", (code) => {
      setDreamLive(false);
      if (code)
        setDreamNote(`pi exited with code ${code}`);
      reload();
    });
  };
  const dreams = useMemo(() => view === "dreams" ? readRuns(process.env) : [], [view, loadedAt, dreamTick]);
  const sideKeys = useMemo(() => view === "activity" ? actRows.map((r) => r.key) : view === "dreams" ? dreams.map((d) => d.id) : view === "graph" ? graphNodes.map((n) => n.id) : view === "search" ? hits.map((h) => h.key) : [], [view, actRows, dreams, graphNodes, hits]);
  const sideIndex = sideKey && sideKeys.includes(sideKey) ? sideKeys.indexOf(sideKey) : sideKeys.length ? 0 : -1;
  const sideSelected = sideIndex >= 0 ? sideKeys[sideIndex] : undefined;
  const actRow = view === "activity" ? actRows.find((r) => r.key === sideSelected) : undefined;
  const hit = view === "search" ? hits.find((h) => h.key === sideSelected) : undefined;
  const dream = view === "dreams" ? dreams.find((d) => d.id === sideSelected) : undefined;
  const pageObject = view === "browse" ? id : view === "activity" ? actRow ? activityTarget(store, actRow).object : undefined : view === "graph" ? sideSelected && store.objects.has(sideSelected) ? sideSelected : undefined : hit?.id;
  const threshold = store.semantic.threshold;
  const page = useMemo(() => {
    if (view === "activity")
      return actRow ? renderActivityPage(store, actRow, rightWidth, changedIds) : undefined;
    if (view === "graph")
      return { lines: renderLocalGraph(store, graphNodes, adj, sideSelected, rightWidth, innerHeight), links: [], linkLines: [] };
    if (view === "dreams")
      return dream ? renderDreamPage(store, dream, rightWidth) : undefined;
    if (view === "search")
      return hit && store.objects.has(hit.id) ? renderPage(store, hit.id, rightWidth, changedIds) : undefined;
    if (!selectedKey)
      return;
    if (selectedKey.startsWith("type:"))
      return renderTypePage(store, selectedKey.slice(5), rightWidth);
    if (selectedKey === WANTED_KEY)
      return renderWantedPage(store, rightWidth);
    return renderPage(store, selectedKey, rightWidth, changedIds);
  }, [store, view, actRow, dream, hit, selectedKey, rightWidth, changedIds, graphNodes, adj, sideSelected, innerHeight]);
  const go = (target, push = true) => {
    if (target === selectedKey)
      return;
    if (push && selectedKey)
      setHistory((h) => [...h.slice(-49), selectedKey]);
    setCurrent(target);
    setLinkIdx(0);
    setScroll(0);
    if (filter && !treeRows(store, filter).some((r) => rowKey(r) === target))
      setFilter("");
  };
  const follow = (target) => {
    if (view !== "browse") {
      setView("browse");
      setFocus(narrow ? "page" : "list");
    }
    go(target);
  };
  const moveSide = (delta) => {
    if (!sideKeys.length)
      return;
    const next = sideKeys[clamp(sideIndex + delta, 0, sideKeys.length - 1)];
    if (next !== sideSelected) {
      setSideKey(next);
      setLinkIdx(0);
      setScroll(0);
    }
  };
  const runSearch = async (q) => {
    const run = ++searchRun.current;
    setView("search");
    setFocus("list");
    setSideKey(undefined);
    setScroll(0);
    const why = semanticUnavailable(store, process.env);
    if (why)
      return setResults({ query: q, status: "error", message: why, hits: [] });
    setResults({ query: q, status: "running", hits: [] });
    try {
      const embedder = embedderFor(store, process.env);
      const cache = cacheRoot(process.env);
      await syncIndex(store, embedder, cache);
      const found = await search(store, embedder, cache, q, { limit: SEARCH_LIMIT, minScore: 0 });
      if (run !== searchRun.current)
        return;
      setResults({ query: q, status: "done", hits: found.map((h) => ({ key: h.obj.id, id: h.obj.id, score: h.score, similarity: h.similarity })) });
    } catch (err) {
      if (run !== searchRun.current)
        return;
      setResults({ query: q, status: "error", message: err instanceof Error ? err.message : String(err), hits: [] });
    }
  };
  const back = () => {
    const prev = history[history.length - 1];
    if (!prev)
      return;
    setHistory((h) => h.slice(0, -1));
    go(prev, false);
  };
  const moveList = (delta) => {
    if (!keys.length)
      return;
    const next = keys[clamp(cursor + delta, 0, keys.length - 1)];
    if (next !== selectedKey) {
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
  const onScreen = (line) => line >= scroll && line < scroll + innerHeight;
  const activeLink = (() => {
    if (!page?.links.length)
      return;
    if (page.linkLines[linkIdx] !== undefined && onScreen(page.linkLines[linkIdx]))
      return linkIdx;
    const first = page.linkLines.findIndex(onScreen);
    return first >= 0 ? first : undefined;
  })();
  const edit = () => {
    const obj = pageObject ? store.objects.get(pageObject) : undefined;
    if (!obj)
      return;
    onEdit(obj.path, { current, view, history, filter, open: [...open], sideKey: sideSelected, activityOpen: [...activityOpen], results, graphCenter: center });
    exit();
  };
  useInput((input, key) => {
    if (asking) {
      if (key.escape)
        setAsking(false);
      else if (key.return) {
        setAsking(false);
        if (question.trim())
          runSearch(question.trim());
      } else if (key.backspace || key.delete)
        setQuestion((q) => q.slice(0, -1));
      else if (input && !key.ctrl && !key.meta)
        setQuestion((q) => q + input);
      return;
    }
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
    if (dreamAsk) {
      if (key.escape || input === "q")
        setDreamAsk(undefined);
      else if (key.return)
        startDream(dreamFormFlags(dreamAsk));
      else if (key.upArrow || key.downArrow || key.tab || input === "j" || input === "k")
        setDreamAsk(updateDreamForm(dreamAsk, key.upArrow || input === "k" ? "up" : "down"));
      else if (key.leftArrow || input === "h")
        setDreamAsk(updateDreamForm(dreamAsk, "left"));
      else if (key.rightArrow || input === "l")
        setDreamAsk(updateDreamForm(dreamAsk, "right"));
      else if (input === "a")
        setDreamAsk(updateDreamForm(dreamAsk, "all"));
      else if (/^\d+$/.test(input))
        setDreamAsk([...input].reduce((f, d) => updateDreamForm(f, d), dreamAsk));
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
      if (input.startsWith("?")) {
        setAsking(true);
        setQuestion(input.slice(1));
        return;
      }
      if (/^[jk]+$/.test(input) && focus === "list") {
        const delta = [...input].reduce((n2, ch) => n2 + (ch === "j" ? 1 : -1), 0);
        return view === "browse" ? moveList(delta) : moveSide(delta);
      }
      input = input[input.length - 1];
    }
    if (input === "R" && view === "dreams") {
      if (dreamLive || dreamRunning(dreamsDir(process.env)))
        return setDreamNote("a dream is already running");
      const { unprocessed, here } = dreamStatus(process.cwd(), process.env);
      if (!unprocessed)
        return setDreamNote("no sessions are waiting");
      return setDreamAsk(newDreamForm(unprocessed, here));
    }
    if (input === "q")
      return exit();
    if (input === "/") {
      setSearching(true);
      setView("browse");
      setFocus("list");
      return;
    }
    if (input === "?") {
      setAsking(true);
      setQuestion("");
      return;
    }
    const switchTo = (v) => {
      if (v === view)
        return;
      setView(v);
      setFocus("list");
      setScroll(0);
      setLinkIdx(0);
    };
    if (input === "1")
      return switchTo("browse");
    if (input === "2" || input === "a")
      return switchTo("activity");
    if (input === "3" || input === "d")
      return switchTo("dreams");
    if (input === "4" && view !== "graph") {
      if (pageObject ?? id)
        setGraphCenter(pageObject ?? id);
      setSideKey(undefined);
      return switchTo("graph");
    }
    if (input === "5" && results)
      return switchTo("search");
    if (input === "e")
      return edit();
    if (input === "r")
      return reload();
    if ((input === "b" || key.backspace || key.delete) && view === "graph") {
      const prev = graphBack[graphBack.length - 1];
      if (prev) {
        setGraphBack((h) => h.slice(0, -1));
        setGraphCenter(prev);
        setSideKey(undefined);
      }
      return;
    }
    if (input === "b" || key.backspace || key.delete)
      return back();
    if (input === "o" && pageObject && view !== "browse")
      return follow(pageObject);
    if (key.tab)
      return setFocus(focus === "list" ? "page" : "list");
    if (input === "g" || input === "G" || key.home || key.end) {
      const end = input === "G" || key.end;
      if (focus === "page")
        return setScroll(end ? maxScroll : 0);
      if (view !== "browse")
        return moveSide(end ? sideKeys.length : -sideKeys.length);
      return moveList(end ? keys.length : -keys.length);
    }
    if (view === "activity" && focus === "list" && actRow) {
      const toggleAct = (key2, on) => setActivityOpen((prev) => {
        const next = new Set(prev);
        if (on)
          next.add(key2);
        else
          next.delete(key2);
        return next;
      });
      const header2 = actRow.kind === "entry" ? undefined : actRow;
      if (header2 && (key.return || key.rightArrow || input === "l" || input === " ")) {
        if (!header2.open)
          return toggleAct(header2.key, true);
        if (key.rightArrow || input === "l")
          return moveSide(1);
        return toggleAct(header2.key, false);
      }
      const parent = () => {
        const at = actRows.indexOf(actRow);
        const nested = actRow.kind === "entry" && actRow.nested;
        for (let i = at - 1;i >= 0; i--)
          if (actRows[i].kind === (nested ? "batch" : "day"))
            return actRows[i].key;
        return;
      };
      if (key.leftArrow || input === "h") {
        if (header2?.open)
          return toggleAct(header2.key, false);
        const up = parent();
        if (up)
          moveSide(sideKeys.indexOf(up) - sideIndex);
        return;
      }
      if (input === "x") {
        const day = actRow.kind === "day" ? actRow.key : actRows.slice(0, actRows.indexOf(actRow)).findLast((r) => r.kind === "day")?.key;
        setActivityOpen(new Set);
        if (day)
          setSideKey(day);
        return;
      }
      if (input === "X")
        return setActivityOpen((prev) => new Set([...prev, ...actRows.filter((r) => r.kind === "day").map((r) => r.key)]));
      if (input === "[" || input === "]") {
        const days = actRows.flatMap((r, i) => r.kind === "day" ? [i] : []);
        const target = input === "]" ? days.find((i) => i > sideIndex) : [...days].reverse().find((i) => i < sideIndex);
        if (target !== undefined)
          moveSide(target - sideIndex);
        return;
      }
    }
    if (view === "graph" && focus === "list") {
      if (key.return || key.rightArrow || input === "l") {
        if (sideSelected && center && sideSelected !== center) {
          setGraphBack((h) => [...h.slice(-49), center]);
          setGraphCenter(sideSelected);
          setSideKey(undefined);
        }
        return;
      }
      if (input === "+" || input === "=")
        return setGraphDepth((d) => Math.min(3, d + 1));
      if (input === "-")
        return setGraphDepth((d) => Math.max(1, d - 1));
    }
    if (view !== "browse" && focus === "list") {
      if (key.downArrow || input === "j")
        moveSide(1);
      else if (key.upArrow || input === "k")
        moveSide(-1);
      else if (key.pageDown || input === " " || key.ctrl && input === "d")
        moveSide(innerHeight - 2);
      else if (key.pageUp || key.ctrl && input === "u")
        moveSide(-(innerHeight - 2));
      else if (key.return || key.rightArrow || input === "l")
        setFocus("page");
      else if (key.escape)
        switchTo("browse");
      return;
    }
    if (focus === "list" && !filter) {
      const header2 = row && (row.kind === "type" || row.kind === "wanted-header") ? row : undefined;
      const headerKey = header2 ? rowKey(header2) : undefined;
      if (header2 && headerKey && (key.return || key.rightArrow || input === "l" || input === " ")) {
        if (!header2.open)
          return toggle(headerKey, true);
        if (key.rightArrow || input === "l")
          return moveList(1);
        return toggle(headerKey, false);
      }
      if (key.leftArrow || input === "h") {
        if (header2 && headerKey && header2.open)
          return toggle(headerKey, false);
        const parent = selectedKey ? parentKey(store, selectedKey) : undefined;
        if (parent)
          return setCurrent(parent);
        return;
      }
      if (input === "x") {
        const parent = selectedKey ? parentKey(store, selectedKey) ?? selectedKey : undefined;
        setOpen(new Set);
        if (parent)
          setCurrent(parent);
        return;
      }
      if (input === "X")
        return setOpen(new Set([...[...store.types.keys()].map(typeKey), WANTED_KEY]));
      if (input === "[" || input === "]") {
        const headers = tree.map((r, i) => [r, i]).filter(([r]) => r.kind === "type" || r.kind === "wanted-header");
        const target = input === "]" ? headers.find(([, i]) => i > cursor) : [...headers].reverse().find(([, i]) => i < cursor);
        if (target)
          setCurrent(rowKey(target[0]));
        return;
      }
    }
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
      else if (key.return || key.rightArrow || input === "l")
        setFocus("page");
      else if (key.escape && filter)
        setFilter("");
      return;
    }
    const n = page?.links.length ?? 0;
    if (key.escape || key.leftArrow || input === "h")
      setFocus("list");
    else if (key.downArrow || input === "j" || input === "J")
      setScroll((s) => Math.min(maxScroll, s + 1));
    else if (key.upArrow || input === "k" || input === "K")
      setScroll((s) => Math.max(0, s - 1));
    else if ((input === "n" || input === "N") && n) {
      const from = activeLink ?? (input === "n" ? -1 : 0);
      const i = (from + (input === "n" ? 1 : -1) + n) % n;
      setLinkIdx(i);
      ensureVisible(page.linkLines[i]);
    } else if (key.return && activeLink !== undefined)
      follow(page.links[activeLink]);
  });
  const errors = store.errors().length;
  const warnings = store.issues.filter((i) => i.severity === "warning").length;
  const stores = displayPath(layers[0].root);
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
              inverse: view === "activity",
              bold: view === "activity",
              children: narrow ? " 2 " : " 2 activity "
            }),
            /* @__PURE__ */ jsx(Text, {
              inverse: view === "dreams",
              bold: view === "dreams",
              children: narrow ? " 3 " : " 3 dreams "
            }),
            /* @__PURE__ */ jsx(Text, {
              inverse: view === "graph",
              bold: view === "graph",
              children: narrow ? " 4 " : " 4 graph "
            }),
            results ? /* @__PURE__ */ jsx(Text, {
              inverse: view === "search",
              bold: view === "search",
              children: narrow ? " 5 " : " 5 search "
            }) : null,
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
  const footerText = searching ? null : view === "dreams" ? "↑↓ move  ⏎/→ page  R run a dream  1 browse  2 activity  4 graph  ? search  q" : view === "graph" ? `↑↓ move  ⏎/→ center  b back  +/- depth (${graphDepth})  o open in browse  e edit  1 browse  ? search  q` : narrow ? view === "browse" ? focus === "list" ? "↑↓ g/G · ⏎→ open · ← close · x/X all · [ ] · 2 activity · / ?" : "↑↓␣ g/G scroll · n/N link · ⏎ go · ← list · e" : focus === "list" ? view === "activity" ? "↑↓ g/G · ⏎→ open · ← close · x/X all · [ ] · o · 1 · ?" : "↑↓ g/G · ⏎→ page · o open · 1 browse · ?" : "↑↓␣ g/G scroll · n/N link · ⏎ go · ← list · o · e" : view === "browse" ? focus === "list" ? "↑↓ move  g/G top/bottom  ⏎/→ open  ← close  x/X collapse/expand all  [ ] prev/next type  tab page  2 activity  3 dreams  / filter  ? search  b back  e edit  q" : "↑↓/j/k/space scroll  g/G top/bottom  n/N next/prev link  enter follow  ←/esc list  2 activity  ? search  b back  e edit  q quit" : focus === "list" ? view === "activity" ? "↑↓ move  g/G top/bottom  ⏎/→ open  ← close  x/X collapse/expand all  [ ] prev/next day  o open in browse  tab page  1 browse  ? search  e edit  q" : "↑↓ move  g/G top/bottom  ⏎/→ page  o open in browse  tab page  1 browse  2 activity  ? search  e edit  q" : "↑↓/j/k/space scroll  g/G top/bottom  n/N next/prev link  enter follow  ←/esc list  o open in browse  e edit  q quit";
  const footer = asking ? /* @__PURE__ */ jsxs(Text, {
    wrap: "truncate",
    children: [
      /* @__PURE__ */ jsx(Text, {
        color: "cyan",
        children: "? "
      }),
      /* @__PURE__ */ jsx(Text, {
        children: question
      }),
      /* @__PURE__ */ jsx(Text, {
        inverse: true,
        children: " "
      }),
      /* @__PURE__ */ jsx(Text, {
        dimColor: true,
        children: narrow ? "" : "  search by meaning · enter run · esc cancel"
      })
    ]
  }) : searching ? /* @__PURE__ */ jsxs(Text, {
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
          tree.filter((r) => r.kind === "object" || r.kind === "wanted").length,
          " matches",
          narrow ? "" : " · enter keep · esc clear"
        ]
      })
    ]
  }) : /* @__PURE__ */ jsxs(Text, {
    dimColor: true,
    wrap: "truncate",
    children: [
      filter && view === "browse" ? /* @__PURE__ */ jsx(Text, {
        color: "yellow",
        children: narrow ? `/${filter} ` : `filter: ${filter} (esc clears)  `
      }) : null,
      footerText
    ]
  });
  const visibleLines = page?.lines.slice(scroll, scroll + innerHeight) ?? [];
  const activeLinkLine = focus === "page" && activeLink !== undefined ? page.linkLines[activeLink] : undefined;
  const pagePane = narrow && focus === "list" ? null : /* @__PURE__ */ jsx(Box, {
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
  });
  if (view !== "browse") {
    const w = leftWidth;
    const selectedOnList = focus === "list";
    let lines;
    let selectedLine = 0;
    if (view === "activity") {
      lines = actRows.map((r) => ({ key: r.key, line: activityLine(store, r, w, selectedOnList && r.key === sideSelected, changedIds) }));
      selectedLine = Math.max(0, actRows.findIndex((r) => r.key === sideSelected));
      if (!actRows.length)
        lines = [{ key: "empty", line: [{ text: " no activity logged yet", dim: true }] }];
    } else if (view === "dreams") {
      lines = dreams.map((d) => ({ key: d.id, line: dreamLine(d, w, selectedOnList && d.id === sideSelected) }));
      selectedLine = Math.max(0, dreams.findIndex((d) => d.id === sideSelected));
      const note = dreams[0]?.status === "running" ? undefined : dreamLive || dreamRunning(dreamsDir(process.env)) ? " dreaming…" : dreamNote;
      if (note) {
        lines.unshift({ key: "note", line: [{ text: truncate(note, w), color: "yellow" }] });
        selectedLine += 1;
      }
      if (!dreams.length && !note)
        lines = [{ key: "empty", line: [{ text: " no dreams yet; run /o6y-dream in pi", dim: true }] }];
    } else if (view === "graph") {
      lines = graphNodes.map((n) => ({ key: n.id, line: graphLine(store, n, adj, w, selectedOnList && n.id === sideSelected) }));
      selectedLine = Math.max(0, graphNodes.findIndex((n) => n.id === sideSelected));
      if (!graphNodes.length)
        lines = [{ key: "empty", line: [{ text: " nothing to graph yet", dim: true }] }];
    } else {
      const head = [{ text: truncate(`? ${results?.query ?? ""}`, w), color: "cyan", bold: true }];
      lines = [{ key: "query", line: head }];
      if (results?.status === "running")
        lines.push({ key: "status", line: [{ text: " searching…", dim: true }] });
      else if (results?.status === "error") {
        lines.push(...wrap(results.message ?? "search failed", w).map((t, i) => ({ key: `err${i}`, line: [{ text: t, color: "red" }] })));
      } else if (!hits.length)
        lines.push({ key: "status", line: [{ text: " no results", dim: true }] });
      let drewThreshold = false;
      hits.forEach((h, i) => {
        if (!drewThreshold && h.score < threshold) {
          drewThreshold = true;
          const label = ` threshold ${threshold.toFixed(2)} `;
          const side = Math.max(0, w - label.length);
          lines.push({ key: "threshold", line: [{ text: `${"─".repeat(Math.floor(side / 2))}${label}${"─".repeat(Math.ceil(side / 2))}`, color: "yellow", dim: true }] });
        }
        if (h.key === sideSelected)
          selectedLine = lines.length;
        lines.push({ key: h.key, line: searchLine(store, h, w, selectedOnList && h.key === sideSelected, threshold) });
        if (i === hits.length - 1 && !drewThreshold && hits.length)
          lines.push({ key: "all-above", line: [{ text: ` all above threshold ${threshold.toFixed(2)}`, dim: true }] });
      });
    }
    const start = clamp(selectedLine - Math.floor(innerHeight / 2), 0, Math.max(0, lines.length - innerHeight));
    const dialogWidth = Math.min(58, columns - 2);
    const models = [...new Set([store.dream.analyzerModel || store.dream.model, store.dream.organizerModel || store.dream.model])].map((m) => m || "pi's default").join(", ");
    const dialog = dreamAsk ? dreamFormLines(dreamAsk, { model: models, perSession: costPerSession(dreams) }, dialogWidth - 2) : [];
    return /* @__PURE__ */ jsxs(Box, {
      flexDirection: "column",
      width: columns,
      height: rows,
      children: [
        header,
        /* @__PURE__ */ jsxs(Box, {
          height: bodyHeight,
          children: [
            narrow && focus === "page" ? null : /* @__PURE__ */ jsx(Box, {
              flexDirection: "column",
              width: leftWidth + 2,
              flexShrink: 0,
              borderStyle: "round",
              borderColor: focus === "list" ? "cyan" : "gray",
              paddingX: 0,
              children: lines.slice(start, start + innerHeight).map((l) => /* @__PURE__ */ jsx(LineView, {
                line: l.line
              }, l.key))
            }),
            pagePane
          ]
        }),
        footer,
        dreamAsk ? /* @__PURE__ */ jsx(Box, {
          position: "absolute",
          top: Math.max(0, Math.floor((rows - dialog.length - 2) / 2)),
          left: Math.floor((columns - dialogWidth) / 2),
          width: dialogWidth,
          flexDirection: "column",
          borderStyle: "round",
          borderColor: "yellow",
          children: dialog.map((line, i) => /* @__PURE__ */ jsx(LineView, {
            line
          }, i))
        }) : null
      ]
    });
  }
  const listStart = clamp(cursor - Math.floor(innerHeight / 2), 0, Math.max(0, tree.length - innerHeight));
  const visibleRows = tree.slice(listStart, listStart + innerHeight);
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
              visibleRows.map((row2, i) => {
                const index = listStart + i;
                const w = leftWidth;
                const isCursor = index === cursor;
                if (row2.kind === "type" || row2.kind === "wanted-header") {
                  const name2 = row2.kind === "type" ? row2.name : "wanted";
                  const label2 = `${row2.open ? "▾" : "▸"} ${name2}`;
                  const count2 = ` ${row2.count}`;
                  return /* @__PURE__ */ jsxs(Text, {
                    wrap: "truncate",
                    children: [
                      /* @__PURE__ */ jsx(Text, {
                        bold: true,
                        color: row2.kind === "type" ? "magenta" : "red",
                        inverse: isCursor && focus === "list",
                        children: label2
                      }),
                      /* @__PURE__ */ jsx(Text, {
                        children: " ".repeat(Math.max(1, w - label2.length - count2.length))
                      }),
                      /* @__PURE__ */ jsx(Text, {
                        dimColor: true,
                        children: count2
                      })
                    ]
                  }, rowKey(row2));
                }
                const label = row2.kind === "object" ? row2.id.slice(row2.id.indexOf("/") + 1) : row2.id;
                const marks = [];
                if (row2.kind === "object") {
                  if (changedIds.has(row2.id))
                    marks.push({ t: "•", c: "green" });
                  if (row2.obj.pinned)
                    marks.push({ t: "★", c: "yellow" });
                  if (store.issuesFor(row2.obj.path).some((x) => x.severity === "error"))
                    marks.push({ t: "!", c: "red" });
                }
                const count = row2.kind === "object" ? store.backlinks.get(row2.id)?.size ?? 0 : row2.sources;
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
                      color: row2.kind === "wanted" ? "red" : isCursor ? "cyan" : undefined,
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
                }, `o:${row2.id}`);
              })
            ]
          }),
          pagePane
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
    }), { alternateScreen: true, exitOnCtrlC: true, incrementalRendering: true });
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
