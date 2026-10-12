import { answerMatches, defineCase, readObject } from "../lib.ts";

export default defineCase({
  name: "recall-review",
  description: "Before a PR, the agent reads the reviewer's object and applies their specific rules.",
  fixture: "acme",
  steps: [
    "I'm about to open a PR to payments-api adding a POST /refunds endpoint. It's ~650 lines with unit tests only. Anything I should know before opening it?",
  ],
  checks: [
    readObject("person/ana-ruiz"),
    answerMatches([/idempoten/i], -1, "mentions idempotency keys"),
    answerMatches([/integration/i], -1, "mentions integration tests"),
    answerMatches([/split|400/i], -1, "says to split the PR"),
  ],
});
