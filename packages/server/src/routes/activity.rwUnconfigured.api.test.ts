import { tokenForHuman } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { vi } from "vitest";

import { risingWaveUnavailableResponsesTotal } from "../metrics";
import { installRisingWaveReadReferences, uninstallRisingWaveReadReferences } from "../test/risingWaveReadReference";
import { __testRisingWaveInbox, addHuman, createChannel, getOrCreateThread, recordThreadFollow } from "../services/channelService";
import { createMessage } from "../services/messageService";
import { __setActivityReadSourceForTests, type ActivityReadSource } from "../services/activityReadSource";
import { __setConversationUnreadSourceForTests, type ConversationUnreadSource } from "../services/conversationUnreadSource";
import { createServer, headers, seedUser } from "./channels.api.fixtures";

const test = createApiTest();

// Tenny (#triage, 2026-10-30): with RisingWave not configured the Activity
// reads answer the explicit 503 rw_unconfigured that GET /api/channels/unread
// already answers, and log it; never a 500 and never an empty list (an empty
// list would hide a production RisingWave outage). Every other failure keeps
// the route's 500.
const endpoints = [
  { path: "/api/channels/inbox", route: "/api/channels/inbox", logPrefix: "Failed to get inbox:", error: "Failed to get inbox" },
  { path: "/api/channels/threads/followed", route: "/api/channels/threads/followed", logPrefix: "Failed to get followed threads:", error: "Failed to get followed threads" },
  { path: "/api/servers/unread-summary", route: "/api/servers/unread-summary", logPrefix: "Failed to get unread summary:", error: "Failed to get unread summary" },
] as const;

// `followsThread`: the followed-thread list has something to read past the
// RisingWave follow rows (its Postgres fallback reads the stats from RW too).
async function seedReader(label: string, { followsThread = true } = {}) {
  const owner = await seedUser(`activity-rw-${label}@slock.test`, `activity-rw-${label}`);
  const server = await createServer(`Activity RW ${label}`, `activity-rw-${label}`, owner.id);
  const channel = await createChannel(server.id, `activity-rw-${label}`);
  await addHuman(channel.id, owner.id);
  if (followsThread) {
    const parent = await createMessage(channel.id, "user", owner.id, "parent message");
    const thread = await getOrCreateThread(parent.id, owner.id, "user");
    await recordThreadFollow("user", owner.id, thread.id, parent.id, "authored");
  }
  return { serverId: server.id, token: await tokenForHuman(owner.email) };
}

async function counterValue(route: string, code: string): Promise<number> {
  return (await risingWaveUnavailableResponsesTotal.get()).values
    .find((value) => value.labels.code === code && value.labels.route_pattern === route)?.value ?? 0;
}

async function withRisingWave<T>(
  overrides: Parameters<typeof __testRisingWaveInbox.set>[0],
  fn: () => Promise<T>,
): Promise<T> {
  // Exercise the RisingWave reader itself: take the Postgres test reference away.
  uninstallRisingWaveReadReferences();
  __testRisingWaveInbox.set(overrides);
  try {
    return await fn();
  } finally {
    __testRisingWaveInbox.reset();
    installRisingWaveReadReferences();
  }
}

function loggedCalls(spy: { mock: { calls: unknown[][] } }, prefix: string) {
  return spy.mock.calls.filter((call) => call[0] === prefix)
    .map((call) => call[1] as { route?: string; status?: number; errorClass?: string; errorMessage?: string });
}

for (const [index, endpoint] of endpoints.entries()) for (const followsThread of [true, false]) {
  test(`GET ${endpoint.path}: RisingWave not configured answers 503 rw_unconfigured and logs it (${followsThread ? "with" : "without"} a followed thread)`, async ({ app }) => {
    const reader = await seedReader(`unconfigured-${index}-${followsThread}`, { followsThread });
    const before = await counterValue(endpoint.route, "rw_unconfigured");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await withRisingWave({ getPool: () => null }, () =>
        fetch(`${app.baseUrl}${endpoint.path}`, { headers: headers(reader.token, reader.serverId) }));

      assert.equal(res.status, 503);
      assert.equal(res.headers.get("retry-after"), null);
      assert.deepEqual(await res.json(), { error: "RisingWave is not configured", code: "rw_unconfigured", retryable: false });
      assert.equal(await counterValue(endpoint.route, "rw_unconfigured") - before, 1);
      const logged = loggedCalls(errorSpy, endpoint.logPrefix);
      assert.equal(logged.length, 1);
      assert.equal(logged[0]?.route, endpoint.route);
      assert.equal(logged[0]?.status, 503);
      assert.equal(logged[0]?.errorClass, "RisingWaveNotConfiguredError");
      assert.match(logged[0]?.errorMessage ?? "", /RisingWave is not configured/);
    } finally {
      errorSpy.mockRestore();
    }
  });
}

async function expectLogged500(res: Response, endpoint: (typeof endpoints)[number], errorSpy: { mock: { calls: unknown[][] } }) {
  assert.equal(res.status, 500);
  const body = await res.json() as { error?: string; code?: string };
  assert.equal(body.error, endpoint.error);
  assert.equal(body.code, undefined);
  const logged = loggedCalls(errorSpy, endpoint.logPrefix);
  assert.equal(logged.length, 1);
  assert.equal(logged[0]?.route, endpoint.route);
  assert.equal(logged[0]?.status, 500);
}

// A bug that is not RisingWave's (every RW-served read throws a plain Error).
const bug = async () => { throw new Error("mapping bug"); };
const buggyActivitySource: ActivityReadSource = {
  inboxItems: bug,
  activityUnreadTotals: bug,
  followedThreadStats: bug,
  followedThreadRows: bug,
};
const buggyConversationUnreadSource: ConversationUnreadSource = { summaryRows: bug, sidebarTotals: bug };

for (const [index, endpoint] of endpoints.entries()) {
  test(`GET ${endpoint.path}: an error that is not RisingWave's keeps its 500 and logs it`, async ({ app }) => {
    const reader = await seedReader(`bug-${index}`);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    __setActivityReadSourceForTests(buggyActivitySource);
    __setConversationUnreadSourceForTests(buggyConversationUnreadSource);
    try {
      const res = await fetch(`${app.baseUrl}${endpoint.path}`, { headers: headers(reader.token, reader.serverId) });
      await expectLogged500(res, endpoint, errorSpy);
    } finally {
      installRisingWaveReadReferences();
      errorSpy.mockRestore();
    }
  });
}

// The followed-thread list falls back to Postgres on a failed RW row read, so
// only the Inbox and the unread summary reach the route with rw_read_failed;
// these routes did not adopt rw_read_failed and keep their 500 for it.
for (const [index, endpoint] of endpoints.filter((e) => e.path !== "/api/channels/threads/followed").entries()) {
  test(`GET ${endpoint.path}: a failed RisingWave read keeps its 500 and logs it`, async ({ app }) => {
    const reader = await seedReader(`read-failed-${index}`);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await withRisingWave({
        getPool: () => ({}) as never,
        query: (async () => { throw Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:4566"), { code: "ECONNREFUSED" }); }) as never,
      }, () => fetch(`${app.baseUrl}${endpoint.path}`, { headers: headers(reader.token, reader.serverId) }));
      await expectLogged500(res, endpoint, errorSpy);
    } finally {
      errorSpy.mockRestore();
    }
  });
}
