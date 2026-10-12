import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ensureFormat, FORMAT_VERSION, readFormat } from "../src/core/format.ts";
import { parseDoc } from "../src/core/frontmatter.ts";
import { appendLog, bootstrap, diffSnapshot, restoreSnapshot, takeSnapshot } from "../src/core/fsops.ts";
import { extractBodyLinks, normalizeLinkValue } from "../src/core/links.ts";
import { lint, query } from "../src/core/ops.ts";
import { renderObjectFooter, renderPromptSection, renderRootIndex, renderTypeIndex } from "../src/core/render.ts";
import { parseTypeSchema } from "../src/core/schema.ts";
import { blockingIssues, changeWarnings, classifyPath, type Layer, makeLayers, Store } from "../src/core/store.ts";

let tmp: string;
let layers: Layer[];
let g: string;
let p: string;

function put(root: string, rel: string, content: string) {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

const PERSON = `---
description: A human
fields:
  name: { type: string, required: true }
  works_at: { type: link, to: org, many: true }
  status: { type: enum, values: [active, past] }
---
Bio first.
`;
const ORG = `---
description: An organization
---
`;

function obj(fm: string, body = "") {
  return `---\n${fm}\n---\n${body}`;
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o6y-"));
  g = join(tmp, "global");
  p = join(tmp, "proj");
  layers = makeLayers(g, p);
  g = layers[0]!.root;
  p = layers[1]!.root;
  put(g, ".schema.md", "---\nsummaryMaxLength: 40\n---\nBe concise.\n");
  put(g, "person/.schema.md", PERSON);
  put(g, "org/.schema.md", ORG);
  put(g, "org/openai.md", obj("summary: AI lab"));
});

afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("parsing", () => {
  test("frontmatter", () => {
    expect(parseDoc("---\na: 1\n---\nbody").data).toEqual({ a: 1 });
    expect(parseDoc("no fm").data).toBeUndefined();
    expect(parseDoc("---\n- x\n---\n").error).toContain("mapping");
    expect(parseDoc("---\na: [\n---\n").error).toContain("invalid YAML");
  });

  test("link value forms", () => {
    expect(normalizeLinkValue("org/openai")).toEqual(["org/openai"]);
    expect(normalizeLinkValue("[[org/openai]]")).toEqual(["org/openai"]);
    expect(normalizeLinkValue([["org/openai"]])).toEqual(["org/openai"]);
    expect(normalizeLinkValue(["[[org/a]]", "org/b"])).toEqual(["org/a", "org/b"]);
    expect(normalizeLinkValue(3)).toBeUndefined();
  });

  test("body links skip code", () => {
    const links = extractBodyLinks("see [[a/b|B]] and [[c/d#x]]\n`[[no/no]]`\n```\n[[no/no]]\n```\n");
    expect(links.map((l) => l.target)).toEqual(["a/b", "c/d"]);
  });

  test("schema DSL errors", () => {
    expect(parseTypeSchema("---\nfields: {}\n---\n").errors[0]).toContain("description");
    expect(parseTypeSchema("---\ndescription: x\nfields:\n  a: wat\n---\n").errors[0]).toContain("must be one of");
    expect(parseTypeSchema("---\ndescription: x\nfields:\n  summary: string\n---\n").errors[0]).toContain("reserved");
    expect(parseTypeSchema("---\ndescription: x\nfields:\n  s: { type: enum }\n---\n").errors[0]).toContain("values");
    const ok = parseTypeSchema("---\ndescription: x\nfields:\n  a: string\n  b: { type: link, to: [x, y], many: true }\n---\nguide");
    expect(ok.errors).toEqual([]);
    expect(ok.schema!.fields.b).toEqual({ type: "link", required: false, to: ["x", "y"], many: true });
    expect(ok.schema!.guidance).toBe("guide");
  });
});

describe("paths", () => {
  test("classification", () => {
    expect(classifyPath(layers, join(g, "index.md"))?.kind).toBe("root-index");
    expect(classifyPath(layers, join(g, "person/index.md"))?.kind).toBe("type-index");
    expect(classifyPath(layers, join(p, "person/ada.md"))).toMatchObject({ kind: "object", id: "person/ada" });
    expect(classifyPath(layers, join(g, "person/Ada.md"))?.kind).toBe("invalid");
    expect(classifyPath(layers, join(g, "person/x/y.md"))?.kind).toBe("invalid");
    expect(classifyPath(layers, join(g, "notes.md"))?.kind).toBe("invalid");
    expect(classifyPath(layers, join(tmp, "elsewhere.md"))).toBeUndefined();
  });
});

describe("validation", () => {
  test("valid object with links and backlinks", () => {
    put(g, "person/ada.md", obj("summary: Engineer\nname: Ada\nworks_at: [[org/openai]]", "Knows [[person/bob]]."));
    const store = Store.load(layers);
    expect(store.errors()).toEqual([]);
    expect(store.backlinksOf("org/openai")).toEqual(["person/ada"]);
    expect([...store.wanted.keys()]).toEqual(["person/bob"]);
  });

  test("field errors", () => {
    put(g, "person/ada.md", obj("summary: this summary is definitely way too long for the cap\nstatus: retired"));
    const msgs = Store.load(layers).errors().map((i) => i.message);
    expect(msgs.some((m) => m.includes("`summary` is"))).toBe(true);
    expect(msgs.some((m) => m.includes("`name` required"))).toBe(true);
    expect(msgs.some((m) => m.includes("`status` must be one of"))).toBe(true);
  });

  test("typed link type mismatch is an error, missing target a warning + wanted", () => {
    put(g, "person/ada.md", obj("summary: x\nname: Ada\nworks_at: [person/bob, org/nope]"));
    const store = Store.load(layers);
    expect(store.errors().map((i) => i.code)).toEqual(["link-type"]);
    expect(store.issues.filter((i) => i.code === "missing-link")).toHaveLength(2);
    expect(store.wanted.get("org/nope")).toEqual(new Set(["person/ada"]));
  });

  test("body link to unknown type is a warning, malformed link an error", () => {
    put(g, "org/acme.md", obj("summary: x", "[[planet/mars]] [[Bad Link]]"));
    const store = Store.load(layers);
    expect(store.errors().map((i) => i.code)).toEqual(["bad-link"]);
    expect(store.issues.filter((i) => i.severity === "warning").map((i) => i.code)).toEqual(["unknown-link-type"]);
    expect(store.wanted.has("planet/mars")).toBe(true);
  });

  test("objects need a schema; stray files flagged; index.md on disk flagged", () => {
    put(g, "thing/a.md", obj("summary: x"));
    put(g, "random.txt", "x");
    put(g, "org/index.md", "x");
    const codes = Store.load(layers).errors().map((i) => i.code).sort();
    expect(codes).toEqual(["invalid-path", "unknown-type", "virtual-file"]);
  });

  test("layers: project can use global types, add types, not shadow; one-way links", () => {
    put(p, "org/.schema.md", ORG);
    put(p, "tool/.schema.md", "---\ndescription: A tool\n---\n");
    put(p, "tool/bun.md", obj("summary: runtime", "by [[org/openai]]"));
    put(p, "person/me.md", obj("summary: me\nname: Me", "uses [[tool/bun]]"));
    put(g, "org/anthropic.md", obj("summary: lab", "[[tool/bun]]"));
    const store = Store.load(layers);
    const codes = store.errors().map((i) => i.code).sort();
    expect(codes).toEqual(["cross-layer", "shadowed-type"]); // global can't see project type `tool`
    expect(store.backlinksOf("tool/bun")).toEqual(["person/me"]);
    expect(store.backlinksOf("org/openai")).toEqual(["tool/bun"]);
  });

  test("duplicate ids across layers", () => {
    put(p, "org/openai.md", obj("summary: dup"));
    expect(Store.load(layers).errors().map((i) => i.code)).toEqual(["duplicate-id"]);
  });

  test("project settings override global", () => {
    put(p, ".schema.md", "---\nsummaryMaxLength: 200\n---\n");
    expect(Store.load(layers).settings.summaryMaxLength).toBe(200);
  });
});

describe("change checks", () => {
  test("missing typed link target does not block, but is reported as a warning", () => {
    const path = join(g, "person/ada.md");
    const before = Store.load(layers);
    const after = Store.load(layers, new Map([[path, obj("summary: x\nname: Ada\nworks_at: [org/nope]")]]));
    expect(blockingIssues(before, after, new Set([path]))).toEqual([]);
    expect(changeWarnings(before, after, new Set([path])).map((i) => i.code)).toEqual(["missing-link"]);
  });

  test("breaking schema change blocks, additive passes", () => {
    put(g, "person/ada.md", obj("summary: x\nname: Ada"));
    const schemaPath = join(g, "person/.schema.md");
    const before = Store.load(layers);
    const breaking = PERSON.replace("fields:\n", "fields:\n  born: { type: date, required: true }\n");
    const after = Store.load(layers, new Map([[schemaPath, breaking]]));
    const blocking = blockingIssues(before, after, new Set([schemaPath]));
    expect(blocking.map((i) => i.path)).toEqual([join(g, "person/ada.md")]);
    const additive = PERSON.replace("fields:\n", "fields:\n  born: date\n");
    expect(blockingIssues(before, Store.load(layers, new Map([[schemaPath, additive]])), new Set([schemaPath]))).toEqual([]);
  });

  test("deleting a linked object only yields warnings elsewhere", () => {
    const ada = join(g, "person/ada.md");
    put(g, "person/ada.md", obj("summary: x\nname: Ada\nworks_at: [org/openai]"));
    const before = Store.load(layers);
    const after = Store.load(layers, new Map([[join(g, "org/openai.md"), null]]));
    expect(blockingIssues(before, after, new Set())).toEqual([]);
    expect(after.issuesFor(ada).map((i) => i.code)).toEqual(["missing-link"]);
    expect(changeWarnings(before, after, new Set()).map((i) => i.path)).toEqual([ada]);
  });

  test("pre-existing errors elsewhere do not block unrelated writes", () => {
    put(g, "person/bad.md", obj("summary: x"));
    const path = join(g, "org/acme.md");
    const before = Store.load(layers);
    const after = Store.load(layers, new Map([[path, obj("summary: acme")]]));
    expect(blockingIssues(before, after, new Set([path]))).toEqual([]);
  });
});

describe("rendering and ops", () => {
  beforeEach(() => {
    put(g, "person/ada.md", obj("summary: Engineer\nname: Ada\nworks_at: [org/openai]", "Met [[person/bob]]"));
  });

  test("indexes", () => {
    const store = Store.load(layers);
    const root = renderRootIndex(store);
    expect(root).toContain("## person (1) [global] — A human");
    expect(root).toContain("## org (1)");
    expect(root).toMatch(/## org[^#]*\[\[org\/openai\]\]/); // objects grouped under their type
    expect(root).toContain("works_at: link→org[]");
    expect(root).toContain("[[person/bob]] ← person/ada");
    const person = renderTypeIndex(store, "person")!;
    expect(person).toContain("- [[person/ada]] — Engineer");
    expect(person).toContain("Bio first.");
    expect(renderTypeIndex(store, "nope")).toBeUndefined();
    expect(renderObjectFooter(store, "org/openai", join(g, "org/openai.md"))).toContain("[[person/ada]] — Engineer");
  });

  test("prompt section respects budget", () => {
    for (let i = 0; i < 200; i++) put(g, `org/o-${i}.md`, obj(`summary: org number ${i}`));
    put(g, ".schema.md", "---\npromptBudget: 3000\n---\n");
    const section = renderPromptSection(Store.load(layers));
    expect(section.length).toBeLessThanOrEqual(3100);
    expect(section).toMatch(/… \d+ more/);
    expect(section.indexOf("[[org/openai]]")).toBeLessThan(section.indexOf("[[org/o-")); // most linked first
  });

  test("prompt reserves room for recently changed objects", () => {
    const old = new Date("2020-01-01");
    const links = [];
    for (let i = 0; i < 150; i++) {
      put(g, `org/o-${i}.md`, obj(`summary: well linked org number ${i}`));
      utimesSync(join(g, `org/o-${i}.md`), old, old);
      links.push(`[[org/o-${i}]]`);
    }
    put(g, "person/hub.md", obj("summary: hub\nname: Hub", links.join(" ")));
    utimesSync(join(g, "person/hub.md"), old, old);
    put(g, "org/fresh.md", obj("summary: just learned"));
    put(g, ".schema.md", "---\npromptBudget: 4000\n---\n");
    const section = renderPromptSection(Store.load(layers));
    expect(section).toContain("[[org/fresh]]");
    expect(section).toMatch(/showing \d+: most recently changed and most linked/);
  });

  test("schema `index` fields appear next to objects", () => {
    put(g, "person/.schema.md", PERSON.replace("---\nBio", "index: [status, works_at]\n---\nBio"));
    put(g, "person/ada.md", obj("summary: Engineer\nname: Ada\nstatus: active\nworks_at: [org/openai]"));
    const store = Store.load(layers);
    expect(store.errors()).toEqual([]);
    expect(renderTypeIndex(store, "person")).toContain("- [[person/ada]] (active · org/openai) — Engineer");
    expect(renderPromptSection(store)).toContain("- [[person/ada]] (active · org/openai) — Engineer");
    expect(parseTypeSchema("---\ndescription: x\nfields:\n  a: string\nindex: [b]\n---\n").errors[0]).toContain("not a declared field");
  });

  test("query", () => {
    const store = Store.load(layers);
    expect(query(store, { where: { works_at: "org/openai" } }).map((o) => o.id)).toEqual(["person/ada"]);
    expect(query(store, { linksTo: "org/openai" }).map((o) => o.id)).toEqual(["person/ada"]);
    expect(query(store, { linkedFrom: "person/ada" }).map((o) => o.id)).toEqual(["org/openai"]);
    expect(query(store, { type: "org", text: "lab" }).map((o) => o.id)).toEqual(["org/openai"]);
  });

  test("lint", () => {
    put(g, "org/lonely.md", obj("summary: alone"));
    const report = lint(Store.load(layers));
    expect(report.errors).toBe(0);
    expect(report.text).toContain("[[person/bob]]");
    expect(report.text).toContain("Orphans");
    expect(report.text).toContain("[[org/lonely]]");
    put(g, "org/extra.md", obj("summary: x\nfounded: 2015"));
    expect(lint(Store.load(layers)).text).toContain("- [[org/extra]]: founded");
  });
});

describe("fs ops", () => {
  test("snapshot restore reverts creates, edits, deletes", () => {
    const snap = takeSnapshot(layers);
    put(g, "org/new.md", "x");
    put(g, "newtype/a.md", "x");
    writeFileSync(join(g, "org/openai.md"), "changed");
    rmSync(join(g, "person/.schema.md"));
    const changes = diffSnapshot(snap, layers);
    expect(changes.created.length).toBe(2);
    expect(changes.modified).toEqual([join(g, "org/openai.md")]);
    expect(changes.deleted).toEqual([join(g, "person/.schema.md")]);
    restoreSnapshot(snap, layers);
    expect(existsSync(join(g, "newtype"))).toBe(false);
    expect(existsSync(join(g, "org/new.md"))).toBe(false);
    expect(readFileSync(join(g, "person/.schema.md"), "utf8")).toBe(PERSON);
    expect(readFileSync(join(g, "org/openai.md"), "utf8")).toContain("AI lab");
  });

  test("log and bootstrap", () => {
    appendLog(layers, [{ action: "create", path: join(p, "org/x.md") }], "write", new Date("2026-01-02T03:04:05Z"));
    expect(readFileSync(join(p, "log.md"), "utf8")).toContain("- 2026-01-02T03:04:05Z create org/x (write)");
    const fresh = join(tmp, "fresh");
    const written = bootstrap(fresh);
    expect(written.length).toBe(7);
    expect(bootstrap(fresh)).toEqual([]);
    expect(Store.load(makeLayers(fresh)).errors()).toEqual([]);
  });
});

describe("store format", () => {
  test("stamps unversioned stores, preserving the rest of the root schema", () => {
    put(g, ".schema.md", "---\n# keep me\nsummaryMaxLength: 40\n---\nBe concise.\n");
    expect(ensureFormat(layers[0]!)).toEqual({ status: "stamped", version: FORMAT_VERSION });
    const text = readFileSync(join(g, ".schema.md"), "utf8");
    expect(text).toContain("# keep me");
    expect(text).toContain(`o6yFormat: ${FORMAT_VERSION}`);
    expect(text.endsWith("Be concise.\n")).toBe(true);
    expect(Store.load(layers).settings.summaryMaxLength).toBe(40);
    expect(ensureFormat(layers[0]!)).toEqual({ status: "current", version: FORMAT_VERSION });
  });

  test("runs migrations in order and reports newer stores", () => {
    const ran: number[] = [];
    const migrations = { 1: () => ran.push(1), 2: () => ran.push(2) };
    expect(ensureFormat(layers[0]!, migrations, 3)).toEqual({ status: "migrated", from: 1, to: 3 });
    expect(ran).toEqual([1, 2]);
    expect(readFormat(readFileSync(join(g, ".schema.md"), "utf8"))).toBe(3);
    expect(ensureFormat(layers[0]!, {}, 2)).toEqual({ status: "newer", version: 3 });
    expect(ensureFormat({ name: "project", root: join(tmp, "missing") })).toEqual({ status: "absent" });
  });

  test("project store without a root schema gets one", () => {
    put(p, "org/x.md", obj("summary: x"));
    expect(ensureFormat(layers[1]!).status).toBe("stamped");
    expect(readFileSync(join(p, ".schema.md"), "utf8")).toBe(`---\no6yFormat: ${FORMAT_VERSION}\n---\n`);
  });
});
