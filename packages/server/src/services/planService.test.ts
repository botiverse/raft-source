import { dbTest as test } from "../test/integration/dbTest.js";
import assert from "node:assert/strict";

import { withAgentCreateLock, withServerLock, withServerResourceLock } from "./planService.js";


test("withServerLock serializes concurrent work on pglite", async ({ db }) => {
  const serverId = "11111111-1111-1111-1111-111111111111";
  const events: string[] = [];
  let releaseFirst!: () => void;

  const firstLockReleased = new Promise<void>((resolve) => {
    releaseFirst = () => resolve();
  });

  const first = withServerLock(serverId, 7, async () => {
    events.push("first:entered");
    await firstLockReleased;
    events.push("first:released");
  });

  await waitFor(() => events.includes("first:entered"));

  const second = withServerLock(serverId, 7, async () => {
    events.push("second:entered");
  });

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(events, ["first:entered"]);

  releaseFirst();
  await Promise.all([first, second]);

  assert.deepEqual(events, [
    "first:entered",
    "first:released",
    "second:entered",
  ]);
});

test("withAgentCreateLock serializes the exact checkpoint helper used by create and reset", async ({ db }) => {
  const serverId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const events: string[] = [];
  let releaseCreate!: () => void;
  const createMayCommit = new Promise<void>((resolve) => {
    releaseCreate = resolve;
  });

  const createSide = withAgentCreateLock(serverId, async () => {
    events.push("create:entered");
    await createMayCommit;
    events.push("create:committed");
  });
  await waitFor(() => events.includes("create:entered"));

  const resetSide = withAgentCreateLock(serverId, async () => {
    events.push("reset:entered");
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(events, ["create:entered"], "reset is queued while create owns the checkpoint lock");

  releaseCreate();
  await Promise.all([createSide, resetSide]);
  assert.deepEqual(events, ["create:entered", "create:committed", "reset:entered"]);
});

test("withServerResourceLock serializes the same resource on pglite", async ({ db }) => {
  const serverId = "22222222-2222-2222-2222-222222222222";
  const events: string[] = [];
  let releaseFirst!: () => void;

  const firstLockReleased = new Promise<void>((resolve) => {
    releaseFirst = () => resolve();
  });

  const first = withServerResourceLock(serverId, 7, "dm:user-a:user-b", async () => {
    events.push("first:entered");
    await firstLockReleased;
    events.push("first:released");
  });

  await waitFor(() => events.includes("first:entered"));

  const second = withServerResourceLock(serverId, 7, "dm:user-a:user-b", async () => {
    events.push("second:entered");
  });

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(events, ["first:entered"]);

  releaseFirst();
  await Promise.all([first, second]);

  assert.deepEqual(events, [
    "first:entered",
    "first:released",
    "second:entered",
  ]);
});

async function waitFor(predicate: () => boolean, timeoutMs = 1_000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for predicate");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
