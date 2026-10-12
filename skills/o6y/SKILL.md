---
name: o6y
description: Full manual for the o6y memory store (typed markdown wiki) — schema syntax, field types, links, global vs project stores, validation rules, migrations and recipes. Load before creating or changing a type schema, restructuring or migrating memory, or when an o6y write is rejected and the reason is unclear.
---

# o6y manual

o6y is a typed wiki of markdown files that serves as persistent memory. You use your normal tools
(`read`, `write`, `edit`, `bash`) on it. o6y validates writes, generates indexes, computes
backlinks and logs every change. The store paths are listed in the `<o6y>` section of your
system prompt.

## Layout

```
<store>/
  .schema.md          root schema: settings + guidance for the whole store
  log.md              append-only change log (o6y writes it; you can't)
  index.md            virtual: full catalog, generated on read
  <type>/
    .schema.md        the type's definition; must exist before any object of the type
    index.md          virtual: every object of this type
    <slug>.md         one object; slug is kebab-case (a-z, 0-9, -); no subfolders
```

Anything else inside a store is rejected, including stray files, subfolders, non-.md files and an `index.md` on disk.

## Type schema: `<type>/.schema.md`

```md
---
description: A codebase, service, library, app or piece of infrastructure   # required
fields:
  repo: string                                   # shorthand for { type: string }
  owner: { type: link, to: [team, person] }
  language: { type: enum, values: [ts, go, py] }
  tags: list
  launched: { type: date, required: true, description: first prod deploy }
index: [owner, language]                         # optional, max 3: shown next to objects in indexes
alwaysList: true                                 # optional: always give every object a full line in the prompt
---
Writing guidance for objects of this type (free markdown). It is advisory and never validated,
and it is shown in the type's index.md.
```

| Field type | Value |
|---|---|
| `string` | text |
| `number` | number |
| `boolean` | true / false |
| `date` | `YYYY-MM-DD` or ISO datetime |
| `enum` | one of `values` |
| `list` | list of strings |
| `link` | `type/slug`. Options: `to` (a type, a list of types, or `any`, the default) and `many: true` for a list |

Field options: `required`, `description`, plus `values` for enums and `to` / `many` for links.
`summary` and `pinned` are reserved and implicit in every type, so don't declare them.

Use `alwaysList: true` for types whose summaries should always be in front of you (the starter `preference` type has it). They get up to 35% of the prompt budget, so keep such types small.

Objects with a path field (e.g. `location: ~/Projects/north`) are ranked first in the prompt when you work inside that path, followed by the objects that link to them. A `location` field on repo or system objects is therefore worth having. Keep it a plain path, or a list of paths, rather than prose.

## Root schema: `<store>/.schema.md`

```md
---
summaryMaxLength: 80   # max chars of every object's summary
promptBudget: 8000     # max chars of full object lines in the system prompt (rules, guidance, pinned excluded)
namesBudget: 10000     # max chars of the slug lists that name every other object
pinnedBudget: 2500     # max chars (summary + body) of all pinned objects combined
---
Guidance for the whole store (shown in the system prompt).
```

The project store's settings override the global store's.

## Objects

```md
---
summary: Payments API; owns checkout + refunds; Go, deployed on k8s   # required, one line
owner: team/payments
tags: [critical]
---
Body in markdown. Mention other objects as [[system/ledger]], [[person/ana|Ana]] or [[practice/releases#hotfixes]].
```

- Typed link fields accept `team/payments`, `"[[team/payments]]"` or unquoted `[[team/payments]]`.
  For `many`, use a YAML list (`[a/b, c/d]` or `- a/b` lines).
- Fields the schema doesn't declare are allowed; lint lists them.

## Pinned objects

Add `pinned: true` to an object's frontmatter, and its full content (summary and body) is loaded into
the system prompt in every session. Use it sparingly, for knowledge that must never be missed:
hard rules, critical contacts, standing instructions.

All pinned objects together must fit in `pinnedBudget`. A write that would exceed it is rejected
and lists what's pinned, so unpin something or tighten it. Find pinned objects with
`o6y query --where pinned=true`; pin or unpin with `o6y set <id> pinned=true` (or `--unset pinned`). The root schema's body is also loaded every session; use
it for store-wide guidance, and pinned objects for specific facts.

## Links: what's an error and what's a warning

| Situation | Result |
|---|---|
| Target object doesn't exist yet (body or typed field) | warning; listed as a wanted page |
| Body link to a type that has no schema yet | warning; listed as a wanted page |
| Malformed link (`[[Some Page]]`, not `type/slug`) | **error** |
| Typed field points to a type not in `to` | **error** |
| Global object links to a project object or type | **error** |

Warnings never block a write. They are appended to the tool result, so resolve them when it makes sense, usually by writing the missing object.

## Global vs project stores

- **global** (default `~/.agents/o6y`) holds knowledge useful across repos: people, teams, shared
  systems and company-wide practices.
- **project** (default `<repo>/.agents/o6y`) holds knowledge specific to this repo.
- Types share one namespace. A project can add types and use global types, but it can't redefine a global type.
- Object ids (`type/slug`) are unique across both stores.
- Links go one way: project → global. Global objects can't link into a project.

## Validation

- **`write`/`edit` an object:** the final content is validated. If it is rejected, nothing is written and you get the errors.
- **`write`/`edit` a schema:** rejected if the schema is malformed or if any existing object would stop validating.
- **`bash` touching a store:** after the command, the whole store is checked. If the command introduced
  errors, all of its store changes are rolled back and the errors are reported. Warnings don't trigger a rollback.
- **Deleting or renaming objects** is allowed. Links that pointed at them become warnings.

## Recipes

**Write to a type.** Read its `<type>/.schema.md` first (fields, guidance, `index:`). Keep summaries well under the cap: a rejected write costs a retry. `o6y check <id> < draft.md` validates a draft without writing it.

**Add a type.** Write `<type>/.schema.md` with a `description`, then write its objects.

**Change a type's fields** with `o6y field`. It edits the schema and migrates every object in one validated step:
- `o6y field add system launched date --required --default 2024-01-01`. `--default` fills objects that don't have the field. Other options: `--values a,b` (enum), `--to team` / `--many` (link), `--description`.
- `o6y field rename person role title`. This also updates `index:`.
- `o6y field drop system legacy-id`. Use `--keep-values` to drop it from the schema only.

**Rename or move an object:** `o6y mv system/old-name system/new-name` rewrites every link to it, in bodies (keeping `|label` and `#heading`) and in typed fields. Add `--in project` to move it into the project store.

**Merge duplicates:** `o6y merge note/dup note/original`. The original keeps its own fields and gains the ones it lacked, the duplicate's body is appended under `## Merged from …`, links are repointed and the duplicate is deleted. Then tidy the merged body.

**Rename a type:** `o6y type rename gotcha pitfall` moves the folder and rewrites ids in links and in other schemas' `to:`.

**Anything else** (an unusual migration): do it in **one** bash command, so the store is validated once at the end and rolled back if the result is invalid.

## The `o6y` command

Run it with bash. Every write command validates the whole change before writing anything, logs it, and accepts `--dry-run` to preview.

| Command | Does |
|---|---|
| `o6y query [text] [--type T] [--where f=v]… [--links-to ID] [--linked-from ID] [--json]` | find objects (list and link fields match any element) |
| `o6y show <id>` · `o6y links <id>` · `o6y backlinks <id>` | an object with backlinks; outgoing or incoming links with the field they use |
| `o6y index [type]` | the generated catalog |
| `o6y lint` | errors, warnings, wanted pages, orphans, undeclared fields (exit 1 on errors). Run after bulk changes |
| `o6y stats` · `o6y log [--since 2d]` | counts and budgets; recent changes |
| `o6y prompt [--stats]` | the memory section of your system prompt, or where its budget goes |
| `o6y export [--format json\|mermaid\|dot]` | dump the store or its link graph |
| `o6y new <id> --summary S [--set f=v]… [--body B] [--in project]` | create an object |
| `o6y set <id> f=v… [--unset f]` | set fields (values are YAML: `true`, `3`, `[a, b]`) |
| `o6y mv` · `o6y merge` · `o6y rm` · `o6y field` · `o6y type rename` | see Recipes |
| `o6y check <id\|path> [--file F]` | validate a draft (stdin or file) without writing it |

`o6y help <command>` shows a command's options. `/o6y` (a user command in pi) shows status and refreshes the memory section of the system prompt, which is otherwise computed once per session.

## What to record

Record durable knowledge that a teammate would otherwise have to learn the hard way:
- who owns what and who to ask
- how systems fit together
- conventions and processes
- the reasons behind decisions
- recurring review feedback
- pitfalls and workarounds

Skip anything that is obvious from the code or only relevant to the current task. Update existing objects instead of creating near-duplicates, and keep summaries specific.
