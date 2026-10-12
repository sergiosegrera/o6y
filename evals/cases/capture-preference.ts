import { defineCase, hasObject, lintClean, objectCount } from "../lib.ts";

export default defineCase({
  name: "capture-preference",
  description: "Stated working preferences become preference objects, one per preference.",
  steps: ["Two things I always want: use pnpm, never npm, in all my projects; and keep PR descriptions to at most three bullet points."],
  checks: [
    hasObject({ type: "preference", text: [/pnpm/i] }, "preference for pnpm"),
    hasObject({ type: "preference", text: [/(three|3) bullet/i] }, "preference for short PR descriptions"),
    objectCount({ type: "preference" }, 2, 3, "2–3 preference objects (not one blob)"),
    lintClean(),
  ],
});
