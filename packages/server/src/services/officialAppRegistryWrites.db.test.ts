import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, sql } from "drizzle-orm";
import type { Database } from "../db/index";
import {
  agents,
  externalAppRegistrations,
  integrationAuditEvents,
  oauthClientInstalls,
  oauthClients,
  officialAppAutoInstallStates,
  officialAppAutoInstallTransitions,
  officialAppRegistry,
  serverAgentMembers,
  serverMembers,
  servers,
} from "../db/schema";
import { dbTest as test } from "../test/integration/dbTest";
import { seedBoundGuest } from "../test/guestFixture";
import type { createSeed } from "../test/integration/seed";
import { createAgent } from "./agentService";
import {
  INTEGRATION_AUDIT_EVENT_TYPES,
  sanitizeIntegrationAuditDiff,
  sanitizeIntegrationAuditMetadata,
  type IntegrationAuditEventType,
} from "./integrationAuditService";
import { isApprovedOfficialAppClient, projectOfficialAppDiscovery } from "./officialAppAutoInstallService";

// public.official_app_registry_register / _update, called directly: the
// contract App Admin relies on (no server route writes the registry). The
// server reads the registry on every request, so a function write is what
// the next isApprovedOfficialAppClient / discovery / auto-install sees.

type Seed = ReturnType<typeof createSeed>;

// Botiverse, the platform's own Server: only its current human owners and
// admins may change the registry (official_app_registry_admin_gate).
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

/** A person with this role in Botiverse; the registry accepts owner and admin. */
async function botiverseHuman(seed: Seed, db: Database, role: "owner" | "admin" | "member" | "guest" = "admin") {
  await botiverse(seed, db);
  const human = await seed.human();
  if (role === "guest") await seedBoundGuest({ serverId: BOTIVERSE_SERVER_ID, userId: human.id }, db);
  else await db.insert(serverMembers).values({ serverId: BOTIVERSE_SERVER_ID, userId: human.id, role });
  return human;
}
type RegisterArgs = { clientId: string | null; purpose: string | null; actorType: string | null; actorId: string | null };
type UpdateArgs = {
  clientId: string | null;
  expectedRevision: number | null;
  status?: string | null;
  purpose?: string | null;
  actorType: string | null;
  actorId: string | null;
};

const ORIGINAL_PRIMARY = process.env.RAFT_OFFICIAL_PUBLISHER_SERVER_ID;
const ORIGINAL_EXTRA = process.env.RAFT_OFFICIAL_PUBLISHER_SERVER_IDS;

afterEach(() => {
  if (ORIGINAL_PRIMARY === undefined) delete process.env.RAFT_OFFICIAL_PUBLISHER_SERVER_ID;
  else process.env.RAFT_OFFICIAL_PUBLISHER_SERVER_ID = ORIGINAL_PRIMARY;
  if (ORIGINAL_EXTRA === undefined) delete process.env.RAFT_OFFICIAL_PUBLISHER_SERVER_IDS;
  else process.env.RAFT_OFFICIAL_PUBLISHER_SERVER_IDS = ORIGINAL_EXTRA;
});

async function register(db: Database, args: RegisterArgs): Promise<Record<string, unknown>> {
  const { rows } = await db.execute<{ result: Record<string, unknown> }>(sql`SELECT public.official_app_registry_register(
    ${args.clientId}::uuid, ${args.purpose}::text, ${args.actorType}::text, ${args.actorId}::uuid
  ) AS result`);
  return rows[0]!.result;
}

async function update(db: Database, args: UpdateArgs): Promise<Record<string, unknown>> {
  const { rows } = await db.execute<{ result: Record<string, unknown> }>(sql`SELECT public.official_app_registry_update(
    ${args.clientId}::uuid, ${args.expectedRevision}::integer, ${args.status ?? null}::text, ${args.purpose ?? null}::text,
    ${args.actorType}::text, ${args.actorId}::uuid
  ) AS result`);
  return rows[0]!.result;
}

/** The SQLSTATE the call fails with. */
async function refusal(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    for (let current: unknown = error; current; current = (current as { cause?: unknown }).cause) {
      const code = (current as { code?: unknown }).code;
      if (typeof code === "string") return code;
    }
    throw error;
  }
  assert.fail("expected the call to be refused");
}

/** A Marketplace App on its own Server, published unless told otherwise. */
async function app(seed: Seed, db: Database, values: Partial<typeof oauthClients.$inferInsert> = {}) {
  const publisher = await seed.human();
  const source = await seed.server({ owner: publisher });
  const [client] = await db.insert(oauthClients).values({
    serverId: source.id,
    createdByUserId: publisher.id,
    clientId: `official-${randomUUID().slice(0, 8)}`,
    clientSecretHash: "fixture-value-not-a-credential",
    name: "Official Fixture",
    description: "An App that may become official.",
    appType: "third_party_global",
    publishStatus: "published",
    ...values,
  }).returning();
  return { publisher, source, client: client! };
}

async function entry(db: Database, clientId: string) {
  const [row] = await db.select({
    clientKey: officialAppRegistry.clientKey,
    publisherServerId: officialAppRegistry.publisherServerId,
    autoInstall: officialAppRegistry.autoInstall,
    purpose: officialAppRegistry.purpose,
    status: officialAppRegistry.status,
    revision: officialAppRegistry.revision,
    createdByUserId: officialAppRegistry.createdByUserId,
    updatedByUserId: officialAppRegistry.updatedByUserId,
  }).from(officialAppRegistry).where(eq(officialAppRegistry.oauthClientId, clientId));
  return row ?? null;
}

async function audits(db: Database, clientId: string) {
  return db.select({
    eventType: integrationAuditEvents.eventType,
    eventCategory: integrationAuditEvents.eventCategory,
    outcome: integrationAuditEvents.outcome,
    source: integrationAuditEvents.source,
    actorType: integrationAuditEvents.actorType,
    actorId: integrationAuditEvents.actorId,
    serverId: integrationAuditEvents.serverId,
    targetType: integrationAuditEvents.targetType,
    targetId: integrationAuditEvents.targetId,
    metadata: integrationAuditEvents.metadata,
    diff: integrationAuditEvents.diff,
  }).from(integrationAuditEvents)
    .where(and(eq(integrationAuditEvents.clientId, clientId), sql`${integrationAuditEvents.eventType} LIKE 'official_app.%'`))
    .orderBy(asc(integrationAuditEvents.createdAt), asc(sql`(${integrationAuditEvents.metadata}->>'revision')::int`));
}

/** The server's audit allowlists keep every key the function wrote, and the event type is one it knows. */
function assertServerReadable(event: { eventType: string; metadata: Record<string, unknown>; diff: Record<string, unknown> | null }) {
  assert.ok((INTEGRATION_AUDIT_EVENT_TYPES as readonly string[]).includes(event.eventType), event.eventType);
  const eventType = event.eventType as IntegrationAuditEventType;
  assert.deepEqual(sanitizeIntegrationAuditMetadata(eventType, event.metadata), event.metadata, `${eventType} metadata`);
  assert.deepEqual(sanitizeIntegrationAuditDiff(event.diff), event.diff, `${eventType} diff`);
}

/** What a registry write could install for one App. */
async function deliveries(db: Database, clientId: string) {
  return {
    installs: await db.select({ serverId: oauthClientInstalls.serverId }).from(oauthClientInstalls).where(eq(oauthClientInstalls.clientId, clientId)),
    autoInstallStates: await db.select({ serverId: officialAppAutoInstallStates.serverId }).from(officialAppAutoInstallStates).where(eq(officialAppAutoInstallStates.clientId, clientId)),
    autoInstallTransitions: await db.select({ serverId: officialAppAutoInstallTransitions.serverId }).from(officialAppAutoInstallTransitions).where(eq(officialAppAutoInstallTransitions.clientId, clientId)),
  };
}

/** Everything a registry write could touch, across all Apps. */
async function world(db: Database) {
  const total = async (table: typeof oauthClientInstalls | typeof officialAppAutoInstallStates | typeof officialAppAutoInstallTransitions | typeof integrationAuditEvents) =>
    (await db.select({ n: count() }).from(table))[0]!.n;
  return {
    registry: await db.select().from(officialAppRegistry).orderBy(asc(officialAppRegistry.clientKey)),
    installs: await total(oauthClientInstalls),
    autoInstallStates: await total(officialAppAutoInstallStates),
    autoInstallTransitions: await total(officialAppAutoInstallTransitions),
    audits: await total(integrationAuditEvents),
  };
}

test("register adds a pending_review entry at revision 1 with auto install off, audited, and installs nothing", async ({ db, seed }) => {
  const operator = await botiverseHuman(seed, db, "owner");
  const { source, client } = await app(seed, db);
  for (let i = 0; i < 3; i++) await seed.server({ owner: await seed.human() });
  const before = await world(db);

  const result = await register(db, {
    clientId: client.id, purpose: "　 Where Raft agents ship code.  ", actorType: "human", actorId: operator.id,
  });

  assert.deepEqual(result, {
    clientId: client.id,
    clientKey: client.clientId,
    publisherServerId: source.id,
    previousStatus: null,
    status: "pending_review",
    revision: 1,
    autoInstall: false,
    purpose: "Where Raft agents ship code.",
  });
  assert.deepEqual(await entry(db, client.id), {
    clientKey: client.clientId,
    publisherServerId: source.id,
    autoInstall: false,
    purpose: "Where Raft agents ship code.",
    status: "pending_review",
    revision: 1,
    createdByUserId: operator.id,
    updatedByUserId: operator.id,
  });
  const after = await world(db);
  assert.deepEqual(
    { installs: after.installs, states: after.autoInstallStates, transitions: after.autoInstallTransitions, audits: after.audits },
    { installs: before.installs, states: before.autoInstallStates, transitions: before.autoInstallTransitions, audits: before.audits + 1 },
  );

  const [event] = await audits(db, client.id);
  assert.deepEqual(event, {
    eventType: "official_app.registry_created",
    eventCategory: "registration",
    outcome: "success",
    source: "api",
    actorType: "human",
    actorId: operator.id,
    serverId: source.id,
    targetType: "app",
    targetId: client.id,
    metadata: {
      clientKey: client.clientId,
      publisherServerId: source.id,
      revision: 1,
      autoInstall: false,
      status: "pending_review",
      purpose: "Where Raft agents ship code.",
    },
    diff: null,
  });
  assertServerReadable(event!);
});

test("approving makes the App official for the server's next read, and installs it on no Server, existing or new", async ({ db, seed }) => {
  const operator = await botiverseHuman(seed, db);
  const { source, client } = await app(seed, db);
  const existing = await seed.server({ owner: await seed.human() });
  // The primary root is the one Server whose official Apps auto-install.
  process.env.RAFT_OFFICIAL_PUBLISHER_SERVER_ID = source.id;
  const human = { actorType: "human", actorId: operator.id } as const;

  await register(db, { clientId: client.id, purpose: "Official fixture.", ...human });
  assert.equal(await isApprovedOfficialAppClient(client.id), false);

  const approved = await update(db, { clientId: client.id, expectedRevision: 1, status: "approved", ...human });
  assert.deepEqual(approved, {
    clientId: client.id,
    clientKey: client.clientId,
    publisherServerId: source.id,
    previousStatus: "pending_review",
    status: "approved",
    revision: 2,
    autoInstall: false,
    purpose: "Official fixture.",
  });
  // No cache in between: the next read is official.
  assert.equal(await isApprovedOfficialAppClient(client.id), true);
  assert.deepEqual(
    await projectOfficialAppDiscovery({ clientId: client.id, sourceServerId: source.id, clientKey: client.clientId }),
    { official: true, purpose: "Official fixture." },
  );

  // A Server created afterwards runs the provisioning auto-install
  // (createServer), which installs only auto_install entries.
  const created = await seed.server({ owner: await seed.human() });
  assert.deepEqual(await deliveries(db, client.id), { installs: [], autoInstallStates: [], autoInstallTransitions: [] },
    `nothing on ${existing.id} or ${created.id}`);

  const [, event] = await audits(db, client.id);
  assert.deepEqual(
    { eventType: event!.eventType, eventCategory: event!.eventCategory, metadata: event!.metadata, diff: event!.diff },
    {
      eventType: "official_app.registry_updated",
      eventCategory: "registration",
      metadata: {
        clientKey: client.clientId,
        publisherServerId: source.id,
        revision: 2,
        autoInstall: false,
        status: "approved",
        purpose: "Official fixture.",
        changedFields: ["status"],
      },
      diff: { status: { before: "pending_review", after: "approved" } },
    },
  );
  assertServerReadable(event!);
});

test("disabling keeps the entry and every installation, ends official status, and re-enabling approves it again", async ({ db, seed }) => {
  const operator = await botiverseHuman(seed, db);
  const { source, client } = await app(seed, db);
  process.env.RAFT_OFFICIAL_PUBLISHER_SERVER_ID = source.id;
  const installer = await seed.human();
  const elsewhere = await seed.server({ owner: installer });
  const [installation] = await db.insert(oauthClientInstalls).values({
    serverId: elsewhere.id, clientId: client.id, installedByUserId: installer.id, approvedScopes: ["openid"],
  }).returning();
  const human = { actorType: "human", actorId: operator.id } as const;
  await register(db, { clientId: client.id, purpose: "Official fixture.", ...human });
  await update(db, { clientId: client.id, expectedRevision: 1, status: "approved", ...human });

  const disabled = await update(db, { clientId: client.id, expectedRevision: 2, status: "disabled", ...human });
  assert.deepEqual({ previousStatus: disabled.previousStatus, status: disabled.status, revision: disabled.revision }, { previousStatus: "approved", status: "disabled", revision: 3 });
  assert.equal((await entry(db, client.id))?.status, "disabled");
  assert.equal(await isApprovedOfficialAppClient(client.id), false);
  assert.deepEqual(await db.select().from(oauthClientInstalls).where(eq(oauthClientInstalls.clientId, client.id)), [installation]);

  const removed = (await audits(db, client.id))[2]!;
  assert.deepEqual(
    { eventType: removed.eventType, eventCategory: removed.eventCategory, metadata: removed.metadata, diff: removed.diff },
    {
      eventType: "official_app.registry_removed",
      eventCategory: "revocation",
      // registry_removed's allowlist has no changedFields; the diff says what changed.
      metadata: { clientKey: client.clientId, publisherServerId: source.id, revision: 3, autoInstall: false, status: "disabled", purpose: "Official fixture." },
      diff: { status: { before: "approved", after: "disabled" } },
    },
  );
  assertServerReadable(removed);

  const reenabled = await update(db, { clientId: client.id, expectedRevision: 3, status: "approved", ...human });
  assert.deepEqual({ previousStatus: reenabled.previousStatus, status: reenabled.status, revision: reenabled.revision }, { previousStatus: "disabled", status: "approved", revision: 4 });
  assert.equal(await isApprovedOfficialAppClient(client.id), true);
  const restored = (await audits(db, client.id))[3]!;
  assert.deepEqual([restored.eventType, restored.metadata.changedFields, restored.diff], [
    "official_app.registry_updated", ["status"], { status: { before: "disabled", after: "approved" } },
  ]);

  // A pending entry can be disabled too, and stays.
  const { client: pending } = await app(seed, db);
  await register(db, { clientId: pending.id, purpose: "Never approved.", ...human });
  await update(db, { clientId: pending.id, expectedRevision: 1, status: "disabled", ...human });
  assert.deepEqual([(await entry(db, pending.id))?.status, (await entry(db, pending.id))?.revision], ["disabled", 2]);
});

test("only a person who is a Botiverse owner or admin now may change the registry", async ({ db, seed }) => {
  const { source, client } = await app(seed, db);
  const admin = await botiverseHuman(seed, db);
  const human = { actorType: "human", actorId: admin.id } as const;
  await register(db, { clientId: client.id, purpose: "Registered by an admin.", ...human });
  const { client: unregistered } = await app(seed, db);

  // An agent is refused even when it is an admin of Botiverse.
  const agent = await createAgent(source.id, "registry-operator", { runtime: "claude", model: "sonnet" });
  await db.insert(serverAgentMembers).values({ serverId: BOTIVERSE_SERVER_ID, agentId: agent.id, role: "admin" }).onConflictDoNothing();
  const outsider = await seed.human();
  const otherServerAdmin = await seed.human();
  await seed.server({ owner: otherServerAdmin });
  const member = await botiverseHuman(seed, db, "member");
  const guest = await botiverseHuman(seed, db, "guest");
  const demoted = await botiverseHuman(seed, db);
  await db.update(serverMembers).set({ role: "member" })
    .where(and(eq(serverMembers.serverId, BOTIVERSE_SERVER_ID), eq(serverMembers.userId, demoted.id)));
  const removed = await botiverseHuman(seed, db);
  await db.delete(serverMembers)
    .where(and(eq(serverMembers.serverId, BOTIVERSE_SERVER_ID), eq(serverMembers.userId, removed.id)));

  const refusedActors: Array<[string, { actorType: string; actorId: string }]> = [
    ["an agent", { actorType: "agent", actorId: agent.id }],
    ["a person outside Botiverse", { actorType: "human", actorId: outsider.id }],
    ["an owner of another Server", { actorType: "human", actorId: otherServerAdmin.id }],
    ["a Botiverse member", { actorType: "human", actorId: member.id }],
    ["a Botiverse guest", { actorType: "human", actorId: guest.id }],
    ["an admin demoted to member", { actorType: "human", actorId: demoted.id }],
    ["an admin removed from Botiverse", { actorType: "human", actorId: removed.id }],
  ];
  const before = await world(db);
  for (const [name, actor] of refusedActors) {
    assert.equal(await refusal(() => register(db, { clientId: unregistered.id, purpose: "A purpose.", ...actor })), "ORG07", `register: ${name}`);
    assert.equal(await refusal(() => update(db, { clientId: client.id, expectedRevision: 1, status: "approved", ...actor })), "ORG07", `approve: ${name}`);
    assert.equal(await refusal(() => update(db, { clientId: client.id, expectedRevision: 1, purpose: "Edited.", ...actor })), "ORG07", `purpose: ${name}`);
  }
  assert.deepEqual(await world(db), before);

  // An owner and an admin both may; the entry and audit name each of them.
  const owner = await botiverseHuman(seed, db, "owner");
  await update(db, { clientId: client.id, expectedRevision: 1, status: "approved", actorType: "human", actorId: owner.id });
  const row = await entry(db, client.id);
  assert.deepEqual([row?.status, row?.createdByUserId, row?.updatedByUserId], ["approved", admin.id, owner.id]);
  const events = await audits(db, client.id);
  assert.deepEqual(events.map((event) => [event.eventType, event.actorType, event.actorId]), [
    ["official_app.registry_created", "human", admin.id],
    ["official_app.registry_updated", "human", owner.id],
  ]);
});

test("an entry written with auto install on has it turned off by its next change, and says so", async ({ db, seed }) => {
  const operator = await botiverseHuman(seed, db);
  const { source, client } = await app(seed, db);
  await db.insert(officialAppRegistry).values({
    oauthClientId: client.id, clientKey: client.clientId, publisherServerId: source.id,
    autoInstall: true, status: "approved", purpose: "Written by Feature Flag Admin.",
  });

  const result = await update(db, { clientId: client.id, expectedRevision: 1, purpose: "Edited in App Admin.", actorType: "human", actorId: operator.id });
  assert.deepEqual([result.autoInstall, result.revision, (await entry(db, client.id))?.autoInstall], [false, 2, false]);
  const [event] = await audits(db, client.id);
  assert.deepEqual([event!.metadata.changedFields, event!.diff], [
    ["autoInstall", "purpose"],
    { autoInstall: { before: true, after: false }, purpose: { before: "Written by Feature Flag Admin.", after: "Edited in App Admin." } },
  ]);
  assertServerReadable(event!);
});

test("every refusal carries its SQLSTATE and changes nothing", async ({ db, seed }) => {
  const operator = await botiverseHuman(seed, db);
  const human = { actorType: "human", actorId: operator.id } as const;
  const retired = await seed.human({ retiredAt: new Date() });
  const { source, client: registered } = await app(seed, db);
  const deletedAgent = await createAgent(source.id, "deleted-operator", { runtime: "claude", model: "sonnet" });
  await db.update(agents).set({ deletedAt: new Date() }).where(eq(agents.id, deletedAgent.id));
  await register(db, { clientId: registered.id, purpose: "Registered.", ...human });
  await update(db, { clientId: registered.id, expectedRevision: 1, status: "approved", ...human });

  const { client: unregistered } = await app(seed, db);
  const { client: builtin } = await app(seed, db, { appType: "slock_builtin" });
  const { client: serverLocal } = await app(seed, db, { appType: "server_local" });
  const { client: requested } = await app(seed, db, { publishStatus: "publish_requested" });
  const { client: oddKey } = await app(seed, db, { clientId: `Odd_Key_${randomUUID().slice(0, 8)}` });
  const { client: platform } = await app(seed, db);
  await db.insert(externalAppRegistrations).values({
    oauthClientId: platform.id, provider: "slack", environment: "test",
    providerAppId: `A_${randomUUID().slice(0, 8)}`, providerOAuthClientId: `platform-${randomUUID().slice(0, 8)}`,
    capabilityManifestVersion: 1, capabilityManifestHash: `manifest-${randomUUID().slice(0, 8)}`,
  });
  // Registered and disabled, then the App went private: it cannot be re-enabled.
  const { client: wentPrivate } = await app(seed, db);
  await register(db, { clientId: wentPrivate.id, purpose: "Went private.", ...human });
  await update(db, { clientId: wentPrivate.id, expectedRevision: 1, status: "disabled", ...human });
  await db.update(oauthClients).set({ publishStatus: "private" }).where(eq(oauthClients.id, wentPrivate.id));

  const reg = (args: Partial<RegisterArgs>) => () => register(db, { clientId: unregistered.id, purpose: "A purpose.", ...human, ...args });
  const upd = (args: Partial<UpdateArgs>) => () => update(db, { clientId: registered.id, expectedRevision: 2, ...human, ...args });
  const cases: Array<[string, () => Promise<unknown>, string]> = [
    ["register: no App id", reg({ clientId: null }), "ORG01"],
    ["register: no actor id", reg({ actorId: null }), "ORG01"],
    ["register: actor type user", reg({ actorType: "user" }), "ORG01"],
    ["register: no purpose", reg({ purpose: null }), "ORG01"],
    ["register: blank purpose", reg({ purpose: " 　\t" }), "ORG01"],
    ["register: 161-character purpose", reg({ purpose: "x".repeat(161) }), "ORG01"],
    ["register: two-line purpose", reg({ purpose: "one\ntwo" }), "ORG01"],
    ["register: unknown human", reg({ actorId: randomUUID() }), "ORG01"],
    ["register: retired human", reg({ actorId: retired.id }), "ORG01"],
    ["register: deleted agent", reg({ actorType: "agent", actorId: deletedAgent.id }), "ORG07"],
    ["register: a human id as an agent", reg({ actorType: "agent", actorId: operator.id }), "ORG07"],
    ["register: unknown App", reg({ clientId: randomUUID() }), "ORG02"],
    ["register: slock_builtin", reg({ clientId: builtin.id }), "ORG03"],
    ["register: external registration", reg({ clientId: platform.id }), "ORG03"],
    ["register: server_local", reg({ clientId: serverLocal.id }), "ORG03"],
    ["register: not published", reg({ clientId: requested.id }), "ORG03"],
    ["register: client key the registry does not accept", reg({ clientId: oddKey.id }), "ORG03"],
    ["register: already registered", reg({ clientId: registered.id }), "ORG04"],
    ["register: already registered and disabled", reg({ clientId: wentPrivate.id }), "ORG04"],
    ["update: no App id", upd({ clientId: null, status: "disabled" }), "ORG01"],
    ["update: no revision", upd({ expectedRevision: null, status: "disabled" }), "ORG01"],
    ["update: revision 0", upd({ expectedRevision: 0, status: "disabled" }), "ORG01"],
    ["update: back to pending_review", upd({ status: "pending_review" }), "ORG01"],
    ["update: unknown status", upd({ status: "deleted" }), "ORG01"],
    ["update: nothing to change", upd({}), "ORG01"],
    ["update: blank purpose", upd({ purpose: "  " }), "ORG01"],
    ["update: retired human", upd({ status: "disabled", actorId: retired.id }), "ORG01"],
    ["update: App without an entry", upd({ clientId: unregistered.id, expectedRevision: 1, status: "approved" }), "ORG02"],
    ["update: unknown App", upd({ clientId: randomUUID(), expectedRevision: 1, status: "approved" }), "ORG02"],
    ["update: stale revision", upd({ expectedRevision: 1, status: "disabled" }), "ORG05"],
    ["update: future revision", upd({ expectedRevision: 3, status: "disabled" }), "ORG05"],
    ["update: approve an approved entry", upd({ status: "approved" }), "ORG06"],
    ["update: same purpose, once trimmed", upd({ purpose: " Registered. " }), "ORG06"],
    ["update: same status with a new purpose", upd({ status: "approved", purpose: "New." }), "ORG06"],
    ["update: disable a disabled entry", upd({ clientId: wentPrivate.id, status: "disabled" }), "ORG06"],
    ["update: re-enable a private App", upd({ clientId: wentPrivate.id, status: "approved" }), "ORG03"],
  ];

  const before = await world(db);
  for (const [name, run, code] of cases) {
    assert.equal(await refusal(run), code, name);
  }
  assert.deepEqual(await world(db), before);

  // A re-enable refused for eligibility is a disable's business only: the
  // private App's entry can still have its purpose edited.
  const edited = await update(db, { clientId: wentPrivate.id, expectedRevision: 2, purpose: "Still private.", ...human });
  assert.deepEqual([edited.status, edited.revision], ["disabled", 3]);
});

test("two operators shown the same revision: the second write is refused, the first one stands", async ({ db, seed }) => {
  const first = await botiverseHuman(seed, db);
  const second = await botiverseHuman(seed, db, "owner");
  const { client } = await app(seed, db);
  await register(db, { clientId: client.id, purpose: "Shown to both.", actorType: "human", actorId: first.id });

  await update(db, { clientId: client.id, expectedRevision: 1, status: "approved", actorType: "human", actorId: first.id });
  assert.equal(await refusal(() => update(db, { clientId: client.id, expectedRevision: 1, status: "disabled", actorType: "human", actorId: second.id })), "ORG05");
  assert.deepEqual([(await entry(db, client.id))?.status, (await entry(db, client.id))?.revision, (await entry(db, client.id))?.updatedByUserId], ["approved", 2, first.id]);

  const [latest] = await db.select({ eventType: integrationAuditEvents.eventType, actorId: integrationAuditEvents.actorId })
    .from(integrationAuditEvents).where(eq(integrationAuditEvents.clientId, client.id)).orderBy(desc(integrationAuditEvents.createdAt)).limit(1);
  assert.deepEqual(latest, { eventType: "official_app.registry_updated", actorId: first.id });
});
