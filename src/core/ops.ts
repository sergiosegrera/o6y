import { normalizeLinkValue } from "./links.ts";
import { formatIssues, type ObjectEntry, type Store } from "./store.ts";

export interface LintReport {
  text: string;
  errors: number;
  warnings: number;
}

export function lint(store: Store): LintReport {
  const errors = store.issues.filter((i) => i.severity === "error");
  const warnings = store.issues.filter((i) => i.severity === "warning");
  const orphans = [...store.objects.values()].filter(
    (o) => !store.backlinks.has(o.id) && o.fieldLinks.length === 0 && o.bodyLinks.length === 0,
  );
  const sections: string[] = [
    `o6y lint: ${store.objects.size} objects, ${store.types.size} types — ${errors.length} errors, ${warnings.length} warnings, ${store.wanted.size} wanted, ${orphans.length} orphans`,
  ];
  if (errors.length) sections.push(`## Errors\n${formatIssues(errors, store.layers)}`);
  if (warnings.length) sections.push(`## Warnings (missing link targets, unknown link types)\n${formatIssues(warnings, store.layers)}`);
  if (store.wanted.size) {
    sections.push(
      `## Wanted pages (linked, not written)\n${[...store.wanted]
        .map(([id, from]) => `- [[${id}]] ← ${[...from].sort().join(", ")}`)
        .join("\n")}`,
    );
  }
  const undeclared = [...store.objects.values()].flatMap((o) => {
    const fields = store.types.get(o.type)?.schema.fields ?? {};
    const extra = Object.keys(o.data).filter((k) => k !== "summary" && !(k in fields));
    return extra.length ? [`- [[${o.id}]]: ${extra.join(", ")}`] : [];
  });
  if (undeclared.length) {
    sections.push(`## Undeclared fields (allowed; leftovers from a migration, or worth adding to the schema?)\n${undeclared.join("\n")}`);
  }
  if (orphans.length) {
    sections.push(`## Orphans (no links in or out)\n${orphans.map((o) => `- [[${o.id}]] — ${o.summary}`).join("\n")}`);
  }
  return { text: sections.join("\n\n"), errors: errors.length, warnings: warnings.length };
}

export interface QueryParams {
  type?: string;
  /** field -> expected value; for list/link fields matches if any element equals. */
  where?: Record<string, string | number | boolean>;
  /** Objects that link to this id. */
  linksTo?: string;
  /** Objects this id links to. */
  linkedFrom?: string;
  /** Case-insensitive substring of id, summary, or body. */
  text?: string;
  limit?: number;
}

function matchesValue(actual: unknown, expected: string | number | boolean): boolean {
  if (actual === undefined || actual === null) return false;
  if (Array.isArray(actual) || (typeof actual === "string" && actual.includes("[["))) {
    const links = normalizeLinkValue(actual);
    if (links?.includes(String(expected))) return true;
    if (Array.isArray(actual)) return actual.some((a) => matchesValue(a, expected));
  }
  return String(actual) === String(expected);
}

export function query(store: Store, params: QueryParams): ObjectEntry[] {
  let results = [...store.objects.values()];
  if (params.type) results = results.filter((o) => o.type === params.type);
  for (const [field, expected] of Object.entries(params.where ?? {})) {
    results = results.filter((o) => matchesValue(o.data[field], expected));
  }
  if (params.linksTo) {
    const sources = store.backlinks.get(params.linksTo) ?? new Set();
    results = results.filter((o) => sources.has(o.id));
  }
  if (params.linkedFrom) {
    const source = store.objects.get(params.linkedFrom);
    const targets = new Set([
      ...(source?.fieldLinks.map((l) => l.target) ?? []),
      ...(source?.bodyLinks.map((l) => l.target) ?? []),
    ]);
    results = results.filter((o) => targets.has(o.id));
  }
  if (params.text) {
    const needle = params.text.toLowerCase();
    results = results.filter((o) =>
      [o.id, o.summary, o.body].some((s) => s.toLowerCase().includes(needle)),
    );
  }
  results.sort((a, b) => a.id.localeCompare(b.id));
  return results.slice(0, params.limit ?? 50);
}

export function formatQuery(store: Store, results: ObjectEntry[]): string {
  if (!results.length) return "No matching objects.";
  return results
    .map((o) => `- [[${o.id}]] — ${o.summary}  (${o.path}; ${store.backlinks.get(o.id)?.size ?? 0} backlinks)`)
    .join("\n");
}
