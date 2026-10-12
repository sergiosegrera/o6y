# o6y — ontology layer for pi

A typed, validated, interlinked markdown memory for the [pi](https://pi.dev) coding agent,
in the spirit of Karpathy's "LLM wiki". The agent just reads and writes `.md` files with its
normal tools; o6y validates every write against agent-editable `.schema.md` files, serves a
virtual `index.md`, computes backlinks, and keeps the store consistent.

## Stores and layers

| Layer   | Default path        | Override                                  |
|---------|---------------------|-------------------------------------------|
| global  | `~/.agents/o6y`     | `O6Y_HOME` env, `--o6y-global <path>`     |
| project | `<cwd>/.agents/o6y` | `O6Y_PROJECT` env, `--o6y-project <path>` |

- Types share one namespace. A project may add new types but may not redefine a global type.
- Object IDs (`type/slug`) are unique across layers.
- Project objects may link to global objects; global objects may **not** link into a project.
- If both paths resolve to the same directory, there is only one layer.

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

In the project layer, the root schema's settings override the global layer's settings.

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
  a typed field pointing at a disallowed type, and global → project links.
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
- short usage rules that point to the `o6y` skill
- pinned objects, in full
- the store paths
- root guidance
- every type (name, count and description; fields stay in `index.md`) with its objects grouped beneath it. Full lines (`- [[id]] — summary`) are bounded by `promptBudget`, and the rules, guidance, pinned objects and slug lists don't count against it, so pinning never hides the catalog.

Every object without a full line is listed by slug (`also: a, b, c` under its type). Slug lists have their own `namesBudget`, about 400 objects at the default; past that, the lowest-priority slugs are left to the type's `index.md`. Full lines go, in order, to:
1. objects relevant to the working directory: an object with a path field containing the cwd, its git root or (in a worktree) the main checkout, e.g. `location: ~/Projects/north`, or whose slug is that directory's name. Paths are found inside prose too (`~/Projects/north (primary checkout)`).
2. objects of `alwaysList` types, up to 35% of the budget (the starter `preference` type sets it: for a preference the summary is the instruction)
3. objects that link to a directory match (backlinks only, since a hub's outgoing links can cover half the store), most linked first, up to 40%
4. the most recently changed objects, up to 30%, so new knowledge shows up before anything links to it; objects touched by a bulk change (8 or more changed within 2 minutes, such as a migration) are skipped
5. the most linked objects

The section is computed at session start and rebuilt before a prompt whenever the store has changed (checked with a cheap file fingerprint), so objects written during a session show up in the next turn. Pi appends section changes as a transcript delta, so the cached prompt prefix stays valid.

Pinned objects are listed by name only, since their full content is already above.

## Manual (skill)

`skills/o6y/SKILL.md` is the full manual: layout, schema syntax, link rules, layers, validation, migration recipes and what to record. The extension registers it through `resources_discover`, so only its description takes prompt space. The agent loads it on demand, or the user can force it with `/skill:o6y`.

## Extras

- `log.md` is appended automatically for every create, update and delete, including schema changes and bash migrations.
- `/o6y-lint` and `o6y lint` report invalid objects, warnings, wanted pages, orphans and undeclared fields.
- o6y registers no tools. The `o6y` command (`src/cli`, bundled to `dist/` so it runs on plain Node) does queries and multi-file maintenance: `query`, `show`, `links`, `backlinks`, `index`, `lint`, `stats`, `log`, `prompt`, `export`, `new`, `set`, `mv`, `merge`, `rm`, `field add|rename|drop`, `type rename`, `check` and `view`. The extension puts `bin/o6y` on the agent's PATH, pointing it at the Node that runs pi and at the stores in use (`O6Y_HOME`, `O6Y_PROJECT`), so nothing has to be installed. Write commands build the full change in memory, validate it against the whole store (the same rules as a write) and only then write, and they log with the command name. When one runs inside a bash call, the bash hook doesn't log those files again.
- `/o6y` shows store status and refreshes the prompt section.
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
