import { defineCase, hasObject, lintClean } from "../lib.ts";

export default defineCase({
  name: "capture-mixed",
  description: "Files a paragraph of mixed tribal knowledge into fitting objects (notes, decision), linked.",
  steps: [
    `Some tribal knowledge from my team, please persist it in memory:
- payments-api (github.com/acme/payments-api) is owned by the payments team; it depends on the ledger service.
- We release on Tuesdays via a release train; hotfixes need approval from the on-call lead.
- The ledger integration tests are flaky when run in parallel; run them with --runInBand.
- In March 2026 we decided to use Postgres advisory locks instead of Redis locks for payment dedup, because Redis failovers caused double charges.`,
  ],
  checks: [
    hasObject({ text: [/payments-api/i, /ledger/i] }, "an object for payments-api mentioning the ledger dependency"),
    hasObject({ text: [/tuesday/i, /on-call/i] }, "an object for the release train + hotfix rule"),
    hasObject({ text: [/runInBand/] }, "an object for the flaky ledger tests"),
    hasObject({ type: "decision", text: [/advisory lock/i, /redis/i], where: { date: (v) => String(v instanceof Date ? v.toISOString() : v).startsWith("2026-03") } }, "decision with a March 2026 date"),
    lintClean(),
  ],
});
