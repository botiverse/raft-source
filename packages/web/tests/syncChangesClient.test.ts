import assert from "node:assert/strict";

import { AxiosError } from "axios";
import { vi } from "vitest";

import type { SyncChange, SyncChangesCursor, SyncChangesResponse, SyncSnapshotName } from "@botiverse/raft-shared";

import {
  planSyncChanges,
  SYNC_CHANNEL_ROW_REFRESH_LIMIT,
  SYNC_PULL_RETRY_MIN_MS,
  SYNC_PULL_RETRY_SPREAD_MS,
  SyncChangesSession,
} from "../src/store/syncChangesClient";
import type { SyncSnapshotLoaders } from "../src/store/syncChangesClient";

const cursor = (value: string) => value as SyncChangesCursor;
const SNAPSHOTS: SyncSnapshotName[] = [
  "channels", "channel_members", "server_members", "agents", "inbox",
  "unread", "followed_threads", "machines", "sidebar_order", "server_order",
];

function counterLoaders(overrides: Partial<SyncSnapshotLoaders> = {}) {
  const calls: Record<string, number> = {};
  const loaders = Object.fromEntries(SNAPSHOTS.map((name) => [name, {
    load: () => { calls[name] = (calls[name] ?? 0) + 1; },
  }])) as SyncSnapshotLoaders;
  return { calls, loaders: { ...loaders, ...overrides } };
}

function page(changes: unknown[], next: string, extra: Partial<SyncChangesResponse> = {}): SyncChangesResponse {
  return { cursor: cursor(next), hasMore: false, changes: changes as SyncChange[], reset: null, ...extra };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test("each entity maps to the reload it touches; unknown entity skipped, unknown op resnapshots", () => {
  const plan = planSyncChanges([
    { seq: 1, entity: "agent", id: "a1", op: "upsert", row: {} },
    { seq: 2, entity: "machine", id: "m1", op: "delete" },
    { seq: 3, entity: "conversation", id: "c1", op: "stale", refSeq: 4 },
    { seq: 4, entity: "channel", id: "ch1", op: "upsert", row: {} },
    { seq: 5, entity: "channel_member", id: "ch2:user:u1", op: "delete" },
    { seq: 6, entity: "widget", id: "w1", op: "upsert" },
    { seq: 7, entity: "sidebar_order", id: "s1", op: "replace" },
  ] as unknown as SyncChange[]);
  assert.deepEqual([...plan.snapshots].sort(), ["agents", "followed_threads", "inbox", "machines", "sidebar_order", "unread"]);
  assert.deepEqual([...plan.channelIds].sort(), ["ch1", "ch2"], "a member change also re-reads the channel row (member count)");
  assert.deepEqual([...plan.memberChannelIds], ["ch2"]);
});

test("a channel delete reads the lists; many channel upserts read the lists instead of row by row", () => {
  assert.ok(planSyncChanges([{ seq: 1, entity: "channel", id: "c", op: "delete" }]).snapshots.has("channels"));
  const many = Array.from({ length: SYNC_CHANNEL_ROW_REFRESH_LIMIT + 1 }, (_, i) => (
    { seq: i, entity: "channel", id: `c${i}`, op: "upsert", row: {} }
  )) as SyncChange[];
  const plan = planSyncChanges(many);
  assert.ok(plan.snapshots.has("channels"));
  assert.equal(plan.channelIds.size, 0);
});

test("scope changes take their snapshots; a removed server re-reads the server list", () => {
  const plan = planSyncChanges([
    { seq: 1, entity: "scope", id: "ch", op: "added", scopeKind: "channel", snapshots: ["channel_members"] },
    { seq: 2, entity: "scope", id: "s", op: "removed", scopeKind: "server", snapshots: [] },
  ]);
  assert.ok(plan.snapshots.has("channel_members"));
  assert.ok(plan.snapshots.has("server_order"));
});

test("pull follows hasMore, keeps the last cursor, and applies once", async () => {
  const seen: Array<string | null> = [];
  const responses = [
    page([], "c0"),
    page([{ seq: 1, entity: "agent", id: "a", op: "upsert", row: {} }], "c1", { hasMore: true }),
    page([{ seq: 2, entity: "agent", id: "b", op: "upsert", row: {} }], "c2"),
    page([], "c3"),
  ];
  const { calls, loaders } = counterLoaders();
  const session = new SyncChangesSession({
    serverId: "s1", loaders, refreshChannel: () => undefined, notifyChannelMembers: () => undefined,
    fetch: async (_server, since) => { seen.push(since); return responses.shift()!; },
  });
  assert.equal(await session.start(), true);
  assert.equal(await session.pull(), "applied");
  await flush();
  assert.deepEqual(seen, [null, "c0", "c1"]);
  assert.equal(calls.agents, 1, "two agent changes over two pages: one reload");
  assert.equal(await session.pull(), "applied");
  assert.deepEqual(seen, [null, "c0", "c1", "c2"]);
});

test("reset takes exactly its snapshots and continues from its cursor", async () => {
  const seen: Array<string | null> = [];
  const responses = [
    page([], "c0"),
    page([], "c9", { reset: { reason: "too_old", snapshots: ["channels", "agents"] } }),
    page([], "c10"),
  ];
  const { calls, loaders } = counterLoaders();
  const session = new SyncChangesSession({
    serverId: "s1", loaders, refreshChannel: () => undefined, notifyChannelMembers: () => undefined,
    fetch: async (_server, since) => { seen.push(since); return responses.shift()!; },
  });
  await session.start();
  assert.equal(await session.pull(), "applied");
  await flush();
  assert.deepEqual(calls, { channels: 1, agents: 1 });
  await session.pull();
  assert.equal(seen.at(-1), "c9");
});

const timedOut = () => new AxiosError("timeout of 5000ms exceeded", "ECONNABORTED");
const httpError = (status: number, data: unknown = {}) =>
  new AxiosError(`Request failed with status code ${status}`, "ERR_BAD_RESPONSE", undefined, undefined, { status, data } as never);

/** A session over scripted answers (an Error is thrown); `seen`: each request's `since`. */
function scriptedSession(script: Array<SyncChangesResponse | Error>) {
  const seen: Array<string | null> = [];
  const dropped = { count: 0 };
  const { calls, loaders } = counterLoaders();
  const session = new SyncChangesSession({
    serverId: "s1", loaders, refreshChannel: () => undefined, notifyChannelMembers: () => undefined,
    onCursorDropped: () => { dropped.count += 1; },
    fetch: async (_server, since) => {
      seen.push(since);
      const next = script.shift();
      if (!next) throw new Error("no more responses");
      if (next instanceof Error) throw next;
      return next;
    },
  });
  return { session, seen, calls, dropped };
}

/** Let the delayed pull's promise chain run under fake timers. */
async function settleFake() {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

test("after a kept pull one delayed pull runs within 30–60 s; failing there drops once, then nothing loops", async () => {
  for (const random of [0, 0.99999]) {
    vi.useFakeTimers();
    const spy = vi.spyOn(Math, "random").mockReturnValue(random);
    try {
      const { session, seen, dropped } = scriptedSession([page([], "c0"), timedOut(), httpError(503)]);
      await session.start();
      assert.equal(await session.pull(), "kept");
      const delay = SYNC_PULL_RETRY_MIN_MS + Math.floor(random * SYNC_PULL_RETRY_SPREAD_MS);
      assert.ok(delay >= 30_000 && delay < 60_000, String(delay));
      vi.advanceTimersByTime(delay - 1);
      await settleFake();
      assert.deepEqual(seen, [null, "c0"], `not before ${delay} ms`);
      vi.advanceTimersByTime(1);
      await settleFake();
      assert.deepEqual(seen, [null, "c0", "c0"]);
      assert.equal(session.hasCursor, false);
      assert.equal(dropped.count, 1);
      vi.advanceTimersByTime(600_000);
      await settleFake();
      assert.deepEqual(seen, [null, "c0", "c0"], "no further pulls");
      assert.equal(dropped.count, 1);
    } finally {
      spy.mockRestore();
      vi.useRealTimers();
    }
  }
});

test("the delayed pull is cancelled by an earlier pull and by dispose", async () => {
  vi.useFakeTimers();
  try {
    const first = scriptedSession([page([], "c0"), timedOut(), page([], "c1")]);
    await first.session.start();
    assert.equal(await first.session.pull(), "kept");
    assert.equal(await first.session.pull(), "applied", "another trigger pulls first");
    vi.advanceTimersByTime(120_000);
    await settleFake();
    assert.deepEqual(first.seen, [null, "c0", "c0"]);

    const second = scriptedSession([page([], "c0"), timedOut()]);
    await second.session.start();
    assert.equal(await second.session.pull(), "kept");
    second.session.dispose();
    vi.advanceTimersByTime(120_000);
    await settleFake();
    assert.deepEqual(second.seen, [null, "c0"]);
    assert.equal(second.dropped.count, 0, "a disposed session reports nothing");
  } finally {
    vi.useRealTimers();
  }
});

test("a timed-out pull keeps its cursor; the second in a row on it drops it", async () => {
  const { session, seen, dropped } = scriptedSession([page([], "c0"), timedOut(), httpError(503)]);
  await session.start();
  assert.equal(await session.pull(), "kept");
  assert.equal(session.hasCursor, true);
  assert.equal(await session.pull(), "dropped");
  assert.equal(session.hasCursor, false);
  assert.deepEqual(seen, [null, "c0", "c0"], "the same cursor both times");
  assert.equal(dropped.count, 1, "the caller reloads in full once");
  assert.equal(await session.pull(), "dropped", "no cursor: nothing to pull");
});

test("a success between failures resets the count; a new cursor starts its own", async () => {
  const { session, seen } = scriptedSession([
    page([], "c0"), timedOut(), page([], "c1"), httpError(502), page([], "c2"), timedOut(), timedOut(),
  ]);
  await session.start();
  assert.equal(await session.pull(), "kept");
  assert.equal(await session.pull(), "applied");
  assert.equal(await session.pull(), "kept", "one failure since the success");
  assert.equal(await session.pull(), "applied");
  assert.equal(await session.pull(), "kept");
  assert.equal(await session.pull(), "dropped");
  assert.deepEqual(seen, [null, "c0", "c0", "c1", "c1", "c2", "c2"]);
});

test("invalid_cursor (and other 4xx, or a malformed answer) drops the cursor at once", async () => {
  for (const failure of [
    httpError(400, { error: "since must be a cursor this endpoint returned", code: "invalid_cursor" }),
    httpError(403),
    new Error("sync/changes: no cursor"),
  ]) {
    const { session } = scriptedSession([page([], "c0"), failure]);
    await session.start();
    assert.equal(await session.pull(), "dropped", failure.message);
    assert.equal(session.hasCursor, false);
  }
});

test("a failure on a later page keeps the cursor the pull started from (no page is skipped)", async () => {
  const { session, seen, calls } = scriptedSession([
    page([], "c0"),
    page([{ seq: 1, entity: "agent", id: "a", op: "upsert", row: {} }], "c1", { hasMore: true }),
    timedOut(),
    page([{ seq: 1, entity: "agent", id: "a", op: "upsert", row: {} }], "c1", { hasMore: true }),
    page([], "c2"),
  ]);
  await session.start();
  assert.equal(await session.pull(), "kept");
  await flush();
  assert.equal(calls.agents, undefined, "nothing applied from the failed pull");
  assert.equal(await session.pull(), "applied");
  await flush();
  assert.deepEqual(seen, [null, "c0", "c1", "c0", "c1"]);
  assert.equal(calls.agents, 1);
});

test("a reload waits for one in flight and runs again when a change lands meanwhile", async () => {
  // Tenny's race: a list read sent before change C must not be the last one applied.
  const order: string[] = [];
  let releaseInFlight!: () => void;
  const inFlight = new Promise<void>((resolve) => { releaseInFlight = resolve; });
  let releaseFirst!: () => void;
  let loads = 0;
  const { loaders } = counterLoaders({
    agents: {
      settleInFlight: async () => { order.push("settle"); await inFlight; },
      load: () => {
        loads += 1;
        order.push(`load${loads}`);
        if (loads === 1) return new Promise<void>((resolve) => { releaseFirst = resolve; });
      },
    },
  });
  const responses = [
    page([], "c0"),
    page([{ seq: 1, entity: "agent", id: "a", op: "upsert", row: {} }], "c1"),
    page([{ seq: 2, entity: "agent", id: "a", op: "upsert", row: {} }], "c2"),
  ];
  const session = new SyncChangesSession({
    serverId: "s1", loaders, refreshChannel: () => undefined, notifyChannelMembers: () => undefined,
    fetch: async () => responses.shift()!,
  });
  await session.start();
  await session.pull();
  await flush();
  assert.deepEqual(order, ["settle"], "does not join the request already in flight");
  releaseInFlight();
  await flush();
  assert.deepEqual(order, ["settle", "load1"]);
  await session.pull(); // change C arrives while load1 runs
  await flush();
  assert.equal(loads, 1, "no parallel read");
  releaseFirst();
  await flush();
  await flush();
  assert.deepEqual(order, ["settle", "load1", "settle", "load2"], "read again after it, starting after C");
});

test("channel upserts re-read rows; member changes notify that channel", async () => {
  const refreshed: string[] = [];
  const notified: string[] = [];
  const { loaders } = counterLoaders();
  const responses = [
    page([], "c0"),
    page([
      { seq: 1, entity: "channel", id: "ch1", op: "upsert", row: {} },
      { seq: 2, entity: "channel_member", id: "ch2:agent:a", op: "upsert", row: {} },
    ], "c1"),
  ];
  const session = new SyncChangesSession({
    serverId: "s1", loaders,
    refreshChannel: (id) => { refreshed.push(id); },
    notifyChannelMembers: (id) => { notified.push(id); },
    fetch: async () => responses.shift()!,
  });
  await session.start();
  await session.pull();
  assert.deepEqual(refreshed.sort(), ["ch1", "ch2"]);
  assert.deepEqual(notified, ["ch2"]);
});

test("a snapshot name this client doesn't know takes every snapshot (no crash)", async () => {
  const { calls, loaders } = counterLoaders();
  const responses = [
    page([], "c0"),
    page([], "c1", { reset: { reason: "forced", snapshots: ["future_list" as SyncSnapshotName] } }),
  ];
  const session = new SyncChangesSession({
    serverId: "s1", loaders, refreshChannel: () => undefined, notifyChannelMembers: () => undefined,
    fetch: async () => responses.shift()!,
  });
  await session.start();
  assert.equal(await session.pull(), "applied");
  await flush();
  for (const name of SNAPSHOTS) assert.equal(calls[name], 1, name);
});

test("after dispose nothing more is read", async () => {
  const { calls, loaders } = counterLoaders();
  const session = new SyncChangesSession({
    serverId: "s1", loaders, refreshChannel: () => undefined, notifyChannelMembers: () => undefined,
    fetch: async () => page([], "c0"),
  });
  await session.start();
  session.dispose();
  session.resnapshotAll("initial");
  assert.equal(await session.pull(), "dropped");
  await flush();
  assert.deepEqual(calls, {});
});

test("a reset's snapshots go through deferReset (spread by the bridge)", async () => {
  const { calls, loaders } = counterLoaders();
  const deferred: Array<() => void> = [];
  const deferredNames: string[][] = [];
  const responses = [
    page([], "c0"),
    page([], "c1", { reset: { reason: "forced", snapshots: ["agents"] } }),
  ];
  const session = new SyncChangesSession({
    serverId: "s1", loaders, refreshChannel: () => undefined, notifyChannelMembers: () => undefined,
    deferReset: (run, snapshots) => { deferred.push(run); deferredNames.push([...snapshots]); },
    fetch: async () => responses.shift()!,
  });
  await session.start();
  assert.equal(await session.pull(), "applied");
  await flush();
  assert.deepEqual(calls, {}, "nothing read until the deferred run");
  assert.deepEqual(deferredNames, [["agents"]], "the bridge learns which lists the reset reads");
  deferred[0]();
  await flush();
  assert.deepEqual(calls, { agents: 1 });
});

test("a conversation change with its current state is patched, not reloaded; malformed or empty state reloads", () => {
  const plan = planSyncChanges([
    { seq: 1, entity: "conversation", id: "c1", op: "stale", refSeq: 4, read: { readSeq: 4, readStateVersion: 7 } },
    { seq: 2, entity: "conversation", id: "c2", op: "stale", refSeq: null, done: { done: true, doneFrontierSeq: "12" }, follow: { followed: false, threadDone: false } },
  ] as unknown as SyncChange[]);
  assert.equal(plan.snapshots.size, 0);
  assert.deepEqual(plan.conversations.get("c1"), { read: { readSeq: 4, readStateVersion: 7 } });
  assert.deepEqual(plan.conversations.get("c2"), {
    done: { done: true, doneFrontierSeq: "12" },
    follow: { followed: false, threadDone: false },
  });
  for (const change of [
    { seq: 3, entity: "conversation", id: "c3", op: "stale", refSeq: 1 },
    { seq: 4, entity: "conversation", id: "c4", op: "stale", refSeq: 1, read: { readSeq: "1", readStateVersion: 2 } },
    { seq: 5, entity: "conversation", id: "c5", op: "stale", refSeq: null, read: { readSeq: 1, readStateVersion: 2 }, done: { done: "yes" } },
    { seq: 6, entity: "conversation", id: "c6", op: "replace", refSeq: null, read: { readSeq: 1, readStateVersion: 2 } },
  ]) {
    const reload = planSyncChanges([change] as unknown as SyncChange[]);
    assert.deepEqual([...reload.snapshots].sort(), ["followed_threads", "inbox", "unread"], `change ${change.id} reloads`);
    assert.equal(reload.conversations.size, 0);
  }
});

test("patched conversations skip the reloads; one the client can't patch reloads the three lists", async () => {
  const run = async (patchable: (id: string) => boolean) => {
    const applied: string[] = [];
    const { calls, loaders } = counterLoaders();
    const responses = [page([], "c0"), page([
      { seq: 1, entity: "conversation", id: "a", op: "stale", refSeq: 3, read: { readSeq: 3, readStateVersion: 1 } },
      { seq: 2, entity: "conversation", id: "b", op: "stale", refSeq: null, done: { done: true, doneFrontierSeq: "9" } },
    ], "c1")];
    const session = new SyncChangesSession({
      serverId: "s1", loaders, refreshChannel: () => undefined, notifyChannelMembers: () => undefined,
      applyConversation: (id) => { applied.push(id); return patchable(id); },
      fetch: async () => responses.shift()!,
    });
    await session.start();
    await session.pull();
    await flush();
    return { applied, calls };
  };
  const patched = await run(() => true);
  assert.deepEqual(patched.applied, ["a", "b"]);
  assert.deepEqual(patched.calls, {});
  const fallback = await run((id) => id !== "a");
  assert.deepEqual(fallback.applied, ["a"], "once the lists are read again, the rest come with them");
  assert.deepEqual(fallback.calls, { inbox: 1, unread: 1, followed_threads: 1 });
});

test("without applyConversation (or with a reset) conversation state still reloads", async () => {
  const { calls, loaders } = counterLoaders();
  const responses = [page([], "c0"), page([
    { seq: 1, entity: "conversation", id: "a", op: "stale", refSeq: 3, read: { readSeq: 3, readStateVersion: 1 } },
  ], "c1")];
  const session = new SyncChangesSession({
    serverId: "s1", loaders, refreshChannel: () => undefined, notifyChannelMembers: () => undefined,
    fetch: async () => responses.shift()!,
  });
  await session.start();
  await session.pull();
  await flush();
  assert.deepEqual(calls, { inbox: 1, unread: 1, followed_threads: 1 });
});

test("parts of one conversation from two pages merge per kind", () => {
  const plan = planSyncChanges([
    { seq: 1, entity: "conversation", id: "c", op: "stale", refSeq: 4, read: { readSeq: 4, readStateVersion: 2 } },
  ] as unknown as SyncChange[]);
  planSyncChanges([
    { seq: 2, entity: "conversation", id: "c", op: "stale", refSeq: 4, done: { done: true, doneFrontierSeq: "4" } },
    { seq: 3, entity: "conversation", id: "c", op: "stale", refSeq: 6, read: { readSeq: 6, readStateVersion: 3 } },
  ] as unknown as SyncChange[], plan);
  assert.deepEqual(plan.conversations.get("c"), {
    read: { readSeq: 6, readStateVersion: 3 },
    done: { done: true, doneFrontierSeq: "4" },
  });
});

test("each list read says why: legacy change, unpatchable change, reset", async () => {
  const run = async (changes: unknown[], extra: Partial<SyncChangesResponse> = {}, patch = false) => {
    const reasons: Record<string, unknown> = {};
    const { loaders } = counterLoaders(Object.fromEntries(
      (["inbox", "followed_threads"] as const).map((name) => [name, { load: (reason?: string) => { reasons[name] = reason; } }]),
    ) as Partial<SyncSnapshotLoaders>);
    const responses = [page([], "c0"), page(changes, "c1", extra)];
    const session = new SyncChangesSession({
      serverId: "s1", loaders, refreshChannel: () => undefined, notifyChannelMembers: () => undefined,
      applyConversation: () => patch,
      fetch: async () => responses.shift()!,
    });
    await session.start();
    await session.pull();
    await flush();
    return reasons;
  };
  assert.deepEqual(await run([{ seq: 1, entity: "conversation", id: "a", op: "stale", refSeq: 1 }]),
    { inbox: "legacy_no_fields", followed_threads: "legacy_no_fields" });
  assert.deepEqual(await run([{ seq: 1, entity: "conversation", id: "a", op: "stale", refSeq: 1, follow: { followed: true, threadDone: false } }]),
    { inbox: "sync_unpatchable", followed_threads: "sync_unpatchable" });
  assert.deepEqual(await run([], { reset: { snapshots: ["inbox", "followed_threads"] } as never }),
    { inbox: "sync_reset", followed_threads: "sync_reset" });
});

test("message upserts (RFC 082 §4.4) carry the row to replace by id, newest per id; nothing else reloads", () => {
  const plan = planSyncChanges([
    { seq: 1, entity: "message", id: "m1", op: "upsert", row: { id: "m1", channelId: "ch1", content: "r2" } },
    { seq: 2, entity: "message", id: "m2", op: "upsert", row: { id: "other", channelId: "ch1", content: "not m2" } },
    { seq: 3, entity: "message", id: "m3", op: "delete" },
    { seq: 4, entity: "message", id: "m1", op: "upsert", row: { id: "m1", channelId: "ch1", content: "r3" } },
  ] as unknown as SyncChange[]);
  assert.deepEqual([...plan.messages.keys()], ["m1"], "a row that is not its message's, and a non-upsert, are dropped");
  assert.equal(plan.messages.get("m1")?.content, "r3");
  assert.equal(plan.snapshots.size, 0);
  assert.equal(plan.channelIds.size, 0);
});

test("a pull hands each changed message to applyMessage once, after the page is read", async () => {
  const applied: string[] = [];
  const responses = [
    page([], "c0"),
    page([
      { seq: 1, entity: "message", id: "m1", op: "upsert", row: { id: "m1", channelId: "ch1", content: "r2" } },
      { seq: 2, entity: "message", id: "m1", op: "upsert", row: { id: "m1", channelId: "ch1", content: "r3" } },
    ], "c1"),
  ];
  const { loaders } = counterLoaders();
  const session = new SyncChangesSession({
    serverId: "s1", loaders, refreshChannel: () => undefined, notifyChannelMembers: () => undefined,
    applyMessage: (row) => { applied.push(`${row.id}:${row.content}`); },
    fetch: async () => responses.shift()!,
  });
  assert.equal(await session.start(), true);
  assert.equal(await session.pull(), "applied");
  assert.deepEqual(applied, ["m1:r3"]);
});
