/**
 * Semantic search: Cohere embeddings narrow the store to the nearest objects, Cohere rerank scores
 * them against the query. Vectors live in a flat per-layer cache outside the store (it can always
 * be rebuilt from the markdown), searched by brute force: a store is thousands of objects at most.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SemanticSettings } from "./schema.ts";
import type { Layer, ObjectEntry, Store } from "./store.ts";

const INDEX_VERSION = 1;
/** Cohere's limit on texts per embed call. */
const EMBED_BATCH = 96;
const EMBED_TEXT_MAX = 8000;
const RERANK_TEXT_MAX = 4000;

export type Env = Record<string, string | undefined>;
export type InputType = "search_document" | "search_query";

export interface Embedder {
  embed(texts: string[], inputType: InputType, signal?: AbortSignal): Promise<Float32Array[]>;
  /** Scores (0–1) for the top `topN` documents, best first. */
  rerank(query: string, documents: string[], topN: number, signal?: AbortSignal): Promise<{ index: number; score: number }[]>;
}

export function apiKey(env: Env): string | undefined {
  return env.CO_API_KEY || env.COHERE_API_KEY || undefined;
}

/** Why semantic search can't run, or undefined when it can. */
export function semanticUnavailable(store: Store, env: Env): string | undefined {
  if (!store.semantic.enabled) return "semantic search is off; set `semantic: { enabled: true }` in the root .schema.md (sends objects and queries to Cohere)";
  if (!apiKey(env)) return "semantic search needs CO_API_KEY in the environment";
  return undefined;
}

export interface CohereOptions {
  apiKey: string;
  embedModel: string;
  rerankModel: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

export function cohere(options: CohereOptions): Embedder {
  const base = (options.baseUrl ?? "https://api.cohere.com").replace(/\/$/, "");
  const doFetch = options.fetch ?? fetch;
  async function post(endpoint: string, body: unknown, signal?: AbortSignal): Promise<any> {
    const res = await doFetch(`${base}/v2/${endpoint}`, {
      method: "POST",
      headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json", "x-client-name": "o6y" },
      body: JSON.stringify(body),
      signal,
    });
    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {}
    if (!res.ok) throw new Error(`Cohere ${endpoint} failed (${res.status}): ${json?.message ?? text.slice(0, 200)}`);
    return json;
  }
  return {
    async embed(texts, inputType, signal) {
      const out: Float32Array[] = [];
      for (let i = 0; i < texts.length; i += EMBED_BATCH) {
        const json = await post(
          "embed",
          { model: options.embedModel, texts: texts.slice(i, i + EMBED_BATCH), input_type: inputType, embedding_types: ["float"] },
          signal,
        );
        const vectors: number[][] | undefined = Array.isArray(json?.embeddings) ? json.embeddings : json?.embeddings?.float;
        if (!Array.isArray(vectors)) throw new Error("Cohere embed returned no float embeddings");
        for (const v of vectors) out.push(normalize(Float32Array.from(v)));
      }
      return out;
    },
    async rerank(query, documents, topN, signal) {
      if (!documents.length) return [];
      const json = await post("rerank", { model: options.rerankModel, query, documents, top_n: Math.min(topN, documents.length) }, signal);
      const results: { index: number; relevance_score: number }[] = json?.results ?? [];
      return results.map((r) => ({ index: r.index, score: r.relevance_score }));
    },
  };
}

export function embedderFor(store: Store, env: Env, fetchImpl?: typeof fetch): Embedder | undefined {
  if (semanticUnavailable(store, env)) return undefined;
  return cohere({
    apiKey: apiKey(env)!,
    embedModel: store.semantic.embedModel,
    rerankModel: store.semantic.rerankModel,
    baseUrl: env.CO_API_URL,
    fetch: fetchImpl,
  });
}

function normalize(v: Float32Array): Float32Array {
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < v.length; i++) v[i]! /= norm;
  return v;
}

function dot(a: Float32Array, b: Float32Array, offset: number): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i]! * b[offset + i]!;
  return sum;
}

function fieldLines(obj: ObjectEntry): string[] {
  return Object.entries(obj.data)
    .filter(([k]) => k !== "summary" && k !== "pinned")
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v instanceof Date ? v.toISOString().slice(0, 10) : String(v)}`);
}

/** What gets embedded for an object: id, its type's description, summary, fields and body. */
export function objectText(store: Store, obj: ObjectEntry, max = EMBED_TEXT_MAX): string {
  const description = store.types.get(obj.type)?.schema.description;
  const head = [`${obj.id}${description ? ` (${obj.type}: ${description})` : ""}`, obj.summary, ...fieldLines(obj)];
  return `${head.join("\n")}\n\n${obj.body.trim()}`.slice(0, max);
}

const hash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

// ── the flat index ─────────────────────────────────────────────────────────

export interface VectorIndex {
  model: string;
  dim: number;
  ids: string[];
  hashes: string[];
  /** ids.length × dim, row-major, each row unit length. */
  vectors: Float32Array;
}

export function cacheRoot(env: Env): string {
  return env.O6Y_CACHE || join(env.XDG_CACHE_HOME || join(homedir(), ".cache"), "o6y");
}

/** One cache directory per layer, keyed by the store's path. */
export function indexDir(cache: string, layer: Layer): string {
  return join(cache, hash(layer.root));
}

export function readIndex(dir: string): VectorIndex | undefined {
  try {
    const meta = JSON.parse(readFileSync(join(dir, "index.json"), "utf8"));
    if (meta.version !== INDEX_VERSION) return undefined;
    const buf = readFileSync(join(dir, "vectors.f32"));
    // Copy into an aligned buffer: Buffer slices may not start on a 4-byte boundary.
    const vectors = new Float32Array(buf.byteLength / 4);
    new Uint8Array(vectors.buffer).set(buf);
    if (vectors.length !== meta.ids.length * meta.dim) return undefined;
    return { model: meta.model, dim: meta.dim, ids: meta.ids, hashes: meta.hashes, vectors };
  } catch {
    return undefined;
  }
}

function writeIndex(dir: string, index: VectorIndex): void {
  mkdirSync(dir, { recursive: true });
  // Vectors first, then the manifest that describes them; each is replaced atomically.
  const tmp = (name: string) => join(dir, `.${name}.${process.pid}.tmp`);
  writeFileSync(tmp("vectors.f32"), new Uint8Array(index.vectors.buffer, index.vectors.byteOffset, index.vectors.byteLength));
  renameSync(tmp("vectors.f32"), join(dir, "vectors.f32"));
  const meta = { version: INDEX_VERSION, model: index.model, dim: index.dim, ids: index.ids, hashes: index.hashes };
  writeFileSync(tmp("index.json"), JSON.stringify(meta));
  renameSync(tmp("index.json"), join(dir, "index.json"));
}

export interface SyncResult {
  embedded: number;
  removed: number;
  total: number;
}

/** Brings every layer's index up to date, embedding only objects whose text changed. */
export async function syncIndex(store: Store, embedder: Embedder, cache: string, options: { full?: boolean } = {}): Promise<SyncResult> {
  const result: SyncResult = { embedded: 0, removed: 0, total: 0 };
  const model = store.semantic.embedModel;
  for (const layer of store.layers) {
    const dir = indexDir(cache, layer);
    const old = options.full ? undefined : readIndex(dir);
    const usable = old?.model === model ? old : undefined;
    const previous = new Map<string, { hash: string; row: number }>();
    usable?.ids.forEach((id, row) => previous.set(id, { hash: usable.hashes[row]!, row }));

    const objects = [...store.objects.values()].filter((o) => o.layer.root === layer.root).sort((a, b) => a.id.localeCompare(b.id));
    const texts = objects.map((o) => objectText(store, o));
    const hashes = texts.map(hash);
    const stale = objects.map((_, i) => i).filter((i) => previous.get(objects[i]!.id)?.hash !== hashes[i]);
    const fresh = stale.length ? await embedder.embed(stale.map((i) => texts[i]!), "search_document") : [];

    const dim = fresh[0]?.length ?? usable?.dim ?? 0;
    if (usable && fresh.length && usable.dim !== dim) return syncIndex(store, embedder, cache, { full: true });
    const vectors = new Float32Array(objects.length * dim);
    const freshByIndex = new Map(stale.map((i, k) => [i, fresh[k]!]));
    objects.forEach((o, i) => {
      const v = freshByIndex.get(i) ?? usable!.vectors.subarray(previous.get(o.id)!.row * dim, (previous.get(o.id)!.row + 1) * dim);
      vectors.set(v, i * dim);
    });
    const current = new Set(objects.map((o) => o.id));
    const removed = usable ? usable.ids.filter((id) => !current.has(id)).length : 0;
    result.embedded += stale.length;
    result.removed += removed;
    result.total += objects.length;
    const changed = stale.length > 0 || removed > 0 || !old || old.model !== model;
    if (changed && (objects.length || existsSync(dir))) writeIndex(dir, { model, dim, ids: objects.map((o) => o.id), hashes, vectors });
  }
  return result;
}

// ── search ─────────────────────────────────────────────────────────────────

export interface Hit {
  obj: ObjectEntry;
  /** Rerank relevance (0–1), or the cosine similarity when not reranked. */
  score: number;
  similarity: number;
}

export interface SearchOptions {
  type?: string;
  limit?: number;
  /** Rerank the nearest candidates (default true). */
  rerank?: boolean;
  /** Ids to leave out. */
  exclude?: Set<string>;
  signal?: AbortSignal;
}

/** Ranks the store's objects against a query, using the indexes as they are in `cache`. */
export async function search(store: Store, embedder: Embedder, cache: string, query: string, options: SearchOptions = {}): Promise<Hit[]> {
  const limit = options.limit ?? 10;
  const model = store.semantic.embedModel;
  const indexes = store.layers.map((l) => readIndex(indexDir(cache, l))).filter((i): i is VectorIndex => i?.model === model);
  if (!indexes.some((i) => i.ids.length)) return [];
  const [q] = await embedder.embed([query], "search_query", options.signal);
  const scored: { obj: ObjectEntry; similarity: number }[] = [];
  for (const index of indexes) {
    if (index.dim !== q!.length) continue;
    index.ids.forEach((id, row) => {
      const obj = store.objects.get(id);
      if (!obj || options.exclude?.has(id) || (options.type && obj.type !== options.type)) return;
      scored.push({ obj, similarity: dot(q!, index.vectors, row * index.dim) });
    });
  }
  scored.sort((a, b) => b.similarity - a.similarity);
  if (options.rerank === false) return scored.slice(0, limit).map((s) => ({ ...s, score: s.similarity }));
  const candidates = scored.slice(0, Math.max(store.semantic.candidates, limit));
  const ranked = await embedder.rerank(
    query,
    candidates.map((c) => objectText(store, c.obj, RERANK_TEXT_MAX)),
    limit,
    options.signal,
  );
  return ranked.map((r) => ({ ...candidates[r.index]!, score: r.score }));
}

/** Whether a user message is worth a relevance lookup: not a command, not a two-word reply. */
export function worthSuggesting(prompt: string): boolean {
  const text = prompt.trim();
  if (!text || text.startsWith("/")) return false;
  return text.split(/\s+/).length >= 3 || text.length >= 20;
}

/** Objects relevant enough to a user message to suggest alongside it. */
export async function relevantTo(
  store: Store,
  embedder: Embedder,
  cache: string,
  prompt: string,
  options: { exclude?: Set<string>; signal?: AbortSignal } = {},
): Promise<Hit[]> {
  const exclude = new Set(options.exclude);
  for (const obj of store.objects.values()) if (obj.pinned) exclude.add(obj.id);
  const hits = await search(store, embedder, cache, prompt, { limit: store.semantic.maxRelevant, exclude, signal: options.signal });
  return hits.filter((h) => h.score >= store.semantic.threshold);
}

export function formatRelevant(hits: Hit[]): string {
  return [
    "<o6y-relevant>",
    "Memory objects that look relevant to this message (score = rerank relevance, 0–1). Read the ones that apply before acting:",
    ...hits.map((h) => `- [[${h.obj.id}]] (${h.score.toFixed(2)}) — ${h.obj.summary}`),
    "</o6y-relevant>",
  ].join("\n");
}
