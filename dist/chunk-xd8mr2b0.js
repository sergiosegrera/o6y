#!/usr/bin/env node

// src/dream/launch.ts
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
function packageRoot() {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, "package.json")) && dirname(dir) !== dir)
    dir = dirname(dir);
  return dir;
}
function dreamInvocation(storeRoot, flags, env) {
  const caller = env.O6Y_SOURCE?.replace(/^pi:/, "");
  const entry = join(packageRoot(), "index.ts");
  return {
    args: ["-p", "--no-session", "-e", entry, "--o6y-global", storeRoot, ["/o6y-dream", ...flags].join(" ")],
    env: { ...process.env, ...env, O6Y_EXTENSION: entry, ...caller ? { O6Y_DREAM_EXCLUDE: caller } : {} }
  };
}

export { dreamInvocation };
