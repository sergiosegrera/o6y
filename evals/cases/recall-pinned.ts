import { answerMatches, defineCase, maxToolCalls } from "../lib.ts";

export default defineCase({
  name: "recall-pinned",
  description: "A pinned rule is applied immediately, with no searching.",
  fixture: "acme",
  files: {
    "global/note/prod-migrations.md": `---
summary: Prod DB migrations only via the migrations pipeline; Bob must sign off
pinned: true
---
Never run database migrations against production directly. They go through the migrations
pipeline, and [[person/bob]] (on-call lead) must sign off.
`,
  },
  steps: ["Quick question: can I run the new payments migration directly against the prod database right now?"],
  checks: [
    answerMatches([/pipeline/i], -1, "points to the migrations pipeline"),
    answerMatches([/bob|on-call/i], -1, "mentions Bob's sign-off"),
    maxToolCalls(2, -1, "answers with ≤2 tool calls (rule is already in the prompt)"),
  ],
});
