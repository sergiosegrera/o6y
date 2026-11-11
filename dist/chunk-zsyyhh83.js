#!/usr/bin/env node
import {
  watchStores
} from "./chunk-mw5ssfee.js";
import {
  graphData,
  graphJson,
  renderGraphHtml
} from "./chunk-p3wgb7ze.js";
import"./chunk-angs7n4p.js";
import"./chunk-asv2qy3p.js";
import"./chunk-a8qzjqdm.js";

// src/viewer/graphServer.ts
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
function serveGraph(layers, load, opts = {}) {
  const token = randomBytes(16).toString("hex");
  const base = `/${token}/`;
  let data = graphData(load());
  let json = graphJson(data);
  const clients = new Set;
  const send = (res, event, body) => res.write(`event: ${event}
data: ${body}

`);
  const stopWatching = watchStores(layers, () => {
    try {
      const next = graphData(load());
      const nextJson = graphJson(next);
      if (nextJson === json)
        return;
      data = next;
      json = nextJson;
      for (const res of clients)
        send(res, "change", String(Date.now()));
    } catch {}
  }, opts.watchMs);
  const heartbeat = setInterval(() => {
    for (const res of clients)
      res.write(`: ping

`);
  }, 25000);
  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };
    if (path === base.slice(0, -1)) {
      res.writeHead(302, { ...headers, location: base });
      return res.end();
    }
    if (req.method !== "GET" || !path.startsWith(base)) {
      res.writeHead(404, headers);
      return res.end();
    }
    const rest = path.slice(base.length);
    if (rest === "") {
      res.writeHead(200, { ...headers, "content-type": "text/html; charset=utf-8" });
      return res.end(renderGraphHtml(data, opts.focus, true));
    }
    if (rest === "data") {
      res.writeHead(200, { ...headers, "content-type": "application/json; charset=utf-8" });
      return res.end(json);
    }
    if (rest === "events") {
      res.writeHead(200, { ...headers, "content-type": "text/event-stream", connection: "keep-alive" });
      res.write(`retry: 2000

`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    res.writeHead(404, headers);
    res.end();
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : opts.port;
      resolve({
        url: `http://127.0.0.1:${port}${base}`,
        close: () => new Promise((done) => {
          stopWatching();
          clearInterval(heartbeat);
          for (const res of clients)
            res.end();
          clients.clear();
          server.close(() => done());
          server.closeAllConnections?.();
        })
      });
    });
  });
}
export {
  serveGraph
};
