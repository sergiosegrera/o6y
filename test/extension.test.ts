import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import o6y from "../src/extension.ts";
import { readSuggestionLog } from "../src/core/semantic.ts";
import { fakeCohere } from "./fake-cohere.ts";

let tmp: string;
let g: string;
let cache: string;
const savedEnv = { ...process.env };
const savedFetch = globalThis.fetch;

function put(rel: string, content: string) {
  const path = join(g, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** Loads the extension against a mock pi; returns its handlers and a context. */
function start() {
  const handlers: Record<string, Function> = {};
  const status: (string | undefined)[] = [];
  const pi: any = {
    on: (event: string, handler: Function) => (handlers[event] = handler),
    registerFlag() {},
    getFlag() {},
    registerCommand() {},
    registerMessageRenderer() {},
  };
  o6y(pi);
  const ctx: any = {
    cwd: tmp,
    hasUI: true,
    ui: { notify() {}, setStatus: (_key: string, text: string | undefined) => status.push(text) },
    sessionManager: { getSessionId: () => "session-1" },
  };
  const prompt = async (text: string) =>
    (await handlers.before_agent_start!({ prompt: text, systemPromptOptions: { sections: {} } }, ctx))?.message;
  const tool = (toolName: string, input: unknown) =>
    handlers.tool_result!({ toolName, input, toolCallId: "t", content: [], isError: false }, ctx);
  const indexed = async () => {
    for (let i = 0; i < 100 && status.at(-1) !== undefined; i++) await new Promise((r) => setTimeout(r, 5));
  };
  return { handlers, ctx, prompt, tool, indexed };
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o6y-ext-"));
  g = join(tmp, "global");
  cache = join(tmp, "cache");
  Object.assign(process.env, { O6Y_HOME: g, O6Y_PROJECT: join(tmp, "proj"), O6Y_CACHE: cache, CO_API_KEY: "test-key" });
  globalThis.fetch = fakeCohere().fetch;
  put(".schema.md", "---\nsemantic: { enabled: true, threshold: 0.5 }\n---\n");
  put("person/.schema.md", "---\ndescription: A person\n---\n");
  put("note/.schema.md", "---\ndescription: A note\n---\n");
  put("person/ana.md", "---\nsummary: Staff engineer who reviews ledger migrations\n---\nAsk her about database migrations.\n");
  put("note/release-train.md", "---\nsummary: Weekly release train on Thursdays\n---\nCut the branch Wednesday night.\n");
});

afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  globalThis.fetch = savedFetch;
  rmSync(tmp, { recursive: true, force: true });
});

test("suggests once, logs the suggestion and the agent opening it, and resets on compaction", async () => {
  const { handlers, ctx, prompt, tool, indexed } = start();
  await handlers.session_start!({}, ctx);
  await indexed();

  const first = await prompt("who reviews ledger migrations");
  expect(first.content).toContain("[[person/ana]]");
  expect(first.details.hits.map((h: { id: string }) => h.id)).toEqual(["person/ana"]);
  expect(await prompt("who reviews ledger migrations")).toBeUndefined();
  expect(await prompt("ok")).toBeUndefined();

  await tool("bash", { command: "o6y show note/release-train" }); // never suggested: not a use
  await tool("read", { path: join(g, "person/ana.md") });
  await tool("bash", { command: `cat ${join(g, "person/ana.md")}` }); // second open: logged once

  const log = readSuggestionLog(cache);
  expect(log).toEqual([
    { type: "suggest", t: expect.any(String), session: "session-1", turn: 1, hits: [{ id: "person/ana", score: 1, similarity: expect.any(Number) }] },
    { type: "use", t: expect.any(String), session: "session-1", turn: 3, id: "person/ana", via: "read" },
  ]);
  expect("prompt" in log[0]!).toBe(false);

  await handlers.session_compact!({}, ctx);
  expect((await prompt("who reviews ledger migrations")).details.hits[0].id).toBe("person/ana");
});

test("bash commands that name a suggested object count as a use", async () => {
  const { handlers, ctx, prompt, tool, indexed } = start();
  await handlers.session_start!({}, ctx);
  await indexed();
  await prompt("when does the weekly release train leave");
  await tool("bash", { command: "o6y show note/release-train" });
  expect(readSuggestionLog(cache).at(-1)).toMatchObject({ type: "use", id: "note/release-train", via: "bash" });
});

test("prompts are logged only with logPrompts", async () => {
  put(".schema.md", "---\nsemantic: { enabled: true, threshold: 0.5, logPrompts: true }\n---\n");
  const { handlers, ctx, prompt, indexed } = start();
  await handlers.session_start!({}, ctx);
  await indexed();
  await prompt("who reviews ledger migrations");
  expect(readSuggestionLog(cache)[0]).toMatchObject({ type: "suggest", prompt: "who reviews ledger migrations" });
});
