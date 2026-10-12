import { readFileSync } from "node:fs";
import { main } from "./main.ts";

process.exitCode = await main(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
  stdin: () => (process.stdin.isTTY ? undefined : readFileSync(0, "utf8")),
  isTTY: !!process.stdin.isTTY && !!process.stdout.isTTY,
});
