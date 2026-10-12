import { defineCase, hasObject, lintClean, noObject } from "../lib.ts";

export default defineCase({
  name: "merge-duplicates",
  description: "Folds a duplicate into the original: keeps its facts, repoints links, deletes it.",
  fixture: "acme",
  files: {
    "global/note/ledger-svc.md": "---\nsummary: Ledger service, runs on k8s in eu-west-1\ntags: [system]\n---\nThe ledger runs on k8s in eu-west-1.\n",
    "global/decision/ledger-region.md":
      "---\nsummary: Keep the ledger in eu-west-1 for data residency\ndate: 2026-02-01\n---\nApplies to [[note/ledger-svc]].\n",
  },
  steps: ["note/ledger-svc in memory is a duplicate of note/ledger. Merge it into note/ledger."],
  checks: [
    noObject({ id: "note/ledger-svc" }, "the duplicate is gone"),
    hasObject({ id: "note/ledger", text: [/eu-west-1/] }, "note/ledger kept the duplicate's facts"),
    hasObject({ id: "decision/ledger-region", text: [/\[\[note\/ledger\]\]/] }, "links to the duplicate now point to note/ledger"),
    lintClean(),
  ],
});
