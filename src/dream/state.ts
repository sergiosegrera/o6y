/** What dreams keep outside the stores: the ledger of read sessions, run records and the lock. */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { cacheRoot } from "../core/semantic.ts";
import { describe, LOG_LINE } from "../core/fsops.ts";
import { formatIssues, type Layer, LOG_FILE } from "../core/store.ts";
import { Plan } from "../core/edit.ts";

export interface Ledger {
  sessions: Record<string, { leaf: string; at: string; run: string }>;
}

export const dreamsDir = (env: Record<string, string | undefined>) => join(cacheRoot(env), "dreams");

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

export function readLedger(dir: string): Ledger {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, "ledger.json"), "utf8"));
    return { sessions: parsed.sessions ?? {} };
  } catch {
    return { sessions: {} };
  }
}

export const writeLedger = (dir: string, ledger: Ledger) => writeJson(join(dir, "ledger.json"), ledger);
export const runDir = (dir: string, id: string) => join(dir, "runs", id);
export const writeRun = (dir: string, id: string, run: unknown) => writeJson(join(runDir(dir, id), "run.json"), run);

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** True while a live dream holds the lock. */
export function dreamRunning(dir: string): boolean {
  try {
    const holder = Number(readFileSync(join(dir, "lock"), "utf8"));
    return Boolean(holder) && pidAlive(holder);
  } catch {
    return false;
  }
}

/** Takes the single-dream lock; returns its release, or undefined if a live dream holds it. */
export function acquireLock(dir: string): (() => void) | undefined {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, String(process.pid), { flag: "wx" });
      return () => rmSync(path, { force: true });
    } catch {
      const holder = Number(readFileSync(path, "utf8"));
      if (holder && pidAlive(holder)) return undefined;
      rmSync(path, { force: true });
    }
  }
  return undefined;
}

export function copyStore(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  if (existsSync(from)) cpSync(from, to, { recursive: true });
}

function storeFiles(root: string, dir = root, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) storeFiles(root, full, out);
    else if (relative(root, full) !== LOG_FILE) out.push(relative(root, full));
  }
  return out;
}

const read = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

export interface ApplyResult {
  changes: { action: string; path: string }[];
  /** Files the dream changed that were also changed live since it started; the live version is kept. */
  conflicts: string[];
  /** Why nothing was applied, when the result would not validate. */
  error?: string;
}

/** True when a dream changed anything in this staged store. */
export function stagedChanged(base: string, staged: string): boolean {
  const files = new Set([...storeFiles(base), ...storeFiles(staged)]);
  return [...files].some((rel) => read(join(base, rel)) !== read(join(staged, rel)));
}

/** Per target, the sessions the staged copy's log says changed it during this dream. */
function stagedSources(base: string, staged: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const added = (read(join(staged, LOG_FILE)) ?? "").slice((read(join(base, LOG_FILE)) ?? "").length);
  for (const line of added.split("\n")) {
    const m = LOG_LINE.exec(line);
    if (!m?.[5]) continue;
    const set = out.get(m[3]!) ?? new Set<string>();
    for (const s of m[5].split(", ")) set.add(s);
    out.set(m[3]!, set);
  }
  return out;
}

/**
 * Applies a staged store to its live one as one validated change. Each file is a three-way
 * comparison against the copy the dream started from, so edits made meanwhile are never overwritten.
 */
export function applyStaged(layers: Layer[], target: Layer, base: string, staged: string): ApplyResult {
  const plan = new Plan(layers);
  plan.stamping = false; // stamped when each change was made in the staged copy
  const sources = stagedSources(base, staged);
  plan.source = (path) => {
    const found = sources.get(describe(layers, path));
    return found ? [...found].join(", ") : undefined;
  };
  const conflicts: string[] = [];
  for (const rel of new Set([...storeFiles(base), ...storeFiles(staged)])) {
    const before = read(join(base, rel));
    const after = read(join(staged, rel));
    if (before === after) continue;
    const path = join(target.root, rel);
    const live = read(path);
    if (live === after) continue;
    if (live !== before) {
      conflicts.push(path);
      continue;
    }
    if (after === null) plan.delete(path);
    else plan.write(path, after);
  }
  const result = plan.validate();
  if (result.blocking.length) return { changes: [], conflicts, error: formatIssues(result.blocking, layers) };
  return { changes: plan.apply("dream"), conflicts };
}
