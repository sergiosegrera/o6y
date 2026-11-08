import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { bootstrap } from "../src/core/fsops.ts";
import { DEFAULT_DREAM, parseRootSchema } from "../src/core/schema.ts";
import { main } from "../src/cli/main.ts";
import { makeLayers, Store } from "../src/core/store.ts";
import { readRuns } from "../src/dream/status.ts";
import { renderDreamPage } from "../src/viewer/model.ts";
import { type AgentRunner, findUnprocessed, runDream } from "../src/dream/runner.ts";
import { dreamsDir, readLedger } from "../src/dream/state.ts";
import { storeTools } from "../src/dream/tools.ts";
import { activeBranch, paginate, parseTranscript, pendingPart, renderEntries } from "../src/dream/transcript.ts";

let tmp: string;
let g: string;
let sessions: string;
let env: Record<string, string | undefined>;

const header = (id: string, cwd: string) => ({ type: "session", version: 3, id, timestamp: "2026-11-01T00:00:00.000Z", cwd });
const user = (id: string, parentId: string | null, text: string) => ({ type: "message", id, parentId, timestamp: "2026-11-01T00:00:01.000Z", message: { role: "user", content: text } });
const assistant = (id: string, parentId: string, text: string) => ({ type: "message", id, parentId, message: { role: "assistant", content: [{ type: "thinking", thinking: "secret plan" }, { type: "text", text }] } });
const toJsonl = (lines: unknown[]) => lines.map((l) => JSON.stringify(l)).join("\n") + "\n";

function session(id: string, lines: unknown[], cwd = tmp): string {
  const file = join(sessions, `${id}.jsonl`);
  writeFileSync(file, toJsonl([header(id, cwd), ...lines]));
  return file;
}

const note = (body: string) => `---\nsummary: A note\n---\n${body}\n`;
const callTool = (tools: any[], name: string, params: unknown) => tools.find((t) => t.name === name).execute("id", params, undefined, undefined, {});

/** A fake analyzer that writes one note per transcript; the organizer does nothing. */
const writer = (seen: string[] = []): AgentRunner => async ({ role, prompt, tools }) => {
  seen.push(role);
  if (role === "analyzer") await callTool(tools, "store_write", { target: `note/from-${seen.length}`, content: note(prompt) });
  return { text: "ok", cost: 0.01, tokens: 10 };
};

const options = (agent: AgentRunner) => ({ cwd: tmp, env, storeRoot: g, sessionsDir: sessions, settings: DEFAULT_DREAM, agent });

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o6y-dream-"));
  g = join(tmp, "global");
  sessions = join(tmp, "sessions");
  mkdirSync(sessions);
  env = { O6Y_CACHE: join(tmp, "cache") };
  bootstrap(g);
});

afterEach(() => rmSync(tmp, { recursive: true, force: true }));

test("the active branch follows parents from the last entry", () => {
  const t = parseTranscript("f", toJsonl([header("a", "/x"), user("1", null, "root"), user("2", "1", "abandoned"), user("3", "1", "kept")]))!;
  expect(activeBranch(t.entries).map((e) => e.id)).toEqual(["1", "3"]);
});

test("rendering drops thinking and o6y suggestions and trims tool results", () => {
  const text = renderEntries(
    [
      user("1", null, "hello"),
      assistant("2", "1", "hi"),
      { type: "message", id: "3", parentId: "2", message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "x".repeat(500) }] } },
      { type: "custom_message", id: "4", parentId: "3", customType: "o6y-relevant", display: true, content: "SUGGESTED" },
      { type: "message", id: "5", parentId: "4", message: { role: "system", content: "SYSTEM" } },
    ],
    100,
  );
  expect(text).toContain("USER: hello");
  expect(text).toContain("ASSISTANT: hi");
  expect(text).toContain("characters omitted");
  for (const hidden of ["secret plan", "SUGGESTED", "SYSTEM"]) expect(text).not.toContain(hidden);
});

test("pending covers only what's new, and needs a user message", () => {
  const t = parseTranscript("f", toJsonl([header("a", "/x"), user("1", null, "one"), assistant("2", "1", "r"), user("3", "2", "two")]))!;
  expect(pendingPart(t, undefined)!.entries.map((e) => e.id)).toEqual(["1", "2", "3"]);
  expect(pendingPart(t, "2")!.entries.map((e) => e.id)).toEqual(["3"]);
  expect(pendingPart(t, "3")).toBeUndefined();
  expect(pendingPart(t, "gone")!.entries).toHaveLength(3);
  const silent = parseTranscript("f", toJsonl([header("b", "/x"), { type: "model_change", id: "1", parentId: null }]))!;
  expect(pendingPart(silent, undefined)).toBeUndefined();
});

test("paginate keeps all text within the page size", () => {
  const text = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
  const pages = paginate(text, 40);
  expect(pages.join("")).toBe(text);
  expect(pages.every((p) => p.length <= 40)).toBe(true);
});

test("the dream block is parsed and validated", () => {
  const ok = parseRootSchema("---\ndream:\n  model: openrouter/deepseek/x\n  thinking: low\n  pageChars: 100\n---\n");
  expect(ok.schema!.dream).toEqual({ model: "openrouter/deepseek/x", thinking: "low", pageChars: 100 });
  expect(parseRootSchema("---\ndream:\n  model: noprovider\n---\n").errors[0]).toContain("provider/model-id");
  expect(parseRootSchema("---\ndream:\n  thinking: loud\n---\n").errors[0]).toContain("dream.thinking");
  expect(parseRootSchema("---\ndream:\n  nope: 1\n---\n").errors[0]).toContain("not a setting");
});

test("a dream applies its changes, logs them and records the session", async () => {
  session("a", [user("1", null, "remember")]);
  const seen: string[] = [];
  const run = await runDream(options(writer(seen)));
  expect(run.status).toBe("done");
  expect(seen).toEqual(["analyzer", "organizer"]);
  expect(existsSync(join(g, "note/from-1.md"))).toBe(true);
  expect(readFileSync(join(g, "log.md"), "utf8")).toContain("create note/from-1 (dream)");
  expect(readFileSync(join(g, "note/from-1.md"), "utf8")).not.toContain("sources");
  expect(readFileSync(join(g, "log.md"), "utf8")).toContain("create note/from-1 (dream) [pi:a]");
  expect(readLedger(dreamsDir(env)).sessions.a!.leaf).toBe("1");
  expect(existsSync(join(run.snapshot!, ".schema.md"))).toBe(true);
  expect((await runDream(options(writer()))).status).toBe("nothing");
});

test("a resumed session is processed again from where the last dream stopped", async () => {
  session("a", [user("1", null, "one")]);
  await runDream(options(writer()));
  session("a", [user("1", null, "one"), assistant("2", "1", "r"), user("3", "2", "two")]);
  const pending = findUnprocessed({ ...options(writer()) });
  expect(pending[0]!.entries.map((e) => e.id)).toEqual(["2", "3"]);
});

test("the running session is left out, and a dry run changes nothing", async () => {
  session("a", [user("1", null, "x")]);
  session("b", [user("1", null, "y")]);
  const run = await runDream({ ...options(writer()), excludeSession: "b", dryRun: true });
  expect(run.status).toBe("dry-run");
  expect(run.sessions.map((s) => s.id)).toEqual(["a"]);
  expect(existsSync(dreamsDir(env))).toBe(false);
});

test("a failed analyzer leaves its session unprocessed", async () => {
  session("a", [user("1", null, "x")]);
  const run = await runDream(options(async () => {
    throw new Error("model down");
  }));
  expect(run.status).toBe("failed");
  expect(run.sessions[0]!.summary).toContain("model down");
  expect(findUnprocessed(options(writer()))).toHaveLength(1);
});

test("an edit made during the dream is kept", async () => {
  mkdirSync(dirname(join(g, "note/x.md")), { recursive: true });
  writeFileSync(join(g, "note/x.md"), note("original"));
  session("a", [user("1", null, "x")]);
  const run = await runDream(options(async ({ role, tools }) => {
    if (role === "analyzer") {
      await callTool(tools, "store_write", { target: "note/x", content: note("from dream") });
      writeFileSync(join(g, "note/x.md"), note("edited by hand"));
    }
    return { text: "", cost: 0, tokens: 0 };
  }));
  expect(run.conflicts).toEqual([expect.stringContaining("note/x.md")]);
  expect(readFileSync(join(g, "note/x.md"), "utf8")).toContain("edited by hand");
});

test("an aborted dream changes nothing", async () => {
  session("a", [user("1", null, "x")]);
  const controller = new AbortController();
  const run = await runDream({
    ...options(async ({ tools }) => {
      await callTool(tools, "store_write", { target: "note/y", content: note("y") });
      controller.abort();
      throw new Error("aborted");
    }),
    signal: controller.signal,
  });
  expect(run.status).toBe("aborted");
  expect(existsSync(join(g, "note/y.md"))).toBe(false);
  expect(readLedger(dreamsDir(env)).sessions).toEqual({});
});

test("changes go only to staged stores; live is untouched until the end", async () => {
  session("a", [user("1", null, "x")]);
  let liveDuring = true;
  await runDream(options(async ({ role, tools }) => {
    if (role === "analyzer") {
      await callTool(tools, "store_write", { target: "note/z", content: note("z") });
      liveDuring = existsSync(join(g, "note/z.md"));
    }
    return { text: "", cost: 0, tokens: 0 };
  }));
  expect(liveDuring).toBe(false);
  expect(existsSync(join(g, "note/z.md"))).toBe(true);
});

test("store tools can't leave the stores", async () => {
  const tools = storeTools(makeLayers(g));
  await expect(callTool(tools, "store_write", { target: "../../evil", content: "x" })).rejects.toThrow();
  await expect(callTool(tools, "store_write", { target: "note/../../evil", content: "x" })).rejects.toThrow();
  await expect(callTool(tools, "store_cli", { args: ["query", "--global", "/etc"] })).rejects.toThrow("can't be used");
  await expect(callTool(tools, "store_cli", { args: ["check", "note/a", "--file", "/etc/passwd"] })).rejects.toThrow("can't be used");
  await expect(callTool(tools, "store_cli", { args: ["view"] })).rejects.toThrow("can't be used");
});

test("an invalid write is rejected with the reason", async () => {
  const tools = storeTools(makeLayers(g));
  await expect(callTool(tools, "store_write", { target: "note/a", content: "---\nsummary: 1\nno closing" })).rejects.toThrow("rejected");
  const out = await callTool(tools, "store_cli", { args: ["lint"] });
  expect(out.content[0].text).toBeString();
});

test("o6y dream reports waiting sessions and the last dream", async () => {
  session("a", [user("1", null, "remember")]);
  session("b", [user("1", null, "remember")], "/elsewhere");
  const status = async () => {
    const out: string[] = [];
    const code = await main(["dream"], { cwd: tmp, env: { ...env, O6Y_HOME: g, PI_CODING_AGENT_SESSION_DIR: sessions }, out: (t) => out.push(t), err: (t) => out.push(t), stdin: () => undefined, isTTY: false });
    expect(code).toBe(0);
    return out.join("\n");
  };
  expect(await status()).toContain("2 unprocessed sessions (1 from this directory)");
  expect(await status()).toContain("No dreams yet.");
  const run = await runDream({ ...options(writer()), limit: 1 });
  const text = await status();
  expect(text).toContain("1 unprocessed session (");
  expect(text).toContain("Last dream:");
  expect(text).toContain("1/1 sessions");

  const store = Store.load(makeLayers(g));
  const page = renderDreamPage(store, readRuns(env)[0]!, 80);
  const lines = page.lines.map((l) => l.map((s) => s.text).join(""));
  expect(readRuns(env)[0]!.id).toBe(run.id);
  expect(lines.join("\n")).toContain("Changes");
  expect(page.links).toEqual(["note/from-1"]);
  expect(lines[page.linkLines[0]!]).toContain("note/from-1");
});

test("o6y dream run hands off to a headless pi, skipping the calling session", async () => {
  const bin = join(tmp, "bin");
  mkdirSync(bin);
  const seen = join(tmp, "seen");
  writeFileSync(join(bin, "pi"), `#!/bin/sh\nprintf '%s\\n' "$@" "exclude=$O6Y_DREAM_EXCLUDE" > ${seen}\necho dreamt\n`, { mode: 0o755 });
  const out: string[] = [];
  const io = { cwd: tmp, env: { ...env, O6Y_HOME: g, O6Y_SOURCE: "pi:caller", PATH: `${bin}:${process.env.PATH}` }, out: (t: string) => out.push(t), err: (t: string) => out.push(t), stdin: () => undefined, isTTY: false };
  expect(await main(["dream", "run", "--here", "--limit", "2"], io)).toBe(0);
  expect(out.join("\n")).toContain("dreamt");
  const args = readFileSync(seen, "utf8");
  expect(args).toContain("/o6y-dream --here --limit 2");
  expect(args).toContain("--no-session");
  expect(args).toContain("exclude=caller");
  expect(args).toMatch(/\/index\.ts\n/);
  expect(await main(["dream", "run", "--limit", "x"], io)).toBe(2);
});

test("a dream saves its progress while it runs, and an abandoned one reads as aborted", async () => {
  session("a", [header("a", tmp), user("1", null, "hello")]);
  const seen: { status: string; step?: string; planned?: number; sessions: number }[] = [];
  const run = await runDream(options(async () => {
    const r = readRuns(env)[0]!;
    seen.push({ status: r.status, step: r.step, planned: r.planned, sessions: r.sessions.length });
    expect(renderDreamPage(Store.load(makeLayers(g)), r, 60).lines.flat().map((s) => s.text).join("")).toContain("⋯");
    return { text: "nothing durable", cost: 0, tokens: 0 };
  }));
  expect(seen).toEqual([{ status: "running", step: "session 1/1", planned: 1, sessions: 1 }]);
  const finished = readRuns(env)[0]!;
  expect(finished.status).toBe(run.status);
  expect(finished.pid).toBeUndefined();
  expect(finished.step).toBeUndefined();

  const file = join(dreamsDir(env), "runs", run.id, "run.json");
  writeFileSync(file, JSON.stringify({ ...finished, status: "running", pid: 999999 }));
  expect(readRuns(env)[0]!.status).toBe("aborted");
  writeFileSync(file, JSON.stringify({ ...finished, status: "running", pid: process.pid }));
  expect(readRuns(env)[0]!.status).toBe("running");
});
