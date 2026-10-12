import type { ObjectEntry, Store } from "../src/core/store.ts";

/** One tool call from a pi run, paired with its result. */
export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
  result: string;
  isError: boolean;
}

/** One pi session (one `pi -p` invocation). */
export interface Run {
  prompt: string;
  toolCalls: ToolCall[];
  /** Text of the final assistant message. */
  answer: string;
  tokens: number;
  cost: number;
  seconds: number;
  /** The run produced no transcript or ended with a provider error. */
  failed?: string;
}

export interface CheckContext {
  store: Store;
  runs: Run[];
  /** Root of the project store (relative paths in checks are not needed; ids are). */
  roots: { global: string; project: string };
}

export interface Check {
  label: string;
  test: (ctx: CheckContext) => boolean | string;
}

export interface EvalCase {
  name: string;
  /** What the case measures, shown in reports. */
  description: string;
  /** Fixture under evals/fixtures/<name>; omitted = empty store (o6y seeds starter schemas). */
  fixture?: string;
  /** Files added on top of the fixture, keyed by `global/...` or `project/...`. */
  files?: Record<string, string>;
  /** Each prompt is a separate pi session, run in order against the same stores. */
  steps: string[];
  checks: Check[];
}

export const defineCase = (c: EvalCase) => c;

// --- Check helpers -------------------------------------------------------------------------

export interface ObjectMatch {
  type?: string;
  id?: string;
  layer?: "global" | "project";
  /** Field predicates or exact values. */
  where?: Record<string, string | number | boolean | ((value: unknown) => boolean)>;
  /** Patterns that must all appear in the summary + body. */
  text?: RegExp[];
  pinned?: boolean;
}

export function matches(obj: ObjectEntry, m: ObjectMatch): boolean {
  if (m.type && obj.type !== m.type) return false;
  if (m.id && obj.id !== m.id) return false;
  if (m.layer && obj.layer.name !== m.layer) return false;
  if (m.pinned !== undefined && obj.pinned !== m.pinned) return false;
  for (const [field, expected] of Object.entries(m.where ?? {})) {
    const value = obj.data[field];
    if (typeof expected === "function" ? !(expected as (v: unknown) => boolean)(value) : value !== expected) return false;
  }
  const content = `${obj.summary}\n${obj.body}`;
  return (m.text ?? []).every((re) => re.test(content));
}

const describe = (m: ObjectMatch) =>
  [m.type, m.id, m.layer, m.pinned ? "pinned" : "", ...(m.text ?? []).map(String)].filter(Boolean).join(" ");

export const hasObject = (m: ObjectMatch, label = `has object ${describe(m)}`): Check => ({
  label,
  test: ({ store }) => [...store.objects.values()].some((o) => matches(o, m)) || `no object matches`,
});

export const noObject = (m: ObjectMatch, label = `no object ${describe(m)}`): Check => ({
  label,
  test: ({ store }) => {
    const hit = [...store.objects.values()].find((o) => matches(o, m));
    return hit ? `found ${hit.id}` : true;
  },
});

export const objectCount = (m: ObjectMatch, min: number, max = Infinity, label = `${min}..${max} objects ${describe(m)}`): Check => ({
  label,
  test: ({ store }) => {
    const n = [...store.objects.values()].filter((o) => matches(o, m)).length;
    return (n >= min && n <= max) || `found ${n}`;
  },
});

export const lintClean = (): Check => ({
  label: "store has no validation errors",
  test: ({ store }) => {
    const errors = store.errors();
    return errors.length === 0 || errors.map((e) => e.message).join("; ");
  },
});

/** The answer of a step (default: last) matches every pattern. */
export const answerMatches = (patterns: RegExp[], step = -1, label = `answer matches ${patterns.join(" ")}`): Check => ({
  label,
  test: ({ runs }) => {
    const answer = runs.at(step)?.answer ?? "";
    const missing = patterns.filter((p) => !p.test(answer));
    return missing.length === 0 || `missing ${missing.join(" ")}`;
  },
});

/** Some step read the object's file (`<type>/<slug>.md`). */
export const readObject = (id: string, label = `read ${id}`): Check => ({
  label,
  test: ({ runs }) =>
    runs.some((r) => r.toolCalls.some((c) => c.name === "read" && String(c.args.path ?? "").endsWith(`${id}.md`))) ||
    "never read",
});

export const maxToolCalls = (n: number, step = -1, label = `≤${n} tool calls`): Check => ({
  label,
  test: ({ runs }) => {
    const count = runs.at(step)?.toolCalls.length ?? 0;
    return count <= n || `${count} calls`;
  },
});

export const typeSchema = (
  predicate: (store: Store) => boolean | string,
  label: string,
): Check => ({ label, test: ({ store }) => predicate(store) });

// --- Metrics -------------------------------------------------------------------------------

/** Writes o6y rejected or rolled back: a measure of how often the agent fights validation. */
export function rejections(runs: Run[]): number {
  return runs
    .flatMap((r) => r.toolCalls)
    .filter((c) => /\[o6y\] (write rejected|This command changed .* rolled back)/.test(c.result)).length;
}
