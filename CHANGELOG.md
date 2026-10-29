# Changelog

## 0.8.1

- **Viewer:** the activity timeline shows only store changes; suggestions and opens are no longer listed (`o6y suggestions` still summarizes them).
- **Viewer:** `g`/`G` (or `Home`/`End`) jump to the top or bottom of any list or page, and `[`/`]` jump between days in the activity timeline.

## 0.8.0

- **Viewer: activity replaces the link tree.** `2` (or `a`) opens a timeline of the store: creates, updates and deletes from `log.md` with what made them, grouped by day, with same-second batches (a bash migration, an `o6y mv`) collapsed. With semantic search on, it also shows suggestions (`◆` with score) and when the agent opened them (`↗`). `o6y view --tree` is gone; `o6y view --activity` opens on the timeline. Backlinks are still on every page.
- **Viewer: `?` searches by meaning**, listing up to 20 results with a line at the threshold, so you can check what a message would get suggested. Results stay under `3`.
- **The agent is told about `o6y search`:** with semantic search on, the prompt rules point to `o6y search "<question>"` for questions (and `o6y query` for exact filters), and say what `<o6y-relevant>` lists are. With it off, the rules are unchanged.

## 0.7.1

Semantic search fixes and tuning, from an eval on a 208-object store (56 relevant and 30 irrelevant prompts):
- **Similarity floor:** new setting `semantic.minSimilarity` (default 0.16). Candidates below it never reach the reranker, which on terse queries ("flaky ci") promoted objects with similarity as low as 0.13.
- **`o6y search` applies the threshold** when reranking, so an off-topic question returns "No matching objects." instead of five results at 0.00. `--min-score` overrides it (`--min-score 0` for the old behavior).
- **Skipped objects are reported:** `o6y reindex` and `o6y search` name objects left out of the index (invalid frontmatter, no schema, id taken by another layer) instead of skipping them silently.
- **Overlapping stores** no longer empty each other's index, and `reindex` counts as "removed" only ids gone from every layer.
- **Suggestion log:** a local log of each suggestion and whether the agent then opened the object; `o6y suggestions` summarizes it by score band. User messages are logged only with `semantic.logPrompts: true`.
- After a context compaction, objects can be suggested again.

## 0.7.0

- **Semantic search (opt-in):** `semantic: { enabled: true }` in a root schema plus `CO_API_KEY` turns on Cohere embeddings and rerank.
  - On each user message, objects scoring at least `threshold` are suggested in an `<o6y-relevant>` message, shown in pi as a collapsible `◆ o6y N relevant: …` line. Each object is suggested once per session, pinned objects never are, and suggestions give up after 2.5 s rather than delay the turn.
  - `o6y search <question>` (word-match fallback when semantic search is off) and `o6y reindex [--full]`.
  - Vectors are kept in a flat per-layer cache outside the store (`~/.cache/o6y`); only changed objects are re-embedded.

## 0.6.0

- **Relevance ranking** (from feedback on 0.5.0):
  - New type option `priority` (an integer, default 0). Among objects relevant to the working directory, higher-priority types come first, then link count, then recency, so runbooks and features stop losing to well-linked reference notes.
  - Path matching ignores `summary` and only reads field values that start with a path. A preference saying "goes in ~/Projects/north" no longer matches every North worktree.
  - When the directory has relevant objects, the recency share drops from 30% to 10%, and the remaining relevant objects fill the budget before the most-linked share.
- **Viewer fix:** on a page, `j`/`k`/arrows now scroll like a pager instead of jumping between the links at the bottom, so you can always get back to the top of a long page. The highlighted link is the one on screen, `n`/`N` jump to the next or previous link, and `enter` follows it. Opening a page no longer scrolls to its links.

## 0.5.0

- **Memory list in the prompt** (from feedback on a real 167-object store):
  - Every object is listed: slug lists no longer count against `promptBudget` and have their own `namesBudget` (default 10000 chars, about 400 objects).
  - Directory matches come first. `alwaysList` types follow, capped at 35% of the budget.
  - Relevance counts only objects that link *to* a directory match (backlinks), most linked first, capped at 40%. Before, every neighbor counted, so a hub marked half the store relevant.
  - Path fields are matched inside prose (`~/Projects/north (primary checkout)`).
  - Prompt lines drop the `fields:` line and index-field values (`index.md` keeps them), which leaves more room for full lines.
  - The section is rebuilt before a prompt when the store has changed, so memory written mid-session shows up in the next turn. Pi appends it as a delta, so the prompt cache keeps working.
- **Viewer:** types start collapsed (`enter`/`→` expands, `←` collapses, `x`/`X` collapse or expand all, `[`/`]` jump between types). Selecting a type shows its description, fields, guidance and objects. It renders with React's production build and Ink's incremental rendering, which redraws only changed lines.

## 0.4.0

- **The `o6y` command** replaces the `o6y_query` and `o6y_lint` tools, so o6y no longer adds tool schemas to every prompt. The extension puts it on the agent's PATH automatically (it runs on the Node that runs pi). It covers read commands (`query`, `show`, `links`, `backlinks`, `index`, `lint`, `stats`, `log`, `prompt --stats`, `export --format json|mermaid|dot`) and validated write commands (`new`, `set`, `mv` with link rewriting, `merge`, `rm`, `field add|rename|drop`, `type rename`, and `check` for drafts). Write commands validate the whole change before writing, log with the command name, and take `--dry-run`.
- Eval cases `rename-object` and `merge-duplicates`.
- `o6y` viewer (`o6y` or `o6y view`): a live Ink terminal UI with a browse view, a link tree you can expand outward from any object, link following, history, search, `$EDITOR` integration and hot reload. It adapts to narrow side panes.
- The prompt catalog lists every object, at least by slug (`also: …`), so the agent always sees what exists. Full lines go first to `alwaysList` types, then to objects relevant to the working directory (path fields such as `location: ~/Projects/north`, or a slug matching the directory, plus their neighbors), then to recent changes, then to the most linked.
- `promptBudget` now covers only the object catalog. Rules, guidance and pinned objects no longer squeeze it.
- New type option `alwaysList: true`. New stores' `preference` type sets it; add it to an existing store's `preference/.schema.md` by hand.
- Recency ranking skips bulk changes (8 or more objects changed within 2 minutes), so a migration doesn't flood the "recent" share.
- Pinned objects are listed by name only in the catalog, since their full content is already in the prompt.
- Fix: lint no longer lists `pinned` as an undeclared field.

## 0.3.1

- The package entry is now `index.ts`, so pi lists the extension as `sergiosegrera/o6y` (git) or `o6y` (npm) instead of `…:src/extension.ts`.

## 0.3.0

- Tighter starter types: `person`, `preference` (how the user or team wants things done), `note` (tagged catch-all) and `decision`. These replace person/team/system/practice/decision/gotcha. Existing stores are not changed.
- The agent is told to read a type's schema before its first write to that type in a session.
- An eval set (`evals/`, `bun run eval`): 12 behavioural cases that drive real pi sessions against fixture stores, scored deterministically, with baseline comparison.

## 0.2.0

- Pinned objects: `pinned: true` loads an object's full content into every session. All pinned objects share a `pinnedBudget` (default 2500 characters), and writes that would exceed it are rejected.
- Store paths in the prompt and in indexes are shown as `~/…`, so they are shorter and harder to mistype.

## 0.1.0

First release.

- Typed markdown stores: a global store (`~/.agents/o6y`) and a project store (`<repo>/.agents/o6y`), each with agent-editable `.schema.md` type definitions.
- Writes are validated by hooking pi's `read`, `write`, `edit` and `bash` calls; no tools are replaced, so o6y works alongside other extensions. Bash changes to a store are transactional and rolled back if they leave the store invalid.
- Virtual `index.md` files, backlinks appended on read, and a budgeted `<o6y>` memory section in the system prompt.
- Lenient links: missing targets are warnings and become wanted pages.
- `o6y_query` and `o6y_lint` tools, `/o6y` and `/o6y-lint` commands, and an automatic `log.md`.
- An `o6y` skill with the full manual.
- Development-focused starter types: person, team, system, practice, decision, gotcha.
- Store format versioning (`o6yFormat` in the root schema) with a migration hook.
