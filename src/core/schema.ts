import { parseDoc } from "./frontmatter.ts";
import { NAME_RE, normalizeLinkValue, parseId } from "./links.ts";

export const FIELD_TYPES = ["string", "number", "boolean", "date", "enum", "list", "link"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export interface FieldSpec {
  type: FieldType;
  required: boolean;
  description?: string;
  /** enum only */
  values?: string[];
  /** link only: allowed target types, or "any" */
  to?: string[] | "any";
  /** link only */
  many?: boolean;
}

export interface TypeSchema {
  description: string;
  fields: Record<string, FieldSpec>;
  /** Fields shown next to each object in indexes. */
  index: string[];
  /** Give every object of this type a full line in the prompt catalog, ahead of other ranking. */
  alwaysList: boolean;
  guidance: string;
}

export interface RootSettings {
  summaryMaxLength: number;
  /** Max characters of the object catalog in the prompt (rules, guidance and pinned objects not counted). */
  promptBudget: number;
  /** Max characters of pinned objects (summary + body), injected in full every session. */
  pinnedBudget: number;
}

export const DEFAULT_SETTINGS: RootSettings = {
  summaryMaxLength: 80,
  promptBudget: 8000,
  pinnedBudget: 2500,
};

export const RESERVED_FIELDS = ["summary", "pinned"];

export interface RootSchema {
  settings: Partial<RootSettings>;
  guidance: string;
}

export function parseRootSchema(text: string): { schema?: RootSchema; errors: string[] } {
  const doc = parseDoc(text);
  if (doc.error) return { errors: [doc.error] };
  const data = doc.data ?? {};
  const errors: string[] = [];
  const settings: Partial<RootSettings> = {};
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof RootSettings)[]) {
    const value = data[key];
    if (value === undefined) continue;
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
  if (errors.length) return { errors };
  return { schema: { settings, guidance: doc.body.trim() }, errors };
}

export function parseTypeSchema(text: string): { schema?: TypeSchema; errors: string[] } {
  const doc = parseDoc(text);
  if (doc.error) return { errors: [doc.error] };
  if (!doc.data) return { errors: ["schema must start with YAML frontmatter (--- ... ---)"] };
  const errors: string[] = [];
  const description = doc.data.description;
  if (typeof description !== "string" || description.trim() === "") {
    errors.push("`description` is required (one line describing what this type represents)");
  }
  const rawFields = doc.data.fields ?? {};
  const fields: Record<string, FieldSpec> = {};
  if (typeof rawFields !== "object" || rawFields === null || Array.isArray(rawFields)) {
    errors.push("`fields` must be a mapping of field name to field definition");
  } else {
    for (const [name, raw] of Object.entries(rawFields)) {
      if (RESERVED_FIELDS.includes(name)) {
        errors.push(`field \`${name}\` is reserved and implicit in every type; remove it`);
        continue;
      }
      const parsed = parseFieldSpec(name, raw);
      if (typeof parsed === "string") errors.push(parsed);
      else fields[name] = parsed;
    }
  }
  const rawIndex = doc.data.index ?? [];
  const index: string[] = [];
  if (!Array.isArray(rawIndex) || !rawIndex.every((f) => typeof f === "string")) {
    errors.push("`index` must be a list of field names to show in indexes, e.g. [status]");
  } else if (rawIndex.length > 3) {
    errors.push("`index` may list at most 3 fields (indexes must stay compact)");
  } else {
    for (const name of rawIndex as string[]) {
      if (!(name in fields)) errors.push(`\`index\`: \`${name}\` is not a declared field`);
      else index.push(name);
    }
  }
  const alwaysList = doc.data.alwaysList ?? false;
  if (typeof alwaysList !== "boolean") errors.push("`alwaysList` must be true or false");
  if (errors.length) return { errors };
  return {
    schema: { description: (description as string).trim(), fields, index, alwaysList: alwaysList === true, guidance: doc.body.trim() },
    errors,
  };
}

const FIELD_KEYS = new Set(["type", "required", "description", "values", "to", "many"]);

function parseFieldSpec(name: string, raw: unknown): FieldSpec | string {
  const where = `field \`${name}\``;
  const spec = typeof raw === "string" ? { type: raw } : raw;
  if (typeof spec !== "object" || spec === null || Array.isArray(spec)) {
    return `${where}: must be a type name (e.g. \`string\`) or a mapping like { type: string, required: true }`;
  }
  const obj = spec as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!FIELD_KEYS.has(key)) return `${where}: unknown option \`${key}\` (allowed: ${[...FIELD_KEYS].join(", ")})`;
  }
  const type = obj.type;
  if (typeof type !== "string" || !(FIELD_TYPES as readonly string[]).includes(type)) {
    return `${where}: \`type\` must be one of ${FIELD_TYPES.join(", ")}`;
  }
  if (obj.required !== undefined && typeof obj.required !== "boolean") return `${where}: \`required\` must be true or false`;
  if (obj.description !== undefined && typeof obj.description !== "string") return `${where}: \`description\` must be a string`;
  const field: FieldSpec = { type: type as FieldType, required: obj.required === true };
  if (typeof obj.description === "string") field.description = obj.description;

  if (type === "enum") {
    if (!Array.isArray(obj.values) || obj.values.length === 0 || !obj.values.every((v) => typeof v === "string")) {
      return `${where}: enum needs \`values\`, a non-empty list of strings`;
    }
    field.values = obj.values as string[];
  } else if (obj.values !== undefined) {
    return `${where}: \`values\` is only valid for enum fields`;
  }

  if (type === "link") {
    const to = obj.to ?? "any";
    if (to === "any") field.to = "any";
    else if (typeof to === "string" && NAME_RE.test(to)) field.to = [to];
    else if (Array.isArray(to) && to.length > 0 && to.every((t) => typeof t === "string" && NAME_RE.test(t))) field.to = to as string[];
    else return `${where}: \`to\` must be a type name, a list of type names, or \`any\``;
    if (obj.many !== undefined && typeof obj.many !== "boolean") return `${where}: \`many\` must be true or false`;
    field.many = obj.many === true;
  } else if (obj.to !== undefined || obj.many !== undefined) {
    return `${where}: \`to\`/\`many\` are only valid for link fields`;
  }
  return field;
}

export function describeField(name: string, field: FieldSpec): string {
  let type: string = field.type;
  if (field.type === "enum") type = `enum(${field.values!.join("|")})`;
  if (field.type === "link") type = `link→${field.to === "any" ? "any" : field.to!.join("|")}${field.many ? "[]" : ""}`;
  return `${name}${field.required ? "*" : ""}: ${type}`;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[T ][0-9:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/;

export interface FieldIssue {
  field: string;
  message: string;
}

/** Validates frontmatter values against a schema. Link targets are returned, not resolved. */
export function validateFields(
  data: Record<string, unknown>,
  schema: TypeSchema,
  settings: RootSettings,
): { issues: FieldIssue[]; links: { field: string; target: string; to: string[] | "any" }[] } {
  const issues: FieldIssue[] = [];
  const links: { field: string; target: string; to: string[] | "any" }[] = [];

  const summary = data.summary;
  if (summary === undefined || summary === null || summary === "") {
    issues.push({ field: "summary", message: `required (one line, max ${settings.summaryMaxLength} chars)` });
  } else if (typeof summary !== "string") {
    issues.push({ field: "summary", message: "must be a string" });
  } else if (summary.includes("\n")) {
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
      if (field.required) issues.push({ field: name, message: `required (${describeField(name, field)})` });
      continue;
    }
    const problem = checkValue(value, field);
    if (typeof problem === "string") {
      issues.push({ field: name, message: problem });
    } else if (problem) {
      for (const target of problem) links.push({ field: name, target, to: field.to! });
    }
  }
  return { issues, links };
}

function checkValue(value: unknown, field: FieldSpec): string | string[] | undefined {
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
      return typeof value === "string" && field.values!.includes(value)
        ? undefined
        : `must be one of: ${field.values!.join(", ")}`;
    case "list":
      return Array.isArray(value) && value.every((v) => typeof v === "string" || typeof v === "number")
        ? undefined
        : "must be a list of strings";
    case "link": {
      const targets = normalizeLinkValue(value);
      if (!targets) return "must be a link like `type/slug` or `[[type/slug]]`";
      if (!field.many && targets.length !== 1) return "must be a single link (this field is not `many`)";
      if (field.many && !Array.isArray(value) && targets.length !== 1) return "must be a list of links";
      for (const target of targets) {
        if (!parseId(target)) return `\`${target}\` is not a valid link; use \`type/slug\` (kebab-case)`;
      }
      return targets;
    }
  }
}
