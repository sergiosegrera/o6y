#!/usr/bin/env node
import {
  listTranscripts,
  pendingPart,
  sessionsRoot
} from "./chunk-kvedd0nk.js";
import {
  cacheRoot
} from "./chunk-7ffqdz50.js";
import {
  canonicalPath
} from "./chunk-byp1kbkq.js";

// src/dream/status.ts
import { readdirSync as readdirSync2, readFileSync as readFileSync2 } from "node:fs";
import { join as join2 } from "node:path";

// src/dream/state.ts
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
var dreamsDir = (env) => join(cacheRoot(env), "dreams");
function readLedger(dir) {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, "ledger.json"), "utf8"));
    return { sessions: parsed.sessions ?? {} };
  } catch {
    return { sessions: {} };
  }
}
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}
function dreamRunning(dir) {
  try {
    const holder = Number(readFileSync(join(dir, "lock"), "utf8"));
    return Boolean(holder) && pidAlive(holder);
  } catch {
    return false;
  }
}

// src/dream/status.ts
function parseSince(value, now) {
  const age = /^([1-9]\d*)([dw])$/.exec(value);
  if (age)
    return new Date(now.getTime() - Number(age[1]) * (age[2] === "w" ? 7 : 1) * 86400000).toISOString();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
    return;
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
function forcedSessions(sessionsDir, wanted, exclude) {
  const all = listTranscripts(sessionsDir);
  const chosen = new Set;
  for (const id of wanted) {
    const matches = all.filter((t) => t.id === id).length ? all.filter((t) => t.id === id) : all.filter((t) => t.id.startsWith(id));
    if (!matches.length)
      throw new Error(`no session matches \`${id}\``);
    if (matches.length > 1)
      throw new Error(`\`${id}\` matches ${matches.length} sessions; use more of the id`);
    if (matches[0].id === exclude)
      throw new Error(`\`${id}\` is the running session, which is still being written`);
    chosen.add(matches[0]);
  }
  return all.filter((t) => chosen.has(t)).map((t) => {
    const part = pendingPart(t, undefined);
    if (!part)
      throw new Error(`session ${t.id} has no user messages to read`);
    return part;
  });
}
function findUnprocessed(opts) {
  if (opts.sessions?.length)
    return forcedSessions(opts.sessionsDir, opts.sessions, opts.excludeSession);
  const ledger = readLedger(dreamsDir(opts.env));
  const out = [];
  for (const transcript of listTranscripts(opts.sessionsDir)) {
    if (transcript.id === opts.excludeSession)
      continue;
    if (opts.here && canonicalPath(transcript.cwd) !== canonicalPath(opts.cwd))
      continue;
    if (opts.since && transcript.startedAt < opts.since)
      continue;
    const part = pendingPart(transcript, ledger.sessions[transcript.id]?.leaf);
    if (part)
      out.push(part);
  }
  return out;
}
function readRuns(env) {
  const root = join2(dreamsDir(env), "runs");
  let ids;
  try {
    ids = readdirSync2(root);
  } catch {
    return [];
  }
  const runs = [];
  for (const id of ids) {
    try {
      const run = JSON.parse(readFileSync2(join2(root, id, "run.json"), "utf8"));
      if (run.status === "running" && !(run.pid && pidAlive(run.pid))) {
        run.status = "aborted";
        run.error = "the process running this dream ended before it finished; nothing was applied";
      }
      runs.push(run);
    } catch {}
  }
  return runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}
function dreamStatus(cwd, env) {
  const sessionsDir = sessionsRoot(env);
  const pending = findUnprocessed({ env, sessionsDir, cwd });
  const here = canonicalPath(cwd);
  return {
    unprocessed: pending.length,
    here: pending.filter((p) => canonicalPath(p.transcript.cwd) === here).length,
    running: dreamRunning(dreamsDir(env)),
    last: readRuns(env).find((r) => r.status !== "running")
  };
}
function formatStatus(s) {
  const noun = s.unprocessed === 1 ? "session" : "sessions";
  const lines = [s.unprocessed ? `${s.unprocessed} unprocessed ${noun} (${s.here} from this directory). Run /o6y-dream in pi to process them.` : "No unprocessed sessions."];
  if (s.running)
    lines.push("A dream is running now.");
  if (s.last) {
    const ok = s.last.sessions.filter((x) => x.ok).length;
    lines.push(`Last dream: ${s.last.startedAt.slice(0, 16).replace("T", " ")} UTC, ${s.last.status}: ${ok}/${s.last.sessions.length} sessions, ${s.last.changes.length} changes, $${s.last.cost.toFixed(4)}`);
  } else
    lines.push("No dreams yet.");
  return lines.join(`
`);
}

export { dreamsDir, dreamRunning, parseSince, findUnprocessed, readRuns, dreamStatus, formatStatus };
