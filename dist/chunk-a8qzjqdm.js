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
function splitDoc(text) {
  const match = FENCE.exec(text);
  if (!match)
    return { frontmatter: undefined, body: text };
  return { frontmatter: match[1] ?? "", body: text.slice(match[0].length) };
}
function joinDoc(frontmatter, body) {
  const fm = frontmatter.endsWith(`
`) ? frontmatter : `${frontmatter}
`;
  return `---
${fm}---
${body}`;
}

// src/core/schema.ts
var FIELD_TYPES = ["string", "number", "boolean", "date", "enum", "list", "link"];
var DEFAULT_SETTINGS = {
  summaryMaxLength: 80,
  promptBudget: 8000,
  pinnedBudget: 2500,
  namesBudget: 1e4
};
var RESERVED_FIELDS = ["summary", "pinned", "o6y"];
var DEFAULT_SEMANTIC = {
  enabled: false,
  embedModel: "embed-v5.0-fast",
  rerankModel: "rerank-v5.0-fast",
  threshold: 0.35,
  minSimilarity: 0.16,
  maxRelevant: 5,
  candidates: 40,
  logPrompts: false
};
var DEFAULT_DREAM = {
  model: "",
  analyzerModel: "",
  organizerModel: "",
  thinking: "",
  maxToolResultChars: 3000,
  pageChars: 30000,
  instructions: "",
  maxNewObjects: 2,
  maxAddedLines: 15,
  protected: [],
  review: false
};
var THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
function parseDream(raw, errors) {
  if (raw === undefined)
    return {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    errors.push("`dream` must be a mapping, e.g. { model: openrouter/some-model }");
    return {};
  }
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    const where = `\`dream.${key}\``;
    switch (key) {
      case "model":
      case "analyzerModel":
      case "organizerModel":
        if (typeof value === "string" && (value === "" || /^[^/\s]+\/\S+$/.test(value)))
          out[key] = value;
        else
          errors.push(`${where} must be provider/model-id`);
        break;
      case "thinking":
        if (typeof value === "string" && (value === "" || THINKING_LEVELS.includes(value)))
          out[key] = value;
        else
          errors.push(`${where} must be one of: ${THINKING_LEVELS.join(", ")}`);
        break;
      case "maxToolResultChars":
      case "pageChars":
        if (typeof value === "number" && Number.isInteger(value) && value > 0)
          out[key] = value;
        else
          errors.push(`${where} must be a positive integer`);
        break;
      case "instructions":
        if (typeof value === "string")
          out[key] = value.trim();
        else
          errors.push(`${where} must be text`);
        break;
      case "maxNewObjects":
      case "maxAddedLines":
        if (typeof value === "number" && Number.isInteger(value) && value >= 0)
          out[key] = value;
        else
          errors.push(`${where} must be a whole number, 0 or more`);
        break;
      case "protected":
        if (Array.isArray(value) && value.every((v) => typeof v === "string" && /^[a-z0-9-]+\/(\*|[^/\s]+)$/.test(v)))
          out[key] = value;
        else
          errors.push(`${where} must be a list of object ids (type/slug) or type/*`);
        break;
      case "review":
        if (typeof value === "boolean")
          out[key] = value;
        else
          errors.push(`${where} must be true or false`);
        break;
      default:
        errors.push(`${where} is not a setting (allowed: ${Object.keys(DEFAULT_DREAM).join(", ")})`);
    }
  }
  return out;
}
function parseSemantic(raw, errors) {
  if (raw === undefined)
    return {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    errors.push("`semantic` must be a mapping, e.g. { enabled: true }");
    return {};
  }
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    const where = `\`semantic.${key}\``;
    switch (key) {
      case "enabled":
      case "logPrompts":
        if (typeof value === "boolean")
          out[key] = value;
        else
          errors.push(`${where} must be true or false`);
        break;
      case "embedModel":
      case "rerankModel":
        if (typeof value === "string" && value.trim())
          out[key] = value.trim();
        else
          errors.push(`${where} must be a Cohere model id`);
        break;
      case "threshold":
      case "minSimilarity":
        if (typeof value === "number" && value >= 0 && value <= 1)
          out[key] = value;
        else
          errors.push(`${where} must be a number between 0 and 1`);
        break;
      case "maxRelevant":
      case "candidates":
        if (typeof value === "number" && Number.isInteger(value) && value > 0)
          out[key] = value;
        else
          errors.push(`${where} must be a positive integer`);
        break;
      default:
        errors.push(`${where} is not a setting (allowed: ${Object.keys(DEFAULT_SEMANTIC).join(", ")})`);
    }
  }
  return out;
}
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
  const semantic = parseSemantic(data.semantic, errors);
  const dream = parseDream(data.dream, errors);
  if (errors.length)
    return { errors };
  return { schema: { settings, semantic, dream, guidance: doc.body.trim() }, errors };
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
  const priority = doc.data.priority ?? 0;
  if (typeof priority !== "number" || !Number.isInteger(priority))
    errors.push("`priority` must be an integer (higher ranks first; default 0)");
  if (errors.length)
    return { errors };
  return {
    schema: { description: description.trim(), fields, index, alwaysList: alwaysList === true, priority, guidance: doc.body.trim() },
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
      const wikilink = Array.isArray(value) && value.length === 1 && Array.isArray(value[0]) && value[0].length === 1 && typeof value[0][0] === "string";
      if (Array.isArray(value) && value.some(Array.isArray) && !wikilink) {
        return 'has a nested list; write links as `[type/slug, type/slug]`, or quote each `"[[type/slug]]"`';
      }
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
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
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
  semantic;
  dream;
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
    const semantic = { ...DEFAULT_SEMANTIC };
    const dream = { ...DEFAULT_DREAM };
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
              Object.assign(semantic, schema.semantic);
              Object.assign(dream, schema.dream);
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
    this.semantic = semantic;
    this.dream = dream;
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

export { __require, parseDoc, splitDoc, joinDoc, ID_RE, parseId, normalizeLinkValue, RESERVED_FIELDS, describeField, SCHEMA_FILE, INDEX_FILE, LOG_FILE, canonicalPath, makeLayers, findLayer, classifyPath, Store, pinnedCost, blockingIssues, changeWarnings, formatIssues };
