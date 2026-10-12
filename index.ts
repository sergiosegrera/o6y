// Package entry. pi labels a package's extension by its path unless the entry is index.ts,
// so this keeps the label to the package name ("o6y" via npm, "sergiosegrera/o6y" via git).
export { default } from "./src/extension.ts";
