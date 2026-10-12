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
`summary` is reserved and implicit in every type, so don't declare it.

## Root schema: `<store>/.schema.md`

```md
---
summaryMaxLength: 80   # max chars of every object's summary
promptBudget: 8000     # max chars of memory injected into the system prompt
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

**Add a type.** Write `<type>/.schema.md` with a `description`, then write its objects.

**Add an optional field.** Edit the schema. Existing objects stay valid.

**Add a required field, or tighten a field.** Either:
1. update the objects first (extra fields are allowed), then edit the schema; or
2. do both in **one** bash command so the change is validated as a single transaction:

```bash
python3 - <<'PY'
import pathlib
d = pathlib.Path("<store>/system")
for f in d.glob("*.md"):                      # objects first…
    if f.name.startswith("."): continue      # (pathlib's glob also matches .schema.md)
    s = f.read_text()
    f.write_text(s.replace("---\n", "---\nlaunched: 2024-01-01\n", 1))
schema = d / ".schema.md"                     # …then the schema, in the same command
s = schema.read_text()
schema.write_text(s.replace("fields:\n", "fields:\n  launched: { type: date, required: true }\n", 1))
PY
```

**Rename a field.** Add the new field as optional, copy the values over, remove the old field from the objects, then drop it from the schema. Or do it all in one bash command.

**Rename an object.** In one bash command, `mv` the file and rewrite its links:
`mv <store>/system/old-name.md <store>/system/new-name.md && grep -rl 'system/old-name' <store> | xargs perl -pi -e 's#system/old-name\b#system/new-name#g'`
(`perl -pi` behaves the same on macOS and Linux, unlike `sed -i`.)

**Merge duplicates.** Fold the content into one object, repoint the links (as above), then delete the other.

## Tools and commands

- `o6y_query`: filter objects by `type`, `where` (field equality; list and link fields match any
  element), `linksTo`, `linkedFrom` or `text`.
- `o6y_lint`: errors, warnings, wanted pages, orphans and undeclared fields. Run it after bulk changes.
- `/o6y` (user command): shows status and refreshes the memory section in the system prompt, which is otherwise computed once per session.

## What to record

Record durable knowledge that a teammate would otherwise have to learn the hard way:
- who owns what and who to ask
- how systems fit together
- conventions and processes
- the reasons behind decisions
- recurring review feedback
- pitfalls and workarounds

Skip anything that is obvious from the code or only relevant to the current task. Update existing objects instead of creating near-duplicates, and keep summaries specific.
