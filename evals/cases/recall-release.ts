import { answerMatches, defineCase } from "../lib.ts";

export default defineCase({
  name: "recall-release",
  description: "Process knowledge (release train, hotfix approval) is applied to a release question.",
  fixture: "acme",
  steps: ["It's Thursday. Can I ship my payments-api fix to production today?"],
  checks: [
    answerMatches([/tuesday|release train/i], -1, "mentions the Tuesday release train"),
    answerMatches([/hotfix/i, /bob|on-call/i], -1, "hotfix needs the on-call lead (Bob)"),
  ],
});
