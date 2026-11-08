#!/usr/bin/env node
import {
  workPaths
} from "./chunk-1zbn4yjy.js";
import {
  displayPath,
  renderObjectFooter,
  renderPromptSection,
  renderRootIndex,
  renderTypeIndex
} from "./chunk-r72565yy.js";
import {
  Plan,
  appendLog,
  bootstrap,
  ensureFormat
} from "./chunk-gcxpqqhg.js";
import {
  INDEX_FILE,
  LOG_FILE,
  SCHEMA_FILE,
  Store,
  canonicalPath,
  classifyPath,
  formatIssues,
  parseId
} from "./chunk-byp1kbkq.js";

// src/mcp/server.ts
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
var PACKAGE_ROOT = (() => {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0;i < 3; i++, dir = dirname(dir))
    if (existsSync(join(dir, "package.json")))
      return dir;
  return dirname(dirname(fileURLToPath(import.meta.url)));
})();
var SKILL_PATH = join(PACKAGE_ROOT, "skills", "o6y", "SKILL.md");
var VIA = "mcp";
var NOT_VIA_CLI = new Set(["view", "mcp"]);
var ok = (text) => ({ content: [{ type: "text", text }] });
var fail = (text) => ({ content: [{ type: "text", text }], isError: true });
function expandHome(p) {
  return p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p;
}
function prepareStores(layers) {
  const notes = [];
  const seeded = bootstrap(layers[0].root);
  if (seeded.length)
    appendLog(layers, seeded.map((path) => ({ action: "create", path })), "bootstrap");
  for (const layer of layers) {
    const result = ensureFormat(layer);
    if (result.status === "newer")
      notes.push(`the ${layer.name} store uses format ${result.version}, newer than this o6y supports; update o6y`);
    else if (result.status === "migrated") {
      appendLog(layers, [{ action: "update", path: join(layer.root, SCHEMA_FILE) }], `migrate format ${result.from}→${result.to}`);
    }
  }
  return notes;
}
function resolveTarget(store, layers, cwd, target) {
  const t = target.trim();
  if (t === "manual")
    return { kind: "manual" };
  const layer = layers[0];
  let path;
  if (t.startsWith("/") || t.startsWith("~") || t.startsWith(".")) {
    if (t === SCHEMA_FILE.replace(/\.md$/, ""))
      path = join(layer.root, SCHEMA_FILE);
    else
      path = resolve(cwd, expandHome(t));
  } else if (t === "index")
    path = join(layer.root, INDEX_FILE);
  else {
    const [type, rest] = t.split("/", 2);
    if (!type || rest === undefined)
      return `\`${t}\` is not a target; use type/slug, type/.schema, .schema, index, type/index, manual or a store path`;
    if (rest === ".schema" || rest === "index") {
      path = join(layer.root, type, rest === "index" ? INDEX_FILE : SCHEMA_FILE);
    } else {
      if (!parseId(t))
        return `\`${t}\` is not a valid id; use type/slug in kebab-case, e.g. note/release-train`;
      path = join(layer.root, type, `${rest}.md`);
    }
  }
  path = canonicalPath(path);
  const info = classifyPath(layers, path);
  if (!info)
    return `${displayPath(path)} is not inside an o6y store (${layers.map((l) => `${l.name}: ${displayPath(l.root)}`).join(", ")})`;
  if (info.kind === "invalid")
    return `${displayPath(path)}: ${info.reason}`;
  return { kind: "path", path, info };
}
function readOrNull(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}
function commitFile(layers, path, content, tool) {
  const plan = new Plan(layers);
  plan.write(path, content);
  const result = plan.validate(Store.load(layers));
  if (result.blocking.length) {
    const isSchema = /\/\.schema\.md$/.test(path);
    const hint = isSchema && result.blocking.some((i) => i.path !== path) ? "\nSchema changes must not invalidate existing objects: migrate the objects first (extra fields are allowed), or make the schema change and the migration in one step with o6y_cli (e.g. `field rename`)." : "";
    return fail(`[o6y] ${tool} rejected; nothing was changed.
${formatIssues(result.blocking, layers)}${hint}`);
  }
  if (!result.changes.length)
    return ok("[o6y] nothing to change: the content is already that.");
  plan.apply(`${tool} (${VIA})`);
  const lines = result.changes.map((c) => `${c.action} ${displayPath(c.path)}`);
  if (result.warnings.length) {
    lines.push(`[o6y] saved with warnings (not blocking; fix when you can, e.g. by writing the missing objects):
${formatIssues(result.warnings, layers)}`);
  }
  return ok(lines.join(`
`));
}
function managedReason(info) {
  if (info.kind === "root-index" || info.kind === "type-index")
    return `${INDEX_FILE} is generated; it cannot be written. Write objects or schemas instead.`;
  if (info.kind === "log")
    return `${LOG_FILE} is append-only and maintained by o6y; it cannot be written.`;
  return;
}
var TARGET = z.string().describe("An object id (type/slug), a schema (type/.schema, or .schema for the store root), or a path inside a store");
function createServer(opts) {
  const { cwd, env, layers } = opts;
  const load = () => Store.load(layers);
  const notes = prepareStores(layers);
  const instructions = [renderPromptSection(load(), { workPaths: workPaths(cwd), mcp: true }), ...notes.map((n) => `Note: ${n}`)].join(`

`);
  const server = new McpServer({ name: "o6y", version: packageVersion() }, { instructions });
  const cliEnv = { ...env, O6Y_HOME: layers[0].root };
  async function cli(argv, { errorOnReject = true } = {}) {
    const out = [];
    const err = [];
    const code = await opts.runCli(argv, {
      cwd,
      env: cliEnv,
      out: (t) => out.push(t),
      err: (t) => err.push(t),
      stdin: () => {
        return;
      },
      isTTY: false,
      fetch: opts.fetch
    });
    const text = [...out, ...err].join(`
`).trimEnd() || `(exit ${code})`;
    return code === 2 || code !== 0 && errorOnReject ? fail(text) : ok(text);
  }
  server.registerTool("o6y_query", {
    title: "Find memory objects",
    description: "Find o6y memory objects by type, field values, links or text (exact matching). Returns one line per object: [[id]] — summary. With no arguments, lists everything (up to limit).",
    inputSchema: {
      text: z.string().optional().describe("Case-insensitive substring of id, summary or body"),
      type: z.string().optional().describe("Only objects of this type"),
      where: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional().describe("field -> value; list and link fields match when any element equals"),
      links_to: z.string().optional().describe("Only objects that link to this id"),
      linked_from: z.string().optional().describe("Only objects this id links to"),
      limit: z.number().int().positive().optional().describe("Default 50")
    },
    annotations: { readOnlyHint: true }
  }, async (a) => {
    const argv = ["query"];
    if (a.type)
      argv.push("--type", a.type);
    for (const [k, v] of Object.entries(a.where ?? {}))
      argv.push("--where", `${k}=${v}`);
    if (a.links_to)
      argv.push("--links-to", a.links_to);
    if (a.linked_from)
      argv.push("--linked-from", a.linked_from);
    if (a.text)
      argv.push("--text", a.text);
    if (a.limit)
      argv.push("--limit", String(a.limit));
    return cli(argv);
  });
  server.registerTool("o6y_search", {
    title: "Search memory by meaning",
    description: 'Find o6y memory objects relevant to a question. Uses semantic search when the store has it on (Cohere), else word matching. "No matching objects." means memory has nothing on it.',
    inputSchema: {
      question: z.string().min(1),
      type: z.string().optional().describe("Only objects of this type"),
      limit: z.number().int().positive().optional().describe("Default 10")
    },
    annotations: { readOnlyHint: true }
  }, async (a) => {
    const argv = ["search", a.question];
    if (a.type)
      argv.push("--type", a.type);
    if (a.limit)
      argv.push("--limit", String(a.limit));
    return cli(argv);
  });
  server.registerTool("o6y_show", {
    title: "Read memory",
    description: "Read from o6y memory. target: an object id (type/slug; shown with its backlinks), a schema (type/.schema, or .schema for the store root), `index` (the full catalog), `type/index` (one type with its fields, guidance and every object), `manual` (the full o6y manual), or any path inside a store.",
    inputSchema: { target: z.string().describe("type/slug, type/.schema, .schema, index, type/index, manual, or a store path") },
    annotations: { readOnlyHint: true }
  }, async (a) => {
    const store = load();
    const t = resolveTarget(store, layers, cwd, a.target);
    if (typeof t === "string")
      return fail(t);
    if (t.kind === "manual")
      return ok(readFileSync(SKILL_PATH, "utf8"));
    const { info, path } = t;
    if (info.kind === "root-index")
      return ok(renderRootIndex(store));
    if (info.kind === "type-index") {
      return ok(renderTypeIndex(store, info.type) ?? `No type \`${info.type}\` yet: write its schema (${info.type}/.schema) first.`);
    }
    const content = readOrNull(path);
    if (info.kind === "object") {
      if (content === null) {
        const from = store.wanted.get(info.id);
        return fail(from ? `${info.id} is not written yet. Linked from: ${[...from].sort().join(", ")}` : `No object \`${info.id}\` (${displayPath(path)}).`);
      }
      return ok(`${content.trimEnd()}
${renderObjectFooter(store, info.id, path)}`);
    }
    if (content === null)
      return fail(`${displayPath(path)} does not exist.`);
    return ok(content);
  });
  server.registerTool("o6y_write", {
    title: "Write memory",
    description: "Create or replace an o6y object or schema with the full file content (YAML frontmatter + markdown body). The change is validated against the schemas before anything is saved; a rejected write changes nothing. For a small change to an existing file, o6y_edit is safer.",
    inputSchema: { target: TARGET, content: z.string().describe("The whole file: ---\\nsummary: ...\\n---\\nbody") },
    annotations: { destructiveHint: true, idempotentHint: true }
  }, async (a) => {
    const t = resolveTarget(load(), layers, cwd, a.target);
    if (typeof t === "string")
      return fail(t);
    if (t.kind === "manual")
      return fail("The manual is part of o6y; it cannot be written.");
    const managed = managedReason(t.info);
    if (managed)
      return fail(`[o6y] ${managed}`);
    return commitFile(layers, t.path, a.content, "o6y_write");
  });
  server.registerTool("o6y_edit", {
    title: "Edit memory",
    description: "Replace text in an existing o6y object or schema. old_string must appear exactly once (or set replace_all). The result is validated before it is saved; a rejected edit changes nothing.",
    inputSchema: {
      target: TARGET,
      old_string: z.string().min(1).describe("Exact text to replace, including whitespace"),
      new_string: z.string(),
      replace_all: z.boolean().optional()
    },
    annotations: { destructiveHint: true }
  }, async (a) => {
    const t = resolveTarget(load(), layers, cwd, a.target);
    if (typeof t === "string")
      return fail(t);
    if (t.kind === "manual")
      return fail("The manual is part of o6y; it cannot be edited.");
    const managed = managedReason(t.info);
    if (managed)
      return fail(`[o6y] ${managed}`);
    const current = readOrNull(t.path);
    if (current === null)
      return fail(`${displayPath(t.path)} does not exist; create it with o6y_write.`);
    const count = current.split(a.old_string).length - 1;
    if (count === 0)
      return fail("old_string was not found; o6y_show the target to see its current content.");
    if (count > 1 && !a.replace_all)
      return fail(`old_string appears ${count} times; add context to make it unique, or set replace_all.`);
    const next = a.replace_all ? current.split(a.old_string).join(a.new_string) : current.replace(a.old_string, () => a.new_string);
    return commitFile(layers, t.path, next, "o6y_edit");
  });
  server.registerTool("o6y_cli", {
    title: "Run an o6y command",
    description: 'Run an `o6y` command, as argv without the leading `o6y`, e.g. ["mv", "note/a", "note/b"], ["lint"], ["field", "rename", "person", "role", "title"], ["set", "note/a", "pinned=true"], ["rm", "note/a"], ["help"]. Write commands validate the whole change before touching anything and accept --dry-run. `["help", "<command>"]` shows a command\'s options.',
    inputSchema: { args: z.array(z.string()).min(1) },
    annotations: { destructiveHint: true }
  }, async (a) => {
    if (NOT_VIA_CLI.has(a.args[0]))
      return fail(`\`o6y ${a.args[0]}\` can't run through o6y_cli.`);
    const isLint = a.args[0] === "lint";
    return cli(a.args, { errorOnReject: !isLint });
  });
  return server;
}
function packageVersion() {
  try {
    return JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")).version;
  } catch {
    return "0.0.0";
  }
}
async function serve(opts, transport) {
  const server = createServer(opts);
  const closed = new Promise((resolve2) => {
    server.server.onclose = () => resolve2();
  });
  await server.connect(transport);
  await closed;
}
export {
  createServer,
  prepareStores,
  serve
};
