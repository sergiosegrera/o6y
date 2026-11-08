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
o6y search "who reviews ledger changes?"   # by meaning (opt-in, below)
o6y help                              # everything else: show, links, backlinks, new, set, rm, type rename, check, log, stats, export
```

Write commands validate the whole change before touching disk, log it, and take `--dry-run`.

## Semantic search (opt-in)

With semantic search on, o6y finds objects by meaning and, on each of your messages, suggests the ones that look relevant to the agent. It uses Cohere embeddings to find candidates and Cohere rerank to score them. It is **off by default**, because it sends your memory and your messages to Cohere. To turn it on, add this to `~/.agents/o6y/.schema.md` and set `CO_API_KEY`:

```yaml
semantic:
  enabled: true
  threshold: 0.35     # how relevant (0–1) an object must be to be suggested
```

- When a message matches something, a line like `◆ o6y 2 relevant: person/ana-ruiz, decision/postgres-advisory-locks` appears under it in pi; expand it to see scores and summaries. The agent gets the same list. Each object is suggested once per session, and pinned objects never are.
- Suggestions are best effort: they give up after 2.5 s and never fail a turn.
- `o6y search "<question>"` searches by meaning from the shell, listing only results that clear the threshold (`--min-score 0` lists everything). Without a key, it falls back to word matching.
- o6y keeps a local log of what it suggested and whether the agent then opened it. `o6y suggestions` shows how often suggestions get used, by score, which is what to tune `threshold` on. Your messages are logged only if you set `logPrompts: true`.
- The vectors are cached in `~/.cache/o6y` (override with `O6Y_CACHE`), not in your store, and only changed objects are re-embedded. `o6y reindex --full` rebuilds the index.

See SPEC.md for the models and the rest of the settings.

## Dreaming

`/o6y-dream` reads past pi sessions and brings memory in line with them: an analyzer per session corrects and adds to memory, then an organizer tidies the result. Changes apply automatically and may touch anything in the store; the previous state is kept under `$O6Y_CACHE/dreams/runs`. Use `--dry-run` to count unprocessed sessions, `--here` for this directory only and `--limit N` for a smaller batch. Transcripts are sent to the configured model. Set the model and other options in a `dream:` block in the root schema (see SPEC.md). Run `o6y dream` to see how many sessions are waiting and how the last dream went, and `o6y dream run [--here] [--limit N] [--dry-run]` to run one from the command line, which needs `pi` on your PATH.

## Other agents (MCP, deprecated)

> **Deprecated:** o6y is a pi extension, and `o6y mcp` will be removed in a future release.

`o6y mcp` serves the same stores as a local MCP server over stdio, for agents other than pi (Claude Code, Codex, Cursor…). Add it to your agent:

```bash
claude mcp add o6y -- npx -y github:sergiosegrera/o6y#v0.9.0 mcp     # Claude Code
```

```toml
# Codex: ~/.codex/config.toml
[mcp_servers.o6y]
command = "npx"
args = ["-y", "github:sergiosegrera/o6y#v0.9.0", "mcp"]
```

The store is found as for the CLI: `O6Y_HOME`, `o6y --global DIR mcp`, or `~/.agents/o6y`.

MCP clients' own tools can't be hooked, so the server provides tools in their place:
- `o6y_show`: read an object (with backlinks), a schema (`person/.schema`, `.schema`), the catalog (`index`, `person/index`), the manual (`manual`), or any path in a store
- `o6y_write`, `o6y_edit`: create or change an object or schema, validated before anything is saved
- `o6y_query`, `o6y_search`: find objects by filters, or by meaning
- `o6y_cli`: any other `o6y` command (`mv`, `merge`, `field rename`, `lint`, `rm`…)

The memory index that pi gets in its system prompt (rules, guidance, pinned objects, catalog) is sent as the server's instructions, which clients put in the system prompt. Clients may shorten long instructions; the tools always have the rest.

Differences from pi:
- **Writes are only validated through the o6y tools.** The instructions tell the agent to use them, but nothing stops it from editing store files with its own file tools. `o6y lint` finds anything that broke.
- **No relevant-object suggestions** on each message; the agent searches with `o6y_search`.
- **The instructions are computed when the server starts.** Restart it (or the agent) to refresh them; the tools always see the current store.

## Viewer

`o6y` (or `o6y view`) in a terminal opens a live viewer of your stores, built with Ink. To use the command outside pi, install it with Bun or npm:

```bash
bun add -g github:sergiosegrera/o6y#v0.8.1     # or: npm i -g github:sergiosegrera/o6y#v0.8.1
o6y                                             # viewer; o6y view --activity opens on the timeline
```

- **Browse** (`1`): types and objects on the left; the selected page on the right, with its fields, body, links and backlinks.
- **Activity** (`2` / `a`): a timeline of the store, newest first, by day. It shows every create (`+`), update (`~`) and delete (`−`) from `log.md`, with what made it (`write`, `edit`, `bash`, `o6y mv`…). Like the browse list, days start collapsed: `enter`/`→` expands one, `←` collapses it, `x`/`X` collapse or expand them all, and `[`/`]` jump between days. A collapsed day's page lists all its changes. Changes made together, like a bash migration, collapse into one row that expands the same way. The selected object's page is on the right, under a line saying what happened. `o` opens it in browse.
- **Search** (`?`, with semantic search on): type a question and press `enter` to rank objects by meaning. A line marks the threshold, so you see what the agent would and wouldn't be suggested for that message. The results stay under `5`.
- **Dreams** (`3` or `d`, or `o6y view --dreams`): every dream with what it read, what it changed and what it cost. `enter` on the page follows a changed object. `R` opens a dialog to choose which sessions and how many (capped at 5 to start, oldest first), then runs the dream in the background. A running dream, started from anywhere, shows up here and updates as it goes.
- **Graph** (`4`, or `o6y view --graph`): the selected object and what links to it. `enter` re-centres, `b` goes back, and `+`/`-` change the depth. For the whole store, `o6y graph` opens an interactive page in your browser; it fetches nothing and stays on your machine, and can size nodes by their links.
- **Hot reload**: changes to the store, whether made by the agent or by you, show up immediately. Changed objects are marked `•`, and the header shows the error and warning counts.
- **Narrow panes** (e.g. a cmux or tmux side pane): below 80 columns, every view shows one pane at a time (`enter` opens the page, `←` goes back to the list).
- **Keys**: `g`/`G` (or `Home`/`End`) jump to the top or bottom of a list or page. On a page, `j`/`k` scroll and `n`/`N` pick a link; `enter` follows a link, `b` goes back, `/` filters the browse list by id, summary and body, `e` opens the object in `$EDITOR`, and `q` quits.

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

`src/core` is pure TypeScript using `node:fs`, because pi runs extensions on Node. `src/cli` is the `o6y` command, and `dist/` holds its Node bundle, which is committed so git installs work without a build step. `src/extension.ts` is the pi adapter (hooks only), `src/mcp` is the MCP server for other agents, and `skills/o6y/SKILL.md` is the manual.

## License

MIT
