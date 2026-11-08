/**
 * Does a dream store what a future agent couldn't look up, and only that? One session reads a
 * config file and a tool's help (lookup data), finds one trap and records one decision. The
 * `chatter` case is only lookups, so the right result is changing nothing.
 *
 *   bun evals/dream-bloat.ts [--case lookup|chatter] [--model provider/id] [--keep]
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

const chatter = o.case === "chatter";
const lines = chatter ? [
  { type: "session", version: 3, id: "eval-session", timestamp: "2026-11-01T00:00:00.000Z", cwd: root },
  entry({ role: "user", content: "What region is acme deploying to, and which version do I have?" }),
  ...run("cat ~/.acme/settings.toml", CONFIG),
  ...run("acme --version", "acme 4.18.2"),
  say("You are deploying to eu-west-3 with acme 4.18.2."),
  entry({ role: "user", content: "Thanks." }),
] : [
  { type: "session", version: 3, id: "eval-session", timestamp: "2026-11-01T00:00:00.000Z", cwd: root },
  entry({ role: "user", content: "Deploys with acme keep retrying even though I set retries to 0. Can you find out why and fix it? Should we also move to webhook mode?" }),
  ...run("cat ~/.acme/settings.toml", CONFIG),
  ...run("acme --version && acme deploy --help", "acme 4.18.2\nUsage: acme deploy [--region R] [--timeout-ms N] [--retries N] [--mode sync|webhook]\nHistory is kept in the deploy_events table."),
  ...run("acme deploy --dry-run", "resolved retries=3 (default)\nFound 226 warnings and 10 errors in the manifest"),
  say("The config says retries = 0, but acme resolved 3. Trying strict mode."),
  ...run("ACME_STRICT=1 acme deploy --dry-run", "resolved retries=0 (settings.toml)\nFound 226 warnings and 10 errors in the manifest"),
  say("Confirmed: without ACME_STRICT=1, acme treats a 0 in settings.toml as unset and falls back to 3 retries."),
  entry({ role: "user", content: "Great. And no webhook mode: we tried it in March and the queue dropped events under load, so we are staying on sync." }),
  say("Understood, staying on sync mode. Done."),
];
writeFileSync(join(sessions, "eval-session.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

const before = new Map([...Store.load(makeLayers(store)).objects].map(([id, obj]) => [id, readFileSync(obj.path, "utf8").length]));
const base = { ...process.env, O6Y_HOME: store, O6Y_CACHE: join(root, "cache"), PI_CODING_AGENT_SESSION_DIR: sessions };
const { args, env } = dreamInvocation(store, [], base);
const res = spawnSync("pi", args, { env: env as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", cwd: root });
if (res.status) console.error(res.stderr);

const after = Store.load(makeLayers(store));
const written = [...after.objects].filter(([id, obj]) => readFileSync(obj.path, "utf8").length !== before.get(id));
const created = written.filter(([id]) => !before.has(id));
const texts = written.map(([id, obj]) => ({ id, text: readFileSync(obj.path, "utf8") }));
const all = texts.map((t) => t.text).join("\n");
const added = texts.reduce((sum, t) => sum + t.text.length - (before.get(t.id) ?? 0), 0);
const copied = LOOKUPS.filter((v) => all.includes(v));
const longest = Math.max(0, ...texts.map((t) => t.text.split("\n").length));

const checks: Record<string, boolean> = chatter ? { "changes nothing": written.length === 0 } : {
  "keeps the trap (ACME_STRICT)": all.includes("ACME_STRICT"),
  "keeps the decision and why (webhook)": /webhook/i.test(all) && /drop|lost/i.test(all),
  "copies no lookup values": copied.length === 0,
  [`at most ${BUDGET.newObjects} new objects`]: created.length <= BUDGET.newObjects,
  [`no object over ${BUDGET.linesPerObject} lines`]: longest <= BUDGET.linesPerObject,
  [`under ${BUDGET.addedChars} chars added`]: added <= BUDGET.addedChars,
  "new objects link to system/acme": created.length > 0 && created.every(([id]) => texts.find((t) => t.id === id)!.text.includes("system/acme")),
};
const failed = Object.values(checks).filter((ok) => !ok).length;
for (const [name, ok] of Object.entries(checks)) console.log(`${ok ? "pass" : "FAIL"}  ${name}`);
console.log(`new ${created.length} [${created.map(([id]) => id).join(", ")}]  changed ${written.length}  added ${added} chars  longest ${longest} lines  copied [${copied.join(", ")}]`);
if (o.keep) console.log(root);
else rmSync(root, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
