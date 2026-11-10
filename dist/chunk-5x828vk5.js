#!/usr/bin/env node
import {
  RESERVED_FIELDS,
  classifyPath
} from "./chunk-fh0jaf4t.js";

// src/core/semantic.ts
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
var INDEX_VERSION = 1;
var EMBED_BATCH = 96;
var EMBED_TEXT_MAX = 8000;
var RERANK_TEXT_MAX = 4000;
function apiKey(env) {
  return env.CO_API_KEY || env.COHERE_API_KEY || undefined;
}
function semanticUnavailable2(store, env) {
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
    async rerank(query, documents, topN, signal) {
      if (!documents.length)
        return [];
      const json = await post("rerank", { model: options.rerankModel, query, documents, top_n: Math.min(topN, documents.length) }, signal);
      const results = json?.results ?? [];
      return results.map((r) => ({ index: r.index, score: r.relevance_score }));
    }
  };
}
function embedderFor2(store, env, fetchImpl) {
  if (semanticUnavailable2(store, env))
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
  return Object.entries(obj.data).filter(([k]) => !RESERVED_FIELDS.includes(k)).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v instanceof Date ? v.toISOString().slice(0, 10) : String(v)}`);
}
function objectText(store, obj, max = EMBED_TEXT_MAX) {
  const description = store.types.get(obj.type)?.schema.description;
  const head = [`${obj.id}${description ? ` (${obj.type}: ${description})` : ""}`, obj.summary, ...fieldLines(obj)];
  return `${head.join(`
`)}

${obj.body.trim()}`.slice(0, max);
}
var hash = (text) => createHash("sha256").update(text).digest("hex").slice(0, 16);
function cacheRoot2(env) {
  return env.O6Y_CACHE || join(env.XDG_CACHE_HOME || join(homedir(), ".cache"), "o6y");
}
function indexDir(cache, layer) {
  return join(cache, hash(layer.root));
}
function readIndex(dir) {
  try {
    const meta = JSON.parse(readFileSync(join(dir, "index.json"), "utf8"));
    if (meta.version !== INDEX_VERSION)
      return;
    const buf = readFileSync(join(dir, "vectors.f32"));
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
  mkdirSync(dir, { recursive: true });
  const tmp = (name) => join(dir, `.${name}.${process.pid}.tmp`);
  writeFileSync(tmp("vectors.f32"), new Uint8Array(index.vectors.buffer, index.vectors.byteOffset, index.vectors.byteLength));
  renameSync(tmp("vectors.f32"), join(dir, "vectors.f32"));
  const meta = { version: INDEX_VERSION, model: index.model, dim: index.dim, ids: index.ids, hashes: index.hashes };
  writeFileSync(tmp("index.json"), JSON.stringify(meta));
  renameSync(tmp("index.json"), join(dir, "index.json"));
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
async function syncIndex2(store, embedder, cache, options = {}) {
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
      return syncIndex2(store, embedder, cache, { full: true });
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
    if (changed && (objects.length || existsSync(dir)))
      writeIndex(dir, { model, dim, ids: objects.map((o) => o.id), hashes, vectors });
  }
  return result;
}
async function search2(store, embedder, cache, query, options = {}) {
  const limit = options.limit ?? 10;
  const model = store.semantic.embedModel;
  const indexes = store.layers.map((l) => readIndex(indexDir(cache, l))).filter((i) => i?.model === model);
  if (!indexes.some((i) => i.ids.length))
    return [];
  const [q] = await embedder.embed([query], "search_query", options.signal);
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
  const ranked = await embedder.rerank(query, candidates.map((c) => objectText(store, c.obj, RERANK_TEXT_MAX)), limit, options.signal);
  return ranked.map((r) => ({ ...candidates[r.index], score: r.score })).filter((h) => h.score >= minScore);
}
var suggestionLogPath2 = (cache) => join(cache, "suggestions.jsonl");
function readSuggestionLog2(cache) {
  let text;
  try {
    text = readFileSync(suggestionLogPath2(cache), "utf8");
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
function suggestionStats2(records, since) {
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

export { semanticUnavailable2, embedderFor2, cacheRoot2, syncIndex2, search2, suggestionLogPath2, readSuggestionLog2, suggestionStats2 };
