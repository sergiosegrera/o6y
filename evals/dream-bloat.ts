/**
 * Does a dream store what a future agent couldn't look up, and only that? Each case is one made-up
 * session:
 *   lookup        a config file and a tool's help around one trap and one decision
 *   chatter       only lookups; change nothing
 *   pr-bound      a bug in our own code, fixed by an open pull request; change nothing
 *   inferred      a cause the agent guessed and couldn't confirm; change nothing
 *   overlap       a reviewer's habit, when memory already describes that reviewer; update, don't create
 *   measurements  one lasting trap among pixel offsets, timings and capture paths
 *
 *   bun evals/dream-bloat.ts [--case NAME] [--model provider/id] [--keep]
 *
 * Needs pi and a key for the model. Works in a temp directory, on a made-up session.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { bootstrap } from "../src/core/fsops.ts";
import { makeLayers, SCHEMA_FILE, Store } from "../src/core/store.ts";
import { dreamInvocation } from "../src/dream/launch.ts";

const { values: o } = parseArgs({ options: { case: { type: "string", default: "lookup" }, model: { type: "string", default: "openrouter/deepseek/deepseek-v4.1-flash-1017" }, keep: { type: "boolean" } } });

/** Readable with `cat` or `--help`, so none of it should be copied into memory. */
const LOOKUPS = ["4.18.2", "schema.acme.dev", "team_8f3a21", "deploy_events", "eu-west-3", "2400"];
const BUDGET = { newObjects: 2, linesPerObject: 25, addedChars: 2500 };

const CONFIG = `# ~/.acme/settings.toml
$schema = "https://schema.acme.dev/v7/settings.json"
team_id = "team_8f3a21"
region = "eu-west-3"
timeout_ms = 2400
retries = 0
history_table = "deploy_events"
mode = "sync"`;

let n = 0;
let parent: string | null = null;
function entry(message: unknown) {
  const id = `e${++n}`;
  const out = { type: "message", id, parentId: parent, timestamp: "2026-11-01T00:00:01.000Z", message };
  parent = id;
  return out;
}
const say = (text: string) => entry({ role: "assistant", content: [{ type: "text", text }] });
function run(command: string, output: string) {
  return [entry({ role: "assistant", content: [{ type: "toolCall", id: `c${n}`, name: "bash", arguments: { command } }] }), entry({ role: "toolResult", toolCallId: `c${n - 1}`, toolName: "bash", content: [{ type: "text", text: output }] })];
}

const root = mkdtempSync(join(tmpdir(), "o6y-dream-eval-"));
const store = join(root, "store");
const sessions = join(root, "sessions");
mkdirSync(sessions);
bootstrap(store);

const schemaPath = join(store, SCHEMA_FILE);
const schema = readFileSync(schemaPath, "utf8").replace("---\n", `---\ndream:\n  model: ${o.model}\n  thinking: low\n`);
writeFileSync(schemaPath, `${schema.trimEnd()}\n\nThe repo wins: never store what a file or a command already answers. Keep the reason and the gotcha. Every new object links to the system/ object it is about.\n`);
mkdirSync(join(store, "system"));
writeFileSync(join(store, "system", SCHEMA_FILE), "---\ndescription: A system or tool we use\n---\n");
writeFileSync(join(store, "system", "acme.md"), "---\nsummary: Acme, the CLI that deploys our services\n---\nAcme deploys our services.\n");

const HEADER = { type: "session", version: 3, id: "eval-session", timestamp: "2026-11-01T00:00:00.000Z", cwd: root };
const ask = (content: string) => entry({ role: "user", content });
const BOT = "note/acme-reviewer-bot";

interface Result {
  all: string;
  written: string[];
  created: string[];
  longest: number;
  added: number;
  text: (id: string) => string;
}
interface Case {
  /** Objects in the store before the dream. */
  seed?: Record<string, string>;
  session: () => unknown[];
  checks: (r: Result) => Record<string, boolean>;
}

const nothing = (r: Result) => ({ "changes nothing": r.written.length === 0 });

const CASES: Record<string, Case> = {
  /** Only lookups: nothing to keep. */
  chatter: {
    session: () => [
      ask("What region is acme deploying to, and which version do I have?"),
      ...run("cat ~/.acme/settings.toml", CONFIG),
      ...run("acme --version", "acme 4.18.2"),
      say("You are deploying to eu-west-3 with acme 4.18.2."),
      ask("Thanks."),
    ],
    checks: nothing,
  },
  /** Lookup data around one trap and one decision. */
  lookup: {
    session: () => [
      ask("Deploys with acme keep retrying even though I set retries to 0. Can you find out why and fix it? Should we also move to webhook mode?"),
      ...run("cat ~/.acme/settings.toml", CONFIG),
      ...run("acme --version && acme deploy --help", "acme 4.18.2\nUsage: acme deploy [--region R] [--timeout-ms N] [--retries N] [--mode sync|webhook]\nHistory is kept in the deploy_events table."),
      ...run("acme deploy --dry-run", "resolved retries=3 (default)\nFound 226 warnings and 10 errors in the manifest"),
      say("The config says retries = 0, but acme resolved 3. Trying strict mode."),
      ...run("ACME_STRICT=1 acme deploy --dry-run", "resolved retries=0 (settings.toml)\nFound 226 warnings and 10 errors in the manifest"),
      say("Confirmed: without ACME_STRICT=1, acme treats a 0 in settings.toml as unset and falls back to 3 retries."),
      ask("Great. And no webhook mode: we tried it in March and the queue dropped events under load, so we are staying on sync."),
      say("Understood, staying on sync mode. Done."),
    ],
    checks: (r) => {
      const copied = LOOKUPS.filter((v) => r.all.includes(v));
      return {
        "keeps the trap (ACME_STRICT)": r.all.includes("ACME_STRICT"),
        "keeps the decision and why (webhook)": /webhook/i.test(r.all) && /drop|lost/i.test(r.all),
        [`copies no lookup values${copied.length ? ` (copied ${copied.join(", ")})` : ""}`]: copied.length === 0,
        [`at most ${BUDGET.newObjects} new objects`]: r.created.length <= BUDGET.newObjects,
        [`no object over ${BUDGET.linesPerObject} lines`]: r.longest <= BUDGET.linesPerObject,
        [`under ${BUDGET.addedChars} chars added`]: r.added <= BUDGET.addedChars,
        "new objects link to system/acme": r.created.length > 0 && r.created.every((id) => r.text(id).includes("system/acme")),
      };
    },
  },
  /** A bug in our own code, fixed by a pull request that is still open: the fix lives in the repo. */
  "pr-bound": {
    session: () => [
      ask("The deploy status panel overflows its card below 600px. Can you fix it?"),
      ...run("grep -n min-width web/panel.css", "14:.status-panel { min-width: 480px; }"),
      say("The panel has a fixed min-width of 480px, so it can't shrink inside the card."),
      ...run("sed -i 's/min-width: 480px/min-width: 0/' web/panel.css && bun test web", "12 pass\n0 fail"),
      ...run("git switch -c fix/status-panel-overflow && git commit -qam 'Let the status panel shrink' && gh pr create --fill", "https://github.com/acme/web/pull/212"),
      say("Fixed in PR #212: the panel no longer forces a 480px minimum. It is open for review; I have not checked whether origin/main has other changes to this file."),
      ask("Thanks, I'll review it."),
    ],
    checks: nothing,
  },
  /** A cause nobody confirmed: the agent says so itself. */
  inferred: {
    session: () => [
      ask("Deploys with acme were slow this morning. Any idea why?"),
      ...run("acme deploy --dry-run --timing", "resolve 0.4s\npush 1.1s\ntotal 1.5s"),
      ...run("acme logs --since 6h | grep -i slow", "(no output)"),
      say("It is fast now and the logs show nothing. My guess is the registry mirror was throttling pushes this morning, but I could not reproduce it and nothing confirms it."),
      ask("OK, leave it then."),
    ],
    checks: nothing,
  },
  /** New habits of a reviewer memory already describes, under another type: add there, don't create a person. */
  overlap: {
    seed: { [BOT]: "---\nsummary: acme-reviewer is a bot that reviews pull requests as the deploy account\nrelated: [system/acme]\n---\nacme-reviewer is a bot, not a person: it posts its reviews as the deploy account, so replies to it reach nobody.\n" },
    session: () => [
      ask("acme-reviewer left comments on PR 88 and PR 91. What does it want?"),
      ...run("gh pr view 88 --comments", "acme-reviewer: This migration has no test. Every migration needs one before I approve."),
      ...run("gh pr view 91 --comments", "acme-reviewer: This migration has no test. Every migration needs one before I approve."),
      say("On both PRs the acme-reviewer bot blocks approval until the migration has a test. I added tests to both and it approved."),
      ask("Good to know, it always does that."),
    ],
    checks: (r) => ({
      "creates no new object": r.created.length === 0,
      "adds the habit to the existing object": r.written.includes(BOT) && /migration/i.test(r.text(BOT)),
      "keeps what was there": r.text(BOT).includes("deploy account"),
      "stays under 12 lines": r.text(BOT).split("\n").length <= 12,
    }),
  },
  /** One lasting trap inside a session full of pixel offsets, timings and capture paths. */
  measurements: {
    session: () => [
      ask("Clicks land in the wrong place when I drive the app from acme snap screenshots. Find out why."),
      ...run("acme snap --out /tmp/captures/zoom-01.png && acme click 412 388", "clicked (412, 388); expected button at (206, 194); miss by 206px, 194px; 37ms"),
      ...run("acme snap --out /tmp/captures/zoom-02.png && acme click 300 120", "clicked (300, 120); expected link at (150, 60); miss by 150px, 60px; 41ms"),
      ...run("acme snap --info", "scale: 2 (device pixels)\nsize: 2880x1800"),
      say("Every miss is exactly double. acme snap captures in device pixels at scale 2, while acme click takes CSS pixels."),
      ...run("ACME_SNAP_SCALE=1 acme snap --out /tmp/captures/zoom-03.png && acme click 206 194", "clicked (206, 194); hit; 39ms"),
      say("Confirmed: with ACME_SNAP_SCALE=1 the screenshot is in CSS pixels and clicks land. Without it, halve every coordinate read from a screenshot. `acme snap --info` shows the scale."),
      ask("Great, that explains it."),
    ],
    checks: (r) => {
      const noise = ["zoom-0", "/tmp/captures", "412", "388", "37ms", "41ms", "2880"].filter((v) => r.all.includes(v));
      return {
        "keeps the trap (ACME_SNAP_SCALE)": r.all.includes("ACME_SNAP_SCALE"),
        [`keeps no measurements or capture paths${noise.length ? ` (kept ${noise.join(", ")})` : ""}`]: noise.length === 0,
        "at most 1 new object": r.created.length <= 1,
        "no object over 15 lines": r.longest <= 15,
      };
    },
  },
};

const chosen = CASES[o.case!];
if (!chosen) {
  console.error(`no case \`${o.case}\`; choose from: ${Object.keys(CASES).join(", ")}`);
  process.exit(2);
}
for (const [id, content] of Object.entries(chosen.seed ?? {})) {
  mkdirSync(join(store, id.split("/")[0]!), { recursive: true });
  writeFileSync(join(store, `${id}.md`), content);
}
const lines = [HEADER, ...chosen.session()];
writeFileSync(join(sessions, "eval-session.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

const before = new Map([...Store.load(makeLayers(store)).objects].map(([id, obj]) => [id, readFileSync(obj.path, "utf8").length]));
const base = { ...process.env, O6Y_HOME: store, O6Y_CACHE: join(root, "cache"), PI_CODING_AGENT_SESSION_DIR: sessions };
const { args, env } = dreamInvocation(store, [], base);
const res = spawnSync("pi", args, { env: env as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", cwd: root });
if (res.status) console.error(res.stderr);

const after = Store.load(makeLayers(store));
const written = [...after.objects].filter(([id, obj]) => readFileSync(obj.path, "utf8").length !== before.get(id));
const texts = new Map(written.map(([id, obj]) => [id, readFileSync(obj.path, "utf8")]));
const result: Result = {
  all: [...texts.values()].join("\n"),
  written: [...texts.keys()],
  created: [...texts.keys()].filter((id) => !before.has(id)),
  longest: Math.max(0, ...[...texts.values()].map((t) => t.split("\n").length)),
  added: [...texts].reduce((sum, [id, t]) => sum + t.length - (before.get(id) ?? 0), 0),
  text: (id) => (after.objects.has(id) ? readFileSync(after.objects.get(id)!.path, "utf8") : ""),
};

const checks = chosen.checks(result);
const failed = Object.values(checks).filter((ok) => !ok).length;
for (const [name, ok] of Object.entries(checks)) console.log(`${ok ? "pass" : "FAIL"}  ${name}`);
console.log(`new ${result.created.length} [${result.created.join(", ")}]  changed ${result.written.length}  added ${result.added} chars  longest ${result.longest} lines`);
if (o.keep) console.log(root);
else rmSync(root, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
