#!/usr/bin/env node
import {
  LOG_FILE,
  SCHEMA_FILE,
  classifyPath,
  parseDoc
} from "./chunk-a8qzjqdm.js";

// src/core/format.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseDocument } from "yaml";
var FORMAT_VERSION = 1;
var FORMAT_KEY = "o6yFormat";
var MIGRATIONS = {};
function readFormat(rootSchemaText) {
  const value = parseDoc(rootSchemaText).data?.[FORMAT_KEY];
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}
function setFormat(text, version) {
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n?---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match)
    return `---
${FORMAT_KEY}: ${version}
---
${text}`;
  const doc = parseDocument(match[1] ?? "");
  doc.set(FORMAT_KEY, version);
  return `---
${String(doc)}---
${text.slice(match[0].length)}`;
}
function ensureFormat(layer, migrations = MIGRATIONS, current = FORMAT_VERSION) {
  if (!existsSync(layer.root))
    return { status: "absent" };
  const path = join(layer.root, SCHEMA_FILE);
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  const stamped = readFormat(text);
  const from = stamped ?? 1;
  if (from > current)
    return { status: "newer", version: from };
  for (let v = from;v < current; v++) {
    const migrate = migrations[v];
    if (!migrate)
      throw new Error(`o6y: no migration from store format ${v} to ${v + 1}`);
    migrate(layer.root);
  }
  if (stamped === current)
    return { status: "current", version: current };
  const latest = existsSync(path) ? readFileSync(path, "utf8") : "";
  mkdirSync(layer.root, { recursive: true });
  writeFileSync(path, setFormat(latest, current));
  return from < current ? { status: "migrated", from, to: current } : { status: "stamped", version: current };
}

// src/core/fsops.ts
import { appendFileSync, existsSync as existsSync2, mkdirSync as mkdirSync2, readdirSync, readFileSync as readFileSync2, rmdirSync, rmSync, statSync, writeFileSync as writeFileSync2 } from "node:fs";
import { dirname, join as join2, relative } from "node:path";
function describe(layers, path) {
  const info = classifyPath(layers, path);
  if (!info)
    return path;
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
var LOG_LINE = /^- (\S+) (create|update|delete) (.+) \((.+)\)(?: \[([^\]]+)\])?$/;
function appendLog(layers, entries, via, now = new Date) {
  const stamp = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  const byLayer = new Map;
  for (const { action, path, source } of entries) {
    const info = classifyPath(layers, path);
    if (!info || info.kind === "log")
      continue;
    if (!byLayer.has(info.layer))
      byLayer.set(info.layer, []);
    byLayer.get(info.layer).push(`- ${stamp} ${action} ${describe(layers, path)} (${via})${source ? ` [${source}]` : ""}`);
  }
  for (const [layer, lines] of byLayer) {
    const logPath = join2(layer.root, LOG_FILE);
    mkdirSync2(layer.root, { recursive: true });
    if (!existsSync2(logPath))
      writeFileSync2(logPath, `# o6y log

Append-only; written by o6y.

`);
    appendFileSync(logPath, lines.join(`
`) + `
`);
  }
}
var STARTER_SCHEMAS = {
  [SCHEMA_FILE]: `---
o6yFormat: ${FORMAT_VERSION}
summaryMaxLength: 80
promptBudget: 8000
namesBudget: 10000
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
  location: { type: string, description: "the repo or directory this applies to, if only one" }
index: [tags]
---
One topic per note, with a specific summary. Tag it (e.g. system, practice, gotcha) so related
notes are easy to find, and link what it is about. For each claim, say how it is known (ran it,
someone stated it, inferred) and when it could stop being true.
`,
  [`decision/${SCHEMA_FILE}`]: `---
description: A choice that was made and should not be silently relitigated
fields:
  date: date
  status: string
index: [date]
---
Context, what was decided and who decided it, the evidence it rested on, and the consequences.
If it replaces an earlier decision, link that one.
`
};
function bootstrap(root) {
  if (existsSync2(join2(root, SCHEMA_FILE)))
    return [];
  const written = [];
  for (const [rel, content] of Object.entries(STARTER_SCHEMAS)) {
    const path = join2(root, rel);
    if (existsSync2(path))
      continue;
    mkdirSync2(dirname(path), { recursive: true });
    writeFileSync2(path, content);
    written.push(path);
  }
  return written;
}
function storeSignature(layers) {
  const walk = (dir, depth) => {
    if (depth > 2)
      return "";
    let out = "";
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return "";
    }
    for (const e of entries) {
      const full = join2(dir, e.name);
      if (e.isDirectory())
        out += `${full}/
${walk(full, depth + 1)}`;
      else {
        try {
          const st = statSync(full);
          out += `${full}:${st.size}:${st.mtimeMs}
`;
        } catch {}
      }
    }
    return out;
  };
  return layers.map((l) => walk(l.root, 0)).join("\x00");
}

export { ensureFormat, describe, LOG_LINE, appendLog, bootstrap, storeSignature };
