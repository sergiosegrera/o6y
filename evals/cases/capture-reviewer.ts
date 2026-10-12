import { answerMatches, defineCase, hasObject, lintClean } from "../lib.ts";

export default defineCase({
  name: "capture-reviewer",
  description: "Persists a reviewer persona from a fresh store into a person object with the review rules.",
  steps: [
    "Tribal knowledge, please persist it in memory: Ana Ruiz is a staff engineer on the payments team. She reviews every PR touching payments-api. She always asks for idempotency keys on new endpoints, rejects PRs without integration tests, and asks for PRs over 400 lines to be split.",
  ],
  checks: [
    hasObject({ type: "person", text: [/ana/i, /idempoten/i, /integration[\s-]*test/i, /400/] }, "person object for Ana with all three review rules"),
    hasObject({ type: "person", text: [/ana/i], where: { role: (v) => typeof v === "string" && /staff/i.test(v) } }, "Ana's role field is set"),
    lintClean(),
    answerMatches([/ana/i]),
  ],
});
