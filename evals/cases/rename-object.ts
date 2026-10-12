import { defineCase, hasObject, lintClean, noObject, ranCommand } from "../lib.ts";

export default defineCase({
  name: "rename-object",
  description: "Renames an object and every link to it (body and typed fields), ideally with `o6y mv`.",
  fixture: "acme",
  steps: ["In memory, rename note/ledger to note/ledger-service."],
  checks: [
    hasObject({ id: "note/ledger-service", text: [/balances/i] }, "note/ledger-service exists with the old content"),
    noObject({ id: "note/ledger" }, "note/ledger is gone"),
    hasObject(
      { id: "note/payments-api", text: [/\[\[note\/ledger-service\]\]/], where: { related: (v) => JSON.stringify(v).includes("note/ledger-service") } },
      "payments-api links (body and related) point to the new id",
    ),
    lintClean(),
    ranCommand("mv"),
  ],
});
