#!/usr/bin/env node
import { createRequire } from "node:module";
var __require = /* @__PURE__ */ createRequire(import.meta.url);

// src/core/links.ts
var NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
var ID_RE = /^([a-z0-9]+(?:-[a-z0-9]+)*)\/([a-z0-9]+(?:-[a-z0-9]+)*)$/;
var WIKILINK_RE = /\[\[([^\]\n]+?)\]\]/g;
function extractBodyLinks(body) {
  const links = [];
  let inFence = false;
  body.split(`
`).forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      return;
    }
    if (inFence)
      return;
    const withoutInlineCode = line.replace(/`[^`]*`/g, "");
    for (const match of withoutInlineCode.matchAll(WIKILINK_RE)) {
      const target = (match[1] ?? "").split("|")[0].split("#")[0].trim();
      links.push({ target, line: i + 1 });
    }
  });
  return links;
}
function parseId(id) {
  const match = ID_RE.exec(id);
  return match ? { type: match[1], slug: match[2] } : undefined;
}
function normalizeLinkValue(value) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    const wiki = /^\[\[([^\]]+)\]\]$/.exec(trimmed);
    const inner = wiki ? wiki[1] : trimmed;
    return [inner.split("|")[0].split("#")[0].trim()];
  }
  if (Array.isArray(value)) {
    const out = [];
    for (const item of value) {
      const inner = normalizeLinkValue(item);
      if (!inner)
        return;
      out.push(...inner);
    }
    return out;
  }
  return;
}

// src/core/store.ts
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

// src/core/frontmatter.ts
import { parse } from "yaml";
var FENCE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n?---[ \t]*(?:\r?\n|$)/;
function parseDoc(text) {
  const match = FENCE.exec(text);
  if (!match)
    return { data: undefined, body: text };
  const body = text.slice(match[0].length);
  const raw = match[1] ?? "";
  if (raw.trim() === "")
    return { data: {}, body };
  try {
    const data = parse(raw);
    if (data === null || data === undefined)
      return { data: {}, body };
    if (typeof data !== "object" || Array.isArray(data)) {
      return { data: undefined, body, error: "frontmatter must be a YAML mapping (key: value pairs)" };
    }
    return { data, body };
  } catch (err) {
    const message = err instanceof Error ? err.message.split(`
`)[0] : String(err);
    return { data: undefined, body, error: `invalid YAML frontmatter: ${message}` };
  }
}

// src/core/schema.ts
var FIELD_TYPES = ["string", "number", "boolean", "date", "enum", "list", "link"];
var DEFAULT_SETTINGS = {
  summaryMaxLength: 80,
  promptBudget: 8000,
  pinnedBudget: 2500,
  namesBudget: 1e4
};
var RESERVED_FIELDS = ["summary", "pinned"];
function parseRootSchema(text) {
  const doc = parseDoc(text);
  if (doc.error)
    return { errors: [doc.error] };
  const data = doc.data ?? {};
  const errors = [];
  const settings = {};
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    const value = data[key];
    if (value === undefined)
      continue;
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
      errors.push(`setting \`${key}\` must be a positive integer`);
    } else {
      settings[key] = value;
    }
  }
  const format = data.o6yFormat;
  if (format !== undefined && (typeof format !== "number" || !Number.isInteger(format) || format <= 0)) {
    errors.push("`o6yFormat` is the store format version managed by o6y; leave it as a positive integer");
  }
  if (errors.length)
    return { errors };
  return { schema: { settings, guidance: doc.body.trim() }, errors };
}
function parseTypeSchema(text) {
  const doc = parseDoc(text);
  if (doc.error)
    return { errors: [doc.error] };
  if (!doc.data)
    return { errors: ["schema must start with YAML frontmatter (--- ... ---)"] };
  const errors = [];
  const description = doc.data.description;
  if (typeof description !== "string" || description.trim() === "") {
    errors.push("`description` is required (one line describing what this type represents)");
  }
  const rawFields = doc.data.fields ?? {};
  const fields = {};
  if (typeof rawFields !== "object" || rawFields === null || Array.isArray(rawFields)) {
    errors.push("`fields` must be a mapping of field name to field definition");
  } else {
    for (const [name, raw] of Object.entries(rawFields)) {
      if (RESERVED_FIELDS.includes(name)) {
        errors.push(`field \`${name}\` is reserved and implicit in every type; remove it`);
        continue;
      }
      const parsed = parseFieldSpec(name, raw);
      if (typeof parsed === "string")
        errors.push(parsed);
      else
        fields[name] = parsed;
    }
  }
  const rawIndex = doc.data.index ?? [];
  const index = [];
  if (!Array.isArray(rawIndex) || !rawIndex.every((f) => typeof f === "string")) {
    errors.push("`index` must be a list of field names to show in indexes, e.g. [status]");
  } else if (rawIndex.length > 3) {
    errors.push("`index` may list at most 3 fields (indexes must stay compact)");
  } else {
    for (const name of rawIndex) {
      if (!(name in fields))
        errors.push(`\`index\`: \`${name}\` is not a declared field`);
      else
        index.push(name);
    }
  }
  const alwaysList = doc.data.alwaysList ?? false;
  if (typeof alwaysList !== "boolean")
    errors.push("`alwaysList` must be true or false");
  if (errors.length)
    return { errors };
  return {
    schema: { description: description.trim(), fields, index, alwaysList: alwaysList === true, guidance: doc.body.trim() },
    errors
  };
}
var FIELD_KEYS = new Set(["type", "required", "description", "values", "to", "many"]);
function parseFieldSpec(name, raw) {
  const where = `field \`${name}\``;
  const spec = typeof raw === "string" ? { type: raw } : raw;
  if (typeof spec !== "object" || spec === null || Array.isArray(spec)) {
    return `${where}: must be a type name (e.g. \`string\`) or a mapping like { type: string, required: true }`;
  }
  const obj = spec;
  for (const key of Object.keys(obj)) {
    if (!FIELD_KEYS.has(key))
      return `${where}: unknown option \`${key}\` (allowed: ${[...FIELD_KEYS].join(", ")})`;
  }
  const type = obj.type;
  if (typeof type !== "string" || !FIELD_TYPES.includes(type)) {
    return `${where}: \`type\` must be one of ${FIELD_TYPES.join(", ")}`;
  }
  if (obj.required !== undefined && typeof obj.required !== "boolean")
    return `${where}: \`required\` must be true or false`;
  if (obj.description !== undefined && typeof obj.description !== "string")
    return `${where}: \`description\` must be a string`;
  const field = { type, required: obj.required === true };
  if (typeof obj.description === "string")
    field.description = obj.description;
  if (type === "enum") {
    if (!Array.isArray(obj.values) || obj.values.length === 0 || !obj.values.every((v) => typeof v === "string")) {
      return `${where}: enum needs \`values\`, a non-empty list of strings`;
    }
    field.values = obj.values;
  } else if (obj.values !== undefined) {
    return `${where}: \`values\` is only valid for enum fields`;
  }
  if (type === "link") {
    const to = obj.to ?? "any";
    if (to === "any")
      field.to = "any";
    else if (typeof to === "string" && NAME_RE.test(to))
      field.to = [to];
    else if (Array.isArray(to) && to.length > 0 && to.every((t) => typeof t === "string" && NAME_RE.test(t)))
      field.to = to;
    else
      return `${where}: \`to\` must be a type name, a list of type names, or \`any\``;
    if (obj.many !== undefined && typeof obj.many !== "boolean")
      return `${where}: \`many\` must be true or false`;
    field.many = obj.many === true;
  } else if (obj.to !== undefined || obj.many !== undefined) {
    return `${where}: \`to\`/\`many\` are only valid for link fields`;
  }
  return field;
}
function describeField(name, field) {
  let type = field.type;
  if (field.type === "enum")
    type = `enum(${field.values.join("|")})`;
  if (field.type === "link")
    type = `link→${field.to === "any" ? "any" : field.to.join("|")}${field.many ? "[]" : ""}`;
  return `${name}${field.required ? "*" : ""}: ${type}`;
}
var DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[T ][0-9:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/;
function validateFields(data, schema, settings) {
  const issues = [];
  const links = [];
  const summary = data.summary;
  if (summary === undefined || summary === null || summary === "") {
    issues.push({ field: "summary", message: `required (one line, max ${settings.summaryMaxLength} chars)` });
  } else if (typeof summary !== "string") {
    issues.push({ field: "summary", message: "must be a string" });
  } else if (summary.includes(`
`)) {
    issues.push({ field: "summary", message: "must be a single line" });
  } else if (summary.length > settings.summaryMaxLength) {
    issues.push({ field: "summary", message: `is ${summary.length} chars; max is ${settings.summaryMaxLength}` });
  }
  if (data.pinned !== undefined && typeof data.pinned !== "boolean") {
    issues.push({ field: "pinned", message: "must be true or false" });
  }
  for (const [name, field] of Object.entries(schema.fields)) {
    const value = data[name];
    if (value === undefined || value === null) {
      if (field.required)
        issues.push({ field: name, message: `required (${describeField(name, field)})` });
      continue;
    }
    const problem = checkValue(value, field);
    if (typeof problem === "string") {
      issues.push({ field: name, message: problem });
    } else if (problem) {
      for (const target of problem)
        links.push({ field: name, target, to: field.to });
    }
  }
  return { issues, links };
}
function checkValue(value, field) {
  switch (field.type) {
    case "string":
      return typeof value === "string" ? undefined : "must be a string";
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? undefined : "must be a number";
    case "boolean":
      return typeof value === "boolean" ? undefined : "must be true or false";
    case "date": {
      const str = value instanceof Date ? value.toISOString() : value;
      return typeof str === "string" && DATE_RE.test(str) ? undefined : "must be a date (YYYY-MM-DD or ISO datetime)";
    }
    case "enum":
      return typeof value === "string" && field.values.includes(value) ? undefined : `must be one of: ${field.values.join(", ")}`;
    case "list":
      return Array.isArray(value) && value.every((v) => typeof v === "string" || typeof v === "number") ? undefined : "must be a list of strings";
    case "link": {
      const targets = normalizeLinkValue(value);
      if (!targets)
        return "must be a link like `type/slug` or `[[type/slug]]`";
      if (!field.many && targets.length !== 1)
        return "must be a single link (this field is not `many`)";
      if (field.many && !Array.isArray(value) && targets.length !== 1)
        return "must be a list of links";
      for (const target of targets) {
        if (!parseId(target))
          return `\`${target}\` is not a valid link; use \`type/slug\` (kebab-case)`;
      }
      return targets;
    }
  }
}

// src/core/store.ts
var SCHEMA_FILE = ".schema.md";
var INDEX_FILE = "index.md";
var LOG_FILE = "log.md";
function canonicalPath(p) {
  let current = resolve(p);
  const rest = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current)
      break;
    rest.unshift(basename(current));
    current = parent;
  }
  try {
    current = realpathSync(current);
  } catch {}
  return rest.length ? join(current, ...rest) : current;
}
function makeLayers(globalRoot, projectRoot) {
  const layers = [{ name: "global", root: canonicalPath(globalRoot) }];
  if (projectRoot) {
    const root = canonicalPath(projectRoot);
    if (root !== layers[0].root)
      layers.push({ name: "project", root });
  }
  return layers;
}
function findLayer(layers, absPath) {
  const p = canonicalPath(absPath);
  return [...layers].sort((a, b) => b.root.length - a.root.length).find((layer) => p === layer.root || p.startsWith(layer.root + sep));
}
function classifyPath(layers, absPath) {
  const layer = findLayer(layers, absPath);
  if (!layer)
    return;
  const rel = relative(layer.root, canonicalPath(absPath));
  if (rel === "")
    return { kind: "invalid", layer, reason: "the store root itself is not a file" };
  const parts = rel.split(sep);
  if (parts.length === 1) {
    const name = parts[0];
    if (name === SCHEMA_FILE)
      return { kind: "root-schema", layer };
    if (name === INDEX_FILE)
      return { kind: "root-index", layer };
    if (name === LOG_FILE)
      return { kind: "log", layer };
    return {
      kind: "invalid",
      layer,
      reason: `only ${SCHEMA_FILE}, ${LOG_FILE} and type folders may live at the store root; objects go in <type>/<slug>.md`
    };
  }
  const type = parts[0];
  if (!NAME_RE.test(type)) {
    return { kind: "invalid", layer, reason: `type folder \`${type}\` must be kebab-case (a-z, 0-9, -)` };
  }
  if (parts.length > 2) {
    return { kind: "invalid", layer, reason: `no subfolders inside types; use ${type}/<slug>.md` };
  }
  const file = parts[1];
  if (file === SCHEMA_FILE)
    return { kind: "type-schema", layer, type };
  if (file === INDEX_FILE)
    return { kind: "type-index", layer, type };
  if (!file.endsWith(".md"))
    return { kind: "invalid", layer, reason: "objects must be .md files" };
  const slug = file.slice(0, -3);
  if (!NAME_RE.test(slug)) {
    return { kind: "invalid", layer, reason: `slug \`${slug}\` must be kebab-case (a-z, 0-9, -), e.g. ${type}/my-object.md` };
  }
  return { kind: "object", layer, type, slug, id: `${type}/${slug}` };
}
function walk(dir, depth, out) {
  if (depth > 3)
    return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== SCHEMA_FILE)
      continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory())
      walk(full, depth + 1, out);
    else if (entry.isFile())
      out.push(full);
  }
}
function readLayerFiles(layer, overlay) {
  const paths = [];
  if (existsSync(layer.root))
    walk(layer.root, 0, paths);
  const files = new Map;
  for (const path of paths) {
    if (overlay?.has(path))
      continue;
    try {
      files.set(path, { path, content: readFileSync(path, "utf8"), mtimeMs: statSync(path).mtimeMs });
    } catch {}
  }
  if (overlay) {
    const now = Date.now();
    for (const [path, content] of overlay) {
      if (content === null)
        continue;
      if (findLayer([layer], path))
        files.set(path, { path, content, mtimeMs: now });
    }
  }
  return [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
}

class Store {
  layers;
  settings;
  rootGuidance = new Map;
  types = new Map;
  objects = new Map;
  issues = [];
  backlinks = new Map;
  wanted = new Map;
  constructor(layers, overlay) {
    this.layers = layers;
    const filesByLayer = layers.map((layer) => ({ layer, files: readLayerFiles(layer, overlay) }));
    const settings = { ...DEFAULT_SETTINGS };
    const pendingTypes = [];
    const pendingObjects = [];
    for (const { layer, files } of filesByLayer) {
      for (const file of files) {
        const info = classifyPath(layers, file.path);
        if (!info || info.layer !== layer)
          continue;
        switch (info.kind) {
          case "root-schema": {
            const { schema, errors } = parseRootSchema(file.content);
            for (const message of errors)
              this.issue(file.path, "error", "root-schema", message);
            if (schema) {
              Object.assign(settings, schema.settings);
              if (schema.guidance)
                this.rootGuidance.set(layer.name, schema.guidance);
            }
            break;
          }
          case "type-schema":
            pendingTypes.push({ layer, type: info.type, file });
            break;
          case "object":
            pendingObjects.push({ info, file });
            break;
          case "log":
            break;
          case "root-index":
          case "type-index":
            this.issue(file.path, "error", "virtual-file", "index.md is generated by o6y and must not exist on disk; delete it");
            break;
          case "invalid":
            this.issue(file.path, "error", "invalid-path", info.reason);
            break;
        }
      }
    }
    this.settings = settings;
    for (const { layer, type, file } of pendingTypes) {
      const existing = this.types.get(type);
      if (existing) {
        this.issue(file.path, "error", "shadowed-type", `type \`${type}\` is already defined in the ${existing.layer.name} store (${existing.path}); a project may add types but not redefine global ones`);
        continue;
      }
      const { schema, errors } = parseTypeSchema(file.content);
      for (const message of errors)
        this.issue(file.path, "error", "type-schema", message);
      if (schema)
        this.types.set(type, { name: type, layer, path: file.path, schema });
    }
    for (const entry of this.types.values()) {
      for (const [name, field] of Object.entries(entry.schema.fields)) {
        if (field.type !== "link" || field.to === "any")
          continue;
        for (const target of field.to) {
          const targetType = this.types.get(target);
          if (!targetType) {
            this.issue(entry.path, "error", "type-schema", `field \`${name}\`: link target type \`${target}\` does not exist`);
          } else if (!this.visible(entry.layer, targetType.layer)) {
            this.issue(entry.path, "error", "cross-layer", `field \`${name}\`: global types cannot link to project type \`${target}\``);
          }
        }
      }
    }
    for (const { info, file } of pendingObjects) {
      const existing = this.objects.get(info.id);
      if (existing) {
        this.issue(file.path, "error", "duplicate-id", `\`${info.id}\` already exists in the ${existing.layer.name} store (${existing.path})`);
        continue;
      }
      const type = this.types.get(info.type);
      if (!type || !this.visible(info.layer, type.layer)) {
        this.issue(file.path, "error", "unknown-type", `type \`${info.type}\` has no schema${type ? " visible from the global store" : ""}; create ${join(info.layer.root, info.type, SCHEMA_FILE)} first`);
        continue;
      }
      const doc = parseDoc(file.content);
      if (doc.error || !doc.data) {
        this.issue(file.path, "error", "frontmatter", doc.error ?? "object must start with YAML frontmatter (--- ... ---) including `summary`");
        continue;
      }
      const { issues, links } = validateFields(doc.data, type.schema, settings);
      for (const i of issues)
        this.issue(file.path, "error", "field", `\`${i.field}\` ${i.message}`);
      const entry = {
        id: info.id,
        type: info.type,
        slug: info.slug,
        layer: info.layer,
        path: file.path,
        data: doc.data,
        body: doc.body,
        summary: typeof doc.data.summary === "string" ? doc.data.summary : "",
        pinned: doc.data.pinned === true,
        mtimeMs: file.mtimeMs,
        fieldLinks: links.map(({ field, target }) => ({ field, target })),
        bodyLinks: extractBodyLinks(doc.body)
      };
      for (const link of links) {
        const targetType = parseId(link.target).type;
        if (link.to !== "any" && !link.to.includes(targetType)) {
          this.issue(file.path, "error", "link-type", `\`${link.field}\`: \`${link.target}\` must link to a ${link.to.join(" or ")}`);
        }
      }
      this.objects.set(info.id, entry);
    }
    const pinned = this.pinnedObjects();
    const pinnedSize = pinned.reduce((n, o) => n + pinnedCost(o), 0);
    if (pinnedSize > settings.pinnedBudget) {
      const list = pinned.map((o) => `${o.id} (${pinnedCost(o)})`).join(", ");
      for (const obj of pinned) {
        this.issue(obj.path, "error", "pinned-budget", `pinned objects total ${pinnedSize} chars, over pinnedBudget ${settings.pinnedBudget}; unpin or shorten something. Pinned: ${list}`);
      }
    }
    for (const obj of this.objects.values()) {
      for (const link of obj.fieldLinks) {
        const target = this.objects.get(link.target);
        if (!target) {
          this.addWanted(link.target, obj.id);
          this.issue(obj.path, "warning", "missing-link", `\`${link.field}\`: \`${link.target}\` does not exist (yet)`);
        } else if (!this.visible(obj.layer, target.layer)) {
          this.issue(obj.path, "error", "cross-layer", `\`${link.field}\`: global objects cannot link to project object \`${link.target}\``);
        } else {
          this.addBacklink(link.target, obj.id);
        }
      }
      for (const link of obj.bodyLinks) {
        const id = parseId(link.target);
        if (!id) {
          this.issue(obj.path, "error", "bad-link", `line ${link.line}: [[${link.target}]] is not a valid link; use [[type/slug]] (kebab-case)`);
          continue;
        }
        const type = this.types.get(id.type);
        if (!type) {
          this.addWanted(link.target, obj.id);
          this.issue(obj.path, "warning", "unknown-link-type", `line ${link.line}: [[${link.target}]] uses type \`${id.type}\`, which has no schema (yet)`);
          continue;
        }
        if (!this.visible(obj.layer, type.layer)) {
          this.issue(obj.path, "error", "cross-layer", `line ${link.line}: [[${link.target}]] — type \`${id.type}\` exists only in the project store, and global objects cannot link into a project (link from the project object to the global one instead)`);
          continue;
        }
        const target = this.objects.get(link.target);
        if (!target) {
          this.addWanted(link.target, obj.id);
          this.issue(obj.path, "info", "wanted", `line ${link.line}: [[${link.target}]] does not exist yet (wanted page)`);
        } else if (!this.visible(obj.layer, target.layer)) {
          this.issue(obj.path, "error", "cross-layer", `line ${link.line}: global objects cannot link to project object [[${link.target}]]`);
        } else {
          this.addBacklink(link.target, obj.id);
        }
      }
    }
  }
  static load(layers, overlay) {
    return new Store(layers, overlay);
  }
  visible(from, to) {
    return from.name === "project" || to.name === "global";
  }
  layer(name) {
    return this.layers.find((l) => l.name === name);
  }
  errors() {
    return this.issues.filter((i) => i.severity === "error");
  }
  issuesFor(path) {
    return this.issues.filter((i) => i.path === path);
  }
  pinnedObjects() {
    return [...this.objects.values()].filter((o) => o.pinned).sort((a, b) => a.id.localeCompare(b.id));
  }
  objectsOfType(type) {
    return [...this.objects.values()].filter((o) => o.type === type).sort((a, b) => a.id.localeCompare(b.id));
  }
  backlinksOf(id) {
    return [...this.backlinks.get(id) ?? []].sort();
  }
  addBacklink(target, source) {
    if (target === source)
      return;
    if (!this.backlinks.has(target))
      this.backlinks.set(target, new Set);
    this.backlinks.get(target).add(source);
  }
  addWanted(target, source) {
    if (!this.wanted.has(target))
      this.wanted.set(target, new Set);
    this.wanted.get(target).add(source);
  }
  issue(path, severity, code, message) {
    this.issues.push({ path, severity, code, message });
  }
}
function pinnedCost(obj) {
  return obj.summary.length + obj.body.trim().length;
}
function issueKey(issue) {
  return `${issue.path}\x00${issue.code}\x00${issue.message}`;
}
function blockingIssues(before, after, touched) {
  const known = new Set(before.errors().map(issueKey));
  return after.issues.filter((issue) => issue.severity === "error" && (touched.has(issue.path) || !known.has(issueKey(issue))));
}
function changeWarnings(before, after, touched) {
  const known = new Set(before.issues.map(issueKey));
  return after.issues.filter((issue) => issue.severity === "warning" && (touched.has(issue.path) || !known.has(issueKey(issue))));
}
function formatIssues(issues, relativeTo) {
  const display = (path) => {
    const layer = relativeTo && findLayer(relativeTo, path);
    return layer ? `${layer.name}:${relative(layer.root, path)}` : path;
  };
  const byPath = new Map;
  for (const issue of issues) {
    if (!byPath.has(issue.path))
      byPath.set(issue.path, []);
    byPath.get(issue.path).push(issue);
  }
  return [...byPath.entries()].map(([path, list]) => `${display(path)}
${list.map((i) => `  - [${i.severity}] ${i.message}`).join(`
`)}`).join(`
`);
}

// src/core/ops.ts
function lint(store) {
  const errors = store.issues.filter((i) => i.severity === "error");
  const warnings = store.issues.filter((i) => i.severity === "warning");
  const orphans = [...store.objects.values()].filter((o) => !store.backlinks.has(o.id) && o.fieldLinks.length === 0 && o.bodyLinks.length === 0);
  const sections = [
    `o6y lint: ${store.objects.size} objects, ${store.types.size} types — ${errors.length} errors, ${warnings.length} warnings, ${store.wanted.size} wanted, ${orphans.length} orphans`
  ];
  if (errors.length)
    sections.push(`## Errors
${formatIssues(errors, store.layers)}`);
  if (warnings.length)
    sections.push(`## Warnings (missing link targets, unknown link types)
${formatIssues(warnings, store.layers)}`);
  if (store.wanted.size) {
    sections.push(`## Wanted pages (linked, not written)
${[...store.wanted].map(([id, from]) => `- [[${id}]] ← ${[...from].sort().join(", ")}`).join(`
`)}`);
  }
  const undeclared = [...store.objects.values()].flatMap((o) => {
    const fields = store.types.get(o.type)?.schema.fields ?? {};
    const extra = Object.keys(o.data).filter((k) => !RESERVED_FIELDS.includes(k) && !(k in fields));
    return extra.length ? [`- [[${o.id}]]: ${extra.join(", ")}`] : [];
  });
  if (undeclared.length) {
    sections.push(`## Undeclared fields (allowed; leftovers from a migration, or worth adding to the schema?)
${undeclared.join(`
`)}`);
  }
  if (orphans.length) {
    sections.push(`## Orphans (no links in or out)
${orphans.map((o) => `- [[${o.id}]] — ${o.summary}`).join(`
`)}`);
  }
  return { text: sections.join(`

`), errors: errors.length, warnings: warnings.length };
}
function matchesValue(actual, expected) {
  if (actual === undefined || actual === null)
    return false;
  if (Array.isArray(actual) || typeof actual === "string" && actual.includes("[[")) {
    const links = normalizeLinkValue(actual);
    if (links?.includes(String(expected)))
      return true;
    if (Array.isArray(actual))
      return actual.some((a) => matchesValue(a, expected));
  }
  return String(actual) === String(expected);
}
function query(store, params) {
  let results = [...store.objects.values()];
  if (params.type)
    results = results.filter((o) => o.type === params.type);
  for (const [field, expected] of Object.entries(params.where ?? {})) {
    results = results.filter((o) => matchesValue(o.data[field], expected));
  }
  if (params.linksTo) {
    const sources = store.backlinks.get(params.linksTo) ?? new Set;
    results = results.filter((o) => sources.has(o.id));
  }
  if (params.linkedFrom) {
    const source = store.objects.get(params.linkedFrom);
    const targets = new Set([
      ...source?.fieldLinks.map((l) => l.target) ?? [],
      ...source?.bodyLinks.map((l) => l.target) ?? []
    ]);
    results = results.filter((o) => targets.has(o.id));
  }
  if (params.text) {
    const needle = params.text.toLowerCase();
    results = results.filter((o) => [o.id, o.summary, o.body].some((s) => s.toLowerCase().includes(needle)));
  }
  results.sort((a, b) => a.id.localeCompare(b.id));
  return results.slice(0, params.limit ?? 50);
}
function outgoing(obj) {
  const out = new Map;
  const add = (target, via) => {
    if (target === obj.id)
      return;
    const list = out.get(target) ?? [];
    if (!list.includes(via))
      list.push(via);
    out.set(target, list);
  };
  for (const l of obj.fieldLinks)
    add(l.target, l.field);
  for (const l of obj.bodyLinks)
    add(l.target, "body");
  return out;
}
function neighbors(store, id) {
  const obj = store.objects.get(id);
  const out = obj ? [...outgoing(obj)].map(([target, via]) => ({ id: target, via, missing: !store.objects.has(target) })) : [];
  const incoming = [];
  for (const source of store.objects.values()) {
    const via = outgoing(source).get(id);
    if (via)
      incoming.push({ id: source.id, via, missing: false });
  }
  const byId = (a, b) => a.id.localeCompare(b.id);
  return { out: out.sort(byId), in: incoming.sort(byId) };
}

// src/core/render.ts
import { homedir } from "node:os";
import { basename as basename2, join as join2 } from "node:path";
var ROOT_INDEX_PER_TYPE = 50;
var RECENT_SHARE = 0.3;
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
      lines.push(`… ${objects.length - ROOT_INDEX_PER_TYPE} more: read ${displayPath(join2(type.layer.root, type.name, INDEX_FILE))}`);
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
- The \`o6y\` shell command searches and maintains memory: \`o6y query <text>\` (or --type/--where/--links-to), \`o6y lint\`, and validated multi-file changes such as \`o6y mv\` (rename + relink), \`o6y merge\`, \`o6y field rename\`. Prefer it over hand-written sed/perl. \`o6y help\` lists everything.
- Consult memory before work that touches what it covers (people, preferences, decisions, notes). Summaries are only pointers: read every object relevant to the task (including the people involved) before advising or acting. Record durable knowledge you learn — the tribal knowledge a teammate would need — not task chatter. Update existing objects rather than duplicating them. Project-specific → project store; shared → global store.`;
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
    for (const m of value.matchAll(PATH_TOKEN))
      out.push(m[1]);
  } else if (Array.isArray(value)) {
    for (const v of value)
      pathValues(v, out);
  }
  return out;
}
function relevantObjects(store, workPaths, home = homedir()) {
  const direct = new Set;
  const names = new Set(workPaths.map((p) => basename2(p).toLowerCase()));
  for (const obj of store.objects.values()) {
    if (names.has(obj.slug)) {
      direct.add(obj.id);
      continue;
    }
    for (const raw of Object.values(obj.data).flatMap((v) => pathValues(v))) {
      const p = (raw.startsWith("~/") ? join2(home, raw.slice(2)) : raw).replace(/\/+$/, "");
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
function buildPromptSection(store, options = {}) {
  const rules = RULES.replace("{MAX}", String(store.settings.summaryMaxLength));
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
  const groups = [
    { objects: ranked.filter((o) => direct.has(o.id)), limit: budget },
    { objects: ranked.filter((o) => store.types.get(o.type)?.schema.alwaysList), limit: budget * ALWAYS_SHARE },
    { objects: ranked.filter((o) => linked.has(o.id)), limit: budget * NEIGHBOR_SHARE },
    { objects: recent, limit: budget * RECENT_SHARE },
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
      body.push(`… ${hidden} more: read ${displayPath(join2(type.layer.root, type.name, INDEX_FILE))}`);
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

// src/core/fsops.ts
import { appendFileSync, existsSync as existsSync2, mkdirSync, readdirSync as readdirSync2, readFileSync as readFileSync2, rmdirSync, rmSync, statSync as statSync2, writeFileSync } from "node:fs";
import { dirname as dirname2, join as join3, relative as relative2 } from "node:path";

// src/core/format.ts
import { parseDocument } from "yaml";
var FORMAT_VERSION = 1;

// src/core/fsops.ts
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
      return relative2(info.layer.root, path);
  }
}
function appendLog(layers, entries, via, now = new Date) {
  const stamp = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  const byLayer = new Map;
  for (const { action, path } of entries) {
    const info = classifyPath(layers, path);
    if (!info || info.kind === "log")
      continue;
    if (!byLayer.has(info.layer))
      byLayer.set(info.layer, []);
    byLayer.get(info.layer).push(`- ${stamp} ${action} ${describe(layers, path)} (${via})`);
  }
  for (const [layer, lines] of byLayer) {
    const logPath = join3(layer.root, LOG_FILE);
    mkdirSync(layer.root, { recursive: true });
    if (!existsSync2(logPath))
      writeFileSync(logPath, `# o6y log

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
`
};
function storeSignature(layers) {
  const walk2 = (dir, depth) => {
    if (depth > 2)
      return "";
    let out = "";
    let entries;
    try {
      entries = readdirSync2(dir, { withFileTypes: true });
    } catch {
      return "";
    }
    for (const e of entries) {
      const full = join3(dir, e.name);
      if (e.isDirectory())
        out += `${full}/
${walk2(full, depth + 1)}`;
      else {
        try {
          const st = statSync2(full);
          out += `${full}:${st.size}:${st.mtimeMs}
`;
        } catch {}
      }
    }
    return out;
  };
  return layers.map((l) => walk2(l.root, 0)).join("\x00");
}

export { __require, parseId, normalizeLinkValue, LOG_FILE, canonicalPath, makeLayers, findLayer, classifyPath, Store, pinnedCost, blockingIssues, changeWarnings, formatIssues, appendLog, storeSignature, lint, query, neighbors, displayPath, renderRootIndex, renderTypeIndex, renderObjectFooter, buildPromptSection };
