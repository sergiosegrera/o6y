import { join } from "node:path";
import { normalizeLinkValue } from "./links.ts";
import { describeField } from "./schema.ts";
import { formatIssues, INDEX_FILE, type ObjectEntry, SCHEMA_FILE, type Store, type TypeEntry } from "./store.ts";

/** Objects listed per type in the root index before deferring to the type index. */
const ROOT_INDEX_PER_TYPE = 50;
/** Share of the prompt's object budget reserved for the most recently changed objects. */
const RECENT_SHARE = 0.3;

function fieldsLine(type: TypeEntry): string {
  const fields = Object.entries(type.schema.fields).map(([name, f]) => describeField(name, f));
  return ["summary*: string", ...fields].join(", ");
}

function formatValue(value: unknown, isLink: boolean): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (isLink) return normalizeLinkValue(value)?.join(", ");
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (Array.isArray(value)) return value.map(String).join(", ");
  if (typeof value === "object") return undefined;
  return String(value);
}

/** `- [[id]] (index field values) — summary` */
function objectLine(store: Store, obj: ObjectEntry): string {
  const schema = store.types.get(obj.type)?.schema;
  const values = (schema?.index ?? [])
    .map((name) => formatValue(obj.data[name], schema!.fields[name]?.type === "link"))
    .filter((v): v is string => v !== undefined);
  if (store.layers.length > 1 && obj.layer.name === "project") values.push("project");
  const meta = values.length ? ` (${values.join(" · ")})` : "";
  return `- [[${obj.id}]]${meta} — ${obj.summary || "(no summary)"}`;
}

function inbound(store: Store, obj: ObjectEntry): number {
  return store.backlinks.get(obj.id)?.size ?? 0;
}

/** Objects ranked by inbound links, then most recently modified. */
export function rankedObjects(store: Store): ObjectEntry[] {
  return [...store.objects.values()].sort(
    (a, b) => inbound(store, b) - inbound(store, a) || b.mtimeMs - a.mtimeMs || a.id.localeCompare(b.id),
  );
}

function sortedTypes(store: Store): TypeEntry[] {
  return [...store.types.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function typeHeader(store: Store, type: TypeEntry, level: string): string[] {
  const count = store.objectsOfType(type.name).length;
  const where = store.layers.length > 1 ? ` [${type.layer.name}]` : "";
  return [`${level} ${type.name} (${count})${where} — ${type.schema.description}`, `fields: ${fieldsLine(type)}`];
}

function wantedLines(store: Store, filter: (id: string) => boolean = () => true, limit = Infinity): string[] {
  return [...store.wanted]
    .filter(([id]) => filter(id))
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(0, limit)
    .map(([id, sources]) => `- [[${id}]] ← ${[...sources].sort().join(", ")}`);
}

/** The full catalog: every type with its objects (bounded per type), wanted pages and issues. */
export function renderRootIndex(store: Store): string {
  const lines = ["# o6y index (virtual, generated)", "", "Stores:", ...store.layers.map((l) => `- ${l.name}: ${l.root}`)];
  for (const layer of store.layers) {
    const guidance = store.rootGuidance.get(layer.name);
    if (guidance) lines.push("", `Guidance (${layer.name}):`, guidance);
  }
  lines.push("", `${store.objects.size} objects in ${store.types.size} types. Full schema and writing guidance: <store>/<type>/${SCHEMA_FILE}.`);

  for (const type of sortedTypes(store)) {
    lines.push("", ...typeHeader(store, type, "##"));
    const objects = store.objectsOfType(type.name).sort((a, b) => inbound(store, b) - inbound(store, a) || a.id.localeCompare(b.id));
    for (const obj of objects.slice(0, ROOT_INDEX_PER_TYPE)) lines.push(objectLine(store, obj));
    if (objects.length > ROOT_INDEX_PER_TYPE) {
      lines.push(`… ${objects.length - ROOT_INDEX_PER_TYPE} more: read ${join(type.layer.root, type.name, INDEX_FILE)}`);
    }
  }

  const wanted = wantedLines(store, undefined, 50);
  if (wanted.length) lines.push("", `## Wanted pages (${store.wanted.size}) — linked but not written yet`, "", ...wanted);

  const errors = store.errors();
  const warnings = store.issues.filter((i) => i.severity === "warning");
  if (errors.length || warnings.length) {
    lines.push("", `## Issues: ${errors.length} errors, ${warnings.length} warnings (o6y_lint for details)`);
    if (errors.length) lines.push("", formatIssues(errors.slice(0, 20), store.layers));
  }
  return lines.join("\n") + "\n";
}

export function renderTypeIndex(store: Store, typeName: string): string | undefined {
  const type = store.types.get(typeName);
  if (!type) return undefined;
  const objects = store.objectsOfType(typeName);
  const lines = [
    `# ${typeName} (virtual index, ${objects.length} objects)`,
    "",
    type.schema.description,
    "",
    `Schema: ${type.path}`,
    `Fields: ${fieldsLine(type)}`,
  ];
  if (type.schema.guidance) lines.push("", "## Guidance", "", type.schema.guidance);
  lines.push("", "## Objects", "");
  if (!objects.length) lines.push("(none yet)");
  for (const obj of objects) {
    const n = inbound(store, obj);
    lines.push(`${objectLine(store, obj)}${n ? ` (${n} backlinks)` : ""}`);
  }
  const wanted = wantedLines(store, (id) => id.startsWith(`${typeName}/`));
  if (wanted.length) lines.push("", "## Wanted (linked but not written yet)", "", ...wanted);
  return lines.join("\n") + "\n";
}

/** Appended to an object when it is read. */
export function renderObjectFooter(store: Store, id: string, path: string): string {
  const backlinks = store.backlinksOf(id);
  const lines = ["", "---", `[o6y] ${id} — backlinks (${backlinks.length}):`];
  for (const source of backlinks) {
    lines.push(`- [[${source}]] — ${store.objects.get(source)?.summary ?? ""}`);
  }
  const issues = store.issuesFor(path).filter((i) => i.severity !== "info");
  if (issues.length) {
    lines.push("[o6y] issues:");
    for (const i of issues) lines.push(`- [${i.severity}] ${i.message}`);
  }
  lines.push("(This footer is generated by o6y and is not part of the file.)");
  return lines.join("\n");
}

const RULES = `o6y is your persistent, typed memory: a wiki of markdown files you read and write with your normal tools. Load the \`o6y\` skill for the full manual (schema syntax, links, layers, migrations) before creating or changing schemas or doing anything non-trivial in it.
- Objects are <store>/<type>/<kebab-slug>.md with YAML frontmatter. \`summary\` (one line, max {MAX} chars) is required; other fields come from <type>/${SCHEMA_FILE}, whose body also says how to write that type.
- Link objects with [[type/slug]]. Links to things that don't exist yet are allowed (reported as warnings / wanted pages).
- ${INDEX_FILE} files are virtual: <store>/${INDEX_FILE} is the full catalog, <store>/<type>/${INDEX_FILE} lists one type. Reading an object shows its backlinks.
- Writes are validated; when one is rejected, fix it and retry. Bash changes to a store are validated as a transaction and rolled back if they break it.
- Consult memory before work that touches what it covers (people, systems, conventions, processes, past decisions). Summaries are only pointers: read every object relevant to the task (including the people involved) before advising or acting. Record durable knowledge you learn — the tribal knowledge a teammate would need — not task chatter. Update existing objects rather than duplicating them. Project-specific → project store; shared → global store.`;

/**
 * The <o6y> system prompt section, bounded by `promptBudget` characters. Objects are grouped by
 * type; part of the budget goes to the most recently changed objects so new knowledge shows up
 * even before anything links to it, and the rest to the most linked ones.
 */
export function renderPromptSection(store: Store): string {
  const head: string[] = [
    RULES.replace("{MAX}", String(store.settings.summaryMaxLength)),
    "",
    "Stores:",
    ...store.layers.map((l) => `- ${l.name}: ${l.root}`),
  ];
  for (const layer of store.layers) {
    const guidance = store.rootGuidance.get(layer.name);
    if (guidance) head.push("", `Guidance (${layer.name}):`, guidance);
  }
  const types = sortedTypes(store);
  const headers = new Map(types.map((t) => [t.name, typeHeader(store, t, "##")]));
  const fixedLength =
    head.join("\n").length + [...headers.values()].reduce((n, h) => n + h.join("\n").length + 2, 0) + 200;

  const lineOf = new Map([...store.objects.values()].map((o) => [o.id, objectLine(store, o)]));
  const available = Math.max(0, store.settings.promptBudget - fixedLength);
  const chosen = new Set<string>();
  let used = 0;
  const take = (obj: ObjectEntry, limit: number): boolean => {
    if (chosen.has(obj.id)) return true;
    const cost = lineOf.get(obj.id)!.length + 1;
    if (used + cost > limit) return false;
    chosen.add(obj.id);
    used += cost;
    return true;
  };
  const recent = [...store.objects.values()].sort((a, b) => b.mtimeMs - a.mtimeMs || a.id.localeCompare(b.id));
  for (const obj of recent) if (!take(obj, available * RECENT_SHARE)) break;
  for (const obj of rankedObjects(store)) if (!take(obj, available)) break;

  const body: string[] = [];
  for (const type of types) {
    const objects = store
      .objectsOfType(type.name)
      .sort((a, b) => inbound(store, b) - inbound(store, a) || b.mtimeMs - a.mtimeMs || a.id.localeCompare(b.id));
    const shown = objects.filter((o) => chosen.has(o.id));
    body.push("", ...headers.get(type.name)!, ...shown.map((o) => lineOf.get(o.id)!));
    if (shown.length < objects.length) {
      body.push(`… ${objects.length - shown.length} more: read ${join(type.layer.root, type.name, INDEX_FILE)}`);
    }
  }
  const summary = `\nMemory: ${store.objects.size} objects in ${store.types.size} types${
    chosen.size < store.objects.size ? ` (showing ${chosen.size}: most recently changed and most linked)` : ""
  }.`;
  return [...head, summary, ...body].join("\n");
}
