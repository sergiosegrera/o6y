import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { main } from "../src/cli/main.ts";
import { makeLayers, Store } from "../src/core/store.ts";

let tmp: string;
let g: string;
let p: string;

function put(rel: string, content: string, root = g) {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}
const read = (rel: string, root = g) => readFileSync(join(root, rel), "utf8");

async function o6y(argv: string, stdin?: string): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  // Split like a shell: quoted strings stay whole.
  const args = [...argv.matchAll(/(?:"[^"]*"|'[^']*'|[^\s"'])+/g)].map((m) => m[0].replace(/["']/g, ""));
  const code = await main(args, {
    cwd: tmp,
    env: { O6Y_HOME: g, O6Y_PROJECT: p },
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    stdin: () => stdin,
    isTTY: false,
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

const load = () => Store.load(makeLayers(g, p));

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o6y-cli-"));
  g = join(tmp, "global");
  p = join(tmp, "proj");
  put(".schema.md", "---\nsummaryMaxLength: 60\n---\nGuidance.\n");
  put("person/.schema.md", "---\ndescription: A person\nfields:\n  role: string\n  team: { type: link, to: team }\nindex: [role]\n---\nWho they are.\n");
  put("team/.schema.md", "---\ndescription: A team\n---\n");
  put("note/.schema.md", "---\ndescription: A note\nfields:\n  related: { type: link, many: true }\n---\n");
  put("team/payments.md", "---\nsummary: Payments team\n---\n");
  put("person/ana.md", "---\nsummary: Staff engineer\nrole: staff\nteam: team/payments\n---\nReviews [[note/ledger|the ledger]] PRs; see [[note/ledger#tests]].\n\n```\n[[note/ledger]] in code\n```\n");
  put("note/ledger.md", "---\nsummary: Ledger service\nrelated: [note/api]\n---\nOwned by [[team/payments]].\n");
  put("note/api.md", "---\nsummary: Payments API\nrelated:\n  - note/ledger\n---\nTalks to [[note/ledger]].\n");
});

afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("read commands", () => {
  test("help and usage errors", async () => {
    expect((await o6y("help")).out).toContain("mv ");
    expect((await o6y("help mv")).out).toContain("o6y mv <old-id> <new-id>");
    const bad = await o6y("nope");
    expect(bad.code).toBe(2);
    expect(bad.err).toContain("unknown command");
    expect((await o6y("mv note/ledger")).code).toBe(2);
    expect((await o6y("query --bogus")).code).toBe(2);
  });

  test("query by text, type, field and links", async () => {
    expect((await o6y("query ledger")).out).toContain("[[note/ledger]]");
    expect((await o6y("query --type person --where role=staff")).out).toContain("[[person/ana]]");
    expect((await o6y("query --where role=junior")).out).toBe("No matching objects.");
    const linking = await o6y("query --links-to note/ledger --json");
    expect(JSON.parse(linking.out).map((r: { id: string }) => r.id)).toEqual(["note/api", "person/ana"]);
  });

  test("show, links, backlinks, index", async () => {
    const show = await o6y("show note/ledger");
    expect(show.out).toContain("summary: Ledger service");
    expect(show.out).toContain("backlinks (2)");
    expect((await o6y("links person/ana")).out).toContain("→ team/payments (team) — Payments team");
    expect((await o6y("backlinks note/ledger")).out).toContain("← person/ana (body)");
    expect((await o6y("index")).out).toContain("## person (1)");
    expect((await o6y("index person")).out).toContain("Who they are.");
    expect((await o6y("show note/nope")).code).toBe(2);
  });

  test("lint exits 1 on errors", async () => {
    expect((await o6y("lint")).code).toBe(0);
    put("note/bad.md", "---\nsummary: x\nrelated: team/payments\n---\n");
    put("person/.schema.md", "---\ndescription: A person\nfields:\n  role: { type: string, required: true }\n  team: { type: link, to: team }\n---\n");
    put("person/bob.md", "---\nsummary: Bob\n---\n");
    const lint = await o6y("lint");
    expect(lint.code).toBe(1);
    expect(lint.out).toContain("person/bob.md");
  });

  test("prompt, stats, log, export", async () => {
    expect((await o6y("prompt")).out).toContain("[[note/ledger]]");
    const stats = await o6y("prompt --stats");
    expect(stats.out).toMatch(/full lines \d+ of promptBudget 8000 \(\d+%\), slugs \d+ of namesBudget 10000/);
    expect(stats.out).toContain("4 full lines");
    expect((await o6y("stats")).out).toContain("types: note 2 · person 1 · team 1");
    await o6y('set note/api summary="Payments HTTP API"');
    expect((await o6y("log --since 1h")).out).toContain("update note/api (o6y set)");
    const json = JSON.parse((await o6y("export")).out);
    expect(json.objects.find((o: { id: string }) => o.id === "note/api").links).toEqual([{ target: "note/ledger", via: ["related", "body"] }]);
    expect((await o6y("export --format mermaid")).out).toContain("graph LR");
    expect((await o6y("export --format dot")).out).toContain('"note/api" -> "note/ledger" [label="related, body"];');
  });
});

describe("write commands", () => {
  test("mv rewrites typed and body links, keeps labels, headings and code", async () => {
    const dry = await o6y("mv note/ledger note/ledger-service --dry-run");
    expect(dry.out).toContain("would create global:note/ledger-service.md");
    expect(existsSync(join(g, "note/ledger.md"))).toBe(true);

    const { code } = await o6y("mv note/ledger note/ledger-service");
    expect(code).toBe(0);
    expect(existsSync(join(g, "note/ledger.md"))).toBe(false);
    expect(read("note/ledger-service.md")).toContain("summary: Ledger service");
    const ana = read("person/ana.md");
    expect(ana).toContain("[[note/ledger-service|the ledger]]");
    expect(ana).toContain("[[note/ledger-service#tests]]");
    expect(ana).toContain("[[note/ledger]] in code");
    expect(read("note/api.md")).toContain("- note/ledger-service");
    expect(read("note/api.md")).toContain("Talks to [[note/ledger-service]].");
    expect(load().errors()).toEqual([]);
    expect(read("log.md")).toContain("create note/ledger-service (o6y mv)");
  });

  test("mv into the project store and refusals", async () => {
    expect((await o6y("mv note/api note/api --in project")).code).toBe(2); // already exists
    expect((await o6y("mv note/ledger note/api")).err).toContain("o6y merge");
    // A global object can't move into the project while global objects link to it.
    const res = await o6y("mv note/api note/payments-api --in project");
    expect(res.code).toBe(1);
    expect(res.out).toContain("rejected");
    expect(existsSync(join(g, "note/api.md"))).toBe(true);
  });

  test("merge repoints links, keeps missing fields and appends the body", async () => {
    put("note/ledger-svc.md", "---\nsummary: Dup of ledger\ntags: [dup]\n---\nRuns on k8s.\n");
    put("note/x.md", "---\nsummary: X\n---\nSee [[note/ledger-svc]].\n");
    const { code } = await o6y("merge note/ledger-svc note/ledger");
    expect(code).toBe(0);
    expect(existsSync(join(g, "note/ledger-svc.md"))).toBe(false);
    const ledger = read("note/ledger.md");
    expect(ledger).toContain("summary: Ledger service");
    expect(load().objects.get("note/ledger")!.data.tags).toEqual(["dup"]);
    expect(ledger).toContain("## Merged from note/ledger-svc\n\nRuns on k8s.");
    expect(read("note/x.md")).toContain("[[note/ledger]]");
  });

  test("set, unset and rejection", async () => {
    await o6y("set person/ana role=principal tags=[a,b] pinned=true");
    let ana = load().objects.get("person/ana")!;
    expect(ana.data.role).toBe("principal");
    expect(ana.data.tags).toEqual(["a", "b"]);
    expect(ana.pinned).toBe(true);
    await o6y("set person/ana --unset tags");
    ana = load().objects.get("person/ana")!;
    expect(ana.data.tags).toBeUndefined();
    const before = read("person/ana.md");
    const bad = await o6y('set person/ana team=note/api');
    expect(bad.code).toBe(1);
    expect(bad.out).toContain("rejected");
    expect(read("person/ana.md")).toBe(before);
  });

  test("new and rm", async () => {
    const created = await o6y('new note/release --summary "Tuesday trains" --set related=[note/api] --body "Run by [[person/ana]]."');
    expect(created.code).toBe(0);
    const obj = load().objects.get("note/release")!;
    expect(obj.data.related).toEqual(["note/api"]);
    expect(obj.body).toBe("Run by [[person/ana]].\n");
    expect((await o6y('new note/release --summary "again"')).code).toBe(2);
    expect((await o6y('new note/p --summary "in project" --in project')).code).toBe(0);
    expect(existsSync(join(p, "note/p.md"))).toBe(true);
    expect((await o6y('new note/toolong --summary "' + "x".repeat(70) + '"')).code).toBe(1);

    const rm = await o6y("rm note/api");
    expect(rm.out).toContain("delete global:note/api.md");
    expect(rm.out).toContain("warnings");
    expect(load().wanted.has("note/api")).toBe(true);
  });

  test("check validates drafts from stdin or a file", async () => {
    const ok = await o6y("check note/new", "---\nsummary: fine\n---\nbody\n");
    expect(ok.code).toBe(0);
    expect(ok.out).toContain("is valid");
    const bad = await o6y("check person/ana", "---\nrole: x\n---\n");
    expect(bad.code).toBe(1);
    expect(bad.out).toContain("summary");
    put("../draft.md", "---\nsummary: from a file\n---\n");
    expect((await o6y(`check note/new --file draft.md`)).code).toBe(0);
    expect(existsSync(join(g, "note/new.md"))).toBe(false);
  });

  test("field add with default, rename (schema, index, objects), drop", async () => {
    put("person/bob.md", "---\nsummary: Bob\nrole: oncall\n---\n");
    expect((await o6y("field add person level enum --values junior,senior --required")).code).toBe(1); // objects lack it
    expect((await o6y("field add person level enum --values junior,senior --required --default senior")).code).toBe(0);
    expect(load().objects.get("person/bob")!.data.level).toBe("senior");
    expect(read("person/.schema.md")).toContain("level: { type: enum, required: true, values: [junior, senior] }");
    expect(read("person/.schema.md")).toContain("team: { type: link, to: team }"); // untouched lines keep their style

    expect((await o6y("field rename person role title")).code).toBe(0);
    const schema = read("person/.schema.md");
    expect(schema).toContain("title: string");
    expect(schema).toContain("index: [title]");
    expect(schema).toContain("Who they are.");
    expect(read("person/ana.md")).toMatch(/^---\nsummary: Staff engineer\ntitle: staff\n/);
    expect(load().errors()).toEqual([]);

    expect((await o6y("field drop person title")).code).toBe(0);
    expect(read("person/.schema.md")).not.toContain("title");
    expect(read("person/.schema.md")).not.toContain("index");
    expect(load().objects.get("person/ana")!.data.title).toBeUndefined();
  });

  test("type rename moves files and rewrites ids and `to:`", async () => {
    expect((await o6y("type rename team squad")).code).toBe(0);
    expect(existsSync(join(g, "team"))).toBe(false);
    expect(read("squad/payments.md")).toContain("Payments team");
    expect(read("person/.schema.md")).toContain("to: squad");
    expect(read("person/ana.md")).toContain("team: squad/payments");
    expect(read("note/ledger.md")).toContain("[[squad/payments]]");
    expect(load().errors()).toEqual([]);
    expect((await o6y("type rename note person")).code).toBe(2);
  });
});

describe("bundle", () => {
  test("dist/o6y.js runs on Node through the bin/ launcher", () => {
    const root = join(import.meta.dir, "..");
    if (!existsSync(join(root, "dist", "o6y.js"))) throw new Error("run `bun run build` first");
    const proc = Bun.spawnSync([join(root, "bin", "o6y"), "query", "--type", "note", "--json"], {
      env: { ...process.env, O6Y_HOME: g, O6Y_PROJECT: p, O6Y_NODE: "" },
    });
    expect(proc.exitCode).toBe(0);
    expect(JSON.parse(proc.stdout.toString()).map((r: { id: string }) => r.id)).toEqual(["note/api", "note/ledger"]);
  });
});
