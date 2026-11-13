// Closed-server purge, `count` mode (closedServerPurge.ts): which servers it
// counts, what it counts and skips, that it never writes, and when it runs.
import assert from "node:assert/strict";
import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import { BasicTracer, MemoryTraceSink, type ServerId } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import {
  agentMigrationReceiptChannels,
  attachmentObjects,
  attachments,
  channels,
  featureFlags,
  jointChannelServers,
  messages,
  objectEvents,
  servers,
  tasks,
} from "../db/schema";
import type { FirstPartyApp } from "../platform/apps";
import { seedServer } from "../test/closedServerPurgeFixture";
import { dbTest as test } from "../test/integration/dbTest";
import { setDefaultTraceTracer } from "../tracing/semanticTrace";
import {
  CLOSED_SERVER_PURGE_FEATURE_FLAG_KEY,
  CLOSED_SERVER_PURGE_RUN_EVENT,
  CLOSED_SERVER_PURGE_SERVER_EVENT,
  closedServerPurgeModeOf,
  closedServerPurgeQuietTime,
  memoryClosedServerPurgeState,
  runClosedServerPurge,
  type ClosedServerPurgeState,
} from "./closedServerPurge";
import { createFeatureFlag } from "./featureFlagService";

const DAY_MS = 24 * 3_600_000;
// 12:30Z: outside every quiet time.
const NOW = new Date("2026-11-09T12:30:00Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY_MS);

async function flagOn(variant: string | null = null, overrides: Partial<typeof featureFlags.$inferInsert> = {}) {
  await createFeatureFlag({ key: CLOSED_SERVER_PURGE_FEATURE_FLAG_KEY, randomizationUnit: "server", defaultEnabled: true, defaultVariant: variant });
  if (Object.keys(overrides).length > 0) {
    await getDb().update(featureFlags).set(overrides).where(eq(featureFlags.key, CLOSED_SERVER_PURGE_FEATURE_FLAG_KEY));
  }
}

const close = (serverId: string, at: Date) => getDb().update(servers).set({ deletedAt: at }).where(eq(servers.id, serverId));

/** What the count should say for the server's channels and messages, read straight from the tables. */
async function expectedConversations(serverId: string, skipped: string[]) {
  const db = getDb();
  const kept = await db.select({ id: channels.id }).from(channels).where(and(eq(channels.serverId, serverId), notInArray(channels.id, skipped)));
  const ids = kept.map((row) => row.id);
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(messages).where(inArray(messages.channelId, ids));
  return { channels: ids.length, messages: Number(row!.n) };
}

/** Row counts the run must leave as they were. */
async function snapshot() {
  const db = getDb();
  const n = async (table: typeof messages | typeof channels | typeof attachments | typeof attachmentObjects | typeof tasks | typeof objectEvents | typeof jointChannelServers | typeof agentMigrationReceiptChannels) =>
    Number((await db.select({ n: sql<number>`count(*)::int` }).from(table))[0]!.n);
  return {
    messages: await n(messages),
    channels: await n(channels),
    attachments: await n(attachments),
    attachmentObjects: await n(attachmentObjects),
    tasks: await n(tasks),
    objectEvents: await n(objectEvents),
    joint: await n(jointChannelServers),
    receipts: await n(agentMigrationReceiptChannels),
    servers: await db.select({ id: servers.id, name: servers.name, deletedAt: servers.deletedAt, avatarUrl: servers.avatarUrl }).from(servers).orderBy(servers.id),
  };
}

function withTracer<T>(work: (sink: MemoryTraceSink) => Promise<T>): Promise<T> {
  const sink = new MemoryTraceSink();
  setDefaultTraceTracer(new BasicTracer({ sink }));
  return work(sink).finally(() => setDefaultTraceTracer(null));
}

const eventsNamed = (sink: MemoryTraceSink, name: string) => sink.getAllLogEvents().filter((event) => event.name === name);

/** An app whose count says one thing, and one whose count tries to write (the transaction is read only). */
const countingApp = { id: "fake-app", purgeServer: async () => ({ remaining: true, counts: { fooBar: 7 } }) } as unknown as FirstPartyApp;
const writingApp = {
  id: "writer",
  purgeServer: async (_serverId: ServerId, options: { executor: { execute: (q: unknown) => Promise<unknown> } }) => {
    await options.executor.execute(sql`UPDATE servers SET name = name WHERE false`);
    return { remaining: false, counts: {} };
  },
} as unknown as FirstPartyApp;

test("counts a server closed 31 days ago, table by table, skipping joint projections and receipt channels; not one closed 29 days ago, nor a live one", async ({ seed }) => {
  await flagOn();
  const old = await seedServer(seed);
  const recent = await seedServer(seed);
  const live = await seedServer(seed);
  await close(old.server.id, daysAgo(31));
  await close(recent.server.id, daysAgo(29));
  const expected = await expectedConversations(old.server.id, [...old.skipped.joint, ...old.skipped.receipt]);
  const before = await snapshot();

  const { result, sink } = await withTracer(async (sink) => ({
    result: await runClosedServerPurge({ now: () => NOW, state: memoryClosedServerPurgeState(() => NOW), apps: [countingApp, writingApp] }),
    sink,
  }));

  assert.equal(result.mode, "on");
  assert.equal(result.stoppedReason, "pass_done");
  const ids = result.counted.map((entry) => entry.serverId);
  assert.ok(ids.includes(old.serverId), "closed 31 days ago: counted");
  assert.ok(!ids.includes(recent.serverId), "closed 29 days ago: not yet");
  assert.ok(!ids.includes(live.serverId), "live: never");
  assert.ok(!ids.includes(old.storage.id as ServerId), "a live storage server: never");

  const counts = result.counted.find((entry) => entry.serverId === old.serverId)!;
  assert.equal(counts.complete, true);
  assert.ok(expected.messages >= 3, "the channel's 3 messages are among them");
  assert.deepEqual({
    channels: counts.counts.channels,
    channels_skipped_joint: counts.counts.channels_skipped_joint,
    channels_skipped_receipt: counts.counts.channels_skipped_receipt,
    messages: counts.counts.messages,
    attachments: counts.counts.attachments,
    attachment_objects: counts.counts.attachment_objects,
    attachment_bytes: counts.counts.attachment_bytes,
    tasks: counts.counts.tasks,
    object_events: counts.counts.object_events,
    app_fake_app_foo_bar: counts.counts["app_fake_app_foo_bar"],
    apps_failed: counts.counts.apps_failed,
  }, {
    channels: expected.channels,
    channels_skipped_joint: 2,
    channels_skipped_receipt: 1,
    messages: expected.messages,
    attachments: 3,
    attachment_objects: 2,
    attachment_bytes: 123,
    tasks: 2,
    object_events: 3,
    // App keys go snake_case under the app's id.
    app_fake_app_foo_bar: 7,
    // The app that tried to write was refused by the READ ONLY transaction.
    apps_failed: 1,
  });

  const serverEvents = eventsNamed(sink, CLOSED_SERVER_PURGE_SERVER_EVENT).filter((event) => event.attrs?.server_id === old.serverId);
  assert.equal(serverEvents.length, 1);
  assert.equal(serverEvents[0]!.attrs?.messages, expected.messages);
  assert.equal(serverEvents[0]!.attrs?.complete, true);
  const runEvents = eventsNamed(sink, CLOSED_SERVER_PURGE_RUN_EVENT);
  assert.equal(runEvents.length, 1);
  assert.equal(runEvents[0]!.attrs?.stopped_reason, "pass_done");
  assert.equal(runEvents[0]!.attrs?.old_bucket_delete_capability, "unknown");
  assert.equal(runEvents[0]!.attrs?.servers_counted, result.serversCounted);

  assert.deepEqual(await snapshot(), before, "nothing deleted or changed");
});

test("mode off: no flag, a disabled flag or its kill switch does nothing, not even the claim", async ({ seed }) => {
  const old = await seedServer(seed);
  await close(old.server.id, daysAgo(40));
  let touched = 0;
  const state: ClosedServerPurgeState = {
    claimRun: async () => { touched += 1; return true; },
    passResting: async () => { touched += 1; return false; },
    markPassDone: async () => { touched += 1; },
    getCursor: async () => { touched += 1; return null; },
    setCursor: async () => { touched += 1; },
  };
  const run = () => withTracer(async (sink) => ({ result: await runClosedServerPurge({ now: () => NOW, state, apps: [] }), sink }));

  for (const setup of [
    async () => {},
    async () => flagOn(null, { enabled: false }),
    async () => getDb().update(featureFlags).set({ enabled: true, killSwitch: true }).where(eq(featureFlags.key, CLOSED_SERVER_PURGE_FEATURE_FLAG_KEY)),
  ]) {
    await setup();
    const { result, sink } = await run();
    assert.equal(result.mode, "off");
    assert.equal(result.stoppedReason, "flag_off");
    assert.equal(result.counted.length, 0);
    assert.equal(sink.getAllLogEvents().length, 0, "no events while off");
  }
  assert.equal(touched, 0);
});

test("the flag's variant: none or count counts, only delete from a server rule deletes, delete from anywhere else counts, anything else is off", async ({ seed }) => {
  assert.equal(closedServerPurgeModeOf({ enabled: true }), "count");
  assert.equal(closedServerPurgeModeOf({ enabled: true, variant: "count" }), "count");
  assert.equal(closedServerPurgeModeOf({ enabled: true, variant: "delete", reason: "server_rule" }), "delete");
  for (const reason of [undefined, "default", "percentage_rule", "audience_rule", "plan_rule", "lab_rule", "user_rule"]) {
    assert.equal(closedServerPurgeModeOf({ enabled: true, variant: "delete", reason }), "count", `delete from ${reason}: counted`);
  }
  assert.equal(closedServerPurgeModeOf({ enabled: true, variant: "Delete", reason: "server_rule" }), "off");
  assert.equal(closedServerPurgeModeOf({ enabled: true, variant: "Count" }), "off");
  assert.equal(closedServerPurgeModeOf({ enabled: false, variant: "delete", reason: "server_rule" }), "off");
  assert.equal(closedServerPurgeModeOf({ enabled: false, variant: "count" }), "off");

  // What `delete` does is closedServerPurgeDelete.db.test.ts; here only that `delete` as the default is counted, not purged.
  await flagOn("delete");
  const old = await seedServer(seed);
  await close(old.server.id, daysAgo(40));
  const result = await runClosedServerPurge({ now: () => NOW, state: memoryClosedServerPurgeState(() => NOW), apps: [] });
  assert.equal(result.purged.length, 0, "nothing claimed");
  assert.ok(result.counted.some((counted) => counted.serverId === old.serverId), "counted instead");
});

test("quiet times: 06-10Z, 20-24Z and :00-:05 every hour skip the run before anything is read", async ({ seed }) => {
  const at = (iso: string) => closedServerPurgeQuietTime(new Date(iso));
  assert.equal(at("2026-11-09T05:59:00Z"), null);
  assert.equal(at("2026-11-09T06:30:00Z"), "rw_peak");
  assert.equal(at("2026-11-09T09:59:00Z"), "rw_peak");
  assert.equal(at("2026-11-09T10:05:00Z"), null);
  assert.equal(at("2026-11-09T13:04:59Z"), "hourly_stall");
  assert.equal(at("2026-11-09T19:59:00Z"), null);
  assert.equal(at("2026-11-09T20:00:00Z"), "release_window");
  assert.equal(at("2026-11-09T23:59:00Z"), "release_window");

  await flagOn();
  const old = await seedServer(seed);
  await close(old.server.id, daysAgo(40));
  let claims = 0;
  const memory = memoryClosedServerPurgeState(() => NOW);
  const state: ClosedServerPurgeState = { ...memory, claimRun: async () => { claims += 1; return memory.claimRun(); } };
  for (const iso of ["2026-11-09T07:30:00Z", "2026-11-09T21:10:00Z", "2026-11-09T14:02:00Z"]) {
    const result = await runClosedServerPurge({ now: () => new Date(iso), state, apps: [] });
    assert.equal(result.stoppedReason, "quiet_time", iso);
    assert.equal(result.counted.length, 0, iso);
  }
  assert.equal(claims, 0, "a quiet time does not use up the hour's claim");
});

test("where a replica is required (production) and there is none, the run stops before the claim and reads nothing; with one, it counts on it", async ({ seed }) => {
  await flagOn();
  const old = await seedServer(seed);
  await close(old.server.id, daysAgo(40));
  let claims = 0;
  const memory = memoryClosedServerPurgeState(() => NOW);
  const state: ClosedServerPurgeState = { ...memory, claimRun: async () => { claims += 1; return memory.claimRun(); } };

  // getSearchDb() is the primary here (no DATABASE_URL_READ_REPLICA): the silent fallback this guards against.
  const stopped = await withTracer(async (sink) => ({ result: await runClosedServerPurge({ now: () => NOW, state, apps: [], replicaRequired: true }), sink }));
  assert.equal(stopped.result.stoppedReason, "replica_unavailable");
  assert.equal(stopped.result.serversSeen, 0);
  assert.equal(stopped.result.counted.length, 0);
  assert.equal(claims, 0, "no claim: the hour is not used up");
  const finished = eventsNamed(stopped.sink, CLOSED_SERVER_PURGE_RUN_EVENT);
  assert.equal(finished.length, 1);
  assert.equal(finished[0]!.attrs?.stopped_reason, "replica_unavailable");
  assert.equal(finished[0]!.attrs?.db_path, "primary");

  // A separate reader (the replica) given: the same run counts on it.
  const counted = await runClosedServerPurge({ now: () => NOW, state, apps: [], replicaRequired: true, reader: getDb() });
  assert.notEqual(counted.stoppedReason, "replica_unavailable");
  assert.ok(counted.counted.some((entry) => entry.serverId === old.serverId), "counted on the given reader");
  assert.equal(claims, 1);
});

test("a flag turned off mid-pass ends the run at the next page: nothing is skipped as off, the cursor stays and the pass is not marked done", async ({ seed }) => {
  await flagOn();
  const old = await seedServer(seed);
  await close(old.server.id, daysAgo(40));
  let marked = 0;
  let cursorWrites = 0;
  const memory = memoryClosedServerPurgeState(() => NOW);
  const state: ClosedServerPurgeState = {
    ...memory,
    // The kill switch lands after the claim, just before the count pass reads its first page.
    passResting: async () => {
      await getDb().update(featureFlags).set({ killSwitch: true }).where(eq(featureFlags.key, CLOSED_SERVER_PURGE_FEATURE_FLAG_KEY));
      return memory.passResting();
    },
    markPassDone: async () => { marked += 1; return memory.markPassDone(); },
    setCursor: async (serverId) => { cursorWrites += 1; return memory.setCursor(serverId); },
  };
  const result = await runClosedServerPurge({ now: () => NOW, state, apps: [] });
  assert.equal(result.stoppedReason, "flag_off");
  assert.equal(result.counted.length, 0);
  assert.equal(result.serversSeen, 0, "no server seen, none skipped as off");
  assert.equal(marked, 0, "the pass is not done");
  assert.equal(cursorWrites, 0, "the cursor did not move");
});

test("one run per claim; a finished pass rests; a run out of budget resumes where it stopped", async ({ seed }) => {
  await flagOn();
  const a = await seedServer(seed);
  const b = await seedServer(seed);
  await close(a.server.id, daysAgo(40));
  await close(b.server.id, daysAgo(40));

  // No budget: the first server is counted as far as it gets (it alone outlasts the run), then the run stops.
  let clock = NOW.getTime();
  const state = memoryClosedServerPurgeState(() => new Date(clock));
  const first = await runClosedServerPurge({ now: () => new Date(clock), state, apps: [], budgetMs: 0 });
  assert.equal(first.stoppedReason, "budget");
  assert.equal(first.counted.length, 1);
  assert.equal(first.counted[0]!.complete, false);

  // Within the claim's hour: another run does nothing.
  const again = await runClosedServerPurge({ now: () => new Date(clock), state, apps: [] });
  assert.equal(again.stoppedReason, "claimed_elsewhere");

  // An hour later: resumes after that server and finishes the pass.
  clock += 3_600_000;
  const second = await runClosedServerPurge({ now: () => new Date(clock), state, apps: [] });
  assert.equal(second.stoppedReason, "pass_done");
  assert.ok(!second.counted.some((entry) => entry.serverId === first.counted[0]!.serverId), "not counted twice in a pass");
  const all = [...first.counted, ...second.counted].map((entry) => entry.serverId);
  assert.ok(all.includes(a.serverId) && all.includes(b.serverId));

  // The next hour: the pass rests.
  clock += 3_600_000;
  const rest = await runClosedServerPurge({ now: () => new Date(clock), state, apps: [] });
  assert.equal(rest.stoppedReason, "pass_resting");
});
