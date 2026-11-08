import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { main } from "../src/cli/main.ts";
import { createServer } from "../src/mcp/server.ts";
import { makeLayers } from "../src/core/store.ts";

let tmp: string;
let g: string;
let client: Client;

function put(rel: string, content: string, root = g) {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}
const read = (rel: string, root = g) => readFileSync(join(root, rel), "utf8");

async function connect(): Promise<Client> {
  const server = createServer({ cwd: tmp, env: {}, layers: makeLayers(g), runCli: main });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(serverSide), c.connect(clientSide)]);
  return c;
}

async function call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const res = (await client.callTool({ name, arguments: args })) as { content: { type: string; text: string }[]; isError?: boolean };
  return { text: res.content.map((c) => c.text).join("\n"), isError: !!res.isError };
}

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "o6y-mcp-"));
  g = join(tmp, "global");
  put(".schema.md", "---\nsummaryMaxLength: 60\n---\nStore guidance here.\n");
  put("person/.schema.md", "---\ndescription: A person\nfields:\n  role: string\n  team: { type: link, to: team }\n---\nWho they are.\n");
  put("team/.schema.md", "---\ndescription: A team\n---\n");
  put("note/.schema.md", "---\ndescription: A note\n---\n");
  put("team/payments.md", "---\nsummary: Payments team\n---\n");
  put("person/ana.md", "---\nsummary: Staff engineer\nrole: staff\nteam: team/payments\npinned: true\n---\nReviews ledger PRs.\n");
  put("note/ledger.md", "---\nsummary: Ledger service\n---\nOwned by [[team/payments]]; ask [[person/ana]].\n");
  client = await connect();
});

afterEach(async () => {
  await client.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("mcp server", () => {
  test("instructions carry the memory index with MCP rules", () => {
    const text = client.getInstructions()!;
    expect(text).toContain("o6y MCP tools");
    expect(text).toContain("Store guidance here.");
    expect(text).toContain("[[person/ana]] — Staff engineer");
    expect(text).toContain("Reviews ledger PRs."); // pinned body
    expect(text).not.toContain("shell command");
  });

  test("lists the tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["o6y_cli", "o6y_edit", "o6y_query", "o6y_search", "o6y_show", "o6y_write"]);
  });

  test("query and search", async () => {
    expect((await call("o6y_query", { type: "person" })).text).toContain("[[person/ana]]");
    expect((await call("o6y_query", { where: { role: "staff" } })).text).toContain("person/ana");
    expect((await call("o6y_query", { links_to: "team/payments" })).text).toContain("note/ledger");
    expect((await call("o6y_search", { question: "who owns the ledger service" })).text).toContain("note/ledger");
  });

  test("show resolves ids, schemas, indexes, paths and the manual", async () => {
    const obj = await call("o6y_show", { target: "note/ledger" });
    expect(obj.text).toContain("Owned by");
    expect((await call("o6y_show", { target: "team/payments" })).text).toContain("[[note/ledger]]"); // backlink footer
    expect((await call("o6y_show", { target: "person/.schema" })).text).toContain("Who they are.");
    expect((await call("o6y_show", { target: ".schema" })).text).toContain("summaryMaxLength");
    expect((await call("o6y_show", { target: "index" })).text).toContain("o6y index");
    expect((await call("o6y_show", { target: "person/index" })).text).toContain("Fields:");
    expect((await call("o6y_show", { target: join(g, "note", "index.md") })).text).toContain("note/ledger");
    expect((await call("o6y_show", { target: join(g, "note", "ledger.md") })).text).toContain("Owned by");
    expect((await call("o6y_show", { target: "manual" })).text).toContain("o6y");
    const missing = await call("o6y_show", { target: "note/nope" });
    expect(missing.isError).toBe(true);
    expect((await call("o6y_show", { target: "/etc/passwd" })).isError).toBe(true);
  });

  test("write creates valid objects and rejects invalid ones without touching disk", async () => {
    const created = await call("o6y_write", { target: "person/bob", content: "---\nsummary: Backend dev\nrole: dev\n---\nNew here.\n" });
    expect(created.isError).toBe(false);
    expect(created.text).toContain("create");
    expect(read("person/bob.md")).toContain("Backend dev");
    expect(read("log.md")).toContain("o6y_write (mcp)");

    const bad = await call("o6y_write", { target: "person/carl", content: "---\nrole: dev\n---\n" });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("rejected");
    expect(existsSync(join(g, "person", "carl.md"))).toBe(false);

    const long = await call("o6y_write", { target: "note/x", content: `---\nsummary: ${"x".repeat(80)}\n---\n` });
    expect(long.isError).toBe(true);
  });

  test("warnings for missing links", async () => {
    const res = await call("o6y_write", { target: "person/cleo", content: "---\nsummary: Contractor\nteam: team/ghost\n---\n" });
    expect(res.isError).toBe(false);
    expect(res.text).toContain("warnings");
    expect(read("person/cleo.md")).toContain("Contractor");
    expect((await call("o6y_edit", { target: "person/cleo", old_string: "Contractor", new_string: "Contract dev" })).isError).toBe(false);
    expect(read("person/cleo.md")).toContain("Contract dev");
  });

  test("schema changes that break objects are rejected", async () => {
    const res = await call("o6y_write", {
      target: "person/.schema",
      content: "---\ndescription: A person\nfields:\n  role: number\n---\n",
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("migrate");
    expect(read("person/.schema.md")).toContain("role: string");
  });

  test("generated and append-only files cannot be written", async () => {
    expect((await call("o6y_write", { target: "index", content: "x" })).isError).toBe(true);
    expect((await call("o6y_write", { target: join(g, "log.md"), content: "x" })).isError).toBe(true);
    expect((await call("o6y_write", { target: join(g, "note", "deep", "x.md"), content: "x" })).isError).toBe(true);
  });

  test("edit replaces unique text and validates", async () => {
    const res = await call("o6y_edit", { target: "note/ledger", old_string: "Ledger service", new_string: "Ledger service (Go)" });
    expect(res.isError).toBe(false);
    expect(read("note/ledger.md")).toContain("Ledger service (Go)");

    expect((await call("o6y_edit", { target: "note/ledger", old_string: "nope", new_string: "x" })).isError).toBe(true);
    const broken = await call("o6y_edit", { target: "person/ana", old_string: "summary: Staff engineer\n", new_string: "" });
    expect(broken.isError).toBe(true);
    expect(read("person/ana.md")).toContain("summary: Staff engineer");
    expect((await call("o6y_edit", { target: "note/new", old_string: "a", new_string: "b" })).isError).toBe(true);
  });

  test("cli runs commands in-process against the same stores", async () => {
    const mv = await call("o6y_cli", { args: ["mv", "note/ledger", "note/ledger-service"] });
    expect(mv.isError).toBe(false);
    expect(existsSync(join(g, "note", "ledger-service.md"))).toBe(true);

    const lint = await call("o6y_cli", { args: ["lint"] });
    expect(lint.isError).toBe(false);
    expect(lint.text).toContain("o6y lint");

    const usage = await call("o6y_cli", { args: ["mv", "note/ledger-service"] });
    expect(usage.isError).toBe(true);
    expect((await call("o6y_cli", { args: ["view"] })).isError).toBe(true);
  });

  test("seeds an empty global store", async () => {
    await client.close();
    rmSync(g, { recursive: true, force: true });
    client = await connect();
    expect(existsSync(join(g, ".schema.md"))).toBe(true);
    expect((await call("o6y_show", { target: "preference/index" })).isError).toBe(false);
  });
});
