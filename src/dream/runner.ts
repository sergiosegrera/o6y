/**
 * A dream: one analyzer per unprocessed session, then an organizer, all on a staged copy of the
 * store. The result is applied to the live store only at the end, as one validated change, and
 * the copy it started from is kept with the run record.
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { DreamSettings } from "../core/schema.ts";
import { canonicalPath, makeLayers, Store } from "../core/store.ts";
import { type DreamRun, findUnprocessed } from "./status.ts";
import { ANALYZER_SYSTEM, analyzerPrompt, ORGANIZER_SYSTEM, organizerPrompt, similarObjects, withInstructions } from "./prompts.ts";
import { acquireLock, applyStaged, copyStore, dreamsDir, readLedger, runDir, stagedChanged, stagedObjects, writeLedger, writeRun } from "./state.ts";
import { storeTools, transcriptTool } from "./tools.ts";
import { paginate, renderEntries } from "./transcript.ts";

export type AgentRunner = (request: {
  role: "analyzer" | "organizer";
  system: string;
  prompt: string;
  tools: ToolDefinition<any, any>[];
  model: string;
  thinking: string;
  signal?: AbortSignal;
}) => Promise<{ text: string; cost: number; tokens: number }>;

export interface DreamOptions {
  cwd: string;
  env: Record<string, string | undefined>;
  storeRoot: string;
  sessionsDir: string;
  /** The running session: still being written, so it waits for a later dream. */
  excludeSession?: string;
  here?: boolean;
  limit?: number;
  /** Only sessions started at or after this ISO time. */
  since?: string;
  dryRun?: boolean;
  settings: DreamSettings;
  agent: AgentRunner;
  signal?: AbortSignal;
  progress?: (text: string) => void;
  now?: () => Date;
}

export { type DreamRun, findUnprocessed };

export async function runDream(opts: DreamOptions): Promise<DreamRun> {
  const now = opts.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const id = startedAt.replace(/[:.]/g, "-");
  const models = { analyzer: opts.settings.analyzerModel || opts.settings.model, organizer: opts.settings.organizerModel || opts.settings.model };
  const run: DreamRun = { id, status: "nothing", startedAt, models, unprocessed: 0, sessions: [], changes: [], conflicts: [], cost: 0, tokens: 0 };

  const pending = findUnprocessed(opts);
  run.unprocessed = pending.length;
  const chosen = opts.limit ? pending.slice(0, opts.limit) : pending;
  if (!chosen.length) return run;
  if (opts.dryRun) {
    run.status = "dry-run";
    run.sessions = chosen.map((p) => ({ id: p.transcript.id, file: p.transcript.file, cwd: p.transcript.cwd, ok: false, summary: "" }));
    return run;
  }

  const dir = dreamsDir(opts.env);
  const release = acquireLock(dir);
  if (!release) throw new Error("another dream is already running");
  const root = runDir(dir, id);
  const staged = join(root, "staging");
  const base = join(root, "base");
  run.snapshot = base;
  /** Saved after every step, so the viewer can follow a dream from another process. */
  const progress = (step: string) => {
    run.step = step;
    writeRun(dir, id, run);
    opts.progress?.(`dreaming: ${step}`);
  };

  try {
    const live = canonicalPath(opts.storeRoot);
    copyStore(live, base);
    copyStore(live, staged);
    run.status = "running";
    run.pid = process.pid;
    run.planned = chosen.length;
    const layers = makeLayers(staged);
    const spend = (r: { cost: number; tokens: number }) => {
      run.cost += r.cost;
      run.tokens += r.tokens;
    };
    const guidance = [...Store.load(layers).rootGuidance.values()].join("\n\n");
    const instructed = (system: string) => withInstructions(system, opts.settings.instructions, guidance);
    const ledger = readLedger(dir);
    const leaves = new Map<string, string>();

    for (const [i, part] of chosen.entries()) {
      opts.signal?.throwIfAborted();
      const { transcript } = part;
      const pages = paginate(renderEntries(part.entries, opts.settings.maxToolResultChars), opts.settings.pageChars);
      const record = { id: transcript.id, file: transcript.file, cwd: transcript.cwd, ok: false, summary: "" };
      run.sessions.push(record);
      progress(`session ${i + 1}/${chosen.length}`);
      try {
        const result = await opts.agent({
          role: "analyzer",
          system: instructed(ANALYZER_SYSTEM),
          prompt: analyzerPrompt({
            id: transcript.id,
            startedAt: transcript.startedAt,
            today: startedAt.slice(0, 10),
            cwd: transcript.cwd,
            pages: pages.length,
            resumed: Boolean(ledger.sessions[transcript.id]),
          }),
          tools: [...storeTools(layers, `pi:${transcript.id}`), transcriptTool(pages)],
          model: models.analyzer,
          thinking: opts.settings.thinking,
          signal: opts.signal,
        });
        spend(result);
        record.ok = true;
        record.summary = result.text.slice(0, 1500);
        leaves.set(transcript.id, part.leaf);
      } catch (err) {
        opts.signal?.throwIfAborted();
        record.summary = `failed: ${err instanceof Error ? err.message : err}`;
      }
    }

    const succeeded = run.sessions.filter((s) => s.ok).length;
    if (stagedChanged(base, staged)) {
      opts.signal?.throwIfAborted();
      run.organizer = { ok: false, summary: "" };
      progress("organizing");
      const changed = stagedObjects(base, staged);
      try {
        const result = await opts.agent({
          role: "organizer",
          system: instructed(ORGANIZER_SYSTEM),
          prompt: organizerPrompt(succeeded, changed, similarObjects(Store.load(layers).objects.values(), [...changed.created, ...changed.updated])),
          tools: storeTools(layers),
          model: models.organizer,
          thinking: opts.settings.thinking,
          signal: opts.signal,
        });
        spend(result);
        run.organizer = { ok: true, summary: result.text.slice(0, 1500) };
      } catch (err) {
        opts.signal?.throwIfAborted();
        run.organizer.summary = `failed: ${err instanceof Error ? err.message : err}`;
      }
    }

    progress("applying");
    const liveLayers = makeLayers(live);
    const result = applyStaged(liveLayers, liveLayers[0]!, base, staged);
    run.changes = result.changes;
    run.conflicts = result.conflicts;
    run.error = result.error;

    if (!result.error) {
      const at = now().toISOString();
      for (const [sessionId, leaf] of leaves) ledger.sessions[sessionId] = { leaf, at, run: id };
      writeLedger(dir, ledger);
    }
    run.status = succeeded === 0 ? "failed" : succeeded < chosen.length || result.error || run.organizer?.ok === false ? "partial" : "done";
  } catch (err) {
    if (!opts.signal?.aborted) {
      run.status = "failed";
      run.error = err instanceof Error ? err.message : String(err);
      throw err;
    }
    run.status = "aborted";
  } finally {
    rmSync(staged, { recursive: true, force: true });
    run.finishedAt = now().toISOString();
    delete run.pid;
    delete run.step;
    writeRun(dir, id, run);
    release();
  }
  return run;
}

export function formatRun(run: DreamRun): string {
  if (run.status === "nothing") return "o6y dream: no unprocessed sessions.";
  if (run.status === "dry-run") return `o6y dream: ${run.unprocessed} unprocessed session(s); this run would process ${run.sessions.length}.`;
  const failed = run.sessions.filter((s) => !s.ok);
  const lines = [
    `o6y dream ${run.status}: ${run.sessions.length - failed.length}/${run.sessions.length} session(s), ${run.changes.length} change(s), $${run.cost.toFixed(4)}, ${run.tokens} tokens`,
    ...run.changes.map((c) => `  ${c.action} ${c.path}`),
    ...run.conflicts.map((path) => `  kept live version (edited during the dream): ${path}`),
    ...(run.error ? [`  not applied: ${run.error}`] : []),
    ...failed.map((s) => `  ${s.id}: ${s.summary}`),
  ];
  if (run.snapshot) lines.push(`Store before this dream: ${run.snapshot}`);
  return lines.join("\n");
}
