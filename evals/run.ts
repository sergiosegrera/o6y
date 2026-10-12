/**
 * o6y eval runner: drives real pi sessions against fixture stores and scores the outcome.
 *
 *   bun evals/run.ts [--model provider/id] [--repeat N] [--concurrency N] [--filter text]
 *                    [--label name] [--compare evals/results/<file>.json] [--keep]
 *
 * Each case runs `--repeat` times in a fresh temp dir. Results go to evals/results/.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { makeLayers, Store } from "../src/core/store.ts";
import { type EvalCase, rejections, type Run, type ToolCall } from "./lib.ts";

const ROOT = resolve(import.meta.dir, "..");
const { values: args } = parseArgs({
  options: {
    model: { type: "string", default: "openrouter/z-ai/glm-5.3-flash" },
    repeat: { type: "string", default: "1" },
    concurrency: { type: "string", default: "4" },
    filter: { type: "string" },
    label: { type: "string", default: "run" },
    compare: { type: "string" },
    keep: { type: "boolean", default: false },
    timeout: { type: "string", default: "300" },
  },
});

interface CheckResult {
  label: string;
  pass: boolean;
  detail?: string;
}

interface Trial {
  case: string;
  trial: number;
  pass: boolean;
  checks: CheckResult[];
  rejections: number;
  toolCalls: number;
  tokens: number;
  cost: number;
  seconds: number;
  failed?: string;
  dir?: string;
}

async function loadCases(): Promise<EvalCase[]> {
  const dir = join(import.meta.dir, "cases");
  const cases: EvalCase[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts")).sort()) {
    const c = (await import(join(dir, file))).default as EvalCase;
    if (!args.filter || c.name.includes(args.filter)) cases.push(c);
  }
  return cases;
}

function parseTranscript(jsonl: string, prompt: string, seconds: number): Run {
  const calls = new Map<string, ToolCall>();
  const order: string[] = [];
  let answer = "";
  let tokens = 0;
  let cost = 0;
  let failed: string | undefined;
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.type !== "message_end") continue;
    const m = ev.message;
    if (m.role === "assistant") {
      tokens += m.usage?.totalTokens ?? 0;
      cost += m.usage?.cost?.total ?? 0;
      if (m.stopReason === "error") failed = m.errorMessage ?? "provider error";
      const text = (m.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n").trim();
      if (text) answer = text;
      for (const c of m.content ?? []) {
        if (c.type !== "toolCall") continue;
        calls.set(c.id, { name: c.name, args: c.arguments ?? {}, result: "", isError: false });
        order.push(c.id);
      }
    } else if (m.role === "toolResult") {
      const call = calls.get(m.toolCallId);
      if (call) {
        call.result = (m.content ?? []).map((c: any) => c.text ?? "").join("\n");
        call.isError = m.isError === true;
      }
    }
  }
  if (!jsonl.trim()) failed = "empty transcript";
  return { prompt, toolCalls: order.map((id) => calls.get(id)!), answer, tokens, cost, seconds, failed };
}

async function runPi(prompt: string, cwd: string, globalRoot: string): Promise<Run> {
  const cmd = [
    process.env.PI_BIN ?? "pi",
    "--no-session", "--mode", "json",
    "-ne", "-nc", "--no-skills", // isolate from the user's extensions, context files and skills
    "-e", join(ROOT, "src", "extension.ts"),
    "--model", args.model!,
    "-p", prompt,
  ];
  // pi occasionally exits with an empty transcript on a first run in a fresh directory; retry.
  for (let attempt = 1; ; attempt++) {
    const started = performance.now();
    const proc = Bun.spawn(cmd, {
      cwd,
      env: { ...process.env, O6Y_HOME: globalRoot, O6Y_PROJECT: join(cwd, ".agents", "o6y") },
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => proc.kill(), Number(args.timeout) * 1000);
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    clearTimeout(timer);
    const run = parseTranscript(out, prompt, (performance.now() - started) / 1000);
    if (run.failed !== "empty transcript" || attempt >= 3) return run;
  }
}

async function runTrial(c: EvalCase, trial: number): Promise<Trial> {
  const dir = mkdtempSync(join(tmpdir(), `o6y-eval-${c.name}-`));
  const globalRoot = join(dir, "global");
  const cwd = join(dir, "proj");
  mkdirSync(cwd, { recursive: true });
  if (c.fixture) {
    const fixture = join(import.meta.dir, "fixtures", c.fixture);
    if (existsSync(join(fixture, "global"))) cpSync(join(fixture, "global"), globalRoot, { recursive: true });
    if (existsSync(join(fixture, "project"))) cpSync(join(fixture, "project"), join(cwd, ".agents", "o6y"), { recursive: true });
  }
  for (const [rel, content] of Object.entries(c.files ?? {})) {
    const path = rel.startsWith("project/") ? join(cwd, ".agents", "o6y", rel.slice(8)) : join(globalRoot, rel.replace(/^global\//, ""));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }

  const runs: Run[] = [];
  for (const prompt of c.steps) {
    const run = await runPi(prompt, cwd, globalRoot);
    runs.push(run);
    if (run.failed) break;
  }
  const store = Store.load(makeLayers(globalRoot, join(cwd, ".agents", "o6y")));
  const failed = runs.find((r) => r.failed)?.failed;
  const checks: CheckResult[] = c.checks.map((check) => {
    if (failed) return { label: check.label, pass: false, detail: `run failed: ${failed}` };
    try {
      const result = check.test({ store, runs, roots: { global: globalRoot, project: join(cwd, ".agents", "o6y") } });
      return result === true ? { label: check.label, pass: true } : { label: check.label, pass: false, detail: String(result) };
    } catch (err) {
      return { label: check.label, pass: false, detail: `check threw: ${err}` };
    }
  });
  if (!args.keep) rmSync(dir, { recursive: true, force: true });
  const sum = (f: (r: Run) => number) => runs.reduce((n, r) => n + f(r), 0);
  return {
    case: c.name,
    trial,
    pass: checks.every((ch) => ch.pass),
    checks,
    rejections: rejections(runs),
    toolCalls: sum((r) => r.toolCalls.length),
    tokens: sum((r) => r.tokens),
    cost: sum((r) => r.cost),
    seconds: sum((r) => r.seconds),
    failed,
    dir: args.keep ? dir : undefined,
  };
}

async function pool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]!);
      }
    }),
  );
  return results;
}

interface CaseSummary {
  case: string;
  passRate: number;
  checkRate: number;
  rejections: number;
  toolCalls: number;
  tokens: number;
  cost: number;
  seconds: number;
}

function summarize(trials: Trial[]): CaseSummary[] {
  const byCase = new Map<string, Trial[]>();
  for (const t of trials) byCase.set(t.case, [...(byCase.get(t.case) ?? []), t]);
  const avg = (ts: Trial[], f: (t: Trial) => number) => ts.reduce((n, t) => n + f(t), 0) / ts.length;
  return [...byCase].map(([name, ts]) => ({
    case: name,
    passRate: avg(ts, (t) => (t.pass ? 1 : 0)),
    checkRate: avg(ts, (t) => t.checks.filter((c) => c.pass).length / Math.max(1, t.checks.length)),
    rejections: avg(ts, (t) => t.rejections),
    toolCalls: avg(ts, (t) => t.toolCalls),
    tokens: avg(ts, (t) => t.tokens),
    cost: avg(ts, (t) => t.cost),
    seconds: avg(ts, (t) => t.seconds),
  }));
}

function delta(now: number, before: number | undefined, digits: number): string {
  if (before === undefined) return "";
  const d = now - before;
  if (Math.abs(d) < 10 ** -digits / 2) return "";
  return ` (${d > 0 ? "+" : ""}${d.toFixed(digits)})`;
}

function report(summary: CaseSummary[], trials: Trial[], baseline?: CaseSummary[]): string {
  const base = new Map(baseline?.map((s) => [s.case, s]));
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const rows = summary.map((s) => {
    const b = base.get(s.case);
    return [
      s.case,
      pct(s.passRate) + (b ? delta(s.passRate * 100, b.passRate * 100, 0) : ""),
      pct(s.checkRate) + (b ? delta(s.checkRate * 100, b.checkRate * 100, 0) : ""),
      s.rejections.toFixed(1) + delta(s.rejections, b?.rejections, 1),
      s.toolCalls.toFixed(1) + delta(s.toolCalls, b?.toolCalls, 1),
      Math.round(s.tokens / 1000) + "k",
      "$" + s.cost.toFixed(4),
      s.seconds.toFixed(0) + "s",
    ];
  });
  const all = (f: (s: CaseSummary) => number) => summary.reduce((n, s) => n + f(s), 0) / summary.length;
  rows.push([
    "OVERALL",
    pct(all((s) => s.passRate)),
    pct(all((s) => s.checkRate)),
    all((s) => s.rejections).toFixed(1),
    all((s) => s.toolCalls).toFixed(1),
    Math.round(all((s) => s.tokens) / 1000) + "k",
    "$" + summary.reduce((n, s) => n + s.cost, 0).toFixed(4) + " total",
    "",
  ]);
  const header = ["case", "pass", "checks", "rejected", "tools", "tokens", "cost", "time"];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const fmt = (r: string[]) => r.map((c, i) => c.padEnd(widths[i]!)).join("  ");
  const lines = [fmt(header), widths.map((w) => "-".repeat(w)).join("  "), ...rows.map(fmt)];
  const failures = trials.flatMap((t) =>
    t.checks.filter((c) => !c.pass).map((c) => `  ${t.case}#${t.trial}: ${c.label} — ${c.detail ?? ""}`),
  );
  if (failures.length) lines.push("", "Failed checks:", ...failures);
  return lines.join("\n");
}

const cases = await loadCases();
const repeat = Number(args.repeat);
const jobs = cases.flatMap((c) => Array.from({ length: repeat }, (_, i) => ({ c, trial: i + 1 })));
console.log(`o6y evals: ${cases.length} cases × ${repeat} trials on ${args.model}`);
let done = 0;
const trials = await pool(jobs, Number(args.concurrency), async ({ c, trial }) => {
  const t = await runTrial(c, trial);
  console.log(`[${++done}/${jobs.length}] ${t.pass ? "PASS" : "FAIL"} ${c.name}#${trial}${t.failed ? ` (${t.failed})` : ""}`);
  return t;
});

const summary = summarize(trials);
const baseline = args.compare ? ((await Bun.file(args.compare).json()) as { summary: CaseSummary[] }).summary : undefined;
console.log("\n" + report(summary, trials, baseline));

const resultsDir = join(import.meta.dir, "results");
mkdirSync(resultsDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const out = join(resultsDir, `${stamp}-${args.label}.json`);
writeFileSync(out, JSON.stringify({ model: args.model, repeat, label: args.label, summary, trials }, null, 2));
console.log(`\nSaved ${out}`);
