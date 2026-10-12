import { existsSync, readdirSync, statSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import type { Layer } from "../core/store.ts";

/** Cheap fingerprint of a store's files (path, size, mtime), to detect changes when polling. */
function signature(dir: string, depth = 0): string {
  if (depth > 2) return "";
  let out = "";
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return "";
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out += `${full}/\n${signature(full, depth + 1)}`;
    else {
      try {
        const s = statSync(full);
        out += `${full}:${s.size}:${s.mtimeMs}\n`;
      } catch {}
    }
  }
  return out;
}

/**
 * Calls `onChange` (debounced) whenever a file in any store changes. Uses recursive fs.watch for
 * instant updates, plus a slow poll that also covers stores that don't exist yet.
 */
export function watchStores(layers: Layer[], onChange: () => void, pollMs = 1500): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const fire = () => {
    clearTimeout(timer);
    timer = setTimeout(onChange, 80);
  };
  const watchers: FSWatcher[] = [];
  for (const layer of layers) {
    if (!existsSync(layer.root)) continue;
    try {
      watchers.push(watch(layer.root, { recursive: true }, fire));
    } catch {}
  }
  let last = layers.map((l) => signature(l.root)).join("\0");
  const poll = setInterval(() => {
    const now = layers.map((l) => signature(l.root)).join("\0");
    if (now !== last) {
      last = now;
      fire();
    }
  }, pollMs);
  return () => {
    clearTimeout(timer);
    clearInterval(poll);
    for (const w of watchers) w.close();
  };
}
