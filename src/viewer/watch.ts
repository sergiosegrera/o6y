import { existsSync, type FSWatcher, watch } from "node:fs";
import { storeSignature } from "../core/fsops.ts";
import type { Layer } from "../core/store.ts";

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
  let last = storeSignature(layers);
  const poll = setInterval(() => {
    const now = storeSignature(layers);
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
