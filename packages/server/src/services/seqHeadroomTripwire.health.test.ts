import { createApiTest } from "../test/integration/apiTest.js";
// Wiring tooth for the seq-headroom tripwire (review gate on #5715).
//
// The pure-unit teeth pin the classifier but not the PRODUCTION WIRING: with
// the /health probe call deleted, the whole tripwire could silently never run
// while CI stays green. This tooth drives the real app's /health endpoint over
// a seeded critical-range seq and asserts the full chain health -> probe ->
// MAX(seq) query -> structured log, plus the throttle. Deleting the app.ts
// call site, the DB query, or the log emission each goes RED here.
import assert from "node:assert/strict";
import { onTestFinished, vi } from "vitest";

import { getDb } from "../db/index.js";
import { channels, messages, servers, users } from "../db/schema.js";
import {
  INT4_MAX,
  SEQ_HEADROOM_CRITICAL_RATIO,
  resetSeqHeadroomThrottleForTest,
} from "./seqHeadroomTripwire.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

const CRITICAL_SEQ = Math.ceil(INT4_MAX * SEQ_HEADROOM_CRITICAL_RATIO) + 7;

async function waitForHeadroomLogs(
  calls: () => string[],
  expectedCount: number,
  deadlineMs = 3000,
): Promise<string[]> {
  const start = Date.now();
  for (;;) {
    const found = calls();
    if (found.length >= expectedCount) return found;
    if (Date.now() - start > deadlineMs) return found;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("health polling drives the tripwire: probe fires, logs once, throttles", async ({ app }) => {

  onTestFinished(async () => {
    await app.close();
  });

  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: "headroom-owner@example.com",
    name: "headroom-owner",
    passwordHash: "hash",
    emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({
    name: "Headroom",
    slug: "headroom",
    ownerId: owner.id,
  }).returning();
  const [channel] = await db.insert(channels).values({
    serverId: server.id,
    name: "general",
    type: "channel",
  }).returning();
  // ONE row with an explicitly critical-range seq: messages.seq is int8, so
  // the value itself is legal; the tripwire must still call it out.
  await db.insert(messages).values({
    channelId: channel.id,
    senderType: "user",
    senderId: owner.id,
    content: "headroom probe fixture",
    seq: CRITICAL_SEQ,
  });

  const errorSpy = vi.spyOn(console, "error");
  onTestFinished(() => errorSpy.mockRestore());
  const headroomLogs = () =>
    errorSpy.mock.calls
      .map((args) => args.map(String).join(" "))
      .filter((line) => line.includes("seq_headroom"));

  resetSeqHeadroomThrottleForTest();
  const first = await fetch(`${app.baseUrl}/health`);
  assert.equal(first.status, 200);

  // The probe is fire-and-forget off the health path; wait for its log.
  const afterFirst = await waitForHeadroomLogs(headroomLogs, 1);
  assert.equal(afterFirst.length, 1, "successful health polling must run the probe exactly once");
  assert.match(afterFirst[0], /level=critical/);
  assert.match(afterFirst[0], new RegExp(`maxSeq=${CRITICAL_SEQ}\\b`), "log must carry the real DB MAX(seq)");

  // Throttle: an immediate second poll must not re-query or re-log.
  const second = await fetch(`${app.baseUrl}/health`);
  assert.equal(second.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(headroomLogs().length, 1, "second poll within the throttle window must be a no-op");

  // Positive control: with the throttle reset, the same poll logs again —
  // proving the silence above came from the throttle, not from a dead probe.
  resetSeqHeadroomThrottleForTest();
  const third = await fetch(`${app.baseUrl}/health`);
  assert.equal(third.status, 200);
  const afterThird = await waitForHeadroomLogs(headroomLogs, 2);
  assert.equal(afterThird.length, 2, "throttle reset must re-arm the probe");
});
