import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Plan, retargetLinks } from "../src/core/edit.ts";
import { stampObject } from "../src/core/managed.ts";
import { makeLayers, Store } from "../src/core/store.ts";

const day = (d: string) => ({ now: new Date(`${d}T12:00:00`) });
const doc = (text: string) => `---\nsummary: "A: note"\ntags:   [a,   b]\n---\n${text}\n`;

test("a new object gets created and updated; formatting is kept", () => {
  const out = stampObject(null, doc("hello"), day("2026-01-02"));
  expect(out).toBe(`---\nsummary: "A: note"\ntags:   [a,   b]\no6y:\n  created: 2026-01-02\n  updated: 2026-01-02\n---\nhello\n`);
});

test("a change updates the date; created stays", () => {
  const first = stampObject(null, doc("one"), day("2026-01-02"));
  const out = stampObject(first, doc("two"), day("2026-02-03"));
  expect(out).toContain("created: 2026-01-02");
  expect(out).toContain("updated: 2026-02-03");
});

test("a writer can't forge the block, and rewriting only the block changes nothing", () => {
  const first = stampObject(null, doc("one"), day("2026-01-02"));
  const forged = first.replace("created: 2026-01-02", "created: 1999-01-01");
  expect(stampObject(first, forged, day("2026-03-03"))).toBe(first);
  expect(stampObject(first, doc("one"), day("2026-03-03"))).toBe(first);
});

test("stamping twice gives the same result", () => {
  const first = stampObject(null, doc("one"), day("2026-01-02"));
  const next = stampObject(first, doc("two"), day("2026-02-03"));
  expect(stampObject(first, next, day("2026-02-03"))).toBe(next);
});

test("objects from before managed attributes don't invent a created date", () => {
  const out = stampObject(doc("one"), doc("two"), day("2026-02-03"));
  expect(out).toContain("updated: 2026-02-03");
  expect(out).not.toContain("created:");
  expect(stampObject(doc("one"), doc("one"), day("2026-02-03"))).toBe(doc("one"));
});

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o6y-managed-"));
  mkdirSync(join(tmp, "note"));
  writeFileSync(join(tmp, ".schema.md"), "---\n---\n");
  writeFileSync(join(tmp, "note/.schema.md"), "---\ndescription: Notes\n---\n");
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

test("a plan stamps objects, and a rename or link rewrite keeps their history", () => {
  const layers = makeLayers(tmp);
  const a = join(tmp, "note/a.md");
  const b = join(tmp, "note/b.md");
  const c = join(tmp, "note/c.md");
  const old = stampObject(null, "---\nsummary: A\n---\nBody\n", day("2020-01-01"));
  writeFileSync(a, old);
  const before = stampObject(null, "---\nsummary: B\n---\nSee [[note/a]]\n", day("2020-01-01"));
  writeFileSync(b, before);

  const plan = new Plan(layers);
  plan.source = "pi:new";
  retargetLinks(Store.load(layers), plan, (id) => (id === "note/a" ? "note/c" : undefined));
  plan.write(c, plan.read(a)!);
  plan.inherit(c, a);
  plan.delete(a);
  expect(plan.validate().blocking).toEqual([]);
  plan.apply("test");

  expect(readFileSync(c, "utf8")).toBe(old);
  const linked = readFileSync(b, "utf8");
  expect(linked).toContain("[[note/c]]");
  expect(linked).toContain("updated: 2020-01-01");
  expect(linked).not.toContain("sources");
  expect(readFileSync(join(tmp, "log.md"), "utf8")).toContain("update note/b (test) [pi:new]");
});
