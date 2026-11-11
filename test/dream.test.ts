import { afterEach, beforeEach, expect, test } from "bun:test";
import { dreamInvocation } from "../src/dream/launch.ts";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { bootstrap } from "../src/core/fsops.ts";
import { DEFAULT_DREAM, parseRootSchema } from "../src/core/schema.ts";
import { main } from "../src/cli/main.ts";
import { makeLayers, Store } from "../src/core/store.ts";
import { formatRun, parseSince, readRuns } from "../src/dream/status.ts";
import { similarObjects, withInstructions } from "../src/dream/prompts.ts";
import { type Page, plain as plainLine, renderDreamPage } from "../src/viewer/model.ts";
const plain = (page: Page) => page.lines.map(plainLine).join("\n");
import { type AgentRunner, findUnprocessed, runDream } from "../src/dream/runner.ts";
import { applyRun, discardRun, dreamsDir, dropStaged, readLedger } from "../src/dream/state.ts";
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
  if (role === "analyzer") await callTool(tools, "store_write", { target: `note/from-${seen.length}`, content: note(prompt), reason: "outlasts the PR" });
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

test("--since accepts ages and dates, and filters by when a session started", () => {
  const now = new Date("2026-11-08T12:00:00.000Z");
  expect(parseSince("7d", now)).toBe("2026-11-01T12:00:00.000Z");
  expect(parseSince("2w", now)).toBe("2026-10-25T12:00:00.000Z");
  expect(parseSince("2026-10-01", now)).toBeDefined();
  for (const bad of ["", "0d", "soon", "2026-13"]) expect(parseSince(bad, now)).toBeUndefined();

  session("old", [user("1", null, "hello")]);
  expect(findUnprocessed({ ...options(writer()), since: "2026-10-31T00:00:00.000Z" })).toHaveLength(1);
  expect(findUnprocessed({ ...options(writer()), since: "2026-11-02T00:00:00.000Z" })).toHaveLength(0);
});

test("--session reads named sessions again in full", async () => {
  session("abc-1", [user("1", null, "first")]);
  session("abd-2", [user("1", null, "second")]);
  await runDream(options(writer()));
  expect(findUnprocessed(options(writer()))).toHaveLength(0);

  const forced = findUnprocessed({ ...options(writer()), sessions: ["abc"] });
  expect(forced.map((p) => p.transcript.id)).toEqual(["abc-1"]);
  expect(forced[0]!.entries).toHaveLength(1);

  const prompts: string[] = [];
  const run = await runDream({ ...options(async ({ role, prompt }) => {
    if (role === "analyzer") prompts.push(prompt);
    return { text: "ok", cost: 0, tokens: 0 };
  }), sessions: ["abc-1"] });
  expect(run.sessions.map((s) => s.id)).toEqual(["abc-1"]);
  expect(prompts[0]).not.toContain("continues a session");

  expect(() => findUnprocessed({ ...options(writer()), sessions: ["ab"] })).toThrow("matches 2");
  expect(() => findUnprocessed({ ...options(writer()), sessions: ["zzz"] })).toThrow("no session matches");
  expect(() => findUnprocessed({ ...options(writer()), sessions: ["abc"], excludeSession: "abc-1" })).toThrow("running session");
});

test("the organizer is told what the dream changed and what looks alike", async () => {
  mkdirSync(join(g, "note"), { recursive: true });
  writeFileSync(join(g, "note/menu-locator-trap.md"), "---\nsummary: Menu locator fails inside the overflow popover\n---\nOld.\n");
  session("a", [user("1", null, "hello")]);
  let prompt = "";
  await runDream(options(async ({ role, prompt: p, tools }) => {
    if (role === "organizer") prompt = p;
    else await callTool(tools, "store_write", { target: "note/overflow-menu-locator", content: "---\nsummary: Overflow popover menu locator fails\n---\nNew.\n", reason: "r" }).catch(() => callTool(tools, "store_write", { target: "note/overflow-menu-locator", content: "---\nsummary: Overflow popover menu locator fails\n---\nNew.\n", reason: "r" }));
    return { text: "ok", cost: 0, tokens: 0 };
  }));
  expect(prompt).toContain("Created (1): note/overflow-menu-locator");
  expect(prompt).toContain("note/menu-locator-trap / note/overflow-menu-locator");
});

test("similar pairs need a touched object and real overlap", () => {
  const objects = [
    { id: "note/gt-submit", summary: "gt submit rewrites a teammate branch" },
    { id: "note/gt-restack", summary: "gt restack rewrites a teammate branch" },
    { id: "note/lazygit", summary: "lazygit keybinding clash" },
  ];
  expect(similarObjects(objects, ["note/gt-submit"])).toEqual([["note/gt-submit", "note/gt-restack"]]);
  expect(similarObjects(objects, ["note/lazygit"])).toEqual([]);
});

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
      await callTool(tools, "store_write", { target: "note/y", content: note("y"), reason: "r" });
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
      await callTool(tools, "store_write", { target: "note/z", content: note("z"), reason: "r" });
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

test("a dream's agents get the store's guidance, after the defaults it overrides", async () => {
  session("a", [header("a", tmp), user("1", null, "hello")]);
  writeFileSync(join(g, ".schema.md"), `${readFileSync(join(g, ".schema.md"), "utf8").trimEnd()}\n\nThe repo wins.\n`);
  let system = "";
  await runDream(options(async (r) => {
    system = r.system;
    return { text: "nothing durable", cost: 0, tokens: 0 };
  }));
  expect(system.indexOf("The repo wins.")).toBeGreaterThan(system.indexOf("Before every write"));
  expect(withInstructions("base", "", "")).toBe("base");
});

test("a large dream's page leads with totals and folds sessions that found nothing", async () => {
  const store = Store.load(makeLayers(g));
  const session = (i: number, cwd: string, ok: boolean, summary: string) => ({ id: `s${i}`, file: "", cwd, ok, summary });
  const run = {
    id: "r", status: "partial" as const, startedAt: "2026-11-01T00:00:00.000Z", finishedAt: "2026-11-01T01:05:00.000Z", models: { analyzer: "m", organizer: "m" }, unprocessed: 230,
    sessions: [...Array.from({ length: 200 }, (_, i) => session(i, i % 2 ? "/work/a" : "/work/b", true, "nothing durable")), session(200, "/work/a", true, `Found a trap. ${"long ".repeat(400)}`), session(201, "/work/c", false, "failed: timeout")],
    changes: [{ action: "update", path: "/x/note/u.md" }, { action: "create", path: "/x/note/c.md" }], conflicts: [], cost: 2.02, tokens: 3_400_000,
  };
  const text = (detail: boolean) => renderDreamPage(store, run, 70, detail);
  const folded = text(false).lines.map((l) => l.map((s) => s.text).join(""));
  expect(folded.length).toBeLessThan(40);
  expect(folded[1]).toBe("201/202 sessions · 1 failed · 200 found nothing");
  expect(folded[2]).toBe("2 changes: +1 ~1");
  expect(folded[3]).toBe("$2.0200 · $0.0100/session · 3.4M tokens · 1h 5m");
  expect(folded.indexOf("Failed (1)")).toBeLessThan(folded.indexOf("Changes (2)"));
  expect(folded.findIndex((l) => l.includes("+ note/c"))).toBeLessThan(folded.findIndex((l) => l.includes("~ note/u")));
  expect(folded.some((l) => l.includes("100 /work/a"))).toBe(true);
  expect(text(false).sections!.map((i) => folded[i])).toContain("Found nothing (200)");
  expect(text(true).lines.length).toBeGreaterThan(200);
});

test("a CLI dream loads the user's extensions and names its own o6y copy", () => {
  const { args, env: launched } = dreamInvocation("/store", ["--dry-run"], {});
  expect(args).not.toContain("-ne");
  expect(args[args.indexOf("-e") + 1]).toBe(launched.O6Y_EXTENSION!);
});

const seed = (id: string, content: string) => {
  mkdirSync(dirname(join(g, `${id}.md`)), { recursive: true });
  writeFileSync(join(g, `${id}.md`), content);
};
const titled = (summary: string, body = "Body.") => `---\nsummary: ${summary}\n---\n${body}\n`;

test("an analyzer's new object needs a reason, and a session creates only so many", async () => {
  const created = new Map<string, string>();
  const tools = storeTools(makeLayers(g), "pi:a", { maxNewObjects: 1, created });
  await expect(callTool(tools, "store_write", { target: "note/one", content: titled("First trap") })).rejects.toThrow("needs `reason`");
  await expect(callTool(tools, "store_cli", { args: ["new", "note/one", "--summary", "x"] })).rejects.toThrow("store_write");
  await callTool(tools, "store_write", { target: "note/one", content: titled("First trap"), reason: "  the flag is\nundocumented " });
  expect([...created]).toEqual([["note/one", "the flag is undocumented"]]);
  // Its own object can be rewritten; a second one can't be created.
  await callTool(tools, "store_write", { target: "note/one", content: titled("First trap", "Better.") });
  await expect(callTool(tools, "store_write", { target: "note/two", content: titled("Second"), reason: "r" })).rejects.toThrow("limit is 1");
  expect(existsSync(join(g, "note/two.md"))).toBe(false);
  // The organizer has no such limits.
  await callTool(storeTools(makeLayers(g)), "store_write", { target: "note/two", content: titled("Second") });
});

test("a new object that looks like an existing one is sent back once to check it", async () => {
  seed("note/review-bot-identity", titled("Review bot posts as the deploy account"));
  const tools = storeTools(makeLayers(g), "pi:a", { maxNewObjects: 2, created: new Map() });
  const write = () => callTool(tools, "store_write", { target: "note/review-bot", content: titled("Review bot, posts as the deploy account"), reason: "r" });
  await expect(write()).rejects.toThrow("note/review-bot-identity");
  expect(existsSync(join(g, "note/review-bot.md"))).toBe(false);
  await write();
  expect(existsSync(join(g, "note/review-bot.md"))).toBe(true);
});

test("an analyzer can't pile lines onto an existing object", async () => {
  seed("note/x", titled("X", "One."));
  const tools = storeTools(makeLayers(g), "pi:a", { maxAddedLines: 3 });
  const many = Array.from({ length: 6 }, (_, i) => `Line ${i}.`).join("\n");
  await expect(callTool(tools, "store_write", { target: "note/x", content: titled("X", many) })).rejects.toThrow("adds 5 lines");
  await callTool(tools, "store_edit", { target: "note/x", old_string: "One.", new_string: "One.\nTwo.\nThree." });
  // Counted from where the session started, not per call.
  await expect(callTool(tools, "store_edit", { target: "note/x", old_string: "Three.", new_string: "Three.\nFour.\nFive." })).rejects.toThrow("adds 4 lines");
});

test("a protected object is never changed, and what the dream wanted is kept for review", async () => {
  seed("runbook/dream-runs", titled("How to review dreams", "Step one."));
  seed("note/x", titled("X"));
  session("a", [user("1", null, "x")]);
  const prompts: string[] = [];
  const run = await runDream({
    ...options(async ({ prompt, tools }) => {
      prompts.push(prompt);
      await expect(callTool(tools, "store_edit", { target: "runbook/dream-runs", old_string: "Step one.", new_string: "Step zero." })).rejects.toThrow("protected");
      await expect(callTool(tools, "store_write", { target: "runbook/dream-runs", content: titled("Mine") })).rejects.toThrow("protected");
      await expect(callTool(tools, "store_cli", { args: ["rm", "runbook/dream-runs"] })).rejects.toThrow("protected");
      await expect(callTool(tools, "store_cli", { args: ["merge", "note/x", "runbook/dream-runs"] })).rejects.toThrow("protected");
      expect((await callTool(tools, "store_cli", { args: ["show", "runbook/dream-runs"] })).content[0].text).toContain("Step one.");
      return { text: "ok", cost: 0, tokens: 0 };
    }),
    settings: { ...DEFAULT_DREAM, protected: ["runbook/*"] },
  });
  expect(prompts[0]).toContain("Protected, read only: runbook/*");
  expect(readFileSync(join(g, "runbook/dream-runs.md"), "utf8")).toContain("Step one.");
  expect(run.proposals).toHaveLength(2);
  expect(run.proposals![0]).toEqual({ id: "runbook/dream-runs", session: "a", change: "replace:\nStep one.\nwith:\nStep zero." });
  expect(formatRun(run)).toContain("Needs review (2)");
  expect(plain(renderDreamPage(Store.load(makeLayers(g)), run, 80))).toContain("Needs review (2)");
});

test("a run lists new objects with their reasons and updates by size", async () => {
  seed("note/small", titled("Small", "one"));
  seed("note/big", `---\nsummary: Big\npinned: true\n---\none\n`);
  session("a", [user("1", null, "x")]);
  const run = await runDream(options(async ({ role, prompt, tools }) => {
    if (role === "organizer") {
      expect(prompt).toContain("- note/new: nobody documents the flag");
      return { text: "no changes needed", cost: 0, tokens: 0 };
    }
    await callTool(tools, "store_edit", { target: "note/small", old_string: "one", new_string: "two" });
    await callTool(tools, "store_edit", { target: "note/big", old_string: "one", new_string: "one\ntwo\nthree" });
    await callTool(tools, "store_write", { target: "note/new", content: titled("New"), reason: "nobody documents the flag" });
    return { text: "ok", cost: 0, tokens: 0 };
  }));
  expect(run.review!.created).toEqual([{ id: "note/new", lines: 4, reason: "nobody documents the flag" }]);
  expect(run.review!.updated).toEqual([
    { id: "note/big", added: 2, removed: 0, flags: ["pinned"] },
    { id: "note/small", added: 1, removed: 1, flags: [] },
  ]);
  const text = formatRun(run);
  expect(text).toContain("  + note/new (4 lines): nobody documents the flag");
  expect(text.indexOf("note/big +2 -0  [pinned]")).toBeLessThan(text.indexOf("note/small +1 -1"));
  expect(plain(renderDreamPage(Store.load(makeLayers(g)), run, 100))).toContain("note/new — nobody documents the flag");
});

test("a reviewed dream changes nothing until it is applied, and objects can be dropped first", async () => {
  seed("note/x", titled("X", "old"));
  session("a", [user("1", null, "x")]);
  const agent: AgentRunner = async ({ role, tools }) => {
    if (role === "analyzer") {
      await callTool(tools, "store_write", { target: "note/keep", content: titled("Keep"), reason: "r" });
      await callTool(tools, "store_write", { target: "note/weak", content: titled("Unrelated thing"), reason: "r" });
      await callTool(tools, "store_edit", { target: "note/x", old_string: "old", new_string: "new" });
    }
    return { text: "ok", cost: 0, tokens: 0 };
  };
  const run = await runDream({ ...options(agent), review: true });
  expect(run.status).toBe("staged");
  expect(run.changes.map((c) => c.action).sort()).toEqual(["create", "create", "update"]);
  expect(existsSync(join(g, "note/keep.md"))).toBe(false);
  expect(readLedger(dreamsDir(env)).sessions).toEqual({});
  expect(formatRun(run)).toContain("o6y dream apply");
  await expect(runDream(options(agent))).rejects.toThrow("staged for review");

  const layers = makeLayers(g);
  expect(() => dropStaged(env, layers, readRuns(env)[0]!, ["note/nope"], 15)).toThrow("doesn't change note/nope");
  dropStaged(env, layers, readRuns(env)[0]!, ["note/weak", "note/x"], 15);
  const staged = readRuns(env)[0]!;
  expect(staged.review!.created.map((c) => c.id)).toEqual(["note/keep"]);
  expect(staged.review!.updated).toEqual([]);

  const applied = applyRun(env, layers, staged);
  expect(applied.status).toBe("done");
  expect(existsSync(join(g, "note/keep.md"))).toBe(true);
  expect(existsSync(join(g, "note/weak.md"))).toBe(false);
  expect(readFileSync(join(g, "note/x.md"), "utf8")).toContain("old");
  expect(readFileSync(join(g, "log.md"), "utf8")).toContain("create note/keep (dream) [pi:a]");
  expect(readLedger(dreamsDir(env)).sessions.a!.leaf).toBe("1");
  expect(existsSync(run.staged!)).toBe(false);
  expect(readRuns(env)[0]!.status).toBe("done");
});

test("a discarded dream applies nothing; its sessions are read again only with retry", async () => {
  const agent = writer();
  session("a", [user("1", null, "x")]);
  await runDream({ ...options(agent), settings: { ...DEFAULT_DREAM, review: true } });
  expect(discardRun(env, readRuns(env)[0]!, true).status).toBe("discarded");
  expect(findUnprocessed(options(agent))).toHaveLength(1);
  await runDream({ ...options(agent), review: true });
  discardRun(env, readRuns(env)[0]!, false);
  expect(findUnprocessed(options(agent))).toHaveLength(0);
  expect(existsSync(join(g, "note/from-1.md"))).toBe(false);
});

test("o6y dream show, drop, apply and discard review a staged dream", async () => {
  session("a", [user("1", null, "x")]);
  await runDream({ ...options(writer()), review: true });
  const cli = async (...args: string[]) => {
    const out: string[] = [];
    const code = await main(args, { cwd: tmp, env: { ...env, O6Y_HOME: g }, out: (t) => out.push(t), err: (t) => out.push(t), stdin: () => undefined, isTTY: false });
    return { code, text: out.join("\n") };
  };
  expect((await cli("dream")).text).toContain("staged for review");
  expect((await cli("dream", "show")).text).toContain("+ note/from-1 (5 lines): outlasts the PR");
  expect((await cli("dream", "drop", "note/zzz")).code).toBe(1);
  expect((await cli("dream", "apply")).text).toContain("o6y dream done");
  expect(existsSync(join(g, "note/from-1.md"))).toBe(true);
  expect((await cli("dream", "apply")).text).toContain("no dream is staged");
});

test("the limits and review settings are parsed", () => {
  const { schema, errors } = parseRootSchema("---\ndream:\n  maxNewObjects: 1\n  maxAddedLines: 0\n  protected: [runbook/o6y-dream-runs, person/*]\n  review: true\n---\n");
  expect(errors).toEqual([]);
  expect(schema!.dream).toEqual({ maxNewObjects: 1, maxAddedLines: 0, protected: ["runbook/o6y-dream-runs", "person/*"], review: true });
  expect(parseRootSchema("---\ndream:\n  protected: [nope]\n---\n").errors[0]).toContain("type/slug");
  expect(parseRootSchema("---\ndream:\n  maxNewObjects: -1\n---\n").errors[0]).toContain("0 or more");
});
