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
  return {
    args: ["-p", "--no-session", "-ne", "-e", join(packageRoot(), "index.ts"), "--o6y-global", storeRoot, ["/o6y-dream", ...flags].join(" ")],
    env: { ...process.env, ...env, ...caller ? { O6Y_DREAM_EXCLUDE: caller } : {} }
  };
}

export { dreamInvocation };
