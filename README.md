# o6y

A typed, validated, interlinked markdown memory (an "ontology wiki") for the [pi](https://pi.dev) coding agent,
in the spirit of Karpathy's [LLM wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f).

The agent reads and writes plain `.md` files with its normal tools. o6y adds the following:
- validates every write against agent-editable `.schema.md` files
- serves virtual `index.md` files
- computes backlinks
- makes bash edits to the store transactional
- puts a budgeted index of the memory into the system prompt

The result is somewhere a team's tribal knowledge (who reviews what, how things are done, past decisions, gotchas) lands and persists across sessions.

See [SPEC.md](SPEC.md) for the full design.

## Install

Requires pi ≥ 1.0.

```bash
pi install git:github.com/sergiosegrera/o6y@v0.1.0   # pinned to a release
pi install git:github.com/sergiosegrera/o6y          # follows the default branch
pi install git:github.com/sergiosegrera/o6y -l       # this project only (.pi/settings.json)
pi -e git:github.com/sergiosegrera/o6y               # try it for one run, without installing
```

To update: a pinned install stays where it is until you change the ref in your settings. An unpinned install moves to the latest commit with `pi update --extensions`, or with `pi update git:github.com/sergiosegrera/o6y`.

Updates replace only o6y's code and skill. Your memory lives in the stores and is never touched by an update. If a release changes the store format, o6y migrates stores when the session starts (see `o6yFormat` in SPEC.md).

## Use

| Setting | Default | Override |
|---|---|---|
| Global store | `~/.agents/o6y` | `O6Y_HOME` or `--o6y-global <path>` |
| Project store | `<cwd>/.agents/o6y` | `O6Y_PROJECT` or `--o6y-project <path>` |

Starter schemas are seeded into an empty global store. They are light and development-focused, and meant to be reshaped:
- `person`, with optional reviewer notes
- `team`
- `system`
- `practice`
- `decision`
- `gotcha`

The full manual ships as the `o6y` skill. The agent loads it on demand, or you can force it with `/skill:o6y`.

- Commands: `/o6y` (status, and refreshes the memory in the system prompt), `/o6y-lint`.
- Tools added for the agent: `o6y_query`, `o6y_lint`. o6y hooks the built-in file tools and doesn't replace them.

## Limitations

- **o6y doesn't replace any tools.** It hooks pi's `read`, `write`, `edit` and `bash` calls, so it works alongside other extensions, including ones that replace those tools. It assumes the store is on the local disk; an extension that sends file tools to a remote machine bypasses validation.
- **Only those four tools are checked.** Writes through `powershell` or through other extensions' own tools aren't validated.
- **Parallel bash calls:** if one bash call's store changes are rolled back, the rollback can also undo store changes another bash call made at the same moment.
- **The memory in the system prompt is computed once per session.** Run `/o6y` to refresh it.

## Develop

```bash
bun install
bun test
bun run typecheck
pi -e ./src/extension.ts
```

`src/core` is pure TypeScript using `node:fs`, because pi runs extensions on Node. `src/extension.ts` is the pi adapter (hooks only), and `skills/o6y/SKILL.md` is the manual.

## License

MIT
