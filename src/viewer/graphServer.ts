/** `o6y graph --live`: serves the graph page on localhost and tells it when the stores change. */
import { randomBytes } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { type GraphData, graphData, graphJson, renderGraphHtml } from "../core/graph.ts";
import type { Layer, Store } from "../core/store.ts";
import { watchStores } from "./watch.ts";

export interface GraphServer {
  url: string;
  close: () => Promise<void>;
}

/**
 * Listens on 127.0.0.1 under a random path, so other local users and web pages can't read the
 * store. The page fetches `data` again whenever `events` reports a change.
 */
export function serveGraph(layers: Layer[], load: () => Store, opts: { focus?: string; port?: number; watchMs?: number } = {}): Promise<GraphServer> {
  const token = randomBytes(16).toString("hex");
  const base = `/${token}/`;
  let data: GraphData = graphData(load());
  let json = graphJson(data);
  const clients = new Set<ServerResponse>();
  const send = (res: ServerResponse, event: string, body: string) => res.write(`event: ${event}\ndata: ${body}\n\n`);

  const stopWatching = watchStores(
    layers,
    () => {
      try {
        const next = graphData(load());
        const nextJson = graphJson(next);
        if (nextJson === json) return;
        data = next;
        json = nextJson;
        for (const res of clients) send(res, "change", String(Date.now()));
      } catch {
        // A half-written file can fail to load; the next change will try again.
      }
    },
    opts.watchMs,
  );
  const heartbeat = setInterval(() => {
    for (const res of clients) res.write(": ping\n\n");
  }, 25_000);

  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0]!;
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
      res.write("retry: 2000\n\n");
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
        close: () =>
          new Promise<void>((done) => {
            stopWatching();
            clearInterval(heartbeat);
            for (const res of clients) res.end();
            clients.clear();
            server.close(() => done());
            server.closeAllConnections?.();
          }),
      });
    });
  });
}
