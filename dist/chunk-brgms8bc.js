#!/usr/bin/env node
import {
  cacheRoot
} from "./chunk-7ffqdz50.js";
import {
  canonicalPath
} from "./chunk-byp1kbkq.js";

// src/dream/status.ts
import { readdirSync as readdirSync3, readFileSync as readFileSync3 } from "node:fs";
import { join as join3 } from "node:path";

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

// src/dream/transcript.ts
import { readdirSync as readdirSync2, readFileSync as readFileSync2 } from "node:fs";
import { homedir } from "node:os";
import { join as join2 } from "node:path";
function sessionsRoot(env) {
  return env.PI_CODING_AGENT_SESSION_DIR || join2(homedir(), ".pi", "agent", "sessions");
}
function jsonlFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync2(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join2(dir, entry.name);
    if (entry.isDirectory())
      jsonlFiles(full, out);
    else if (entry.name.endsWith(".jsonl"))
      out.push(full);
  }
  return out;
}
function parseTranscript(file, text) {
  const parsed = [];
  for (const line of text.split(`
`)) {
    if (!line.trim())
      continue;
    try {
      parsed.push(JSON.parse(line));
    } catch {}
  }
  const header = parsed[0];
  if (header?.type !== "session" || typeof header.id !== "string")
    return;
  return { id: header.id, file, cwd: String(header.cwd ?? ""), startedAt: String(header.timestamp ?? ""), entries: parsed.slice(1) };
}
function listTranscripts(root) {
  const out = [];
  for (const file of jsonlFiles(root)) {
    let text;
    try {
      text = readFileSync2(file, "utf8");
    } catch {
      continue;
    }
    const transcript = parseTranscript(file, text);
    if (transcript)
      out.push(transcript);
  }
  return out.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}
function activeBranch(entries) {
  const byId = new Map(entries.filter((e) => e.id).map((e) => [e.id, e]));
  const leaf = entries.findLast((e) => e.id);
  const branch = [];
  const seen = new Set;
  for (let at = leaf;at?.id && !seen.has(at.id); at = at.parentId ? byId.get(at.parentId) : undefined) {
    seen.add(at.id);
    branch.push(at);
  }
  return branch.reverse();
}
var hasUserMessage = (entries) => entries.some((e) => e.type === "message" && e.message?.role === "user");
function pendingPart(transcript, doneLeaf) {
  const branch = activeBranch(transcript.entries);
  const leaf = branch.at(-1)?.id;
  if (!leaf || leaf === doneLeaf)
    return;
  const from = doneLeaf ? branch.findIndex((e) => e.id === doneLeaf) + 1 : 0;
  const entries = branch.slice(from);
  return hasUserMessage(entries) ? { transcript, entries, leaf } : undefined;
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
function findUnprocessed(opts) {
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
  const root = join3(dreamsDir(env), "runs");
  let ids;
  try {
    ids = readdirSync3(root);
  } catch {
    return [];
  }
  const runs = [];
  for (const id of ids) {
    try {
      const run = JSON.parse(readFileSync3(join3(root, id, "run.json"), "utf8"));
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
