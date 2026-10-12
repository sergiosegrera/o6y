import { homedir } from "node:os";
import { basename, join } from "node:path";
import { normalizeLinkValue } from "./links.ts";
import { describeField } from "./schema.ts";
import { formatIssues, INDEX_FILE, type ObjectEntry, SCHEMA_FILE, type Store, type TypeEntry } from "./store.ts";

/** Objects listed per type in the root index before deferring to the type index. */
const ROOT_INDEX_PER_TYPE = 50;
/** Share of the prompt's object budget reserved for the most recently changed objects. */
const RECENT_SHARE = 0.3;
/** Shares of the object budget that `alwaysList` types and neighbors of directory matches may take. */
const ALWAYS_SHARE = 0.35;
const NEIGHBOR_SHARE = 0.4;

/** Shortens paths under the home directory to `~/…`; long absolute paths invite typos. */
export function displayPath(path: string, home = homedir()): string {
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

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
  if (obj.pinned) values.push("pinned");
  if (store.layers.length > 1 && obj.layer.name === "project") values.push("project");
  const meta = values.length ? ` (${values.join(" · ")})` : "";
  return `- [[${obj.id}]]${meta} — ${obj.summary || "(no summary)"}`;
}

/** `- [[id]] — summary`: prompt lines leave index fields to index.md. */
function promptLine(store: Store, obj: ObjectEntry): string {
  const project = store.layers.length > 1 && obj.layer.name === "project" ? " (project)" : "";
  return `- [[${obj.id}]]${project} — ${obj.summary || "(no summary)"}`;
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
  const lines = ["# o6y index (virtual, generated)", "", "Stores:", ...store.layers.map((l) => `- ${l.name}: ${displayPath(l.root)}`)];
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
      lines.push(`… ${objects.length - ROOT_INDEX_PER_TYPE} more: read ${displayPath(join(type.layer.root, type.name, INDEX_FILE))}`);
    }
  }

  const wanted = wantedLines(store, undefined, 50);
  if (wanted.length) lines.push("", `## Wanted pages (${store.wanted.size}) — linked but not written yet`, "", ...wanted);

  const errors = store.errors();
  const warnings = store.issues.filter((i) => i.severity === "warning");
  if (errors.length || warnings.length) {
    lines.push("", `## Issues: ${errors.length} errors, ${warnings.length} warnings (run o6y lint for details)`);
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
    `Schema: ${displayPath(type.path)}`,
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
- Objects are <store>/<type>/<kebab-slug>.md with YAML frontmatter. \`summary\` (one line, max {MAX} chars; keep it well under) is required; other fields come from <type>/${SCHEMA_FILE}, whose body also says how to write that type. Before your first write to a type in a session, read its <type>/${SCHEMA_FILE}.
- Set \`pinned: true\` on an object to load its full content in every session. Reserve it for critical, always-relevant knowledge; the total is capped by \`pinnedBudget\`.
- Link objects with [[type/slug]]. Links to things that don't exist yet are allowed (reported as warnings / wanted pages).
- ${INDEX_FILE} files are virtual: <store>/${INDEX_FILE} is the full catalog, <store>/<type>/${INDEX_FILE} lists one type. Reading an object shows its backlinks.
- Writes are validated; when one is rejected, fix it and retry. Bash changes to a store are validated as a transaction and rolled back if they break it.
- The \`o6y\` shell command searches and maintains memory: \`o6y query <text>\` (or --type/--where/--links-to), \`o6y lint\`, and validated multi-file changes such as \`o6y mv\` (rename + relink), \`o6y merge\`, \`o6y field rename\`. Prefer it over hand-written sed/perl. \`o6y help\` lists everything.
- Consult memory before work that touches what it covers (people, preferences, decisions, notes). Summaries are only pointers: read every object relevant to the task (including the people involved) before advising or acting. Record durable knowledge you learn — the tribal knowledge a teammate would need — not task chatter. Update existing objects rather than duplicating them. Project-specific → project store; shared → global store.`;

/** Objects changed within this window of each other, in numbers of at least BULK_MIN, are a bulk change. */
const BULK_WINDOW_MS = 120_000;
const BULK_MIN = 8;

/**
 * Objects touched by a bulk change (a migration, a cleanup), detected as many objects with
 * modification times close together. They are skipped when ranking by recency so one big
 * transaction doesn't take over the "recent" share.
 */
export function bulkChanged(objects: ObjectEntry[]): Set<string> {
  const sorted = [...objects].sort((a, b) => a.mtimeMs - b.mtimeMs);
  const bulk = new Set<string>();
  let lo = 0;
  for (let hi = 0; hi < sorted.length; hi++) {
    while (sorted[hi]!.mtimeMs - sorted[lo]!.mtimeMs > BULK_WINDOW_MS) lo++;
    if (hi - lo + 1 >= BULK_MIN) for (let i = lo; i <= hi; i++) bulk.add(sorted[i]!.id);
  }
  return bulk;
}

const PATH_TOKEN = /(?:^|[\s(,;])((?:~\/|\/)[^\s,;()]+)/g;

/** Absolute or `~/` paths in a field value, including paths inside prose ("~/x (primary) + ~/y"). */
function pathValues(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    for (const m of value.matchAll(PATH_TOKEN)) out.push(m[1]!);
  } else if (Array.isArray(value)) {
    for (const v of value) pathValues(v, out);
  }
  return out;
}

/**
 * Objects relevant to where the agent is working: an object with a path field containing one of
 * `workPaths` (e.g. `location: ~/Projects/north` for cwd ~/Projects/north/api), or whose slug is
 * the directory's name (`direct`), plus the objects that link to those (`linked`). Outgoing links
 * are left out: a hub like system/north links to half the store.
 */
export function relevantObjects(store: Store, workPaths: string[], home = homedir()): { direct: Set<string>; linked: Set<string> } {
  const direct = new Set<string>();
  const names = new Set(workPaths.map((p) => basename(p).toLowerCase()));
  for (const obj of store.objects.values()) {
    if (names.has(obj.slug)) {
      direct.add(obj.id);
      continue;
    }
    for (const raw of Object.values(obj.data).flatMap((v) => pathValues(v))) {
      const p = (raw.startsWith("~/") ? join(home, raw.slice(2)) : raw).replace(/\/+$/, "");
      if (!p || p === home) continue;
      if (workPaths.some((w) => w === p || w.startsWith(`${p}/`))) {
        direct.add(obj.id);
        break;
      }
    }
  }
  const linked = new Set<string>();
  for (const id of direct) for (const s of store.backlinks.get(id) ?? []) linked.add(s);
  for (const id of direct) linked.delete(id);
  return { direct, linked };
}

export interface PromptOptions {
  /** Absolute directories the agent is working in (cwd, repository root), for relevance ranking. */
  workPaths?: string[];
}

/**
 * The <o6y> system prompt section. Rules, guidance and pinned objects are always included; the
 * object catalog below them is bounded by `promptBudget` characters. Every object is listed at
 * least by name; full lines (with summary) go first to `alwaysList` types, then objects relevant
 * to the working directory, then recently changed objects (bulk changes excluded), then the
 * most linked.
 */
export interface PromptStats {
  /** Characters of each part of the section. */
  rules: number;
  guidance: number;
  pinned: number;
  catalog: number;
  /** Characters of full lines (against `budget`) and of slug lists (against `namesBudget`). */
  lines: number;
  names: number;
  budget: number;
  namesBudget: number;
  objects: number;
  /** Objects shown with a full line, by slug only, or not at all. */
  full: number;
  named: number;
  hidden: number;
  /** Objects boosted for the working directory (direct matches, then linked). */
  relevant: string[];
}

export function renderPromptSection(store: Store, options: PromptOptions = {}): string {
  return buildPromptSection(store, options).text;
}

/** The prompt section plus a breakdown of where its characters and budget went. */
export function buildPromptSection(store: Store, options: PromptOptions = {}): { text: string; stats: PromptStats } {
  const rules = RULES.replace("{MAX}", String(store.settings.summaryMaxLength));
  const head: string[] = [rules, "", "Stores:", ...store.layers.map((l) => `- ${l.name}: ${displayPath(l.root)}`)];
  const guidanceStart = head.join("\n").length;
  for (const layer of store.layers) {
    const guidance = store.rootGuidance.get(layer.name);
    if (guidance) head.push("", `Guidance (${layer.name}):`, guidance);
  }
  const pinnedStart = head.join("\n").length;
  const pinned = store.pinnedObjects();
  if (pinned.length) {
    head.push("", "Pinned (always loaded):");
    for (const obj of pinned) head.push("", `### [[${obj.id}]] — ${obj.summary}`, obj.body.trim());
  }
  const headLength = head.join("\n").length;

  const types = sortedTypes(store);
  // Fields only matter when writing, and the agent reads the schema first; index.md has them.
  const headers = new Map(
    types.map((t) => [
      t.name,
      [`## ${t.name} (${store.objectsOfType(t.name).length})${store.layers.length > 1 ? ` [${t.layer.name}]` : ""} — ${t.schema.description}`],
    ]),
  );
  const NAMES_PREFIX = "also: ";
  const all = [...store.objects.values()];
  const lineOf = new Map(all.map((o) => [o.id, promptLine(store, o)]));
  const nameOf = (o: ObjectEntry) => (store.layers.length > 1 && o.layer.name === "project" ? `${o.slug} [project]` : o.slug);
  const lineCost = (o: ObjectEntry) => lineOf.get(o.id)!.length + 1;
  const nameCost = (o: ObjectEntry) => nameOf(o).length + 2;
  const fixed = [...headers.values()].reduce((n, h) => n + h.join("\n").length + 2, 0) + 300;
  const budget = Math.max(0, store.settings.promptBudget - fixed);

  // Priority order for full lines.
  const ranked = rankedObjects(store);
  const { direct, linked } = relevantObjects(store, options.workPaths ?? []);
  const bulk = bulkChanged(all);
  const recent = all
    .filter((o) => !bulk.has(o.id))
    .sort((a, b) => b.mtimeMs - a.mtimeMs || a.id.localeCompare(b.id));
  const groups: { objects: ObjectEntry[]; limit: number }[] = [
    { objects: ranked.filter((o) => direct.has(o.id)), limit: budget },
    { objects: ranked.filter((o) => store.types.get(o.type)?.schema.alwaysList), limit: budget * ALWAYS_SHARE },
    { objects: ranked.filter((o) => linked.has(o.id)), limit: budget * NEIGHBOR_SHARE },
    { objects: recent, limit: budget * RECENT_SHARE },
    { objects: ranked, limit: budget },
  ];

  // Full lines fill promptBudget in priority order. Every other object is then listed by slug,
  // outside that budget (names have their own, larger namesBudget), in the same order.
  const full = new Set<string>();
  let used = 0;
  const order: ObjectEntry[] = [];
  const ordered = new Set<string>();
  for (const group of groups) {
    let spent = 0;
    for (const obj of group.objects) {
      if (!ordered.has(obj.id)) {
        ordered.add(obj.id);
        order.push(obj);
      }
      if (full.has(obj.id) || obj.pinned) continue; // pinned objects are already in full above
      const cost = lineCost(obj);
      if (used + cost > budget || spent + cost > group.limit) continue;
      full.add(obj.id);
      used += cost;
      spent += cost;
    }
  }
  const named = new Set<string>();
  let namesUsed = 0;
  for (const obj of order) {
    if (full.has(obj.id) || namesUsed + nameCost(obj) > store.settings.namesBudget) continue;
    named.add(obj.id);
    namesUsed += nameCost(obj);
  }

  const body: string[] = [];
  for (const type of types) {
    const objects = store
      .objectsOfType(type.name)
      .sort((a, b) => inbound(store, b) - inbound(store, a) || b.mtimeMs - a.mtimeMs || a.id.localeCompare(b.id));
    body.push("", ...headers.get(type.name)!);
    body.push(...objects.filter((o) => full.has(o.id)).map((o) => lineOf.get(o.id)!));
    const names = objects.filter((o) => named.has(o.id)).sort((a, b) => a.slug.localeCompare(b.slug));
    if (names.length) body.push(`${NAMES_PREFIX}${names.map(nameOf).join(", ")}`);
    const hidden = objects.length - names.length - objects.filter((o) => full.has(o.id)).length;
    if (hidden > 0) body.push(`… ${hidden} more: read ${displayPath(join(type.layer.root, type.name, INDEX_FILE))}`);
  }
  const reasons = [
    direct.size && "relevant to this directory",
    types.some((t) => t.schema.alwaysList) && "always-listed types",
    "recently changed",
    "most linked",
  ].filter(Boolean);
  const summary =
    full.size < store.objects.size
      ? `\nMemory: ${store.objects.size} objects in ${store.types.size} types. Full lines for ${full.size} (${reasons.join(", ")}); the rest by slug under "${NAMES_PREFIX.trim()}" — the file is <store>/<type>/<slug>.md.`
      : `\nMemory: ${store.objects.size} objects in ${store.types.size} types.`;
  const catalog = [summary, ...body].join("\n");
  return {
    text: `${head.join("\n")}\n${catalog}`,
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
      relevant: [...direct, ...linked],
    },
  };
}
