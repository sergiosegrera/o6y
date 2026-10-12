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
promptBudget: 8000        # max characters of the memory catalog injected into the system prompt
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

At session start, o6y computes an `<o6y>` section once and injects it into every run, so the prompt cache stays stable. `/o6y` refreshes it. The section holds:
- short usage rules that point to the `o6y` skill
- pinned objects, in full
- the store paths
- root guidance
- every type with its fields, and its objects grouped beneath it, bounded by `promptBudget`

Of the object budget, 30% goes to the most recently changed objects, so new knowledge shows up before anything links to it. The rest goes to the most linked objects.

## Manual (skill)

`skills/o6y/SKILL.md` is the full manual: layout, schema syntax, link rules, layers, validation, migration recipes and what to record. The extension registers it through `resources_discover`, so only its description takes prompt space. The agent loads it on demand, or the user can force it with `/skill:o6y`.

## Extras

- `log.md` is appended automatically for every create, update and delete, including schema changes and bash migrations.
- `/o6y-lint` and the `o6y_lint` tool report invalid objects, warnings, wanted pages, orphans and undeclared fields.
- The `o6y_query` tool filters objects by type, field values, links and text.
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
