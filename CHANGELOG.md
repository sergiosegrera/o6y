# Changelog

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
