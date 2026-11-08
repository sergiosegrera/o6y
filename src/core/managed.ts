/**
 * The `o6y:` frontmatter block: attributes the store maintains itself, so they can be trusted.
 * Whatever a writer puts there is replaced. It is edited as text, so the rest of the frontmatter
 * keeps its exact formatting.
 */
import { parse } from "yaml";
import { joinDoc, splitDoc } from "./frontmatter.ts";

export const MANAGED_KEY = "o6y";
interface Managed {
  created?: string;
  updated?: string;
}

export interface StampOptions {
  /** Files this one continues (a rename, or the object merged into it). */
  inherit?: string[];
  /** Link rewrites and migrations: the object's knowledge didn't change. */
  mechanical?: boolean;
  now?: Date;
}

/** Splits frontmatter lines into the managed block and everything else. */
function separate(frontmatter: string): { block: string; rest: string } {
  const block: string[] = [];
  const rest: string[] = [];
  let inside = false;
  for (const line of frontmatter.split("\n")) {
    if (new RegExp(`^${MANAGED_KEY}:`).test(line)) inside = true;
    else if (inside && !/^\s/.test(line)) inside = false;
    (inside ? block : rest).push(line);
  }
  return { block: block.join("\n"), rest: rest.join("\n").trimEnd() };
}

function readManaged(text: string): Managed {
  const { block } = separate(splitDoc(text).frontmatter ?? "");
  let raw: any;
  try {
    raw = (parse(block) ?? {})[MANAGED_KEY];
  } catch {}
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  return {
    created: str(raw?.created),
    updated: str(raw?.updated),
  };
}

/** The object as written by its authors, without the managed block. */
function authored(text: string): string {
  const { frontmatter, body } = splitDoc(text);
  return `${separate(frontmatter ?? "").rest.trim()}\n---\n${body.trim()}`;
}

const latest = (values: (string | undefined)[], pick: (a: string, b: string) => boolean) =>
  values.reduce((best, v) => (v && (!best || pick(v, best)) ? v : best), undefined as string | undefined);

/** `next`, with its managed block rebuilt from what the file held before. */
export function stampObject(previous: string | null, next: string, opts: StampOptions = {}): string {
  const { frontmatter, body } = splitDoc(next);
  if (frontmatter === undefined) return next;
  const { rest } = separate(frontmatter);
  const ancestors = [...(previous === null ? [] : [previous]), ...(opts.inherit ?? [])];
  const known = ancestors.map(readManaged);
  const changed = !opts.mechanical && (!ancestors.length || authored(ancestors[0]!) !== authored(next));
  const today = (opts.now ?? new Date()).toLocaleDateString("en-CA");

  const created = ancestors.length ? latest(known.map((m) => m.created), (a, b) => a < b) : today;
  const updated = changed ? today : latest(known.map((m) => m.updated), (a, b) => a > b);

  const lines = [
    ...(created ? [`  created: ${created}`] : []),
    ...(updated ? [`  updated: ${updated}`] : []),
  ];
  if (!lines.length) return separate(frontmatter).block ? joinDoc(rest, body) : next;
  return joinDoc(`${rest}\n${MANAGED_KEY}:\n${lines.join("\n")}`, body);
}
