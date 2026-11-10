/** What can be known about dreams without running one. Free of pi imports, so the CLI bundle can use it. */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalPath } from "../core/store.ts";
import { dreamRunning, dreamsDir, pidAlive, readLedger } from "./state.ts";
import { listTranscripts, type PendingTranscript, pendingPart, sessionsRoot } from "./transcript.ts";

export interface DreamRun {
  id: string;
  /** `staged`: finished and waiting for `o6y dream apply` or `discard`; nothing in the store has changed. */
  status: "running" | "nothing" | "dry-run" | "staged" | "done" | "partial" | "discarded" | "aborted" | "failed";
  startedAt: string;
  finishedAt?: string;
  models: { analyzer: string; organizer: string };
  unprocessed: number;
  /** While running: the process doing it, how many sessions it will read, and the current step. */
  pid?: number;
  planned?: number;
  step?: string;
  sessions: { id: string; file: string; cwd: string; ok: boolean; summary: string }[];
  organizer?: { ok: boolean; summary: string };
  changes: { action: string; path: string }[];
  conflicts: string[];
  /** Why the result could not be applied. */
  error?: string;
  cost: number;
  tokens: number;
  snapshot?: string;
  /** What to look at when reviewing: new objects with the analyzer's reason, and updates by size. */
  review?: Review;
  /** Changes the dream wanted to make to protected objects; none were made. */
  proposals?: { id: string; session?: string; change: string }[];
  /** A staged dream: the copy holding its result, and the last entry read per session, recorded once applied. */
  staged?: string;
  leaves?: Record<string, string>;
}

export interface Review {
  created: { id: string; lines: number; reason: string }[];
  /** Largest first. `flags` name what deserves a look: a pinned object, or many added lines. */
  updated: { id: string; added: number; removed: number; flags: string[] }[];
  deleted: string[];
}

/** The run to apply, discard or show: the one named (by id or prefix), else the staged one, else the latest. */
export function findRun(env: Record<string, string | undefined>, id?: string, staged = false): DreamRun {
  const runs = readRuns(env);
  const run = id ? runs.find((r) => r.id === id) ?? runs.find((r) => r.id.startsWith(id)) : staged ? runs.find((r) => r.status === "staged") : runs.find((r) => r.status !== "running");
  if (!run) throw new Error(id ? `no dream \`${id}\`` : staged ? "no dream is staged for review" : "no dreams yet");
  if (staged && run.status !== "staged") throw new Error(`dream ${run.id} is ${run.status}, not staged`);
  return run;
}

/** A dream as a list to skim: what is new and why, then updates by size, then everything else. */
export function formatRun(run: DreamRun): string {
  if (run.status === "nothing") return "o6y dream: no unprocessed sessions.";
  if (run.status === "dry-run") return `o6y dream: ${run.unprocessed} unprocessed session(s); this run would process ${run.sessions.length}.`;
  const failed = run.sessions.filter((s) => !s.ok);
  const lines = [`o6y dream ${run.status}: ${run.sessions.length - failed.length}/${run.sessions.length} session(s), ${run.changes.length} change(s), $${run.cost.toFixed(4)}, ${run.tokens} tokens`];
  const r = run.review;
  const listed: string[] = [];
  if (r) {
    for (const id of [...r.created.map((c) => c.id), ...r.updated.map((u) => u.id), ...r.deleted]) listed.push(`/${id}.md`);
    if (r.created.length) lines.push(`New (${r.created.length}):`, ...r.created.map((c) => `  + ${c.id} (${c.lines} lines): ${c.reason || "no reason given"}`));
    if (r.updated.length) lines.push(`Updated (${r.updated.length}), largest first:`, ...r.updated.map((u) => `  ~ ${u.id} +${u.added} -${u.removed}${u.flags.length ? `  [${u.flags.join(", ")}]` : ""}`));
    if (r.deleted.length) lines.push(`Deleted (${r.deleted.length}):`, ...r.deleted.map((id) => `  - ${id}`));
  }
  const other = run.changes.filter((c) => !listed.some((rel) => c.path.endsWith(rel)));
  if (other.length) lines.push(...(r ? ["Other files:"] : []), ...other.map((c) => `  ${c.action} ${c.path}`));
  if (run.proposals?.length) {
    lines.push(`Needs review (${run.proposals.length}): protected objects the dream wanted to change, and didn't:`);
    for (const p of run.proposals) lines.push(`  ${p.id}${p.session ? ` (session ${p.session})` : ""}`, ...p.change.split("\n").map((l) => `    ${l}`));
  }
  lines.push(...run.conflicts.map((path) => `  kept live version (edited during the dream): ${path}`));
  if (run.error) lines.push(`  not applied: ${run.error}`);
  lines.push(...failed.map((s) => `  ${s.id}: ${s.summary}`));
  if (run.status === "staged") {
    lines.push(
      "Nothing has changed in the store yet. Compare the two copies, edit the staged one if you like, then:",
      `  before: ${run.snapshot}`,
      `  staged: ${run.staged}`,
      "  o6y dream drop ID...   take an object's change out",
      "  o6y dream apply        apply what is left",
      "  o6y dream discard      apply nothing (--retry to read the sessions again next time)",
    );
  } else if (run.snapshot) lines.push(`Store before this dream: ${run.snapshot}`);
  return lines.join("\n");
}

/** `--since`: `30d`, `2w` or `YYYY-MM-DD` as the ISO time to start from; undefined if malformed. */
export function parseSince(value: string, now: Date): string | undefined {
  const age = /^([1-9]\d*)([dw])$/.exec(value);
  if (age) return new Date(now.getTime() - Number(age[1]) * (age[2] === "w" ? 7 : 1) * 86_400_000).toISOString();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** The named sessions (by id or unique id prefix) in full, whether or not a dream has read them. */
function forcedSessions(sessionsDir: string, wanted: string[], exclude?: string): PendingTranscript[] {
  const all = listTranscripts(sessionsDir);
  const chosen = new Set<PendingTranscript["transcript"]>();
  for (const id of wanted) {
    const matches = all.filter((t) => t.id === id).length ? all.filter((t) => t.id === id) : all.filter((t) => t.id.startsWith(id));
    if (!matches.length) throw new Error(`no session matches \`${id}\``);
    if (matches.length > 1) throw new Error(`\`${id}\` matches ${matches.length} sessions; use more of the id`);
    if (matches[0]!.id === exclude) throw new Error(`\`${id}\` is the running session, which is still being written`);
    chosen.add(matches[0]!);
  }
  return all.filter((t) => chosen.has(t)).map((t) => {
    const part = pendingPart(t, undefined);
    if (!part) throw new Error(`session ${t.id} has no user messages to read`);
    return part;
  });
}

export function findUnprocessed(opts: { env: Record<string, string | undefined>; sessionsDir: string; excludeSession?: string; here?: boolean; cwd: string; since?: string; sessions?: string[] }): PendingTranscript[] {
  if (opts.sessions?.length) return forcedSessions(opts.sessionsDir, opts.sessions, opts.excludeSession);
  const ledger = readLedger(dreamsDir(opts.env));
  const out: PendingTranscript[] = [];
  for (const transcript of listTranscripts(opts.sessionsDir)) {
    if (transcript.id === opts.excludeSession) continue;
    if (opts.here && canonicalPath(transcript.cwd) !== canonicalPath(opts.cwd)) continue;
    if (opts.since && transcript.startedAt < opts.since) continue;
    const part = pendingPart(transcript, ledger.sessions[transcript.id]?.leaf);
    if (part) out.push(part);
  }
  return out;
}

/** Recorded dreams, newest first. */
export function readRuns(env: Record<string, string | undefined>): DreamRun[] {
  const root = join(dreamsDir(env), "runs");
  let ids: string[];
  try {
    ids = readdirSync(root);
  } catch {
    return [];
  }
  const runs: DreamRun[] = [];
  for (const id of ids) {
    try {
      const run: DreamRun = JSON.parse(readFileSync(join(root, id, "run.json"), "utf8"));
      if (run.status === "running" && !(run.pid && pidAlive(run.pid))) {
        run.status = "aborted";
        run.error = "the process running this dream ended before it finished; nothing was applied";
      }
      runs.push(run);
    } catch {} // not a run
  }
  return runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export interface DreamStatus {
  unprocessed: number;
  here: number;
  running: boolean;
  /** A dream waiting for review. */
  staged?: DreamRun;
  last?: DreamRun;
}

export function dreamStatus(cwd: string, env: Record<string, string | undefined>): DreamStatus {
  const sessionsDir = sessionsRoot(env);
  const pending = findUnprocessed({ env, sessionsDir, cwd });
  const here = canonicalPath(cwd);
  return {
    unprocessed: pending.length,
    here: pending.filter((p) => canonicalPath(p.transcript.cwd) === here).length,
    running: dreamRunning(dreamsDir(env)),
    staged: readRuns(env).find((r) => r.status === "staged"),
    last: readRuns(env).find((r) => r.status !== "running"),
  };
}

export function formatStatus(s: DreamStatus): string {
  const noun = s.unprocessed === 1 ? "session" : "sessions";
  const lines = [s.unprocessed ? `${s.unprocessed} unprocessed ${noun} (${s.here} from this directory). Run /o6y-dream in pi to process them.` : "No unprocessed sessions."];
  if (s.running) lines.push("A dream is running now.");
  if (s.staged) lines.push(`Dream ${s.staged.id} is staged for review: \`o6y dream show\`, then \`o6y dream apply\` or \`o6y dream discard\`.`);
  if (s.last) {
    const ok = s.last.sessions.filter((x) => x.ok).length;
    lines.push(`Last dream: ${s.last.startedAt.slice(0, 16).replace("T", " ")} UTC, ${s.last.status}: ${ok}/${s.last.sessions.length} sessions, ${s.last.changes.length} changes, $${s.last.cost.toFixed(4)}`);
  } else lines.push("No dreams yet.");
  return lines.join("\n");
}
