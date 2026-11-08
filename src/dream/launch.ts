/** How to start a dream from outside pi: a headless pi, since dreams need its models and agent sessions. */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The package root, from `src/...` or the bundle in `dist`. */
function packageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, "package.json")) && dirname(dir) !== dir) dir = dirname(dir);
  return dir;
}

/** Arguments and environment for `pi`. Called from inside a pi session, that session is left for a later dream. */
export function dreamInvocation(storeRoot: string, flags: string[], env: Record<string, string | undefined>): { args: string[]; env: Record<string, string | undefined> } {
  const caller = env.O6Y_SOURCE?.replace(/^pi:/, "");
  const entry = join(packageRoot(), "index.ts");
  return {
    // The user's extensions load so their model providers exist; the dream's own agents still get none.
    args: ["-p", "--no-session", "-e", entry, "--o6y-global", storeRoot, ["/o6y-dream", ...flags].join(" ")],
    env: { ...process.env, ...env, O6Y_EXTENSION: entry, ...(caller ? { O6Y_DREAM_EXCLUDE: caller } : {}) },
  };
}
