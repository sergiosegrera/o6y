import { defineCase, hasObject, lintClean, noObject } from "../lib.ts";

export default defineCase({
  name: "project-vs-global",
  description: "Repo-specific knowledge goes to the project store, not the global one.",
  fixture: "acme",
  steps: ["Remember for this repo (refunds-service) only: we use pnpm, not npm, and unit tests run with `pnpm test:unit`."],
  checks: [
    hasObject({ layer: "project", text: [/pnpm/] }, "project-store object mentions pnpm"),
    noObject({ layer: "global", text: [/pnpm/] }, "nothing about pnpm in the global store"),
    lintClean(),
  ],
});
