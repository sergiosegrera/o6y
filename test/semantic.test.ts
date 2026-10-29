import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { main } from "../src/cli/main.ts";
import { buildPromptSection } from "../src/core/render.ts";
import { parseRootSchema } from "../src/core/schema.ts";
import {
  cohere,
  embedderFor,
  formatRelevant,
  indexDir,
  readIndex,
  type LogRecord,
  readSuggestionLog,
  relevantTo,
  search,
  semanticUnavailable,
  suggestionStats,
  syncIndex,
  worthSuggesting,
} from "../src/core/semantic.ts";
import { makeLayers, Store } from "../src/core/store.ts";
import { fakeCohere } from "./fake-cohere.ts";

let tmp: string;
let g: string;
let p: string;
let cache: string;

function put(rel: string, content: string, root = g) {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
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

test("the prompt rules point to `o6y search` and suggestions only when semantic search is on", () => {
  const on = buildPromptSection(load()).text;
  expect(on).toContain('`o6y search "<question>"` finds objects by meaning');
  expect(on).toContain("<o6y-relevant>");
  put(".schema.md", "---\n---\n");
  const off = buildPromptSection(load()).text;
  expect(off).toContain("`o6y query <text>` (or --type/--where/--links-to), `o6y lint`");
  expect(off).not.toContain("o6y search");
  expect(off).not.toContain("<o6y-relevant>");
});

describe("index", () => {
  test("embeds only what changed and drops deleted objects", async () => {
    const api = fakeCohere();
    const embedder = embedderFor(load(), env(), api.fetch)!;
    expect(await syncIndex(load(), embedder, cache)).toMatchObject({ embedded: 3, removed: 0, total: 3, skipped: [] });
    expect(await syncIndex(load(), embedder, cache)).toMatchObject({ embedded: 0, removed: 0, total: 3 });

    put("note/release-train.md", "---\nsummary: Release train moved to Tuesdays\n---\n");
    rmSync(join(g, "note/coffee.md"));
    expect(await syncIndex(load(), embedder, cache)).toMatchObject({ embedded: 1, removed: 1, total: 2 });
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

  test("objects that don't load are reported as skipped", async () => {
    put("note/broken.md", "---\nsummary: has: a colon\n---\n");
    const api = fakeCohere();
    const r = await syncIndex(load(), embedderFor(load(), env(), api.fetch)!, cache);
    expect(r.total).toBe(3);
    expect(r.skipped).toEqual([{ id: "note/broken", path: join(g, "note/broken.md"), layer: g, reason: "invalid frontmatter" }]);
  });

  test("overlapping stores: a shadowed layer keeps its vectors, and moved ids aren't 'removed'", async () => {
    const api = fakeCohere();
    // Index the real store as the project layer, then run with a copy of it as the global layer.
    const asProject = Store.load(makeLayers(join(tmp, "elsewhere"), g));
    await syncIndex(asProject, embedderFor(asProject, env(), api.fetch)!, cache);
    const copy = join(tmp, "copy");
    for (const rel of [".schema.md", "person/.schema.md", "note/.schema.md", "person/ana.md", "note/release-train.md", "note/coffee.md"]) {
      put(rel, readFileSync(join(g, rel), "utf8"), copy);
    }
    const overlapping = Store.load(makeLayers(copy, g));
    const r = await syncIndex(overlapping, embedderFor(overlapping, env(), api.fetch)!, cache);
    expect(r).toMatchObject({ embedded: 3, removed: 0, total: 3 });
    expect(r.skipped.map((s) => s.reason)).toEqual(Array(3).fill("id also exists in another layer"));
    // The real store's index survived, so going back costs no API calls.
    const before = api.calls.length;
    expect(await syncIndex(asProject, embedderFor(asProject, env(), api.fetch)!, cache)).toMatchObject({ embedded: 0, removed: 0 });
    expect(api.calls.length).toBe(before);
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

  test("the similarity floor applies before rerank", async () => {
    const api = fakeCohere();
    const store = load();
    const embedder = embedderFor(store, env(), api.fetch)!;
    await syncIndex(store, embedder, cache);
    const query = "who reviews ledger migrations";
    const bySimilarity = await search(store, embedder, cache, query, { rerank: false });
    const floor = (bySimilarity[0]!.similarity + bySimilarity[1]!.similarity) / 2;
    put(".schema.md", `---\nsemantic: { enabled: true, minSimilarity: ${floor} }\n---\n`);
    const hits = await search(load(), embedder, cache, query, { limit: 3 });
    expect(api.calls.at(-1)!.body.documents).toHaveLength(1);
    expect(hits.map((h) => h.obj.id)).toEqual([bySimilarity[0]!.obj.id]);
  });

  test("minScore drops weak results", async () => {
    const api = fakeCohere();
    const store = load();
    const embedder = embedderFor(store, env(), api.fetch)!;
    await syncIndex(store, embedder, cache);
    const query = "who reviews ledger migrations on the release train";
    const all = await search(store, embedder, cache, query, { minScore: 0 });
    expect(all.length).toBeGreaterThan(1);
    const cut = (all[0]!.score + all[1]!.score) / 2;
    expect((await search(store, embedder, cache, query, { minScore: cut })).map((h) => h.obj.id)).toEqual([all[0]!.obj.id]);
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

describe("suggestion stats", () => {
  const t = (day: string) => `2026-10-${day}T12:00:00.000Z`;
  const records: LogRecord[] = [
    { type: "suggest", t: t("20"), session: "a", turn: 1, hits: [{ id: "person/ana", score: 0.8, similarity: 0.5 }, { id: "note/x", score: 0.4, similarity: 0.2 }] },
    { type: "use", t: t("20"), session: "a", turn: 1, id: "person/ana", via: "read" },
    { type: "suggest", t: t("28"), session: "b", turn: 3, hits: [{ id: "note/x", score: 0.36, similarity: 0.2 }, { id: "person/ana", score: 0.6, similarity: 0.4 }] },
    // Opened in a different session than it was suggested in: doesn't count for session b.
    { type: "use", t: t("28"), session: "c", turn: 1, id: "person/ana", via: "bash" },
  ];

  test("counts uses per session, by score band, and never-opened objects", () => {
    const stats = suggestionStats(records);
    expect(stats).toMatchObject({ sessions: 2, suggestions: 4, used: 1 });
    expect(stats.bands).toEqual([
      { from: 0, to: 0.5, suggestions: 2, used: 0 },
      { from: 0.5, to: 0.7, suggestions: 1, used: 0 },
      { from: 0.7, to: 1, suggestions: 1, used: 1 },
    ]);
    expect(stats.ignored).toEqual([{ id: "note/x", times: 2 }]);
    expect(suggestionStats(records, new Date(t("25")))).toMatchObject({ sessions: 1, suggestions: 2, used: 0 });
  });

  test("the log tolerates a torn last line", () => {
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, "suggestions.jsonl"), `${JSON.stringify(records[0])}\n{"type":"sugg`);
    expect(readSuggestionLog(cache)).toHaveLength(1);
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

  test("search applies the threshold when reranking; --min-score overrides it", async () => {
    const api = fakeCohere();
    expect((await o6y(["search", "banana bread recipe"], {}, api.fetch)).out).toBe("No matching objects.");
    expect((await o6y(["search", "banana bread recipe", "--min-score", "0"], {}, api.fetch)).out).toContain("(0.00)");
    expect((await o6y(["search", "x", "--min-score", "2"], {}, api.fetch)).code).toBe(2);
  });

  test("search and reindex report objects they skip", async () => {
    put("note/broken.md", "---\nsummary: has: a colon\n---\n");
    const api = fakeCohere();
    expect((await o6y(["reindex"], {}, api.fetch)).out).toContain("1 object(s) not indexed: note/broken (invalid frontmatter); see `o6y lint`");
    expect((await o6y(["search", "ledger migrations"], {}, api.fetch)).err).toContain("note/broken (invalid frontmatter)");
  });

  test("suggestions summarizes the log", async () => {
    expect((await o6y(["suggestions"])).out).toContain("No suggestions logged yet");
    mkdirSync(cache, { recursive: true });
    const now = new Date().toISOString();
    const lines = [
      { type: "suggest", t: now, session: "s", turn: 1, hits: [{ id: "person/ana", score: 0.8, similarity: 0.5 }] },
      { type: "use", t: now, session: "s", turn: 2, id: "person/ana", via: "read" },
    ];
    writeFileSync(join(cache, "suggestions.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n"));
    const out = (await o6y(["suggestions"])).out;
    expect(out).toContain("1 objects suggested over 1 session(s); 1 opened afterwards (100%)");
    expect(out).toContain("0.70–1.00  100% opened (1/1)");
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
