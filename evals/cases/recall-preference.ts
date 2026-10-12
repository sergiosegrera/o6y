import { answerMatches, defineCase } from "../lib.ts";

export default defineCase({
  name: "recall-preference",
  description: "A stored preference changes what the agent recommends.",
  fixture: "acme",
  steps: ["What command should I run to add the zod package to this project? Just the command."],
  checks: [answerMatches([/bun add zod/], -1, "recommends `bun add zod`"), answerMatches([/^(?![\s\S]*npm (i|install))/], -1, "doesn't recommend npm install")],
});
