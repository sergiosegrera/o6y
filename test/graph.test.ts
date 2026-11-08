import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adjacency, graphData, renderGraphHtml } from "../src/core/graph.ts";
import { makeLayers, Store } from "../src/core/store.ts";
import { busiest, localGraph, renderLocalGraph } from "../src/viewer/graph.ts";
import { managedLine, plain, renderPage } from "../src/viewer/model.ts";

let tmp: string;
const put = (rel: string, text: string) => writeFileSync(join(tmp, rel), text);
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o6y-graph-"));
  mkdirSync(join(tmp, "note"));
  put(".schema.md", "---\n---\n");
  put("note/.schema.md", "---\ndescription: Notes\n---\n");
  put("note/hub.md", "---\nsummary: Hub\no6y:\n  created: 2026-01-02\n  updated: 2026-02-03\n---\n[[note/a]] [[note/b]] [[note/ghost]]\n");
  put("note/a.md", "---\nsummary: A </script><img src=x>\n---\n[[note/far]]\n");
  put("note/b.md", "---\nsummary: B\n---\n");
  put("note/far.md", "---\nsummary: Far\n---\n");
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));
const load = () => Store.load(makeLayers(tmp));

test("the graph holds objects, wanted pages and links", () => {
  const data = graphData(load());
  expect(data.nodes.find((n) => n.id === "note/ghost")!.wanted).toBe(true);
  expect(data.nodes.find((n) => n.id === "note/hub")!.updated).toBe("2026-02-03");
  expect(data.links).toContainEqual({ source: "note/hub", target: "note/a" });
});

test("the local graph widens with depth, and the busiest object is the default centre", () => {
  const adj = adjacency(graphData(load()));
  expect(busiest(adj)).toBe("note/hub");
  expect(localGraph(adj, "note/hub", 1).map((n) => n.id)).not.toContain("note/far");
  expect(localGraph(adj, "note/hub", 2).find((n) => n.id === "note/far")).toMatchObject({ hop: 2, parent: "note/a" });
  expect(localGraph(adj, "note/none", 1)).toEqual([]);
});

test("the drawing fits its box and labels the centre and the selection", () => {
  const store = load();
  const adj = adjacency(graphData(store));
  const lines = renderLocalGraph(store, localGraph(adj, "note/hub", 2), adj, "note/a", 60, 20).map(plain);
  expect(lines).toHaveLength(20);
  for (const l of lines) expect(l.length).toBeLessThanOrEqual(60);
  expect(lines.join("\n")).toContain("note/hub");
  expect(lines.join("\n")).toContain(" a ");
  expect(lines.join("\n")).toContain("far");
  expect(lines.join("\n")).toContain("ghost");
});

test("object text can't break out of the graph page", () => {
  const html = renderGraphHtml(graphData(load()), "note/hub");
  expect(html).not.toContain("</script><img");
  expect(html).toContain("\\u003c/script>");
  expect(html).not.toMatch(/https?:\/\//);
  expect(html).not.toContain("innerHTML");
});

test("pages mark managed attributes and don't list them as a field", () => {
  const lines = renderPage(load(), "note/hub", 80).lines.map(plain);
  expect(lines.some((l) => l.startsWith(" o6y  created 2026-01-02 updated 2026-02-03"))).toBe(true);
  expect(lines.some((l) => l.startsWith("o6y  "))).toBe(false);
  expect(managedLine(undefined)).toBeUndefined();
  expect(plain(managedLine({ updated: "2026-02-03" }, new Date("2026-02-05T12:00:00"))!)).toContain("(2d ago)");
});
