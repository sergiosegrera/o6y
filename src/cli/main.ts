/**
 * The `o6y` command: query and maintain o6y stores from a shell. Agents run it through bash (the
 * pi extension puts it on PATH); people run it directly. Write commands plan their changes,
 * validate them against the whole store and only then write, so a bad change never lands.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { workPaths } from "../core/context.ts";
import { editFrontmatter, parseValue, Plan, renameKey, retargetLinks, splitDoc } from "../core/edit.ts";
import { parseId } from "../core/links.ts";
import { lint, neighbors, query, type QueryParams } from "../core/ops.ts";
import { buildPromptSection, displayPath, renderObjectFooter, renderRootIndex, renderTypeIndex } from "../core/render.ts";
import {
  canonicalPath,
  classifyPath,
  findLayer,
  formatIssues,
  type Issue,
  type Layer,
  LOG_FILE,
  makeLayers,
  type ObjectEntry,
  pinnedCost,
  Store,
} from "../core/store.ts";

export interface Io {
  cwd: string;
  env: Record<string, string | undefined>;
  out: (text: string) => void;
  err: (text: string) => void;
  /** Reads all of stdin, or undefined when it's a terminal. */
  stdin: () => string | undefined;
  isTTY: boolean;
}

class UsageError extends Error {}

interface Ctx extends Io {
  layers: Layer[];
  load: () => Store;
}

interface Command {
  usage: string;
  summary: string;
  options?: ParseArgsConfig["options"];
  run: (ctx: Ctx, args: string[], opts: Record<string, any>) => number | Promise<number>;
}

const DRY = { "dry-run": { type: "boolean" as const } };
const JSON_OPT = { json: { type: "boolean" as const } };
const IN = { in: { type: "string" as const } };

// ── helpers ──────────────────────────────────────────────────────────────

function where(layers: Layer[], path: string): string {
  const layer = findLayer(layers, path);
  return layer ? `${layer.name}:${relative(layer.root, path)}` : displayPath(path);
}

function needObject(store: Store, id: string | undefined): ObjectEntry {
  if (!id) throw new UsageError("missing object id (type/slug)");
  const obj = store.objects.get(id);
  if (!obj) throw new UsageError(`no object \`${id}\`${store.wanted.has(id) ? " (it is linked but not written yet)" : ""}`);
  return obj;
}

function needId(id: string | undefined): { type: string; slug: string } {
  const parsed = id ? parseId(id) : undefined;
  if (!parsed) throw new UsageError(`\`${id ?? ""}\` is not a valid id; use type/slug in kebab-case, e.g. note/release-train`);
  return parsed;
}

function pickLayer(ctx: Ctx, name: string | undefined, fallback?: Layer): Layer {
  if (!name) return fallback ?? ctx.layers[0]!;
  const layer = ctx.layers.find((l) => l.name === name);
  if (!layer) throw new UsageError(`--in must be one of: ${ctx.layers.map((l) => l.name).join(", ")}`);
  return layer;
}

function objectPath(layer: Layer, id: string): string {
  const { type, slug } = needId(id);
  return join(layer.root, type, `${slug}.md`);
}

function parseAssignments(items: string[]): [string, unknown][] {
  return items.map((item) => {
    const eq = item.indexOf("=");
    if (eq <= 0) throw new UsageError(`expected field=value, got \`${item}\``);
    return [item.slice(0, eq), parseValue(item.slice(eq + 1))];
  });
}

function printIssues(ctx: Ctx, title: string, issues: Issue[]): void {
  if (issues.length) ctx.out(`${title}\n${formatIssues(issues, ctx.layers)}`);
}

/** Validates a plan and applies it (or previews it with --dry-run). */
function commit(ctx: Ctx, plan: Plan, via: string, dryRun: boolean): number {
  const result = plan.validate(ctx.load());
  if (result.blocking.length) {
    printIssues(ctx, "o6y: rejected; nothing was changed. The change would leave the store invalid:", result.blocking);
    return 1;
  }
  if (!result.changes.length) {
    ctx.out("o6y: nothing to change.");
    return 0;
  }
  const verb = dryRun ? "would " : "";
  if (!dryRun) plan.apply(via);
  ctx.out(result.changes.map((c) => `${verb}${c.action} ${where(ctx.layers, c.path)}`).join("\n"));
  printIssues(ctx, "warnings (not blocking):", result.warnings);
  return 0;
}

function readInput(ctx: Ctx, file: string | undefined): string {
  if (file) return readFileSync(resolve(ctx.cwd, file), "utf8");
  const stdin = ctx.stdin();
  if (stdin === undefined) throw new UsageError("pass the content with --file <path> or on stdin");
  return stdin;
}

function edgeLines(store: Store, edges: { id: string; via: string[]; missing: boolean }[], arrow: string): string[] {
  return edges.map((e) => `${arrow} ${e.id} (${e.via.join(", ")}) — ${store.objects.get(e.id)?.summary ?? "not written yet"}`);
}

function parseSince(value: string): number {
  const rel = /^(\d+)([mhdw])$/.exec(value);
  if (rel) return Date.now() - Number(rel[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[rel[2] as "m"];
  const abs = Date.parse(value);
  if (Number.isNaN(abs)) throw new UsageError(`--since takes a duration (30m, 6h, 2d, 1w) or a date, not \`${value}\``);
  return abs;
}

/** Mutates a type schema's frontmatter in the plan. */
function editSchema(plan: Plan, path: string, fn: Parameters<typeof editFrontmatter>[1]): void {
  plan.write(path, editFrontmatter(plan.read(path) ?? "", fn));
}

// ── commands ─────────────────────────────────────────────────────────────

const COMMANDS: Record<string, Command> = {
  query: {
    usage: "o6y query [--type T] [--where field=value]... [--links-to ID] [--linked-from ID] [--text S] [--limit N] [--json]",
    summary: "find objects by type, field values, links or text",
    options: {
      type: { type: "string" },
      where: { type: "string", multiple: true },
      "links-to": { type: "string" },
      "linked-from": { type: "string" },
      text: { type: "string" },
      limit: { type: "string" },
      ...JSON_OPT,
    },
    run(ctx, args, o) {
      const params: QueryParams = { type: o.type, linksTo: o["links-to"], linkedFrom: o["linked-from"], text: o.text ?? (args.join(" ") || undefined) };
      if (o.where) {
        params.where = Object.fromEntries(
          parseAssignments(o.where).map(([k, v]) => [k, typeof v === "number" || typeof v === "boolean" ? v : String(v)]),
        );
      }
      if (o.limit) params.limit = Number(o.limit);
      const store = ctx.load();
      const results = query(store, params);
      if (o.json) {
        ctx.out(JSON.stringify(results.map((r) => ({ id: r.id, summary: r.summary, path: r.path, backlinks: store.backlinksOf(r.id).length })), null, 2));
      } else if (!results.length) ctx.out("No matching objects.");
      else {
        ctx.out(results.map((r) => `- [[${r.id}]] — ${r.summary}  (${displayPath(r.path)}; ${store.backlinksOf(r.id).length} backlinks)`).join("\n"));
      }
      return 0;
    },
  },

  lint: {
    usage: "o6y lint [--json]",
    summary: "errors, warnings, wanted pages, orphans and undeclared fields (exit 1 on errors)",
    options: JSON_OPT,
    run(ctx, _args, o) {
      const store = ctx.load();
      const report = lint(store);
      if (o.json) {
        ctx.out(
          JSON.stringify(
            {
              errors: store.errors(),
              warnings: store.issues.filter((i) => i.severity === "warning"),
              wanted: Object.fromEntries([...store.wanted].map(([id, from]) => [id, [...from].sort()])),
            },
            null,
            2,
          ),
        );
      } else ctx.out(report.text);
      return report.errors ? 1 : 0;
    },
  },

  show: {
    usage: "o6y show <id>",
    summary: "print an object with its backlinks",
    run(ctx, [id]) {
      const store = ctx.load();
      if (id && !store.objects.has(id) && store.wanted.has(id)) {
        ctx.out(`${id} is not written yet. Linked from: ${[...store.wanted.get(id)!].sort().join(", ")}`);
        return 0;
      }
      const obj = needObject(store, id);
      ctx.out(readFileSync(obj.path, "utf8").trimEnd() + "\n" + renderObjectFooter(store, obj.id, obj.path));
      return 0;
    },
  },

  links: {
    usage: "o6y links <id> [--json]",
    summary: "what an object links to, and through which field",
    options: JSON_OPT,
    run(ctx, [id], o) {
      const store = ctx.load();
      if (!id) throw new UsageError("missing object id");
      const edges = neighbors(store, id).out;
      ctx.out(o.json ? JSON.stringify(edges, null, 2) : edges.length ? edgeLines(store, edges, "→").join("\n") : `${id} links to nothing.`);
      return 0;
    },
  },

  backlinks: {
    usage: "o6y backlinks <id> [--json]",
    summary: "what links to an object (works for wanted pages too)",
    options: JSON_OPT,
    run(ctx, [id], o) {
      const store = ctx.load();
      if (!id) throw new UsageError("missing object id");
      const edges = neighbors(store, id).in;
      ctx.out(o.json ? JSON.stringify(edges, null, 2) : edges.length ? edgeLines(store, edges, "←").join("\n") : `Nothing links to ${id}.`);
      return 0;
    },
  },

  index: {
    usage: "o6y index [type]",
    summary: "the generated catalog of the stores, or of one type",
    run(ctx, [type]) {
      const store = ctx.load();
      if (!type) ctx.out(renderRootIndex(store).trimEnd());
      else {
        const text = renderTypeIndex(store, type);
        if (!text) throw new UsageError(`no type \`${type}\``);
        ctx.out(text.trimEnd());
      }
      return 0;
    },
  },

  prompt: {
    usage: "o6y prompt [--stats] [--cwd DIR]",
    summary: "the <o6y> system prompt section as the agent sees it, or where its budget goes",
    options: { stats: { type: "boolean" }, cwd: { type: "string" } },
    run(ctx, _args, o) {
      const store = ctx.load();
      const { text, stats } = buildPromptSection(store, { workPaths: workPaths(resolve(ctx.cwd, o.cwd ?? ".")) });
      if (!o.stats) {
        ctx.out(text);
        return 0;
      }
      const pct = (n: number) => `${Math.round((n / Math.max(1, stats.budget)) * 100)}%`;
      ctx.out(
        [
          `section: ${text.length} chars`,
          `  rules     ${stats.rules}`,
          `  guidance  ${stats.guidance}`,
          `  pinned    ${stats.pinned}  (pinnedBudget ${store.settings.pinnedBudget})`,
          `  catalog   ${stats.catalog} of promptBudget ${stats.budget} (${pct(stats.catalog)})`,
          `objects: ${stats.objects} — ${stats.full} full lines, ${stats.named} by slug, ${stats.hidden} only in index.md`,
          stats.relevant.length ? `relevant to this directory: ${stats.relevant.join(", ")}` : "relevant to this directory: none",
        ].join("\n"),
      );
      return 0;
    },
  },

  stats: {
    usage: "o6y stats [--json]",
    summary: "counts per store and type, links, issues and budgets",
    options: JSON_OPT,
    run(ctx, _args, o) {
      const store = ctx.load();
      const types = [...store.types.values()].sort((a, b) => a.name.localeCompare(b.name));
      const links = [...store.objects.values()].reduce((n, obj) => n + neighbors(store, obj.id).out.length, 0);
      const orphans = [...store.objects.values()].filter((obj) => {
        const nb = neighbors(store, obj.id);
        return !nb.in.length && !nb.out.length;
      });
      const pinned = store.pinnedObjects();
      const data = {
        stores: ctx.layers.map((l) => ({
          name: l.name,
          root: l.root,
          exists: existsSync(l.root),
          objects: [...store.objects.values()].filter((obj) => obj.layer.name === l.name).length,
        })),
        types: types.map((t) => ({ name: t.name, layer: t.layer.name, objects: store.objectsOfType(t.name).length })),
        links,
        wanted: store.wanted.size,
        orphans: orphans.length,
        errors: store.errors().length,
        warnings: store.issues.filter((i) => i.severity === "warning").length,
        pinned: { objects: pinned.length, chars: pinned.reduce((n, p) => n + pinnedCost(p), 0), budget: store.settings.pinnedBudget },
      };
      if (o.json) {
        ctx.out(JSON.stringify(data, null, 2));
        return 0;
      }
      ctx.out(
        [
          ...data.stores.map((s) => `${s.name}: ${displayPath(s.root)} — ${s.exists ? `${s.objects} objects` : "not created"}`),
          `types: ${data.types.map((t) => `${t.name} ${t.objects}`).join(" · ") || "none"}`,
          `links: ${links} · wanted pages: ${data.wanted} · orphans: ${data.orphans}`,
          `issues: ${data.errors} errors · ${data.warnings} warnings`,
          `pinned: ${data.pinned.objects} objects, ${data.pinned.chars}/${data.pinned.budget} chars`,
        ].join("\n"),
      );
      return 0;
    },
  },

  log: {
    usage: "o6y log [--since 2d|DATE] [--limit N]",
    summary: "recent changes to the stores, newest first",
    options: { since: { type: "string" }, limit: { type: "string" } },
    run(ctx, _args, o) {
      const since = o.since ? parseSince(o.since) : 0;
      const entries: { at: number; line: string }[] = [];
      for (const layer of ctx.layers) {
        const path = join(layer.root, LOG_FILE);
        if (!existsSync(path)) continue;
        for (const line of readFileSync(path, "utf8").split("\n")) {
          const m = /^- (\S+) (.+)$/.exec(line);
          const at = m ? Date.parse(m[1]!) : NaN;
          if (!m || Number.isNaN(at) || at < since) continue;
          entries.push({ at, line: `${m[1]} ${ctx.layers.length > 1 ? `${layer.name} ` : ""}${m[2]}` });
        }
      }
      entries.sort((a, b) => b.at - a.at);
      const shown = entries.slice(0, Number(o.limit ?? 30));
      ctx.out(shown.length ? shown.map((e) => e.line).join("\n") : "No changes logged in that period.");
      return 0;
    },
  },

  export: {
    usage: "o6y export [--format json|mermaid|dot]",
    summary: "dump the stores as JSON, or the link graph as Mermaid or Graphviz",
    options: { format: { type: "string" } },
    run(ctx, _args, o) {
      const store = ctx.load();
      const format = o.format ?? "json";
      const objects = [...store.objects.values()].sort((a, b) => a.id.localeCompare(b.id));
      if (format === "json") {
        ctx.out(
          JSON.stringify(
            {
              types: [...store.types.values()].map((t) => ({ name: t.name, layer: t.layer.name, ...t.schema })),
              objects: objects.map((obj) => ({
                id: obj.id,
                type: obj.type,
                layer: obj.layer.name,
                path: obj.path,
                summary: obj.summary,
                data: obj.data,
                body: obj.body,
                links: neighbors(store, obj.id).out.map((e) => ({ target: e.id, via: e.via })),
              })),
            },
            null,
            2,
          ),
        );
        return 0;
      }
      const edges = objects.flatMap((obj) => neighbors(store, obj.id).out.map((e) => ({ from: obj.id, to: e.id, via: e.via.join(", ") })));
      const nodes = [...new Set([...objects.map((obj) => obj.id), ...edges.map((e) => e.to)])];
      if (format === "mermaid") {
        const key = new Map(nodes.map((id, i) => [id, `n${i}`]));
        ctx.out(
          [
            "graph LR",
            ...nodes.map((id) => `  ${key.get(id)}["${id}"]${store.objects.has(id) ? "" : ":::wanted"}`),
            ...edges.map((e) => `  ${key.get(e.from)} -->|${e.via}| ${key.get(e.to)}`),
            "  classDef wanted stroke-dasharray: 4 4",
          ].join("\n"),
        );
      } else if (format === "dot") {
        ctx.out(
          [
            "digraph o6y {",
            "  rankdir=LR;",
            ...nodes.filter((id) => !store.objects.has(id)).map((id) => `  "${id}" [style=dashed];`),
            ...edges.map((e) => `  "${e.from}" -> "${e.to}" [label="${e.via}"];`),
            "}",
          ].join("\n"),
        );
      } else throw new UsageError("--format must be json, mermaid or dot");
      return 0;
    },
  },

  check: {
    usage: "o6y check <id|path> [--file DRAFT] [--in global|project]   (content on stdin if no --file)",
    summary: "validate a draft as if it were written there, without writing it",
    options: { file: { type: "string" }, ...IN },
    run(ctx, [target], o) {
      if (!target) throw new UsageError("missing target id or path");
      const store = ctx.load();
      const path = target.includes("/") && (target.endsWith(".md") || target.startsWith(".") || target.startsWith("/") || target.startsWith("~"))
        ? canonicalPath(resolve(ctx.cwd, target.startsWith("~/") ? join(homedir(), target.slice(2)) : target))
        : (store.objects.get(target)?.path ?? objectPath(pickLayer(ctx, o.in), target));
      if (!classifyPath(ctx.layers, path)) throw new UsageError(`${target} is not inside an o6y store`);
      const plan = new Plan(ctx.layers);
      plan.write(path, readInput(ctx, o.file));
      const result = plan.validate(store);
      if (result.blocking.length) {
        printIssues(ctx, `o6y: ${where(ctx.layers, path)} would be rejected:`, result.blocking);
        return 1;
      }
      ctx.out(`o6y: ${where(ctx.layers, path)} is valid.`);
      printIssues(ctx, "warnings (not blocking):", result.warnings);
      return 0;
    },
  },

  new: {
    usage: "o6y new <id> --summary TEXT [--set field=value]... [--body TEXT | --body-file F] [--in global|project] [--dry-run]",
    summary: "create an object (fails if it exists)",
    options: { summary: { type: "string" }, set: { type: "string", multiple: true }, body: { type: "string" }, "body-file": { type: "string" }, ...IN, ...DRY },
    run(ctx, [id], o) {
      needId(id);
      const store = ctx.load();
      if (store.objects.has(id!)) throw new UsageError(`${id} already exists (${displayPath(store.objects.get(id!)!.path)}); use \`o6y set\` or edit it`);
      if (!o.summary) throw new UsageError("--summary is required");
      const path = objectPath(pickLayer(ctx, o.in), id!);
      const body = o["body-file"] ? readFileSync(resolve(ctx.cwd, o["body-file"]), "utf8") : (o.body ?? "");
      const content = editFrontmatter("", (doc) => {
        doc.set("summary", o.summary);
        for (const [k, v] of parseAssignments(o.set ?? [])) doc.set(k, v);
        return body ? `${body.trimEnd()}\n` : "";
      });
      const plan = new Plan(ctx.layers);
      plan.write(path, content);
      return commit(ctx, plan, "o6y new", !!o["dry-run"]);
    },
  },

  set: {
    usage: "o6y set <id> field=value... [--unset field]... [--dry-run]",
    summary: "set or remove frontmatter fields (values are YAML: true, 3, [a, b])",
    options: { unset: { type: "string", multiple: true }, ...DRY },
    run(ctx, [id, ...assignments], o) {
      const obj = needObject(ctx.load(), id);
      const sets = parseAssignments(assignments);
      if (!sets.length && !o.unset?.length) throw new UsageError("nothing to set; pass field=value or --unset field");
      const plan = new Plan(ctx.layers);
      plan.write(
        obj.path,
        editFrontmatter(plan.read(obj.path)!, (doc) => {
          for (const [k, v] of sets) doc.set(k, v);
          for (const k of o.unset ?? []) doc.delete(k);
        }),
      );
      return commit(ctx, plan, "o6y set", !!o["dry-run"]);
    },
  },

  mv: {
    usage: "o6y mv <old-id> <new-id> [--in global|project] [--dry-run]",
    summary: "rename or move an object and rewrite every link to it",
    options: { ...IN, ...DRY },
    run(ctx, [from, to], o) {
      const store = ctx.load();
      const obj = needObject(store, from);
      needId(to);
      if (store.objects.has(to!)) throw new UsageError(`${to} already exists; use \`o6y merge ${from} ${to}\` to combine them`);
      const dest = objectPath(pickLayer(ctx, o.in, obj.layer), to!);
      const plan = new Plan(ctx.layers);
      retargetLinks(store, plan, (id) => (id === from ? to : undefined));
      plan.write(dest, plan.read(obj.path)!);
      plan.delete(obj.path);
      return commit(ctx, plan, "o6y mv", !!o["dry-run"]);
    },
  },

  merge: {
    usage: "o6y merge <from-id> <into-id> [--dry-run]",
    summary: "fold one object into another: repoint links, keep missing fields, append its body, delete it",
    options: DRY,
    run(ctx, [from, into], o) {
      const store = ctx.load();
      const src = needObject(store, from);
      const dst = needObject(store, into);
      if (src.id === dst.id) throw new UsageError("cannot merge an object into itself");
      const plan = new Plan(ctx.layers);
      retargetLinks(store, plan, (id) => (id === src.id ? dst.id : undefined));
      const srcDoc = splitDoc(plan.read(src.path)!);
      plan.write(
        dst.path,
        editFrontmatter(plan.read(dst.path)!, (doc) => {
          for (const [k, v] of Object.entries(src.data)) {
            if (k !== "summary" && k !== "pinned" && !doc.has(k)) doc.set(k, v);
          }
          const body = splitDoc(plan.read(dst.path)!).body.trimEnd();
          const extra = srcDoc.body.trim();
          if (!extra) return undefined;
          return `${body ? `${body}\n\n` : ""}## Merged from ${src.id}\n\n${extra}\n`;
        }),
      );
      plan.delete(src.path);
      return commit(ctx, plan, "o6y merge", !!o["dry-run"]);
    },
  },

  rm: {
    usage: "o6y rm <id>... [--dry-run]",
    summary: "delete objects; links to them become wanted pages (reported)",
    options: DRY,
    run(ctx, ids, o) {
      if (!ids.length) throw new UsageError("missing object id");
      const store = ctx.load();
      const plan = new Plan(ctx.layers);
      for (const id of ids) plan.delete(needObject(store, id).path);
      return commit(ctx, plan, "o6y rm", !!o["dry-run"]);
    },
  },

  field: {
    usage: [
      "o6y field add <type> <name> [TYPE] [--required] [--description D] [--values a,b] [--to t1,t2] [--many] [--default V] [--dry-run]",
      "o6y field rename <type> <old> <new> [--dry-run]",
      "o6y field drop <type> <name> [--keep-values] [--dry-run]",
    ].join("\n       "),
    summary: "change a type's fields and migrate its objects in one validated step",
    options: {
      required: { type: "boolean" },
      description: { type: "string" },
      values: { type: "string" },
      to: { type: "string" },
      many: { type: "boolean" },
      default: { type: "string" },
      "keep-values": { type: "boolean" },
      ...DRY,
    },
    run(ctx, [action, typeName, ...rest], o) {
      const store = ctx.load();
      const type = typeName ? store.types.get(typeName) : undefined;
      if (!action || !["add", "rename", "drop"].includes(action)) throw new UsageError("expected add, rename or drop");
      if (!type) throw new UsageError(`no type \`${typeName ?? ""}\``);
      const plan = new Plan(ctx.layers);
      const objects = store.objectsOfType(type.name);

      if (action === "add") {
        const [name, kind = "string"] = rest;
        if (!name) throw new UsageError("missing field name");
        if (type.schema.fields[name]) throw new UsageError(`${type.name} already declares \`${name}\``);
        const extra: Record<string, unknown> = {};
        if (o.required) extra.required = true;
        if (o.description) extra.description = o.description;
        if (o.values) extra.values = String(o.values).split(",").map((v) => v.trim());
        if (o.to) extra.to = String(o.to).includes(",") ? String(o.to).split(",").map((v) => v.trim()) : o.to;
        if (o.many) extra.many = true;
        const spec = Object.keys(extra).length ? { type: kind, ...extra } : kind;
        editSchema(plan, type.path, (doc) => {
          if (!doc.has("fields") || doc.get("fields") === null) doc.set("fields", doc.createNode({}));
          doc.setIn(["fields", name], doc.createNode(spec, { flow: typeof spec === "object" }));
        });
        if (o.default !== undefined) {
          const value = parseValue(o.default);
          for (const obj of objects) {
            if (obj.data[name] === undefined) plan.write(obj.path, editFrontmatter(plan.read(obj.path)!, (doc) => void doc.set(name, value)));
          }
        }
        return commit(ctx, plan, "o6y field add", !!o["dry-run"]);
      }

      if (action === "rename") {
        const [from, to] = rest;
        if (!from || !to) throw new UsageError("usage: o6y field rename <type> <old> <new>");
        if (type.schema.fields[to]) throw new UsageError(`${type.name} already declares \`${to}\``);
        const clash = objects.find((obj) => obj.data[to] !== undefined && obj.data[from] !== undefined);
        if (clash) throw new UsageError(`${clash.id} already has both \`${from}\` and \`${to}\`; resolve it first`);
        if (type.schema.fields[from]) {
          editSchema(plan, type.path, (doc) => {
            const fields = doc.get("fields", true);
            renameKey(fields, from, to);
            const index = (doc.toJS().index ?? []) as string[];
            if (index.includes(from)) doc.set("index", doc.createNode(index.map((f) => (f === from ? to : f)), { flow: true }));
          });
        }
        for (const obj of objects) {
          if (obj.data[from] === undefined) continue;
          plan.write(obj.path, editFrontmatter(plan.read(obj.path)!, (doc) => void renameKey(doc.contents, from, to)));
        }
        return commit(ctx, plan, "o6y field rename", !!o["dry-run"]);
      }

      const [name] = rest;
      if (!name) throw new UsageError("missing field name");
      if (type.schema.fields[name]) {
        editSchema(plan, type.path, (doc) => {
          doc.deleteIn(["fields", name]);
          const index = (doc.toJS().index ?? []) as string[];
          if (index.includes(name)) {
            const next = index.filter((f) => f !== name);
            if (next.length) doc.set("index", doc.createNode(next, { flow: true }));
            else doc.delete("index");
          }
        });
      } else if (o["keep-values"]) throw new UsageError(`${type.name} doesn't declare \`${name}\``);
      if (!o["keep-values"]) {
        for (const obj of objects) {
          if (obj.data[name] !== undefined) plan.write(obj.path, editFrontmatter(plan.read(obj.path)!, (doc) => void doc.delete(name)));
        }
      }
      return commit(ctx, plan, "o6y field drop", !!o["dry-run"]);
    },
  },

  type: {
    usage: "o6y type rename <old> <new> [--dry-run]",
    summary: "rename a type: move its folder, rewrite ids in links and `to:` in other schemas",
    options: DRY,
    run(ctx, [action, from, to], o) {
      if (action !== "rename") throw new UsageError("expected `rename`");
      const store = ctx.load();
      if (!from || !store.types.has(from)) throw new UsageError(`no type \`${from ?? ""}\``);
      if (!to || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(to)) throw new UsageError("new type name must be kebab-case");
      if (store.types.has(to)) throw new UsageError(`type \`${to}\` already exists`);
      const plan = new Plan(ctx.layers);
      retargetLinks(store, plan, (id) => (id.startsWith(`${from}/`) ? `${to}${id.slice(from.length)}` : undefined));
      for (const t of store.types.values()) {
        const fields = t.schema.fields;
        for (const [name, f] of Object.entries(fields)) {
          if (f.type !== "link" || f.to === "any" || !f.to?.includes(from)) continue;
          editSchema(plan, t.path, (doc) => {
            const raw = doc.getIn(["fields", name, "to"]);
            const value = (raw && typeof raw === "object" ? (raw as any).toJSON() : raw) as unknown;
            const next = Array.isArray(value) ? value.map((v) => (v === from ? to : v)) : to;
            doc.setIn(["fields", name, "to"], doc.createNode(next, { flow: true }));
          });
        }
      }
      for (const layer of ctx.layers) {
        const dir = join(layer.root, from);
        if (!existsSync(dir)) continue;
        for (const file of readdirSync(dir)) {
          if (!file.endsWith(".md")) continue;
          const path = join(dir, file);
          plan.write(join(layer.root, to, file), plan.read(path)!);
          plan.delete(path);
        }
      }
      return commit(ctx, plan, "o6y type rename", !!o["dry-run"]);
    },
  },

  view: {
    usage: "o6y view [id] [--tree]",
    summary: "live terminal viewer (also: plain `o6y` in a terminal)",
    options: { tree: { type: "boolean" } },
    async run(ctx, [id], o) {
      if (!ctx.isTTY) throw new UsageError("the viewer needs an interactive terminal");
      const { runViewer } = await import("../viewer/run.tsx");
      await runViewer(ctx.layers, { current: id, view: o.tree ? "tree" : "browse", history: [], filter: "" });
      return 0;
    },
  },
};

const GROUPS: [string, string[]][] = [
  ["Read", ["query", "show", "links", "backlinks", "index", "lint", "stats", "log", "prompt", "export"]],
  ["Write (validated as one change; --dry-run previews)", ["new", "set", "mv", "merge", "rm", "field", "type", "check"]],
  ["Viewer", ["view"]],
];

function help(): string {
  const lines = [
    "o6y — query and maintain o6y memory stores",
    "",
    "Usage: o6y [--global DIR] [--project DIR] <command> [args]",
    "Stores default to $O6Y_HOME or ~/.agents/o6y, and $O6Y_PROJECT or ./.agents/o6y.",
  ];
  for (const [title, names] of GROUPS) {
    lines.push("", `${title}:`);
    for (const name of names) lines.push(`  ${name.padEnd(10)} ${COMMANDS[name]!.summary}`);
  }
  lines.push("", "`o6y help <command>` shows a command's options. Ids are type/slug, e.g. note/release-train.");
  return lines.join("\n");
}

function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p;
}

/** Runs the CLI. Returns the exit code: 0 ok, 1 rejected or lint errors, 2 usage error. */
export async function main(argv: string[], io: Io): Promise<number> {
  const args = [...argv];
  const take = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    if (i < 0) return undefined;
    const value = args[i + 1];
    args.splice(i, 2);
    return value;
  };
  const globalFlag = take("--global");
  const projectFlag = take("--project");
  const layers = makeLayers(
    resolve(io.cwd, expandHome(globalFlag || io.env.O6Y_HOME || join(homedir(), ".agents", "o6y"))),
    resolve(io.cwd, expandHome(projectFlag || io.env.O6Y_PROJECT || join(io.cwd, ".agents", "o6y"))),
  );
  const ctx: Ctx = { ...io, layers, load: () => Store.load(layers) };

  let name = args.shift();
  if (!name) name = io.isTTY ? "view" : "help";
  if (name === "--help" || name === "-h") name = "help";
  if (name === "help") {
    const topic = args[0] && COMMANDS[args[0]];
    io.out(topic ? `${topic.usage}\n\n${topic.summary}` : help());
    return 0;
  }
  const command = COMMANDS[name];
  if (!command) {
    io.err(`o6y: unknown command \`${name}\`\n\n${help()}`);
    return 2;
  }
  if (args.includes("--help") || args.includes("-h")) {
    io.out(`${command.usage}\n\n${command.summary}`);
    return 0;
  }
  try {
    const { values, positionals } = parseArgs({ args, options: command.options ?? {}, allowPositionals: true, strict: true });
    return await command.run(ctx, positionals, values);
  } catch (err) {
    if (err instanceof UsageError || (err instanceof TypeError && "code" in err && String(err.code).startsWith("ERR_PARSE_ARGS"))) {
      io.err(`o6y ${name}: ${err.message}\nusage: ${command.usage}`);
      return 2;
    }
    if (err instanceof Error) {
      io.err(`o6y ${name}: ${err.message}`);
      return 1;
    }
    throw err;
  }
}

