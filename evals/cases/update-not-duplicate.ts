import { defineCase, hasObject, lintClean, objectCount } from "../lib.ts";

export default defineCase({
  name: "update-not-duplicate",
  description: "New facts about a known person update the existing object instead of creating a duplicate.",
  fixture: "acme",
  steps: ["Remember: Ana now also requires a CHANGELOG entry for every user-facing change in payments-api."],
  checks: [
    hasObject({ id: "person/ana-ruiz", text: [/changelog/i, /idempoten/i] }, "person/ana-ruiz updated, old rules kept"),
    objectCount({ type: "person" }, 2, 2, "still exactly 2 people"),
    lintClean(),
  ],
});
