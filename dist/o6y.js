#!/usr/bin/env node
import {
  workPaths
} from "./chunk-1zbn4yjy.js";
import {
  dreamInvocation
} from "./chunk-v6va4yga.js";
import {
  buildPromptSection,
  displayPath,
  renderObjectFooter,
  renderRootIndex,
  renderTypeIndex
} from "./chunk-r72565yy.js";
import {
  Plan,
  editFrontmatter,
  parseValue,
  renameKey,
  retargetLinks
} from "./chunk-gcxpqqhg.js";
import {
  lint,
  neighbors,
  query
} from "./chunk-nx45tbs7.js";
import {
  cacheRoot,
  embedderFor,
  readSuggestionLog,
  search,
  semanticUnavailable,
  suggestionLogPath,
  suggestionStats,
  syncIndex
} from "./chunk-7ffqdz50.js";
import {
  LOG_FILE,
  Store,
  __require,
  canonicalPath,
  classifyPath,
  findLayer,
  formatIssues,
  makeLayers,
  parseId,
  pinnedCost,
  splitDoc
} from "./chunk-byp1kbkq.js";

// src/cli/o6y.ts
import { readFileSync as readFileSync2 } from "node:fs";

// src/cli/main.ts
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
class UsageError extends Error {
}
var DRY = { "dry-run": { type: "boolean" } };
var JSON_OPT = { json: { type: "boolean" } };
function where(layers, path) {
  const layer = findLayer(layers, path);
  return layer ? `${layer.name}:${relative(layer.root, path)}` : displayPath(path);
}
function needObject(store, id) {
  if (!id)
    throw new UsageError("missing object id (type/slug)");
  const obj = store.objects.get(id);
  if (!obj)
    throw new UsageError(`no object \`${id}\`${store.wanted.has(id) ? " (it is linked but not written yet)" : ""}`);
  return obj;
}
function needId(id) {
  const parsed = id ? parseId(id) : undefined;
  if (!parsed)
    throw new UsageError(`\`${id ?? ""}\` is not a valid id; use type/slug in kebab-case, e.g. note/release-train`);
  return parsed;
}
function objectPath(layer, id) {
  const { type, slug } = needId(id);
  return join(layer.root, type, `${slug}.md`);
}
function parseAssignments(items) {
  return items.map((item) => {
    const eq = item.indexOf("=");
    if (eq <= 0)
      throw new UsageError(`expected field=value, got \`${item}\``);
    return [item.slice(0, eq), parseValue(item.slice(eq + 1))];
  });
}
function printIssues(ctx, title, issues) {
  if (issues.length)
    ctx.out(`${title}
${formatIssues(issues, ctx.layers)}`);
}
function commit(ctx, plan, via, dryRun) {
  plan.source = ctx.env.O6Y_SOURCE;
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
  if (!dryRun)
    plan.apply(via);
  ctx.out(result.changes.map((c) => `${verb}${c.action} ${where(ctx.layers, c.path)}`).join(`
`));
  printIssues(ctx, "warnings (not blocking):", result.warnings);
  return 0;
}
async function runDreamInPi(ctx, o) {
  if (o.limit !== undefined && !/^[1-9]\d*$/.test(o.limit))
    throw new UsageError("--limit must be a positive whole number");
  const { parseSince, readRuns } = await import("./chunk-wd5047hy.js");
  if (o.since !== undefined && !parseSince(o.since, new Date))
    throw new UsageError("--since needs an age like 30d or 2w, or a date like 2026-10-01");
  const flags = [o.here && "--here", o.limit && `--limit ${o.limit}`, o.since && `--since ${o.since}`, o["dry-run"] && "--dry-run"].filter(Boolean);
  const previous = readRuns(ctx.env)[0]?.id;
  const { args, env } = dreamInvocation(ctx.layers[0].root, flags, ctx.env);
  const res = spawnSync("pi", args, {
    cwd: ctx.cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    maxBuffer: 67108864
  });
  if (res.error) {
    ctx.err(`o6y: could not start pi (${res.error.message}). Dreams run through pi, so it must be on PATH.`);
    return 1;
  }
  if (res.stdout?.trim())
    ctx.out(res.stdout.trim());
  if (res.stderr?.trim())
    ctx.err(res.stderr.trim());
  if (res.status !== 0)
    return res.status ?? 1;
  const run = readRuns(ctx.env)[0];
  return run && run.id !== previous && (run.status === "failed" || run.status === "aborted") ? 1 : 0;
}
function readInput(ctx, file) {
  if (file)
    return readFileSync(resolve(ctx.cwd, file), "utf8");
  const stdin = ctx.stdin();
  if (stdin === undefined)
    throw new UsageError("pass the content with --file <path> or on stdin");
  return stdin;
}
function edgeLines(store, edges, arrow) {
  return edges.map((e) => `${arrow} ${e.id} (${e.via.join(", ")}) — ${store.objects.get(e.id)?.summary ?? "not written yet"}`);
}
function parseSince(value) {
  const rel = /^(\d+)([mhdw])$/.exec(value);
  if (rel)
    return Date.now() - Number(rel[1]) * { m: 60000, h: 3600000, d: 86400000, w: 604800000 }[rel[2]];
  const abs = Date.parse(value);
  if (Number.isNaN(abs))
    throw new UsageError(`--since takes a duration (30m, 6h, 2d, 1w) or a date, not \`${value}\``);
  return abs;
}
function editSchema(plan, path, fn) {
  plan.write(path, editFrontmatter(plan.read(path) ?? "", fn));
}
var round = (n) => Math.round(n * 1000) / 1000;
function skippedNote(skipped) {
  const list = skipped.map((s) => `${s.id} (${s.reason})`).join(", ");
  return `${skipped.length} object(s) not indexed: ${list}; see \`o6y lint\``;
}
function wordMatch(store, question, type, limit) {
  const words = [...new Set(question.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])];
  if (!words.length)
    return [];
  const hits = [];
  for (const obj of store.objects.values()) {
    if (type && obj.type !== type)
      continue;
    const text = `${obj.id} ${obj.summary} ${obj.body}`.toLowerCase();
    const score = words.filter((w) => text.includes(w)).length / words.length;
    if (score > 0)
      hits.push({ obj, score, similarity: score });
  }
  return hits.sort((a, b) => b.score - a.score || a.obj.id.localeCompare(b.obj.id)).slice(0, limit);
}
var COMMANDS = {
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
      ...JSON_OPT
    },
    run(ctx, args, o) {
      const params = { type: o.type, linksTo: o["links-to"], linkedFrom: o["linked-from"], text: o.text ?? (args.join(" ") || undefined) };
      if (o.where) {
        params.where = Object.fromEntries(parseAssignments(o.where).map(([k, v]) => [k, typeof v === "number" || typeof v === "boolean" ? v : String(v)]));
      }
      if (o.limit)
        params.limit = Number(o.limit);
      const store = ctx.load();
      const results = query(store, params);
      if (o.json) {
        ctx.out(JSON.stringify(results.map((r) => ({ id: r.id, summary: r.summary, path: r.path, backlinks: store.backlinksOf(r.id).length })), null, 2));
      } else if (!results.length)
        ctx.out("No matching objects.");
      else {
        ctx.out(results.map((r) => `- [[${r.id}]] — ${r.summary}  (${displayPath(r.path)}; ${store.backlinksOf(r.id).length} backlinks)`).join(`
`));
      }
      return 0;
    }
  },
  search: {
    usage: "o6y search <question> [--type T] [--limit N] [--min-score S] [--no-rerank] [--json]",
    summary: "find objects by meaning (Cohere embeddings + rerank; word match when semantic search is off)",
    options: { type: { type: "string" }, limit: { type: "string" }, "min-score": { type: "string" }, "no-rerank": { type: "boolean" }, ...JSON_OPT },
    async run(ctx, args, o) {
      const question = args.join(" ").trim();
      if (!question)
        throw new UsageError("give a question to search for");
      const limit = o.limit ? Number(o.limit) : 10;
      const minScore = o["min-score"] === undefined ? undefined : Number(o["min-score"]);
      if (minScore !== undefined && !(minScore >= 0 && minScore <= 1))
        throw new UsageError("--min-score takes a number between 0 and 1");
      const store = ctx.load();
      const embedder = embedderFor(store, ctx.env, ctx.fetch);
      let hits;
      if (!embedder) {
        ctx.err(`o6y search: ${semanticUnavailable(store, ctx.env)}; falling back to word match`);
        hits = wordMatch(store, question, o.type, limit).filter((h) => h.score >= (minScore ?? 0));
      } else {
        const cache = cacheRoot(ctx.env);
        const synced = await syncIndex(store, embedder, cache);
        if (synced.skipped.length)
          ctx.err(`o6y search: ${skippedNote(synced.skipped)}`);
        const rerank = !o["no-rerank"];
        hits = await search(store, embedder, cache, question, { type: o.type, limit, rerank, minScore: minScore ?? (rerank ? store.semantic.threshold : 0) });
      }
      if (o.json) {
        ctx.out(JSON.stringify(hits.map((h) => ({ id: h.obj.id, score: round(h.score), similarity: round(h.similarity), summary: h.obj.summary, path: h.obj.path })), null, 2));
      } else if (!hits.length)
        ctx.out("No matching objects.");
      else
        ctx.out(hits.map((h) => `- [[${h.obj.id}]] (${h.score.toFixed(2)}) — ${h.obj.summary}  (${displayPath(h.obj.path)})`).join(`
`));
      return 0;
    }
  },
  reindex: {
    usage: "o6y reindex [--full]",
    summary: "bring the semantic search index up to date (--full re-embeds everything)",
    options: { full: { type: "boolean" } },
    async run(ctx, _args, o) {
      const store = ctx.load();
      const embedder = embedderFor(store, ctx.env, ctx.fetch);
      if (!embedder)
        throw new Error(semanticUnavailable(store, ctx.env));
      const r = await syncIndex(store, embedder, cacheRoot(ctx.env), { full: !!o.full });
      const lines = [`${r.total} objects indexed: ${r.embedded} embedded, ${r.removed} removed (cache: ${displayPath(cacheRoot(ctx.env))})`];
      if (r.skipped.length)
        lines.push(skippedNote(r.skipped));
      ctx.out(lines.join(`
`));
      return 0;
    }
  },
  suggestions: {
    usage: "o6y suggestions [--since 7d|DATE] [--json]",
    summary: "how often suggested objects were then opened, by score (from the local suggestion log)",
    options: { since: { type: "string" }, ...JSON_OPT },
    run(ctx, _args, o) {
      const cache = cacheRoot(ctx.env);
      const stats = suggestionStats(readSuggestionLog(cache), o.since ? new Date(parseSince(o.since)) : undefined);
      if (o.json) {
        ctx.out(JSON.stringify(stats, null, 2));
        return 0;
      }
      if (!stats.suggestions) {
        ctx.out(`No suggestions logged yet (${displayPath(suggestionLogPath(cache))}).`);
        return 0;
      }
      const pct = (used, of) => of ? `${Math.round(used / of * 100)}%` : "–";
      const lines = [
        `${stats.suggestions} objects suggested over ${stats.sessions} session(s); ${stats.used} opened afterwards (${pct(stats.used, stats.suggestions)})`,
        "",
        "By rerank score:",
        ...stats.bands.filter((b) => b.suggestions).map((b) => `  ${b.from.toFixed(2)}–${b.to.toFixed(2)}  ${pct(b.used, b.suggestions).padStart(4)} opened (${b.used}/${b.suggestions})`)
      ];
      if (stats.ignored.length)
        lines.push("", "Suggested but never opened:", ...stats.ignored.map((i) => `  ${i.id} (${i.times}×)`));
      ctx.out(lines.join(`
`));
      return 0;
    }
  },
  lint: {
    usage: "o6y lint [--json]",
    summary: "errors, warnings, wanted pages, orphans and undeclared fields (exit 1 on errors)",
    options: JSON_OPT,
    run(ctx, _args, o) {
      const store = ctx.load();
      const report = lint(store);
      if (o.json) {
        ctx.out(JSON.stringify({
          errors: store.errors(),
          warnings: store.issues.filter((i) => i.severity === "warning"),
          wanted: Object.fromEntries([...store.wanted].map(([id, from]) => [id, [...from].sort()]))
        }, null, 2));
      } else
        ctx.out(report.text);
      return report.errors ? 1 : 0;
    }
  },
  show: {
    usage: "o6y show <id>",
    summary: "print an object with its backlinks",
    run(ctx, [id]) {
      const store = ctx.load();
      if (id && !store.objects.has(id) && store.wanted.has(id)) {
        ctx.out(`${id} is not written yet. Linked from: ${[...store.wanted.get(id)].sort().join(", ")}`);
        return 0;
      }
      const obj = needObject(store, id);
      ctx.out(readFileSync(obj.path, "utf8").trimEnd() + `
` + renderObjectFooter(store, obj.id, obj.path));
      return 0;
    }
  },
  links: {
    usage: "o6y links <id> [--json]",
    summary: "what an object links to, and through which field",
    options: JSON_OPT,
    run(ctx, [id], o) {
      const store = ctx.load();
      if (!id)
        throw new UsageError("missing object id");
      const edges = neighbors(store, id).out;
      ctx.out(o.json ? JSON.stringify(edges, null, 2) : edges.length ? edgeLines(store, edges, "→").join(`
`) : `${id} links to nothing.`);
      return 0;
    }
  },
  backlinks: {
    usage: "o6y backlinks <id> [--json]",
    summary: "what links to an object (works for wanted pages too)",
    options: JSON_OPT,
    run(ctx, [id], o) {
      const store = ctx.load();
      if (!id)
        throw new UsageError("missing object id");
      const edges = neighbors(store, id).in;
      ctx.out(o.json ? JSON.stringify(edges, null, 2) : edges.length ? edgeLines(store, edges, "←").join(`
`) : `Nothing links to ${id}.`);
      return 0;
    }
  },
  index: {
    usage: "o6y index [type]",
    summary: "the generated catalog of the stores, or of one type",
    run(ctx, [type]) {
      const store = ctx.load();
      if (!type)
        ctx.out(renderRootIndex(store).trimEnd());
      else {
        const text = renderTypeIndex(store, type);
        if (!text)
          throw new UsageError(`no type \`${type}\``);
        ctx.out(text.trimEnd());
      }
      return 0;
    }
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
      const pct = (n) => `${Math.round(n / Math.max(1, stats.budget) * 100)}%`;
      ctx.out([
        `section: ${text.length} chars`,
        `  rules     ${stats.rules}`,
        `  guidance  ${stats.guidance}`,
        `  pinned    ${stats.pinned}  (pinnedBudget ${store.settings.pinnedBudget})`,
        `  catalog   ${stats.catalog}: full lines ${stats.lines} of promptBudget ${stats.budget} (${pct(stats.lines)}), slugs ${stats.names} of namesBudget ${stats.namesBudget}`,
        `objects: ${stats.objects} — ${stats.full} full lines, ${stats.named} by slug, ${stats.hidden} only in index.md`,
        stats.relevant.length ? `relevant to this directory: ${stats.relevant.join(", ")}` : "relevant to this directory: none"
      ].join(`
`));
      return 0;
    }
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
          objects: [...store.objects.values()].filter((obj) => obj.layer.name === l.name).length
        })),
        types: types.map((t) => ({ name: t.name, layer: t.layer.name, objects: store.objectsOfType(t.name).length })),
        links,
        wanted: store.wanted.size,
        orphans: orphans.length,
        errors: store.errors().length,
        warnings: store.issues.filter((i) => i.severity === "warning").length,
        pinned: { objects: pinned.length, chars: pinned.reduce((n, p) => n + pinnedCost(p), 0), budget: store.settings.pinnedBudget }
      };
      if (o.json) {
        ctx.out(JSON.stringify(data, null, 2));
        return 0;
      }
      ctx.out([
        ...data.stores.map((s) => `${s.name}: ${displayPath(s.root)} — ${s.exists ? `${s.objects} objects` : "not created"}`),
        `types: ${data.types.map((t) => `${t.name} ${t.objects}`).join(" · ") || "none"}`,
        `links: ${links} · wanted pages: ${data.wanted} · orphans: ${data.orphans}`,
        `issues: ${data.errors} errors · ${data.warnings} warnings`,
        `pinned: ${data.pinned.objects} objects, ${data.pinned.chars}/${data.pinned.budget} chars`
      ].join(`
`));
      return 0;
    }
  },
  log: {
    usage: "o6y log [--since 2d|DATE] [--limit N]",
    summary: "recent changes to the stores, newest first",
    options: { since: { type: "string" }, limit: { type: "string" } },
    run(ctx, _args, o) {
      const since = o.since ? parseSince(o.since) : 0;
      const entries = [];
      for (const layer of ctx.layers) {
        const path = join(layer.root, LOG_FILE);
        if (!existsSync(path))
          continue;
        for (const line of readFileSync(path, "utf8").split(`
`)) {
          const m = /^- (\S+) (.+)$/.exec(line);
          const at = m ? Date.parse(m[1]) : NaN;
          if (!m || Number.isNaN(at) || at < since)
            continue;
          entries.push({ at, line: `${m[1]} ${ctx.layers.length > 1 ? `${layer.name} ` : ""}${m[2]}` });
        }
      }
      entries.sort((a, b) => b.at - a.at);
      const shown = entries.slice(0, Number(o.limit ?? 30));
      ctx.out(shown.length ? shown.map((e) => e.line).join(`
`) : "No changes logged in that period.");
      return 0;
    }
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
        ctx.out(JSON.stringify({
          types: [...store.types.values()].map((t) => ({ name: t.name, layer: t.layer.name, ...t.schema })),
          objects: objects.map((obj) => ({
            id: obj.id,
            type: obj.type,
            layer: obj.layer.name,
            path: obj.path,
            summary: obj.summary,
            data: obj.data,
            body: obj.body,
            links: neighbors(store, obj.id).out.map((e) => ({ target: e.id, via: e.via }))
          }))
        }, null, 2));
        return 0;
      }
      const edges = objects.flatMap((obj) => neighbors(store, obj.id).out.map((e) => ({ from: obj.id, to: e.id, via: e.via.join(", ") })));
      const nodes = [...new Set([...objects.map((obj) => obj.id), ...edges.map((e) => e.to)])];
      if (format === "mermaid") {
        const key = new Map(nodes.map((id, i) => [id, `n${i}`]));
        ctx.out([
          "graph LR",
          ...nodes.map((id) => `  ${key.get(id)}["${id}"]${store.objects.has(id) ? "" : ":::wanted"}`),
          ...edges.map((e) => `  ${key.get(e.from)} -->|${e.via}| ${key.get(e.to)}`),
          "  classDef wanted stroke-dasharray: 4 4"
        ].join(`
`));
      } else if (format === "dot") {
        ctx.out([
          "digraph o6y {",
          "  rankdir=LR;",
          ...nodes.filter((id) => !store.objects.has(id)).map((id) => `  "${id}" [style=dashed];`),
          ...edges.map((e) => `  "${e.from}" -> "${e.to}" [label="${e.via}"];`),
          "}"
        ].join(`
`));
      } else
        throw new UsageError("--format must be json, mermaid or dot");
      return 0;
    }
  },
  check: {
    usage: "o6y check <id|path> [--file DRAFT]   (content on stdin if no --file)",
    summary: "validate a draft as if it were written there, without writing it",
    options: { file: { type: "string" } },
    run(ctx, [target], o) {
      if (!target)
        throw new UsageError("missing target id or path");
      const store = ctx.load();
      const path = target.includes("/") && (target.endsWith(".md") || target.startsWith(".") || target.startsWith("/") || target.startsWith("~")) ? canonicalPath(resolve(ctx.cwd, target.startsWith("~/") ? join(homedir(), target.slice(2)) : target)) : store.objects.get(target)?.path ?? objectPath(ctx.layers[0], target);
      if (!classifyPath(ctx.layers, path))
        throw new UsageError(`${target} is not inside an o6y store`);
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
    }
  },
  new: {
    usage: "o6y new <id> --summary TEXT [--set field=value]... [--body TEXT | --body-file F] [--dry-run]",
    summary: "create an object (fails if it exists)",
    options: { summary: { type: "string" }, set: { type: "string", multiple: true }, body: { type: "string" }, "body-file": { type: "string" }, ...DRY },
    run(ctx, [id], o) {
      needId(id);
      const store = ctx.load();
      if (store.objects.has(id))
        throw new UsageError(`${id} already exists (${displayPath(store.objects.get(id).path)}); use \`o6y set\` or edit it`);
      if (!o.summary)
        throw new UsageError("--summary is required");
      const path = objectPath(ctx.layers[0], id);
      const body = o["body-file"] ? readFileSync(resolve(ctx.cwd, o["body-file"]), "utf8") : o.body ?? "";
      const content = editFrontmatter("", (doc) => {
        doc.set("summary", o.summary);
        for (const [k, v] of parseAssignments(o.set ?? []))
          doc.set(k, v);
        return body ? `${body.trimEnd()}
` : "";
      });
      const plan = new Plan(ctx.layers);
      plan.write(path, content);
      return commit(ctx, plan, "o6y new", !!o["dry-run"]);
    }
  },
  set: {
    usage: "o6y set <id> field=value... [--unset field]... [--dry-run]",
    summary: "set or remove frontmatter fields (values are YAML: true, 3, [a, b])",
    options: { unset: { type: "string", multiple: true }, ...DRY },
    run(ctx, [id, ...assignments], o) {
      const obj = needObject(ctx.load(), id);
      const sets = parseAssignments(assignments);
      if (!sets.length && !o.unset?.length)
        throw new UsageError("nothing to set; pass field=value or --unset field");
      const plan = new Plan(ctx.layers);
      plan.write(obj.path, editFrontmatter(plan.read(obj.path), (doc) => {
        for (const [k, v] of sets)
          doc.set(k, v);
        for (const k of o.unset ?? [])
          doc.delete(k);
      }));
      return commit(ctx, plan, "o6y set", !!o["dry-run"]);
    }
  },
  mv: {
    usage: "o6y mv <old-id> <new-id> [--dry-run]",
    summary: "rename an object and rewrite every link to it",
    options: { ...DRY },
    run(ctx, [from, to], o) {
      const store = ctx.load();
      const obj = needObject(store, from);
      needId(to);
      if (store.objects.has(to))
        throw new UsageError(`${to} already exists; use \`o6y merge ${from} ${to}\` to combine them`);
      const dest = objectPath(obj.layer, to);
      const plan = new Plan(ctx.layers);
      retargetLinks(store, plan, (id) => id === from ? to : undefined);
      plan.write(dest, plan.read(obj.path));
      plan.inherit(dest, obj.path);
      plan.delete(obj.path);
      return commit(ctx, plan, "o6y mv", !!o["dry-run"]);
    }
  },
  merge: {
    usage: "o6y merge <from-id> <into-id> [--dry-run]",
    summary: "fold one object into another: repoint links, keep missing fields, append its body, delete it",
    options: DRY,
    run(ctx, [from, into], o) {
      const store = ctx.load();
      const src = needObject(store, from);
      const dst = needObject(store, into);
      if (src.id === dst.id)
        throw new UsageError("cannot merge an object into itself");
      const plan = new Plan(ctx.layers);
      retargetLinks(store, plan, (id) => id === src.id ? dst.id : undefined);
      const srcDoc = splitDoc(plan.read(src.path));
      plan.write(dst.path, editFrontmatter(plan.read(dst.path), (doc) => {
        for (const [k, v] of Object.entries(src.data)) {
          if (k !== "summary" && k !== "pinned" && !doc.has(k))
            doc.set(k, v);
        }
        const body = splitDoc(plan.read(dst.path)).body.trimEnd();
        const extra = srcDoc.body.trim();
        if (!extra)
          return;
        return `${body ? `${body}

` : ""}## Merged from ${src.id}

${extra}
`;
      }));
      plan.inherit(dst.path, src.path);
      plan.delete(src.path);
      return commit(ctx, plan, "o6y merge", !!o["dry-run"]);
    }
  },
  rm: {
    usage: "o6y rm <id>... [--dry-run]",
    summary: "delete objects; links to them become wanted pages (reported)",
    options: DRY,
    run(ctx, ids, o) {
      if (!ids.length)
        throw new UsageError("missing object id");
      const store = ctx.load();
      const plan = new Plan(ctx.layers);
      for (const id of ids)
        plan.delete(needObject(store, id).path);
      return commit(ctx, plan, "o6y rm", !!o["dry-run"]);
    }
  },
  field: {
    usage: [
      "o6y field add <type> <name> [TYPE] [--required] [--description D] [--values a,b] [--to t1,t2] [--many] [--default V] [--dry-run]",
      "o6y field rename <type> <old> <new> [--dry-run]",
      "o6y field drop <type> <name> [--keep-values] [--dry-run]"
    ].join(`
       `),
    summary: "change a type's fields and migrate its objects in one validated step",
    options: {
      required: { type: "boolean" },
      description: { type: "string" },
      values: { type: "string" },
      to: { type: "string" },
      many: { type: "boolean" },
      default: { type: "string" },
      "keep-values": { type: "boolean" },
      ...DRY
    },
    run(ctx, [action, typeName, ...rest], o) {
      const store = ctx.load();
      const type = typeName ? store.types.get(typeName) : undefined;
      if (!action || !["add", "rename", "drop"].includes(action))
        throw new UsageError("expected add, rename or drop");
      if (!type)
        throw new UsageError(`no type \`${typeName ?? ""}\``);
      const plan = new Plan(ctx.layers);
      plan.mechanical = true;
      const objects = store.objectsOfType(type.name);
      if (action === "add") {
        const [name2, kind = "string"] = rest;
        if (!name2)
          throw new UsageError("missing field name");
        if (type.schema.fields[name2])
          throw new UsageError(`${type.name} already declares \`${name2}\``);
        const extra = {};
        if (o.required)
          extra.required = true;
        if (o.description)
          extra.description = o.description;
        if (o.values)
          extra.values = String(o.values).split(",").map((v) => v.trim());
        if (o.to)
          extra.to = String(o.to).includes(",") ? String(o.to).split(",").map((v) => v.trim()) : o.to;
        if (o.many)
          extra.many = true;
        const spec = Object.keys(extra).length ? { type: kind, ...extra } : kind;
        editSchema(plan, type.path, (doc) => {
          if (!doc.has("fields") || doc.get("fields") === null)
            doc.set("fields", doc.createNode({}));
          doc.setIn(["fields", name2], doc.createNode(spec, { flow: typeof spec === "object" }));
        });
        if (o.default !== undefined) {
          const value = parseValue(o.default);
          for (const obj of objects) {
            if (obj.data[name2] === undefined)
              plan.write(obj.path, editFrontmatter(plan.read(obj.path), (doc) => void doc.set(name2, value)));
          }
        }
        return commit(ctx, plan, "o6y field add", !!o["dry-run"]);
      }
      if (action === "rename") {
        const [from, to] = rest;
        if (!from || !to)
          throw new UsageError("usage: o6y field rename <type> <old> <new>");
        if (type.schema.fields[to])
          throw new UsageError(`${type.name} already declares \`${to}\``);
        const clash = objects.find((obj) => obj.data[to] !== undefined && obj.data[from] !== undefined);
        if (clash)
          throw new UsageError(`${clash.id} already has both \`${from}\` and \`${to}\`; resolve it first`);
        if (type.schema.fields[from]) {
          editSchema(plan, type.path, (doc) => {
            const fields = doc.get("fields", true);
            renameKey(fields, from, to);
            const index = doc.toJS().index ?? [];
            if (index.includes(from))
              doc.set("index", doc.createNode(index.map((f) => f === from ? to : f), { flow: true }));
          });
        }
        for (const obj of objects) {
          if (obj.data[from] === undefined)
            continue;
          plan.write(obj.path, editFrontmatter(plan.read(obj.path), (doc) => void renameKey(doc.contents, from, to)));
        }
        return commit(ctx, plan, "o6y field rename", !!o["dry-run"]);
      }
      const [name] = rest;
      if (!name)
        throw new UsageError("missing field name");
      if (type.schema.fields[name]) {
        editSchema(plan, type.path, (doc) => {
          doc.deleteIn(["fields", name]);
          const index = doc.toJS().index ?? [];
          if (index.includes(name)) {
            const next = index.filter((f) => f !== name);
            if (next.length)
              doc.set("index", doc.createNode(next, { flow: true }));
            else
              doc.delete("index");
          }
        });
      } else if (o["keep-values"])
        throw new UsageError(`${type.name} doesn't declare \`${name}\``);
      if (!o["keep-values"]) {
        for (const obj of objects) {
          if (obj.data[name] !== undefined)
            plan.write(obj.path, editFrontmatter(plan.read(obj.path), (doc) => void doc.delete(name)));
        }
      }
      return commit(ctx, plan, "o6y field drop", !!o["dry-run"]);
    }
  },
  type: {
    usage: "o6y type rename <old> <new> [--dry-run]",
    summary: "rename a type: move its folder, rewrite ids in links and `to:` in other schemas",
    options: DRY,
    run(ctx, [action, from, to], o) {
      if (action !== "rename")
        throw new UsageError("expected `rename`");
      const store = ctx.load();
      if (!from || !store.types.has(from))
        throw new UsageError(`no type \`${from ?? ""}\``);
      if (!to || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(to))
        throw new UsageError("new type name must be kebab-case");
      if (store.types.has(to))
        throw new UsageError(`type \`${to}\` already exists`);
      const plan = new Plan(ctx.layers);
      plan.mechanical = true;
      retargetLinks(store, plan, (id) => id.startsWith(`${from}/`) ? `${to}${id.slice(from.length)}` : undefined);
      for (const t of store.types.values()) {
        const fields = t.schema.fields;
        for (const [name, f] of Object.entries(fields)) {
          if (f.type !== "link" || f.to === "any" || !f.to?.includes(from))
            continue;
          editSchema(plan, t.path, (doc) => {
            const raw = doc.getIn(["fields", name, "to"]);
            const value = raw && typeof raw === "object" ? raw.toJSON() : raw;
            const next = Array.isArray(value) ? value.map((v) => v === from ? to : v) : to;
            doc.setIn(["fields", name, "to"], doc.createNode(next, { flow: true }));
          });
        }
      }
      for (const layer of ctx.layers) {
        const dir = join(layer.root, from);
        if (!existsSync(dir))
          continue;
        for (const file of readdirSync(dir)) {
          if (!file.endsWith(".md"))
            continue;
          const path = join(dir, file);
          plan.write(join(layer.root, to, file), plan.read(path));
          plan.inherit(join(layer.root, to, file), path);
          plan.delete(path);
        }
      }
      return commit(ctx, plan, "o6y type rename", !!o["dry-run"]);
    }
  },
  mcp: {
    usage: "o6y mcp",
    summary: "deprecated: serve the stores as a local MCP server over stdio",
    async run(ctx) {
      ctx.err("o6y mcp is deprecated and will be removed in a future release; o6y is a pi extension.");
      const [{ serve }, { StdioServerTransport }] = await Promise.all([
        import("./chunk-c4z34wqa.js"),
        import("@modelcontextprotocol/sdk/server/stdio.js")
      ]);
      const transport = new StdioServerTransport;
      process.stdin.once("end", () => void transport.close());
      await serve({ cwd: ctx.cwd, env: ctx.env, layers: ctx.layers, runCli: main, fetch: ctx.fetch }, transport);
      return 0;
    }
  },
  dream: {
    usage: `o6y dream [--json]
       o6y dream run [--here] [--limit N] [--since 30d|DATE] [--dry-run]   (needs pi on PATH; applies without review)`,
    summary: "show how many sessions are waiting and the last dream, or run a dream",
    options: { ...JSON_OPT, ...DRY, here: { type: "boolean" }, limit: { type: "string" }, since: { type: "string" } },
    async run(ctx, [action], o) {
      if (action === "run")
        return runDreamInPi(ctx, o);
      if (action)
        throw new UsageError("expected `o6y dream` or `o6y dream run`");
      const { dreamStatus, formatStatus } = await import("./chunk-wd5047hy.js");
      const status = dreamStatus(ctx.cwd, ctx.env);
      ctx.out(o.json ? JSON.stringify({ ...status, last: status.last ? { id: status.last.id, status: status.last.status, startedAt: status.last.startedAt, changes: status.last.changes.length, cost: status.last.cost } : null }, null, 2) : formatStatus(status));
      return 0;
    }
  },
  graph: {
    usage: "o6y graph [--focus ID] [--out FILE] [--no-open]",
    summary: "write the whole store as an interactive graph page and open it in your browser",
    options: { focus: { type: "string" }, out: { type: "string" }, "no-open": { type: "boolean" } },
    async run(ctx, _args, o) {
      const store = ctx.load();
      if (o.focus && !store.objects.has(o.focus))
        throw new UsageError(`no object \`${o.focus}\``);
      const [{ graphData, renderGraphHtml }, { cacheRoot: cacheRoot2 }] = await Promise.all([import("./chunk-jzqfbt58.js"), import("./chunk-2w8dr3rf.js")]);
      const path = o.out ? resolve(ctx.cwd, o.out) : join(cacheRoot2(ctx.env), "graph.html");
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, renderGraphHtml(graphData(store), o.focus), { mode: 384 });
      ctx.out(path);
      if (ctx.isTTY && !o["no-open"])
        spawnSync(process.platform === "darwin" ? "open" : "xdg-open", [path], { stdio: "ignore" });
      return 0;
    }
  },
  view: {
    usage: "o6y view [id] [--activity | --dreams | --graph]",
    summary: "live terminal viewer (also: plain `o6y` in a terminal)",
    options: { activity: { type: "boolean" }, dreams: { type: "boolean" }, graph: { type: "boolean" } },
    async run(ctx, [id], o) {
      if (!ctx.isTTY)
        throw new UsageError("the viewer needs an interactive terminal");
      process.env.NODE_ENV ??= "production";
      const { runViewer } = await import("./chunk-r6s3ntjd.js");
      await runViewer(ctx.layers, { current: id, view: o.graph ? "graph" : o.dreams ? "dreams" : o.activity ? "activity" : "browse", history: [], filter: "", open: [] });
      return 0;
    }
  }
};
var GROUPS = [
  ["Read", ["query", "show", "links", "backlinks", "index", "lint", "stats", "log", "prompt", "export"]],
  ["Write (validated as one change; --dry-run previews)", ["new", "set", "mv", "merge", "rm", "field", "type", "check"]],
  ["Semantic search (opt-in: semantic.enabled in the root schema, CO_API_KEY)", ["search", "reindex", "suggestions"]],
  ["Dreaming", ["dream"]],
  ["Viewer", ["view", "graph"]],
  ["Deprecated", ["mcp"]]
];
function help() {
  const lines = [
    "o6y — query and maintain o6y memory stores",
    "",
    "Usage: o6y [--global DIR] <command> [args]",
    "The store defaults to $O6Y_HOME or ~/.agents/o6y."
  ];
  for (const [title, names] of GROUPS) {
    lines.push("", `${title}:`);
    for (const name of names)
      lines.push(`  ${name.padEnd(10)} ${COMMANDS[name].summary}`);
  }
  lines.push("", "`o6y help <command>` shows a command's options. Ids are type/slug, e.g. note/release-train.");
  return lines.join(`
`);
}
function expandHome(p) {
  return p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p;
}
async function main(argv, io) {
  const args = [...argv];
  const take = (flag) => {
    const i = args.indexOf(flag);
    if (i < 0)
      return;
    const value = args[i + 1];
    args.splice(i, 2);
    return value;
  };
  const globalFlag = take("--global");
  const layers = makeLayers(resolve(io.cwd, expandHome(globalFlag || io.env.O6Y_HOME || join(homedir(), ".agents", "o6y"))));
  const ctx = { ...io, layers, load: () => Store.load(layers) };
  let name = args.shift();
  if (!name)
    name = io.isTTY ? "view" : "help";
  if (name === "--help" || name === "-h")
    name = "help";
  if (name === "help") {
    const topic = args[0] && COMMANDS[args[0]];
    io.out(topic ? `${topic.usage}

${topic.summary}` : help());
    return 0;
  }
  const command = COMMANDS[name];
  if (!command) {
    io.err(`o6y: unknown command \`${name}\`

${help()}`);
    return 2;
  }
  if (args.includes("--help") || args.includes("-h")) {
    io.out(`${command.usage}

${command.summary}`);
    return 0;
  }
  try {
    const { values, positionals } = parseArgs({ args, options: command.options ?? {}, allowPositionals: true, strict: true });
    return await command.run(ctx, positionals, values);
  } catch (err) {
    if (err instanceof UsageError || err instanceof TypeError && "code" in err && String(err.code).startsWith("ERR_PARSE_ARGS")) {
      io.err(`o6y ${name}: ${err.message}
usage: ${command.usage}`);
      return 2;
    }
    if (err instanceof Error) {
      io.err(`o6y ${name}: ${err.message}`);
      return 1;
    }
    throw err;
  }
}

// src/cli/o6y.ts
process.exitCode = await main(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  out: (text) => process.stdout.write(`${text}
`),
  err: (text) => process.stderr.write(`${text}
`),
  stdin: () => process.stdin.isTTY ? undefined : readFileSync2(0, "utf8"),
  isTTY: !!process.stdin.isTTY && !!process.stdout.isTTY
});
