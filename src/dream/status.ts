/** What can be known about dreams without running one. Free of pi imports, so the CLI bundle can use it. */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalPath } from "../core/store.ts";
import { dreamRunning, dreamsDir, pidAlive, readLedger } from "./state.ts";
import { listTranscripts, type PendingTranscript, pendingPart, sessionsRoot } from "./transcript.ts";

export interface DreamRun {
  id: string;
  status: "running" | "nothing" | "dry-run" | "done" | "partial" | "aborted" | "failed";
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
}

/** `--since`: `30d`, `2w` or `YYYY-MM-DD` as the ISO time to start from; undefined if malformed. */
export function parseSince(value: string, now: Date): string | undefined {
  const age = /^([1-9]\d*)([dw])$/.exec(value);
  if (age) return new Date(now.getTime() - Number(age[1]) * (age[2] === "w" ? 7 : 1) * 86_400_000).toISOString();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export function findUnprocessed(opts: { env: Record<string, string | undefined>; sessionsDir: string; excludeSession?: string; here?: boolean; cwd: string; since?: string }): PendingTranscript[] {
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
    last: readRuns(env).find((r) => r.status !== "running"),
  };
}

export function formatStatus(s: DreamStatus): string {
  const noun = s.unprocessed === 1 ? "session" : "sessions";
  const lines = [s.unprocessed ? `${s.unprocessed} unprocessed ${noun} (${s.here} from this directory). Run /o6y-dream in pi to process them.` : "No unprocessed sessions."];
  if (s.running) lines.push("A dream is running now.");
  if (s.last) {
    const ok = s.last.sessions.filter((x) => x.ok).length;
    lines.push(`Last dream: ${s.last.startedAt.slice(0, 16).replace("T", " ")} UTC, ${s.last.status}: ${ok}/${s.last.sessions.length} sessions, ${s.last.changes.length} changes, $${s.last.cost.toFixed(4)}`);
  } else lines.push("No dreams yet.");
  return lines.join("\n");
}
