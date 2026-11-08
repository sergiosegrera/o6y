#!/usr/bin/env node

// src/dream/transcript.ts
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
function sessionsRoot(env) {
  return env.PI_CODING_AGENT_SESSION_DIR || join(homedir(), ".pi", "agent", "sessions");
}
function jsonlFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory())
      jsonlFiles(full, out);
    else if (entry.name.endsWith(".jsonl"))
      out.push(full);
  }
  return out;
}
function parseTranscript(file, text) {
  const parsed = [];
  for (const line of text.split(`
`)) {
    if (!line.trim())
      continue;
    try {
      parsed.push(JSON.parse(line));
    } catch {}
  }
  const header = parsed[0];
  if (header?.type !== "session" || typeof header.id !== "string")
    return;
  return { id: header.id, file, cwd: String(header.cwd ?? ""), startedAt: String(header.timestamp ?? ""), entries: parsed.slice(1) };
}
function listTranscripts(root) {
  const out = [];
  for (const file of jsonlFiles(root)) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const transcript = parseTranscript(file, text);
    if (transcript)
      out.push(transcript);
  }
  return out.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}
function activeBranch(entries) {
  const byId = new Map(entries.filter((e) => e.id).map((e) => [e.id, e]));
  const leaf = entries.findLast((e) => e.id);
  const branch = [];
  const seen = new Set;
  for (let at = leaf;at?.id && !seen.has(at.id); at = at.parentId ? byId.get(at.parentId) : undefined) {
    seen.add(at.id);
    branch.push(at);
  }
  return branch.reverse();
}
var hasUserMessage = (entries) => entries.some((e) => e.type === "message" && e.message?.role === "user");
function pendingPart(transcript, doneLeaf) {
  const branch = activeBranch(transcript.entries);
  const leaf = branch.at(-1)?.id;
  if (!leaf || leaf === doneLeaf)
    return;
  const from = doneLeaf ? branch.findIndex((e) => e.id === doneLeaf) + 1 : 0;
  const entries = branch.slice(from);
  return hasUserMessage(entries) ? { transcript, entries, leaf } : undefined;
}

export { sessionsRoot, listTranscripts, pendingPart };
