import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { parseDoc } from "./frontmatter.ts";
import { type Layer, SCHEMA_FILE } from "./store.ts";

/**
 * Version of the on-disk store format, stamped into each root schema as `o6yFormat`. Bump it only
 * when a release changes rules in a way that could invalidate existing stores, and add the
 * migration that upgrades stores from the previous version.
 */
export const FORMAT_VERSION = 1;
export const FORMAT_KEY = "o6yFormat";

/** `MIGRATIONS[n]` upgrades a store root from format n to n + 1. */
export type Migration = (root: string) => void;
export const MIGRATIONS: Record<number, Migration> = {};

export type FormatStatus =
  | { status: "absent" }
  | { status: "current"; version: number }
  | { status: "stamped"; version: number }
  | { status: "migrated"; from: number; to: number }
  | { status: "newer"; version: number };

export function readFormat(rootSchemaText: string): number | undefined {
  const value = parseDoc(rootSchemaText).data?.[FORMAT_KEY];
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/** Sets `o6yFormat` in a root schema's frontmatter, preserving other keys, comments and body. */
export function setFormat(text: string, version: number): string {
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n?---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) return `---\n${FORMAT_KEY}: ${version}\n---\n${text}`;
  const doc = parseDocument(match[1] ?? "");
  doc.set(FORMAT_KEY, version);
  return `---\n${String(doc)}---\n${text.slice(match[0].length)}`;
}

/**
 * Brings an existing store to the current format: stamps unversioned stores (they predate
 * versioning, i.e. format 1), runs pending migrations, and reports stores from a newer o6y.
 */
export function ensureFormat(layer: Layer, migrations = MIGRATIONS, current = FORMAT_VERSION): FormatStatus {
  if (!existsSync(layer.root)) return { status: "absent" };
  const path = join(layer.root, SCHEMA_FILE);
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  const stamped = readFormat(text);
  const from = stamped ?? 1;
  if (from > current) return { status: "newer", version: from };
  for (let v = from; v < current; v++) {
    const migrate = migrations[v];
    if (!migrate) throw new Error(`o6y: no migration from store format ${v} to ${v + 1}`);
    migrate(layer.root);
  }
  if (stamped === current) return { status: "current", version: current };
  // Migrations may have rewritten the root schema; re-read before stamping.
  const latest = existsSync(path) ? readFileSync(path, "utf8") : "";
  mkdirSync(layer.root, { recursive: true });
  writeFileSync(path, setFormat(latest, current));
  return from < current ? { status: "migrated", from, to: current } : { status: "stamped", version: current };
}
