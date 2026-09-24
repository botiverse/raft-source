import assert from "node:assert/strict";
import { test } from "vitest";

import { createKServiceExecutableSurface } from "./kLifecycleSurface.js";
import { kSlotBinaryPath } from "./kPaths.js";

test("K lifecycle surface reads the exact live service executable over IPC", async () => {
  let closed = false;
  const surface = createKServiceExecutableSurface("/home", async () => ({
    events: { async *[Symbol.asyncIterator]() {} },
    request: async () => ({
      computerVersion: "1.1.0",
      serviceGeneration: "generation",
      servicePid: 42,
      serviceExecutablePath: "/home/computer/k/slots/experiment/artifact.bin",
      managedServerIds: [],
      managedSetRevision: "revision",
    }),
    close: async () => { closed = true; },
  }) as never);

  assert.deepEqual(await surface.read(), {
    value: "/home/computer/k/slots/experiment/artifact.bin",
    source: "computer.machine-attestation.serviceExecutablePath",
  });
  assert.equal(closed, true);
});

test("Windows lifecycle readback canonicalizes casing only for the same experiment path", async () => {
  const home = "C:\\Users\\Raft";
  const expected = kSlotBinaryPath(home, "experiment");
  const surface = createKServiceExecutableSurface(home, async () => ({
    events: { async *[Symbol.asyncIterator]() {} },
    request: async () => ({
      computerVersion: "1.1.0",
      serviceGeneration: "generation",
      servicePid: 42,
      serviceExecutablePath: expected.toUpperCase(),
      managedServerIds: [],
      managedSetRevision: "revision",
    }),
    close: async () => {},
  }) as never, "win32");

  assert.equal((await surface.read()).value, expected);
});
