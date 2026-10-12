import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { canonicalPath } from "./store.ts";

/**
 * Directories describing where the agent works, for ranking memory by relevance: the cwd, its git
 * repository root, and for a linked worktree the main checkout.
 */
export function workPaths(cwd: string): string[] {
  const paths = new Set([canonicalPath(cwd)]);
  try {
    const out = execFileSync("git", ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    });
    const [top, common] = out.trim().split("\n");
    if (top) paths.add(canonicalPath(top));
    if (common?.endsWith("/.git")) paths.add(canonicalPath(dirname(common)));
  } catch {}
  return [...paths];
}
