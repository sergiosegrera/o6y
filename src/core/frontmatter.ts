import { parse } from "yaml";

export interface ParsedDoc {
  /** Parsed frontmatter, or undefined when the document has none. */
  data: Record<string, unknown> | undefined;
  body: string;
  /** Present when the frontmatter exists but is not a valid YAML mapping. */
  error?: string;
}

const FENCE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n?---[ \t]*(?:\r?\n|$)/;

export function parseDoc(text: string): ParsedDoc {
  const match = FENCE.exec(text);
  if (!match) return { data: undefined, body: text };
  const body = text.slice(match[0].length);
  const raw = match[1] ?? "";
  if (raw.trim() === "") return { data: {}, body };
  try {
    const data = parse(raw);
    if (data === null || data === undefined) return { data: {}, body };
    if (typeof data !== "object" || Array.isArray(data)) {
      return { data: undefined, body, error: "frontmatter must be a YAML mapping (key: value pairs)" };
    }
    return { data: data as Record<string, unknown>, body };
  } catch (err) {
    const message = err instanceof Error ? err.message.split("\n")[0] : String(err);
    return { data: undefined, body, error: `invalid YAML frontmatter: ${message}` };
  }
}
