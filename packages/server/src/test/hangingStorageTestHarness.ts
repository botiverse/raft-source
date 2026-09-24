import assert from "node:assert/strict";
import { once } from "node:events";
import { Agent, createServer, get, type Server } from "node:http";

import {
  clearClockInterval,
  currentTimeMs,
  setClockInterval,
  setClockTimeout,
} from "@botiverse/raft-shared";

import type { StorageBackend } from "../services/storageService.js";

function countAgentEntries(entries: Record<string, unknown[] | undefined>): number {
  return Object.values(entries).reduce((total, values) => total + (values?.length ?? 0), 0);
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<boolean> {
  const deadline = currentTimeMs() + timeoutMs;
  while (currentTimeMs() < deadline) {
    if (predicate()) return true;
    await new Promise<void>((resolve) => setClockTimeout(() => resolve(), 10));
  }
  return predicate();
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

export async function createHangingStorageTestHarness(): Promise<{
  storage: StorageBackend;
  abortDownload: (
    url: string,
    init?: RequestInit,
    inspect?: (response: Response) => void,
  ) => Promise<void>;
  close: () => Promise<void>;
}> {
  const upstream = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/octet-stream" });
    res.write(Buffer.alloc(64 * 1024, 0x61));
    const interval = setClockInterval(() => res.write(Buffer.alloc(1024, 0x62)), 10);
    res.once("close", () => clearClockInterval(interval));
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const address = upstream.address();
  assert.ok(address && typeof address === "object");

  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  const busySockets = () => countAgentEntries(agent.sockets);
  const read = () => new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
    get(`http://127.0.0.1:${address.port}/object`, { agent }, resolve).once("error", reject);
  });
  const storage: StorageBackend = {
    async put() {},
    get: read,
    getRange: async () => read(),
    async delete() {},
  };

  return {
    storage,
    async abortDownload(url, init, inspect) {
      const response = await fetch(url, init);
      inspect?.(response);
      assert.ok(response.body, "streaming response must expose a body");
      const reader = response.body.getReader();
      const first = await reader.read();
      assert.equal(first.done, false, "abort tooth requires a live mid-download body");
      assert.equal(busySockets(), 1, "upstream request must own one busy agent socket before abort");
      await reader.cancel("test destination abort");
      assert.equal(
        await waitFor(() => busySockets() === 0),
        true,
        "destination abort must destroy the upstream stream and release its agent socket",
      );
    },
    async close() {
      agent.destroy();
      await closeServer(upstream);
    },
  };
}
