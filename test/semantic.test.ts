import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { main } from "../src/cli/main.ts";
import { parseRootSchema } from "../src/core/schema.ts";
import {
  cohere,
  embedderFor,
  formatRelevant,
  indexDir,
  readIndex,
  relevantTo,
  search,
  semanticUnavailable,
  syncIndex,
  worthSuggesting,
} from "../src/core/semantic.ts";
import { makeLayers, Store } from "../src/core/store.ts";

let tmp: string;
let g: string;
let p: string;
let cache: string;

function put(rel: string, content: string, root = g) {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

const words = (text: string) => text.toLowerCase().match(/[a-z]{3,}/g) ?? [];

/** A stand-in for Cohere: hashed bag-of-words embeddings, word-overlap rerank. Records every call. */
function fakeCohere() {
  const calls: { endpoint: string; body: any }[] = [];
  const embed = (text: string) => {
    const v = new Array(64).fill(0);
    for (const w of words(text)) v[[...w].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 64, 7)] += 1;
    return v;
  };
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const endpoint = url.split("/v2/")[1]!;
    const body = JSON.parse(String(init.body));
    calls.push({ endpoint, body });
    if (endpoint === "embed") return Response.json({ embeddings: { float: body.texts.map(embed) } });
    const q = new Set(words(body.query));
    const results = body.documents
      .map((d: string, index: number) => ({ index, relevance_score: [...new Set(words(d))].filter((w) => q.has(w)).length / Math.max(q.size, 1) }))
      .sort((a: any, b: any) => b.relevance_score - a.relevance_score)
      .slice(0, body.top_n);
    return Response.json({ results });
  }) as unknown as typeof fetch;
  return { calls, fetch: fetchImpl, embedded: () => calls.filter((c) => c.endpoint === "embed" && c.body.input_type === "search_document").flatMap((c) => c.body.texts) };
}

const env = () => ({ O6Y_HOME: g, O6Y_PROJECT: p, O6Y_CACHE: cache, CO_API_KEY: "test-key" });
const load = () => Store.load(makeLayers(g, p));

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o6y-sem-"));
  g = join(tmp, "global");
  p = join(tmp, "proj");
  cache = join(tmp, "cache");
  put(".schema.md", "---\nsemantic:\n  enabled: true\n  threshold: 0.5\n---\n");
  put("person/.schema.md", "---\ndescription: A person\nfields:\n  role: string\n---\n");
  put("note/.schema.md", "---\ndescription: A note\n---\n");
  put("person/ana.md", "---\nsummary: Staff engineer who reviews ledger migrations\nrole: staff\n---\nAsk her about database migrations.\n");
  put("note/release-train.md", "---\nsummary: Weekly release train on Thursdays\n---\nCut the branch Wednesday night.\n");
  put("note/coffee.md", "---\nsummary: The office espresso machine\npinned: true\n---\nDescale monthly; ledger migrations unrelated.\n");
});

afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("settings", () => {
  test("semantic is opt-in and validated", () => {
    expect(parseRootSchema("---\n---\n").schema!.semantic).toEqual({});
    expect(parseRootSchema("---\nsemantic: { enabled: true, threshold: 0.4, rerankModel: rerank-x }\n---\n").schema!.semantic).toEqual({
      enabled: true,
      threshold: 0.4,
      rerankModel: "rerank-x",
    });
    expect(parseRootSchema("---\nsemantic: { threshold: 2 }\n---\n").errors[0]).toContain("between 0 and 1");
    expect(parseRootSchema("---\nsemantic: { enable: true }\n---\n").errors[0]).toContain("`semantic.enable` is not a setting");
  });

  test("needs both the opt-in and a key", () => {
    expect(semanticUnavailable(load(), env())).toBeUndefined();
    expect(semanticUnavailable(load(), { ...env(), CO_API_KEY: undefined })).toContain("CO_API_KEY");
    put(".schema.md", "---\n---\n");
    expect(semanticUnavailable(load(), env())).toContain("semantic: { enabled: true }");
    expect(embedderFor(load(), env())).toBeUndefined();
  });
});

describe("index", () => {
  test("embeds only what changed and drops deleted objects", async () => {
    const api = fakeCohere();
    const embedder = embedderFor(load(), env(), api.fetch)!;
    expect(await syncIndex(load(), embedder, cache)).toEqual({ embedded: 3, removed: 0, total: 3 });
    expect(await syncIndex(load(), embedder, cache)).toEqual({ embedded: 0, removed: 0, total: 3 });

    put("note/release-train.md", "---\nsummary: Release train moved to Tuesdays\n---\n");
    rmSync(join(g, "note/coffee.md"));
    expect(await syncIndex(load(), embedder, cache)).toEqual({ embedded: 1, removed: 1, total: 2 });
    expect(api.embedded().at(-1)).toContain("Release train moved to Tuesdays");

    const index = readIndex(indexDir(cache, load().layers[0]!))!;
    expect(index.ids).toEqual(["note/release-train", "person/ana"]);
    expect(index.vectors.length).toBe(2 * index.dim);
  });

  test("a model change re-embeds everything", async () => {
    const api = fakeCohere();
    await syncIndex(load(), embedderFor(load(), env(), api.fetch)!, cache);
    put(".schema.md", "---\nsemantic: { enabled: true, embedModel: embed-other }\n---\n");
    expect((await syncIndex(load(), embedderFor(load(), env(), api.fetch)!, cache)).embedded).toBe(3);
    expect(api.calls.at(-1)!.body.model).toBe("embed-other");
  });

  test("project and global layers get separate indexes", async () => {
    put(".schema.md", "---\n---\n", p);
    put("note/deploy.md", "---\nsummary: Project deploy steps\n---\n", p);
    const api = fakeCohere();
    await syncIndex(load(), embedderFor(load(), env(), api.fetch)!, cache);
    const [global, project] = load().layers.map((l) => readIndex(indexDir(cache, l))!);
    expect(global!.ids).not.toContain("note/deploy");
    expect(project!.ids).toEqual(["note/deploy"]);
  });
});

describe("search", () => {
  test("reranks the nearest candidates", async () => {
    const api = fakeCohere();
    const store = load();
    const embedder = embedderFor(store, env(), api.fetch)!;
    await syncIndex(store, embedder, cache);
    const hits = await search(store, embedder, cache, "who reviews ledger migrations?", { limit: 2 });
    expect(hits[0]!.obj.id).toBe("person/ana");
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
    const rerank = api.calls.find((c) => c.endpoint === "rerank")!;
    expect(rerank.body.top_n).toBe(2);
    expect(api.calls.find((c) => c.body.input_type === "search_query")!.body.texts).toEqual(["who reviews ledger migrations?"]);
  });

  test("--no-rerank ranks by similarity alone; --type filters", async () => {
    const api = fakeCohere();
    const store = load();
    const embedder = embedderFor(store, env(), api.fetch)!;
    await syncIndex(store, embedder, cache);
    const hits = await search(store, embedder, cache, "release train", { rerank: false, type: "note" });
    expect(hits.every((h) => h.obj.type === "note")).toBe(true);
    expect(hits[0]!.obj.id).toBe("note/release-train");
    expect(api.calls.some((c) => c.endpoint === "rerank")).toBe(false);
  });

  test("relevant objects: threshold, pinned and already-suggested are left out", async () => {
    const api = fakeCohere();
    const store = load();
    const embedder = embedderFor(store, env(), api.fetch)!;
    await syncIndex(store, embedder, cache);
    const hits = await relevantTo(store, embedder, cache, "who reviews ledger migrations");
    // note/coffee mentions ledger migrations but is pinned (already in the prompt in full).
    expect(hits.map((h) => h.obj.id)).toEqual(["person/ana"]);
    expect(formatRelevant(hits)).toContain("- [[person/ana]] (1.00) — Staff engineer who reviews ledger migrations");
    expect(await relevantTo(store, embedder, cache, "who reviews ledger migrations", { exclude: new Set(["person/ana"]) })).toEqual([]);
    expect(await relevantTo(store, embedder, cache, "lunch plans for friday")).toEqual([]);
  });

  test("worth suggesting: not commands or short replies", () => {
    expect(worthSuggesting("/o6y")).toBe(false);
    expect(worthSuggesting("ok")).toBe(false);
    expect(worthSuggesting("go on")).toBe(false);
    expect(worthSuggesting("who reviews ledger migrations")).toBe(true);
  });

  test("API errors carry Cohere's message", async () => {
    const failing = (async () => Response.json({ message: "invalid api token" }, { status: 401 })) as unknown as typeof fetch;
    const client = cohere({ apiKey: "bad", embedModel: "m", rerankModel: "r", fetch: failing });
    await expect(client.embed(["x"], "search_query")).rejects.toThrow("Cohere embed failed (401): invalid api token");
  });
});

describe("cli", () => {
  async function o6y(args: string[], extraEnv: Record<string, string | undefined> = {}, fetchImpl?: typeof fetch) {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(args, {
      cwd: tmp,
      env: { ...env(), ...extraEnv },
      out: (t) => out.push(t),
      err: (t) => err.push(t),
      stdin: () => undefined,
      isTTY: false,
      fetch: fetchImpl,
    });
    return { code, out: out.join("\n"), err: err.join("\n") };
  }

  test("search syncs the index and prints scored results", async () => {
    const api = fakeCohere();
    const r = await o6y(["search", "who", "reviews", "ledger", "migrations", "--limit", "1"], {}, api.fetch);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^- \[\[person\/ana\]\] \(1\.00\) — Staff engineer/);
    expect(existsSync(join(indexDir(cache, load().layers[0]!), "vectors.f32"))).toBe(true);
    const json = JSON.parse((await o6y(["search", "release train", "--json", "--limit", "1"], {}, api.fetch)).out);
    expect(json[0]).toMatchObject({ id: "note/release-train", score: 1 });
  });

  test("search falls back to word match without a key", async () => {
    const r = await o6y(["search", "ledger migrations"], { CO_API_KEY: undefined });
    expect(r.code).toBe(0);
    expect(r.err).toContain("CO_API_KEY");
    expect(r.out).toContain("[[person/ana]] (1.00)");
  });

  test("reindex reports counts, and refuses when off", async () => {
    const api = fakeCohere();
    expect((await o6y(["reindex"], {}, api.fetch)).out).toContain("3 objects indexed: 3 embedded, 0 removed");
    expect((await o6y(["reindex", "--full"], {}, api.fetch)).out).toContain("3 embedded");
    const off = await o6y(["reindex"], { CO_API_KEY: undefined });
    expect(off.code).toBe(1);
    expect(off.err).toContain("CO_API_KEY");
  });
});
