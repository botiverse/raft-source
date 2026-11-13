import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import {
  __resetLinkCardActionLimitsForTests, admitLinkCardAction, admitLinkCardUpdate, LINK_CARD_EXECUTE_PER_MINUTE, LINK_CARD_LOOKUP_PER_MINUTE, LINK_CARD_PREPARE_PER_MINUTE,
  LINK_CARD_RECOVERY_PER_MINUTE, LINK_CARD_STATUS_PER_MINUTE, LINK_CARD_UPDATE_PER_INSTALLATION_PER_MINUTE,
} from "./linkCardActionLimits";

// RFC 076 §8, protocol v3.2.3 §13.6. Without Redis (as here) the server is one
// replica and this process's count is the whole count; with Redis the same
// window is counted there (one INCR + TTL Lua call).
afterEach(() => __resetLinkCardActionLimitsForTests());

test("30 per viewer per Server per minute for each kind; the 31st waits out the window", async () => {
  assert.equal(LINK_CARD_EXECUTE_PER_MINUTE, 30);
  assert.equal(LINK_CARD_PREPARE_PER_MINUTE, 30);
  const start = 1_000_000;
  for (let i = 0; i < 30; i++) assert.deepEqual(await admitLinkCardAction("execute", "v1", "s1", start + i), { admitted: true });
  assert.deepEqual(await admitLinkCardAction("execute", "v1", "s1", start + 30_000), { admitted: false, retryAfterSeconds: 30 });
  assert.deepEqual(await admitLinkCardAction("prepare", "v1", "s1", start + 30_000), { admitted: true }, "prepare has its own budget");
  assert.deepEqual(await admitLinkCardAction("execute", "v1", "s2", start + 30_000), { admitted: true }, "per Server");
  assert.deepEqual(await admitLinkCardAction("execute", "v2", "s1", start + 30_000), { admitted: true }, "per viewer");
  assert.deepEqual(await admitLinkCardAction("execute", "v1", "s1", start + 60_000), { admitted: true }, "a new window");
});

test("execute's same-id lookup (recovery) has its own generous budget: 120 per viewer per Server per minute, apart from the execute budget", async () => {
  assert.equal(LINK_CARD_RECOVERY_PER_MINUTE, 120);
  const start = 2_000_000;
  for (let i = 0; i < 120; i++) assert.deepEqual(await admitLinkCardAction("recovery", "v1", "s1", start + i), { admitted: true });
  assert.deepEqual(await admitLinkCardAction("recovery", "v1", "s1", start + 15_000), { admitted: false, retryAfterSeconds: 45 });
  assert.deepEqual(await admitLinkCardAction("execute", "v1", "s1", start + 15_000), { admitted: true }, "the execute budget is untouched");
  assert.deepEqual(await admitLinkCardAction("recovery", "v2", "s1", start + 15_000), { admitted: true }, "per viewer");
  assert.deepEqual(await admitLinkCardAction("recovery", "v1", "s1", start + 60_000), { admitted: true }, "a new window");
});

test("after the send: 120 statuses and 120 lookups per viewer per Server per minute, each its own budget; 600 terminal updates per installation per minute", async () => {
  assert.equal(LINK_CARD_STATUS_PER_MINUTE, 120);
  assert.equal(LINK_CARD_LOOKUP_PER_MINUTE, 120);
  assert.equal(LINK_CARD_UPDATE_PER_INSTALLATION_PER_MINUTE, 600);
  const start = 3_000_000;
  for (let i = 0; i < 120; i++) assert.deepEqual(await admitLinkCardAction("status", "v1", "s1", start + i), { admitted: true });
  assert.deepEqual(await admitLinkCardAction("status", "v1", "s1", start + 10_000), { admitted: false, retryAfterSeconds: 50 });
  for (const kind of ["lookup", "recovery", "execute"] as const) assert.deepEqual(await admitLinkCardAction(kind, "v1", "s1", start + 10_000), { admitted: true }, kind);
  for (let i = 1; i < 120; i++) await admitLinkCardAction("lookup", "v1", "s1", start + 10_000 + i);
  assert.deepEqual(await admitLinkCardAction("lookup", "v1", "s1", start + 20_000), { admitted: false, retryAfterSeconds: 50 });
  for (let i = 0; i < 600; i++) assert.deepEqual(await admitLinkCardUpdate("inst-1", start + i), { admitted: true });
  assert.deepEqual(await admitLinkCardUpdate("inst-1", start + 30_000), { admitted: false, retryAfterSeconds: 30 });
  assert.deepEqual(await admitLinkCardUpdate("inst-2", start + 30_000), { admitted: true }, "per installation");
  assert.deepEqual(await admitLinkCardAction("status", "inst-1", "s1", start + 30_000), { admitted: true }, "never shares a key with a viewer's budget");
});
