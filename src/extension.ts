import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  appendLog,
  bootstrap,
  changesToLog,
  describe,
  storeSignature,
  diffSnapshot,
  hasChanges,
  restoreSnapshot,
  type Snapshot,
  takeSnapshot,
} from "./core/fsops.ts";
import { workPaths } from "./core/context.ts";
import { ensureFormat } from "./core/format.ts";
import { lint } from "./core/ops.ts";
import { renderObjectFooter, renderPromptSection, renderRootIndex, renderTypeIndex } from "./core/render.ts";
import {
  blockingIssues,
  canonicalPath,
  changeWarnings,
  classifyPath,
  formatIssues,
  INDEX_FILE,
  type Issue,
  type Layer,
  LOG_FILE,
  makeLayers,
  type PathInfo,
  Store,
} from "./core/store.ts";

function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p;
}

/** Resolves a tool path argument the way pi's file tools do (~ expansion, @ prefix, cwd-relative). */
function resolveToolPath(path: string, cwd: string): string {
  const cleaned = path.startsWith("@") ? path.slice(1) : path;
  return canonicalPath(resolve(cwd, expandHome(cleaned)));
}

function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Applies read's 1-indexed offset/limit to generated text. */
function sliceLines(text: string, offset: unknown, limit: unknown): string {
  const lines = text.split("\n");
  const start = typeof offset === "number" && offset > 0 ? offset - 1 : 0;
  const end = typeof limit === "number" && limit > 0 ? start + limit : lines.length;
  return lines.slice(start, end).join("\n");
}

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SKILL_PATH = join(PACKAGE_ROOT, "skills", "o6y", "SKILL.md");

/**
 * Makes the `o6y` command available to the agent's bash: pi builds the shell environment from its
 * own, so the launcher in bin/ goes on PATH, pointed at this Node and at the stores in use.
 */
function exposeCli(layers: Layer[]): void {
  const bin = join(PACKAGE_ROOT, "bin");
  const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === "path") ?? "PATH";
  const current = process.env[pathKey] ?? "";
  if (!current.split(delimiter).includes(bin)) process.env[pathKey] = [bin, current].filter(Boolean).join(delimiter);
  // Only when pi runs on a plain Node or Bun binary; a compiled pi binary can't run scripts.
  if (/^(node|bun)(\.exe)?$/i.test(basename(process.execPath))) process.env.O6Y_NODE = process.execPath;
  process.env.O6Y_HOME = layers[0]!.root;
  if (layers[1]) process.env.O6Y_PROJECT = layers[1].root;
}

const SCHEMA_MIGRATION_HINT =
  "\nSchema changes must not invalidate existing objects. Migrate the objects first (extra fields are allowed), or perform the schema change and the migration in a single bash command.";

type Pending =
  | { tool: "write"; path: string; existed: boolean; warnings: Issue[] }
  | { tool: "edit"; path: string; info: PathInfo; original: string | null; before: Store }
  | { tool: "bash"; snapshot: Snapshot; before: Store };

/**
 * o6y never replaces pi's tools. It hooks `tool_call`/`tool_result` for read, write, edit and bash,
 * so it composes with other extensions, including ones that provide their own implementations.
 */
export default function o6y(pi: ExtensionAPI) {
  // The manual is a skill so only its description costs prompt space; loaded on demand.
  pi.on("resources_discover", () => ({ skillPaths: [SKILL_PATH] }));

  pi.registerFlag("o6y-global", { type: "string", description: "Path of the global o6y store (default ~/.agents/o6y)" });
  pi.registerFlag("o6y-project", { type: "string", description: "Path of the project o6y store (default <cwd>/.agents/o6y)" });

  let layers: Layer[] = [];
  let promptSection = "";
  /** Store fingerprint when promptSection was computed; the section is rebuilt when it changes. */
  let promptSignature = "";
  let workDirs: string[] = [];
  const pending = new Map<string, Pending>();

  function configure(cwd: string): void {
    const flagGlobal = pi.getFlag("o6y-global");
    const flagProject = pi.getFlag("o6y-project");
    const globalRoot = expandHome(
      (typeof flagGlobal === "string" && flagGlobal) || process.env.O6Y_HOME || join(homedir(), ".agents", "o6y"),
    );
    const projectRoot = expandHome(
      (typeof flagProject === "string" && flagProject) || process.env.O6Y_PROJECT || join(cwd, ".agents", "o6y"),
    );
    layers = makeLayers(resolve(cwd, globalRoot), resolve(cwd, projectRoot));
    workDirs = workPaths(cwd);
    exposeCli(layers);
  }

  const load = () => Store.load(layers);

  function refreshPrompt(): Store {
    promptSignature = storeSignature(layers);
    const store = load();
    promptSection = renderPromptSection(store, { workPaths: workDirs });
    return store;
  }

  function managedFileReason(info: PathInfo): string | undefined {
    if (info.kind === "root-index" || info.kind === "type-index") {
      return `[o6y] ${INDEX_FILE} is virtual and generated on read; it cannot be written. Edit objects or schemas instead.`;
    }
    if (info.kind === "log") return `[o6y] ${LOG_FILE} is append-only and maintained by o6y; it cannot be written.`;
    return undefined;
  }

  function rejection(info: PathInfo, path: string, blocking: Issue[]): string {
    const isSchema = info.kind === "type-schema" || info.kind === "root-schema";
    const hint = isSchema && blocking.some((i) => i.path !== path) ? SCHEMA_MIGRATION_HINT : "";
    return `[o6y] write rejected; nothing was changed.\n${formatIssues(blocking, layers)}${hint}`;
  }

  function warningsNote(warnings: Issue[]): string {
    return `\n[o6y] saved with warnings (not blocking; fix when you can, e.g. by writing the missing objects):\n${formatIssues(warnings, layers)}`;
  }

  // --- Before a tool runs: validate writes up front, remember state for edits and bash. ---

  pi.on("tool_call", async (event, ctx) => {
    if (!["read", "write", "edit", "bash"].includes(event.toolName)) return;
    if (!layers.length) configure(ctx.cwd);
    const input = event.input as Record<string, unknown>;

    if (event.toolName === "bash") {
      if (layers.some((l) => existsSync(l.root))) {
        pending.set(event.toolCallId, { tool: "bash", snapshot: takeSnapshot(layers), before: load() });
      }
      return;
    }
    if (typeof input.path !== "string") return;
    const path = resolveToolPath(input.path, ctx.cwd);
    const info = classifyPath(layers, path);
    if (!info || event.toolName === "read") return;

    const managed = managedFileReason(info);
    if (managed) return { block: true, reason: managed };

    if (event.toolName === "write" && typeof input.content === "string") {
      // The full content is known, so the write is validated before anything touches disk.
      const before = load();
      const after = Store.load(layers, new Map([[path, input.content]]));
      const touched = new Set([path]);
      const blocking = blockingIssues(before, after, touched);
      if (blocking.length) return { block: true, reason: rejection(info, path, blocking) };
      pending.set(event.toolCallId, { tool: "write", path, existed: existsSync(path), warnings: changeWarnings(before, after, touched) });
    } else if (event.toolName === "edit") {
      // The edited content is only known after the tool applies it; validated in tool_result.
      pending.set(event.toolCallId, { tool: "edit", path, info, original: readOrNull(path), before: load() });
    }
  });

  // --- After a tool runs: serve virtual reads, validate edits and bash, log, report. ---

  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName === "read") {
      if (!layers.length) configure(ctx.cwd);
      const input = event.input as Record<string, unknown>;
      if (typeof input.path !== "string") return;
      const path = resolveToolPath(input.path, ctx.cwd);
      const info = classifyPath(layers, path);
      if (info?.kind === "root-index" || info?.kind === "type-index") {
        const store = load();
        const generated =
          info.kind === "root-index"
            ? renderRootIndex(store)
            : (renderTypeIndex(store, info.type) ?? `No type \`${info.type}\`: create ${join(info.layer.root, info.type, ".schema.md")} first.`);
        const text = sliceLines(generated, input.offset, input.limit);
        return { content: [{ type: "text", text }], structuredContent: text, isError: false };
      }
      if (info?.kind === "object" && !event.isError) {
        const footer = renderObjectFooter(load(), info.id, path);
        const result: { content: typeof event.content; structuredContent?: typeof event.structuredContent } = {
          content: [...event.content, { type: "text", text: footer }],
        };
        if (typeof event.structuredContent === "string") result.structuredContent = `${event.structuredContent}\n${footer}`;
        return result;
      }
      return;
    }

    const state = pending.get(event.toolCallId);
    if (!state) return;
    pending.delete(event.toolCallId);

    if (state.tool === "write") {
      if (event.isError) return;
      appendLog(layers, [{ action: state.existed ? "update" : "create", path: state.path }], "write");
      if (state.warnings.length) return { content: [...event.content, { type: "text", text: warningsNote(state.warnings) }] };
      return;
    }

    if (state.tool === "edit") {
      if (event.isError) return;
      const after = load();
      const touched = new Set([state.path]);
      const blocking = blockingIssues(state.before, after, touched);
      if (blocking.length) {
        if (state.original === null) rmSync(state.path, { force: true });
        else writeFileSync(state.path, state.original);
        return {
          content: [{ type: "text", text: rejection(state.info, state.path, blocking).replace("nothing was changed", "the edit was reverted") }],
          structuredContent: undefined,
          isError: true,
        };
      }
      appendLog(layers, [{ action: "update", path: state.path }], "edit");
      const warnings = changeWarnings(state.before, after, touched);
      if (warnings.length) return { content: [...event.content, { type: "text", text: warningsNote(warnings) }] };
      return;
    }

    // bash: validate the whole store as a transaction.
    const changes = diffSnapshot(state.snapshot, layers);
    if (!hasChanges(changes)) return;
    const after = load();
    const blocking = blockingIssues(state.before, after, new Set());
    const count = changes.created.length + changes.modified.length + changes.deleted.length;
    if (blocking.length) {
      restoreSnapshot(state.snapshot, layers);
      return {
        content: [
          ...event.content,
          {
            type: "text",
            text: `\n[o6y] This command changed ${count} file(s) in the memory store and left it invalid, so ALL its store changes were rolled back:\n${formatIssues(blocking, layers)}\nFix the command (or migrate in a different order) and run it again.`,
          },
        ],
        structuredContent: undefined,
        isError: true,
      };
    }
    // `o6y` write commands log their own changes (with the command name); don't log those twice.
    const loggedByCli = (path: string) =>
      layers.some((layer) => {
        const logPath = join(layer.root, LOG_FILE);
        const before = state.snapshot.files.get(logPath)?.toString("utf8") ?? "";
        const added = readOrNull(logPath)?.slice(before.length) ?? "";
        return added.includes(` ${describe(layers, path)} (o6y `);
      });
    appendLog(layers, changesToLog(changes).filter((c) => !loggedByCli(c.path)), "bash");
    const warnings = changeWarnings(state.before, after, new Set());
    const note = warnings.length ? ` New warnings (not blocking):\n${formatIssues(warnings, layers)}` : "";
    return {
      content: [...event.content, { type: "text", text: `\n[o6y] ${count} store change(s) validated and logged.${note}` }],
    };
  });

  // --- Commands ---

  pi.registerCommand("o6y-lint", {
    description: "Health-check the o6y memory store",
    handler: async (_args, ctx) => {
      const report = lint(load());
      ctx.ui.notify(report.text, report.errors ? "warning" : "info");
    },
  });

  pi.registerCommand("o6y", {
    description: "Show o6y store status and refresh the memory index in the system prompt",
    handler: async (_args, ctx) => {
      const store = refreshPrompt();
      const lines = [
        ...layers.map((l) => `${l.name}: ${l.root}${existsSync(l.root) ? "" : " (not created yet)"}`),
        `${store.types.size} types, ${store.objects.size} objects, ${store.errors().length} errors, ${store.wanted.size} wanted`,
        "Memory index in the system prompt refreshed.",
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // --- Lifecycle ---

  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    configure(ctx.cwd);
    const seeded = bootstrap(layers[0]!.root);
    if (seeded.length) appendLog(layers, seeded.map((path) => ({ action: "create" as const, path })), "bootstrap");
    for (const layer of layers) {
      const result = ensureFormat(layer);
      if (result.status === "newer" && ctx.hasUI) {
        ctx.ui.notify(`o6y: the ${layer.name} store uses format ${result.version}, newer than this o6y supports; update o6y (pi update --extensions)`, "warning");
      } else if (result.status === "migrated") {
        appendLog(layers, [{ action: "update", path: join(layer.root, ".schema.md") }], `migrate format ${result.from}→${result.to}`);
      }
    }
    const store = refreshPrompt();
    const errors = store.errors().length;
    if (errors && ctx.hasUI) ctx.ui.notify(`o6y: ${errors} validation error(s) in the memory store; run /o6y-lint`, "warning");
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (!layers.length) configure(ctx.cwd);
    // Rebuild when memory changed since the last prompt (written this session, or edited outside
    // pi). Pi appends section changes as a transcript delta, so the cached prefix stays valid.
    if (!promptSection || storeSignature(layers) !== promptSignature) refreshPrompt();
    event.systemPromptOptions.sections.o6y = promptSection;
  });

  pi.on("session_shutdown", async () => {
    pending.clear();
  });
}
