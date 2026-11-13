import { dbTest as test } from "../../test/integration/dbTest";
import { closeTestDatabase } from "../../test/integration/database";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";

import { getDb } from "../../db/index";
import {
  agents,
  channelAgents,
  channels,
  jointChannelServers,
  jointChannels,
  messages,
  oauthAgentAutoGrantBlocks,
  oauthClientInstalls,
  oauthClientKeyAliases,
  oauthClients,
  oauthGrants,
  officialAppRegistry,
  integrationAuditEvents,
  reminderAppMigrations,
  reminders,
  servers,
  users,
} from "../../db/schema";
import { createMessage } from "../../services/messageService";
import { getJointThreadProjectionByLocalThread } from "../../services/channelService";
import { createReminder, getReminderById, recordReminderArmed, type TimeProvider } from "./service";
import { startReminderAppMigrationWorker } from "../../services/reminderAppMigrationWorker";
import {
  findActiveReminderAppInstall,
  listDueReminderAppInstalls,
  planReminderAppMigrationReport,
  readReminderAppMigrationConfig,
  reminderAppMigratedForServer,
  runReminderAppMigration,
  type ReminderAppImportFn,
  type ReminderAppImportItem,
  type ReminderAppInstall,
  type ReminderAppMigrationConfig,
} from "./appMigration";

afterEach(async () => {
  await closeTestDatabase();
});

const NOW = new Date("2026-10-20T09:00:00.000Z");
const CLOCK: TimeProvider = { now: () => NOW };
const CONFIG: ReminderAppMigrationConfig = {
  clientId: "reminder-test",
  importUrl: "https://reminder.example/api/platform/legacy-reminders/import",
  token: "t".repeat(40),
  mode: "live",
  liveBlockedReason: null,
  servers: "*",
};
const DAILY = { version: 1, rule: { kind: "daily", hour: 9, minute: 0, tz: "UTC" } };

async function seed() {
  const db = getDb();
  const [owner] = await db.insert(users).values({ email: "owner@example.com", name: "owner", passwordHash: "hash", emailVerified: true }).returning();
  const [server] = await db.insert(servers).values({ name: "Acme", slug: "acme", ownerId: owner.id }).returning();
  const mkAgent = async (name: string, extra: Partial<typeof agents.$inferInsert> = {}) => (await db.insert(agents).values({
    serverId: server.id, name, status: "active", model: "sonnet", runtime: "claude", executionMode: "byoc", ...extra,
  }).returning())[0];
  const alice = await mkAgent("alice", { displayName: "Alice" });
  const bob = await mkAgent("bob");
  const gone = await mkAgent("gone", { deletedAt: new Date("2026-10-01T00:00:00.000Z") });
  const [ops] = await db.insert(channels).values({ serverId: server.id, name: "ops" }).returning();
  await db.insert(channelAgents).values([{ channelId: ops.id, agentId: alice.id }, { channelId: ops.id, agentId: bob.id }]);
  const anchor = await createMessage(ops.id, "agent", alice.id, "anchor");
  const [client] = await db.insert(oauthClients).values({
    serverId: server.id, clientId: CONFIG.clientId, clientSecretHash: "h", name: "Reminder", createdByUserId: owner.id,
    appType: "third_party_global",
  }).returning();
  const [install] = await db.insert(oauthClientInstalls).values({
    serverId: server.id, clientId: client.id, installedByUserId: owner.id, approvedScopes: ["agent:notification:write"],
  }).returning();
  const appInstall: ReminderAppInstall = {
    installId: install.id, serverId: server.id, clientUuid: client.id, clientCreatedByUserId: owner.id,
    approvedScopes: ["agent:notification:write"],
  };
  const mk = (ownerAgentId: string, title: string, fireAt: Date, extra: { recurrence?: unknown; payload?: unknown; msgId?: string | null } = {}) =>
    createReminder({
      serverId: server.id, ownerAgentId, msgId: extra.msgId ?? null, title, fireAt,
      payload: extra.payload ?? null, recurrence: extra.recurrence as never,
      createdBy: { type: "agent", id: ownerAgentId },
    }, { clock: { now: () => new Date("2026-09-01T00:00:00.000Z") } });
  return { db, server, owner, alice, bob, gone, ops, anchor, client, appInstall, mk };
}

function fakeImport(statusFor: (item: ReminderAppImportItem) => "imported" | "duplicate" | "conflict" | "rejected" = () => "imported") {
  const calls: Array<{ serverId: string; serverSlug: string; items: ReminderAppImportItem[] }> = [];
  const fn: ReminderAppImportFn = async ({ body }) => {
    calls.push(body);
    return {
      kind: "ok",
      items: body.items.map((item) => {
        const status = statusFor(item);
        return { legacyId: item.legacyId, status, reminderId: `app-${item.legacyId.slice(0, 4)}`, ...(status === "rejected" ? { code: "title_invalid" } : {}) };
      }),
    };
  };
  return { fn, calls };
}

test("a live run grants first, imports recurring + late one-time reminders, marks them migrated, and completes", async ({ db: _db }) => {
  const s = await seed();
  const recurring = await s.mk(s.alice.id, "weekly report", new Date("2026-10-21T09:00:00.000Z"), { recurrence: DAILY, msgId: s.anchor.id });
  const overdueRecurring = await s.mk(s.bob.id, "stale daily", new Date("2026-09-15T09:00:00.000Z"), { recurrence: DAILY });
  const late = await s.mk(s.alice.id, "check the deploy", new Date("2026-10-10T09:00:00.000Z"));
  assert.ok(await recordReminderArmed(late.id, s.alice.id, late.version, { clock: CLOCK }));
  const notLate = await s.mk(s.alice.id, "unarmed one-time", new Date("2026-10-10T09:00:00.000Z"));
  const internal = await s.mk(s.alice.id, "D2 recap", new Date("2026-10-21T09:00:00.000Z"), { recurrence: DAILY, payload: { kind: "onboarding_d2_recap" } });
  const ofDeleted = await s.mk(s.gone.id, "orphan", new Date("2026-10-21T09:00:00.000Z"), { recurrence: DAILY });

  // The dry run reports the same plan and writes nothing.
  const report = await planReminderAppMigrationReport(s.appInstall, { clock: CLOCK });
  assert.deepEqual(
    { candidates: report.counts.candidates, toImport: report.counts.to_import, grants: report.counts.grants_to_create, voided: report.counts.voided_owner_deleted, late: report.counts.one_time_late },
    { candidates: 4, toImport: 3, grants: 2, voided: 1, late: 1 },
  );
  assert.equal((await s.db.select().from(oauthGrants)).length, 0, "dry run creates no grant");
  assert.equal((await s.db.select().from(reminderAppMigrations)).length, 0, "dry run records no run");

  const grantsAtImport: number[] = [];
  const imp = fakeImport();
  const outcome = await runReminderAppMigration(s.appInstall, {
    config: CONFIG, clock: CLOCK,
    importFn: async (input) => {
      grantsAtImport.push((await s.db.select().from(oauthGrants)).length);
      return imp.fn(input);
    },
  });
  assert.equal(outcome?.state, "completed", JSON.stringify(outcome));
  assert.deepEqual(grantsAtImport, [2], "both owners' grants exist before the first import call");

  const grants = await s.db.select().from(oauthGrants);
  assert.deepEqual(grants.map((g) => [g.agentId, g.grantSource, g.scopes]).sort(), [
    [s.alice.id, "legacy_import", ["agent:notification:write"]],
    [s.bob.id, "legacy_import", ["agent:notification:write"]],
  ].sort());

  const items = imp.calls[0].items;
  assert.equal(imp.calls[0].serverSlug, "acme");
  assert.deepEqual(items.map((i) => [i.legacyId, i.kind]).sort(), [
    [recurring.id, "recurring"], [overdueRecurring.id, "recurring"], [late.id, "oneTimeLate"],
  ].sort());
  const recurringItem = items.find((i) => i.legacyId === recurring.id)!;
  assert.deepEqual(recurringItem.owner, { agentId: s.alice.id, agentName: "alice", displayName: "Alice" });
  assert.deepEqual(recurringItem.recurrence, DAILY);
  assert.deepEqual(recurringItem.anchor, {
    msgId: s.anchor.id,
    resolved: { channelType: "channel", channelName: "ops", messageId: s.anchor.id.slice(0, 8) },
  });
  assert.equal(items.find((i) => i.legacyId === overdueRecurring.id)!.fireAt, "2026-09-15T09:00:00.000Z", "fireAt is sent verbatim; the app rolls it forward");
  assert.equal(items.find((i) => i.legacyId === late.id)!.recurrence, undefined);

  for (const id of [recurring.id, overdueRecurring.id, late.id]) assert.equal((await getReminderById(id))?.status, "migrated", id);
  assert.equal((await getReminderById(notLate.id))?.status, "scheduled", "an unarmed overdue one-time reminder stays legacy");
  assert.equal((await getReminderById(internal.id))?.status, "scheduled", "server-internal reminders never move");
  assert.equal((await getReminderById(ofDeleted.id))?.status, "canceled", "a deleted agent's reminder is voided");

  assert.equal(await reminderAppMigratedForServer(s.server.id, CONFIG), true);
  // A second pass finds the installation completed and does nothing.
  assert.equal(await runReminderAppMigration(s.appInstall, { config: CONFIG, clock: CLOCK, importFn: fakeImport().fn }), null);
});

test("duplicates are marked, conflicts and rejections stay legacy, a revoked owner is skipped, a due-soon reminder defers completion", async ({ db: _db }) => {
  const s = await seed();
  const dup = await s.mk(s.alice.id, "already there", new Date("2026-10-21T09:00:00.000Z"), { recurrence: DAILY });
  const conflict = await s.mk(s.alice.id, "edited", new Date("2026-10-21T09:00:00.000Z"), { recurrence: DAILY });
  const rejected = await s.mk(s.alice.id, "x".repeat(300), new Date("2026-10-21T09:00:00.000Z"), { recurrence: DAILY });
  const soon = await s.mk(s.alice.id, "in five minutes", new Date(NOW.getTime() + 5 * 60_000), { recurrence: DAILY });
  const revoked = await s.mk(s.bob.id, "bob's", new Date("2026-10-21T09:00:00.000Z"), { recurrence: DAILY });
  await s.db.insert(oauthAgentAutoGrantBlocks).values({ agentId: s.bob.id, clientId: s.client.id, serverId: s.server.id, blockedByUserId: s.owner.id });

  const imp = fakeImport((item) => item.legacyId === dup.id ? "duplicate" : item.legacyId === conflict.id ? "conflict" : item.legacyId === rejected.id ? "rejected" : "imported");
  const outcome = await runReminderAppMigration(s.appInstall, { config: CONFIG, clock: CLOCK, importFn: imp.fn });
  assert.equal(outcome?.state, "running", "the due-soon reminder needs another pass before the switch");
  assert.equal(outcome?.counts.deferred_due_soon, 1);
  assert.equal(outcome?.counts.skipped_grant_revoked, 1);
  assert.equal(outcome?.counts.conflict_title_invalid ?? 0, 0);
  assert.equal(outcome?.counts.rejected_title_invalid, 1);

  assert.equal((await getReminderById(dup.id))?.status, "migrated", "a duplicate means an earlier run imported it");
  assert.equal((await getReminderById(conflict.id))?.status, "scheduled");
  assert.equal((await getReminderById(rejected.id))?.status, "scheduled");
  assert.equal((await getReminderById(soon.id))?.status, "scheduled");
  assert.equal((await getReminderById(revoked.id))?.status, "scheduled");
  assert.equal(imp.calls[0].items.some((i) => i.legacyId === revoked.id || i.legacyId === soon.id), false);
  assert.deepEqual((await s.db.select().from(oauthGrants)).map((g) => g.agentId), [s.alice.id], "no grant for the owner a person revoked");
  assert.equal(await reminderAppMigratedForServer(s.server.id, CONFIG), false, "not switched until the run completes");

  const [run] = await s.db.select().from(reminderAppMigrations).where(eq(reminderAppMigrations.serverId, s.server.id));
  assert.equal(run.state, "running");
  assert.ok(run.nextAttemptAt && run.nextAttemptAt.getTime() > NOW.getTime());
});

test("a refused batch fails the run without marking anything; uninstalling switches the server back", async ({ db: _db }) => {
  const s = await seed();
  const r = await s.mk(s.alice.id, "daily", new Date("2026-10-21T09:00:00.000Z"), { recurrence: DAILY });
  const refused = await runReminderAppMigration(s.appInstall, {
    config: CONFIG, clock: CLOCK,
    importFn: async () => ({ kind: "refused", status: 403, code: "agent_reminders_disabled" }),
  });
  assert.equal(refused?.state, "failed");
  assert.equal(refused?.errorCode, "agent_reminders_disabled");
  assert.equal((await getReminderById(r.id))?.status, "scheduled");
  assert.equal(await reminderAppMigratedForServer(s.server.id, CONFIG), false);

  // Retry after the backoff, then complete.
  const later: TimeProvider = { now: () => new Date(NOW.getTime() + 3 * 60 * 60_000) };
  const done = await runReminderAppMigration(s.appInstall, { config: CONFIG, clock: later, importFn: fakeImport().fn });
  assert.equal(done?.state, "completed");
  assert.equal(await reminderAppMigratedForServer(s.server.id, CONFIG), true);

  await s.db.delete(oauthClientInstalls).where(and(eq(oauthClientInstalls.id, s.appInstall.installId)));
  assert.equal(await reminderAppMigratedForServer(s.server.id, CONFIG), false, "uninstalled: legacy commands come back");
  assert.equal((await getReminderById(r.id))?.status, "migrated", "migrated reminders are not moved back");
  void reminders;
});

test("the worker never migrates on configuration alone: no allowlist runs nothing, dry-run writes nothing", async ({ db: _db }) => {
  const s = await seed();
  const r = await s.mk(s.alice.id, "daily", new Date("2026-10-21T09:00:00.000Z"), { recurrence: DAILY });
  const imp = fakeImport();
  const tickWith = async (config: ReminderAppMigrationConfig) => {
    const worker = startReminderAppMigrationWorker({
      config: () => config,
      importFn: imp.fn,
      clock: { now: () => NOW, setInterval: () => Symbol("interval"), clearInterval: () => {} },
    });
    await worker.tick();
    worker.stop();
  };

  await tickWith({ ...CONFIG, servers: new Set() });
  await tickWith({ ...CONFIG, mode: "dry_run", servers: new Set([s.server.id]) });
  assert.equal(imp.calls.length, 0, "nothing imported");
  assert.equal((await s.db.select().from(oauthGrants)).length, 0);
  assert.equal((await s.db.select().from(reminderAppMigrations)).length, 0);
  assert.equal((await getReminderById(r.id))?.status, "scheduled");

  await tickWith({ ...CONFIG, mode: "live", servers: new Set([s.server.id]) });
  assert.equal(imp.calls.length, 1);
  assert.equal((await getReminderById(r.id))?.status, "migrated");
  assert.equal(await reminderAppMigratedForServer(s.server.id, CONFIG), true);
});

test("configuration: the client id alone allows a dry run; live needs the import settings", () => {
  assert.equal(readReminderAppMigrationConfig({}), null, "no client id: off");
  const dry = readReminderAppMigrationConfig({ REMINDER_APP_CLIENT_ID: "reminder-x", REMINDER_APP_MIGRATION_SERVERS: "s1, s2" });
  assert.equal(dry?.mode, "dry_run");
  assert.deepEqual(dry && dry.servers !== "*" ? [...dry.servers] : dry?.servers, ["s1", "s2"]);
  const blocked = readReminderAppMigrationConfig({ REMINDER_APP_CLIENT_ID: "reminder-x", REMINDER_APP_MIGRATION_MODE: "live" });
  assert.deepEqual([blocked?.mode, blocked?.liveBlockedReason], ["dry_run", "import_settings_missing"]);
  const live = readReminderAppMigrationConfig({
    REMINDER_APP_CLIENT_ID: "reminder-x", REMINDER_APP_MIGRATION_MODE: "live",
    REMINDER_APP_IMPORT_URL: "https://r.example/import", REMINDER_APP_IMPORT_TOKEN: "t".repeat(40), REMINDER_APP_MIGRATION_SERVERS: "*",
  });
  assert.deepEqual([live?.mode, live?.servers], ["live", "*"]);
});

test("two workers racing for the same installation: exactly one claims the run, grants and imports once", async ({ db: _db }) => {
  const s = await seed();
  const r = await s.mk(s.alice.id, "daily", new Date("2026-10-21T09:00:00.000Z"), { recurrence: DAILY });
  const imp = fakeImport();
  const slowImport: ReminderAppImportFn = async (input) => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    return imp.fn(input);
  };
  const outcomes = await Promise.all([1, 2, 3].map(() =>
    runReminderAppMigration(s.appInstall, { config: CONFIG, clock: CLOCK, importFn: slowImport })));
  assert.equal(outcomes.filter((o) => o !== null).length, 1, JSON.stringify(outcomes));
  assert.equal(imp.calls.length, 1, "imported once");
  assert.equal((await s.db.select().from(oauthGrants)).length, 1, "one grant, not one per worker");
  assert.equal((await s.db.select().from(reminderAppMigrations)).length, 1);
  assert.equal((await getReminderById(r.id))?.status, "migrated");
});

test("thread anchors: parent channel + short ids; a missing parent_channel_id is recovered from the parent message; no parents at all → no anchor", async ({ db: _db }) => {
  const s = await seed();
  const parentMsg = await createMessage(s.ops.id, "agent", s.alice.id, "thread parent");
  const [thread] = await s.db.insert(channels).values({
    serverId: s.server.id, name: `thread-${parentMsg.id.slice(0, 8)}`, type: "thread", parentMessageId: parentMsg.id,
  }).returning();
  // The trigger may have derived it; simulate the threads where it is missing.
  await s.db.update(channels).set({ parentChannelId: null }).where(eq(channels.id, thread.id));
  const [bare] = await s.db.insert(channels).values({ serverId: s.server.id, name: "thread-bare", type: "thread" }).returning();
  await s.db.update(channels).set({ parentChannelId: null, parentMessageId: null }).where(eq(channels.id, bare.id));

  const inThread = await s.mk(s.alice.id, "in thread", new Date("2026-10-21T09:00:00.000Z"), { recurrence: DAILY });
  await s.db.update(reminders).set({ targetChannelId: thread.id }).where(eq(reminders.id, inThread.id));
  const inBare = await s.mk(s.bob.id, "empty thread", new Date("2026-10-21T09:00:00.000Z"), { recurrence: DAILY });
  await s.db.update(reminders).set({ targetChannelId: bare.id }).where(eq(reminders.id, inBare.id));

  const imp = fakeImport();
  const outcome = await runReminderAppMigration(s.appInstall, { config: CONFIG, clock: CLOCK, importFn: imp.fn });
  assert.equal(outcome?.state, "completed");
  assert.equal(outcome?.counts.anchor_unresolved, 1);
  const byId = new Map(imp.calls[0].items.map((i) => [i.legacyId, i]));
  assert.deepEqual(byId.get(inThread.id)?.anchor, {
    targetChannelId: thread.id,
    resolved: { channelType: "channel", channelName: "ops", threadId: parentMsg.id.slice(0, 8) },
  });
  assert.deepEqual(byId.get(inBare.id)?.anchor, { targetChannelId: bare.id, resolved: null }, "imported without an anchor, not skipped");
  assert.equal((await getReminderById(inBare.id))?.status, "migrated");
});

test("a joint (cross-server) thread's local projection resolves to the owner's local joint channel and its thread short id", async ({ db: _db }) => {
  const s = await seed();
  const [host] = await s.db.insert(servers).values({ name: "Host", slug: "host", ownerId: s.owner.id }).returning();
  const [canonical, hostLocal, local] = await s.db.insert(channels).values([
    { serverId: host.id, name: "partners-canonical", type: "joint" },
    { serverId: host.id, name: "partners-host", type: "joint" },
    { serverId: s.server.id, name: "partners", type: "joint" },
  ]).returning();
  const [joint] = await s.db.insert(jointChannels).values({ canonicalChannelId: canonical.id, createdByServerId: host.id, createdByUserId: s.owner.id }).returning();
  await s.db.insert(jointChannelServers).values([
    { jointChannelId: joint.id, serverId: host.id, localChannelId: hostLocal.id, role: "host", status: "active", joinedByUserId: s.owner.id },
    { jointChannelId: joint.id, serverId: s.server.id, localChannelId: local.id, role: "participant", status: "active", joinedByUserId: s.owner.id },
  ]);
  await s.db.insert(channelAgents).values({ channelId: local.id, agentId: s.alice.id });
  const root = await createMessage(canonical.id, "agent", s.alice.id, "joint root");
  const [canonicalThread, localThread] = await s.db.insert(channels).values([
    { serverId: host.id, name: `thread-${root.id.slice(0, 8)}`, type: "thread", parentMessageId: root.id },
    // A local projection has no parent fields, by design.
    { serverId: s.server.id, name: `thread-${root.id.slice(0, 8)}`, type: "thread", parentMessageId: null },
  ]).returning();
  await s.db.update(messages).set({ threadId: canonicalThread.id }).where(eq(messages.id, root.id));
  const [jointThread] = await s.db.insert(jointChannels).values({ canonicalChannelId: canonicalThread.id, createdByServerId: host.id, createdByUserId: s.owner.id }).returning();
  await s.db.insert(jointChannelServers).values({
    jointChannelId: jointThread.id, serverId: s.server.id, localChannelId: localThread.id, role: "participant", status: "active", joinedByUserId: s.owner.id,
  });
  assert.equal((await getJointThreadProjectionByLocalThread(localThread.id, s.server.id))?.localParentChannelId, local.id, "fixture: a live projection");

  const r = await s.mk(s.alice.id, "follow up in the partner thread", new Date("2026-10-21T09:00:00.000Z"), { recurrence: DAILY });
  await s.db.update(reminders).set({ targetChannelId: localThread.id }).where(eq(reminders.id, r.id));
  const imp = fakeImport();
  const outcome = await runReminderAppMigration(s.appInstall, { config: CONFIG, clock: CLOCK, importFn: imp.fn });
  assert.equal(outcome?.counts.anchor_unresolved, 0);
  assert.deepEqual(imp.calls[0].items.find((i) => i.legacyId === r.id)?.anchor, {
    targetChannelId: localThread.id,
    resolved: { channelType: "channel", channelName: "partners", threadId: root.id.slice(0, 8) },
  });
});

test("a run that lost its lease mid-import writes nothing more; the run that took over keeps its outcome", async ({ db: _db }) => {
  const s = await seed();
  const r = await s.mk(s.alice.id, "daily", new Date("2026-10-21T09:00:00.000Z"), { recurrence: DAILY });
  let t = NOW;
  const clock: TimeProvider = { now: () => t };
  const fast = fakeImport();
  let takeover: Awaited<ReturnType<typeof runReminderAppMigration>> | undefined;
  const slow: ReminderAppImportFn = async (input) => {
    // While this import hangs, the lease expires and another replica takes the run over and finishes it.
    t = new Date(NOW.getTime() + 11 * 60_000);
    takeover = await runReminderAppMigration(s.appInstall, { config: CONFIG, clock, importFn: fast.fn });
    return fast.fn(input);
  };
  const first = await runReminderAppMigration(s.appInstall, { config: CONFIG, clock, importFn: slow });
  assert.equal(takeover?.state, "completed", "the second replica claimed the expired lease and completed");
  assert.equal(first, null, "the first run lost its lease: no outcome of its own");
  const [row] = await s.db.select().from(reminderAppMigrations);
  assert.equal(row.state, "completed", "not overwritten by the slow run");
  assert.equal(row.attempts, 2);
  assert.equal((await getReminderById(r.id))?.status, "migrated");
  assert.equal((await s.db.select().from(oauthGrants)).length, 1, "grants were created once");
});

test("a long run renews its lease before each step", async ({ db: _db }) => {
  const s = await seed();
  await s.mk(s.alice.id, "daily", new Date("2026-10-21T09:00:00.000Z"), { recurrence: DAILY });
  let calls = 0;
  // Every reading of the clock is a minute later: the run takes "a while".
  const clock: TimeProvider = { now: () => new Date(NOW.getTime() + (calls++) * 60_000) };
  const imp = fakeImport();
  let leaseAtImport: Date | null = null;
  const outcome = await runReminderAppMigration(s.appInstall, {
    config: CONFIG, clock,
    importFn: async (input) => {
      leaseAtImport = (await s.db.select().from(reminderAppMigrations))[0].nextAttemptAt;
      return imp.fn(input);
    },
  });
  assert.equal(outcome?.state, "completed");
  assert.ok(leaseAtImport && (leaseAtImport as Date).getTime() > NOW.getTime() + 10 * 60_000, `renewed past the claim's lease: ${String(leaseAtImport)}`);
});

test("audit item 3: legacy-import grants are recorded as an integration audit event", async ({ db: _db }) => {
  const s = await seed();
  await s.mk(s.alice.id, "daily", new Date("2026-10-21T09:00:00.000Z"), { recurrence: DAILY });
  await s.mk(s.bob.id, "daily too", new Date("2026-10-21T09:00:00.000Z"), { recurrence: DAILY });
  assert.equal((await runReminderAppMigration(s.appInstall, { config: CONFIG, clock: CLOCK, importFn: fakeImport().fn }))?.state, "completed");
  const events = await s.db.select().from(integrationAuditEvents).where(eq(integrationAuditEvents.eventType, "installation.legacy_import_grants_created"));
  assert.equal(events.length, 1);
  assert.equal(events[0].serverId, s.server.id);
  assert.equal(events[0].clientId, s.client.id);
  assert.equal(events[0].actorType, "system");
  assert.deepEqual(events[0].metadata, { installationId: s.appInstall.installId, grantCount: 2, scopes: ["agent:notification:write"] });
});

test("audit item 4: a Reminder App that is not an approved official app is reported, not blocked", async ({ db: _db }) => {
  const s = await seed();
  await s.mk(s.alice.id, "daily", new Date("2026-10-21T09:00:00.000Z"), { recurrence: DAILY });
  assert.equal((await planReminderAppMigrationReport(s.appInstall, { clock: CLOCK })).counts.reminder_app_not_official, 1);
  await s.db.insert(officialAppRegistry).values({
    oauthClientId: s.client.id, clientKey: CONFIG.clientId, publisherServerId: s.server.id, purpose: "Reminders", status: "approved",
  });
  assert.equal((await planReminderAppMigrationReport(s.appInstall, { clock: CLOCK })).counts.reminder_app_not_official, undefined);
});

test("RFC 084: the setting keeps naming the App after it changes its id", async ({ db: _db }) => {
  const s = await seed();
  await s.db.update(oauthClients).set({ clientId: "reminder-renamed" }).where(eq(oauthClients.id, s.client.id));
  assert.deepEqual(await listDueReminderAppInstalls(CONFIG, { now: NOW, limit: 5 }), [], "an old id with no alias names nothing");
  await s.db.insert(oauthClientKeyAliases).values({ key: CONFIG.clientId, clientId: s.client.id, sourceServerId: s.server.id });
  const due = await listDueReminderAppInstalls(CONFIG, { now: NOW, limit: 5 });
  assert.deepEqual(due.map((install) => install.clientUuid), [s.client.id]);
  assert.equal((await findActiveReminderAppInstall(s.server.id, CONFIG.clientId))?.clientUuid, s.client.id);
});

test("audit item 5: the server allowlist applies before the LIMIT, so other due installations cannot crowd it out", async ({ db: _db }) => {
  const s = await seed();
  const [other] = await s.db.insert(servers).values({ name: "Other", slug: "other", ownerId: s.owner.id }).returning();
  await s.db.insert(oauthClientInstalls).values({
    serverId: other.id, clientId: s.client.id, installedByUserId: s.owner.id, approvedScopes: ["agent:notification:write"],
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  });
  const due = await listDueReminderAppInstalls({ ...CONFIG, servers: new Set([s.server.id]) }, { now: NOW, limit: 1 });
  assert.deepEqual(due.map((install) => install.serverId), [s.server.id]);
  assert.deepEqual(await listDueReminderAppInstalls({ ...CONFIG, servers: new Set() }, { now: NOW, limit: 5 }), []);
});
