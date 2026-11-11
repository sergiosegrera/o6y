#!/usr/bin/env node
import {
  appendLog
} from "./chunk-asv2qy3p.js";
import {
  Store,
  blockingIssues,
  changeWarnings,
  classifyPath,
  findLayer,
  joinDoc,
  normalizeLinkValue,
  splitDoc
} from "./chunk-a8qzjqdm.js";

// src/core/edit.ts
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isMap, isScalar, isSeq, parse as parse2, parseDocument, Scalar } from "yaml";

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
  const doc = parseDocument(frontmatter ?? "");
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
  const doc = parseDocument(frontmatter);
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
      return readFileSync(path, "utf8");
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
      return readFileSync(path, "utf8");
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
      const exists = existsSync(path);
      if (content === null) {
        if (exists)
          out.push({ action: "delete", path });
      } else if (!exists)
        out.push({ action: "create", path });
      else if (readFileSync(path, "utf8") !== content)
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
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, this.overlay.get(path));
    }
    for (const { action, path } of changes) {
      if (action !== "delete")
        continue;
      rmSync(path, { force: true });
      const dir = dirname(path);
      const layer = findLayer(this.layers, path);
      if (layer && dir !== layer.root && existsSync(dir) && readdirSync(dir).length === 0) {
        try {
          rmdirSync(dir);
        } catch {}
      }
    }
    const { source } = this;
    if (changes.length)
      appendLog(this.layers, changes.map((c) => ({ ...c, source: typeof source === "function" ? source(c.path) : source })), via);
    return changes;
  }
}

export { editFrontmatter, renameKey, parseValue, retargetLinks, Plan };
