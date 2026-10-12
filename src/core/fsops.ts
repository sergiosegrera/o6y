import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { FORMAT_VERSION } from "./format.ts";
import { classifyPath, type Layer, LOG_FILE, SCHEMA_FILE } from "./store.ts";

export interface Snapshot {
  files: Map<string, Buffer>;
  dirs: Set<string>;
}

function walkAll(dir: string, files: string[], dirs: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      dirs.push(full);
      walkAll(full, files, dirs);
    } else {
      files.push(full);
    }
  }
}

export function takeSnapshot(layers: Layer[]): Snapshot {
  const snapshot: Snapshot = { files: new Map(), dirs: new Set() };
  for (const layer of layers) {
    if (!existsSync(layer.root)) continue;
    snapshot.dirs.add(layer.root);
    const files: string[] = [];
    const dirs: string[] = [];
    walkAll(layer.root, files, dirs);
    for (const d of dirs) snapshot.dirs.add(d);
    for (const f of files) {
      try {
        snapshot.files.set(f, readFileSync(f));
      } catch {}
    }
  }
  return snapshot;
}

export interface Changes {
  created: string[];
  modified: string[];
  deleted: string[];
}

export function diffSnapshot(before: Snapshot, layers: Layer[]): Changes {
  const after = takeSnapshot(layers);
  const changes: Changes = { created: [], modified: [], deleted: [] };
  for (const [path, content] of after.files) {
    const prev = before.files.get(path);
    if (!prev) changes.created.push(path);
    else if (!prev.equals(content)) changes.modified.push(path);
  }
  for (const path of before.files.keys()) if (!after.files.has(path)) changes.deleted.push(path);
  return changes;
}

export function hasChanges(c: Changes): boolean {
  return c.created.length + c.modified.length + c.deleted.length > 0;
}

/** Restores the stores to the snapshot: removes new files/dirs and rewrites changed/deleted ones. */
export function restoreSnapshot(snapshot: Snapshot, layers: Layer[]): void {
  const files: string[] = [];
  const dirs: string[] = [];
  for (const layer of layers) {
    if (existsSync(layer.root)) {
      if (!snapshot.dirs.has(layer.root)) dirs.push(layer.root);
      walkAll(layer.root, files, dirs);
    }
  }
  for (const f of files) {
    if (!snapshot.files.has(f)) rmSync(f, { force: true });
  }
  for (const [path, content] of snapshot.files) {
    let current: Buffer | undefined;
    try {
      current = readFileSync(path);
    } catch {}
    if (!current || !current.equals(content)) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    }
  }
  // Deepest first so parents are empty when we reach them.
  for (const d of dirs.sort((a, b) => b.length - a.length)) {
    if (snapshot.dirs.has(d)) continue;
    try {
      rmdirSync(d);
    } catch {}
  }
}

export type LogAction = "create" | "update" | "delete";

/** How a path is named in log.md: an object id, `schema <type>`, `root schema`, or a relative path. */
export function describe(layers: Layer[], path: string): string {
  const info = classifyPath(layers, path);
  if (!info) return path;
  switch (info.kind) {
    case "object":
      return info.id;
    case "type-schema":
      return `schema ${info.type}`;
    case "root-schema":
      return "root schema";
    default:
      return relative(info.layer.root, path);
  }
}

/** Appends one line per change to the log.md of the layer containing each path. */
export function appendLog(layers: Layer[], entries: { action: LogAction; path: string }[], via: string, now = new Date()): void {
  const stamp = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  const byLayer = new Map<Layer, string[]>();
  for (const { action, path } of entries) {
    const info = classifyPath(layers, path);
    if (!info || info.kind === "log") continue;
    if (!byLayer.has(info.layer)) byLayer.set(info.layer, []);
    byLayer.get(info.layer)!.push(`- ${stamp} ${action} ${describe(layers, path)} (${via})`);
  }
  for (const [layer, lines] of byLayer) {
    const logPath = join(layer.root, LOG_FILE);
    mkdirSync(layer.root, { recursive: true });
    if (!existsSync(logPath)) writeFileSync(logPath, "# o6y log\n\nAppend-only; written by o6y.\n\n");
    appendFileSync(logPath, lines.join("\n") + "\n");
  }
}

export function changesToLog(c: Changes): { action: LogAction; path: string }[] {
  return [
    ...c.created.map((path) => ({ action: "create" as const, path })),
    ...c.modified.map((path) => ({ action: "update" as const, path })),
    ...c.deleted.map((path) => ({ action: "delete" as const, path })),
  ];
}

export const STARTER_SCHEMAS: Record<string, string> = {
  [SCHEMA_FILE]: `---
o6yFormat: ${FORMAT_VERSION}
summaryMaxLength: 80
promptBudget: 8000
pinnedBudget: 2500
---
Memory of the user and their work: the people, preferences, decisions and tribal knowledge a
teammate would need. Keep objects factual, concise and linked. The starter types are deliberately
minimal; when a kind of note keeps recurring (systems, gotchas, runbooks…), give it its own type.
`,
  [`person/${SCHEMA_FILE}`]: `---
description: Someone the user works with or mentions (teammate, reviewer, stakeholder)
fields:
  role: string
  team: string
index: [role]
---
Who they are, what they own or know best, and how to work with them. If they review code, a
\`## Review notes\` section (what they look for, recurring feedback) lets you pre-empt their review.
`,
  [`preference/${SCHEMA_FILE}`]: `---
description: How the user or team wants things done (style, tools, workflow, communication)
fields:
  scope: { type: string, description: "who it applies to: user, team, or a project/repo name" }
index: [scope]
alwaysList: true
---
Write the preference as an instruction you can follow, plus the reason if known. One preference
per object; when it changes, update the object instead of adding a contradicting one.
`,
  [`note/${SCHEMA_FILE}`]: `---
description: Any other durable knowledge — how a system works, a convention, a gotcha, a fact
fields:
  tags: list
  related: { type: link, many: true }
index: [tags]
---
One topic per note, with a specific summary. Tag it (e.g. system, practice, gotcha) so related
notes are easy to find, and link what it is about.
`,
  [`decision/${SCHEMA_FILE}`]: `---
description: A choice that was made and should not be silently relitigated
fields:
  date: date
  status: string
index: [date]
---
Context, what was decided, and the consequences. If it replaces an earlier decision, link that one.
`,
};

/** Seeds starter schemas into an empty store. Returns the files written. */
export function bootstrap(root: string): string[] {
  if (existsSync(join(root, SCHEMA_FILE))) return [];
  const written: string[] = [];
  for (const [rel, content] of Object.entries(STARTER_SCHEMAS)) {
    const path = join(root, rel);
    if (existsSync(path)) continue;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    written.push(path);
  }
  return written;
}
