#!/usr/bin/env node
import {
  canonicalPath
} from "./chunk-fh0jaf4t.js";

// src/core/context.ts
import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
function workPaths(cwd) {
  const paths = new Set([canonicalPath(cwd)]);
  try {
    const out = execFileSync("git", ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000
    });
    const [top, common] = out.trim().split(`
`);
    if (top)
      paths.add(canonicalPath(top));
    if (common?.endsWith("/.git"))
      paths.add(canonicalPath(dirname(common)));
  } catch {}
  return [...paths];
}

export { workPaths };
