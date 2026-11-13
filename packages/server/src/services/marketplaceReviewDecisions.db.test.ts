import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, sql } from "drizzle-orm";
import type { Database, DatabaseExecutor } from "../db/index";
import {
  externalAppRegistrations,
  integrationAuditEvents,
  oauthAppLinkPreviews,
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
import { createOAuthClient } from "./oauthService";
import { addMember } from "./serverService";

// The review decision functions of migration marketplace_review_decider_gate,
// called directly: the card URL (action endpoint) body, the gate, and the
// gated app_admin_* entries App Admin calls (it decides every card URL review;
// Raft has no review route since #proj-apps task #19). The publish body has
// its own tests (marketplacePublishReview.db.test.ts).

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

/** A person with this role in Botiverse; the entries accept owner and admin. */
async function botiverseHuman(seed: Seed, db: Database, role: "owner" | "admin" | "member" | "guest" = "admin") {
  await botiverse(seed, db);
  const human = await seed.human();
  if (role === "guest") await seedBoundGuest({ serverId: BOTIVERSE_SERVER_ID, userId: human.id }, db);
  else await db.insert(serverMembers).values({ serverId: BOTIVERSE_SERVER_ID, userId: human.id, role });
  return human;
}

type CardArgs = { clientId: string | null; decision: string | null; expected: string | null; reason?: string | null };
type Actor = { actorType: string | null; actorId: string | null };
type PublishArgs = { clientId: string | null; decision: string | null; expectedStatus: string | null; reason?: string | null };

async function result(db: DatabaseExecutor, query: ReturnType<typeof sql>): Promise<Record<string, unknown>> {
  const { rows } = await db.execute<{ result: Record<string, unknown> }>(query);
  return rows[0]!.result;
}

/** The card URL body, as the server calls it. */
const cardBody = (db: DatabaseExecutor, args: CardArgs & { reviewerId: string | null }) => result(db, sql`SELECT public.marketplace_decide_action_endpoint_review(
  ${args.clientId}::uuid, ${args.decision}::text, ${args.expected}::text, ${args.reviewerId}::uuid, ${args.reason ?? null}::text
) AS result`);

/** The card URL entry, as App Admin calls it. */
const cardEntry = (db: DatabaseExecutor, args: CardArgs & Actor) => result(db, sql`SELECT public.app_admin_decide_action_endpoint_review(
  ${args.clientId}::uuid, ${args.decision}::text, ${args.expected}::text, ${args.actorType}::text, ${args.actorId}::uuid, ${args.reason ?? null}::text
) AS result`);

const publishBody = (db: DatabaseExecutor, args: PublishArgs & Actor) => result(db, sql`SELECT public.marketplace_decide_publish_review(
  ${args.clientId}::uuid, ${args.decision}::text, ${args.expectedStatus}::text, ${args.actorType}::text, ${args.actorId}::uuid, ${args.reason ?? null}::text
) AS result`);

const publishEntry = (db: DatabaseExecutor, args: PublishArgs & Actor) => result(db, sql`SELECT public.app_admin_decide_publish_review(
  ${args.clientId}::uuid, ${args.decision}::text, ${args.expectedStatus}::text, ${args.actorType}::text, ${args.actorId}::uuid, ${args.reason ?? null}::text
) AS result`);

/** The gate alone (owner-only): the actor's user id, or its refusal. */
const gate = async (db: DatabaseExecutor, actor: Actor) => {
  const { rows } = await db.execute<{ decider: string }>(sql`SELECT public.marketplace_review_require_decider(${actor.actorType}::text, ${actor.actorId}::uuid) AS decider`);
  return rows[0]!.decider;
};

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

/** A published App whose link-preview registration has an action endpoint waiting for review. */
async function cardApp(seed: Seed, db: Database, state: { live?: boolean; pending?: boolean } = {}) {
  const publisher = await seed.human();
  const source = await seed.server({ owner: publisher });
  const { client } = await createOAuthClient({
    serverId: source.id,
    createdByUserId: publisher.id,
    clientId: `cards-${randomUUID().slice(0, 8)}`,
    name: "Cards Fixture",
    description: "Cards that ask a person to confirm.",
    appType: "third_party_global",
  });
  await db.update(oauthClients).set({ publishStatus: "published" }).where(eq(oauthClients.id, client.id));
  const origin = `https://${randomUUID().slice(0, 8)}.example.test`;
  const live = state.live ? `${origin}/actions` : null;
  const pending = state.pending === false ? null : `${origin}/actions-next`;
  const [preview] = await db.insert(oauthAppLinkPreviews).values({
    clientId: client.id, origin, endpoint: `${origin}/preview`, paths: ["/x/*"],
    actionEndpoint: live, pendingActionEndpoint: pending, pendingActionEndpointRequestedAt: pending ? new Date(Date.now() - 60_000) : null,
    actionEndpointRejectReason: "an older rejection", updatedAt: new Date(Date.now() - 60_000),
  }).returning();
  return { source, client, origin, live, pending, preview: preview! };
}

async function marketplaceApp(seed: Seed, db: Database, publishStatus: "publish_requested" | "in_review" | "unpublish_requested") {
  const publisher = await seed.human();
  const source = await seed.server({ owner: publisher });
  const { client } = await createOAuthClient({
    serverId: source.id,
    createdByUserId: publisher.id,
    clientId: `review-${randomUUID().slice(0, 8)}`,
    name: "Review Fixture",
    description: "An App under marketplace review.",
    appType: "third_party_global",
  });
  await db.update(oauthClients).set({ publishStatus }).where(eq(oauthClients.id, client.id));
  return { publisher, source, client };
}

const preview = async (db: Database, clientId: string) =>
  (await db.select().from(oauthAppLinkPreviews).where(eq(oauthAppLinkPreviews.clientId, clientId)))[0]!;

async function reviewedAudits(db: Database, clientId: string) {
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
    .where(and(eq(integrationAuditEvents.clientId, clientId), eq(integrationAuditEvents.eventType, "app.action_endpoint_reviewed")))
    .orderBy(desc(integrationAuditEvents.createdAt));
}

/** What a refused decision must leave as it was. */
async function world(db: Database) {
  const total = async (table: typeof oauthClientInstalls | typeof integrationAuditEvents) => (await db.select({ n: count() }).from(table))[0]!.n;
  return {
    previews: await db.select().from(oauthAppLinkPreviews).orderBy(asc(oauthAppLinkPreviews.clientId)),
    clients: await db.select({
      id: oauthClients.id, publishStatus: oauthClients.publishStatus, appType: oauthClients.appType,
      listed: oauthClients.humanMarketplaceVisible, reviewedAt: oauthClients.publishReviewedAt, reviewedBy: oauthClients.publishReviewedByUserId,
    }).from(oauthClients).orderBy(asc(oauthClients.id)),
    installs: await total(oauthClientInstalls),
    audits: await total(integrationAuditEvents),
  };
}

test("card URL approval puts the pending endpoint in force under a new revision, clears the request, and audits as the server did", async ({ db, seed }) => {
  const { source, client, pending, preview: before } = await cardApp(seed, db, { live: true });
  const reviewer = await seed.human();

  const decided = await cardBody(db, { clientId: client.id, decision: "approve", expected: pending, reviewerId: reviewer.id });

  const after = await preview(db, client.id);
  assert.deepEqual(decided, { clientId: client.id, decision: "approve", actionEndpoint: pending, revision: after.revision });
  assert.deepEqual(
    { live: after.actionEndpoint, pending: after.pendingActionEndpoint, requestedAt: after.pendingActionEndpointRequestedAt, rejectReason: after.actionEndpointRejectReason },
    { live: pending, pending: null, requestedAt: null, rejectReason: null },
  );
  assert.notEqual(after.revision, before.revision, "approval voids outstanding card handles");
  assert.ok(after.updatedAt > before.updatedAt);
  // Everything else on the registration is untouched.
  assert.deepEqual(
    { origin: after.origin, endpoint: after.endpoint, paths: after.paths, verifiedAt: after.verifiedAt, suspendedAt: after.suspendedAt },
    { origin: before.origin, endpoint: before.endpoint, paths: before.paths, verifiedAt: before.verifiedAt, suspendedAt: before.suspendedAt },
  );
  // recordIntegrationAuditEvent's row for the same call.
  assert.deepEqual(await reviewedAudits(db, client.id), [{
    serverId: source.id, clientId: client.id, eventCategory: "registration", outcome: "success", source: "api",
    actorType: "human", actorId: reviewer.id, requesterType: null, requesterId: null,
    subjectType: "app", subjectId: client.id, targetType: "app", targetId: client.id,
    correlationId: null, requestId: null, metadata: { clientKey: client.clientId, decision: "approve" }, diff: null,
  }]);
});

test("card URL rejection keeps the endpoint in force and the revision, and stores the reason trimmed as JavaScript trims", async ({ db, seed }) => {
  const { client, live, pending, preview: before } = await cardApp(seed, db, { live: true });
  const reviewer = await seed.human();

  const decided = await cardBody(db, {
    clientId: client.id, decision: "reject", expected: pending, reviewerId: reviewer.id, reason: " 　 Same path with a version suffix only\n\t",
  });

  const after = await preview(db, client.id);
  assert.deepEqual(decided, { clientId: client.id, decision: "reject", actionEndpoint: live, revision: before.revision });
  assert.deepEqual(
    { live: after.actionEndpoint, pending: after.pendingActionEndpoint, requestedAt: after.pendingActionEndpointRequestedAt, rejectReason: after.actionEndpointRejectReason, revision: after.revision },
    { live, pending: null, requestedAt: null, rejectReason: "Same path with a version suffix only", revision: before.revision },
  );
  assert.ok(after.updatedAt > before.updatedAt);
  const [audit] = await reviewedAudits(db, client.id);
  assert.deepEqual([audit?.actorId, audit?.metadata], [reviewer.id, { clientKey: client.clientId, decision: "reject" }]);

  // A reason of exactly 2000 characters after trimming is accepted.
  const second = await cardApp(seed, db);
  await cardBody(db, { clientId: second.client.id, decision: "reject", expected: second.pending, reviewerId: reviewer.id, reason: ` ${"y".repeat(2000)} ` });
  assert.equal((await preview(db, second.client.id)).actionEndpointRejectReason?.length, 2000);
});

test("the card URL body validates every argument and gives each refusal its own SQLSTATE, changing nothing", async ({ db, seed }) => {
  const { client, origin, pending } = await cardApp(seed, db, { live: true });
  const reviewer = await seed.human();
  const retired = await seed.human();
  await db.update(users).set({ retiredAt: new Date() }).where(eq(users.id, retired.id));
  const idle = await cardApp(seed, db, { live: true, pending: false });
  const unregistered = await marketplaceApp(seed, db, "publish_requested");
  const ok = { clientId: client.id, decision: "approve", expected: pending, reviewerId: reviewer.id } as CardArgs & { reviewerId: string | null };
  const reject = { ...ok, decision: "reject", reason: "Needs a stable path" };

  const cases: Array<[string, CardArgs & { reviewerId: string | null }, string]> = [
    ["no App id", { ...ok, clientId: null }, "RVW01"],
    ["no reviewer", { ...ok, reviewerId: null }, "RVW01"],
    ["unknown decision", { ...ok, decision: "publish" }, "RVW01"],
    ["no decision", { ...ok, decision: null }, "RVW01"],
    ["no expected endpoint", { ...ok, expected: null }, "RVW01"],
    ["empty expected endpoint", { ...ok, expected: "" }, "RVW01"],
    ["blank expected endpoint", { ...ok, expected: "  　\n" }, "RVW01"],
    ["expected endpoint over 2000 characters", { ...ok, expected: `${origin}/${"a".repeat(2000)}` }, "RVW01"],
    ["a reason with approve", { ...ok, reason: "fine" }, "RVW01"],
    ["an empty reason with approve", { ...ok, reason: "" }, "RVW01"],
    ["reject without a reason", { ...reject, reason: null }, "RVW01"],
    ["reject with a blank reason", { ...reject, reason: " 　﻿\n" }, "RVW01"],
    ["reject reason over 2000 characters", { ...reject, reason: "x".repeat(2001) }, "RVW01"],
    ["unknown reviewer", { ...ok, reviewerId: randomUUID() }, "RVW01"],
    ["retired reviewer", { ...ok, reviewerId: retired.id }, "RVW01"],
    ["unknown App", { ...ok, clientId: randomUUID() }, "RVW02"],
    ["an App without a link-preview registration", { ...ok, clientId: unregistered.client.id }, "RVW04"],
    ["nothing waiting for review", { ...ok, clientId: idle.client.id, expected: `${origin}/actions-next` }, "RVW04"],
    ["a different endpoint than the one waiting", { ...ok, expected: `${origin}/actions-other` }, "RVW05"],
    ["the pending endpoint with different case", { ...ok, expected: pending!.toUpperCase() }, "RVW05"],
    ["the pending endpoint with a trailing space", { ...ok, expected: `${pending} ` }, "RVW05"],
    ["a reject of a different endpoint", { ...reject, expected: `${origin}/actions` }, "RVW05"],
  ];
  const before = await world(db);
  for (const [name, args, code] of cases) {
    assert.equal(await refusal(() => cardBody(db, args)), code, name);
  }
  assert.deepEqual(await world(db), before);

  // The stale refusal carries the endpoint waiting now, for the server's 409.
  const stale = await failure(() => cardBody(db, { ...ok, expected: `${origin}/actions-other` }));
  assert.deepEqual([stale.code, JSON.parse(stale.detail ?? "null")], ["RVW05", { pending }]);
});

test("only a person who is a Botiverse owner or admin now passes either entry; everyone else is refused and nothing changes", async ({ db, seed }) => {
  const card = await cardApp(seed, db);
  const publish = await marketplaceApp(seed, db, "publish_requested");
  const owner = await botiverseHuman(seed, db, "owner");
  const admin = await botiverseHuman(seed, db, "admin");

  // An agent is refused even when it is an admin of Botiverse.
  const agent = await createAgent(card.source.id, "review-agent", { runtime: "claude", model: "sonnet" });
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

  const refused: Array<[string, Actor, string]> = [
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
  const cardDecision = { clientId: card.client.id, decision: "approve", expected: card.pending };
  const publishDecision = { clientId: publish.client.id, decision: "approve", expectedStatus: "publish_requested" };
  const before = await world(db);
  for (const [name, actor, code] of refused) {
    // The gate answers by itself (the bodies would refuse a retired or unknown user too).
    assert.equal(await refusal(() => gate(db, actor)), code, `gate: ${name}`);
    assert.equal(await refusal(() => cardEntry(db, { ...cardDecision, ...actor })), code, `card URL: ${name}`);
    assert.equal(await refusal(() => publishEntry(db, { ...publishDecision, ...actor })), code, `publish: ${name}`);
  }
  assert.deepEqual(await world(db), before);

  // Botiverse soft-deleted: its owners and admins are refused too.
  await db.update(servers).set({ deletedAt: new Date() }).where(eq(servers.id, BOTIVERSE_SERVER_ID));
  for (const [name, actor] of [["owner", owner], ["admin", admin]] as const) {
    assert.equal(await refusal(() => gate(db, { actorType: "human", actorId: actor.id })), "RVW07", `gate: ${name} of a deleted Botiverse`);
    assert.equal(await refusal(() => cardEntry(db, { ...cardDecision, actorType: "human", actorId: actor.id })), "RVW07", `card URL: ${name} of a deleted Botiverse`);
    assert.equal(await refusal(() => publishEntry(db, { ...publishDecision, actorType: "human", actorId: actor.id })), "RVW07", `publish: ${name} of a deleted Botiverse`);
  }
  assert.deepEqual(await world(db), before);
  await db.update(servers).set({ deletedAt: null }).where(eq(servers.id, BOTIVERSE_SERVER_ID));

  // An owner and an admin both may; each decision names its person.
  const secondCard = await cardApp(seed, db);
  const secondPublish = await marketplaceApp(seed, db, "publish_requested");
  for (const [actor, cardFixture, publishFixture] of [[owner, card, publish], [admin, secondCard, secondPublish]] as const) {
    assert.equal(await gate(db, { actorType: "human", actorId: actor.id }), actor.id);
    const decided = await cardEntry(db, { clientId: cardFixture.client.id, decision: "approve", expected: cardFixture.pending, actorType: "human", actorId: actor.id });
    assert.equal(decided.actionEndpoint, cardFixture.pending);
    assert.equal((await reviewedAudits(db, cardFixture.client.id))[0]?.actorId, actor.id);
    const published = await publishEntry(db, { clientId: publishFixture.client.id, decision: "approve", expectedStatus: "publish_requested", actorType: "human", actorId: actor.id });
    assert.equal(published.status, "published");
    const [row] = await db.select({ by: oauthClients.publishReviewedByUserId }).from(oauthClients).where(eq(oauthClients.id, publishFixture.client.id));
    assert.equal(row?.by, actor.id);
  }
});

test("the entries check the decider before they touch the App, and hold the decider's membership row until the decision commits", async ({ db, seed }) => {
  const card = await cardApp(seed, db);
  const publish = await marketplaceApp(seed, db, "publish_requested");
  const admin = await botiverseHuman(seed, db);
  const bystander = await botiverseHuman(seed, db);
  const member = await botiverseHuman(seed, db, "member");

  // Inputs the bodies would refuse: a refused actor is told it may not decide, not what the App's state is.
  const cardInputs: Array<[string, CardArgs, string]> = [
    ["unknown App", { clientId: randomUUID(), decision: "approve", expected: card.pending }, "RVW02"],
    ["bad decision", { clientId: card.client.id, decision: "publish", expected: card.pending }, "RVW01"],
    ["stale endpoint", { clientId: card.client.id, decision: "approve", expected: `${card.origin}/elsewhere` }, "RVW05"],
  ];
  const publishInputs: Array<[string, PublishArgs, string]> = [
    ["unknown App", { clientId: randomUUID(), decision: "approve", expectedStatus: "publish_requested" }, "RVW02"],
    ["bad decision", { clientId: publish.client.id, decision: "publish", expectedStatus: "publish_requested" }, "RVW01"],
    ["stale status", { clientId: publish.client.id, decision: "approve", expectedStatus: "in_review" }, "RVW05"],
  ];
  for (const [name, args, bodyCode] of cardInputs) {
    assert.equal(await refusal(() => cardEntry(db, { ...args, actorType: "human", actorId: member.id })), "RVW07", `card URL, member: ${name}`);
    assert.equal(await refusal(() => cardEntry(db, { ...args, actorType: "human", actorId: admin.id })), bodyCode, `card URL, admin: ${name}`);
  }
  for (const [name, args, bodyCode] of publishInputs) {
    assert.equal(await refusal(() => publishEntry(db, { ...args, actorType: "human", actorId: member.id })), "RVW07", `publish, member: ${name}`);
    assert.equal(await refusal(() => publishEntry(db, { ...args, actorType: "human", actorId: admin.id })), bodyCode, `publish, admin: ${name}`);
  }

  // The deciding transaction has locked the decider's Botiverse membership
  // row (its xmax is the transaction's id), and nobody else's.
  const membershipLockedBy = async (tx: DatabaseExecutor, userId: string) => {
    const { rows } = await tx.execute<{ locked: boolean }>(sql`SELECT m.xmax::text = (pg_catalog.txid_current() % 4294967296)::text AS locked
      FROM public.server_members m WHERE m.server_id = ${BOTIVERSE_SERVER_ID}::uuid AND m.user_id = ${userId}::uuid`);
    return rows[0]?.locked;
  };
  await db.transaction(async (tx) => {
    await cardEntry(tx, { clientId: card.client.id, decision: "approve", expected: card.pending, actorType: "human", actorId: admin.id });
    assert.equal(await membershipLockedBy(tx, admin.id), true, "card URL entry");
    assert.equal(await membershipLockedBy(tx, bystander.id), false);
  });
  await db.transaction(async (tx) => {
    await publishEntry(tx, { clientId: publish.client.id, decision: "approve", expectedStatus: "publish_requested", actorType: "human", actorId: admin.id });
    assert.equal(await membershipLockedBy(tx, admin.id), true, "publish entry");
    assert.equal(await membershipLockedBy(tx, bystander.id), false);
  });
});

test("the publish entry returns marketplace_decide_publish_review's result and refusals unchanged", async ({ db, seed }) => {
  const admin = await botiverseHuman(seed, db);
  const actor = { actorType: "human", actorId: admin.id };

  const viaEntry = await marketplaceApp(seed, db, "in_review");
  const direct = await marketplaceApp(seed, db, "in_review");
  const entryResult = await publishEntry(db, { clientId: viaEntry.client.id, decision: "approve", expectedStatus: "in_review", ...actor });
  const bodyResult = await publishBody(db, { clientId: direct.client.id, decision: "approve", expectedStatus: "in_review", ...actor });
  assert.equal(entryResult.clientId, viaEntry.client.id);
  assert.deepEqual({ ...entryResult, clientId: null }, { ...bodyResult, clientId: null });
  assert.equal(entryResult.status, "published");

  const offline = await marketplaceApp(seed, db, "unpublish_requested");
  const kept = await publishEntry(db, { clientId: offline.client.id, decision: "reject", expectedStatus: "unpublish_requested", reason: "  keep listed  ", ...actor });
  assert.equal(kept.status, "published");
  const [row] = await db.select({ reason: oauthClients.publishRejectionReason }).from(oauthClients).where(eq(oauthClients.id, offline.client.id));
  assert.equal(row?.reason, "keep listed");

  const { publisher, source, client } = await marketplaceApp(seed, db, "publish_requested");
  const privateApp = (await createOAuthClient({ serverId: source.id, createdByUserId: publisher.id, name: "Private", appType: "third_party_global" })).client;
  const platformApp = (await createOAuthClient({ serverId: source.id, createdByUserId: publisher.id, name: "Platform", appType: "third_party_global" })).client;
  await db.update(oauthClients).set({ publishStatus: "publish_requested" }).where(eq(oauthClients.id, platformApp.id));
  await db.insert(externalAppRegistrations).values({
    id: randomUUID(), oauthClientId: platformApp.id, provider: "slack", environment: "test", state: "active",
    providerAppId: `A_${randomUUID().slice(0, 8)}`, providerOAuthClientId: `platform-${randomUUID().slice(0, 8)}`,
    capabilityManifestVersion: 1, capabilityManifestHash: `manifest-${randomUUID().slice(0, 8)}`, requiredCapabilities: ["channel_events"],
  });
  const blank = (await createOAuthClient({ serverId: source.id, createdByUserId: publisher.id, name: "Blank", appType: "third_party_global" })).client;
  await db.update(oauthClients).set({ publishStatus: "publish_requested", description: "  　\n" }).where(eq(oauthClients.id, blank.id));
  const ok: PublishArgs = { clientId: client.id, decision: "approve", expectedStatus: "publish_requested" };
  const cases: Array<[string, PublishArgs, string]> = [
    ["no App id", { ...ok, clientId: null }, "RVW01"],
    ["unknown decision", { ...ok, decision: "publish" }, "RVW01"],
    ["expected status not a request", { ...ok, expectedStatus: "published" }, "RVW01"],
    ["reason with approve", { ...ok, reason: "fine" }, "RVW01"],
    ["reason over 1000 characters", { ...ok, decision: "reject", reason: "x".repeat(1001) }, "RVW01"],
    ["unknown App", { ...ok, clientId: randomUUID() }, "RVW02"],
    ["platform-managed App", { ...ok, clientId: platformApp.id }, "RVW03"],
    ["no open request", { ...ok, clientId: privateApp.id }, "RVW04"],
    ["request moved since shown", { ...ok, expectedStatus: "in_review" }, "RVW05"],
    ["publishing without a description", { ...ok, clientId: blank.id }, "RVW06"],
  ];
  const before = await world(db);
  for (const [name, args, code] of cases) {
    const viaEntryRefusal = await failure(() => publishEntry(db, { ...args, ...actor }));
    const directRefusal = await failure(() => publishBody(db, { ...args, ...actor }));
    assert.equal(viaEntryRefusal.code, code, name);
    assert.deepEqual(viaEntryRefusal, directRefusal, name);
  }
  assert.deepEqual(await world(db), before);
});

test("the card URL entry returns the body's result and refusals unchanged", async ({ db, seed }) => {
  const admin = await botiverseHuman(seed, db, "owner");
  const actor = { actorType: "human", actorId: admin.id };
  const { client, origin, pending, live } = await cardApp(seed, db, { live: true });
  const idle = await cardApp(seed, db, { pending: false });

  const cases: Array<[string, CardArgs, string]> = [
    ["no expected endpoint", { clientId: client.id, decision: "approve", expected: null }, "RVW01"],
    ["a reason with approve", { clientId: client.id, decision: "approve", expected: pending, reason: "fine" }, "RVW01"],
    ["reject without a reason", { clientId: client.id, decision: "reject", expected: pending }, "RVW01"],
    ["unknown App", { clientId: randomUUID(), decision: "approve", expected: pending }, "RVW02"],
    ["nothing waiting", { clientId: idle.client.id, decision: "approve", expected: pending }, "RVW04"],
    ["stale endpoint", { clientId: client.id, decision: "approve", expected: `${origin}/elsewhere` }, "RVW05"],
  ];
  const before = await world(db);
  for (const [name, args, code] of cases) {
    const viaEntryRefusal = await failure(() => cardEntry(db, { ...args, ...actor }));
    const directRefusal = await failure(() => cardBody(db, { ...args, reviewerId: admin.id }));
    assert.equal(viaEntryRefusal.code, code, name);
    assert.deepEqual(viaEntryRefusal, directRefusal, name);
  }
  assert.deepEqual(await world(db), before);

  const rejected = await cardEntry(db, { clientId: client.id, decision: "reject", expected: pending, reason: " Needs a stable path ", ...actor });
  const after = await preview(db, client.id);
  assert.deepEqual(rejected, { clientId: client.id, decision: "reject", actionEndpoint: live, revision: after.revision });
  assert.deepEqual([after.pendingActionEndpoint, after.actionEndpointRejectReason], [null, "Needs a stable path"]);
  assert.deepEqual((await reviewedAudits(db, client.id)).map((audit) => [audit.actorType, audit.actorId, audit.metadata]), [
    ["human", admin.id, { clientKey: client.clientId, decision: "reject" }],
  ]);
});

test("the gate and the card URL body are owner-only invoker-rights functions, the entries owner-only definer-rights ones, all with a pinned search_path", async ({ db }) => {
  const { rows } = await db.execute<{ name: string; definer: boolean; config: string[] | null; public_execute: boolean }>(sql`
    SELECT p.oid::pg_catalog.regprocedure::text AS name, p.prosecdef AS definer, p.proconfig AS config,
           pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE') AS public_execute
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname IN (
       'marketplace_review_require_decider', 'marketplace_decide_action_endpoint_review',
       'app_admin_decide_publish_review', 'app_admin_decide_action_endpoint_review')
     ORDER BY 1`);
  const pinned = ["search_path=pg_catalog, pg_temp"];
  assert.deepEqual(rows, [
    { name: "app_admin_decide_action_endpoint_review(uuid,text,text,text,uuid,text)", definer: true, config: pinned, public_execute: false },
    { name: "app_admin_decide_publish_review(uuid,text,text,text,uuid,text)", definer: true, config: pinned, public_execute: false },
    { name: "marketplace_decide_action_endpoint_review(uuid,text,text,uuid,text)", definer: false, config: pinned, public_execute: false },
    { name: "marketplace_review_require_decider(text,uuid)", definer: false, config: pinned, public_execute: false },
  ]);

  // The lock mode is not observable on one connection: the membership row is
  // taken FOR SHARE (a concurrent demotion or removal waits; another decision
  // by the same person does not).
  const { rows: [gate] } = await db.execute<{ source: string }>(sql`
    SELECT p.prosrc AS source FROM pg_catalog.pg_proc p
     WHERE p.oid = 'public.marketplace_review_require_decider(text, uuid)'::pg_catalog.regprocedure`);
  assert.match(gate!.source, /\n\s+FOR SHARE OF m;\n/);
});
