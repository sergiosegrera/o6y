#!/usr/bin/env node
import {
  LOG_FILE,
  Store,
  __require,
  appendLog,
  blockingIssues,
  buildPromptSection,
  canonicalPath,
  changeWarnings,
  classifyPath,
  displayPath,
  findLayer,
  formatIssues,
  lint,
  makeLayers,
  neighbors,
  normalizeLinkValue,
  parseId,
  pinnedCost,
  query,
  renderObjectFooter,
  renderRootIndex,
  renderTypeIndex
} from "./chunk-4rjx79a1.js";

// src/cli/o6y.ts
import { readFileSync as readFileSync4 } from "node:fs";

// src/cli/main.ts
import { existsSync as existsSync3, readdirSync as readdirSync2, readFileSync as readFileSync3 } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { join as join3, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

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

// src/core/semantic.ts
import { createHash } from "node:crypto";
import { appendFileSync, existsSync as existsSync2, mkdirSync as mkdirSync2, readFileSync as readFileSync2, renameSync, writeFileSync as writeFileSync2 } from "node:fs";
import { homedir } from "node:os";
import { join as join2 } from "node:path";
var INDEX_VERSION = 1;
var EMBED_BATCH = 96;
var EMBED_TEXT_MAX = 8000;
var RERANK_TEXT_MAX = 4000;
function apiKey(env) {
  return env.CO_API_KEY || env.COHERE_API_KEY || undefined;
}
function semanticUnavailable(store, env) {
  if (!store.semantic.enabled)
    return "semantic search is off; set `semantic: { enabled: true }` in the root .schema.md (sends objects and queries to Cohere)";
  if (!apiKey(env))
    return "semantic search needs CO_API_KEY in the environment";
  return;
}
function cohere(options) {
  const base = (options.baseUrl ?? "https://api.cohere.com").replace(/\/$/, "");
  const doFetch = options.fetch ?? fetch;
  async function post(endpoint, body, signal) {
    const res = await doFetch(`${base}/v2/${endpoint}`, {
      method: "POST",
      headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json", "x-client-name": "o6y" },
      body: JSON.stringify(body),
      signal
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {}
    if (!res.ok)
      throw new Error(`Cohere ${endpoint} failed (${res.status}): ${json?.message ?? text.slice(0, 200)}`);
    return json;
  }
  return {
    async embed(texts, inputType, signal) {
      const out = [];
      for (let i = 0;i < texts.length; i += EMBED_BATCH) {
        const json = await post("embed", { model: options.embedModel, texts: texts.slice(i, i + EMBED_BATCH), input_type: inputType, embedding_types: ["float"] }, signal);
        const vectors = Array.isArray(json?.embeddings) ? json.embeddings : json?.embeddings?.float;
        if (!Array.isArray(vectors))
          throw new Error("Cohere embed returned no float embeddings");
        for (const v of vectors)
          out.push(normalize(Float32Array.from(v)));
      }
      return out;
    },
    async rerank(query2, documents, topN, signal) {
      if (!documents.length)
        return [];
      const json = await post("rerank", { model: options.rerankModel, query: query2, documents, top_n: Math.min(topN, documents.length) }, signal);
      const results = json?.results ?? [];
      return results.map((r) => ({ index: r.index, score: r.relevance_score }));
    }
  };
}
function embedderFor(store, env, fetchImpl) {
  if (semanticUnavailable(store, env))
    return;
  return cohere({
    apiKey: apiKey(env),
    embedModel: store.semantic.embedModel,
    rerankModel: store.semantic.rerankModel,
    baseUrl: env.CO_API_URL,
    fetch: fetchImpl
  });
}
function normalize(v) {
  let norm = 0;
  for (const x of v)
    norm += x * x;
  norm = Math.sqrt(norm);
  if (norm > 0)
    for (let i = 0;i < v.length; i++)
      v[i] /= norm;
  return v;
}
function dot(a, b, offset) {
  let sum = 0;
  for (let i = 0;i < a.length; i++)
    sum += a[i] * b[offset + i];
  return sum;
}
function fieldLines(obj) {
  return Object.entries(obj.data).filter(([k]) => k !== "summary" && k !== "pinned").map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v instanceof Date ? v.toISOString().slice(0, 10) : String(v)}`);
}
function objectText(store, obj, max = EMBED_TEXT_MAX) {
  const description = store.types.get(obj.type)?.schema.description;
  const head = [`${obj.id}${description ? ` (${obj.type}: ${description})` : ""}`, obj.summary, ...fieldLines(obj)];
  return `${head.join(`
`)}

${obj.body.trim()}`.slice(0, max);
}
var hash = (text) => createHash("sha256").update(text).digest("hex").slice(0, 16);
function cacheRoot(env) {
  return env.O6Y_CACHE || join2(env.XDG_CACHE_HOME || join2(homedir(), ".cache"), "o6y");
}
function indexDir(cache, layer) {
  return join2(cache, hash(layer.root));
}
function readIndex(dir) {
  try {
    const meta = JSON.parse(readFileSync2(join2(dir, "index.json"), "utf8"));
    if (meta.version !== INDEX_VERSION)
      return;
    const buf = readFileSync2(join2(dir, "vectors.f32"));
    const vectors = new Float32Array(buf.byteLength / 4);
    new Uint8Array(vectors.buffer).set(buf);
    if (vectors.length !== meta.ids.length * meta.dim)
      return;
    return { model: meta.model, dim: meta.dim, ids: meta.ids, hashes: meta.hashes, vectors };
  } catch {
    return;
  }
}
function writeIndex(dir, index) {
  mkdirSync2(dir, { recursive: true });
  const tmp = (name) => join2(dir, `.${name}.${process.pid}.tmp`);
  writeFileSync2(tmp("vectors.f32"), new Uint8Array(index.vectors.buffer, index.vectors.byteOffset, index.vectors.byteLength));
  renameSync(tmp("vectors.f32"), join2(dir, "vectors.f32"));
  const meta = { version: INDEX_VERSION, model: index.model, dim: index.dim, ids: index.ids, hashes: index.hashes };
  writeFileSync2(tmp("index.json"), JSON.stringify(meta));
  renameSync(tmp("index.json"), join2(dir, "index.json"));
}
var SKIP_CODES = {
  frontmatter: "invalid frontmatter",
  "unknown-type": "type has no schema",
  "duplicate-id": "id also exists in another layer"
};
function skippedObjects(store) {
  const out = [];
  for (const issue of store.issues) {
    const reason = SKIP_CODES[issue.code];
    const info = reason ? classifyPath(store.layers, issue.path) : undefined;
    if (info?.kind === "object")
      out.push({ id: info.id, path: issue.path, layer: info.layer.root, reason });
  }
  return out;
}
async function syncIndex(store, embedder, cache, options = {}) {
  const result = { embedded: 0, removed: 0, total: 0, skipped: skippedObjects(store) };
  const model = store.semantic.embedModel;
  for (const layer of store.layers) {
    const dir = indexDir(cache, layer);
    const old = options.full ? undefined : readIndex(dir);
    const usable = old?.model === model ? old : undefined;
    const previous = new Map;
    usable?.ids.forEach((id, row) => previous.set(id, { hash: usable.hashes[row], row }));
    const objects = [...store.objects.values()].filter((o) => o.layer.root === layer.root).sort((a, b) => a.id.localeCompare(b.id));
    const shadowed = result.skipped.some((s) => s.layer === layer.root);
    if (!objects.length && shadowed)
      continue;
    const texts = objects.map((o) => objectText(store, o));
    const hashes = texts.map(hash);
    const stale = objects.map((_, i) => i).filter((i) => previous.get(objects[i].id)?.hash !== hashes[i]);
    const fresh = stale.length ? await embedder.embed(stale.map((i) => texts[i]), "search_document") : [];
    const dim = fresh[0]?.length ?? usable?.dim ?? 0;
    if (usable && fresh.length && usable.dim !== dim)
      return syncIndex(store, embedder, cache, { full: true });
    const vectors = new Float32Array(objects.length * dim);
    const freshByIndex = new Map(stale.map((i, k) => [i, fresh[k]]));
    objects.forEach((o, i) => {
      const v = freshByIndex.get(i) ?? usable.vectors.subarray(previous.get(o.id).row * dim, (previous.get(o.id).row + 1) * dim);
      vectors.set(v, i * dim);
    });
    const removed = usable ? usable.ids.filter((id) => !store.objects.has(id)).length : 0;
    const dropped = usable ? usable.ids.some((id) => store.objects.get(id)?.layer.root !== layer.root) : false;
    result.embedded += stale.length;
    result.removed += removed;
    result.total += objects.length;
    const changed = stale.length > 0 || dropped || !old || old.model !== model;
    if (changed && (objects.length || existsSync2(dir)))
      writeIndex(dir, { model, dim, ids: objects.map((o) => o.id), hashes, vectors });
  }
  return result;
}
async function search(store, embedder, cache, query2, options = {}) {
  const limit = options.limit ?? 10;
  const model = store.semantic.embedModel;
  const indexes = store.layers.map((l) => readIndex(indexDir(cache, l))).filter((i) => i?.model === model);
  if (!indexes.some((i) => i.ids.length))
    return [];
  const [q] = await embedder.embed([query2], "search_query", options.signal);
  const scored = [];
  for (const index of indexes) {
    if (index.dim !== q.length)
      continue;
    index.ids.forEach((id, row) => {
      const obj = store.objects.get(id);
      if (!obj || options.exclude?.has(id) || options.type && obj.type !== options.type)
        return;
      scored.push({ obj, similarity: dot(q, index.vectors, row * index.dim) });
    });
  }
  scored.sort((a, b) => b.similarity - a.similarity);
  const minScore = options.minScore ?? 0;
  if (options.rerank === false) {
    return scored.slice(0, limit).map((s) => ({ ...s, score: s.similarity })).filter((h) => h.score >= minScore);
  }
  const candidates = scored.filter((s) => s.similarity >= store.semantic.minSimilarity).slice(0, Math.max(store.semantic.candidates, limit));
  const ranked = await embedder.rerank(query2, candidates.map((c) => objectText(store, c.obj, RERANK_TEXT_MAX)), limit, options.signal);
  return ranked.map((r) => ({ ...candidates[r.index], score: r.score })).filter((h) => h.score >= minScore);
}
var suggestionLogPath = (cache) => join2(cache, "suggestions.jsonl");
function readSuggestionLog(cache) {
  let text;
  try {
    text = readFileSync2(suggestionLogPath(cache), "utf8");
  } catch {
    return [];
  }
  return text.split(`
`).flatMap((line) => {
    try {
      return line ? [JSON.parse(line)] : [];
    } catch {
      return [];
    }
  });
}
function suggestionStats(records, since) {
  const recent = since ? records.filter((r) => new Date(r.t) >= since) : records;
  const used = new Set(recent.filter((r) => r.type === "use").map((r) => `${r.session}\x00${r.id}`));
  const edges = [0, 0.5, 0.7, 1.01];
  const bands = edges.slice(0, -1).map((from, i) => ({ from, to: Math.min(edges[i + 1], 1), suggestions: 0, used: 0 }));
  const ignored = new Map;
  const everUsed = new Set(recent.flatMap((r) => r.type === "use" ? [r.id] : []));
  let suggestions = 0;
  let usedCount = 0;
  for (const r of recent) {
    if (r.type !== "suggest")
      continue;
    for (const h of r.hits) {
      const wasUsed = used.has(`${r.session}\x00${h.id}`);
      suggestions++;
      if (wasUsed)
        usedCount++;
      const band = bands.findLast((b) => h.score >= b.from);
      band.suggestions++;
      if (wasUsed)
        band.used++;
      if (!everUsed.has(h.id))
        ignored.set(h.id, (ignored.get(h.id) ?? 0) + 1);
    }
  }
  return {
    sessions: new Set(recent.filter((r) => r.type === "suggest").map((r) => r.session)).size,
    suggestions,
    used: usedCount,
    bands,
    ignored: [...ignored].map(([id, times]) => ({ id, times })).sort((a, b) => b.times - a.times || a.id.localeCompare(b.id)).slice(0, 10)
  };
}

// src/cli/main.ts
class UsageError extends Error {
}
var DRY = { "dry-run": { type: "boolean" } };
var JSON_OPT = { json: { type: "boolean" } };
var IN = { in: { type: "string" } };
function where(layers, path) {
  const layer = findLayer(layers, path);
  return layer ? `${layer.name}:${relative(layer.root, path)}` : displayPath(path);
}
function needObject(store, id) {
  if (!id)
    throw new UsageError("missing object id (type/slug)");
  const obj = store.objects.get(id);
  if (!obj)
    throw new UsageError(`no object \`${id}\`${store.wanted.has(id) ? " (it is linked but not written yet)" : ""}`);
  return obj;
}
function needId(id) {
  const parsed = id ? parseId(id) : undefined;
  if (!parsed)
    throw new UsageError(`\`${id ?? ""}\` is not a valid id; use type/slug in kebab-case, e.g. note/release-train`);
  return parsed;
}
function pickLayer(ctx, name, fallback) {
  if (!name)
    return fallback ?? ctx.layers[0];
  const layer = ctx.layers.find((l) => l.name === name);
  if (!layer)
    throw new UsageError(`--in must be one of: ${ctx.layers.map((l) => l.name).join(", ")}`);
  return layer;
}
function objectPath(layer, id) {
  const { type, slug } = needId(id);
  return join3(layer.root, type, `${slug}.md`);
}
function parseAssignments(items) {
  return items.map((item) => {
    const eq = item.indexOf("=");
    if (eq <= 0)
      throw new UsageError(`expected field=value, got \`${item}\``);
    return [item.slice(0, eq), parseValue(item.slice(eq + 1))];
  });
}
function printIssues(ctx, title, issues) {
  if (issues.length)
    ctx.out(`${title}
${formatIssues(issues, ctx.layers)}`);
}
function commit(ctx, plan, via, dryRun) {
  const result = plan.validate(ctx.load());
  if (result.blocking.length) {
    printIssues(ctx, "o6y: rejected; nothing was changed. The change would leave the store invalid:", result.blocking);
    return 1;
  }
  if (!result.changes.length) {
    ctx.out("o6y: nothing to change.");
    return 0;
  }
  const verb = dryRun ? "would " : "";
  if (!dryRun)
    plan.apply(via);
  ctx.out(result.changes.map((c) => `${verb}${c.action} ${where(ctx.layers, c.path)}`).join(`
`));
  printIssues(ctx, "warnings (not blocking):", result.warnings);
  return 0;
}
function readInput(ctx, file) {
  if (file)
    return readFileSync3(resolve(ctx.cwd, file), "utf8");
  const stdin = ctx.stdin();
  if (stdin === undefined)
    throw new UsageError("pass the content with --file <path> or on stdin");
  return stdin;
}
function edgeLines(store, edges, arrow) {
  return edges.map((e) => `${arrow} ${e.id} (${e.via.join(", ")}) — ${store.objects.get(e.id)?.summary ?? "not written yet"}`);
}
function parseSince(value) {
  const rel = /^(\d+)([mhdw])$/.exec(value);
  if (rel)
    return Date.now() - Number(rel[1]) * { m: 60000, h: 3600000, d: 86400000, w: 604800000 }[rel[2]];
  const abs = Date.parse(value);
  if (Number.isNaN(abs))
    throw new UsageError(`--since takes a duration (30m, 6h, 2d, 1w) or a date, not \`${value}\``);
  return abs;
}
function editSchema(plan, path, fn) {
  plan.write(path, editFrontmatter(plan.read(path) ?? "", fn));
}
var round = (n) => Math.round(n * 1000) / 1000;
function skippedNote(skipped) {
  const list = skipped.map((s) => `${s.id} (${s.reason})`).join(", ");
  return `${skipped.length} object(s) not indexed: ${list}; see \`o6y lint\``;
}
function wordMatch(store, question, type, limit) {
  const words = [...new Set(question.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])];
  if (!words.length)
    return [];
  const hits = [];
  for (const obj of store.objects.values()) {
    if (type && obj.type !== type)
      continue;
    const text = `${obj.id} ${obj.summary} ${obj.body}`.toLowerCase();
    const score = words.filter((w) => text.includes(w)).length / words.length;
    if (score > 0)
      hits.push({ obj, score, similarity: score });
  }
  return hits.sort((a, b) => b.score - a.score || a.obj.id.localeCompare(b.obj.id)).slice(0, limit);
}
var COMMANDS = {
  query: {
    usage: "o6y query [--type T] [--where field=value]... [--links-to ID] [--linked-from ID] [--text S] [--limit N] [--json]",
    summary: "find objects by type, field values, links or text",
    options: {
      type: { type: "string" },
      where: { type: "string", multiple: true },
      "links-to": { type: "string" },
      "linked-from": { type: "string" },
      text: { type: "string" },
      limit: { type: "string" },
      ...JSON_OPT
    },
    run(ctx, args, o) {
      const params = { type: o.type, linksTo: o["links-to"], linkedFrom: o["linked-from"], text: o.text ?? (args.join(" ") || undefined) };
      if (o.where) {
        params.where = Object.fromEntries(parseAssignments(o.where).map(([k, v]) => [k, typeof v === "number" || typeof v === "boolean" ? v : String(v)]));
      }
      if (o.limit)
        params.limit = Number(o.limit);
      const store = ctx.load();
      const results = query(store, params);
      if (o.json) {
        ctx.out(JSON.stringify(results.map((r) => ({ id: r.id, summary: r.summary, path: r.path, backlinks: store.backlinksOf(r.id).length })), null, 2));
      } else if (!results.length)
        ctx.out("No matching objects.");
      else {
        ctx.out(results.map((r) => `- [[${r.id}]] — ${r.summary}  (${displayPath(r.path)}; ${store.backlinksOf(r.id).length} backlinks)`).join(`
`));
      }
      return 0;
    }
  },
  search: {
    usage: "o6y search <question> [--type T] [--limit N] [--min-score S] [--no-rerank] [--json]",
    summary: "find objects by meaning (Cohere embeddings + rerank; word match when semantic search is off)",
    options: { type: { type: "string" }, limit: { type: "string" }, "min-score": { type: "string" }, "no-rerank": { type: "boolean" }, ...JSON_OPT },
    async run(ctx, args, o) {
      const question = args.join(" ").trim();
      if (!question)
        throw new UsageError("give a question to search for");
      const limit = o.limit ? Number(o.limit) : 10;
      const minScore = o["min-score"] === undefined ? undefined : Number(o["min-score"]);
      if (minScore !== undefined && !(minScore >= 0 && minScore <= 1))
        throw new UsageError("--min-score takes a number between 0 and 1");
      const store = ctx.load();
      const embedder = embedderFor(store, ctx.env, ctx.fetch);
      let hits;
      if (!embedder) {
        ctx.err(`o6y search: ${semanticUnavailable(store, ctx.env)}; falling back to word match`);
        hits = wordMatch(store, question, o.type, limit).filter((h) => h.score >= (minScore ?? 0));
      } else {
        const cache = cacheRoot(ctx.env);
        const synced = await syncIndex(store, embedder, cache);
        if (synced.skipped.length)
          ctx.err(`o6y search: ${skippedNote(synced.skipped)}`);
        const rerank = !o["no-rerank"];
        hits = await search(store, embedder, cache, question, { type: o.type, limit, rerank, minScore: minScore ?? (rerank ? store.semantic.threshold : 0) });
      }
      if (o.json) {
        ctx.out(JSON.stringify(hits.map((h) => ({ id: h.obj.id, score: round(h.score), similarity: round(h.similarity), summary: h.obj.summary, path: h.obj.path })), null, 2));
      } else if (!hits.length)
        ctx.out("No matching objects.");
      else
        ctx.out(hits.map((h) => `- [[${h.obj.id}]] (${h.score.toFixed(2)}) — ${h.obj.summary}  (${displayPath(h.obj.path)})`).join(`
`));
      return 0;
    }
  },
  reindex: {
    usage: "o6y reindex [--full]",
    summary: "bring the semantic search index up to date (--full re-embeds everything)",
    options: { full: { type: "boolean" } },
    async run(ctx, _args, o) {
      const store = ctx.load();
      const embedder = embedderFor(store, ctx.env, ctx.fetch);
      if (!embedder)
        throw new Error(semanticUnavailable(store, ctx.env));
      const r = await syncIndex(store, embedder, cacheRoot(ctx.env), { full: !!o.full });
      const lines = [`${r.total} objects indexed: ${r.embedded} embedded, ${r.removed} removed (cache: ${displayPath(cacheRoot(ctx.env))})`];
      if (r.skipped.length)
        lines.push(skippedNote(r.skipped));
      ctx.out(lines.join(`
`));
      return 0;
    }
  },
  suggestions: {
    usage: "o6y suggestions [--since 7d|DATE] [--json]",
    summary: "how often suggested objects were then opened, by score (from the local suggestion log)",
    options: { since: { type: "string" }, ...JSON_OPT },
    run(ctx, _args, o) {
      const cache = cacheRoot(ctx.env);
      const stats = suggestionStats(readSuggestionLog(cache), o.since ? new Date(parseSince(o.since)) : undefined);
      if (o.json) {
        ctx.out(JSON.stringify(stats, null, 2));
        return 0;
      }
      if (!stats.suggestions) {
        ctx.out(`No suggestions logged yet (${displayPath(suggestionLogPath(cache))}).`);
        return 0;
      }
      const pct = (used, of) => of ? `${Math.round(used / of * 100)}%` : "–";
      const lines = [
        `${stats.suggestions} objects suggested over ${stats.sessions} session(s); ${stats.used} opened afterwards (${pct(stats.used, stats.suggestions)})`,
        "",
        "By rerank score:",
        ...stats.bands.filter((b) => b.suggestions).map((b) => `  ${b.from.toFixed(2)}–${b.to.toFixed(2)}  ${pct(b.used, b.suggestions).padStart(4)} opened (${b.used}/${b.suggestions})`)
      ];
      if (stats.ignored.length)
        lines.push("", "Suggested but never opened:", ...stats.ignored.map((i) => `  ${i.id} (${i.times}×)`));
      ctx.out(lines.join(`
`));
      return 0;
    }
  },
  lint: {
    usage: "o6y lint [--json]",
    summary: "errors, warnings, wanted pages, orphans and undeclared fields (exit 1 on errors)",
    options: JSON_OPT,
    run(ctx, _args, o) {
      const store = ctx.load();
      const report = lint(store);
      if (o.json) {
        ctx.out(JSON.stringify({
          errors: store.errors(),
          warnings: store.issues.filter((i) => i.severity === "warning"),
          wanted: Object.fromEntries([...store.wanted].map(([id, from]) => [id, [...from].sort()]))
        }, null, 2));
      } else
        ctx.out(report.text);
      return report.errors ? 1 : 0;
    }
  },
  show: {
    usage: "o6y show <id>",
    summary: "print an object with its backlinks",
    run(ctx, [id]) {
      const store = ctx.load();
      if (id && !store.objects.has(id) && store.wanted.has(id)) {
        ctx.out(`${id} is not written yet. Linked from: ${[...store.wanted.get(id)].sort().join(", ")}`);
        return 0;
      }
      const obj = needObject(store, id);
      ctx.out(readFileSync3(obj.path, "utf8").trimEnd() + `
` + renderObjectFooter(store, obj.id, obj.path));
      return 0;
    }
  },
  links: {
    usage: "o6y links <id> [--json]",
    summary: "what an object links to, and through which field",
    options: JSON_OPT,
    run(ctx, [id], o) {
      const store = ctx.load();
      if (!id)
        throw new UsageError("missing object id");
      const edges = neighbors(store, id).out;
      ctx.out(o.json ? JSON.stringify(edges, null, 2) : edges.length ? edgeLines(store, edges, "→").join(`
`) : `${id} links to nothing.`);
      return 0;
    }
  },
  backlinks: {
    usage: "o6y backlinks <id> [--json]",
    summary: "what links to an object (works for wanted pages too)",
    options: JSON_OPT,
    run(ctx, [id], o) {
      const store = ctx.load();
      if (!id)
        throw new UsageError("missing object id");
      const edges = neighbors(store, id).in;
      ctx.out(o.json ? JSON.stringify(edges, null, 2) : edges.length ? edgeLines(store, edges, "←").join(`
`) : `Nothing links to ${id}.`);
      return 0;
    }
  },
  index: {
    usage: "o6y index [type]",
    summary: "the generated catalog of the stores, or of one type",
    run(ctx, [type]) {
      const store = ctx.load();
      if (!type)
        ctx.out(renderRootIndex(store).trimEnd());
      else {
        const text = renderTypeIndex(store, type);
        if (!text)
          throw new UsageError(`no type \`${type}\``);
        ctx.out(text.trimEnd());
      }
      return 0;
    }
  },
  prompt: {
    usage: "o6y prompt [--stats] [--cwd DIR]",
    summary: "the <o6y> system prompt section as the agent sees it, or where its budget goes",
    options: { stats: { type: "boolean" }, cwd: { type: "string" } },
    run(ctx, _args, o) {
      const store = ctx.load();
      const { text, stats } = buildPromptSection(store, { workPaths: workPaths(resolve(ctx.cwd, o.cwd ?? ".")) });
      if (!o.stats) {
        ctx.out(text);
        return 0;
      }
      const pct = (n) => `${Math.round(n / Math.max(1, stats.budget) * 100)}%`;
      ctx.out([
        `section: ${text.length} chars`,
        `  rules     ${stats.rules}`,
        `  guidance  ${stats.guidance}`,
        `  pinned    ${stats.pinned}  (pinnedBudget ${store.settings.pinnedBudget})`,
        `  catalog   ${stats.catalog}: full lines ${stats.lines} of promptBudget ${stats.budget} (${pct(stats.lines)}), slugs ${stats.names} of namesBudget ${stats.namesBudget}`,
        `objects: ${stats.objects} — ${stats.full} full lines, ${stats.named} by slug, ${stats.hidden} only in index.md`,
        stats.relevant.length ? `relevant to this directory: ${stats.relevant.join(", ")}` : "relevant to this directory: none"
      ].join(`
`));
      return 0;
    }
  },
  stats: {
    usage: "o6y stats [--json]",
    summary: "counts per store and type, links, issues and budgets",
    options: JSON_OPT,
    run(ctx, _args, o) {
      const store = ctx.load();
      const types = [...store.types.values()].sort((a, b) => a.name.localeCompare(b.name));
      const links = [...store.objects.values()].reduce((n, obj) => n + neighbors(store, obj.id).out.length, 0);
      const orphans = [...store.objects.values()].filter((obj) => {
        const nb = neighbors(store, obj.id);
        return !nb.in.length && !nb.out.length;
      });
      const pinned = store.pinnedObjects();
      const data = {
        stores: ctx.layers.map((l) => ({
          name: l.name,
          root: l.root,
          exists: existsSync3(l.root),
          objects: [...store.objects.values()].filter((obj) => obj.layer.name === l.name).length
        })),
        types: types.map((t) => ({ name: t.name, layer: t.layer.name, objects: store.objectsOfType(t.name).length })),
        links,
        wanted: store.wanted.size,
        orphans: orphans.length,
        errors: store.errors().length,
        warnings: store.issues.filter((i) => i.severity === "warning").length,
        pinned: { objects: pinned.length, chars: pinned.reduce((n, p) => n + pinnedCost(p), 0), budget: store.settings.pinnedBudget }
      };
      if (o.json) {
        ctx.out(JSON.stringify(data, null, 2));
        return 0;
      }
      ctx.out([
        ...data.stores.map((s) => `${s.name}: ${displayPath(s.root)} — ${s.exists ? `${s.objects} objects` : "not created"}`),
        `types: ${data.types.map((t) => `${t.name} ${t.objects}`).join(" · ") || "none"}`,
        `links: ${links} · wanted pages: ${data.wanted} · orphans: ${data.orphans}`,
        `issues: ${data.errors} errors · ${data.warnings} warnings`,
        `pinned: ${data.pinned.objects} objects, ${data.pinned.chars}/${data.pinned.budget} chars`
      ].join(`
`));
      return 0;
    }
  },
  log: {
    usage: "o6y log [--since 2d|DATE] [--limit N]",
    summary: "recent changes to the stores, newest first",
    options: { since: { type: "string" }, limit: { type: "string" } },
    run(ctx, _args, o) {
      const since = o.since ? parseSince(o.since) : 0;
      const entries = [];
      for (const layer of ctx.layers) {
        const path = join3(layer.root, LOG_FILE);
        if (!existsSync3(path))
          continue;
        for (const line of readFileSync3(path, "utf8").split(`
`)) {
          const m = /^- (\S+) (.+)$/.exec(line);
          const at = m ? Date.parse(m[1]) : NaN;
          if (!m || Number.isNaN(at) || at < since)
            continue;
          entries.push({ at, line: `${m[1]} ${ctx.layers.length > 1 ? `${layer.name} ` : ""}${m[2]}` });
        }
      }
      entries.sort((a, b) => b.at - a.at);
      const shown = entries.slice(0, Number(o.limit ?? 30));
      ctx.out(shown.length ? shown.map((e) => e.line).join(`
`) : "No changes logged in that period.");
      return 0;
    }
  },
  export: {
    usage: "o6y export [--format json|mermaid|dot]",
    summary: "dump the stores as JSON, or the link graph as Mermaid or Graphviz",
    options: { format: { type: "string" } },
    run(ctx, _args, o) {
      const store = ctx.load();
      const format = o.format ?? "json";
      const objects = [...store.objects.values()].sort((a, b) => a.id.localeCompare(b.id));
      if (format === "json") {
        ctx.out(JSON.stringify({
          types: [...store.types.values()].map((t) => ({ name: t.name, layer: t.layer.name, ...t.schema })),
          objects: objects.map((obj) => ({
            id: obj.id,
            type: obj.type,
            layer: obj.layer.name,
            path: obj.path,
            summary: obj.summary,
            data: obj.data,
            body: obj.body,
            links: neighbors(store, obj.id).out.map((e) => ({ target: e.id, via: e.via }))
          }))
        }, null, 2));
        return 0;
      }
      const edges = objects.flatMap((obj) => neighbors(store, obj.id).out.map((e) => ({ from: obj.id, to: e.id, via: e.via.join(", ") })));
      const nodes = [...new Set([...objects.map((obj) => obj.id), ...edges.map((e) => e.to)])];
      if (format === "mermaid") {
        const key = new Map(nodes.map((id, i) => [id, `n${i}`]));
        ctx.out([
          "graph LR",
          ...nodes.map((id) => `  ${key.get(id)}["${id}"]${store.objects.has(id) ? "" : ":::wanted"}`),
          ...edges.map((e) => `  ${key.get(e.from)} -->|${e.via}| ${key.get(e.to)}`),
          "  classDef wanted stroke-dasharray: 4 4"
        ].join(`
`));
      } else if (format === "dot") {
        ctx.out([
          "digraph o6y {",
          "  rankdir=LR;",
          ...nodes.filter((id) => !store.objects.has(id)).map((id) => `  "${id}" [style=dashed];`),
          ...edges.map((e) => `  "${e.from}" -> "${e.to}" [label="${e.via}"];`),
          "}"
        ].join(`
`));
      } else
        throw new UsageError("--format must be json, mermaid or dot");
      return 0;
    }
  },
  check: {
    usage: "o6y check <id|path> [--file DRAFT] [--in global|project]   (content on stdin if no --file)",
    summary: "validate a draft as if it were written there, without writing it",
    options: { file: { type: "string" }, ...IN },
    run(ctx, [target], o) {
      if (!target)
        throw new UsageError("missing target id or path");
      const store = ctx.load();
      const path = target.includes("/") && (target.endsWith(".md") || target.startsWith(".") || target.startsWith("/") || target.startsWith("~")) ? canonicalPath(resolve(ctx.cwd, target.startsWith("~/") ? join3(homedir2(), target.slice(2)) : target)) : store.objects.get(target)?.path ?? objectPath(pickLayer(ctx, o.in), target);
      if (!classifyPath(ctx.layers, path))
        throw new UsageError(`${target} is not inside an o6y store`);
      const plan = new Plan(ctx.layers);
      plan.write(path, readInput(ctx, o.file));
      const result = plan.validate(store);
      if (result.blocking.length) {
        printIssues(ctx, `o6y: ${where(ctx.layers, path)} would be rejected:`, result.blocking);
        return 1;
      }
      ctx.out(`o6y: ${where(ctx.layers, path)} is valid.`);
      printIssues(ctx, "warnings (not blocking):", result.warnings);
      return 0;
    }
  },
  new: {
    usage: "o6y new <id> --summary TEXT [--set field=value]... [--body TEXT | --body-file F] [--in global|project] [--dry-run]",
    summary: "create an object (fails if it exists)",
    options: { summary: { type: "string" }, set: { type: "string", multiple: true }, body: { type: "string" }, "body-file": { type: "string" }, ...IN, ...DRY },
    run(ctx, [id], o) {
      needId(id);
      const store = ctx.load();
      if (store.objects.has(id))
        throw new UsageError(`${id} already exists (${displayPath(store.objects.get(id).path)}); use \`o6y set\` or edit it`);
      if (!o.summary)
        throw new UsageError("--summary is required");
      const path = objectPath(pickLayer(ctx, o.in), id);
      const body = o["body-file"] ? readFileSync3(resolve(ctx.cwd, o["body-file"]), "utf8") : o.body ?? "";
      const content = editFrontmatter("", (doc) => {
        doc.set("summary", o.summary);
        for (const [k, v] of parseAssignments(o.set ?? []))
          doc.set(k, v);
        return body ? `${body.trimEnd()}
` : "";
      });
      const plan = new Plan(ctx.layers);
      plan.write(path, content);
      return commit(ctx, plan, "o6y new", !!o["dry-run"]);
    }
  },
  set: {
    usage: "o6y set <id> field=value... [--unset field]... [--dry-run]",
    summary: "set or remove frontmatter fields (values are YAML: true, 3, [a, b])",
    options: { unset: { type: "string", multiple: true }, ...DRY },
    run(ctx, [id, ...assignments], o) {
      const obj = needObject(ctx.load(), id);
      const sets = parseAssignments(assignments);
      if (!sets.length && !o.unset?.length)
        throw new UsageError("nothing to set; pass field=value or --unset field");
      const plan = new Plan(ctx.layers);
      plan.write(obj.path, editFrontmatter(plan.read(obj.path), (doc) => {
        for (const [k, v] of sets)
          doc.set(k, v);
        for (const k of o.unset ?? [])
          doc.delete(k);
      }));
      return commit(ctx, plan, "o6y set", !!o["dry-run"]);
    }
  },
  mv: {
    usage: "o6y mv <old-id> <new-id> [--in global|project] [--dry-run]",
    summary: "rename or move an object and rewrite every link to it",
    options: { ...IN, ...DRY },
    run(ctx, [from, to], o) {
      const store = ctx.load();
      const obj = needObject(store, from);
      needId(to);
      if (store.objects.has(to))
        throw new UsageError(`${to} already exists; use \`o6y merge ${from} ${to}\` to combine them`);
      const dest = objectPath(pickLayer(ctx, o.in, obj.layer), to);
      const plan = new Plan(ctx.layers);
      retargetLinks(store, plan, (id) => id === from ? to : undefined);
      plan.write(dest, plan.read(obj.path));
      plan.delete(obj.path);
      return commit(ctx, plan, "o6y mv", !!o["dry-run"]);
    }
  },
  merge: {
    usage: "o6y merge <from-id> <into-id> [--dry-run]",
    summary: "fold one object into another: repoint links, keep missing fields, append its body, delete it",
    options: DRY,
    run(ctx, [from, into], o) {
      const store = ctx.load();
      const src = needObject(store, from);
      const dst = needObject(store, into);
      if (src.id === dst.id)
        throw new UsageError("cannot merge an object into itself");
      const plan = new Plan(ctx.layers);
      retargetLinks(store, plan, (id) => id === src.id ? dst.id : undefined);
      const srcDoc = splitDoc(plan.read(src.path));
      plan.write(dst.path, editFrontmatter(plan.read(dst.path), (doc) => {
        for (const [k, v] of Object.entries(src.data)) {
          if (k !== "summary" && k !== "pinned" && !doc.has(k))
            doc.set(k, v);
        }
        const body = splitDoc(plan.read(dst.path)).body.trimEnd();
        const extra = srcDoc.body.trim();
        if (!extra)
          return;
        return `${body ? `${body}

` : ""}## Merged from ${src.id}

${extra}
`;
      }));
      plan.delete(src.path);
      return commit(ctx, plan, "o6y merge", !!o["dry-run"]);
    }
  },
  rm: {
    usage: "o6y rm <id>... [--dry-run]",
    summary: "delete objects; links to them become wanted pages (reported)",
    options: DRY,
    run(ctx, ids, o) {
      if (!ids.length)
        throw new UsageError("missing object id");
      const store = ctx.load();
      const plan = new Plan(ctx.layers);
      for (const id of ids)
        plan.delete(needObject(store, id).path);
      return commit(ctx, plan, "o6y rm", !!o["dry-run"]);
    }
  },
  field: {
    usage: [
      "o6y field add <type> <name> [TYPE] [--required] [--description D] [--values a,b] [--to t1,t2] [--many] [--default V] [--dry-run]",
      "o6y field rename <type> <old> <new> [--dry-run]",
      "o6y field drop <type> <name> [--keep-values] [--dry-run]"
    ].join(`
       `),
    summary: "change a type's fields and migrate its objects in one validated step",
    options: {
      required: { type: "boolean" },
      description: { type: "string" },
      values: { type: "string" },
      to: { type: "string" },
      many: { type: "boolean" },
      default: { type: "string" },
      "keep-values": { type: "boolean" },
      ...DRY
    },
    run(ctx, [action, typeName, ...rest], o) {
      const store = ctx.load();
      const type = typeName ? store.types.get(typeName) : undefined;
      if (!action || !["add", "rename", "drop"].includes(action))
        throw new UsageError("expected add, rename or drop");
      if (!type)
        throw new UsageError(`no type \`${typeName ?? ""}\``);
      const plan = new Plan(ctx.layers);
      const objects = store.objectsOfType(type.name);
      if (action === "add") {
        const [name2, kind = "string"] = rest;
        if (!name2)
          throw new UsageError("missing field name");
        if (type.schema.fields[name2])
          throw new UsageError(`${type.name} already declares \`${name2}\``);
        const extra = {};
        if (o.required)
          extra.required = true;
        if (o.description)
          extra.description = o.description;
        if (o.values)
          extra.values = String(o.values).split(",").map((v) => v.trim());
        if (o.to)
          extra.to = String(o.to).includes(",") ? String(o.to).split(",").map((v) => v.trim()) : o.to;
        if (o.many)
          extra.many = true;
        const spec = Object.keys(extra).length ? { type: kind, ...extra } : kind;
        editSchema(plan, type.path, (doc) => {
          if (!doc.has("fields") || doc.get("fields") === null)
            doc.set("fields", doc.createNode({}));
          doc.setIn(["fields", name2], doc.createNode(spec, { flow: typeof spec === "object" }));
        });
        if (o.default !== undefined) {
          const value = parseValue(o.default);
          for (const obj of objects) {
            if (obj.data[name2] === undefined)
              plan.write(obj.path, editFrontmatter(plan.read(obj.path), (doc) => void doc.set(name2, value)));
          }
        }
        return commit(ctx, plan, "o6y field add", !!o["dry-run"]);
      }
      if (action === "rename") {
        const [from, to] = rest;
        if (!from || !to)
          throw new UsageError("usage: o6y field rename <type> <old> <new>");
        if (type.schema.fields[to])
          throw new UsageError(`${type.name} already declares \`${to}\``);
        const clash = objects.find((obj) => obj.data[to] !== undefined && obj.data[from] !== undefined);
        if (clash)
          throw new UsageError(`${clash.id} already has both \`${from}\` and \`${to}\`; resolve it first`);
        if (type.schema.fields[from]) {
          editSchema(plan, type.path, (doc) => {
            const fields = doc.get("fields", true);
            renameKey(fields, from, to);
            const index = doc.toJS().index ?? [];
            if (index.includes(from))
              doc.set("index", doc.createNode(index.map((f) => f === from ? to : f), { flow: true }));
          });
        }
        for (const obj of objects) {
          if (obj.data[from] === undefined)
            continue;
          plan.write(obj.path, editFrontmatter(plan.read(obj.path), (doc) => void renameKey(doc.contents, from, to)));
        }
        return commit(ctx, plan, "o6y field rename", !!o["dry-run"]);
      }
      const [name] = rest;
      if (!name)
        throw new UsageError("missing field name");
      if (type.schema.fields[name]) {
        editSchema(plan, type.path, (doc) => {
          doc.deleteIn(["fields", name]);
          const index = doc.toJS().index ?? [];
          if (index.includes(name)) {
            const next = index.filter((f) => f !== name);
            if (next.length)
              doc.set("index", doc.createNode(next, { flow: true }));
            else
              doc.delete("index");
          }
        });
      } else if (o["keep-values"])
        throw new UsageError(`${type.name} doesn't declare \`${name}\``);
      if (!o["keep-values"]) {
        for (const obj of objects) {
          if (obj.data[name] !== undefined)
            plan.write(obj.path, editFrontmatter(plan.read(obj.path), (doc) => void doc.delete(name)));
        }
      }
      return commit(ctx, plan, "o6y field drop", !!o["dry-run"]);
    }
  },
  type: {
    usage: "o6y type rename <old> <new> [--dry-run]",
    summary: "rename a type: move its folder, rewrite ids in links and `to:` in other schemas",
    options: DRY,
    run(ctx, [action, from, to], o) {
      if (action !== "rename")
        throw new UsageError("expected `rename`");
      const store = ctx.load();
      if (!from || !store.types.has(from))
        throw new UsageError(`no type \`${from ?? ""}\``);
      if (!to || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(to))
        throw new UsageError("new type name must be kebab-case");
      if (store.types.has(to))
        throw new UsageError(`type \`${to}\` already exists`);
      const plan = new Plan(ctx.layers);
      retargetLinks(store, plan, (id) => id.startsWith(`${from}/`) ? `${to}${id.slice(from.length)}` : undefined);
      for (const t of store.types.values()) {
        const fields = t.schema.fields;
        for (const [name, f] of Object.entries(fields)) {
          if (f.type !== "link" || f.to === "any" || !f.to?.includes(from))
            continue;
          editSchema(plan, t.path, (doc) => {
            const raw = doc.getIn(["fields", name, "to"]);
            const value = raw && typeof raw === "object" ? raw.toJSON() : raw;
            const next = Array.isArray(value) ? value.map((v) => v === from ? to : v) : to;
            doc.setIn(["fields", name, "to"], doc.createNode(next, { flow: true }));
          });
        }
      }
      for (const layer of ctx.layers) {
        const dir = join3(layer.root, from);
        if (!existsSync3(dir))
          continue;
        for (const file of readdirSync2(dir)) {
          if (!file.endsWith(".md"))
            continue;
          const path = join3(dir, file);
          plan.write(join3(layer.root, to, file), plan.read(path));
          plan.delete(path);
        }
      }
      return commit(ctx, plan, "o6y type rename", !!o["dry-run"]);
    }
  },
  view: {
    usage: "o6y view [id] [--tree]",
    summary: "live terminal viewer (also: plain `o6y` in a terminal)",
    options: { tree: { type: "boolean" } },
    async run(ctx, [id], o) {
      if (!ctx.isTTY)
        throw new UsageError("the viewer needs an interactive terminal");
      process.env.NODE_ENV ??= "production";
      const { runViewer } = await import("./chunk-5v4ajq3z.js");
      await runViewer(ctx.layers, { current: id, view: o.tree ? "tree" : "browse", history: [], filter: "", open: [] });
      return 0;
    }
  }
};
var GROUPS = [
  ["Read", ["query", "show", "links", "backlinks", "index", "lint", "stats", "log", "prompt", "export"]],
  ["Write (validated as one change; --dry-run previews)", ["new", "set", "mv", "merge", "rm", "field", "type", "check"]],
  ["Semantic search (opt-in: semantic.enabled in the root schema, CO_API_KEY)", ["search", "reindex", "suggestions"]],
  ["Viewer", ["view"]]
];
function help() {
  const lines = [
    "o6y — query and maintain o6y memory stores",
    "",
    "Usage: o6y [--global DIR] [--project DIR] <command> [args]",
    "Stores default to $O6Y_HOME or ~/.agents/o6y, and $O6Y_PROJECT or ./.agents/o6y."
  ];
  for (const [title, names] of GROUPS) {
    lines.push("", `${title}:`);
    for (const name of names)
      lines.push(`  ${name.padEnd(10)} ${COMMANDS[name].summary}`);
  }
  lines.push("", "`o6y help <command>` shows a command's options. Ids are type/slug, e.g. note/release-train.");
  return lines.join(`
`);
}
function expandHome(p) {
  return p === "~" || p.startsWith("~/") ? join3(homedir2(), p.slice(1)) : p;
}
async function main(argv, io) {
  const args = [...argv];
  const take = (flag) => {
    const i = args.indexOf(flag);
    if (i < 0)
      return;
    const value = args[i + 1];
    args.splice(i, 2);
    return value;
  };
  const globalFlag = take("--global");
  const projectFlag = take("--project");
  const layers = makeLayers(resolve(io.cwd, expandHome(globalFlag || io.env.O6Y_HOME || join3(homedir2(), ".agents", "o6y"))), resolve(io.cwd, expandHome(projectFlag || io.env.O6Y_PROJECT || join3(io.cwd, ".agents", "o6y"))));
  const ctx = { ...io, layers, load: () => Store.load(layers) };
  let name = args.shift();
  if (!name)
    name = io.isTTY ? "view" : "help";
  if (name === "--help" || name === "-h")
    name = "help";
  if (name === "help") {
    const topic = args[0] && COMMANDS[args[0]];
    io.out(topic ? `${topic.usage}

${topic.summary}` : help());
    return 0;
  }
  const command = COMMANDS[name];
  if (!command) {
    io.err(`o6y: unknown command \`${name}\`

${help()}`);
    return 2;
  }
  if (args.includes("--help") || args.includes("-h")) {
    io.out(`${command.usage}

${command.summary}`);
    return 0;
  }
  try {
    const { values, positionals } = parseArgs({ args, options: command.options ?? {}, allowPositionals: true, strict: true });
    return await command.run(ctx, positionals, values);
  } catch (err) {
    if (err instanceof UsageError || err instanceof TypeError && "code" in err && String(err.code).startsWith("ERR_PARSE_ARGS")) {
      io.err(`o6y ${name}: ${err.message}
usage: ${command.usage}`);
      return 2;
    }
    if (err instanceof Error) {
      io.err(`o6y ${name}: ${err.message}`);
      return 1;
    }
    throw err;
  }
}

// src/cli/o6y.ts
process.exitCode = await main(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  out: (text) => process.stdout.write(`${text}
`),
  err: (text) => process.stderr.write(`${text}
`),
  stdin: () => process.stdin.isTTY ? undefined : readFileSync4(0, "utf8"),
  isTTY: !!process.stdin.isTTY && !!process.stdout.isTTY
});
