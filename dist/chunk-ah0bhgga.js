#!/usr/bin/env node
import {
  listTranscripts,
  pendingPart,
  sessionsRoot
} from "./chunk-kvedd0nk.js";
import {
  dreamRunning,
  dreamsDir,
  pidAlive,
  readLedger
} from "./chunk-10tk4hs0.js";
import {
  canonicalPath
} from "./chunk-a8qzjqdm.js";

// src/dream/status.ts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
function findRun(env, id, staged = false) {
  const runs = readRuns(env);
  const run = id ? runs.find((r) => r.id === id) ?? runs.find((r) => r.id.startsWith(id)) : staged ? runs.find((r) => r.status === "staged") : runs.find((r) => r.status !== "running");
  if (!run)
    throw new Error(id ? `no dream \`${id}\`` : staged ? "no dream is staged for review" : "no dreams yet");
  if (staged && run.status !== "staged")
    throw new Error(`dream ${run.id} is ${run.status}, not staged`);
  return run;
}
function formatRun(run) {
  if (run.status === "nothing")
    return "o6y dream: no unprocessed sessions.";
  if (run.status === "dry-run")
    return `o6y dream: ${run.unprocessed} unprocessed session(s); this run would process ${run.sessions.length}.`;
  const failed = run.sessions.filter((s) => !s.ok);
  const lines = [`o6y dream ${run.status}: ${run.sessions.length - failed.length}/${run.sessions.length} session(s), ${run.changes.length} change(s), $${run.cost.toFixed(4)}, ${run.tokens} tokens`];
  const r = run.review;
  const listed = [];
  if (r) {
    for (const id of [...r.created.map((c) => c.id), ...r.updated.map((u) => u.id), ...r.deleted])
      listed.push(`/${id}.md`);
    if (r.created.length)
      lines.push(`New (${r.created.length}):`, ...r.created.map((c) => `  + ${c.id} (${c.lines} lines): ${c.reason || "no reason given"}`));
    if (r.updated.length)
      lines.push(`Updated (${r.updated.length}), largest first:`, ...r.updated.map((u) => `  ~ ${u.id} +${u.added} -${u.removed}${u.flags.length ? `  [${u.flags.join(", ")}]` : ""}`));
    if (r.deleted.length)
      lines.push(`Deleted (${r.deleted.length}):`, ...r.deleted.map((id) => `  - ${id}`));
  }
  const other = run.changes.filter((c) => !listed.some((rel) => c.path.endsWith(rel)));
  if (other.length)
    lines.push(...r ? ["Other files:"] : [], ...other.map((c) => `  ${c.action} ${c.path}`));
  if (run.proposals?.length) {
    lines.push(`Needs review (${run.proposals.length}): protected objects the dream wanted to change, and didn't:`);
    for (const p of run.proposals)
      lines.push(`  ${p.id}${p.session ? ` (session ${p.session})` : ""}`, ...p.change.split(`
`).map((l) => `    ${l}`));
  }
  lines.push(...run.conflicts.map((path) => `  kept live version (edited during the dream): ${path}`));
  if (run.error)
    lines.push(`  not applied: ${run.error}`);
  lines.push(...failed.map((s) => `  ${s.id}: ${s.summary}`));
  if (run.status === "staged") {
    lines.push("Nothing has changed in the store yet. Compare the two copies, edit the staged one if you like, then:", `  before: ${run.snapshot}`, `  staged: ${run.staged}`, "  o6y dream drop ID...   take an object's change out", "  o6y dream apply        apply what is left", "  o6y dream discard      apply nothing (--retry to read the sessions again next time)");
  } else if (run.snapshot)
    lines.push(`Store before this dream: ${run.snapshot}`);
  return lines.join(`
`);
}
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
  const root = join(dreamsDir(env), "runs");
  let ids;
  try {
    ids = readdirSync(root);
  } catch {
    return [];
  }
  const runs = [];
  for (const id of ids) {
    try {
      const run = JSON.parse(readFileSync(join(root, id, "run.json"), "utf8"));
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
    staged: readRuns(env).find((r) => r.status === "staged"),
    last: readRuns(env).find((r) => r.status !== "running")
  };
}
function formatStatus(s) {
  const noun = s.unprocessed === 1 ? "session" : "sessions";
  const lines = [s.unprocessed ? `${s.unprocessed} unprocessed ${noun} (${s.here} from this directory). Run /o6y-dream in pi to process them.` : "No unprocessed sessions."];
  if (s.running)
    lines.push("A dream is running now.");
  if (s.staged)
    lines.push(`Dream ${s.staged.id} is staged for review: \`o6y dream show\`, then \`o6y dream apply\` or \`o6y dream discard\`.`);
  if (s.last) {
    const ok = s.last.sessions.filter((x) => x.ok).length;
    lines.push(`Last dream: ${s.last.startedAt.slice(0, 16).replace("T", " ")} UTC, ${s.last.status}: ${ok}/${s.last.sessions.length} sessions, ${s.last.changes.length} changes, $${s.last.cost.toFixed(4)}`);
  } else
    lines.push("No dreams yet.");
  return lines.join(`
`);
}

export { findRun, formatRun, parseSince, findUnprocessed, readRuns, dreamStatus, formatStatus };
