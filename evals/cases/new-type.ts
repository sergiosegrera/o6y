import { defineCase, lintClean, typeSchema } from "../lib.ts";

export default defineCase({
  name: "new-type",
  description: "Knowledge that fits no existing type gets a new schema plus objects.",
  fixture: "acme",
  steps: [
    "We use feature flags a lot; please track them in memory: checkout-v2 (owned by payments, 50% rollout) and ledger-batching (off, waiting on a ledger fix).",
  ],
  checks: [
    typeSchema((s) => [...s.types.keys()].some((t) => /flag/.test(t)) || `types: ${[...s.types.keys()].join(", ")}`, "a flag type exists"),
    typeSchema((s) => {
      const type = [...s.types.keys()].find((t) => /flag/.test(t));
      const n = type ? s.objectsOfType(type).length : 0;
      return n >= 2 || `${n} flag objects`;
    }, "both flags are objects"),
    lintClean(),
  ],
});
