import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { makeLayers, Store } from "../src/core/store.ts";
import {
  activityLine,
  activityRows,
  joinParagraphs,
  neighbors,
  parseLog,
  plain,
  readActivity,
  renderActivityPage,
  renderPage,
  renderTypePage,
  renderWantedPage,
  rowKey,
  searchLine,
  treeRows,
  typeKey,
  WANTED_KEY,
  wrap,
} from "../src/viewer/model.ts";

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

test("treeRows: headers collapsed unless open; filtering opens matches", () => {
  const store = load();
  expect(treeRows(store, "", new Set()).map(rowKey)).toEqual(["type:note", WANTED_KEY]);
  expect(treeRows(store, "", new Set([typeKey("note")])).map(rowKey)).toEqual(["type:note", "note/a", "note/b", "note/c", WANTED_KEY]);
  expect(treeRows(store, "ghost", new Set()).map(rowKey)).toEqual(["type:note", "note/c", WANTED_KEY, "note/ghost"]);
});

test("type and wanted pages list their objects as links", () => {
  const store = load();
  const type = renderTypePage(store, "note", 60);
  expect(type.links).toEqual(["note/a", "note/b", "note/c"]);
  expect(type.lines.map(plain).join("\n")).toContain("related  link→any[]");
  expect(renderWantedPage(store, 60).links).toEqual(["note/ghost"]);
});

test("renderPage: fields, joined body, links and backlinks", () => {
  const page = renderPage(load(), "note/a", 60);
  const text = page.lines.map(plain).join("\n");
  expect(text).toContain("related  [[note/b]]");
  expect(text).toContain("See [[note/c]] and wrapped text.");
  expect(page.links).toEqual(["note/b", "note/c", "note/b"]);
  expect(plain(page.lines[page.linkLines[2]!]!)).toStartWith("← note/b");
});

const at = (iso: string) => Date.parse(iso);

test("parseLog reads log.md lines and skips anything else", () => {
  const log = [
    "# o6y log",
    "",
    "- 2026-10-29T14:02:11Z update note/a (edit)",
    "- 2026-10-29T14:05:40Z create schema note (o6y field add)",
    "- not a log line",
    "- 2026-10-29T14:06:00Z delete note/old-thing (o6y mv)",
  ].join("\n");
  expect(parseLog(log, "global")).toEqual([
    { at: at("2026-10-29T14:02:11Z"), action: "update", target: "note/a", via: "edit", layer: "global" },
    { at: at("2026-10-29T14:05:40Z"), action: "create", target: "schema note", via: "o6y field add", layer: "global" },
    { at: at("2026-10-29T14:06:00Z"), action: "delete", target: "note/old-thing", via: "o6y mv", layer: "global" },
  ]);
});

test("readActivity merges every layer's log.md, newest first", () => {
  put("log.md", "- 2026-10-28T09:00:00Z create note/a (write)\n- 2026-10-29T10:00:00Z update note/b (edit)\n");
  const proj = join(tmp, "proj");
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, "log.md"), "- 2026-10-29T12:00:00Z create note/p (o6y new)\n");
  const entries = readActivity(makeLayers(root, proj));
  expect(entries.map((e) => `${e.action} ${e.target} ${e.layer}`)).toEqual(["create note/p project", "update note/b global", "create note/a global"]);
  expect(readActivity(makeLayers(join(tmp, "nowhere")))).toEqual([]);
});

test("activityRows: day headers, same-second batches collapse unless open", () => {
  const now = new Date("2026-10-29T18:00:00");
  const e = (iso: string, action: "create" | "update" | "delete", target: string, via: string) => ({ at: Date.parse(iso), action, target, via, layer: "global" });
  const entries = [
    e("2026-10-29T15:00:00", "update", "note/a", "edit"),
    e("2026-10-29T14:00:00", "update", "note/b", "bash"),
    e("2026-10-29T14:00:00", "update", "note/c", "bash"),
    e("2026-10-29T14:00:00", "delete", "note/d", "bash"),
    e("2026-10-28T09:00:00", "create", "note/a", "write"),
    e("2026-10-20T09:00:00", "create", "note/b", "write"),
  ];
  const rows = activityRows(entries, new Set(), "", now);
  const outline = rows.map((r) => (r.kind === "day" ? `# ${r.label} (${r.count})` : r.kind === "batch" ? `batch of ${r.entries.length}` : r.entry.target));
  expect(outline).toEqual(["# Today (4)", "note/a", "batch of 3", "# Yesterday (1)", "note/a", "# Tue, Oct 20 (1)", "note/b"]);
  const batch = rows.find((r) => r.kind === "batch")!;
  const opened = activityRows(entries, new Set([batch.key]), "", now);
  expect(opened.filter((r) => r.kind === "entry" && r.nested).map((r) => (r as { entry: { target: string } }).entry.target)).toEqual(["note/b", "note/c", "note/d"]);
  // Keys stay unique, even for identical entries.
  const twice = activityRows([entries[0]!, entries[0]!], new Set(), "", now);
  expect(new Set(twice.map((r) => r.key)).size).toBe(twice.length);
  // A query matches the target or the source.
  expect(activityRows(entries, new Set(), "write", now).filter((r) => r.kind === "entry")).toHaveLength(2);
});

test("activity lines and pages", () => {
  const store = load();
  const now = new Date("2026-10-29T18:00:00");
  const entries = [
    { at: Date.parse("2026-10-29T15:04:00"), action: "update" as const, target: "note/a", via: "edit", layer: "global" },
    { at: Date.parse("2026-10-29T15:03:00"), action: "delete" as const, target: "note/gone", via: "o6y rm", layer: "global" },
  ];
  const rows = activityRows(entries, new Set(), "", now);
  const [, a, gone] = rows;
  expect(plain(activityLine(store, a!, 40, false))).toMatch(/^15:04 ~ note\/a +edit$/);
  expect(plain(activityLine(store, gone!, 40, false))).toMatch(/^15:03 − note\/gone +o6y rm$/);
  for (const r of [a!, gone!]) expect(plain(activityLine(store, r, 40, false))).toHaveLength(40);
  expect(activityLine(store, gone!, 40, false)[2]!.color).toBe("red");

  // An entry's page is the object's page under a line saying what happened; links still work.
  const page = renderActivityPage(store, a!, 60);
  expect(plain(page.lines[0]!)).toContain("~ updated");
  expect(plain(page.lines[2]!)).toContain("note/a");
  expect(page.links).toContain("note/b");
  expect(plain(page.lines[page.linkLines[0]!]!)).toContain(page.links[0]!);
  expect(plain(renderActivityPage(store, gone!, 60).lines[3]!)).toBe("No longer in the store.");

  const batchEntries = ["note/a", "note/b", "note/gone"].map((target) => ({ ...entries[0]!, target, via: "bash" }));
  const batch = activityRows(batchEntries, new Set(), "", now)[1]!;
  expect(plain(activityLine(store, batch, 40, false))).toBe("15:04 ▸ 3 changes  ~3 · bash");
  const batchPage = renderActivityPage(store, batch, 60);
  expect(batchPage.links).toEqual(["note/a", "note/b"]);
});

test("search lines dim results under the threshold", () => {
  const store = load();
  const above = searchLine(store, { key: "note/a", id: "note/a", score: 0.62, similarity: 0.4 }, 30, false, 0.35);
  const below = searchLine(store, { key: "note/b", id: "note/b", score: 0.2, similarity: 0.3 }, 30, false, 0.35);
  expect(plain(above)).toBe("0.62 note/a");
  expect(above[0]!.color).toBe("green");
  expect(below[1]!.dim).toBe(true);
});

test("wrap and joinParagraphs", () => {
  expect(wrap("- one two three four", 10)).toEqual(["- one two", "  three", "  four"]);
  expect(joinParagraphs(["a", "b", "", "- x", "  y", "```", "c", "d", "```"])).toEqual(["a b", "", "- x y", "```", "c", "d", "```"]);
});
