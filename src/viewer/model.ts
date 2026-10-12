/**
 * Pure view model for the o6y viewer: link edges, the browse list, page lines and the link tree.
 * Lines are arrays of styled segments so they can be rendered by Ink or tested as plain text.
 */
import { stringify } from "yaml";
import { type Edge, neighbors } from "../core/ops.ts";
import type { ObjectEntry, Store } from "../core/store.ts";

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

// ── link tree ────────────────────────────────────────────────────────────

export interface TreeNode {
  /** Unique path from the root, e.g. `note/a>out:note/b>in:person/c`. */
  key: string;
  id: string;
  depth: number;
  /** How this node relates to its parent: linked from it (out), links to it (in), or both. */
  dir: "root" | "out" | "in" | "both";
  via: string[];
  missing: boolean;
  /** Already an ancestor on this path; shown but not expandable. */
  cycle: boolean;
  expandable: boolean;
  expanded: boolean;
  /** For each ancestor level (and this one), whether that node is the last of its siblings. */
  last: boolean[];
}

/**
 * The visible rows of a tree rooted at `root`: each node's children are what it links to (→),
 * then what links to it (←); mutual links appear once (↔). The parent itself is left out of its
 * children. Only nodes whose key is in `expanded` show their children.
 */
export function linkTree(store: Store, root: string, expanded: Set<string>): TreeNode[] {
  const rows: TreeNode[] = [];
  const childrenOf = (id: string, parent: string | undefined) => {
    const nb = neighbors(store, id);
    const incoming = new Map(nb.in.map((e) => [e.id, e]));
    const children: { e: Edge; dir: "out" | "in" | "both" }[] = [];
    for (const e of nb.out) {
      const back = incoming.get(e.id);
      if (back) incoming.delete(e.id);
      children.push(back ? { e: { ...e, via: [...new Set([...e.via, ...back.via])] }, dir: "both" } : { e, dir: "out" });
    }
    for (const e of incoming.values()) children.push({ e, dir: "in" });
    return children.filter((c) => c.e.id !== parent);
  };
  const visit = (id: string, key: string, depth: number, dir: TreeNode["dir"], via: string[], last: boolean[], ancestors: string[]) => {
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
      last,
    });
    if (!isOpen) return;
    const next = [...ancestors, id];
    children.forEach(({ e, dir: d }, i) =>
      visit(e.id, `${key}>${d}:${e.id}`, depth + 1, d, e.via, [...last, i === children.length - 1], next),
    );
  };
  visit(root, root, 0, "root", [], [true], []);
  return rows;
}

/** One tree row: guides, expand marker, direction, id, and the summary if there's room. */
export function treeLine(store: Store, node: TreeNode, width: number, selected: boolean, changed?: Set<string>): Line {
  let guides = "";
  for (let d = 1; d < node.depth; d++) guides += node.last[d] ? "   " : "│  ";
  if (node.depth > 0) guides += node.last[node.depth] ? "└─ " : "├─ ";
  const marker = node.cycle ? "↺ " : node.expandable ? (node.expanded ? "▾ " : "▸ ") : "  ";
  const arrow = { root: "", out: "→ ", in: "← ", both: "↔ " }[node.dir];
  const color = node.missing ? "red" : node.dir === "root" ? "green" : "cyan";
  const used = guides.length + marker.length + arrow.length;
  const id = truncate(node.id, Math.max(4, width - used));
  const segs: Line = [
    { text: guides, dim: true },
    { text: marker, color: node.cycle ? "gray" : "yellow" },
    { text: arrow, dim: true },
    { text: id, color, bold: selected || node.dir === "root", inverse: selected, dim: node.cycle },
  ];
  if (changed?.has(node.id)) segs.push({ text: " •", color: "green" });
  const room = width - used - id.length - (changed?.has(node.id) ? 2 : 0);
  const summary = node.cycle ? "(already above)" : (store.objects.get(node.id)?.summary ?? "not written yet");
  if (room > 12) segs.push({ text: truncate(` — ${summary}`, room), dim: true });
  return segs;
}
