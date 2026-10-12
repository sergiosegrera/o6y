import { defineCase, hasObject, lintClean, noObject, typeSchema } from "../lib.ts";

export default defineCase({
  name: "schema-migration",
  description: "Renames a field across a schema and its objects, leaving a valid store.",
  fixture: "acme",
  steps: ["In memory, rename the `role` field of the person type to `title`, in the schema and in every person object."],
  checks: [
    typeSchema((s) => {
      const fields = s.types.get("person")?.schema.fields ?? {};
      return ("title" in fields && !("role" in fields)) || `fields: ${Object.keys(fields).join(", ")}`;
    }, "person schema has title and no role"),
    hasObject({ id: "person/ana-ruiz", where: { title: "staff engineer" } }, "ana-ruiz has title: staff engineer"),
    noObject({ type: "person", where: { role: (v) => v !== undefined } }, "no person object still has role"),
    lintClean(),
  ],
});
