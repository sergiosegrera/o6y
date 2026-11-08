/** The "run a dream" dialog on the viewer's dreams tab: its state, its keys and its lines. */
import type { Line } from "./model.ts";

export interface DreamForm {
  /** Sessions waiting, everywhere and from this directory. */
  all: number;
  here: number;
  scope: "all" | "here";
  /** How many sessions to process; the scope's whole count means no cap. */
  cap: number;
  field: "scope" | "cap";
  /** Digits typed so far, so "12" means twelve. */
  typed: string;
}

export type DreamFormKey = "up" | "down" | "left" | "right" | "all" | `${number}`;

/** Starts capped, because a dream applies without review and costs money per session. */
const DEFAULT_CAP = 5;

export const dreamFormMax = (f: DreamForm) => (f.scope === "here" ? f.here : f.all);

export function newDreamForm(all: number, here: number): DreamForm {
  return { all, here, scope: all ? "all" : "here", cap: Math.min(DEFAULT_CAP, all), field: "cap", typed: "" };
}

export function updateDreamForm(f: DreamForm, key: DreamFormKey): DreamForm {
  const clampCap = (cap: number, form = f) => Math.max(1, Math.min(dreamFormMax(form), cap));
  if (/^\d$/.test(key)) {
    const typed = `${f.typed}${key}`.replace(/^0+/, "");
    return typed ? { ...f, field: "cap", typed, cap: clampCap(Number(typed)) } : f;
  }
  const next: DreamForm = { ...f, typed: "" };
  if (key === "up" || key === "down") return { ...next, field: f.field === "cap" ? "scope" : "cap" };
  if (key === "all") return { ...next, field: "cap", cap: dreamFormMax(f) };
  if (f.field === "cap") return { ...next, cap: clampCap(f.cap + (key === "right" ? 1 : -1)) };
  const scope = f.scope === "all" ? "here" : "all";
  if (!(scope === "here" ? f.here : f.all)) return next;
  const moved = { ...next, scope } as DreamForm;
  return { ...moved, cap: clampCap(f.cap, moved) };
}

/** The flags for `/o6y-dream`. */
export function dreamFormFlags(f: DreamForm): string[] {
  return [...(f.scope === "here" ? ["--here"] : []), ...(f.cap < dreamFormMax(f) ? ["--limit", String(f.cap)] : [])];
}

/** Average cost of one session in past dreams, if any were paid for. */
export function costPerSession(runs: { cost: number; sessions: { ok: boolean }[] }[]): number | undefined {
  const paid = runs.filter((r) => r.cost > 0 && r.sessions.some((s) => s.ok));
  const sessions = paid.reduce((n, r) => n + r.sessions.filter((s) => s.ok).length, 0);
  return sessions ? paid.reduce((n, r) => n + r.cost, 0) / sessions : undefined;
}

/** Every line fills `width`, so the dialog hides what is behind it. */
export function dreamFormLines(f: DreamForm, info: { model: string; perSession?: number }, width: number): Line[] {
  const fill = (line: Line): Line => {
    let room = width;
    const fitted: Line = [];
    for (const seg of line) {
      const text = seg.text.slice(0, room);
      room -= text.length;
      if (text) fitted.push({ ...seg, text });
    }
    return [...fitted, { text: " ".repeat(room) }];
  };
  const row = (field: DreamForm["field"], label: string, value: string): Line => {
    const on = f.field === field;
    return [{ text: on ? " ▸ " : "   ", color: "cyan" }, { text: label.padEnd(10), dim: !on }, { text: ` ‹ ${value} › `, inverse: on, bold: on }];
  };
  const max = dreamFormMax(f);
  const count = (n: number) => `${n} session${n === 1 ? "" : "s"}`;
  const scope = f.scope === "here" ? `this directory (${f.here})` : `all directories (${f.all})`;
  const capText = f.cap >= max ? `no cap, all ${max}` : `${f.cap} of ${max}`;
  const blank: Line = [];
  return [
    [{ text: " Run a dream", bold: true }],
    blank,
    row("scope", "Sessions", scope),
    row("cap", "Cap", capText),
    blank,
    [{ text: ` Reads ${count(f.cap)}, oldest first.`, dim: true }],
    [{ text: ` Model: ${info.model}`, dim: true }],
    ...(info.perSession === undefined ? [] : [[{ text: ` About $${(info.perSession * f.cap).toFixed(2)}, going by past dreams.`, dim: true }]]),
    [{ text: " Changes apply to memory without review.", color: "yellow" }],
    blank,
    [{ text: " ⏎ start  ↑↓ field  ←→ change  0-9 cap  a all  esc", dim: true }],
  ].map(fill);
}
