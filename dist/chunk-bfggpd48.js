#!/usr/bin/env node
import {
  INDEX_FILE,
  SCHEMA_FILE,
  describeField,
  formatIssues,
  normalizeLinkValue
} from "./chunk-cttfmfym.js";

// src/core/render.ts
import { homedir } from "node:os";
import { basename, join } from "node:path";
var ROOT_INDEX_PER_TYPE = 50;
var RECENT_SHARE = 0.3;
var LOCAL_RECENT_SHARE = 0.1;
var ALWAYS_SHARE = 0.35;
var NEIGHBOR_SHARE = 0.4;
function displayPath(path, home = homedir()) {
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}
function fieldsLine(type) {
  const fields = Object.entries(type.schema.fields).map(([name, f]) => describeField(name, f));
  return ["summary*: string", ...fields].join(", ");
}
function formatValue(value, isLink) {
  if (value === undefined || value === null || value === "")
    return;
  if (isLink)
    return normalizeLinkValue(value)?.join(", ");
  if (value instanceof Date)
    return value.toISOString().slice(0, 10);
  if (Array.isArray(value))
    return value.map(String).join(", ");
  if (typeof value === "object")
    return;
  return String(value);
}
function objectLine(store, obj) {
  const schema = store.types.get(obj.type)?.schema;
  const values = (schema?.index ?? []).map((name) => formatValue(obj.data[name], schema.fields[name]?.type === "link")).filter((v) => v !== undefined);
  if (obj.pinned)
    values.push("pinned");
  if (store.layers.length > 1 && obj.layer.name === "project")
    values.push("project");
  const meta = values.length ? ` (${values.join(" · ")})` : "";
  return `- [[${obj.id}]]${meta} — ${obj.summary || "(no summary)"}`;
}
function promptLine(store, obj) {
  const project = store.layers.length > 1 && obj.layer.name === "project" ? " (project)" : "";
  return `- [[${obj.id}]]${project} — ${obj.summary || "(no summary)"}`;
}
function inbound(store, obj) {
  return store.backlinks.get(obj.id)?.size ?? 0;
}
function rankedObjects(store) {
  return [...store.objects.values()].sort((a, b) => inbound(store, b) - inbound(store, a) || b.mtimeMs - a.mtimeMs || a.id.localeCompare(b.id));
}
function sortedTypes(store) {
  return [...store.types.values()].sort((a, b) => a.name.localeCompare(b.name));
}
function typeHeader(store, type, level) {
  const count = store.objectsOfType(type.name).length;
  const where = store.layers.length > 1 ? ` [${type.layer.name}]` : "";
  return [`${level} ${type.name} (${count})${where} — ${type.schema.description}`, `fields: ${fieldsLine(type)}`];
}
function wantedLines(store, filter = () => true, limit = Infinity) {
  return [...store.wanted].filter(([id]) => filter(id)).sort(([a], [b]) => a.localeCompare(b)).slice(0, limit).map(([id, sources]) => `- [[${id}]] ← ${[...sources].sort().join(", ")}`);
}
function renderRootIndex(store) {
  const lines = ["# o6y index (virtual, generated)", "", "Stores:", ...store.layers.map((l) => `- ${l.name}: ${displayPath(l.root)}`)];
  for (const layer of store.layers) {
    const guidance = store.rootGuidance.get(layer.name);
    if (guidance)
      lines.push("", `Guidance (${layer.name}):`, guidance);
  }
  lines.push("", `${store.objects.size} objects in ${store.types.size} types. Full schema and writing guidance: <store>/<type>/${SCHEMA_FILE}.`);
  for (const type of sortedTypes(store)) {
    lines.push("", ...typeHeader(store, type, "##"));
    const objects = store.objectsOfType(type.name).sort((a, b) => inbound(store, b) - inbound(store, a) || a.id.localeCompare(b.id));
    for (const obj of objects.slice(0, ROOT_INDEX_PER_TYPE))
      lines.push(objectLine(store, obj));
    if (objects.length > ROOT_INDEX_PER_TYPE) {
      lines.push(`… ${objects.length - ROOT_INDEX_PER_TYPE} more: read ${displayPath(join(type.layer.root, type.name, INDEX_FILE))}`);
    }
  }
  const wanted = wantedLines(store, undefined, 50);
  if (wanted.length)
    lines.push("", `## Wanted pages (${store.wanted.size}) — linked but not written yet`, "", ...wanted);
  const errors = store.errors();
  const warnings = store.issues.filter((i) => i.severity === "warning");
  if (errors.length || warnings.length) {
    lines.push("", `## Issues: ${errors.length} errors, ${warnings.length} warnings (run o6y lint for details)`);
    if (errors.length)
      lines.push("", formatIssues(errors.slice(0, 20), store.layers));
  }
  return lines.join(`
`) + `
`;
}
function renderTypeIndex(store, typeName) {
  const type = store.types.get(typeName);
  if (!type)
    return;
  const objects = store.objectsOfType(typeName);
  const lines = [
    `# ${typeName} (virtual index, ${objects.length} objects)`,
    "",
    type.schema.description,
    "",
    `Schema: ${displayPath(type.path)}`,
    `Fields: ${fieldsLine(type)}`
  ];
  if (type.schema.guidance)
    lines.push("", "## Guidance", "", type.schema.guidance);
  lines.push("", "## Objects", "");
  if (!objects.length)
    lines.push("(none yet)");
  for (const obj of objects) {
    const n = inbound(store, obj);
    lines.push(`${objectLine(store, obj)}${n ? ` (${n} backlinks)` : ""}`);
  }
  const wanted = wantedLines(store, (id) => id.startsWith(`${typeName}/`));
  if (wanted.length)
    lines.push("", "## Wanted (linked but not written yet)", "", ...wanted);
  return lines.join(`
`) + `
`;
}
function renderObjectFooter(store, id, path) {
  const backlinks = store.backlinksOf(id);
  const lines = ["", "---", `[o6y] ${id} — backlinks (${backlinks.length}):`];
  for (const source of backlinks) {
    lines.push(`- [[${source}]] — ${store.objects.get(source)?.summary ?? ""}`);
  }
  const issues = store.issuesFor(path).filter((i) => i.severity !== "info");
  if (issues.length) {
    lines.push("[o6y] issues:");
    for (const i of issues)
      lines.push(`- [${i.severity}] ${i.message}`);
  }
  lines.push("(This footer is generated by o6y and is not part of the file.)");
  return lines.join(`
`);
}
var RULES = `o6y is your persistent, typed memory: a wiki of markdown files you read and write with your normal tools. Load the \`o6y\` skill for the full manual (schema syntax, links, layers, migrations) before creating or changing schemas or doing anything non-trivial in it.
- Objects are <store>/<type>/<kebab-slug>.md with YAML frontmatter. \`summary\` (one line, max {MAX} chars; keep it well under) is required; other fields come from <type>/${SCHEMA_FILE}, whose body also says how to write that type. Before your first write to a type in a session, read its <type>/${SCHEMA_FILE}.
- Set \`pinned: true\` on an object to load its full content in every session. Reserve it for critical, always-relevant knowledge; the total is capped by \`pinnedBudget\`.
- Link objects with [[type/slug]]. Links to things that don't exist yet are allowed (reported as warnings / wanted pages).
- ${INDEX_FILE} files are virtual: <store>/${INDEX_FILE} is the full catalog, <store>/<type>/${INDEX_FILE} lists one type. Reading an object shows its backlinks.
- Writes are validated; when one is rejected, fix it and retry. Bash changes to a store are validated as a transaction and rolled back if they break it.
- The \`o6y\` shell command searches and maintains memory: {SEARCH}\`o6y lint\`, and validated multi-file changes such as \`o6y mv\` (rename + relink), \`o6y merge\`, \`o6y field rename\`. Prefer it over hand-written sed/perl. \`o6y help\` lists everything.
- Consult memory before work that touches what it covers (people, preferences, decisions, notes). Summaries are only pointers: read every object relevant to the task (including the people involved) before advising or acting.{RELEVANT} Record durable knowledge you learn — the tribal knowledge a teammate would need — not task chatter. Update existing objects rather than duplicating them. Project-specific → project store; shared → global store.`;
var MCP_RULES = `o6y is your persistent, typed memory: a wiki of markdown objects you read and change through the o6y MCP tools. Change it only through them, never by editing store files with other tools: they validate and log every change. \`o6y_show manual\` is the full manual (schema syntax, links, layers, migrations); read it before creating or changing schemas or doing anything non-trivial. It is written for the pi integration: where it says to use read/write/edit on a store file, use o6y_show/o6y_write/o6y_edit on that path or id, and run \`o6y\` commands with o6y_cli.
- Objects are <type>/<kebab-slug> (the file <store>/<type>/<slug>.md) with YAML frontmatter. \`summary\` (one line, max {MAX} chars; keep it well under) is required; other fields come from the type's schema (\`o6y_show <type>/.schema\`), whose body also says how to write that type. Before your first write to a type in a session, read its schema.
- Set \`pinned: true\` on an object to load its full content in every session. Reserve it for critical, always-relevant knowledge; the total is capped by \`pinnedBudget\`.
- Link objects with [[type/slug]]. Links to things that don't exist yet are allowed (reported as warnings / wanted pages).
- o6y_show takes an id, a schema (\`<type>/.schema\`, \`.schema\`), \`index\` (the full catalog), \`<type>/index\` (one type), or any path under a store listed below. Showing an object lists its backlinks.
- o6y_write and o6y_edit validate the change before saving it; when one is rejected, nothing was changed: fix it and retry. Find objects with {SEARCH}and use o6y_cli for \`o6y lint\` and validated multi-file changes such as \`o6y mv\` (rename + relink), \`o6y merge\`, \`o6y field rename\`, \`o6y rm\` (\`help\` lists everything).
- Consult memory before work that touches what it covers (people, preferences, decisions, notes). Summaries are only pointers: read every object relevant to the task (including the people involved) before advising or acting. Record durable knowledge you learn — the tribal knowledge a teammate would need — not task chatter. Update existing objects rather than duplicating them. Project-specific → project store; shared → global store.
- The memory below is as of the start of this session; the tools always see the current store.`;
var MCP_PLAIN_SEARCH = "o6y_query (text, or type/where/links_to filters) ";
var MCP_SEMANTIC_SEARCH = 'o6y_search (by meaning; use it before work memory may cover; "No matching objects." means it has nothing) or o6y_query (exact type/where/links_to filters), ';
var PLAIN_SEARCH = "`o6y query <text>` (or --type/--where/--links-to), ";
var SEMANTIC_SEARCH = '`o6y search "<question>"` finds objects by meaning (use it before work memory may cover; "No matching objects." means it has nothing), `o6y query` for exact filters (--type/--where/--links-to), ';
var RELEVANT_NOTE = " A user message may come with an <o6y-relevant> list of objects that look relevant: read the ones that apply.";
var BULK_WINDOW_MS = 120000;
var BULK_MIN = 8;
function bulkChanged(objects) {
  const sorted = [...objects].sort((a, b) => a.mtimeMs - b.mtimeMs);
  const bulk = new Set;
  let lo = 0;
  for (let hi = 0;hi < sorted.length; hi++) {
    while (sorted[hi].mtimeMs - sorted[lo].mtimeMs > BULK_WINDOW_MS)
      lo++;
    if (hi - lo + 1 >= BULK_MIN)
      for (let i = lo;i <= hi; i++)
        bulk.add(sorted[i].id);
  }
  return bulk;
}
var PATH_TOKEN = /(?:^|[\s(,;])((?:~\/|\/)[^\s,;()]+)/g;
function pathValues(value, out = []) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("/") || trimmed.startsWith("~/"))
      for (const m of trimmed.matchAll(PATH_TOKEN))
        out.push(m[1]);
  } else if (Array.isArray(value)) {
    for (const v of value)
      pathValues(v, out);
  }
  return out;
}
function relevantObjects(store, workPaths, home = homedir()) {
  const direct = new Set;
  const names = new Set(workPaths.map((p) => basename(p).toLowerCase()));
  for (const obj of store.objects.values()) {
    if (names.has(obj.slug)) {
      direct.add(obj.id);
      continue;
    }
    const values = Object.entries(obj.data).filter(([field]) => field !== "summary").map(([, v]) => v);
    for (const raw of values.flatMap((v) => pathValues(v))) {
      const p = (raw.startsWith("~/") ? join(home, raw.slice(2)) : raw).replace(/\/+$/, "");
      if (!p || p === home)
        continue;
      if (workPaths.some((w) => w === p || w.startsWith(`${p}/`))) {
        direct.add(obj.id);
        break;
      }
    }
  }
  const linked = new Set;
  for (const id of direct)
    for (const s of store.backlinks.get(id) ?? [])
      linked.add(s);
  for (const id of direct)
    linked.delete(id);
  return { direct, linked };
}
function renderPromptSection(store, options = {}) {
  return buildPromptSection(store, options).text;
}
function buildPromptSection(store, options = {}) {
  const rules = options.mcp ? MCP_RULES.replace("{MAX}", String(store.settings.summaryMaxLength)).replace("{SEARCH}", store.semantic.enabled ? MCP_SEMANTIC_SEARCH : MCP_PLAIN_SEARCH) : RULES.replace("{MAX}", String(store.settings.summaryMaxLength)).replace("{SEARCH}", store.semantic.enabled ? SEMANTIC_SEARCH : PLAIN_SEARCH).replace("{RELEVANT}", store.semantic.enabled ? RELEVANT_NOTE : "");
  const head = [rules, "", "Stores:", ...store.layers.map((l) => `- ${l.name}: ${displayPath(l.root)}`)];
  const guidanceStart = head.join(`
`).length;
  for (const layer of store.layers) {
    const guidance = store.rootGuidance.get(layer.name);
    if (guidance)
      head.push("", `Guidance (${layer.name}):`, guidance);
  }
  const pinnedStart = head.join(`
`).length;
  const pinned = store.pinnedObjects();
  if (pinned.length) {
    head.push("", "Pinned (always loaded):");
    for (const obj of pinned)
      head.push("", `### [[${obj.id}]] — ${obj.summary}`, obj.body.trim());
  }
  const headLength = head.join(`
`).length;
  const types = sortedTypes(store);
  const headers = new Map(types.map((t) => [
    t.name,
    [`## ${t.name} (${store.objectsOfType(t.name).length})${store.layers.length > 1 ? ` [${t.layer.name}]` : ""} — ${t.schema.description}`]
  ]));
  const NAMES_PREFIX = "also: ";
  const all = [...store.objects.values()];
  const lineOf = new Map(all.map((o) => [o.id, promptLine(store, o)]));
  const nameOf = (o) => store.layers.length > 1 && o.layer.name === "project" ? `${o.slug} [project]` : o.slug;
  const lineCost = (o) => lineOf.get(o.id).length + 1;
  const nameCost = (o) => nameOf(o).length + 2;
  const fixed = [...headers.values()].reduce((n, h) => n + h.join(`
`).length + 2, 0) + 300;
  const budget = Math.max(0, store.settings.promptBudget - fixed);
  const ranked = rankedObjects(store);
  const { direct, linked } = relevantObjects(store, options.workPaths ?? []);
  const bulk = bulkChanged(all);
  const recent = all.filter((o) => !bulk.has(o.id)).sort((a, b) => b.mtimeMs - a.mtimeMs || a.id.localeCompare(b.id));
  const priority = (o) => store.types.get(o.type)?.schema.priority ?? 0;
  const relevant = [...linked].map((id) => store.objects.get(id)).sort((a, b) => priority(b) - priority(a) || inbound(store, b) - inbound(store, a) || b.mtimeMs - a.mtimeMs || a.id.localeCompare(b.id));
  const local = direct.size > 0;
  const groups = [
    { objects: ranked.filter((o) => direct.has(o.id)), limit: budget },
    { objects: ranked.filter((o) => store.types.get(o.type)?.schema.alwaysList), limit: budget * ALWAYS_SHARE },
    { objects: relevant, limit: budget * NEIGHBOR_SHARE },
    { objects: recent, limit: budget * (local ? LOCAL_RECENT_SHARE : RECENT_SHARE) },
    { objects: relevant, limit: budget },
    { objects: ranked, limit: budget }
  ];
  const full = new Set;
  let used = 0;
  const order = [];
  const ordered = new Set;
  for (const group of groups) {
    let spent = 0;
    for (const obj of group.objects) {
      if (!ordered.has(obj.id)) {
        ordered.add(obj.id);
        order.push(obj);
      }
      if (full.has(obj.id) || obj.pinned)
        continue;
      const cost = lineCost(obj);
      if (used + cost > budget || spent + cost > group.limit)
        continue;
      full.add(obj.id);
      used += cost;
      spent += cost;
    }
  }
  const named = new Set;
  let namesUsed = 0;
  for (const obj of order) {
    if (full.has(obj.id) || namesUsed + nameCost(obj) > store.settings.namesBudget)
      continue;
    named.add(obj.id);
    namesUsed += nameCost(obj);
  }
  const body = [];
  for (const type of types) {
    const objects = store.objectsOfType(type.name).sort((a, b) => inbound(store, b) - inbound(store, a) || b.mtimeMs - a.mtimeMs || a.id.localeCompare(b.id));
    body.push("", ...headers.get(type.name));
    body.push(...objects.filter((o) => full.has(o.id)).map((o) => lineOf.get(o.id)));
    const names = objects.filter((o) => named.has(o.id)).sort((a, b) => a.slug.localeCompare(b.slug));
    if (names.length)
      body.push(`${NAMES_PREFIX}${names.map(nameOf).join(", ")}`);
    const hidden = objects.length - names.length - objects.filter((o) => full.has(o.id)).length;
    if (hidden > 0)
      body.push(`… ${hidden} more: read ${displayPath(join(type.layer.root, type.name, INDEX_FILE))}`);
  }
  const reasons = [
    direct.size && "relevant to this directory",
    types.some((t) => t.schema.alwaysList) && "always-listed types",
    "recently changed",
    "most linked"
  ].filter(Boolean);
  const summary = full.size < store.objects.size ? `
Memory: ${store.objects.size} objects in ${store.types.size} types. Full lines for ${full.size} (${reasons.join(", ")}); the rest by slug under "${NAMES_PREFIX.trim()}" — the file is <store>/<type>/<slug>.md.` : `
Memory: ${store.objects.size} objects in ${store.types.size} types.`;
  const catalog = [summary, ...body].join(`
`);
  return {
    text: `${head.join(`
`)}
${catalog}`,
    stats: {
      rules: rules.length,
      guidance: pinnedStart - guidanceStart,
      pinned: headLength - pinnedStart,
      catalog: catalog.length,
      lines: used,
      names: namesUsed,
      budget: store.settings.promptBudget,
      namesBudget: store.settings.namesBudget,
      objects: store.objects.size,
      full: full.size,
      named: named.size,
      hidden: store.objects.size - full.size - named.size,
      relevant: [...direct, ...linked]
    }
  };
}

export { displayPath, renderRootIndex, renderTypeIndex, renderObjectFooter, renderPromptSection, buildPromptSection };
