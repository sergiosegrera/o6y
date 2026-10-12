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
pi install git:github.com/sergiosegrera/o6y@v0.3.1   # pinned to a release
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

Four minimal starter types are seeded into an empty global store:
- `person`: people, with optional review notes
- `preference`: how the user or team wants things done
- `note`: any other durable knowledge, tagged
- `decision`: choices that shouldn't be relitigated

The agent adds a type when a kind of note keeps recurring.

To have something load in every session, set `pinned: true` on its object. The total size of pinned objects is capped by `pinnedBudget` in the root schema (`~/.agents/o6y/.schema.md`). The root schema's body is loaded every session too, as store-wide guidance.

The full manual ships as the `o6y` skill. The agent loads it on demand, or you can force it with `/skill:o6y`.

- Commands: `/o6y` (status, and refreshes the memory in the system prompt), `/o6y-lint`.
- o6y adds no tools. It hooks the built-in file tools, and gives the agent an `o6y` shell command (on its PATH automatically) for searching memory and for validated multi-file changes:

```bash
o6y query ledger                      # also --type, --where field=value, --links-to, --json
o6y lint                              # errors, warnings, wanted pages, orphans
o6y mv note/ledger note/ledger-service    # rename + rewrite every link
o6y merge note/dup note/original      # fold a duplicate in
o6y field rename person role title    # schema + every object, one validated step
o6y prompt --stats                    # where the system-prompt budget goes
o6y help                              # everything else: show, links, backlinks, new, set, rm, type rename, check, log, stats, export
```

Write commands validate the whole change before touching disk, log it, and take `--dry-run`.

## Viewer

`o6y` (or `o6y view`) in a terminal opens a live viewer of your stores, built with Ink. To use the command outside pi, install it with Bun or npm:

```bash
bun add -g github:sergiosegrera/o6y#v0.5.0     # or: npm i -g github:sergiosegrera/o6y#v0.5.0
o6y                                             # viewer; o6y view --tree note/payments-api
```

- **Browse** (`1`): types and objects on the left; the selected page on the right, with its fields, body, links and backlinks.
- **Tree** (`2` / `t`): explore outward from an object like a file tree. Each node's children are what it links to (`→`), what links to it (`←`) and mutual links (`↔`). `→`/`l` expands, `←`/`h` collapses or goes to the parent, `enter` makes the node the new root, `o` opens its page, and `x` collapses everything. Links back to an object already higher up are marked `↺` and don't expand.
- **Hot reload**: changes to the store, whether made by the agent or by you, show up immediately. Changed objects are marked `•`, and the header shows the error and warning counts.
- **Narrow panes** (e.g. a cmux or tmux side pane): below 80 columns, browse shows one pane at a time (`enter` opens the page, `←` goes back to the list); the tree view works at any width.
- **Keys**: `enter` follows a link, `b` goes back, `/` searches ids, summaries and bodies, `e` opens the object in `$EDITOR`, and `q` quits.

Edits made in `$EDITOR` are not validated, because validation hooks only into the agent's tools. The viewer shows any errors they introduce.

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
bun run o6y help    # the CLI from source (src/cli); bun run view for the viewer
bun run build       # rebuild dist/ (the bundled CLI) after changing src/; CI checks it's current
```

`src/core` is pure TypeScript using `node:fs`, because pi runs extensions on Node. `src/cli` is the `o6y` command, and `dist/` holds its Node bundle, which is committed so git installs work without a build step. `src/extension.ts` is the pi adapter (hooks only), and `skills/o6y/SKILL.md` is the manual.

## License

MIT
