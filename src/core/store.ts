import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { parseDoc } from "./frontmatter.ts";
import { type BodyLink, extractBodyLinks, NAME_RE, parseId } from "./links.ts";
import {
  DEFAULT_SETTINGS,
  parseRootSchema,
  parseTypeSchema,
  type RootSchema,
  type RootSettings,
  type TypeSchema,
  validateFields,
} from "./schema.ts";

export type LayerName = "global" | "project";

export interface Layer {
  name: LayerName;
  root: string;
}

export const SCHEMA_FILE = ".schema.md";
export const INDEX_FILE = "index.md";
export const LOG_FILE = "log.md";

export type PathInfo =
  | { kind: "root-schema"; layer: Layer }
  | { kind: "root-index"; layer: Layer }
  | { kind: "log"; layer: Layer }
  | { kind: "type-schema"; layer: Layer; type: string }
  | { kind: "type-index"; layer: Layer; type: string }
  | { kind: "object"; layer: Layer; type: string; slug: string; id: string }
  | { kind: "invalid"; layer: Layer; reason: string };

/** Resolves symlinks in the longest existing prefix so /tmp and /private/tmp compare equal. */
export function canonicalPath(p: string): string {
  let current = resolve(p);
  const rest: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    rest.unshift(basename(current));
    current = parent;
  }
  try {
    current = realpathSync(current);
  } catch {}
  return rest.length ? join(current, ...rest) : current;
}

export function makeLayers(globalRoot: string, projectRoot?: string): Layer[] {
  const layers: Layer[] = [{ name: "global", root: canonicalPath(globalRoot) }];
  if (projectRoot) {
    const root = canonicalPath(projectRoot);
    if (root !== layers[0]!.root) layers.push({ name: "project", root });
  }
  return layers;
}

export function findLayer(layers: Layer[], absPath: string): Layer | undefined {
  const p = canonicalPath(absPath);
  // Prefer the most specific root in case one store is nested inside another.
  return [...layers]
    .sort((a, b) => b.root.length - a.root.length)
    .find((layer) => p === layer.root || p.startsWith(layer.root + sep));
}

export function classifyPath(layers: Layer[], absPath: string): PathInfo | undefined {
  const layer = findLayer(layers, absPath);
  if (!layer) return undefined;
  const rel = relative(layer.root, canonicalPath(absPath));
  if (rel === "") return { kind: "invalid", layer, reason: "the store root itself is not a file" };
  const parts = rel.split(sep);
  if (parts.length === 1) {
    const name = parts[0]!;
    if (name === SCHEMA_FILE) return { kind: "root-schema", layer };
    if (name === INDEX_FILE) return { kind: "root-index", layer };
    if (name === LOG_FILE) return { kind: "log", layer };
    return {
      kind: "invalid",
      layer,
      reason: `only ${SCHEMA_FILE}, ${LOG_FILE} and type folders may live at the store root; objects go in <type>/<slug>.md`,
    };
  }
  const type = parts[0]!;
  if (!NAME_RE.test(type)) {
    return { kind: "invalid", layer, reason: `type folder \`${type}\` must be kebab-case (a-z, 0-9, -)` };
  }
  if (parts.length > 2) {
    return { kind: "invalid", layer, reason: `no subfolders inside types; use ${type}/<slug>.md` };
  }
  const file = parts[1]!;
  if (file === SCHEMA_FILE) return { kind: "type-schema", layer, type };
  if (file === INDEX_FILE) return { kind: "type-index", layer, type };
  if (!file.endsWith(".md")) return { kind: "invalid", layer, reason: "objects must be .md files" };
  const slug = file.slice(0, -3);
  if (!NAME_RE.test(slug)) {
    return { kind: "invalid", layer, reason: `slug \`${slug}\` must be kebab-case (a-z, 0-9, -), e.g. ${type}/my-object.md` };
  }
  return { kind: "object", layer, type, slug, id: `${type}/${slug}` };
}

export type Severity = "error" | "warning" | "info";

export interface Issue {
  path: string;
  severity: Severity;
  code: string;
  message: string;
}

export interface TypeEntry {
  name: string;
  layer: Layer;
  path: string;
  schema: TypeSchema;
}

export interface ObjectEntry {
  id: string;
  type: string;
  slug: string;
  layer: Layer;
  path: string;
  data: Record<string, unknown>;
  body: string;
  summary: string;
  mtimeMs: number;
  /** Typed frontmatter links. */
  fieldLinks: { field: string; target: string }[];
  bodyLinks: BodyLink[];
}

/** Pending content per canonical absolute path; `null` means deleted. */
export type Overlay = Map<string, string | null>;

interface RawFile {
  path: string;
  content: string;
  mtimeMs: number;
}

function walk(dir: string, depth: number, out: string[]): void {
  if (depth > 3) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== SCHEMA_FILE) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, depth + 1, out);
    else if (entry.isFile()) out.push(full);
  }
}

function readLayerFiles(layer: Layer, overlay: Overlay | undefined): RawFile[] {
  const paths: string[] = [];
  if (existsSync(layer.root)) walk(layer.root, 0, paths);
  const files = new Map<string, RawFile>();
  for (const path of paths) {
    if (overlay?.has(path)) continue;
    try {
      files.set(path, { path, content: readFileSync(path, "utf8"), mtimeMs: statSync(path).mtimeMs });
    } catch {}
  }
  if (overlay) {
    const now = Date.now();
    for (const [path, content] of overlay) {
      if (content === null) continue;
      if (findLayer([layer], path)) files.set(path, { path, content, mtimeMs: now });
    }
  }
  return [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export class Store {
  readonly layers: Layer[];
  readonly settings: RootSettings;
  readonly rootGuidance = new Map<LayerName, string>();
  readonly types = new Map<string, TypeEntry>();
  readonly objects = new Map<string, ObjectEntry>();
  readonly issues: Issue[] = [];
  /** target id -> source ids */
  readonly backlinks = new Map<string, Set<string>>();
  /** missing target id -> source ids (body links only) */
  readonly wanted = new Map<string, Set<string>>();

  private constructor(layers: Layer[], overlay?: Overlay) {
    this.layers = layers;
    const filesByLayer = layers.map((layer) => ({ layer, files: readLayerFiles(layer, overlay) }));
    const settings = { ...DEFAULT_SETTINGS };

    // Pass 1: root schemas (project settings override global) and type schemas.
    const pendingTypes: { layer: Layer; type: string; file: RawFile }[] = [];
    const pendingObjects: { info: Extract<PathInfo, { kind: "object" }>; file: RawFile }[] = [];
    for (const { layer, files } of filesByLayer) {
      for (const file of files) {
        const info = classifyPath(layers, file.path);
        if (!info || info.layer !== layer) continue;
        switch (info.kind) {
          case "root-schema": {
            const { schema, errors } = parseRootSchema(file.content);
            for (const message of errors) this.issue(file.path, "error", "root-schema", message);
            if (schema) {
              Object.assign(settings, schema.settings);
              if (schema.guidance) this.rootGuidance.set(layer.name, schema.guidance);
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
        this.issue(
          file.path,
          "error",
          "shadowed-type",
          `type \`${type}\` is already defined in the ${existing.layer.name} store (${existing.path}); a project may add types but not redefine global ones`,
        );
        continue;
      }
      const { schema, errors } = parseTypeSchema(file.content);
      for (const message of errors) this.issue(file.path, "error", "type-schema", message);
      if (schema) this.types.set(type, { name: type, layer, path: file.path, schema });
    }
    for (const entry of this.types.values()) {
      for (const [name, field] of Object.entries(entry.schema.fields)) {
        if (field.type !== "link" || field.to === "any") continue;
        for (const target of field.to!) {
          const targetType = this.types.get(target);
          if (!targetType) {
            this.issue(entry.path, "error", "type-schema", `field \`${name}\`: link target type \`${target}\` does not exist`);
          } else if (!this.visible(entry.layer, targetType.layer)) {
            this.issue(entry.path, "error", "cross-layer", `field \`${name}\`: global types cannot link to project type \`${target}\``);
          }
        }
      }
    }

    // Pass 2: objects.
    for (const { info, file } of pendingObjects) {
      const existing = this.objects.get(info.id);
      if (existing) {
        this.issue(file.path, "error", "duplicate-id", `\`${info.id}\` already exists in the ${existing.layer.name} store (${existing.path})`);
        continue;
      }
      const type = this.types.get(info.type);
      if (!type || !this.visible(info.layer, type.layer)) {
        this.issue(
          file.path,
          "error",
          "unknown-type",
          `type \`${info.type}\` has no schema${type ? " visible from the global store" : ""}; create ${join(info.layer.root, info.type, SCHEMA_FILE)} first`,
        );
        continue;
      }
      const doc = parseDoc(file.content);
      if (doc.error || !doc.data) {
        this.issue(file.path, "error", "frontmatter", doc.error ?? "object must start with YAML frontmatter (--- ... ---) including `summary`");
        continue;
      }
      const { issues, links } = validateFields(doc.data, type.schema, settings);
      for (const i of issues) this.issue(file.path, "error", "field", `\`${i.field}\` ${i.message}`);
      const entry: ObjectEntry = {
        id: info.id,
        type: info.type,
        slug: info.slug,
        layer: info.layer,
        path: file.path,
        data: doc.data,
        body: doc.body,
        summary: typeof doc.data.summary === "string" ? doc.data.summary : "",
        mtimeMs: file.mtimeMs,
        fieldLinks: links.map(({ field, target }) => ({ field, target })),
        bodyLinks: extractBodyLinks(doc.body),
      };
      // Type constraints on typed links are checked here; existence after all objects load.
      for (const link of links) {
        const targetType = parseId(link.target)!.type;
        if (link.to !== "any" && !link.to.includes(targetType)) {
          this.issue(file.path, "error", "link-type", `\`${link.field}\`: \`${link.target}\` must link to a ${link.to.join(" or ")}`);
        }
      }
      this.objects.set(info.id, entry);
    }

    // Pass 3: link resolution, backlinks, wanted pages.
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
          this.issue(
            obj.path,
            "warning",
            "unknown-link-type",
            `line ${link.line}: [[${link.target}]] uses type \`${id.type}\`, which has no schema (yet)`,
          );
          continue;
        }
        if (!this.visible(obj.layer, type.layer)) {
          this.issue(
            obj.path,
            "error",
            "cross-layer",
            `line ${link.line}: [[${link.target}]] — type \`${id.type}\` exists only in the project store, and global objects cannot link into a project (link from the project object to the global one instead)`,
          );
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

  static load(layers: Layer[], overlay?: Overlay): Store {
    return new Store(layers, overlay);
  }

  /** Can something in layer `from` reference something in layer `to`? */
  visible(from: Layer, to: Layer): boolean {
    return from.name === "project" || to.name === "global";
  }

  layer(name: LayerName): Layer | undefined {
    return this.layers.find((l) => l.name === name);
  }

  errors(): Issue[] {
    return this.issues.filter((i) => i.severity === "error");
  }

  issuesFor(path: string): Issue[] {
    return this.issues.filter((i) => i.path === path);
  }

  objectsOfType(type: string): ObjectEntry[] {
    return [...this.objects.values()].filter((o) => o.type === type).sort((a, b) => a.id.localeCompare(b.id));
  }

  backlinksOf(id: string): string[] {
    return [...(this.backlinks.get(id) ?? [])].sort();
  }

  private addBacklink(target: string, source: string): void {
    if (target === source) return;
    if (!this.backlinks.has(target)) this.backlinks.set(target, new Set());
    this.backlinks.get(target)!.add(source);
  }

  private addWanted(target: string, source: string): void {
    if (!this.wanted.has(target)) this.wanted.set(target, new Set());
    this.wanted.get(target)!.add(source);
  }

  private issue(path: string, severity: Severity, code: string, message: string): void {
    this.issues.push({ path, severity, code, message });
  }
}

export function issueKey(issue: Issue): string {
  return `${issue.path}\u0000${issue.code}\u0000${issue.message}`;
}

/**
 * Errors that block a change: every error in the touched files plus errors elsewhere that the
 * change introduced.
 */
export function blockingIssues(before: Store, after: Store, touched: Set<string>): Issue[] {
  const known = new Set(before.errors().map(issueKey));
  return after.issues.filter(
    (issue) => issue.severity === "error" && (touched.has(issue.path) || !known.has(issueKey(issue))),
  );
}

/** Warnings to surface after an accepted change: all in touched files, new ones elsewhere. */
export function changeWarnings(before: Store, after: Store, touched: Set<string>): Issue[] {
  const known = new Set(before.issues.map(issueKey));
  return after.issues.filter(
    (issue) => issue.severity === "warning" && (touched.has(issue.path) || !known.has(issueKey(issue))),
  );
}

export function formatIssues(issues: Issue[], relativeTo?: Layer[]): string {
  const display = (path: string) => {
    const layer = relativeTo && findLayer(relativeTo, path);
    return layer ? `${layer.name}:${relative(layer.root, path)}` : path;
  };
  const byPath = new Map<string, Issue[]>();
  for (const issue of issues) {
    if (!byPath.has(issue.path)) byPath.set(issue.path, []);
    byPath.get(issue.path)!.push(issue);
  }
  return [...byPath.entries()]
    .map(([path, list]) => `${display(path)}\n${list.map((i) => `  - [${i.severity}] ${i.message}`).join("\n")}`)
    .join("\n");
}
