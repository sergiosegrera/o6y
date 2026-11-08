# o6y — ontology layer for pi

A typed, validated, interlinked markdown memory for the [pi](https://pi.dev) coding agent,
in the spirit of Karpathy's "LLM wiki". The agent just reads and writes `.md` files with its
normal tools; o6y validates every write against agent-editable `.schema.md` files, serves a
virtual `index.md`, computes backlinks, and keeps the store consistent.

## The store

There is one store, at `~/.agents/o6y` (override with the `O6Y_HOME` env or `--o6y-global <path>`). It is global by design: memory becomes more useful the more context it holds, and what is learned in one repo often helps in another.

- Object IDs (`type/slug`) are unique in the store.
- Knowledge specific to one repo names that repo, and carries a path field (`location: ~/Projects/north`) so it ranks first when working there.

## Layout

```
<store>/
  .schema.md            root schema: store-wide settings + global guidance
  log.md                append-only, written by o6y only
  index.md              VIRTUAL (generated on read, never on disk)
  <type>/
    .schema.md          type definition (required before any object of that type)
    index.md            VIRTUAL
    <slug>.md           object; slug is kebab-case; no subfolders
```

Anything else inside a store is rejected.

## Root schema (`/.schema.md`)

```md
---
summaryMaxLength: 80      # hard cap on every object's `summary`
promptBudget: 8000        # max characters of full object lines in the system prompt (rules, guidance, pinned, slug lists not counted)
namesBudget: 10000        # max characters of the slug lists naming every other object
pinnedBudget: 2500        # max characters (summary + body) of all pinned objects together
---
Free-form guidance for the whole memory (shown in the system prompt).
```

## Type schema (`/<type>/.schema.md`)

```md
---
description: A specific human being
fields:
  name:     { type: string, required: true }
  aliases:  { type: list }
  born:     date
  works_at: { type: link, to: org, many: true }
  status:   { type: enum, values: [active, past] }
index: [status]            # optional, max 3 fields shown next to each object in indexes
alwaysList: true           # optional: every object of this type gets a full line in the prompt catalog
priority: 1                # optional integer: rank among objects relevant to the working directory (higher first, default 0)
---
Guidance for writing objects of this type (advisory, never validated).
```

Field types: `string`, `number`, `boolean`, `date` (`YYYY-MM-DD` or ISO datetime), `enum`
(`values`), `list` (list of strings), `link` (`to`: type name, list of type names, or `any`;
`many: true` for a list of links). The shorthand `name: string` means `{ type: string }`.

`summary` is reserved and implicit in every type: required string, at most `summaryMaxLength` chars.
`pinned` is reserved too: optional boolean (see Pinned objects).
Fields an object has but its schema doesn't declare are allowed.

## Objects

```md
---
summary: Founding member of OpenAI, ex-Tesla AI director; writes about LLMs
name: Andrej Karpathy
works_at: [[org/openai]]
---
Body text with [[concept/llm-wiki]] links.
```

Link values in frontmatter can be written as `org/openai`, `"[[org/openai]]"` or unquoted
`[[org/openai]]` (a list of those for `many`).

## Managed attributes

Every object's frontmatter carries an `o6y:` block that the store maintains, so it can be trusted. It is rebuilt on every write, whichever tool made it, and anything a writer puts there is replaced. It's reserved, like `summary` and `pinned`.

```yaml
o6y:
  created: 2026-11-08    # the day the object was created
  updated: 2026-11-08    # the last day its content changed
```

- `updated` changes only when the object's content does. Link rewrites and schema migrations leave them alone.
- The viewer shows them on a highlighted line under the object's title.
- A rename keeps the block, and a merge combines both objects' blocks.
- Objects from before this existed gain `updated` on their next change and never a guessed `created`.
- The sessions behind a change go in `log.md`, not on the object, so they cost no tokens when an object is read: `- <time> update note/x (dream) [pi:<session id>]`. Sessions identify themselves with `O6Y_SOURCE`, which the extension sets. A write from outside a session records no source.

## Pinned objects

`pinned: true` loads an object's full content into the system prompt in every session, in a "Pinned" section above the catalog. This is how knowledge gets marked as always relevant, while the catalog itself stays generated.

The combined size (summary + body) of all pinned objects is capped by `pinnedBudget`, separately from `promptBudget`. Exceeding it is an error on every pinned object, so pinning past the budget, or lowering the budget, is rejected.

## Links

- Body: `[[type/slug]]`, `[[type/slug|label]]`, `[[type/slug#heading]]`.
- Links are lenient about things that don't exist **yet**: a missing target (body or typed field)
  or a body link to a type without a schema is a **warning**, not an error. The write goes through,
  the warning is appended to the tool result, and the target is listed as a **wanted page** in the
  index and in lint.
- Links that are wrong no matter what gets written later stay **errors**: malformed links,
  and a typed field pointing at a disallowed type.
- Backlinks are computed and appended when an object is read.

## Validation and enforcement

| Action | Behaviour |
|---|---|
| `write` / `edit` an object | Validate the final content; reject errors with precise messages. Warnings (e.g. missing link targets) don't block; they are appended to the result. |
| `write` / `edit` a `.schema.md` | Reject if the schema is malformed or **any existing object** would become invalid (breaking change). Migrate objects first; unknown fields are allowed. |
| `write` / `edit` `index.md` or `log.md` | Rejected; they are managed. |
| Object in a type without a schema | Rejected; create `<type>/.schema.md` first. |
| `bash` | The store is snapshotted before the call and validated after it. If the call introduced new errors, every change is rolled back and the errors are returned. Use this for mass migrations. |
| Deletes / renames | Allowed. The resulting missing link targets are warnings, not errors. |

## Reading

- `read <store>/index.md` returns the full catalog:
  - store guidance
  - every type with its fields, and its objects grouped beneath it (50 per type; the rest are in the type index)
  - wanted pages
  - issues
- `read <store>/<type>/index.md` returns one type: its schema, guidance, every object with backlink counts, and wanted pages.
- `read <object>` returns the file plus an appended `o6y` footer with its backlinks.
- Index lines look like `- [[type/slug]] (index field values) — summary`.

## System prompt

o6y injects an `<o6y>` section into every run. `/o6y` refreshes it on demand. The section holds:
- short usage rules that point to the `o6y` skill (with semantic search on, they also point to `o6y search` and explain `<o6y-relevant>` lists)
- pinned objects, in full
- the store paths
- root guidance
- every type (name, count and description; fields stay in `index.md`) with its objects grouped beneath it. Full lines (`- [[id]] — summary`) are bounded by `promptBudget`, and the rules, guidance, pinned objects and slug lists don't count against it, so pinning never hides the catalog.

Every object without a full line is listed by slug (`also: a, b, c` under its type). Slug lists have their own `namesBudget`, about 400 objects at the default; past that, the lowest-priority slugs are left to the type's `index.md`. Full lines go, in order, to:
1. objects relevant to the working directory: an object with a path field containing the cwd, its git root or (in a worktree) the main checkout, e.g. `location: ~/Projects/north`, or whose slug is that directory's name. A field value counts only if it starts with a path, and the paths in it are all read (`~/Projects/north (primary checkout) + ~/wt/north`). `summary` is never read for paths.
2. objects of `alwaysList` types, up to 35% of the budget (the starter `preference` type sets it: for a preference the summary is the instruction)
3. objects that link to a directory match (backlinks only, since a hub's outgoing links can cover half the store), ranked by type `priority`, then links, then recency, up to 40%
4. the most recently changed objects, up to 30%, or 10% when the directory has relevant objects, so new knowledge shows up before anything links to it; objects touched by a bulk change (8 or more changed within 2 minutes, such as a migration) are skipped
5. when the directory has relevant objects, the rest of them, before anything generic
6. the most linked objects

The section is computed at session start and rebuilt before a prompt whenever the store has changed (checked with a cheap file fingerprint), so objects written during a session show up in the next turn. Pi appends section changes as a transcript delta, so the cached prompt prefix stays valid.

Pinned objects are listed by name only, since their full content is already above.

## Semantic search (opt-in)

Off by default, because it sends every object and every user message to Cohere. Turn it on in a root schema and set `CO_API_KEY` (or `COHERE_API_KEY`; `CO_API_URL` overrides the endpoint):

```md
---
semantic:
  enabled: true
  embedModel: embed-v5.0-fast     # default
  rerankModel: rerank-v5.0-fast   # default
  threshold: 0.35                 # rerank score (0–1) a suggestion, or an `o6y search` result, needs
  minSimilarity: 0.16             # cosine similarity a candidate needs to reach the reranker
  maxRelevant: 5                  # max suggestions per user message
  candidates: 40                  # nearest objects by embedding sent to the reranker
  logPrompts: false               # also write user messages to the suggestion log
---
```

`threshold` and `minSimilarity` are tuned to the default models (on a 208-object store: no off-topic prompt fired, and a right object was suggested for 91% of prompts that had one); re-tune them after changing either model.

- **Index:** one vector per object, embedded (`search_document`) from its id, type description, summary, fields and body. Vectors live outside the store, in `$O6Y_CACHE` (default `$XDG_CACHE_HOME/o6y` or `~/.cache/o6y`), one directory per layer: `vectors.f32` (unit-length float32 rows) and `index.json` (model, dimension, ids, content hashes). Only objects whose text changed are re-embedded; a model change re-embeds everything. Objects that don't load (invalid frontmatter, a type without a schema, an id taken by another layer) aren't indexed; `o6y reindex` and `o6y search` name them. A layer whose objects all lost to another layer's ids keeps its index, so overlapping stores don't wipe each other's vectors. The cache can always be deleted and rebuilt.
- **Search:** the query is embedded (`search_query`) and every object is scored by cosine similarity (brute force). Objects below `minSimilarity` are dropped *before* rerank, so the reranker can't promote a far-off object on a terse query, and still fills its slots from the rest. The top `candidates` are reranked. Scores are rerank relevance, 0–1. Ranking is about as good with embeddings alone; rerank is kept because its scores are calibrated enough for one fixed `threshold`.
- **Relevant objects:** on each user message (not slash commands or replies under 3 words), the extension runs the search and, when objects score at least `threshold`, adds a `<o6y-relevant>` message after the user's, listing them as `- [[id]] (score) — summary`. Pinned objects (already in the prompt in full) and objects already suggested this session are left out; after a compaction, objects can be suggested again. Suggestions give up after 2.5 s, and any error means no suggestion, never a failed turn. The extension re-embeds changed objects in the background (at session start and whenever the store changed); a suggestion uses the index as it is. In pi's UI the message renders as one line (`◆ o6y 2 relevant: …`), with scores and summaries when expanded; the footer shows `o6y: indexing memory…` while the index syncs.
- **Suggestion log:** `$O6Y_CACHE/suggestions.jsonl` records, locally, each suggestion (session, turn, ids, scores and similarities) and the first time the agent then opens a suggested object: a `read` of its file, or a bash command naming it (`o6y show|links|backlinks <id>` or a `<type>/<slug>.md` path). User messages are written only with `logPrompts: true`. `o6y suggestions [--since 7d]` summarizes it: how often suggestions were opened, by score band, and which objects keep being suggested without being opened.
- **CLI:** `o6y search <question>` syncs the index, then searches. It lists only results at or above `threshold` (`--min-score S` overrides; `--min-score 0` lists the top N whatever they score). `--no-rerank` ranks by similarity alone, with no minimum unless `--min-score` is given. Without the opt-in or a key it falls back to word matching, with a note. `o6y reindex [--full]` syncs the index explicitly.

## Dreaming

`/o6y-dream` consolidates past pi sessions into memory. `o6y dream run` does the same from the command line (and so from an agent's shell) through a headless pi that loads your extensions (so their model providers work), skipping the session that called it. `o6y dream` shows how many sessions are waiting and how the last dream went, and the viewer lists every dream under `3` (`o6y view --dreams`), where `R` runs one after asking. Options: `--dry-run` (only count), `--here` (only sessions from this directory), `--limit N` (oldest first), `--since 30d|2w|YYYY-MM-DD` (only sessions started then or later), `--session ID[,ID]` (read these sessions again in full, even if already processed; `--here` and `--since` don't apply). It runs when asked, and applies its changes without review.

- **Input:** session files under `PI_CODING_AGENT_SESSION_DIR` (default `~/.pi/agent/sessions`). Only the active branch is read, without system prompts, thinking or `o6y-relevant` messages, and tool calls and results are trimmed. The running session is left out, as are sessions with no new user message.
- **Agents:** nested in-memory pi sessions, so a dream writes no session files. They have validated store tools and a transcript reader, and no shell or file tools, because transcripts are untrusted. One analyzer runs per session, in order, and checks memory against the transcript. Then an organizer, which sees no transcripts, tidies the store. Everything goes in the one store; an analyzer marks repo-specific knowledge with the repo's name and a `location:` field, and writes how code or tools behaved in an older session as observed on that date, since it can't check what is true today.
- **Provenance:** `log.md` records the sessions behind each change a dream applies. Analyzers write each claim with how it is known (ran it, someone stated it, or inferred and unconfirmed) and when it could stop being true.
- **Applying:** agents work on a staged copy. At the end it is applied as one validated change, logged as `(dream)`. A file also edited live during the dream keeps the live version and is listed as a conflict. An aborted dream applies nothing.
- **State:** in `$O6Y_CACHE/dreams`: `ledger.json` (the last entry read per session, so a resumed session continues from there; a session is recorded only once its changes are applied), `runs/<id>/run.json`, `runs/<id>/base/` (the store before the dream), and a lock allowing one dream at a time.

Settings go in a `dream:` block in the root schema:

```md
---
dream:
  model: openrouter/some/model   # provider/model-id for both agents; empty = the pi session's model
  analyzerModel: ""              # overrides model for analyzers
  organizerModel: ""             # overrides model for the organizer
  thinking: ""                   # off, minimal, low, medium, high, xhigh, max; empty = the pi session's level
  maxToolResultChars: 3000       # trim tool calls and results to this size
  pageChars: 30000               # transcript page size
  instructions: ""               # extra guidance for both agents, e.g. "lessons, traps and decisions with their reasons; point to files rather than copying them"
---
```

## Manual (skill)

`skills/o6y/SKILL.md` is the full manual: layout, schema syntax, link rules, layers, validation, migration recipes and what to record. The extension registers it through `resources_discover`, so only its description takes prompt space. The agent loads it on demand, or the user can force it with `/skill:o6y`.

## Extras

- `log.md` is appended automatically for every create, update and delete, including schema changes and bash migrations.
- `/o6y-lint` and `o6y lint` report invalid objects, warnings, wanted pages, orphans and undeclared fields.
- o6y registers no tools. The `o6y` command (`src/cli`, bundled to `dist/` so it runs on plain Node) does queries and multi-file maintenance: `query`, `show`, `links`, `backlinks`, `index`, `lint`, `stats`, `log`, `prompt`, `export`, `new`, `set`, `mv`, `merge`, `rm`, `field add|rename|drop`, `type rename`, `check`, `search`, `reindex`, `suggestions` and `view`. The extension puts `bin/o6y` on the agent's PATH, pointing it at the Node that runs pi and at the store in use (`O6Y_HOME`), so nothing has to be installed. Write commands build the full change in memory, validate it against the whole store (the same rules as a write) and only then write, and they log with the command name. When one runs inside a bash call, the bash hook doesn't log those files again.
- `/o6y` shows store status (including whether semantic search is on) and refreshes the prompt section.
- Four minimal starter types are seeded into an empty global store:
  - `person` (role, team; optional `## Review notes`)
  - `preference` (scope)
  - `note` (tags, related)
  - `decision` (date, status)

  When a kind of note keeps recurring, the agent gives it its own type.

## Implementation

- `src/core/*`: pure TypeScript using `node:fs` only, because pi runs extensions on Node. Tested with `bun test`.
- `src/extension.ts`: the pi adapter. It never replaces a tool, so it works alongside other extensions, including ones that provide their own `read`/`write`/`edit`. It hooks pi's tool events:
  - **`write`:** the full content is validated in `tool_call`, and the call is blocked before anything touches disk.
  - **`edit`:** `tool_call` remembers the original file, and the tool applies the edit with its own matching rules. `tool_result` then validates the result; if it's invalid, the original is restored and the result becomes an error.
  - **`read`:** `tool_result` serves virtual `index.md` files (replacing the "file not found" error) and appends the backlinks footer to object reads.
  - **`bash`:** the store is snapshotted in `tool_call`. In `tool_result` the whole store is validated, and on new errors every change is rolled back.
- `skills/o6y/SKILL.md`: the manual, registered through `resources_discover`.
- `src/mcp/server.ts` (**deprecated**; o6y is a pi extension and this will be removed): the MCP adapter (`o6y mcp`, stdio) for agents whose tools can't be hooked. It offers tools in their place: `o6y_show` (reads, with the same virtual indexes and backlink footer as pi's `read`), `o6y_write` and `o6y_edit` (validated in full with a `Plan` before anything is written, logged with `mcp`), `o6y_query`, `o6y_search`, and `o6y_cli`, which runs any other CLI command in-process. The system prompt section, with rules that name these tools (`PromptOptions.mcp`), is the server's `instructions`. Writes made outside these tools aren't validated, and there are no per-message suggestions.
