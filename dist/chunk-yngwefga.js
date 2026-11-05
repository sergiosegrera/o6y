#!/usr/bin/env node
import {
  Store,
  appendLog,
  blockingIssues,
  canonicalPath,
  changeWarnings,
  findLayer,
  normalizeLinkValue
} from "./chunk-4m0nbp6g.js";

// src/core/context.ts
import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
function workPaths(cwd) {
  const paths = new Set([canonicalPath(cwd)]);
  try {
    const out = execFileSync("git", ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000
    });
    const [top, common] = out.trim().split(`
`);
    if (top)
      paths.add(canonicalPath(top));
    if (common?.endsWith("/.git"))
      paths.add(canonicalPath(dirname(common)));
  } catch {}
  return [...paths];
}

// src/core/edit.ts
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname as dirname2, join } from "node:path";
import { isMap, isScalar, parse, parseDocument, Scalar } from "yaml";
var FENCE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n?---[ \t]*(?:\r?\n|$)/;
function splitDoc(text) {
  const match = FENCE.exec(text);
  if (!match)
    return { frontmatter: undefined, body: text };
  return { frontmatter: match[1] ?? "", body: text.slice(match[0].length) };
}
function joinDoc(frontmatter, body) {
  const fm = frontmatter.endsWith(`
`) ? frontmatter : `${frontmatter}
`;
  return `---
${fm}---
${body}`;
}
function editFrontmatter(text, fn) {
  const { frontmatter, body } = splitDoc(text);
  const doc = parseDocument(frontmatter ?? "");
  if (doc.errors.length)
    throw new Error(`invalid YAML frontmatter: ${doc.errors[0].message.split(`
`)[0]}`);
  if (doc.contents === null)
    doc.contents = doc.createNode({});
  const newBody = fn(doc);
  const yaml = isMap(doc.contents) && doc.contents.items.length === 0 ? "" : tidyFlowLists(doc.toString());
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
    const value = parse(raw);
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
function rewriteLinkValue(value, map) {
  if (Array.isArray(value)) {
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
    if (!next)
      return { value, changed: false };
    return { value: value.trim().startsWith("[[") ? `[[${next}]]` : next, changed: true };
  }
  return { value, changed: false };
}
function retargetLinks(store, plan, map) {
  for (const obj of store.objects.values()) {
    const current = plan.read(obj.path);
    if (current === null)
      continue;
    const linkFields = Object.entries(store.types.get(obj.type)?.schema.fields ?? {}).filter(([, f]) => f.type === "link").map(([name]) => name);
    let next;
    try {
      next = editFrontmatter(current, (doc) => {
        for (const field of linkFields) {
          if (!doc.has(field))
            continue;
          const r = rewriteLinkValue(doc.toJS()[field], map);
          if (r.changed)
            doc.set(field, r.value);
        }
        return rewriteBodyLinks(splitDoc(current).body, map);
      });
    } catch {
      continue;
    }
    if (next !== current)
      plan.write(obj.path, next);
  }
}

class Plan {
  layers;
  overlay = new Map;
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
  write(path, content) {
    this.overlay.set(path, content);
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
    const after = Store.load(this.layers, this.overlay);
    const touched = new Set(this.overlay.keys());
    return {
      blocking: blockingIssues(before, after, touched),
      warnings: changeWarnings(before, after, touched),
      changes: this.changes()
    };
  }
  apply(via) {
    const changes = this.changes();
    for (const { action, path } of changes) {
      if (action === "delete")
        continue;
      mkdirSync(dirname2(path), { recursive: true });
      writeFileSync(path, this.overlay.get(path));
    }
    for (const { action, path } of changes) {
      if (action !== "delete")
        continue;
      rmSync(path, { force: true });
      const dir = dirname2(path);
      const layer = findLayer(this.layers, path);
      if (layer && dir !== layer.root && existsSync(dir) && readdirSync(dir).length === 0) {
        try {
          rmdirSync(dir);
        } catch {}
      }
    }
    if (changes.length)
      appendLog(this.layers, changes, via);
    return changes;
  }
}

export { workPaths, splitDoc, editFrontmatter, renameKey, parseValue, retargetLinks, Plan };
