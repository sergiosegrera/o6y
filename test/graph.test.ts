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

test("a heavily linked hub doesn't blow up the layout", () => {
  const html = renderGraphHtml({ nodes: [], links: [], types: [] } as never);
  const source = html.slice(html.indexOf("function tick() {") + "function tick() {".length, html.indexOf("function loop()")).replace(/\}\s*$/, "");
  const tick = new Function("shown", "links", "dragging", "state", `var MAX_SPEED = ${/MAX_SPEED = (\d+)/.exec(html)![1]}, alpha = state.alpha; ${source}; state.alpha = alpha;`);
  const nodes: any[] = Array.from({ length: 302 }, (_, i) => ({ x: 14 * Math.sqrt(i + 1) * Math.cos(i * 2.4), y: 14 * Math.sqrt(i + 1) * Math.sin(i * 2.4), vx: 0, vy: 0, near: new Set() }));
  const links = nodes.slice(1, 291).map((t) => ({ s: nodes[0], t }));
  for (const { s, t } of links) (s.near.add(t), t.near.add(s));
  const state = { alpha: 1 };
  for (let i = 0; i < 320; i++) tick(new Set(nodes), links, null, state);
  expect(Math.max(...nodes.map((d) => Math.abs(d.x)), ...nodes.map((d) => Math.abs(d.y)))).toBeLessThan(5000);
});

test("the page's markup has no escape codes from the bundler", () => {
  const html = renderGraphHtml({ nodes: [], links: [], types: [] } as never);
  expect(html.slice(0, html.indexOf("<script"))).not.toMatch(/\\[ux][0-9a-fA-F]{2}/);
  expect(html).toContain("&minus;");
});

test("the graph carries fields, the layer and logged changes", () => {
  put("note/b.md", "---\nsummary: B\nowner: \"[[note/hub]]\"\ntags: [x, y]\n---\nbody\n");
  put("log.md", "# o6y log\n\n- 2026-03-01T10:00:00Z create note/b (cli)\n- 2026-03-02T10:00:00Z update root schema (cli)\n- 2026-03-03T10:00:00Z update note/b (dream) [pi:abc]\n");
  const data = graphData(load());
  const b = data.nodes.find((n) => n.id === "note/b")!;
  expect(b.layer).toBe("global");
  expect(b.fields).toEqual([["owner", ["[[note/hub]]"]], ["tags", ["x", "y"]]]);
  expect(data.events).toEqual([
    { at: "2026-03-01T10:00:00Z", action: "create", id: "note/b", via: "cli" },
    { at: "2026-03-03T10:00:00Z", action: "update", id: "note/b", via: "dream" },
  ]);
});

test("the live page asks for updates; the file page doesn't", () => {
  const data = graphData(load());
  expect(renderGraphHtml(data)).not.toContain('"live":true');
  expect(renderGraphHtml(data, undefined, true)).toContain('"live":true');
});

test("the live server serves the page under a secret path and reports changes", async () => {
  const { serveGraph } = await import("../src/viewer/graphServer.ts");
  const server = await serveGraph(makeLayers(tmp), load, { watchMs: 50 });
  try {
    const root = new URL(server.url);
    expect((await fetch(new URL("/", root))).status).toBe(404);
    expect((await fetch(new URL("/nope/data", root))).status).toBe(404);
    const page = await fetch(server.url);
    expect(await page.text()).toContain('"live":true');
    const before: any = await (await fetch(server.url + "data")).json();
    expect(before.nodes.some((n: any) => n.id === "note/new")).toBe(false);

    const events = await fetch(server.url + "events");
    const reader = events.body!.getReader();
    await reader.read();
    put("note/new.md", "---\nsummary: New\n---\n");
    const deadline = Date.now() + 4000;
    let text = "";
    while (!text.includes("event: change") && Date.now() < deadline) text += new TextDecoder().decode((await reader.read()).value);
    expect(text).toContain("event: change");
    reader.cancel();
    const after: any = await (await fetch(server.url + "data")).json();
    expect(after.nodes.some((n: any) => n.id === "note/new")).toBe(true);
  } finally {
    await server.close();
  }
});
