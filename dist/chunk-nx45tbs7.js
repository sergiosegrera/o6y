#!/usr/bin/env node
import {
  RESERVED_FIELDS,
  formatIssues,
  normalizeLinkValue
} from "./chunk-byp1kbkq.js";

// src/core/ops.ts
function lint(store) {
  const errors = store.issues.filter((i) => i.severity === "error");
  const warnings = store.issues.filter((i) => i.severity === "warning");
  const orphans = [...store.objects.values()].filter((o) => !store.backlinks.has(o.id) && o.fieldLinks.length === 0 && o.bodyLinks.length === 0);
  const sections = [
    `o6y lint: ${store.objects.size} objects, ${store.types.size} types — ${errors.length} errors, ${warnings.length} warnings, ${store.wanted.size} wanted, ${orphans.length} orphans`
  ];
  if (errors.length)
    sections.push(`## Errors
${formatIssues(errors, store.layers)}`);
  if (warnings.length)
    sections.push(`## Warnings (missing link targets, unknown link types)
${formatIssues(warnings, store.layers)}`);
  if (store.wanted.size) {
    sections.push(`## Wanted pages (linked, not written)
${[...store.wanted].map(([id, from]) => `- [[${id}]] ← ${[...from].sort().join(", ")}`).join(`
`)}`);
  }
  const undeclared = [...store.objects.values()].flatMap((o) => {
    const fields = store.types.get(o.type)?.schema.fields ?? {};
    const extra = Object.keys(o.data).filter((k) => !RESERVED_FIELDS.includes(k) && !(k in fields));
    return extra.length ? [`- [[${o.id}]]: ${extra.join(", ")}`] : [];
  });
  if (undeclared.length) {
    sections.push(`## Undeclared fields (allowed; leftovers from a migration, or worth adding to the schema?)
${undeclared.join(`
`)}`);
  }
  if (orphans.length) {
    sections.push(`## Orphans (no links in or out)
${orphans.map((o) => `- [[${o.id}]] — ${o.summary}`).join(`
`)}`);
  }
  return { text: sections.join(`

`), errors: errors.length, warnings: warnings.length };
}
function matchesValue(actual, expected) {
  if (actual === undefined || actual === null)
    return false;
  if (Array.isArray(actual) || typeof actual === "string" && actual.includes("[[")) {
    const links = normalizeLinkValue(actual);
    if (links?.includes(String(expected)))
      return true;
    if (Array.isArray(actual))
      return actual.some((a) => matchesValue(a, expected));
  }
  return String(actual) === String(expected);
}
function query(store, params) {
  let results = [...store.objects.values()];
  if (params.type)
    results = results.filter((o) => o.type === params.type);
  for (const [field, expected] of Object.entries(params.where ?? {})) {
    results = results.filter((o) => matchesValue(o.data[field], expected));
  }
  if (params.linksTo) {
    const sources = store.backlinks.get(params.linksTo) ?? new Set;
    results = results.filter((o) => sources.has(o.id));
  }
  if (params.linkedFrom) {
    const source = store.objects.get(params.linkedFrom);
    const targets = new Set([
      ...source?.fieldLinks.map((l) => l.target) ?? [],
      ...source?.bodyLinks.map((l) => l.target) ?? []
    ]);
    results = results.filter((o) => targets.has(o.id));
  }
  if (params.text) {
    const needle = params.text.toLowerCase();
    results = results.filter((o) => [o.id, o.summary, o.body].some((s) => s.toLowerCase().includes(needle)));
  }
  results.sort((a, b) => a.id.localeCompare(b.id));
  return results.slice(0, params.limit ?? 50);
}
function outgoing(obj) {
  const out = new Map;
  const add = (target, via) => {
    if (target === obj.id)
      return;
    const list = out.get(target) ?? [];
    if (!list.includes(via))
      list.push(via);
    out.set(target, list);
  };
  for (const l of obj.fieldLinks)
    add(l.target, l.field);
  for (const l of obj.bodyLinks)
    add(l.target, "body");
  return out;
}
function neighbors(store, id) {
  const obj = store.objects.get(id);
  const out = obj ? [...outgoing(obj)].map(([target, via]) => ({ id: target, via, missing: !store.objects.has(target) })) : [];
  const incoming = [];
  for (const source of store.objects.values()) {
    const via = outgoing(source).get(id);
    if (via)
      incoming.push({ id: source.id, via, missing: false });
  }
  const byId = (a, b) => a.id.localeCompare(b.id);
  return { out: out.sort(byId), in: incoming.sort(byId) };
}

export { lint, query, outgoing, neighbors };
