import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { asc, eq, inArray, sql } from "drizzle-orm";
import type { Server as SocketServer } from "socket.io";
import { APP_INSTALLATION_NOTIFICATION_EVENTS, BasicTracer, MemoryTraceSink, PERMISSION_UPDATES_CHANGED_EVENT } from "@botiverse/raft-shared";
import { APP_ADMIN_OPERATOR_ROLE, MARKETPLACE_PERMISSION_REVIEW_MARKER_FUNCTION } from "../db/appAdminPrivileges";
import type { Database, DatabaseExecutor } from "../db/index";
import {
  agentCredentials,
  agents,
  appBotBindings,
  marketplaceReviewOutbox,
  oauthAppLinkPreviews,
  oauthAppPermissionRevisions,
  oauthClientInstalls,
  oauthClients,
  serverMembers,
  servers,
} from "../db/schema";
import { marketplaceReviewOutboxOldestUndeliveredAgeSeconds, marketplaceReviewOutboxUndeliveredRows } from "../metrics";
import { dbTest as test } from "../test/integration/dbTest";
import type { createSeed } from "../test/integration/seed";
import { setDefaultTraceTracer } from "../tracing/semanticTrace";
import { subscribeAgentCredentialRevocation } from "./agentCredentialRevocationBus";
import { createAgent } from "./agentService";
import { createAppOutboundPermissionRevision } from "./appOutboundPermissionService";
import { setListChangedRealtimeIO } from "./listChangedRealtime";
import {
  drainMarketplaceReviewOutbox,
  marketplaceReviewSideEffectSinks,
  pruneDeliveredMarketplaceReviewOutbox,
  reportMarketplaceReviewOutboxBacklog,
  resetMarketplaceReviewOutboxBacklogForTests,
  startMarketplaceReviewOutboxWorker,
  type MarketplaceReviewSideEffectSinks,
} from "./marketplaceReviewOutbox";
import { createOAuthClient } from "./oauthService";

// What follows a marketplace review decision (#proj-apps:#50): the migration
// marketplace_review_outbox's decision functions (installation.bot_changed
// kept on approval, an offline approval's security inside the function, one
// outbox row per side effect, the marker App Admin looks for, the one-off
// repair), the server's worker that sends the rows, the retention of
// delivered rows, and a decision through App Admin's entry, under App Admin's
// role, reaching clients once the worker runs. Raft's own routes for these
// decisions were removed (#proj-apps task #19): the worker sends every
// decision's rows.

type Seed = ReturnType<typeof createSeed>;
const OWN = "installation.bot_changed";
const BOTIVERSE_SERVER_ID = "95f993fa-2a68-4797-b8ae-7beb7d984ada";

async function botiverseAdmin(seed: Seed, db: Database) {
  const [existing] = await db.select({ id: servers.id }).from(servers).where(eq(servers.id, BOTIVERSE_SERVER_ID));
  if (!existing) {
    const owner = await seed.human();
    await db.insert(servers).values({ id: BOTIVERSE_SERVER_ID, name: "Botiverse", slug: `botiverse-${randomUUID().slice(0, 8)}`, ownerId: owner.id });
  }
  const human = await seed.human();
  await db.insert(serverMembers).values({ serverId: BOTIVERSE_SERVER_ID, userId: human.id, role: "admin" });
  return human;
}

async function result(db: DatabaseExecutor, query: ReturnType<typeof sql>): Promise<Record<string, unknown>> {
  const { rows } = await db.execute<{ result: Record<string, unknown> }>(query);
  return rows[0]!.result;
}

/** The bodies, as the server calls them; the entries, as App Admin calls them. */
const permissionBody = (db: DatabaseExecutor, clientId: string, expected: string | null, reviewerId: string) =>
  result(db, sql`SELECT public.marketplace_approve_permission_review(${clientId}::uuid, ${expected}::uuid, ${reviewerId}::uuid) AS result`);
const permissionEntry = (db: DatabaseExecutor, clientId: string, expected: string, actorId: string) =>
  result(db, sql`SELECT public.app_admin_approve_permission_review(${clientId}::uuid, ${expected}::uuid, 'human', ${actorId}::uuid) AS result`);
const publishBody = (db: DatabaseExecutor, clientId: string, decision: string, expectedStatus: string, actorId: string, reason: string | null = null) =>
  result(db, sql`SELECT public.marketplace_decide_publish_review(${clientId}::uuid, ${decision}::text, ${expectedStatus}::text, 'human', ${actorId}::uuid, ${reason}::text) AS result`);
const publishEntry = (db: DatabaseExecutor, clientId: string, decision: string, expectedStatus: string, actorId: string) =>
  result(db, sql`SELECT public.app_admin_decide_publish_review(${clientId}::uuid, ${decision}::text, ${expectedStatus}::text, 'human', ${actorId}::uuid, NULL) AS result`);

async function marketplaceApp(seed: Seed, db: Database, publishStatus: typeof oauthClients.$inferInsert["publishStatus"]) {
  const publisher = await seed.human();
  const source = await seed.server({ owner: publisher });
  const { client } = await createOAuthClient({
    serverId: source.id,
    createdByUserId: publisher.id,
    clientId: `outbox-${randomUUID().slice(0, 8)}`,
    name: "Outbox Fixture",
    description: "An App under marketplace review.",
    appType: "third_party_global",
  });
  await db.update(oauthClients).set({ publishStatus }).where(eq(oauthClients.id, client.id));
  return { publisher, source, client };
}

async function install(db: Database, input: { serverId: string; clientId: string; userId: string; subscribedEvents?: string[]; approvedGroups?: string[] }) {
  const [row] = await db.insert(oauthClientInstalls).values({
    serverId: input.serverId, clientId: input.clientId, installedByUserId: input.userId, approvedScopes: ["openid"],
    approvedGroups: input.approvedGroups ?? [], subscribedEvents: input.subscribedEvents ?? [],
    grantRevision: 3, subscriptionRevision: 5, updatedAt: new Date(Date.now() - 60_000),
  }).returning();
  return row!;
}

/** Another Server with the App installed. */
async function installedElsewhere(seed: Seed, db: Database, clientId: string) {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  return { owner, server, installation: await install(db, { serverId: server.id, clientId, userId: owner.id }) };
}

/** A bot bound to the installation, with one live credential. */
async function bot(db: Database, installation: { id: string; serverId: string }) {
  const agent = await createAgent(installation.serverId, `bot-${randomUUID().slice(0, 8)}`, { runtime: "external", model: "external" });
  await db.insert(appBotBindings).values({ installId: installation.id, serverId: installation.serverId, agentId: agent.id, handle: agent.name });
  await db.insert(agentCredentials).values({ agentId: agent.id, apiKeyHash: "fixture-value-not-a-credential", apiKeyPrefix: `p${randomUUID().slice(0, 7)}`, scopes: ["send"] });
  return agent;
}

/** A published App with a permission revision waiting (groups agent and server, event server.plan_changed). */
async function permissionApp(seed: Seed, db: Database, sourceSubscribedEvents: string[] | null) {
  const app = await marketplaceApp(seed, db, "published");
  const sourceInstall = sourceSubscribedEvents === null ? null : await install(db, {
    serverId: app.source.id, clientId: app.client.id, userId: app.publisher.id, subscribedEvents: sourceSubscribedEvents, approvedGroups: ["agent"],
  });
  const created = await createAppOutboundPermissionRevision({
    clientId: app.client.id, actor: { type: "human", id: app.publisher.id }, groups: ["agent", "server"], events: ["server.plan_changed"],
  });
  assert.equal(created?.revision.state, "pending_review");
  return { ...app, sourceInstall, pendingRevisionId: created!.revision.id };
}

const installRow = async (db: Database, id: string) => (await db.select().from(oauthClientInstalls).where(eq(oauthClientInstalls.id, id)))[0]!;

async function outboxOf(db: Database, clientIds: string[]) {
  return db.select().from(marketplaceReviewOutbox).where(inArray(marketplaceReviewOutbox.clientId, clientIds)).orderBy(asc(marketplaceReviewOutbox.seq));
}

/** `kind server [agent] cause` per row, in delivery order. */
const describeRows = (rows: Array<typeof marketplaceReviewOutbox.$inferSelect>) =>
  rows.map((row) => [row.kind, row.serverId, ...(row.agentId ? [row.agentId] : []), row.cause].join(" "));

/** The production sinks over a recording socket server, the list-changed pings and the revocation bus. */
function captured(agentIds: string[] = []) {
  const frames: string[] = [];
  const record = (room: string) => ({ emit: (event: string, payload: unknown) => {
    frames.push(`${room} ${event} ${JSON.stringify(payload)}`);
    return true;
  } });
  setListChangedRealtimeIO({ to: record } as never);
  const forgotten: string[] = [];
  const revoked: string[] = [];
  const unsubscribe = agentIds.map((agentId) => subscribeAgentCredentialRevocation(agentId, () => revoked.push(agentId)));
  const sinks = marketplaceReviewSideEffectSinks({
    io: { to: record } as unknown as Pick<SocketServer, "to">,
    agentOrchestrator: { forgetAgentActivity: (agentId: string) => { forgotten.push(agentId); } },
  });
  return {
    sinks, frames, forgotten, revoked,
    take: () => frames.splice(0),
    restore: () => {
      setListChangedRealtimeIO(null);
      for (const stop of unsubscribe) stop();
    },
  };
}

const ping = (serverId: string) => `server:${serverId} ${PERMISSION_UPDATES_CHANGED_EVENT} ${JSON.stringify({ serverId })}`;
const agentDeleted = (serverId: string, agentId: string) => `server:${serverId} agent:deleted ${JSON.stringify({ agentId })}`;

// ── The decision functions ──────────────────────────────────────────────────

test("a permission approval keeps the source installation's own events, through the body and App Admin's entry; one without them stays without", async ({ db, seed }) => {
  const reviewer = await seed.human();
  const admin = await botiverseAdmin(seed, db);

  // Subscribed to its own event only: the reviewed event joins it, sorted; the subscription moved.
  const ownOnly = await permissionApp(seed, db, [OWN]);
  await permissionBody(db, ownOnly.client.id, ownOnly.pendingRevisionId, reviewer.id);
  let after = await installRow(db, ownOnly.sourceInstall!.id);
  assert.deepEqual([after.subscribedEvents, after.subscriptionRevision], [[OWN, "server.plan_changed"], 6]);

  // Through App Admin's entry, already holding everything: nothing moves (the
  // list compared is the one written, the kept event included).
  const settled = await permissionApp(seed, db, ["server.plan_changed", OWN]);
  await permissionEntry(db, settled.client.id, settled.pendingRevisionId, admin.id);
  after = await installRow(db, settled.sourceInstall!.id);
  assert.deepEqual([after.subscribedEvents, after.subscriptionRevision], [[OWN, "server.plan_changed"], 5]);

  // Never subscribed to it: the revision's events as stored, as before.
  const without = await permissionApp(seed, db, []);
  await permissionEntry(db, without.client.id, without.pendingRevisionId, admin.id);
  after = await installRow(db, without.sourceInstall!.id);
  assert.deepEqual([after.subscribedEvents, after.subscriptionRevision], [["server.plan_changed"], 6]);

  // Every installation event the shared registry has is kept: the SQL's list is that list.
  const every = await permissionApp(seed, db, [...APP_INSTALLATION_NOTIFICATION_EVENTS]);
  await permissionEntry(db, every.client.id, every.pendingRevisionId, admin.id);
  after = await installRow(db, every.sourceInstall!.id);
  assert.deepEqual(after.subscribedEvents, [...APP_INSTALLATION_NOTIFICATION_EVENTS, "server.plan_changed"].sort());
});

test("an offline approval revokes the removed bots' credentials, retires their bindings and agents inside the function, before anything is delivered", async ({ db, seed }) => {
  const { publisher, source, client } = await marketplaceApp(seed, db, "unpublish_requested");
  const admin = await botiverseAdmin(seed, db);
  const sourceInstall = await install(db, { serverId: source.id, clientId: client.id, userId: publisher.id });
  const sourceBot = await bot(db, sourceInstall);
  const external = await installedElsewhere(seed, db, client.id);
  const externalBot = await bot(db, external.installation);
  // A disabled binding is a bot too: retired with the installation.
  const disabled = await installedElsewhere(seed, db, client.id);
  const disabledBot = await bot(db, disabled.installation);
  await db.update(appBotBindings).set({ state: "disabled", disabledAt: new Date() }).where(eq(appBotBindings.agentId, disabledBot.id));

  // One transaction, as App Admin runs it; nothing but the function in it.
  await db.transaction(async (tx) => {
    await publishEntry(tx, client.id, "approve", "unpublish_requested", admin.id);
    for (const agent of [externalBot, disabledBot]) {
      const credentials = await tx.select({ revokedAt: agentCredentials.revokedAt, reason: agentCredentials.revokedReason })
        .from(agentCredentials).where(eq(agentCredentials.agentId, agent.id));
      assert.deepEqual(credentials.map((row) => [Boolean(row.revokedAt), row.reason]), [[true, "bot_uninstalled"]], agent.name);
      assert.equal((await tx.select().from(appBotBindings).where(eq(appBotBindings.agentId, agent.id))).length, 0, `${agent.name}: binding gone with its installation`);
      assert.ok((await tx.select({ deletedAt: agents.deletedAt }).from(agents).where(eq(agents.id, agent.id)))[0]?.deletedAt, `${agent.name}: agent deleted`);
    }
  });

  // The source Server keeps its bot.
  const [sourceCredential] = await db.select({ revokedAt: agentCredentials.revokedAt }).from(agentCredentials).where(eq(agentCredentials.agentId, sourceBot.id));
  assert.equal(sourceCredential?.revokedAt, null);
  // What follows is written, not yet sent: the removed bots, then every Server it was installed on.
  const rows = await outboxOf(db, [client.id]);
  assert.ok(rows.every((row) => row.deliveredAt === null && row.attempts === 0));
  const removed = rows.filter((row) => row.kind === "app_bot_removed").map((row) => `${row.serverId} ${row.agentId}`).sort();
  assert.deepEqual(removed, [`${external.server.id} ${externalBot.id}`, `${disabled.server.id} ${disabledBot.id}`].sort());
  assert.deepEqual(rows.slice(0, 2).map((row) => row.kind), ["app_bot_removed", "app_bot_removed"]);
  assert.deepEqual(
    describeRows(rows.slice(2)),
    [source.id, external.server.id, disabled.server.id].sort().map((serverId) => `permission_updates_changed ${serverId} app.offline_approved`),
  );
});

test("each decision writes one outbox row per side effect, in decision order per App; the card URL review writes none", async ({ db, seed }) => {
  const reviewer = await seed.human();

  // Publish approval: the Servers installed on before the decision (the source installation it creates is not one, as the route read them).
  const fresh = await marketplaceApp(seed, db, "publish_requested");
  await publishBody(db, fresh.client.id, "approve", "publish_requested", reviewer.id);
  assert.deepEqual(describeRows(await outboxOf(db, [fresh.client.id])), []);
  const earlier = await marketplaceApp(seed, db, "in_review");
  const earlierInstall = await install(db, { serverId: earlier.source.id, clientId: earlier.client.id, userId: earlier.publisher.id });
  await publishBody(db, earlier.client.id, "approve", "in_review", reviewer.id);
  assert.deepEqual(describeRows(await outboxOf(db, [earlier.client.id])), [`permission_updates_changed ${earlierInstall.serverId} app.publish_approved`]);

  // Rejections ping too, as the route's did.
  const rejected = await marketplaceApp(seed, db, "publish_requested");
  await install(db, { serverId: rejected.source.id, clientId: rejected.client.id, userId: rejected.publisher.id });
  await publishBody(db, rejected.client.id, "reject", "publish_requested", reviewer.id, "Not yet.");
  assert.deepEqual(describeRows(await outboxOf(db, [rejected.client.id])), [`permission_updates_changed ${rejected.source.id} app.publish_rejected`]);

  // One App, three decisions: rows in the order the decisions committed.
  const app = await permissionApp(seed, db, [OWN]);
  const external = await installedElsewhere(seed, db, app.client.id);
  const externalBot = await bot(db, external.installation);
  const serverIds = [app.source.id, external.server.id].sort();
  await permissionBody(db, app.client.id, app.pendingRevisionId, reviewer.id);
  await db.update(oauthClients).set({ publishStatus: "unpublish_requested" }).where(eq(oauthClients.id, app.client.id));
  await publishBody(db, app.client.id, "reject", "unpublish_requested", reviewer.id, "Stay listed.");
  await db.update(oauthClients).set({ publishStatus: "unpublish_requested" }).where(eq(oauthClients.id, app.client.id));
  await publishBody(db, app.client.id, "approve", "unpublish_requested", reviewer.id);
  const rows = await outboxOf(db, [app.client.id]);
  assert.deepEqual(describeRows(rows), [
    ...serverIds.map((serverId) => `permission_updates_changed ${serverId} app.outbound_permission_approved`),
    ...serverIds.map((serverId) => `permission_updates_changed ${serverId} app.offline_rejected`),
    `app_bot_removed ${external.server.id} ${externalBot.id} app.offline_approved`,
    ...serverIds.map((serverId) => `permission_updates_changed ${serverId} app.offline_approved`),
  ]);
  assert.equal(new Set(rows.map((row) => row.id)).size, rows.length);

  // The card URL review has nothing after it.
  const card = await marketplaceApp(seed, db, "published");
  await install(db, { serverId: card.source.id, clientId: card.client.id, userId: card.publisher.id });
  const origin = `https://${randomUUID().slice(0, 8)}.example.test`;
  await db.insert(oauthAppLinkPreviews).values({
    clientId: card.client.id, origin, endpoint: `${origin}/preview`, paths: ["/x/*"], pendingActionEndpoint: `${origin}/actions`, pendingActionEndpointRequestedAt: new Date(),
  });
  await result(db, sql`SELECT public.marketplace_decide_action_endpoint_review(${card.client.id}::uuid, 'approve', ${`${origin}/actions`}::text, ${reviewer.id}::uuid, NULL) AS result`);
  assert.deepEqual(await outboxOf(db, [card.client.id]), []);
});

test("the marker App Admin looks for exists, answers true, and only its owner may execute it", async ({ db }) => {
  const { rows } = await db.execute<{ found: boolean; answer: boolean; public_execute: boolean; definer: boolean; config: string[] | null }>(sql`
    SELECT pg_catalog.to_regprocedure(${MARKETPLACE_PERMISSION_REVIEW_MARKER_FUNCTION}) IS NOT NULL AS found,
           public.marketplace_permission_review_keeps_bot_changed() AS answer,
           pg_catalog.has_function_privilege('public', ${MARKETPLACE_PERMISSION_REVIEW_MARKER_FUNCTION}, 'EXECUTE') AS public_execute,
           p.prosecdef AS definer, p.proconfig AS config
      FROM pg_catalog.pg_proc p WHERE p.oid = pg_catalog.to_regprocedure(${MARKETPLACE_PERMISSION_REVIEW_MARKER_FUNCTION})`);
  assert.deepEqual(rows[0], { found: true, answer: true, public_execute: false, definer: false, config: ["search_path=pg_catalog, pg_temp"] });
});

/** The migration's one-off repair statement, as it runs at deploy. */
function repairStatement(): string {
  const folder = new URL("../../drizzle/", import.meta.url);
  const file = readdirSync(folder).find((name) => name.endsWith(".sql")
    && readFileSync(new URL(name, folder), "utf8").includes("CREATE FUNCTION public.marketplace_permission_review_keeps_bot_changed()"));
  assert.ok(file, "the marker's migration");
  const statement = readFileSync(new URL(file, folder), "utf8").split("--> statement-breakpoint")
    .find((part) => part.includes("UPDATE public.oauth_client_installs i SET"));
  assert.ok(statement, "the repair statement");
  return statement;
}

test("the one-off repair gives installation.bot_changed back only where a review approval since App Admin's entry was the installation's last write", async ({ db, seed }) => {
  const reviewer = await seed.human();
  // What an approval that dropped the event leaves: the subscription is the
  // revision's events, written by the approval and by nothing since.
  const approved = async (subscribed: string[]) => {
    const app = await permissionApp(seed, db, subscribed);
    await permissionBody(db, app.client.id, app.pendingRevisionId, reviewer.id);
    return app;
  };
  const dropped = await approved([]);
  const droppedBefore = await installRow(db, dropped.sourceInstall!.id);
  const kept = await approved([OWN]);
  const writtenSince = await approved([]);
  await db.update(oauthClientInstalls).set({ updatedAt: new Date(Date.now() + 1_000) }).where(eq(oauthClientInstalls.id, writtenSince.sourceInstall!.id));
  const changedSince = await approved([]);
  await db.execute(sql`UPDATE public.oauth_client_installs SET subscribed_events = '[]'::jsonb WHERE id = ${changedSince.sourceInstall!.id}::uuid`);
  const longAgo = await approved([]);
  const before = new Date("2026-11-01T00:00:00Z");
  await db.update(oauthAppPermissionRevisions).set({ reviewedAt: before }).where(eq(oauthAppPermissionRevisions.id, longAgo.pendingRevisionId));
  await db.update(oauthClientInstalls).set({ updatedAt: before }).where(eq(oauthClientInstalls.id, longAgo.sourceInstall!.id));
  // Another Server's installation is never the source's.
  const elsewhere = await installedElsewhere(seed, db, dropped.client.id);
  const untouched = [kept, writtenSince, changedSince, longAgo].map((app) => app.sourceInstall!.id);
  const snapshot = async () => db.select().from(oauthClientInstalls).where(inArray(oauthClientInstalls.id, [...untouched, elsewhere.installation.id])).orderBy(asc(oauthClientInstalls.id));
  const othersBefore = await snapshot();

  await db.execute(sql.raw(repairStatement()));

  const repaired = await installRow(db, dropped.sourceInstall!.id);
  assert.deepEqual(
    [repaired.subscribedEvents, repaired.subscriptionRevision],
    [[OWN, "server.plan_changed"], droppedBefore.subscriptionRevision],
  );
  assert.ok(repaired.updatedAt > droppedBefore.updatedAt);
  assert.deepEqual(await snapshot(), othersBefore);
  // Once is enough: it now has the event, so a second run matches nothing.
  await db.execute(sql.raw(repairStatement()));
  assert.deepEqual(await installRow(db, dropped.sourceInstall!.id), repaired);
});

// ── The worker ──────────────────────────────────────────────────────────────

test("the worker sends what the routes sent after their commit and marks each row delivered; a delivered row is not sent again", async ({ db, seed }) => {
  const { publisher, source, client } = await marketplaceApp(seed, db, "unpublish_requested");
  const reviewer = await seed.human();
  await install(db, { serverId: source.id, clientId: client.id, userId: publisher.id });
  const external = await installedElsewhere(seed, db, client.id);
  const externalBot = await bot(db, external.installation);
  await publishBody(db, client.id, "approve", "unpublish_requested", reviewer.id);
  const serverIds = [source.id, external.server.id].sort();

  const capture = captured([externalBot.id]);
  try {
    const summary = await drainMarketplaceReviewOutbox({ sinks: capture.sinks });
    assert.deepEqual(summary, { apps: 1, busy: 0, delivered: 3, failed: 0 });
    assert.deepEqual(capture.take(), [agentDeleted(external.server.id, externalBot.id), ...serverIds.map(ping)]);
    assert.deepEqual(capture.revoked, [externalBot.id]);
    assert.deepEqual(capture.forgotten, [externalBot.id]);
    const rows = await outboxOf(db, [client.id]);
    assert.ok(rows.every((row) => row.deliveredAt !== null && row.attempts === 1 && row.lastError === null));

    assert.deepEqual(await drainMarketplaceReviewOutbox({ sinks: capture.sinks }), { apps: 0, busy: 0, delivered: 0, failed: 0 });
    assert.deepEqual(capture.take(), []);
  } finally {
    capture.restore();
  }
});

test("redelivery is harmless: rows a crash left undelivered are sent again and change nothing in the database", async ({ db, seed }) => {
  const { client } = await marketplaceApp(seed, db, "unpublish_requested");
  const reviewer = await seed.human();
  const external = await installedElsewhere(seed, db, client.id);
  const externalBot = await bot(db, external.installation);
  await publishBody(db, client.id, "approve", "unpublish_requested", reviewer.id);

  const capture = captured([externalBot.id]);
  try {
    await drainMarketplaceReviewOutbox({ sinks: capture.sinks });
    const first = capture.take();
    const state = async () => ({
      agent: (await db.select({ deletedAt: agents.deletedAt }).from(agents).where(eq(agents.id, externalBot.id)))[0],
      credentials: await db.select({ revokedAt: agentCredentials.revokedAt, reason: agentCredentials.revokedReason }).from(agentCredentials).where(eq(agentCredentials.agentId, externalBot.id)),
      bindings: await db.select().from(appBotBindings).where(eq(appBotBindings.agentId, externalBot.id)),
      installs: await db.select().from(oauthClientInstalls).where(eq(oauthClientInstalls.clientId, client.id)),
    });
    const settled = await state();
    // As if the process died after sending, before its transaction committed.
    await db.update(marketplaceReviewOutbox).set({ deliveredAt: null }).where(eq(marketplaceReviewOutbox.clientId, client.id));

    const again = await drainMarketplaceReviewOutbox({ sinks: capture.sinks });
    assert.deepEqual([again.delivered, again.failed], [first.length, 0]);
    assert.deepEqual(capture.take(), first);
    assert.deepEqual(capture.revoked, [externalBot.id, externalBot.id]);
    assert.deepEqual(await state(), settled);
    assert.ok((await outboxOf(db, [client.id])).every((row) => row.deliveredAt !== null && row.attempts === 2));
  } finally {
    capture.restore();
  }
});

test("one App's rows go in order, and a row that fails holds back only its own App's later rows until it goes", async ({ db }) => {
  const [appA, appB] = [randomUUID(), randomUUID()];
  const [s1, s2, s3, s4] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const removedAgent = randomUUID();
  const insert = (clientId: string, kind: "app_bot_removed" | "permission_updates_changed", serverId: string, agentId: string | null = null) =>
    db.insert(marketplaceReviewOutbox).values({ clientId, kind, serverId, agentId, cause: "fixture" }).returning();
  const [a1] = await insert(appA, "permission_updates_changed", s1);
  await insert(appB, "permission_updates_changed", s2);
  await insert(appA, "app_bot_removed", s3, removedAgent);
  await insert(appA, "permission_updates_changed", s4);

  const sent: string[] = [];
  let failNext = true;
  const sinks: MarketplaceReviewSideEffectSinks = {
    async appBotRemoved(bot) { sent.push(`bot ${bot.serverId} ${bot.agentId}`); },
    permissionUpdatesChanged(serverId) {
      if (serverId === s1 && failNext) {
        failNext = false;
        throw new Error("socket adapter unavailable");
      }
      sent.push(`ping ${serverId}`);
    },
  };

  // App A has the oldest row, so it goes first; its first row fails and the rest of A waits; B goes.
  assert.deepEqual(await drainMarketplaceReviewOutbox({ sinks }), { apps: 2, busy: 0, delivered: 1, failed: 1 });
  assert.deepEqual(sent.splice(0), [`ping ${s2}`]);
  const [failed] = await db.select().from(marketplaceReviewOutbox).where(eq(marketplaceReviewOutbox.id, a1!.id));
  assert.deepEqual([failed!.deliveredAt, failed!.attempts, failed!.lastError], [null, 1, "socket adapter unavailable"]);
  assert.equal((await outboxOf(db, [appA])).filter((row) => row.deliveredAt === null).length, 3);

  // Next pass: A in seq order.
  assert.deepEqual(await drainMarketplaceReviewOutbox({ sinks }), { apps: 1, busy: 0, delivered: 3, failed: 0 });
  assert.deepEqual(sent, [`ping ${s1}`, `bot ${s3} ${removedAgent}`, `ping ${s4}`]);
  const rows = await outboxOf(db, [appA]);
  assert.deepEqual(rows.map((row) => [row.attempts, row.lastError, row.deliveredAt !== null]), [[2, null, true], [1, null, true], [1, null, true]]);
});

test("the backlog gauges report the oldest undelivered row's age and the count, 0 once delivered", async ({ db }) => {
  resetMarketplaceReviewOutboxBacklogForTests();
  const now = Date.now();
  await db.insert(marketplaceReviewOutbox).values([
    { clientId: randomUUID(), kind: "permission_updates_changed", serverId: randomUUID(), cause: "fixture", createdAt: new Date(now - 240_000) },
    { clientId: randomUUID(), kind: "permission_updates_changed", serverId: randomUUID(), cause: "fixture", createdAt: new Date(now - 30_000) },
    { clientId: randomUUID(), kind: "permission_updates_changed", serverId: randomUUID(), cause: "fixture", createdAt: new Date(now - 900_000), deliveredAt: new Date(now - 899_000) },
  ]);
  const gauge = async (metric: typeof marketplaceReviewOutboxUndeliveredRows) => (await metric.get()).values[0]?.value;

  await reportMarketplaceReviewOutboxBacklog(() => now);
  assert.deepEqual([await gauge(marketplaceReviewOutboxOldestUndeliveredAgeSeconds), await gauge(marketplaceReviewOutboxUndeliveredRows)], [240, 2]);

  await db.update(marketplaceReviewOutbox).set({ deliveredAt: new Date(now) });
  await reportMarketplaceReviewOutboxBacklog(() => now + 60_000);
  assert.deepEqual([await gauge(marketplaceReviewOutboxOldestUndeliveredAgeSeconds), await gauge(marketplaceReviewOutboxUndeliveredRows)], [0, 0]);
  resetMarketplaceReviewOutboxBacklogForTests();
});

// ── Retention: the hourly maintenance's prune_delivered_marketplace_review_outbox ──

const DAY_MS = 24 * 60 * 60 * 1000;
const retentionNow = new Date("2026-11-05T09:00:00Z");

/** One row created `createdDaysAgo` days before retentionNow, delivered `deliveredDaysAgo` days before it (null: undelivered). */
async function outboxRow(db: Database, createdDaysAgo: number, deliveredDaysAgo: number | null) {
  const [row] = await db.insert(marketplaceReviewOutbox).values({
    clientId: randomUUID(),
    kind: "permission_updates_changed",
    serverId: randomUUID(),
    cause: "fixture",
    createdAt: new Date(retentionNow.getTime() - createdDaysAgo * DAY_MS),
    deliveredAt: deliveredDaysAgo === null ? null : new Date(retentionNow.getTime() - deliveredDaysAgo * DAY_MS),
  }).returning({ id: marketplaceReviewOutbox.id });
  return row!.id;
}

async function remainingOutbox(db: Database, ids: string[]): Promise<string[]> {
  const rows = await db.select({ id: marketplaceReviewOutbox.id }).from(marketplaceReviewOutbox).where(inArray(marketplaceReviewOutbox.id, ids));
  return rows.map((row) => row.id).sort();
}

test("retention deletes rows delivered over 30 days ago, in batches; rows delivered since and undelivered rows of any age stay", async ({ db }) => {
  const sink = new MemoryTraceSink();
  setDefaultTraceTracer(new BasicTracer({ sink }));
  try {
    const deliveredLongAgo = [await outboxRow(db, 45, 45), await outboxRow(db, 31, 31), await outboxRow(db, 400, 90)];
    const deliveredRecently = [await outboxRow(db, 29, 29), await outboxRow(db, 1, 0)];
    // Created long ago, delivered only lately: it counts from its delivery.
    const lateDelivery = await outboxRow(db, 60, 10);
    const undelivered = [await outboxRow(db, 400, null), await outboxRow(db, 45, null), await outboxRow(db, 0, null)];
    const kept = [...deliveredRecently, lateDelivery, ...undelivered];

    const result = await pruneDeliveredMarketplaceReviewOutbox({ now: retentionNow, batchSize: 2, pauseMs: 0 });

    assert.equal(result.deleted, 3);
    // 2 (full), 1 (done).
    assert.equal(result.batches, 2);
    assert.equal(result.yielded, false);
    assert.deepEqual(await remainingOutbox(db, [...deliveredLongAgo, ...kept]), [...kept].sort());
    const events = sink.getAllLogEvents().filter((event) => event.name === "marketplace_review_outbox.retention");
    assert.equal(events.length, 1);
    assert.equal(events[0]!.attrs?.deleted, 3);
    assert.equal(events[0]!.attrs?.batches, 2);
    assert.equal(events[0]!.attrs?.yielded, false);

    const again = await pruneDeliveredMarketplaceReviewOutbox({ now: retentionNow, batchSize: 2, pauseMs: 0 });
    assert.deepEqual([again.deleted, again.batches], [0, 1]);
    assert.deepEqual(await remainingOutbox(db, kept), [...kept].sort());
  } finally {
    setDefaultTraceTracer(null);
  }
});

test("retention stops when the time budget runs out and resumes on the next tick", async ({ db }) => {
  const deliveredLongAgo = [await outboxRow(db, 40, 40), await outboxRow(db, 50, 50), await outboxRow(db, 60, 60)];
  const undelivered = await outboxRow(db, 90, null);

  // No budget: one batch, then the tick stops.
  const first = await pruneDeliveredMarketplaceReviewOutbox({ now: retentionNow, batchSize: 2, pauseMs: 0, budgetMs: 0 });
  assert.deepEqual([first.deleted, first.batches], [2, 1]);
  assert.equal((await remainingOutbox(db, deliveredLongAgo)).length, 1);

  const second = await pruneDeliveredMarketplaceReviewOutbox({ now: retentionNow, batchSize: 2, pauseMs: 0 });
  assert.deepEqual([second.deleted, second.batches], [1, 1]);
  assert.deepEqual(await remainingOutbox(db, [...deliveredLongAgo, undelivered]), [undelivered]);
});

// ── End to end: App Admin's entry, App Admin's role, the worker ─────────────

/** Runs the call as App Admin's role, holding only what the reconciler grants it. */
async function asAppAdmin<T>(db: Database, call: () => Promise<T>): Promise<T> {
  await db.execute(sql.raw(`SET ROLE ${APP_ADMIN_OPERATOR_ROLE}`));
  try {
    return await call();
  } finally {
    await db.execute(sql`RESET ROLE`);
  }
}

async function untilDelivered(db: Database, clientIds: string[]) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const rows = await outboxOf(db, clientIds);
    if (rows.length > 0 && rows.every((row) => row.deliveredAt !== null)) return rows;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail("the worker did not deliver the rows");
}

test("decisions through App Admin's entries, under App Admin's role, reach clients once the worker runs", async ({ db, seed }) => {
  await db.execute(sql.raw(`CREATE ROLE ${APP_ADMIN_OPERATOR_ROLE} NOLOGIN`));
  const { rows: [reconciled] } = await db.execute<{ reconciled: boolean }>(sql`SELECT public.reconcile_app_admin_privileges() AS reconciled`);
  assert.equal(reconciled?.reconciled, true);
  const admin = await botiverseAdmin(seed, db);

  // An offline approval with a bot on another Server, and a permission approval whose source installation subscribed to its own event.
  const offline = await marketplaceApp(seed, db, "unpublish_requested");
  await install(db, { serverId: offline.source.id, clientId: offline.client.id, userId: offline.publisher.id });
  const external = await installedElsewhere(seed, db, offline.client.id);
  const externalBot = await bot(db, external.installation);
  const permission = await permissionApp(seed, db, [OWN]);

  const capture = captured([externalBot.id]);
  let worker: { stop(): void } | null = null;
  try {
    await asAppAdmin(db, async () => {
      await publishEntry(db, offline.client.id, "approve", "unpublish_requested", admin.id);
      await permissionEntry(db, permission.client.id, permission.pendingRevisionId, admin.id);
    });
    // Decided: the bot's keys are already revoked and the installation keeps its event; no client has been told.
    const [credential] = await db.select({ revokedAt: agentCredentials.revokedAt }).from(agentCredentials).where(eq(agentCredentials.agentId, externalBot.id));
    assert.ok(credential?.revokedAt);
    assert.deepEqual((await installRow(db, permission.sourceInstall!.id)).subscribedEvents, [OWN, "server.plan_changed"]);
    assert.deepEqual(capture.frames, []);

    // Sentinels: the worker's own backlog read, after its drain, replaces them.
    marketplaceReviewOutboxUndeliveredRows.set(-1);
    marketplaceReviewOutboxOldestUndeliveredAgeSeconds.set(-1);
    worker = startMarketplaceReviewOutboxWorker({ sinks: capture.sinks, intervalMs: 60_000 });
    await untilDelivered(db, [offline.client.id, permission.client.id]);
    for (let attempt = 0; attempt < 200 && (await marketplaceReviewOutboxOldestUndeliveredAgeSeconds.get()).values[0]?.value === -1; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    worker.stop();
    worker = null;
    // Nothing waits any more.
    assert.deepEqual(
      [(await marketplaceReviewOutboxOldestUndeliveredAgeSeconds.get()).values[0]?.value, (await marketplaceReviewOutboxUndeliveredRows.get()).values[0]?.value],
      [0, 0],
    );

    assert.deepEqual(capture.take(), [
      agentDeleted(external.server.id, externalBot.id),
      ...[offline.source.id, external.server.id].sort().map(ping),
      ping(permission.source.id),
    ]);
    assert.deepEqual(capture.revoked, [externalBot.id]);
  } finally {
    worker?.stop();
    capture.restore();
    resetMarketplaceReviewOutboxBacklogForTests();
  }
});
