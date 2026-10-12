import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { makeLayers, Store } from "../src/core/store.ts";
import { joinParagraphs, linkTree, neighbors, plain, renderPage, treeLine, treeRows, wrap } from "../src/viewer/model.ts";

let tmp: string;
let root: string;

function put(rel: string, content: string) {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o6y-viewer-"));
  root = join(tmp, "global");
  put("note/.schema.md", "---\ndescription: A note\nfields:\n  related: { type: link, many: true }\n---\n");
  put("note/a.md", "---\nsummary: A\nrelated: [note/b]\n---\nSee [[note/c]] and\nwrapped text.\n");
  put("note/b.md", "---\nsummary: B\npinned: true\n---\nBack to [[note/a]].\n");
  put("note/c.md", "---\nsummary: C\n---\nMentions [[note/ghost]].\n");
});

afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const load = () => Store.load(makeLayers(root, join(tmp, "proj")));

test("neighbors: outgoing with via, incoming, wanted pages", () => {
  const store = load();
  const a = neighbors(store, "note/a");
  expect(a.out).toEqual([
    { id: "note/b", via: ["related"], missing: false },
    { id: "note/c", via: ["body"], missing: false },
  ]);
  expect(a.in.map((e) => e.id)).toEqual(["note/b"]);
  const ghost = neighbors(store, "note/ghost");
  expect(ghost.out).toEqual([]);
  expect(ghost.in.map((e) => e.id)).toEqual(["note/c"]);
});

test("treeRows: types, objects, wanted; filtering", () => {
  const store = load();
  const rows = treeRows(store);
  expect(rows.map((r) => r.kind)).toEqual(["type", "object", "object", "object", "wanted-header", "wanted"]);
  const filtered = treeRows(store, "back to");
  expect(filtered.filter((r) => r.kind === "object").map((r) => (r as { id: string }).id)).toEqual(["note/b"]);
});

test("renderPage: fields, joined body, links and backlinks", () => {
  const page = renderPage(load(), "note/a", 60);
  const text = page.lines.map(plain).join("\n");
  expect(text).toContain("related  [[note/b]]");
  expect(text).toContain("See [[note/c]] and wrapped text.");
  expect(page.links).toEqual(["note/b", "note/c", "note/b"]);
  expect(plain(page.lines[page.linkLines[2]!]!)).toStartWith("← note/b");
});

test("linkTree expands links then backlinks, marks cycles, draws guides", () => {
  const store = load();
  const collapsed = linkTree(store, "note/a", new Set());
  expect(collapsed.map((n) => [n.id, n.expandable, n.expanded])).toEqual([["note/a", true, false]]);

  // a ↔ b (a links b via `related`, b links a in its body); a → c → ghost
  const open = linkTree(store, "note/a", new Set(["note/a", "note/a>out:note/c", "note/a>both:note/b"]));
  expect(open.map((n) => `${"  ".repeat(n.depth)}${n.dir}:${n.id}`)).toEqual([
    "root:note/a",
    "  both:note/b",
    "  out:note/c",
    "    out:note/ghost",
  ]);
  expect(open[1]!.via).toEqual(["related", "body"]);
  expect(open[1]!.expandable).toBe(false); // its only neighbor is the parent
  expect(open.find((n) => n.id === "note/ghost")!.missing).toBe(true);

  const lines = open.map((n) => plain(treeLine(store, n, 60, false)));
  expect(lines[0]).toBe("▾ note/a — A");
  expect(lines[1]).toBe("├─   ↔ note/b — B");
  expect(lines[2]).toBe("└─ ▾ → note/c — C");
  expect(lines[3]).toBe("   └─   → note/ghost — not written yet");

  // A link back to an ancestor further up is marked as a cycle, not expanded.
  put("note/ghost.md", "---\nsummary: G\n---\nBack to [[note/a]].\n");
  const deep = linkTree(load(), "note/a", new Set(["note/a", "note/a>out:note/c", "note/a>out:note/c>out:note/ghost"]));
  const cycle = deep.find((n) => n.key === "note/a>out:note/c>out:note/ghost>out:note/a")!;
  expect(cycle.cycle).toBe(true);
  expect(cycle.expandable).toBe(false);
});

test("wrap and joinParagraphs", () => {
  expect(wrap("- one two three four", 10)).toEqual(["- one two", "  three", "  four"]);
  expect(joinParagraphs(["a", "b", "", "- x", "  y", "```", "c", "d", "```"])).toEqual(["a b", "", "- x y", "```", "c", "d", "```"]);
});
