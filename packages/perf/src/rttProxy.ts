/**
 * A local HTTP CONNECT proxy that adds a fixed round trip to everything the browser sends through it, so a fast
 * machine near the servers can stand in for a user far from them (startup --rtt).
 *
 * Why not DevTools network emulation (`Network.emulateNetworkConditions` latency): it does not delay CORS preflights
 * (measured 2026-11-17 on production: preflights answered in about 1 ms with 400 ms of emulated latency), and a
 * production preflight is a CloudFront miss that goes all the way to the origin, so it costs a real user a round trip.
 * Here the answer to CONNECT waits one round trip (the TCP handshake a distant user pays), and after it every chunk is
 * held for half the round trip in each direction, in order, so TLS setup, preflights and requests pay it too. HTTPS
 * only (CONNECT): a plain-HTTP request is refused. It is a stand-in, not a real network: no loss, no bandwidth limit,
 * and bytes sent in one burst are delayed together.
 */

import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";

export interface RttProxy {
  /** `http://127.0.0.1:<port>`, for Chromium's `--proxy-server`. */
  url: string;
  /** Round trip added, in milliseconds. */
  rttMs: number;
  /** Tunnels opened so far (one per connection the browser made). */
  tunnels(): number;
  close(): Promise<void>;
}

/** The range --rtt accepts: past a second a load would mostly measure the proxy. */
export const RTT_RANGE_MS = [0, 1000] as const;

/** `host:port` of a CONNECT request line, IPv6 brackets removed; null when it is not one. */
export function connectTarget(value: string | undefined): { host: string; port: number } | null {
  if (!value) return null;
  const at = value.lastIndexOf(":");
  if (at <= 0) return null;
  const port = Number(value.slice(at + 1));
  const host = value.slice(0, at).replace(/^\[(.*)\]$/, "$1");
  if (!host || !Number.isInteger(port) || port < 1 || port > 65_535) return null;
  return { host, port };
}

/**
 * Forward `from` to `to`, each chunk no earlier than `delayMs` after it arrived, keeping the order. A clean end is
 * passed on as an end after the last chunk (so nothing buffered is lost); only an error tears `to` down.
 */
function pipeDelayed(from: net.Socket, to: net.Socket, delayMs: number): void {
  let queue = Promise.resolve();
  const later = (step: () => void): void => {
    queue = queue.then(step);
  };
  from.on("data", (chunk: Buffer) => {
    const due = Date.now() + delayMs;
    queue = queue
      .then(() => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, due - Date.now()))))
      .then(() => {
        if (!to.destroyed && !to.writableEnded) to.write(chunk);
      });
  });
  from.on("end", () => later(() => {
    if (!to.destroyed && !to.writableEnded) to.end();
  }));
  from.on("close", (hadError: boolean) => {
    if (hadError) to.destroy();
  });
}

/** Start the proxy on a free loopback port. Only CONNECT is served; anything else gets 405. */
export async function startRttProxy(rttMs: number): Promise<RttProxy> {
  if (!Number.isFinite(rttMs) || rttMs < RTT_RANGE_MS[0] || rttMs > RTT_RANGE_MS[1]) throw new RangeError(`rtt must be ${RTT_RANGE_MS[0]} to ${RTT_RANGE_MS[1]} ms`);
  const half = rttMs / 2;
  let opened = 0;
  const sockets = new Set<net.Socket>();
  const track = (s: net.Socket): void => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  };
  const server = http.createServer((_req, res) => {
    res.writeHead(405, { "content-type": "text/plain" });
    res.end("this proxy serves CONNECT (HTTPS) only\n");
  });
  server.on("connect", (req: http.IncomingMessage, client: net.Socket, head: Buffer) => {
    track(client);
    const target = connectTarget(req.url);
    if (!target) {
      client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    let answered = false;
    const upstream = net.connect({ host: target.host, port: target.port, allowHalfOpen: true });
    track(upstream);
    upstream.on("connect", () => {
      // the TCP handshake a distant user pays: one round trip before the tunnel answers
      setTimeout(() => {
        if (client.destroyed) {
          upstream.destroy();
          return;
        }
        opened++;
        answered = true;
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        pipeDelayed(client, upstream, half);
        pipeDelayed(upstream, client, half);
      }, rttMs);
    });
    upstream.on("error", () => {
      if (!answered && !client.destroyed) client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      else client.destroy();
    });
    client.on("error", () => upstream.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  // never the thing keeping a finished run alive
  server.unref();
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    rttMs,
    tunnels: () => opened,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

/** Chromium switches that send every connection through the proxy, loopback included. */
export function rttChromiumArgs(proxy: Pick<RttProxy, "url">): string[] {
  return [`--proxy-server=${proxy.url}`, "--proxy-bypass-list=<-loopback>"];
}
