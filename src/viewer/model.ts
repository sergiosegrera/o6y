/**
 * View model for the o6y viewer: link edges, the browse list, page lines, the activity timeline
 * and search results.
 * Lines are arrays of styled segments so they can be rendered by Ink or tested as plain text.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { type Edge, neighbors } from "../core/ops.ts";
import { readSuggestionLog } from "../core/semantic.ts";
import { type Layer, LOG_FILE, type ObjectEntry, type Store } from "../core/store.ts";

export { type Edge, neighbors };
import { displayPath } from "../core/render.ts";

export interface Seg {
  text: string;
  color?: string;
  bold?: boolean;
  italic?: boolean;
  dim?: boolean;
  inverse?: boolean;
  underline?: boolean;
}
export type Line = Seg[];

export const plain = (line: Line): string => line.map((s) => s.text).join("");

// ── browse tree ──────────────────────────────────────────────────────────

export type Row =
  | { kind: "type"; name: string; count: number; layer: string; open: boolean }
  | { kind: "object"; id: string; obj: ObjectEntry }
  | { kind: "wanted-header"; count: number; open: boolean }
  | { kind: "wanted"; id: string; sources: number };

/** Header row keys; object and wanted rows are keyed by their id. */
export const typeKey = (name: string) => `type:${name}`;
export const WANTED_KEY = "wanted:";

export function rowKey(row: Row): string {
  if (row.kind === "type") return typeKey(row.name);
  if (row.kind === "wanted-header") return WANTED_KEY;
  return row.id;
}

/** The header key a row sits under. */
export function parentKey(store: Store, key: string): string | undefined {
  if (key.startsWith("type:") || key === WANTED_KEY) return undefined;
  const obj = store.objects.get(key);
  return obj ? typeKey(obj.type) : WANTED_KEY;
}

export function matches(store: Store, id: string, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  const obj = store.objects.get(id);
  if (id.toLowerCase().includes(q)) return true;
  if (!obj) return false;
  return obj.summary.toLowerCase().includes(q) || obj.body.toLowerCase().includes(q);
}

/**
 * Types with their objects, then wanted pages. Only headers whose key is in `open` show their
 * rows; while filtering, every matching group is open and empty types are hidden.
 */
export function treeRows(store: Store, query = "", open: Set<string> | "all" = "all"): Row[] {
  const isOpen = (key: string) => open === "all" || !!query || open.has(key);
  const byType = new Map<string, ObjectEntry[]>();
  for (const obj of store.objects.values()) {
    if (!matches(store, obj.id, query)) continue;
    const list = byType.get(obj.type) ?? [];
    list.push(obj);
    byType.set(obj.type, list);
  }
  const rows: Row[] = [];
  const types = [...store.types.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const type of types) {
    const objects = (byType.get(type.name) ?? []).sort((a, b) => a.id.localeCompare(b.id));
    if (query && !objects.length) continue;
    const open = isOpen(typeKey(type.name));
    rows.push({ kind: "type", name: type.name, count: objects.length, layer: type.layer.name, open });
    if (open) for (const obj of objects) rows.push({ kind: "object", id: obj.id, obj });
  }
  const wanted = [...store.wanted].filter(([id]) => matches(store, id, query)).sort(([a], [b]) => a.localeCompare(b));
  if (wanted.length) {
    const open = isOpen(WANTED_KEY);
    rows.push({ kind: "wanted-header", count: wanted.length, open });
    if (open) for (const [id, sources] of wanted) rows.push({ kind: "wanted", id, sources: sources.size });
  }
  return rows;
}

export const selectable = (row: Row): row is Extract<Row, { id: string }> => row.kind === "object" || row.kind === "wanted";

// ── text ─────────────────────────────────────────────────────────────────

export function truncate(text: string, width: number): string {
  if (width <= 0) return "";
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`;
}

/** Word-wraps one line, hard-breaking words longer than the width. Keeps leading indentation. */
export function wrap(text: string, width: number): string[] {
  if (width <= 0) return [text];
  if (text.length <= width) return [text];
  const indent = /^\s*(?:[-*] |\d+\. )?/.exec(text)![0].replace(/\S/g, " ");
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/(\s+)/)) {
    if (!word) continue;
    if ((line + word).length <= width) {
      line += word;
      continue;
    }
    if (line.trim()) out.push(line.trimEnd());
    line = /^\s+$/.test(word) ? indent : indent + word;
    while (line.length > width) {
      out.push(line.slice(0, width));
      line = indent + line.slice(width);
    }
  }
  if (line.trim()) out.push(line.trimEnd());
  return out.length ? out : [""];
}

const LINK_RE = /\[\[([^\]\n]+?)\]\]/g;

/** Splits text into segments, coloring [[links]] (red when they point at a missing object). */
function linkSegs(store: Store, text: string, base: Seg = { text: "" }): Seg[] {
  const segs: Seg[] = [];
  let last = 0;
  for (const m of text.matchAll(LINK_RE)) {
    if (m.index! > last) segs.push({ ...base, text: text.slice(last, m.index) });
    const target = m[1]!.split("|")[0]!.split("#")[0]!.trim();
    segs.push({ ...base, text: m[0], color: store.objects.has(target) ? "cyan" : "red", underline: true });
    last = m.index! + m[0].length;
  }
  if (last < text.length) segs.push({ ...base, text: text.slice(last) });
  return segs.length ? segs : [{ ...base, text: "" }];
}

const BLOCK_START = /^\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|>|```|~~~|\||$)/;

/** Joins soft-wrapped paragraph lines (as markdown renders them), leaving code and block syntax alone. */
export function joinParagraphs(lines: string[]): string[] {
  const out: string[] = [];
  let fence = false;
  let joinable = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const continuation = !fence && joinable && line.trim() !== "" && !BLOCK_START.test(line);
    if (continuation) out[out.length - 1] += ` ${line.trim()}`;
    else out.push(line);
    joinable = !fence && line.trim() !== "" && !/^\s*(#{1,6}\s|```|~~~|\|)/.test(line) && !line.endsWith("  ");
  }
  return out;
}

function markdownLines(store: Store, body: string, width: number): Line[] {
  const lines: Line[] = [];
  let fence = false;
  for (const raw of joinParagraphs(body.replace(/\s+$/, "").split("\n"))) {
    if (/^\s*(```|~~~)/.test(raw)) {
      fence = !fence;
      lines.push([{ text: raw, dim: true }]);
      continue;
    }
    if (fence) {
      for (const w of wrap(raw, width)) lines.push([{ text: w, color: "yellow" }]);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(raw);
    if (heading) {
      for (const w of wrap(heading[2]!, width)) lines.push([{ text: w, bold: true, color: "magenta" }]);
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

/** Renders **bold** inside an unstyled segment. */
function boldSegs(seg: Seg): Seg[] {
  if (seg.color || !seg.text.includes("**")) return [seg];
  return seg.text.split(/(\*\*[^*]+\*\*)/).filter(Boolean).map((part) =>
    /^\*\*[^*]+\*\*$/.test(part) ? { ...seg, text: part.slice(2, -2), bold: true } : { ...seg, text: part },
  );
}

function formatField(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (Array.isArray(value)) return value.map((v) => (Array.isArray(v) ? `[[${v.flat().join("")}]]` : String(v))).join(", ");
  if (value && typeof value === "object") return stringify(value).trim();
  return String(value);
}

export interface Page {
  lines: Line[];
  /** Link targets in display order (outgoing, then backlinks), for the link cursor. */
  links: string[];
  /** Index in `lines` where each entry of `links` is listed. */
  linkLines: number[];
}

/** The page for an object or wanted page: header, fields, body, links and backlinks. */
export function renderPage(store: Store, id: string, width: number, changed?: Set<string>): Page {
  const obj = store.objects.get(id);
  const lines: Line[] = [];
  const nb = neighbors(store, id);
  if (!obj) {
    lines.push([{ text: id, bold: true, color: "red" }]);
    lines.push([{ text: "Wanted page: linked but not written yet.", dim: true }]);
  } else {
    const type = store.types.get(obj.type);
    const tags: Seg[] = [{ text: ` ${obj.layer.name}`, dim: true }];
    if (obj.pinned) tags.push({ text: " pinned", color: "yellow" });
    if (changed?.has(id)) tags.push({ text: " changed", color: "green" });
    lines.push([{ text: id, bold: true, color: "cyan" }, ...tags]);
    for (const w of wrap(obj.summary || "(no summary)", width)) lines.push([{ text: w, italic: true }]);
    lines.push([{ text: displayPath(obj.path), dim: true }]);
    const fields = Object.entries(obj.data).filter(([k]) => k !== "summary" && k !== "pinned");
    if (fields.length) {
      lines.push([]);
      const keyWidth = Math.min(16, Math.max(...fields.map(([k]) => k.length)));
      for (const [key, value] of fields) {
        const declared = !!type?.schema.fields[key];
        const text = formatField(value);
        const isLink = type?.schema.fields[key]?.type === "link";
        const shown = isLink ? text.split(", ").map((t) => (t.startsWith("[[") ? t : `[[${t}]]`)).join(", ") : text;
        const valueLines = wrap(shown, Math.max(10, width - keyWidth - 2));
        valueLines.forEach((v, i) => {
          const keySeg: Seg = i === 0 ? { text: key.padEnd(keyWidth) + "  ", color: declared ? "blue" : "gray" } : { text: " ".repeat(keyWidth + 2) };
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

  const links: string[] = [];
  const linkLines: number[] = [];
  const section = (title: string, edges: Edge[], arrow: string) => {
    if (!edges.length) return;
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
        { text: truncate(` — ${summary}`, Math.max(0, width - head.length - via.length)), dim: true },
      ]);
    }
  };
  section("Links", nb.out, "→");
  section("Backlinks", nb.in, "←");
  return { lines, links, linkLines };
}

/** The page for a type header: description, schema, guidance and its objects (as links). */
export function renderTypePage(store: Store, typeName: string, width: number): Page {
  const type = store.types.get(typeName);
  const lines: Line[] = [];
  const links: string[] = [];
  const linkLines: number[] = [];
  if (!type) return { lines: [[{ text: `no type ${typeName}`, color: "red" }]], links, linkLines };
  const objects = store.objectsOfType(typeName);
  lines.push([{ text: typeName, bold: true, color: "magenta" }, { text: ` ${type.layer.name} · ${objects.length} objects`, dim: true }]);
  for (const w of wrap(type.schema.description, width)) lines.push([{ text: w, italic: true }]);
  lines.push([{ text: displayPath(type.path), dim: true }]);
  const fields = Object.entries(type.schema.fields);
  if (fields.length) {
    lines.push([]);
    const keyWidth = Math.min(16, Math.max(...fields.map(([k]) => k.length)));
    for (const [name, f] of fields) {
      const spec = [f.type === "link" ? `link→${f.to === "any" || !f.to ? "any" : f.to.join("|")}${f.many ? "[]" : ""}` : f.type === "enum" ? `enum(${f.values!.join("|")})` : f.type, f.required ? "required" : ""]
        .filter(Boolean)
        .join(", ");
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

/** The page for the wanted header: every linked-but-missing page and who links to it. */
export function renderWantedPage(store: Store, width: number): Page {
  const lines: Line[] = [[{ text: "Wanted pages", bold: true, color: "red" }, { text: ` ${store.wanted.size}`, dim: true }]];
  lines.push([{ text: "Linked from somewhere but not written yet.", dim: true }], []);
  const links: string[] = [];
  const linkLines: number[] = [];
  for (const [id, sources] of [...store.wanted].sort(([a], [b]) => a.localeCompare(b))) {
    links.push(id);
    linkLines.push(lines.length);
    lines.push([{ text: `  ${id}`, color: "red" }, { text: truncate(` ← ${[...sources].sort().join(", ")}`, Math.max(0, width - id.length - 2)), dim: true }]);
  }
  return { lines, links, linkLines };
}

// ── activity ─────────────────────────────────────────────────────────────

export type ActivityAction = "create" | "update" | "delete" | "suggest" | "open";

export interface ActivityEntry {
  at: number;
  action: ActivityAction;
  /** An object id, `schema <type>`, `root schema`, or a store-relative path (as log.md names it). */
  target: string;
  /** What made the change (`write`, `edit`, `bash`, `o6y mv`…), or for suggestions the session. */
  via: string;
  layer: string;
  /** Suggestions: rerank score. */
  score?: number;
}

const LOG_LINE = /^- (\S+) (create|update|delete) (.+) \((.+)\)$/;

/** Parses a layer's log.md, oldest first. */
export function parseLog(text: string, layer: string): ActivityEntry[] {
  const out: ActivityEntry[] = [];
  for (const line of text.split("\n")) {
    const m = LOG_LINE.exec(line);
    const at = m ? Date.parse(m[1]!) : NaN;
    if (m && !Number.isNaN(at)) out.push({ at, action: m[2] as ActivityAction, target: m[3]!, via: m[4]!, layer });
  }
  return out;
}

/** Store changes from every layer's log.md, plus suggestions and opens from the suggestion log. */
export function readActivity(layers: Layer[], cache?: string): ActivityEntry[] {
  const entries: ActivityEntry[] = [];
  for (const layer of layers) {
    try {
      entries.push(...parseLog(readFileSync(join(layer.root, LOG_FILE), "utf8"), layer.name));
    } catch {}
  }
  if (cache) {
    for (const r of readSuggestionLog(cache)) {
      const at = Date.parse(r.t);
      if (Number.isNaN(at)) continue;
      if (r.type === "suggest") for (const h of r.hits) entries.push({ at, action: "suggest", target: h.id, via: r.session, layer: "", score: h.score });
      else entries.push({ at, action: "open", target: r.id, via: r.via, layer: "" });
    }
  }
  return entries.sort((a, b) => b.at - a.at);
}

export type ActivityRow =
  | { kind: "day"; key: string; label: string; count: number }
  | { kind: "entry"; key: string; entry: ActivityEntry; nested: boolean }
  | { kind: "batch"; key: string; entries: ActivityEntry[]; open: boolean };

/** Changes this many or more with the same second and source (a bash migration, an `o6y mv`) collapse into one row. */
const BATCH_MIN = 3;
const isSuggestion = (e: ActivityEntry) => e.action === "suggest" || e.action === "open";

function dayLabel(at: number, now: Date): string {
  const d = new Date(at);
  const days = Math.round((new Date(now).setHours(0, 0, 0, 0) - new Date(at).setHours(0, 0, 0, 0)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", ...(days > 300 ? { year: "numeric" } : {}) });
}

/**
 * Newest first, under day headers. Same-second changes from one source collapse into a batch
 * row; only batches whose key is in `open` list their entries. `query` matches target or source.
 */
export function activityRows(entries: ActivityEntry[], open: Set<string>, query = "", now = new Date()): ActivityRow[] {
  const q = query.toLowerCase();
  const shown = q ? entries.filter((e) => e.target.toLowerCase().includes(q) || e.via.toLowerCase().includes(q)) : entries;
  const groups: ActivityEntry[][] = [];
  for (const e of shown) {
    const g = groups[groups.length - 1];
    const head = g?.[0];
    if (head && head.at === e.at && head.via === e.via && isSuggestion(head) === isSuggestion(e)) g.push(e);
    else groups.push([e]);
  }
  const rows: ActivityRow[] = [];
  const seen = new Map<string, number>();
  const unique = (base: string) => {
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n ? `${base}#${n}` : base;
  };
  let day: Extract<ActivityRow, { kind: "day" }> | undefined;
  for (const g of groups) {
    const label = dayLabel(g[0]!.at, now);
    if (day?.label !== label) {
      day = { kind: "day", key: unique(`day:${label}`), label, count: 0 };
      rows.push(day);
    }
    day.count += g.length;
    const entryRow = (e: ActivityEntry, nested: boolean): ActivityRow => ({
      kind: "entry",
      key: unique(`${e.at}|${e.action}|${e.target}|${e.via}`),
      entry: e,
      nested,
    });
    if (g.length < BATCH_MIN) {
      for (const e of g) rows.push(entryRow(e, false));
      continue;
    }
    const key = unique(`batch:${g[0]!.at}|${g[0]!.via}|${isSuggestion(g[0]!) ? "s" : "c"}`);
    const isOpen = open.has(key);
    rows.push({ kind: "batch", key, entries: g, open: isOpen });
    if (isOpen) for (const e of g) rows.push(entryRow(e, true));
  }
  return rows;
}

const ACTION_MARK: Record<ActivityAction, { mark: string; color: string; verb: string }> = {
  create: { mark: "+", color: "green", verb: "created" },
  update: { mark: "~", color: "yellow", verb: "updated" },
  delete: { mark: "−", color: "red", verb: "deleted" },
  suggest: { mark: "◆", color: "cyan", verb: "suggested" },
  open: { mark: "↗", color: "blue", verb: "opened" },
};

const clock = (at: number) => new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

/** What an entry shows on the right: the source, or for a suggestion its score. */
const entrySource = (e: ActivityEntry) => (e.action === "suggest" ? (e.score ?? 0).toFixed(2) : e.via);

function batchSummary(entries: ActivityEntry[]): string {
  const counts = new Map<ActivityAction, number>();
  for (const e of entries) counts.set(e.action, (counts.get(e.action) ?? 0) + 1);
  return [...counts].map(([a, n]) => `${ACTION_MARK[a].mark}${n}`).join(" ");
}

/** One row of the activity list. */
export function activityLine(store: Store, row: ActivityRow, width: number, selected: boolean, changed?: Set<string>): Line {
  if (row.kind === "day") {
    return [{ text: row.label, bold: true, color: "magenta" }, { text: ` ${row.count}`, dim: true }];
  }
  if (row.kind === "batch") {
    const head = row.entries[0]!;
    const what = isSuggestion(head) ? `${row.entries.length} suggested` : `${row.entries.length} changes`;
    const left = `${clock(head.at)} ${row.open ? "▾" : "▸"} ${what} `;
    const right = ` ${batchSummary(row.entries)} · ${isSuggestion(head) ? "suggestions" : head.via}`;
    return [
      { text: left, bold: selected, inverse: selected, color: selected ? "cyan" : undefined },
      { text: truncate(right, Math.max(0, width - left.length)), dim: true },
    ];
  }
  const e = row.entry;
  const a = ACTION_MARK[e.action];
  const time = row.nested ? "   " : clock(e.at);
  const missing = !e.target.includes(" ") && e.target.includes("/") && !store.objects.has(e.target);
  const source = ` ${entrySource(e)}`;
  const mark = changed?.has(e.target) ? " •" : "";
  const nameWidth = Math.max(4, width - time.length - 3 - mark.length - (width > 34 ? source.length : 0));
  const segs: Line = [
    { text: `${time} `, dim: true },
    { text: `${a.mark} `, color: a.color },
    { text: truncate(e.target, nameWidth), color: missing ? "red" : e.target.includes(" ") ? "magenta" : selected ? "cyan" : undefined, bold: selected, inverse: selected },
  ];
  if (mark) segs.push({ text: mark, color: "green" });
  // The source, right-aligned, when it fits.
  const room = width - plain(segs).length;
  if (room >= source.length) segs.push({ text: source.padStart(room), dim: true });
  return segs;
}

/** The object an activity row points at, if it still exists (schema rows point at the type). */
export function activityTarget(store: Store, row: ActivityRow): { object?: string; type?: string } {
  if (row.kind !== "entry") return {};
  const t = row.entry.target;
  if (t.startsWith("schema ")) return store.types.has(t.slice(7)) ? { type: t.slice(7) } : {};
  return store.objects.has(t) ? { object: t } : {};
}

/** The right-hand page for an activity row. */
export function renderActivityPage(store: Store, row: ActivityRow, width: number, changed?: Set<string>): Page {
  const links: string[] = [];
  const linkLines: number[] = [];
  const lines: Line[] = [];
  const stamp = (at: number) => new Date(at).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "medium" });
  const describeEntry = (e: ActivityEntry): Line => {
    const a = ACTION_MARK[e.action];
    return [{ text: `${a.mark} ${a.verb}`, color: a.color }, { text: ` ${stamp(e.at)} · ${e.action === "suggest" ? `score ${entrySource(e)}` : e.action === "open" ? `via ${e.via}` : e.via}${e.layer ? ` · ${e.layer}` : ""}`, dim: true }];
  };
  if (row.kind === "entry") {
    const { object, type } = activityTarget(store, row);
    const page = object ? renderPage(store, object, width, changed) : type ? renderTypePage(store, type, width) : undefined;
    const head = [describeEntry(row.entry), []];
    if (page) return { lines: [...head, ...page.lines], links: page.links, linkLines: page.linkLines.map((n) => n + head.length) };
    lines.push(...head, [{ text: row.entry.target, bold: true, color: "red" }]);
    lines.push([{ text: row.entry.action === "delete" || !store.objects.has(row.entry.target) ? "No longer in the store." : "", dim: true }]);
    return { lines, links, linkLines };
  }
  const entries = row.kind === "batch" ? row.entries : [];
  if (row.kind === "day") lines.push([{ text: row.label, bold: true, color: "magenta" }, { text: ` ${row.count} events`, dim: true }]);
  else {
    const head = entries[0]!;
    lines.push([{ text: isSuggestion(head) ? `${entries.length} suggestions` : `${entries.length} changes`, bold: true }, { text: ` ${stamp(head.at)} · ${isSuggestion(head) ? "suggestions" : head.via}`, dim: true }], []);
    for (const e of entries) {
      const a = ACTION_MARK[e.action];
      const exists = store.objects.has(e.target);
      if (exists) {
        links.push(e.target);
        linkLines.push(lines.length);
      }
      const summary = store.objects.get(e.target)?.summary;
      lines.push([
        { text: `${a.mark} `, color: a.color },
        { text: e.target, color: exists ? "cyan" : "red" },
        { text: truncate(summary ? ` — ${summary}` : e.action === "suggest" ? ` ${entrySource(e)}` : "", Math.max(0, width - e.target.length - 2)), dim: true },
      ]);
    }
  }
  return { lines, links, linkLines };
}

// ── semantic search results ──────────────────────────────────────────────

export interface SearchRow {
  key: string;
  id: string;
  score: number;
  similarity: number;
}

/** One result line; results under the threshold are dimmed (the agent wouldn't be shown them). */
export function searchLine(store: Store, hit: SearchRow, width: number, selected: boolean, threshold: number): Line {
  const score = `${hit.score.toFixed(2)} `;
  const below = hit.score < threshold;
  return [
    { text: score, color: below ? "gray" : "green" },
    { text: truncate(hit.id, Math.max(4, width - score.length)), color: selected ? "cyan" : undefined, bold: selected, inverse: selected, dim: below && !selected },
  ];
}
