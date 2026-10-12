export const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const ID_RE = /^([a-z0-9]+(?:-[a-z0-9]+)*)\/([a-z0-9]+(?:-[a-z0-9]+)*)$/;

export interface BodyLink {
  /** Raw text between the brackets, before `|` or `#`. */
  target: string;
  line: number;
}

const WIKILINK_RE = /\[\[([^\]\n]+?)\]\]/g;

/** Extracts `[[target]]`, `[[target|label]]` and `[[target#heading]]` links, ignoring code. */
export function extractBodyLinks(body: string): BodyLink[] {
  const links: BodyLink[] = [];
  let inFence = false;
  body.split("\n").forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    const withoutInlineCode = line.replace(/`[^`]*`/g, "");
    for (const match of withoutInlineCode.matchAll(WIKILINK_RE)) {
      const target = (match[1] ?? "").split("|")[0]!.split("#")[0]!.trim();
      links.push({ target, line: i + 1 });
    }
  });
  return links;
}

export function parseId(id: string): { type: string; slug: string } | undefined {
  const match = ID_RE.exec(id);
  return match ? { type: match[1]!, slug: match[2]! } : undefined;
}

/**
 * Normalizes a frontmatter link value into link targets. Accepts `type/slug`, `"[[type/slug]]"`,
 * and unquoted `[[type/slug]]`, which YAML parses as a nested array.
 */
export function normalizeLinkValue(value: unknown): string[] | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    const wiki = /^\[\[([^\]]+)\]\]$/.exec(trimmed);
    const inner = wiki ? wiki[1]! : trimmed;
    return [inner.split("|")[0]!.split("#")[0]!.trim()];
  }
  if (Array.isArray(value)) {
    const out: string[] = [];
    for (const item of value) {
      const inner = normalizeLinkValue(item);
      if (!inner) return undefined;
      out.push(...inner);
    }
    return out;
  }
  return undefined;
}
