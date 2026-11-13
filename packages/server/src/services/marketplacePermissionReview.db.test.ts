import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, asc, count, eq, sql } from "drizzle-orm";
import type { Database, DatabaseExecutor } from "../db/index";
import {
  externalAppRegistrations,
  integrationAuditEvents,
  oauthAppInstallationTokens,
  oauthAppPermissionRevisions,
  oauthClientInstalls,
  oauthClients,
  serverAgentMembers,
  serverMembers,
  servers,
  users,
} from "../db/schema";
import { dbTest as test } from "../test/integration/dbTest";
import { seedBoundGuest } from "../test/guestFixture";
import type { createSeed } from "../test/integration/seed";
import { createAgent } from "./agentService";
import { createAppOutboundPermissionRevision } from "./appOutboundPermissionService";
import { createOAuthClient } from "./oauthService";
import { addMember } from "./serverService";

// The permission update review functions of migration
// marketplace_permission_review_fn, called directly: the body and the gated
// entry App Admin calls (it decides every permission update review; Raft has
// no review route since #proj-apps task #19). API tests that need an approved
// update (installApprovedScopes, appPermissionUpdateNotice,
// appOutboundPermissionSubscriptionSync, integrations.api) call the body
// through test/marketplaceReviewFixture.ts; the gate itself is covered with
// the other entries in marketplaceReviewDecisions.

type Seed = ReturnType<typeof createSeed>;

// Botiverse, the platform's own Server: only its current human owners and
// admins may decide reviews through the entries.
const BOTIVERSE_SERVER_ID = "95f993fa-2a68-4797-b8ae-7beb7d984ada";

async function botiverse(seed: Seed, db: Database) {
  const [existing] = await db.select({ id: servers.id }).from(servers).where(eq(servers.id, BOTIVERSE_SERVER_ID));
  if (existing) return existing;
  const owner = await seed.human();
  const [created] = await db.insert(servers).values({
    id: BOTIVERSE_SERVER_ID, name: "Botiverse", slug: `botiverse-${randomUUID().slice(0, 8)}`, ownerId: owner.id,
  }).returning({ id: servers.id });
  return created!;
}

/** A person with this role in Botiverse; the entry accepts owner and admin. */
async function botiverseHuman(seed: Seed, db: Database, role: "owner" | "admin" | "member" | "guest" = "admin") {
  await botiverse(seed, db);
  const human = await seed.human();
  if (role === "guest") await seedBoundGuest({ serverId: BOTIVERSE_SERVER_ID, userId: human.id }, db);
  else await db.insert(serverMembers).values({ serverId: BOTIVERSE_SERVER_ID, userId: human.id, role });
  return human;
}

type BodyArgs = { clientId: string | null; expected: string | null; reviewerId: string | null };
type EntryArgs = { clientId: string | null; expected: string | null; actorType: string | null; actorId: string | null };

async function result(db: DatabaseExecutor, query: ReturnType<typeof sql>): Promise<Record<string, unknown>> {
  const { rows } = await db.execute<{ result: Record<string, unknown> }>(query);
  return rows[0]!.result;
}

/** The body, as the server calls it. */
const approveBody = (db: DatabaseExecutor, args: BodyArgs) => result(db, sql`SELECT public.marketplace_approve_permission_review(
  ${args.clientId}::uuid, ${args.expected}::uuid, ${args.reviewerId}::uuid
) AS result`);

/** The entry, as App Admin calls it. */
const approveEntry = (db: DatabaseExecutor, args: EntryArgs) => result(db, sql`SELECT public.app_admin_approve_permission_review(
  ${args.clientId}::uuid, ${args.expected}::uuid, ${args.actorType}::text, ${args.actorId}::uuid
) AS result`);

/** The database error the call fails with: SQLSTATE and DETAIL. */
async function failure(run: () => Promise<unknown>): Promise<{ code: string; detail: string | null }> {
  try {
    await run();
  } catch (error) {
    for (let current: unknown = error; current; current = (current as { cause?: unknown }).cause) {
      const { code, detail } = current as { code?: unknown; detail?: unknown };
      if (typeof code === "string") return { code, detail: typeof detail === "string" ? detail : null };
    }
    throw error;
  }
  assert.fail("expected the call to be refused");
}

const refusal = async (run: () => Promise<unknown>) => (await failure(run)).code;

type InstallState = { approvedGroups: string[]; subscribedEvents: string[]; status?: "active" | "suspended" };

/**
 * A published App with a permission revision waiting for review (by default
 * groups agent and server, event server.plan_changed), optionally an
 * installation on its source Server holding one live installation token.
 */
async function permissionApp(seed: Seed, db: Database, options: {
  groups?: string[];
  events?: string[];
  sourceInstall?: InstallState;
  pending?: boolean;
} = {}) {
  const publisher = await seed.human();
  const source = await seed.server({ owner: publisher });
  const { client } = await createOAuthClient({
    serverId: source.id,
    createdByUserId: publisher.id,
    clientId: `perm-${randomUUID().slice(0, 8)}`,
    name: "Permission Fixture",
    description: "An App asking for more App Notifications authority.",
    appType: "third_party_global",
  });
  await db.update(oauthClients).set({ publishStatus: "published" }).where(eq(oauthClients.id, client.id));
  const install = options.sourceInstall ? await installOn(db, client.id, source.id, publisher.id, options.sourceInstall) : null;
  let pendingRevisionId: string | null = null;
  if (options.pending !== false) {
    const created = await createAppOutboundPermissionRevision({
      clientId: client.id,
      actor: { type: "human", id: publisher.id },
      groups: options.groups ?? ["agent", "server"],
      events: options.events ?? ["server.plan_changed"],
    });
    assert.equal(created?.revision.state, "pending_review");
    pendingRevisionId = created!.revision.id;
  }
  return { publisher, source, client, install, pendingRevisionId };
}

/** An installation (grant revision 3, subscription revision 5) with one live installation token. */
async function installOn(db: Database, clientId: string, serverId: string, userId: string, state: InstallState) {
  const [install] = await db.insert(oauthClientInstalls).values({
    clientId, serverId, installedByUserId: userId, status: state.status ?? "active",
    approvedGroups: state.approvedGroups, subscribedEvents: state.subscribedEvents,
    grantRevision: 3, subscriptionRevision: 5, updatedAt: new Date(Date.now() - 60_000),
  }).returning();
  await token(db, install!);
  return install!;
}

async function token(db: Database, install: typeof oauthClientInstalls.$inferSelect, revokedAt: Date | null = null) {
  const [row] = await db.insert(oauthAppInstallationTokens).values({
    installationId: install.id, clientId: install.clientId, serverId: install.serverId,
    tokenHash: `fixture-hash-${randomUUID()}`, grantRevision: install.grantRevision, effectiveGroups: install.approvedGroups,
    audience: "raft:app-installation-api", expiresAt: new Date(Date.now() + 600_000), revokedAt,
  }).returning();
  return row!;
}

const installRow = async (db: Database, id: string) =>
  (await db.select().from(oauthClientInstalls).where(eq(oauthClientInstalls.id, id)))[0]!;

const tokensOf = (db: Database, installationId: string) =>
  db.select().from(oauthAppInstallationTokens).where(eq(oauthAppInstallationTokens.installationId, installationId)).orderBy(asc(oauthAppInstallationTokens.createdAt), asc(oauthAppInstallationTokens.id));

const revisionRow = async (db: Database, id: string) =>
  (await db.select().from(oauthAppPermissionRevisions).where(eq(oauthAppPermissionRevisions.id, id)))[0]!;

const clientRow = async (db: Database, id: string) =>
  (await db.select().from(oauthClients).where(eq(oauthClients.id, id)))[0]!;

async function approvedAudits(db: Database, clientId: string) {
  return db.select({
    serverId: integrationAuditEvents.serverId,
    clientId: integrationAuditEvents.clientId,
    eventCategory: integrationAuditEvents.eventCategory,
    outcome: integrationAuditEvents.outcome,
    source: integrationAuditEvents.source,
    actorType: integrationAuditEvents.actorType,
    actorId: integrationAuditEvents.actorId,
    requesterType: integrationAuditEvents.requesterType,
    requesterId: integrationAuditEvents.requesterId,
    subjectType: integrationAuditEvents.subjectType,
    subjectId: integrationAuditEvents.subjectId,
    targetType: integrationAuditEvents.targetType,
    targetId: integrationAuditEvents.targetId,
    correlationId: integrationAuditEvents.correlationId,
    requestId: integrationAuditEvents.requestId,
    metadata: integrationAuditEvents.metadata,
    diff: integrationAuditEvents.diff,
  }).from(integrationAuditEvents)
    .where(and(eq(integrationAuditEvents.clientId, clientId), eq(integrationAuditEvents.eventType, "app.outbound_permission_approved")));
}

/** What a refused decision must leave as it was. */
async function world(db: Database) {
  return {
    revisions: await db.select().from(oauthAppPermissionRevisions).orderBy(asc(oauthAppPermissionRevisions.id)),
    clients: await db.select({
      id: oauthClients.id, appType: oauthClients.appType, currentRevisionId: oauthClients.outboundCurrentRevisionId,
      pendingRevisionId: oauthClients.outboundPendingRevisionId, groups: oauthClients.outboundCurrentGroups,
      events: oauthClients.outboundCurrentEvents, updatedAt: oauthClients.updatedAt,
    }).from(oauthClients).orderBy(asc(oauthClients.id)),
    installs: await db.select().from(oauthClientInstalls).orderBy(asc(oauthClientInstalls.id)),
    tokens: await db.select().from(oauthAppInstallationTokens).orderBy(asc(oauthAppInstallationTokens.id)),
    audits: (await db.select({ n: count() }).from(integrationAuditEvents))[0]!.n,
  };
}

/**
 * The server's "changed" test before this migration (sameSet in
 * appOutboundPermissionService): the installation's list sorted, against the
 * revision's list as stored, element by element.
 */
function serverSaysChanged(installList: readonly string[], requested: readonly string[]) {
  const sorted = [...installList].sort();
  return !(sorted.length === requested.length && sorted.every((value, index) => value === requested[index]));
}

test("approval activates the pending revision, makes it the App's authority, resyncs only the source Server's active installation, revokes its tokens when its groups changed, and audits as the server did", async ({ db, seed }) => {
  const { source, client, install, pendingRevisionId } = await permissionApp(seed, db, {
    sourceInstall: { approvedGroups: ["agent"], subscribedEvents: [] },
  });
  const reviewer = await seed.human();
  // A second live token and one revoked earlier on the source installation.
  await token(db, install!);
  const earlier = new Date(Date.now() - 3_600_000);
  await token(db, install!, earlier);
  // Another Server's installation of the same App is not the source's: untouched.
  const installer = await seed.human();
  const elsewhere = await seed.server({ owner: installer });
  const otherInstall = await installOn(db, client.id, elsewhere.id, installer.id, { approvedGroups: [], subscribedEvents: [] });
  const otherBefore = { install: await installRow(db, otherInstall.id), tokens: await tokensOf(db, otherInstall.id) };
  const clientBefore = await clientRow(db, client.id);

  const approved = await approveBody(db, { clientId: client.id, expected: pendingRevisionId, reviewerId: reviewer.id });

  assert.deepEqual(approved, {
    revisionId: pendingRevisionId, revision: 1, state: "active",
    requestedGroups: ["agent", "server"], requestedEvents: ["server.plan_changed"],
    syncedInstallCount: 1, revokedTokenCount: 2,
  });
  const revision = await revisionRow(db, pendingRevisionId!);
  assert.deepEqual([revision.state, revision.reviewedByUserId], ["active", reviewer.id]);
  assert.ok(revision.reviewedAt instanceof Date);
  const reviewedAt = revision.reviewedAt;

  const after = await clientRow(db, client.id);
  assert.deepEqual(
    { current: after.outboundCurrentRevisionId, pending: after.outboundPendingRevisionId, groups: after.outboundCurrentGroups, events: after.outboundCurrentEvents, updatedAt: after.updatedAt },
    { current: pendingRevisionId, pending: null, groups: ["agent", "server"], events: ["server.plan_changed"], updatedAt: reviewedAt },
  );
  assert.equal(after.outboundRequestRevision, clientBefore.outboundRequestRevision);
  assert.equal(after.publishStatus, clientBefore.publishStatus);

  const synced = await installRow(db, install!.id);
  assert.deepEqual(synced, {
    ...install,
    approvedRequestRevisionId: pendingRevisionId,
    approvedGroups: ["agent", "server"],
    subscribedEvents: ["server.plan_changed"],
    grantRevision: 4,
    subscriptionRevision: 6,
    updatedAt: reviewedAt,
  });
  // The live tokens are revoked at the review time; the earlier revocation stands.
  assert.deepEqual((await tokensOf(db, install!.id)).map((row) => row.revokedAt?.getTime()).sort(), [earlier.getTime(), reviewedAt!.getTime(), reviewedAt!.getTime()].sort());
  assert.deepEqual({ install: await installRow(db, otherInstall.id), tokens: await tokensOf(db, otherInstall.id) }, otherBefore);

  // recordIntegrationAuditEvent's row for the same call.
  assert.deepEqual(await approvedAudits(db, client.id), [{
    serverId: source.id, clientId: client.id, eventCategory: "scope", outcome: "success", source: "api",
    actorType: "human", actorId: reviewer.id, requesterType: null, requesterId: null,
    subjectType: "app", subjectId: client.id, targetType: "app", targetId: client.id,
    correlationId: null, requestId: null,
    metadata: { clientKey: client.clientId, revision: 1, groupCount: 2, eventCount: 1 }, diff: null,
  }]);
});

test("the counts and revisions follow what changed: events only, nothing, no source installation, a suspended one", async ({ db, seed }) => {
  const reviewer = await seed.human();
  const approve = async (app: Awaited<ReturnType<typeof permissionApp>>) =>
    approveBody(db, { clientId: app.client.id, expected: app.pendingRevisionId, reviewerId: reviewer.id });

  // Same groups, new events: the subscription revision moves, the grant and its tokens stay.
  const eventsOnly = await permissionApp(seed, db, { groups: ["server"], sourceInstall: { approvedGroups: ["server"], subscribedEvents: [] } });
  const eventsOnlyResult = await approve(eventsOnly);
  assert.deepEqual([eventsOnlyResult.syncedInstallCount, eventsOnlyResult.revokedTokenCount], [1, 0]);
  const eventsOnlyInstall = await installRow(db, eventsOnly.install!.id);
  assert.deepEqual(
    [eventsOnlyInstall.grantRevision, eventsOnlyInstall.subscriptionRevision, eventsOnlyInstall.approvedRequestRevisionId, eventsOnlyInstall.subscribedEvents],
    [3, 6, eventsOnly.pendingRevisionId, ["server.plan_changed"]],
  );
  assert.deepEqual((await tokensOf(db, eventsOnly.install!.id)).map((row) => row.revokedAt), [null]);

  // Already what the revision asks: rewritten to point at it, no revision moves.
  const unchanged = await permissionApp(seed, db, { groups: ["server"], sourceInstall: { approvedGroups: ["server"], subscribedEvents: ["server.plan_changed"] } });
  const unchangedResult = await approve(unchanged);
  assert.deepEqual([unchangedResult.syncedInstallCount, unchangedResult.revokedTokenCount], [1, 0]);
  const unchangedInstall = await installRow(db, unchanged.install!.id);
  assert.deepEqual(
    [unchangedInstall.grantRevision, unchangedInstall.subscriptionRevision, unchangedInstall.approvedRequestRevisionId],
    [3, 5, unchanged.pendingRevisionId],
  );
  assert.ok(unchangedInstall.updatedAt > unchanged.install!.updatedAt);
  assert.deepEqual((await tokensOf(db, unchanged.install!.id)).map((row) => row.revokedAt), [null]);

  // Groups only: the grant moves and its token is revoked, the subscription stays.
  const groupsOnly = await permissionApp(seed, db, { groups: ["agent", "server"], events: [], sourceInstall: { approvedGroups: ["agent"], subscribedEvents: [] } });
  const groupsOnlyResult = await approve(groupsOnly);
  assert.deepEqual([groupsOnlyResult.syncedInstallCount, groupsOnlyResult.revokedTokenCount], [1, 1]);
  const groupsOnlyInstall = await installRow(db, groupsOnly.install!.id);
  assert.deepEqual([groupsOnlyInstall.grantRevision, groupsOnlyInstall.subscriptionRevision], [4, 5]);

  // No installation on the source Server: the App's authority changes, nothing else.
  const uninstalled = await permissionApp(seed, db);
  const uninstalledResult = await approve(uninstalled);
  assert.deepEqual([uninstalledResult.syncedInstallCount, uninstalledResult.revokedTokenCount], [0, 0]);
  assert.deepEqual((await clientRow(db, uninstalled.client.id)).outboundCurrentGroups, ["agent", "server"]);

  // A suspended source installation is not resynced and keeps its token.
  const suspended = await permissionApp(seed, db, { sourceInstall: { approvedGroups: [], subscribedEvents: [], status: "suspended" } });
  const suspendedResult = await approve(suspended);
  assert.deepEqual([suspendedResult.syncedInstallCount, suspendedResult.revokedTokenCount], [0, 0]);
  assert.deepEqual(await installRow(db, suspended.install!.id), suspended.install);
  assert.deepEqual((await tokensOf(db, suspended.install!.id)).map((row) => row.revokedAt), [null]);
});

test("an installation's groups and events count as changed exactly when the server's sorted comparison said so, duplicates included", async ({ db, seed }) => {
  // [the installation's list, the revision's list as stored]
  const lists: Array<[string[], string[]]> = [
    [["server"], ["server"]],
    [["server", "server"], ["server"]],
    [["server"], ["server", "server"]],
    [["server", "agent"], ["agent", "server"]],
    [["agent", "server"], ["server", "agent"]],
    [["agent", "agent", "server"], ["agent", "server", "server"]],
    [[], []],
    [["agent"], ["agent", "server"]],
    [["agent", "server"], ["agent"]],
    [["channel", "agent", "server"], ["agent", "channel", "server"]],
  ];
  const reviewer = await seed.human();
  let changedGroups = 0;
  let changedEvents = 0;
  for (const [index, [installGroups, requestedGroups]] of lists.entries()) {
    // The events take another row of the table, so the two comparisons differ case by case.
    const [installEvents, requestedEvents] = lists[(index + 3) % lists.length]!;
    const app = await permissionApp(seed, db, { sourceInstall: { approvedGroups: installGroups, subscribedEvents: installEvents } });
    await db.update(oauthAppPermissionRevisions).set({ requestedGroups, requestedEvents })
      .where(eq(oauthAppPermissionRevisions.id, app.pendingRevisionId!));

    const approved = await approveBody(db, { clientId: app.client.id, expected: app.pendingRevisionId, reviewerId: reviewer.id });

    const groupsChanged = serverSaysChanged(installGroups, requestedGroups);
    const eventsChanged = serverSaysChanged(installEvents, requestedEvents);
    changedGroups += Number(groupsChanged);
    changedEvents += Number(eventsChanged);
    const label = `groups ${JSON.stringify(installGroups)} -> ${JSON.stringify(requestedGroups)}, events ${JSON.stringify(installEvents)} -> ${JSON.stringify(requestedEvents)}`;
    const after = await installRow(db, app.install!.id);
    assert.deepEqual(
      { grantRevision: after.grantRevision, subscriptionRevision: after.subscriptionRevision, revokedTokenCount: approved.revokedTokenCount },
      { grantRevision: groupsChanged ? 4 : 3, subscriptionRevision: eventsChanged ? 6 : 5, revokedTokenCount: groupsChanged ? 1 : 0 },
      label,
    );
    assert.deepEqual([after.approvedGroups, after.subscribedEvents], [requestedGroups, requestedEvents], label);
  }
  // Both answers occur in both columns.
  assert.ok(changedGroups > 0 && changedGroups < lists.length);
  assert.ok(changedEvents > 0 && changedEvents < lists.length);
});

test("the body validates its arguments and gives each refusal its own SQLSTATE, changing nothing", async ({ db, seed }) => {
  const { client, pendingRevisionId } = await permissionApp(seed, db, { sourceInstall: { approvedGroups: [], subscribedEvents: [] } });
  const reviewer = await seed.human();
  const retired = await seed.human();
  await db.update(users).set({ retiredAt: new Date() }).where(eq(users.id, retired.id));

  const platform = await permissionApp(seed, db);
  await db.insert(externalAppRegistrations).values({
    id: randomUUID(), oauthClientId: platform.client.id, provider: "slack", environment: "test", state: "active",
    providerAppId: `A_${randomUUID().slice(0, 8)}`, providerOAuthClientId: `platform-${randomUUID().slice(0, 8)}`,
    capabilityManifestVersion: 1, capabilityManifestHash: `manifest-${randomUUID().slice(0, 8)}`, requiredCapabilities: ["channel_events"],
  });
  const builtin = await permissionApp(seed, db);
  await db.update(oauthClients).set({ appType: "slock_builtin" }).where(eq(oauthClients.id, builtin.client.id));
  const idle = await permissionApp(seed, db, { pending: false });
  // The App still points at revisions that are no longer waiting.
  const superseded = await permissionApp(seed, db);
  await db.update(oauthAppPermissionRevisions).set({ state: "superseded" }).where(eq(oauthAppPermissionRevisions.id, superseded.pendingRevisionId!));
  const active = await permissionApp(seed, db);
  await db.update(oauthAppPermissionRevisions).set({ state: "active" }).where(eq(oauthAppPermissionRevisions.id, active.pendingRevisionId!));
  const crossed = await permissionApp(seed, db);
  const foreign = await permissionApp(seed, db);
  await db.update(oauthClients).set({ outboundPendingRevisionId: foreign.pendingRevisionId }).where(eq(oauthClients.id, crossed.client.id));

  const ok: BodyArgs = { clientId: client.id, expected: pendingRevisionId, reviewerId: reviewer.id };
  const cases: Array<[string, BodyArgs, string]> = [
    ["no App id", { ...ok, clientId: null }, "RVW01"],
    ["no reviewer", { ...ok, reviewerId: null }, "RVW01"],
    ["unknown reviewer", { ...ok, reviewerId: randomUUID() }, "RVW01"],
    ["retired reviewer", { ...ok, reviewerId: retired.id }, "RVW01"],
    ["unknown App", { ...ok, clientId: randomUUID() }, "RVW02"],
    ["unknown App, no expected revision", { ...ok, clientId: randomUUID(), expected: null }, "RVW02"],
    ["a platform-registered App", { ...ok, clientId: platform.client.id, expected: platform.pendingRevisionId }, "RVW03"],
    ["a built-in App", { ...ok, clientId: builtin.client.id, expected: null }, "RVW03"],
    ["nothing pending", { ...ok, clientId: idle.client.id, expected: null }, "RVW04"],
    ["nothing pending, a revision named", { ...ok, clientId: idle.client.id }, "RVW04"],
    ["the pointed revision was superseded", { ...ok, clientId: superseded.client.id, expected: superseded.pendingRevisionId }, "RVW04"],
    ["the pointed revision was superseded, approve-latest", { ...ok, clientId: superseded.client.id, expected: null }, "RVW04"],
    ["the pointed revision is already active", { ...ok, clientId: active.client.id, expected: active.pendingRevisionId }, "RVW04"],
    ["the pointer names another App's revision", { ...ok, clientId: crossed.client.id, expected: foreign.pendingRevisionId }, "RVW04"],
    ["a different revision than the one pending", { ...ok, expected: randomUUID() }, "RVW05"],
    ["another App's pending revision", { ...ok, expected: foreign.pendingRevisionId }, "RVW05"],
  ];
  const before = await world(db);
  for (const [name, args, code] of cases) {
    assert.equal(await refusal(() => approveBody(db, args)), code, name);
  }
  assert.deepEqual(await world(db), before);

  // The stale refusal carries the revision pending now.
  const stale = await failure(() => approveBody(db, { ...ok, expected: foreign.pendingRevisionId }));
  assert.deepEqual([stale.code, JSON.parse(stale.detail ?? "null")], ["RVW05", { pendingRevisionId }]);
});

test("without an expected revision the body approves whatever is pending; the entry refuses that", async ({ db, seed }) => {
  const reviewer = await seed.human();
  const app = await permissionApp(seed, db, { groups: ["agent"], events: [] });
  // The publisher replaces the request: the latest is the one approved.
  const replacement = await createAppOutboundPermissionRevision({
    clientId: app.client.id, actor: { type: "human", id: app.publisher.id }, groups: ["agent", "server"], events: [],
  });
  const approved = await approveBody(db, { clientId: app.client.id, expected: null, reviewerId: reviewer.id });
  assert.deepEqual([approved.revisionId, approved.revision, approved.requestedGroups], [replacement!.revision.id, 2, ["agent", "server"]]);
  assert.equal((await revisionRow(db, app.pendingRevisionId!)).state, "superseded");

  const admin = await botiverseHuman(seed, db);
  const other = await permissionApp(seed, db);
  const before = await world(db);
  const missing = await failure(() => approveEntry(db, { clientId: other.client.id, expected: null, actorType: "human", actorId: admin.id }));
  assert.deepEqual(missing, { code: "RVW01", detail: null });
  assert.deepEqual(await world(db), before);
  const viaEntry = await approveEntry(db, { clientId: other.client.id, expected: other.pendingRevisionId, actorType: "human", actorId: admin.id });
  assert.equal(viaEntry.revisionId, other.pendingRevisionId);
});

test("only a person who is a Botiverse owner or admin now passes the entry; everyone else is refused and nothing changes", async ({ db, seed }) => {
  const app = await permissionApp(seed, db, { sourceInstall: { approvedGroups: [], subscribedEvents: [] } });
  const owner = await botiverseHuman(seed, db, "owner");
  const admin = await botiverseHuman(seed, db, "admin");

  // An agent is refused even when it is an admin of Botiverse.
  const agent = await createAgent(app.source.id, "review-agent", { runtime: "claude", model: "sonnet" });
  await db.insert(serverAgentMembers).values({ serverId: BOTIVERSE_SERVER_ID, agentId: agent.id, role: "admin" }).onConflictDoNothing();
  const outsider = await seed.human();
  const otherServerOwner = await seed.human();
  const otherServer = await seed.server({ owner: otherServerOwner });
  const otherServerAdmin = await seed.human();
  await addMember(otherServer.id, otherServerAdmin.id, "admin");
  const member = await botiverseHuman(seed, db, "member");
  const guest = await botiverseHuman(seed, db, "guest");
  const demoted = await botiverseHuman(seed, db);
  await db.update(serverMembers).set({ role: "member" })
    .where(and(eq(serverMembers.serverId, BOTIVERSE_SERVER_ID), eq(serverMembers.userId, demoted.id)));
  const removed = await botiverseHuman(seed, db);
  await db.delete(serverMembers)
    .where(and(eq(serverMembers.serverId, BOTIVERSE_SERVER_ID), eq(serverMembers.userId, removed.id)));
  const retired = await botiverseHuman(seed, db, "admin");
  await db.update(users).set({ retiredAt: new Date() }).where(eq(users.id, retired.id));

  const refused: Array<[string, { actorType: string | null; actorId: string | null }, string]> = [
    ["an agent admin of Botiverse", { actorType: "agent", actorId: agent.id }, "RVW07"],
    ["a person outside Botiverse", { actorType: "human", actorId: outsider.id }, "RVW07"],
    ["the owner of another Server", { actorType: "human", actorId: otherServerOwner.id }, "RVW07"],
    ["an admin of another Server", { actorType: "human", actorId: otherServerAdmin.id }, "RVW07"],
    ["a Botiverse member", { actorType: "human", actorId: member.id }, "RVW07"],
    ["a Botiverse guest", { actorType: "human", actorId: guest.id }, "RVW07"],
    ["an admin demoted to member", { actorType: "human", actorId: demoted.id }, "RVW07"],
    ["an admin removed from Botiverse", { actorType: "human", actorId: removed.id }, "RVW07"],
    ["a retired Botiverse admin", { actorType: "human", actorId: retired.id }, "RVW01"],
    ["an unknown user", { actorType: "human", actorId: randomUUID() }, "RVW01"],
    ["a Botiverse admin's id as an agent", { actorType: "agent", actorId: admin.id }, "RVW07"],
    ["an unknown actor type", { actorType: "user", actorId: admin.id }, "RVW01"],
    ["no actor type", { actorType: null, actorId: admin.id }, "RVW01"],
    ["no actor id", { actorType: "human", actorId: null }, "RVW01"],
  ];
  const decision = { clientId: app.client.id, expected: app.pendingRevisionId };
  const before = await world(db);
  for (const [name, actor, code] of refused) {
    assert.equal(await refusal(() => approveEntry(db, { ...decision, ...actor })), code, name);
  }
  assert.deepEqual(await world(db), before);

  // Botiverse soft-deleted: its owners and admins are refused too.
  await db.update(servers).set({ deletedAt: new Date() }).where(eq(servers.id, BOTIVERSE_SERVER_ID));
  for (const [name, actor] of [["owner", owner], ["admin", admin]] as const) {
    assert.equal(await refusal(() => approveEntry(db, { ...decision, actorType: "human", actorId: actor.id })), "RVW07", `${name} of a deleted Botiverse`);
  }
  assert.deepEqual(await world(db), before);
  await db.update(servers).set({ deletedAt: null }).where(eq(servers.id, BOTIVERSE_SERVER_ID));

  // An owner and an admin both may; each approval names its person.
  const second = await permissionApp(seed, db);
  for (const [actor, fixture] of [[owner, app], [admin, second]] as const) {
    const approved = await approveEntry(db, { clientId: fixture.client.id, expected: fixture.pendingRevisionId, actorType: "human", actorId: actor.id });
    assert.deepEqual([approved.revisionId, approved.state], [fixture.pendingRevisionId, "active"]);
    assert.equal((await revisionRow(db, fixture.pendingRevisionId!)).reviewedByUserId, actor.id);
    assert.deepEqual((await approvedAudits(db, fixture.client.id)).map((audit) => [audit.actorType, audit.actorId]), [["human", actor.id]]);
  }
});

test("the entry checks the decider before it touches the App, and holds the decider's membership row until the approval commits", async ({ db, seed }) => {
  const app = await permissionApp(seed, db);
  const idle = await permissionApp(seed, db, { pending: false });
  const platform = await permissionApp(seed, db);
  await db.update(oauthClients).set({ appType: "slock_builtin" }).where(eq(oauthClients.id, platform.client.id));
  const admin = await botiverseHuman(seed, db);
  const bystander = await botiverseHuman(seed, db);
  const member = await botiverseHuman(seed, db, "member");

  // Inputs the body (or the entry) would refuse: a refused actor is told it may not decide, not what the App's state is.
  const inputs: Array<[string, { clientId: string | null; expected: string | null }, string]> = [
    ["no App id", { clientId: null, expected: app.pendingRevisionId }, "RVW01"],
    ["no expected revision", { clientId: app.client.id, expected: null }, "RVW01"],
    ["unknown App", { clientId: randomUUID(), expected: app.pendingRevisionId }, "RVW02"],
    ["platform-managed App", { clientId: platform.client.id, expected: platform.pendingRevisionId }, "RVW03"],
    ["nothing pending", { clientId: idle.client.id, expected: app.pendingRevisionId }, "RVW04"],
    ["stale revision", { clientId: app.client.id, expected: randomUUID() }, "RVW05"],
  ];
  for (const [name, args, bodyCode] of inputs) {
    assert.equal(await refusal(() => approveEntry(db, { ...args, actorType: "human", actorId: member.id })), "RVW07", `member: ${name}`);
    assert.equal(await refusal(() => approveEntry(db, { ...args, actorType: "agent", actorId: admin.id })), "RVW07", `agent: ${name}`);
    assert.equal(await refusal(() => approveEntry(db, { ...args, actorType: "human", actorId: admin.id })), bodyCode, `admin: ${name}`);
  }

  // The approving transaction has locked the decider's Botiverse membership
  // row (its xmax is the transaction's id), and nobody else's.
  const membershipLockedBy = async (tx: DatabaseExecutor, userId: string) => {
    const { rows } = await tx.execute<{ locked: boolean }>(sql`SELECT m.xmax::text = (pg_catalog.txid_current() % 4294967296)::text AS locked
      FROM public.server_members m WHERE m.server_id = ${BOTIVERSE_SERVER_ID}::uuid AND m.user_id = ${userId}::uuid`);
    return rows[0]?.locked;
  };
  await db.transaction(async (tx) => {
    await approveEntry(tx, { clientId: app.client.id, expected: app.pendingRevisionId, actorType: "human", actorId: admin.id });
    assert.equal(await membershipLockedBy(tx, admin.id), true);
    assert.equal(await membershipLockedBy(tx, bystander.id), false);
  });
});

test("the entry returns the body's result and refusals unchanged", async ({ db, seed }) => {
  const admin = await botiverseHuman(seed, db, "owner");
  const actor = { actorType: "human", actorId: admin.id };
  const { client, pendingRevisionId } = await permissionApp(seed, db);
  const idle = await permissionApp(seed, db, { pending: false });
  const superseded = await permissionApp(seed, db);
  await db.update(oauthAppPermissionRevisions).set({ state: "superseded" }).where(eq(oauthAppPermissionRevisions.id, superseded.pendingRevisionId!));
  const platform = await permissionApp(seed, db);
  await db.update(oauthClients).set({ appType: "slock_builtin" }).where(eq(oauthClients.id, platform.client.id));

  const cases: Array<[string, { clientId: string | null; expected: string | null }, string]> = [
    ["no App id", { clientId: null, expected: pendingRevisionId }, "RVW01"],
    ["unknown App", { clientId: randomUUID(), expected: pendingRevisionId }, "RVW02"],
    ["platform-managed App", { clientId: platform.client.id, expected: platform.pendingRevisionId }, "RVW03"],
    ["nothing pending", { clientId: idle.client.id, expected: pendingRevisionId }, "RVW04"],
    ["no longer pending_review", { clientId: superseded.client.id, expected: superseded.pendingRevisionId }, "RVW04"],
    ["stale revision", { clientId: client.id, expected: randomUUID() }, "RVW05"],
  ];
  const before = await world(db);
  for (const [name, args, code] of cases) {
    const viaEntryRefusal = await failure(() => approveEntry(db, { ...args, ...actor }));
    const directRefusal = await failure(() => approveBody(db, { ...args, reviewerId: admin.id }));
    assert.equal(viaEntryRefusal.code, code, name);
    assert.deepEqual(viaEntryRefusal, directRefusal, name);
  }
  assert.deepEqual(await world(db), before);

  // Twin Apps, one through the entry and one through the body: the same answer.
  const viaEntry = await permissionApp(seed, db, { sourceInstall: { approvedGroups: ["agent"], subscribedEvents: [] } });
  const direct = await permissionApp(seed, db, { sourceInstall: { approvedGroups: ["agent"], subscribedEvents: [] } });
  const entryResult = await approveEntry(db, { clientId: viaEntry.client.id, expected: viaEntry.pendingRevisionId, ...actor });
  const bodyResult = await approveBody(db, { clientId: direct.client.id, expected: direct.pendingRevisionId, reviewerId: admin.id });
  assert.equal(entryResult.revisionId, viaEntry.pendingRevisionId);
  assert.deepEqual({ ...entryResult, revisionId: null }, { ...bodyResult, revisionId: null });
  assert.deepEqual([entryResult.syncedInstallCount, entryResult.revokedTokenCount], [1, 1]);
});

test("the permission body is an owner-only invoker-rights function, its entry an owner-only definer-rights one, both with a pinned search_path", async ({ db }) => {
  const { rows } = await db.execute<{ name: string; definer: boolean; config: string[] | null; public_execute: boolean }>(sql`
    SELECT p.oid::pg_catalog.regprocedure::text AS name, p.prosecdef AS definer, p.proconfig AS config,
           pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE') AS public_execute
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname IN ('marketplace_approve_permission_review', 'app_admin_approve_permission_review')
     ORDER BY 1`);
  const pinned = ["search_path=pg_catalog, pg_temp"];
  assert.deepEqual(rows, [
    { name: "app_admin_approve_permission_review(uuid,uuid,text,uuid)", definer: true, config: pinned, public_execute: false },
    { name: "marketplace_approve_permission_review(uuid,uuid,uuid)", definer: false, config: pinned, public_execute: false },
  ]);
});
