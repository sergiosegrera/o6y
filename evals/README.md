# o6y evals

A small behavioural eval set. Each case drives real pi sessions (headless, isolated from your own extensions, context files and skills) against a fixture store. It then scores the result deterministically from the final store and the transcript, with no LLM judge.

```bash
bun run eval                                   # all cases × 1 trial on the default model (~$0.003 on GLM 5.3 Flash)
bun evals/run.ts --repeat 3 --label my-change  # more trials, named result file
bun evals/run.ts --filter recall               # only matching cases
bun evals/run.ts --compare evals/results/<baseline>.json   # show deltas vs a previous run
bun evals/run.ts --model openrouter/z-ai/glm-5.3-flash --concurrency 6 --keep   # --keep leaves temp dirs to inspect
```

The workflow for a behaviour change (prompt rules, skill, schema defaults, validation messages):
1. Run a baseline.
2. Make the change.
3. Rerun with `--compare`.

Each run writes JSON (summary plus per-trial check results) to `evals/results/`, which is git-ignored.

## Metrics

| Column | Meaning |
|---|---|
| pass | share of trials where every check passed |
| checks | share of individual checks passed (partial credit) |
| rejected | o6y-rejected writes and rolled-back bash calls per trial (friction with validation) |
| tools | tool calls per trial |
| tokens / cost / time | per trial, summed over the case's steps |

Models are nondeterministic. One trial is fine for spotting regressions; use `--repeat 3` when comparing a change, and don't trust a difference of a single trial. A full 12-case × 3-trial run costs about $0.01 on GLM 5.3 Flash.

## Cases

| Case | Fixture | Measures |
|---|---|---|
| capture-reviewer | empty | reviewer persona lands in a `person` object with all rules |
| capture-mixed | empty | a paragraph of tribal knowledge is filed into fitting objects (notes, a dated decision) |
| capture-preference | empty | stated preferences become separate `preference` objects |
| update-not-duplicate | acme | new facts update the existing object, with no duplicates |
| recall-review | acme | before a PR, the agent reads the reviewer and applies their specific rules |
| recall-release | acme | process knowledge (release train, hotfix approval) is applied |
| recall-preference | acme | a stored preference (use bun) changes the recommended command |
| recall-pinned | acme + pinned | a pinned rule is applied with no searching |
| pin-request | acme | "every session must know X" becomes a pinned object |
| schema-migration | acme | a field rename (`person.role` → `title`, including `index:`) ends valid |
| new-type | acme | knowledge that fits no type gets a new schema and objects |
| project-vs-global | acme | repo-specific knowledge lands in the project store |

## Adding a case

Create `evals/cases/<name>.ts`:

```ts
import { answerMatches, defineCase, hasObject, lintClean } from "../lib.ts";

export default defineCase({
  name: "my-case",
  description: "What behaviour this protects.",
  fixture: "acme",                      // evals/fixtures/acme/{global,project}; omit for an empty store
  files: { "global/person/x.md": "…" }, // optional extra files on top of the fixture
  steps: ["first session prompt", "second session prompt"],
  checks: [hasObject({ type: "person", text: [/x/i] }), lintClean(), answerMatches([/y/i])],
});
```

The available checks are in `lib.ts`: `hasObject`, `noObject`, `objectCount`, `lintClean`, `answerMatches`, `readObject`, `maxToolCalls` and `typeSchema`. Any `{ label, test(ctx) }` works too, where `ctx` contains the loaded `Store` and every run's tool calls and answer.
