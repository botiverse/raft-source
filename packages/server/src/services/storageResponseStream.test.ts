import assert from "node:assert/strict";
import { once } from "node:events";
import {
  Agent,
  createServer,
  get,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { PassThrough, Readable, Transform } from "node:stream";
import { test } from "vitest";

import {
  streamStorageResponse,
  streamStorageResponseThrough,
} from "./storageResponseStream.js";

type Forward = (source: IncomingMessage, response: ServerResponse) => Promise<void>;

function countAgentEntries(entries: Record<string, unknown[] | undefined>): number {
  return Object.values(entries).reduce((total, values) => total + (values?.length ?? 0), 0);
}

function busySockets(agent: Agent): number {
  return countAgentEntries(agent.sockets);
}

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return address.port;
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
}

async function abortDestinationMidDownload(forward: Forward): Promise<number> {
  const upstream = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/octet-stream" });
    res.write(Buffer.alloc(64 * 1024, 0x61));
    const interval = setInterval(() => res.write(Buffer.alloc(1024, 0x62)), 10);
    res.once("close", () => clearInterval(interval));
  });
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  let proxy: Server | null = null;

  try {
    const upstreamPort = await listen(upstream);
    proxy = createServer((_req, res) => {
      const upstreamRequest = get(
        `http://127.0.0.1:${upstreamPort}/object`,
        { agent },
        (source) => {
          void forward(source, res).catch((error: unknown) => {
            if (!res.destroyed) res.destroy(error instanceof Error ? error : undefined);
          });
        },
      );
      upstreamRequest.once("error", (error) => {
        if (!res.destroyed) res.destroy(error);
      });
    });
    const proxyPort = await listen(proxy);

    await new Promise<void>((resolve, reject) => {
      const request = get(`http://127.0.0.1:${proxyPort}/download`, (response) => {
        response.once("data", () => {
          assert.equal(busySockets(agent), 1, "the upstream request must own one busy agent socket before abort");
          response.destroy();
          resolve();
        });
        response.once("error", (error) => {
          if ((error as NodeJS.ErrnoException).code === "ECONNRESET") return;
          reject(error);
        });
      });
      request.once("error", reject);
    });

    await waitFor(() => busySockets(agent) === 0);
    return busySockets(agent);
  } finally {
    agent.destroy();
    if (proxy) await closeServer(proxy);
    await closeServer(upstream);
  }
}

async function completeDownload(forward: Forward): Promise<Buffer> {
  const upstream = createServer((_req, res) => {
    res.end("stored-object");
  });
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  let proxy: Server | null = null;

  try {
    const upstreamPort = await listen(upstream);
    proxy = createServer((_req, res) => {
      get(`http://127.0.0.1:${upstreamPort}/object`, { agent }, (source) => {
        void forward(source, res).catch((error: unknown) => {
          if (!res.destroyed) res.destroy(error instanceof Error ? error : undefined);
        });
      }).once("error", (error) => res.destroy(error));
    });
    const proxyPort = await listen(proxy);
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      get(`http://127.0.0.1:${proxyPort}/download`, (response) => {
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("end", resolve);
        response.once("error", reject);
      }).once("error", reject);
    });
    return Buffer.concat(chunks);
  } finally {
    agent.destroy();
    if (proxy) await closeServer(proxy);
    await closeServer(upstream);
  }
}

test("storage response pipeline releases the upstream Agent socket when the client aborts", async () => {
  const remaining = await abortDestinationMidDownload((source, response) => (
    streamStorageResponse(source, response)
  ));
  assert.equal(remaining, 0, "client abort must destroy the upstream response and release its agent socket");
});

test("two-hop preview pipeline releases the upstream Agent socket when the client aborts", async () => {
  const remaining = await abortDestinationMidDownload((source, response) => (
    streamStorageResponseThrough(source, new Transform({
      transform(chunk, _encoding, callback) {
        callback(null, chunk);
      },
    }), response)
  ));
  assert.equal(remaining, 0, "destroying the transform alone is insufficient; the upstream agent socket must drain");
});

test("storage response pipeline preserves normal bytes and transform flush output", async () => {
  assert.equal(
    (await completeDownload((source, response) => streamStorageResponse(source, response))).toString(),
    "stored-object",
  );
  assert.equal(
    (await completeDownload((source, response) => streamStorageResponseThrough(
      source,
      new Transform({
        transform(chunk, _encoding, callback) {
          callback(null, chunk);
        },
        flush(callback) {
          callback(null, "-bridge");
        },
      }),
      response,
    ))).toString(),
    "stored-object-bridge",
  );
});

test("storage response pipelines propagate upstream and transform errors", async () => {
  const upstreamError = new Error("upstream storage failed");
  await assert.rejects(
    streamStorageResponse(
      new Readable({
        read() {
          this.destroy(upstreamError);
        },
      }),
      new PassThrough() as unknown as ServerResponse,
    ),
    (error: unknown) => error === upstreamError,
  );

  const transformError = new Error("preview transform failed");
  await assert.rejects(
    streamStorageResponseThrough(
      Readable.from(["stored-object"]),
      new Transform({
        transform(_chunk, _encoding, callback) {
          callback(transformError);
        },
      }),
      new PassThrough() as unknown as ServerResponse,
    ),
    (error: unknown) => error === transformError,
  );
});
