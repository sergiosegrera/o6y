#!/usr/bin/env node
import {
  storeSignature
} from "./chunk-asv2qy3p.js";

// src/viewer/watch.ts
import { existsSync, watch } from "node:fs";
function watchStores(layers, onChange, pollMs = 1500) {
  let timer;
  const fire = () => {
    clearTimeout(timer);
    timer = setTimeout(onChange, 80);
  };
  const watchers = [];
  for (const layer of layers) {
    if (!existsSync(layer.root))
      continue;
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
    for (const w of watchers)
      w.close();
  };
}

export { watchStores };
