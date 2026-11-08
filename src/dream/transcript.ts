/** Reads pi session files (JSONL) and renders them as plain text for a dream to read. */
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Entry {
  type: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  [key: string]: any;
}

export interface Transcript {
  id: string;
  file: string;
  cwd: string;
  startedAt: string;
  entries: Entry[];
}

/** The part of a transcript no dream has read yet. */
export interface PendingTranscript {
  transcript: Transcript;
  entries: Entry[];
  /** The last entry on the active branch; recorded in the ledger once dreamed. */
  leaf: string;
}

const RELEVANT_MESSAGE = "o6y-relevant";

export function sessionsRoot(env: Record<string, string | undefined>): string {
  return env.PI_CODING_AGENT_SESSION_DIR || join(homedir(), ".pi", "agent", "sessions");
}

function jsonlFiles(dir: string, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) jsonlFiles(full, out);
    else if (entry.name.endsWith(".jsonl")) out.push(full);
  }
  return out;
}

/** Parses one session file; undefined when it has no session header. A torn last line is ignored. */
export function parseTranscript(file: string, text: string): Transcript | undefined {
  const parsed: Entry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      parsed.push(JSON.parse(line));
    } catch {}
  }
  const header = parsed[0];
  if (header?.type !== "session" || typeof header.id !== "string") return undefined;
  return { id: header.id, file, cwd: String(header.cwd ?? ""), startedAt: String(header.timestamp ?? ""), entries: parsed.slice(1) };
}

export function listTranscripts(root: string): Transcript[] {
  const out: Transcript[] = [];
  for (const file of jsonlFiles(root)) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const transcript = parseTranscript(file, text);
    if (transcript) out.push(transcript);
  }
  return out.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

/** The entries on the active branch, root first: the path from the last entry back through parents. */
export function activeBranch(entries: Entry[]): Entry[] {
  const byId = new Map(entries.filter((e) => e.id).map((e) => [e.id!, e]));
  const leaf = entries.findLast((e) => e.id);
  const branch: Entry[] = [];
  const seen = new Set<string>();
  for (let at = leaf; at?.id && !seen.has(at.id); at = at.parentId ? byId.get(at.parentId) : undefined) {
    seen.add(at.id);
    branch.push(at);
  }
  return branch.reverse();
}

const hasUserMessage = (entries: Entry[]) => entries.some((e) => e.type === "message" && e.message?.role === "user");

/**
 * What's left to dream in a transcript, given the leaf recorded last time. If that leaf is no
 * longer on the active branch, the whole branch is read again. Undefined when no new user turn
 * exists, so sessions that never got past startup don't count.
 */
export function pendingPart(transcript: Transcript, doneLeaf: string | undefined): PendingTranscript | undefined {
  const branch = activeBranch(transcript.entries);
  const leaf = branch.at(-1)?.id;
  if (!leaf || leaf === doneLeaf) return undefined;
  const from = doneLeaf ? branch.findIndex((e) => e.id === doneLeaf) + 1 : 0;
  const entries = branch.slice(from);
  return hasUserMessage(entries) ? { transcript, entries, leaf } : undefined;
}

function trim(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.ceil((max * 2) / 3);
  const tail = max - head;
  return `${text.slice(0, head)}\n…[${text.length - max} characters omitted]…\n${text.slice(text.length - tail)}`;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (block?.type === "text" ? String(block.text ?? "") : block?.type === "image" ? "[image]" : ""))
    .filter(Boolean)
    .join("\n");
}

function renderMessage(m: any, max: number): string[] {
  switch (m?.role) {
    case "user":
      return [`USER: ${textOf(m.content)}`];
    case "assistant": {
      const out: string[] = [];
      for (const block of Array.isArray(m.content) ? m.content : [{ type: "text", text: m.content }]) {
        if (block?.type === "text" && block.text) out.push(`ASSISTANT: ${block.text}`);
        else if (block?.type === "toolCall") out.push(`TOOL CALL ${block.name}: ${trim(JSON.stringify(block.arguments ?? {}), max)}`);
      }
      return out;
    }
    case "toolResult":
      return [`TOOL RESULT ${m.toolName}${m.isError ? " (error)" : ""}: ${trim(textOf(m.content), max)}`];
    case "bashExecution":
      return [`USER SHELL: ${m.command}\nOUTPUT: ${trim(String(m.output ?? ""), max)}`];
    default:
      return [];
  }
}

/** Plain text for a dream: messages, tool calls and (trimmed) results; no system prompts or thinking. */
export function renderEntries(entries: Entry[], maxToolResultChars: number): string {
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.type === "message") out.push(...renderMessage(entry.message, maxToolResultChars));
    else if (entry.type === "compaction" || entry.type === "branch_summary") out.push(`EARLIER WORK, SUMMARIZED: ${entry.summary}`);
    else if (entry.type === "custom_message" && entry.display && entry.customType !== RELEVANT_MESSAGE) {
      out.push(`NOTE (${entry.customType}): ${trim(textOf(entry.content), maxToolResultChars)}`);
    }
  }
  return out.join("\n\n");
}

/** Splits text into pages of at most `size` characters, on line breaks where possible. */
export function paginate(text: string, size: number): string[] {
  const pages: string[] = [];
  let rest = text;
  while (rest.length > size) {
    const cut = rest.lastIndexOf("\n", size);
    const at = cut > size / 2 ? cut + 1 : size;
    pages.push(rest.slice(0, at));
    rest = rest.slice(at);
  }
  pages.push(rest);
  return pages;
}
