/**
 * Planned changes to a store: edit documents in memory, validate the whole plan against the
 * store, then apply it. Used by the CLI's write commands (mv, merge, field rename, …).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Document, isMap, isScalar, parse, parseDocument, Scalar } from "yaml";
import { appendLog, type LogAction } from "./fsops.ts";
import { normalizeLinkValue } from "./links.ts";
import { blockingIssues, changeWarnings, findLayer, type Issue, type Layer, type Overlay, SCHEMA_FILE, Store } from "./store.ts";

const FENCE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n?---[ \t]*(?:\r?\n|$)/;

/** Splits a document into raw frontmatter (without fences) and body. */
export function splitDoc(text: string): { frontmatter: string | undefined; body: string } {
  const match = FENCE.exec(text);
  if (!match) return { frontmatter: undefined, body: text };
  return { frontmatter: match[1] ?? "", body: text.slice(match[0].length) };
}

export function joinDoc(frontmatter: string, body: string): string {
  const fm = frontmatter.endsWith("\n") ? frontmatter : `${frontmatter}\n`;
  return `---\n${fm}---\n${body}`;
}

/**
 * Edits a document's frontmatter as a YAML document (comments and key order are kept). The
 * callback may also return a new body.
 */
export function editFrontmatter(text: string, fn: (doc: Document) => string | void): string {
  const { frontmatter, body } = splitDoc(text);
  const doc = parseDocument(frontmatter ?? "");
  if (doc.errors.length) throw new Error(`invalid YAML frontmatter: ${doc.errors[0]!.message.split("\n")[0]}`);
  if (doc.contents === null) doc.contents = doc.createNode({}) as never;
  const newBody = fn(doc);
  const yaml = isMap(doc.contents) && doc.contents.items.length === 0 ? "" : tidyFlowLists(doc.toString());
  return joinDoc(yaml, newBody ?? body);
}

/** `[ a, b ]` → `[a, b]` (the style of the starter schemas), on lines without quoted strings. */
function tidyFlowLists(yaml: string): string {
  return yaml
    .split("\n")
    .map((line) => (/["']/.test(line) ? line : line.replace(/\[ ([^[\]{}]*?) \]/g, "[$1]")))
    .join("\n");
}

/** Renames a key of a YAML map node in place, keeping its position and value. Returns false if absent. */
export function renameKey(node: unknown, from: string, to: string): boolean {
  if (!isMap(node)) return false;
  for (const pair of node.items) {
    const key = isScalar(pair.key) ? pair.key.value : pair.key;
    if (key === from) {
      pair.key = new Scalar(to);
      return true;
    }
  }
  return false;
}

/** Parses a CLI value (`true`, `3`, `[a, b]`) as YAML; anything that isn't a scalar or list stays text. */
export function parseValue(raw: string): unknown {
  try {
    const value = parse(raw);
    if (value === null || value === undefined) return raw === "" ? "" : raw;
    if (typeof value === "object" && !Array.isArray(value)) return raw;
    return value;
  } catch {
    return raw;
  }
}

// ── link rewriting ───────────────────────────────────────────────────────

const BODY_LINK = /\[\[([^\]|#\n]+?)([|#][^\]\n]*)?\]\]/g;

/** Rewrites `[[id]]`, `[[id|label]]` and `[[id#heading]]` in a body, outside code. */
export function rewriteBodyLinks(body: string, map: (id: string) => string | undefined): string {
  let fence = false;
  return body
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        fence = !fence;
        return line;
      }
      if (fence) return line;
      // Leave inline code alone by only rewriting the parts outside backticks.
      return line
        .split(/(`[^`]*`)/)
        .map((part, i) =>
          i % 2 === 1
            ? part
            : part.replace(BODY_LINK, (whole, target: string, rest: string | undefined) => {
                const next = map(target.trim());
                return next ? `[[${next}${rest ?? ""}]]` : whole;
              }),
        )
        .join("");
    })
    .join("\n");
}

function rewriteLinkValue(value: unknown, map: (id: string) => string | undefined): { value: unknown; changed: boolean } {
  if (Array.isArray(value)) {
    // `[[a/b]]` unquoted parses as a nested array; treat it as one link.
    if (value.length === 1 && Array.isArray(value[0]) && value[0].length === 1 && typeof value[0][0] === "string") {
      const next = map(value[0][0]);
      return next ? { value: `[[${next}]]`, changed: true } : { value, changed: false };
    }
    let changed = false;
    const out = value.map((v) => {
      const r = rewriteLinkValue(v, map);
      changed ||= r.changed;
      return r.value;
    });
    return { value: out, changed };
  }
  if (typeof value === "string") {
    const target = normalizeLinkValue(value)?.[0];
    const next = target ? map(target) : undefined;
    if (!next) return { value, changed: false };
    return { value: value.trim().startsWith("[[") ? `[[${next}]]` : next, changed: true };
  }
  return { value, changed: false };
}

/**
 * Rewrites every link (typed link fields and body links) in every object, using `plan` contents
 * where the plan already changed a file. Records changed files in the plan.
 */
export function retargetLinks(store: Store, plan: Plan, map: (id: string) => string | undefined): void {
  for (const obj of store.objects.values()) {
    const current = plan.read(obj.path);
    if (current === null) continue;
    const linkFields = Object.entries(store.types.get(obj.type)?.schema.fields ?? {})
      .filter(([, f]) => f.type === "link")
      .map(([name]) => name);
    let next: string;
    try {
      next = editFrontmatter(current, (doc) => {
        for (const field of linkFields) {
          if (!doc.has(field)) continue;
          const r = rewriteLinkValue(doc.toJS()[field], map);
          if (r.changed) doc.set(field, r.value);
        }
        return rewriteBodyLinks(splitDoc(current).body, map);
      });
    } catch {
      continue; // unparseable frontmatter: leave the file to lint
    }
    if (next !== current) plan.write(obj.path, next);
  }
}

// ── plans ────────────────────────────────────────────────────────────────

export interface PlanResult {
  blocking: Issue[];
  warnings: Issue[];
  /** Planned file changes, in apply order. */
  changes: { action: LogAction; path: string }[];
}

/** An in-memory set of file writes and deletes, validated as one transaction before applying. */
export class Plan {
  readonly overlay: Overlay = new Map();

  constructor(readonly layers: Layer[]) {}

  /** The file's content as the plan currently sees it (null when deleted or missing). */
  read(path: string): string | null {
    if (this.overlay.has(path)) return this.overlay.get(path)!;
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  }

  write(path: string, content: string): void {
    this.overlay.set(path, content);
  }

  delete(path: string): void {
    this.overlay.set(path, null);
  }

  get empty(): boolean {
    return this.changes().length === 0;
  }

  changes(): { action: LogAction; path: string }[] {
    const out: { action: LogAction; path: string }[] = [];
    for (const [path, content] of this.overlay) {
      const exists = existsSync(path);
      if (content === null) {
        if (exists) out.push({ action: "delete", path });
      } else if (!exists) out.push({ action: "create", path });
      else if (readFileSync(path, "utf8") !== content) out.push({ action: "update", path });
    }
    return out;
  }

  /** Validates the plan against the current store. Blocking issues are new errors it would cause. */
  validate(before: Store = Store.load(this.layers)): PlanResult {
    const after = Store.load(this.layers, this.overlay);
    const touched = new Set(this.overlay.keys());
    return {
      blocking: blockingIssues(before, after, touched),
      warnings: changeWarnings(before, after, touched),
      changes: this.changes(),
    };
  }

  /** Writes the plan to disk, removes type folders it emptied, and logs the changes. */
  apply(via: string): { action: LogAction; path: string }[] {
    const changes = this.changes();
    for (const { action, path } of changes) {
      if (action === "delete") continue;
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, this.overlay.get(path)!);
    }
    for (const { action, path } of changes) {
      if (action !== "delete") continue;
      rmSync(path, { force: true });
      const dir = dirname(path);
      const layer = findLayer(this.layers, path);
      if (layer && dir !== layer.root && existsSync(dir) && readdirSync(dir).length === 0) {
        try {
          rmdirSync(dir);
        } catch {}
      }
    }
    if (changes.length) appendLog(this.layers, changes, via);
    return changes;
  }
}

/** Path of the type schema for `type` in `layer`. */
export function schemaPath(layer: Layer, type: string): string {
  return join(layer.root, type, SCHEMA_FILE);
}
