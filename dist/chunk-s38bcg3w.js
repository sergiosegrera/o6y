#!/usr/bin/env node
import {
  parseDoc,
  splitDoc,
  joinDoc,
  normalizeLinkValue,
  SCHEMA_FILE,
  LOG_FILE,
  findLayer,
  classifyPath,
  Store,
  blockingIssues,
  changeWarnings
} from "./chunk-fh0jaf4t.js";

// src/core/edit.ts
import { existsSync as existsSync3, mkdirSync as mkdirSync3, readdirSync as readdirSync2, readFileSync as readFileSync3, rmdirSync as rmdirSync2, rmSync as rmSync2, writeFileSync as writeFileSync3 } from "node:fs";
import { dirname as dirname2, join as join3 } from "node:path";
import { isMap, isScalar, isSeq, parse as parse2, parseDocument as parseDocument2, Scalar } from "yaml";

// src/core/fsops.ts
import { appendFileSync, existsSync as existsSync2, mkdirSync as mkdirSync2, readdirSync, readFileSync as readFileSync2, rmdirSync, rmSync, statSync, writeFileSync as writeFileSync2 } from "node:fs";
import { dirname, join as join2, relative } from "node:path";

// src/core/format.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseDocument } from "yaml";
var FORMAT_VERSION = 1;
var FORMAT_KEY = "o6yFormat";
var MIGRATIONS = {};
function readFormat(rootSchemaText) {
  const value = parseDoc(rootSchemaText).data?.[FORMAT_KEY];
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}
function setFormat(text, version) {
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n?---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match)
    return `---
${FORMAT_KEY}: ${version}
---
${text}`;
  const doc = parseDocument(match[1] ?? "");
  doc.set(FORMAT_KEY, version);
  return `---
${String(doc)}---
${text.slice(match[0].length)}`;
}
function ensureFormat(layer, migrations = MIGRATIONS, current = FORMAT_VERSION) {
  if (!existsSync(layer.root))
    return { status: "absent" };
  const path = join(layer.root, SCHEMA_FILE);
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  const stamped = readFormat(text);
  const from = stamped ?? 1;
  if (from > current)
    return { status: "newer", version: from };
  for (let v = from;v < current; v++) {
    const migrate = migrations[v];
    if (!migrate)
      throw new Error(`o6y: no migration from store format ${v} to ${v + 1}`);
    migrate(layer.root);
  }
  if (stamped === current)
    return { status: "current", version: current };
  const latest = existsSync(path) ? readFileSync(path, "utf8") : "";
  mkdirSync(layer.root, { recursive: true });
  writeFileSync(path, setFormat(latest, current));
  return from < current ? { status: "migrated", from, to: current } : { status: "stamped", version: current };
}

// src/core/fsops.ts
function describe(layers, path) {
  const info = classifyPath(layers, path);
  if (!info)
    return path;
  switch (info.kind) {
    case "object":
      return info.id;
    case "type-schema":
      return `schema ${info.type}`;
    case "root-schema":
      return "root schema";
    default:
      return relative(info.layer.root, path);
  }
}
var LOG_LINE = /^- (\S+) (create|update|delete) (.+) \((.+)\)(?: \[([^\]]+)\])?$/;
function appendLog(layers, entries, via, now = new Date) {
  const stamp = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  const byLayer = new Map;
  for (const { action, path, source } of entries) {
    const info = classifyPath(layers, path);
    if (!info || info.kind === "log")
      continue;
    if (!byLayer.has(info.layer))
      byLayer.set(info.layer, []);
    byLayer.get(info.layer).push(`- ${stamp} ${action} ${describe(layers, path)} (${via})${source ? ` [${source}]` : ""}`);
  }
  for (const [layer, lines] of byLayer) {
    const logPath = join2(layer.root, LOG_FILE);
    mkdirSync2(layer.root, { recursive: true });
    if (!existsSync2(logPath))
      writeFileSync2(logPath, `# o6y log

Append-only; written by o6y.

`);
    appendFileSync(logPath, lines.join(`
`) + `
`);
  }
}
var STARTER_SCHEMAS = {
  [SCHEMA_FILE]: `---
o6yFormat: ${FORMAT_VERSION}
summaryMaxLength: 80
promptBudget: 8000
namesBudget: 10000
pinnedBudget: 2500
---
Memory of the user and their work: the people, preferences, decisions and tribal knowledge a
teammate would need. Keep objects factual, concise and linked. The starter types are deliberately
minimal; when a kind of note keeps recurring (systems, gotchas, runbooks…), give it its own type.
`,
  [`person/${SCHEMA_FILE}`]: `---
description: Someone the user works with or mentions (teammate, reviewer, stakeholder)
fields:
  role: string
  team: string
index: [role]
---
Who they are, what they own or know best, and how to work with them. If they review code, a
\`## Review notes\` section (what they look for, recurring feedback) lets you pre-empt their review.
`,
  [`preference/${SCHEMA_FILE}`]: `---
description: How the user or team wants things done (style, tools, workflow, communication)
fields:
  scope: { type: string, description: "who it applies to: user, team, or a project/repo name" }
index: [scope]
alwaysList: true
---
Write the preference as an instruction you can follow, plus the reason if known. One preference
per object; when it changes, update the object instead of adding a contradicting one.
`,
  [`note/${SCHEMA_FILE}`]: `---
description: Any other durable knowledge — how a system works, a convention, a gotcha, a fact
fields:
  tags: list
  related: { type: link, many: true }
  location: { type: string, description: "the repo or directory this applies to, if only one" }
index: [tags]
---
One topic per note, with a specific summary. Tag it (e.g. system, practice, gotcha) so related
notes are easy to find, and link what it is about. For each claim, say how it is known (ran it,
someone stated it, inferred) and when it could stop being true.
`,
  [`decision/${SCHEMA_FILE}`]: `---
description: A choice that was made and should not be silently relitigated
fields:
  date: date
  status: string
index: [date]
---
Context, what was decided and who decided it, the evidence it rested on, and the consequences.
If it replaces an earlier decision, link that one.
`
};
function bootstrap(root) {
  if (existsSync2(join2(root, SCHEMA_FILE)))
    return [];
  const written = [];
  for (const [rel, content] of Object.entries(STARTER_SCHEMAS)) {
    const path = join2(root, rel);
    if (existsSync2(path))
      continue;
    mkdirSync2(dirname(path), { recursive: true });
    writeFileSync2(path, content);
    written.push(path);
  }
  return written;
}
function storeSignature(layers) {
  const walk = (dir, depth) => {
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
      const full = join2(dir, e.name);
      if (e.isDirectory())
        out += `${full}/
${walk(full, depth + 1)}`;
      else {
        try {
          const st = statSync(full);
          out += `${full}:${st.size}:${st.mtimeMs}
`;
        } catch {}
      }
    }
    return out;
  };
  return layers.map((l) => walk(l.root, 0)).join("\x00");
}

// src/core/managed.ts
import { parse } from "yaml";
var MANAGED_KEY = "o6y";
function separate(frontmatter) {
  const block = [];
  const rest = [];
  let inside = false;
  for (const line of frontmatter.split(`
`)) {
    if (new RegExp(`^${MANAGED_KEY}:`).test(line))
      inside = true;
    else if (inside && !/^\s/.test(line))
      inside = false;
    (inside ? block : rest).push(line);
  }
  return { block: block.join(`
`), rest: rest.join(`
`).trimEnd() };
}
function readManaged(text) {
  const { block } = separate(splitDoc(text).frontmatter ?? "");
  let raw;
  try {
    raw = (parse(block) ?? {})[MANAGED_KEY];
  } catch {}
  const str = (v) => typeof v === "string" ? v : undefined;
  return {
    created: str(raw?.created),
    updated: str(raw?.updated)
  };
}
function authored(text) {
  const { frontmatter, body } = splitDoc(text);
  return `${separate(frontmatter ?? "").rest.trim()}
---
${body.trim()}`;
}
var latest = (values, pick) => values.reduce((best, v) => v && (!best || pick(v, best)) ? v : best, undefined);
function stampObject(previous, next, opts = {}) {
  const { frontmatter, body } = splitDoc(next);
  if (frontmatter === undefined)
    return next;
  const { rest } = separate(frontmatter);
  const ancestors = [...previous === null ? [] : [previous], ...opts.inherit ?? []];
  const known = ancestors.map(readManaged);
  const changed = !opts.mechanical && (!ancestors.length || authored(ancestors[0]) !== authored(next));
  const today = (opts.now ?? new Date).toLocaleDateString("en-CA");
  const created = ancestors.length ? latest(known.map((m) => m.created), (a, b) => a < b) : today;
  const updated = changed ? today : latest(known.map((m) => m.updated), (a, b) => a > b);
  const lines = [
    ...created ? [`  created: ${created}`] : [],
    ...updated ? [`  updated: ${updated}`] : []
  ];
  if (!lines.length)
    return separate(frontmatter).block ? joinDoc(rest, body) : next;
  return joinDoc(`${rest}
${MANAGED_KEY}:
${lines.join(`
`)}`, body);
}

// src/core/edit.ts
function editFrontmatter(text, fn) {
  const { frontmatter, body } = splitDoc(text);
  const doc = parseDocument2(frontmatter ?? "");
  if (doc.errors.length)
    throw new Error(`invalid YAML frontmatter: ${doc.errors[0].message.split(`
`)[0]}`);
  if (doc.contents === null)
    doc.contents = doc.createNode({});
  const newBody = fn(doc);
  const yaml = isMap(doc.contents) && doc.contents.items.length === 0 ? "" : tidyFlowLists(doc.toString({ lineWidth: 0 }));
  return joinDoc(yaml, newBody ?? body);
}
function tidyFlowLists(yaml) {
  return yaml.split(`
`).map((line) => /["']/.test(line) ? line : line.replace(/\[ ([^[\]{}]*?) \]/g, "[$1]")).join(`
`);
}
function renameKey(node, from, to) {
  if (!isMap(node))
    return false;
  for (const pair of node.items) {
    const key = isScalar(pair.key) ? pair.key.value : pair.key;
    if (key === from) {
      pair.key = new Scalar(to);
      return true;
    }
  }
  return false;
}
function parseValue(raw) {
  try {
    const value = parse2(raw);
    if (value === null || value === undefined)
      return raw === "" ? "" : raw;
    if (typeof value === "object" && !Array.isArray(value))
      return raw;
    return value;
  } catch {
    return raw;
  }
}
var BODY_LINK = /\[\[([^\]|#\n]+?)([|#][^\]\n]*)?\]\]/g;
function rewriteBodyLinks(body, map) {
  let fence = false;
  return body.split(`
`).map((line) => {
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence;
      return line;
    }
    if (fence)
      return line;
    return line.split(/(`[^`]*`)/).map((part, i) => i % 2 === 1 ? part : part.replace(BODY_LINK, (whole, target, rest) => {
      const next = map(target.trim());
      return next ? `[[${next}${rest ?? ""}]]` : whole;
    })).join("");
  }).join(`
`);
}
function rewriteFrontmatterLinks(frontmatter, fields, map) {
  const doc = parseDocument2(frontmatter);
  if (doc.errors.length)
    throw new Error("invalid YAML frontmatter");
  const edits = [];
  const visit = (node) => {
    if (isSeq(node))
      return node.items.forEach(visit);
    if (!isScalar(node) || typeof node.value !== "string" || !node.range)
      return;
    const target = normalizeLinkValue(node.value)?.[0];
    const next = target ? map(target) : undefined;
    if (!target || !next)
      return;
    const [start, end] = node.range;
    const source = frontmatter.slice(start, end);
    if (source.includes(target))
      edits.push({ start, end, text: source.replace(target, () => next) });
  };
  for (const field of fields)
    visit(doc.get(field, true));
  return edits.sort((a, b) => b.start - a.start).reduce((text, e) => text.slice(0, e.start) + e.text + text.slice(e.end), frontmatter);
}
function retargetLinks(store, plan, map) {
  for (const obj of store.objects.values()) {
    const current = plan.read(obj.path);
    if (current === null)
      continue;
    const linkFields = Object.entries(store.types.get(obj.type)?.schema.fields ?? {}).filter(([, f]) => f.type === "link").map(([name]) => name);
    const { frontmatter, body } = splitDoc(current);
    let fm = frontmatter;
    try {
      if (frontmatter !== undefined)
        fm = rewriteFrontmatterLinks(frontmatter, linkFields, map);
    } catch {
      continue;
    }
    const newBody = rewriteBodyLinks(body, map);
    if (fm === frontmatter && newBody === body)
      continue;
    const next = fm === undefined ? newBody : joinDoc(fm, newBody);
    if (next !== current)
      plan.write(obj.path, next, { mechanical: true });
  }
}

class Plan {
  layers;
  overlay = new Map;
  source;
  stamping = true;
  mechanical = false;
  mechanicalPaths = new Set;
  inherits = new Map;
  constructor(layers) {
    this.layers = layers;
  }
  read(path) {
    if (this.overlay.has(path))
      return this.overlay.get(path);
    try {
      return readFileSync3(path, "utf8");
    } catch {
      return null;
    }
  }
  write(path, content, opts = {}) {
    this.overlay.set(path, content);
    if (opts.mechanical)
      this.mechanicalPaths.add(path);
    else
      this.mechanicalPaths.delete(path);
  }
  inherit(to, from) {
    this.inherits.set(to, [...this.inherits.get(to) ?? [], from]);
  }
  disk(path) {
    try {
      return readFileSync3(path, "utf8");
    } catch {
      return null;
    }
  }
  stamp() {
    if (!this.stamping)
      return;
    for (const [path, content] of this.overlay) {
      if (content === null || classifyPath(this.layers, path)?.kind !== "object")
        continue;
      this.overlay.set(path, stampObject(this.disk(path), content, {
        mechanical: this.mechanical || this.mechanicalPaths.has(path),
        inherit: (this.inherits.get(path) ?? []).map((p) => this.disk(p)).filter((t) => t !== null)
      }));
    }
  }
  delete(path) {
    this.overlay.set(path, null);
  }
  get empty() {
    return this.changes().length === 0;
  }
  changes() {
    const out = [];
    for (const [path, content] of this.overlay) {
      const exists = existsSync3(path);
      if (content === null) {
        if (exists)
          out.push({ action: "delete", path });
      } else if (!exists)
        out.push({ action: "create", path });
      else if (readFileSync3(path, "utf8") !== content)
        out.push({ action: "update", path });
    }
    return out;
  }
  validate(before = Store.load(this.layers)) {
    this.stamp();
    const after = Store.load(this.layers, this.overlay);
    const touched = new Set(this.overlay.keys());
    return {
      blocking: blockingIssues(before, after, touched),
      warnings: changeWarnings(before, after, touched),
      changes: this.changes()
    };
  }
  apply(via) {
    this.stamp();
    const changes = this.changes();
    for (const { action, path } of changes) {
      if (action === "delete")
        continue;
      mkdirSync3(dirname2(path), { recursive: true });
      writeFileSync3(path, this.overlay.get(path));
    }
    for (const { action, path } of changes) {
      if (action !== "delete")
        continue;
      rmSync2(path, { force: true });
      const dir = dirname2(path);
      const layer = findLayer(this.layers, path);
      if (layer && dir !== layer.root && existsSync3(dir) && readdirSync2(dir).length === 0) {
        try {
          rmdirSync2(dir);
        } catch {}
      }
    }
    const { source } = this;
    if (changes.length)
      appendLog(this.layers, changes.map((c) => ({ ...c, source: typeof source === "function" ? source(c.path) : source })), via);
    return changes;
  }
}

export { ensureFormat, describe, LOG_LINE, appendLog, bootstrap, storeSignature, editFrontmatter, renameKey, parseValue, retargetLinks, Plan };
