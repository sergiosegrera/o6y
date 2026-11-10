#!/usr/bin/env node
import {
  LOG_FILE,
  makeLayers,
  Store,
  formatIssues
} from "./chunk-fh0jaf4t.js";
import {
  cacheRoot2
} from "./chunk-5x828vk5.js";
import {
  describe,
  LOG_LINE,
  Plan
} from "./chunk-s38bcg3w.js";

// src/dream/state.ts
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
var dreamsDir2 = (env) => join(cacheRoot2(env), "dreams");
function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}
`);
  renameSync(tmp, path);
}
function readLedger2(dir) {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, "ledger.json"), "utf8"));
    return { sessions: parsed.sessions ?? {} };
  } catch {
    return { sessions: {} };
  }
}
var writeLedger = (dir, ledger) => writeJson(join(dir, "ledger.json"), ledger);
var runDir = (dir, id) => join(dir, "runs", id);
var writeRun = (dir, id, run) => writeJson(join(runDir(dir, id), "run.json"), run);
function pidAlive2(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}
function dreamRunning2(dir) {
  try {
    const holder = Number(readFileSync(join(dir, "lock"), "utf8"));
    return Boolean(holder) && pidAlive2(holder);
  } catch {
    return false;
  }
}
function acquireLock(dir) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "lock");
  for (let attempt = 0;attempt < 2; attempt++) {
    try {
      writeFileSync(path, String(process.pid), { flag: "wx" });
      return () => rmSync(path, { force: true });
    } catch {
      const holder = Number(readFileSync(path, "utf8"));
      if (holder && pidAlive2(holder))
        return;
      rmSync(path, { force: true });
    }
  }
  return;
}
function storeFiles(root, dir = root, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory())
      storeFiles(root, full, out);
    else if (relative(root, full) !== LOG_FILE)
      out.push(relative(root, full));
  }
  return out;
}
var read = (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};
function stagedSources(base, staged) {
  const out = new Map;
  const added = (read(join(staged, LOG_FILE)) ?? "").slice((read(join(base, LOG_FILE)) ?? "").length);
  for (const line of added.split(`
`)) {
    const m = LOG_LINE.exec(line);
    if (!m?.[5])
      continue;
    const set = out.get(m[3]) ?? new Set;
    for (const s of m[5].split(", "))
      set.add(s);
    out.set(m[3], set);
  }
  return out;
}
function applyStaged(layers, target, base, staged) {
  const plan = new Plan(layers);
  plan.stamping = false;
  const sources = stagedSources(base, staged);
  plan.source = (path) => {
    const found = sources.get(describe(layers, path));
    return found ? [...found].join(", ") : undefined;
  };
  const conflicts = [];
  for (const rel of new Set([...storeFiles(base), ...storeFiles(staged)])) {
    const before = read(join(base, rel));
    const after = read(join(staged, rel));
    if (before === after)
      continue;
    const path = join(target.root, rel);
    const live = read(path);
    if (live === after)
      continue;
    if (live !== before) {
      conflicts.push(path);
      continue;
    }
    if (after === null)
      plan.delete(path);
    else
      plan.write(path, after);
  }
  const result = plan.validate();
  if (result.blocking.length)
    return { changes: [], conflicts, error: formatIssues(result.blocking, layers) };
  return { changes: plan.apply("dream"), conflicts };
}
var OBJECT_FILE = /^([^/.][^/]*\/[^/.][^/]*)\.md$/;
var unmanaged = (text) => text.replace(/^o6y:\n(?:[ \t]+.*\n)*/m, "");
function lineDelta(before, after) {
  const counts = new Map;
  for (const line of before.split(`
`))
    counts.set(line, (counts.get(line) ?? 0) + 1);
  let added = 0;
  for (const line of after.split(`
`)) {
    const left = counts.get(line) ?? 0;
    if (left)
      counts.set(line, left - 1);
    else
      added++;
  }
  return { added, removed: [...counts.values()].reduce((n, c) => n + c, 0) };
}
function reviewOf(base, staged, reasons, pinned, manyLines) {
  const review = { created: [], updated: [], deleted: [] };
  for (const rel of [...new Set([...storeFiles(base), ...storeFiles(staged)])].sort()) {
    const id = OBJECT_FILE.exec(rel)?.[1];
    if (!id)
      continue;
    const before = read(join(base, rel));
    const after = read(join(staged, rel));
    if (before === after)
      continue;
    if (after === null)
      review.deleted.push(id);
    else if (before === null)
      review.created.push({ id, lines: unmanaged(after).trimEnd().split(`
`).length, reason: reasons.get(id) ?? "" });
    else {
      const delta = lineDelta(unmanaged(before), unmanaged(after));
      review.updated.push({ id, ...delta, flags: [...pinned.has(id) ? ["pinned"] : [], ...delta.added > manyLines ? [`over ${manyLines} lines added`] : []] });
    }
  }
  review.updated.sort((a, b) => b.added + b.removed - (a.added + a.removed) || a.id.localeCompare(b.id));
  return review;
}
function stagedChanges(base, staged, liveRoot) {
  const out = [];
  for (const rel of [...new Set([...storeFiles(base), ...storeFiles(staged)])].sort()) {
    const before = read(join(base, rel));
    const after = read(join(staged, rel));
    if (before !== after)
      out.push({ action: after === null ? "delete" : before === null ? "create" : "update", path: join(liveRoot, rel) });
  }
  return out;
}
function recordSessions(dir, run, leaves, at) {
  const ledger = readLedger2(dir);
  for (const [session, leaf] of Object.entries(leaves))
    ledger.sessions[session] = { leaf, at, run };
  writeLedger(dir, ledger);
}
var outcome = (run) => {
  const ok = run.sessions.filter((s) => s.ok).length;
  return ok === 0 ? "failed" : ok < run.sessions.length || run.error || run.organizer?.ok === false ? "partial" : "done";
};
function refreshStaged(run, liveRoot, layers, manyLines) {
  const reasons = new Map((run.review?.created ?? []).map((c) => [c.id, c.reason]));
  const pinned = new Set([...Store.load(layers).objects.values()].filter((o) => o.pinned).map((o) => o.id));
  run.review = reviewOf(run.snapshot, run.staged, reasons, pinned, manyLines);
  run.changes = stagedChanges(run.snapshot, run.staged, liveRoot);
}
function dropStaged2(env, layers, run, ids, manyLines) {
  const touched = new Set([...run.review?.created ?? [], ...run.review?.updated ?? []].map((o) => o.id).concat(run.review?.deleted ?? []));
  const unknown = ids.filter((id) => !touched.has(id));
  if (unknown.length)
    throw new Error(`dream ${run.id} doesn't change ${unknown.join(", ")}`);
  for (const id of ids) {
    const before = read(join(run.snapshot, `${id}.md`));
    const path = join(run.staged, `${id}.md`);
    if (before === null)
      rmSync(path, { force: true });
    else {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, before);
    }
  }
  refreshStaged(run, layers[0].root, layers, manyLines);
  writeRun(dreamsDir2(env), run.id, run);
  const issues = Store.load(makeLayers(run.staged)).issues.filter((i) => i.severity !== "info" && ids.some((id) => i.message.includes(id)));
  return issues.map((i) => i.message);
}
function applyRun2(env, layers, run, now = new Date) {
  const dir = dreamsDir2(env);
  const release = acquireLock(dir);
  if (!release)
    throw new Error("a dream is running; apply when it has finished");
  try {
    const result = applyStaged(layers, layers[0], run.snapshot, run.staged);
    run.conflicts = result.conflicts;
    run.error = result.error;
    if (result.error) {
      writeRun(dir, run.id, run);
      return run;
    }
    run.changes = result.changes;
    recordSessions(dir, run.id, run.leaves ?? {}, now.toISOString());
    rmSync(run.staged, { recursive: true, force: true });
    delete run.staged;
    delete run.leaves;
    run.status = outcome(run);
    writeRun(dir, run.id, run);
    return run;
  } finally {
    release();
  }
}
function discardRun2(env, run, retry, now = new Date) {
  const dir = dreamsDir2(env);
  if (!retry)
    recordSessions(dir, run.id, run.leaves ?? {}, now.toISOString());
  rmSync(run.staged, { recursive: true, force: true });
  delete run.staged;
  delete run.leaves;
  run.status = "discarded";
  run.changes = [];
  writeRun(dir, run.id, run);
  return run;
}

export { dreamsDir2, readLedger2, pidAlive2, dreamRunning2, dropStaged2, applyRun2, discardRun2 };
