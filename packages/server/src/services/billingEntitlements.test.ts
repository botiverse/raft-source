import { dbTest as test } from "../test/integration/dbTest.js";
import { closeTestDatabase } from "../test/integration/database.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { PRO_AGENT_SEAT_BLOCK_SIZE } from "@botiverse/raft-shared";
import { getDb } from "../db/index.js";
import { jointChannels, jointChannelServers, subscriptions, servers, users } from "../db/schema.js";
import { createAgent } from "./agentService.js";
import {
  assertAgentCapacityAvailable,
  assertJointChannelCreationCapacity,
  getJointChannelCreationEntitlement,
  getHistoryCutoff,
  getServerBillingEntitlement,
  getServerBillingUsage,
  isChannelReadOnlyByBillingFeature,
  requireTeamBillingFeature,
} from "./planService.js";
import { addMember, createServer } from "./serverService.js";
import { createChannel, getOrCreateThread } from "./channelService.js";
import { createMessage } from "./messageService.js";


afterEach(async () => {
  await closeTestDatabase();
});

async function seedUser(label: string) {
  const [user] = await getDb().insert(users).values({
    email: `${label}-${randomUUID()}@slock.test`,
    name: `${label}-${randomUUID().slice(0, 8)}`,
    displayName: label,
    passwordHash: "hash",
    emailVerified: true,
  }).returning();
  return user;
}

function futureDate() {
  return new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
}

const DURING_FULL_FEATURE_TRIAL = new Date("2026-06-14T00:00:00Z");
const AFTER_FULL_FEATURE_TRIAL = new Date("2026-06-23T12:00:00Z");

async function insertProSubscription(input: {
  serverId: string;
  ownerId: string;
  status?: "active" | "past_due" | "canceled" | "incomplete";
  packQuantity?: number;
}) {
  const packQuantity = input.packQuantity ?? 1;
  await getDb().insert(subscriptions).values({
    serverId: input.serverId,
    plan: "pro",
    provider: "stripe",
    stripeCustomerId: `cus_${randomUUID()}`,
    stripeSubscriptionId: `sub_${randomUUID()}`,
    stripeProPackItemId: `si_pro_${randomUUID()}`,
    status: input.status ?? "active",
    provisionedHumanSeats: packQuantity,
    provisionedAgentSeats: packQuantity * PRO_AGENT_SEAT_BLOCK_SIZE,
    proPackQuantity: packQuantity,
    trialFreePackQuantity: 1,
    firstPackTrialEndsAt: futureDate(),
    currentPeriodStart: new Date(),
    currentPeriodEnd: futureDate(),
    createdByUserId: input.ownerId,
    updatedByUserId: input.ownerId,
  });
}

async function createRetainedJointChannel(input: {
  hostServerId: string;
  hostOwnerId: string;
  targetServerId?: string;
  targetOwnerId?: string;
  createdAt?: Date;
}) {
  const db = getDb();
  const canonical = await createChannel(input.hostServerId, `canonical-${randomUUID()}`);
  const hostProjection = await createChannel(input.hostServerId, `host-joint-${randomUUID()}`, undefined, "joint");
  const targetProjection = input.targetServerId
    ? await createChannel(input.targetServerId, `target-joint-${randomUUID()}`, undefined, "joint")
    : null;
  const [joint] = await db.insert(jointChannels).values({
    canonicalChannelId: canonical.id,
    createdByServerId: input.hostServerId,
    createdByUserId: input.hostOwnerId,
    createdAt: input.createdAt,
  }).returning();
  await db.insert(jointChannelServers).values([
    {
      jointChannelId: joint.id,
      serverId: input.hostServerId,
      localChannelId: hostProjection.id,
      role: "host",
      joinedByUserId: input.hostOwnerId,
    },
    ...(targetProjection && input.targetServerId
      ? [{
          jointChannelId: joint.id,
          serverId: input.targetServerId,
          localChannelId: targetProjection.id,
          role: "participant" as const,
          joinedByUserId: input.targetOwnerId ?? input.hostOwnerId,
        }]
      : []),
  ]);
  return { joint, canonical, hostProjection, targetProjection };
}

test("Free history cutoff starts after the full-featured trial while Pro and internal plans are unlimited", () => {
  assert.equal(getHistoryCutoff("free", DURING_FULL_FEATURE_TRIAL), undefined);
  const cutoff = getHistoryCutoff("free", AFTER_FULL_FEATURE_TRIAL);
  assert.ok(cutoff);
  const ageDays = (AFTER_FULL_FEATURE_TRIAL.getTime() - cutoff.getTime()) / (24 * 60 * 60 * 1000);
  assert.ok(ageDays > 29.9 && ageDays < 30.1);
  assert.equal(getHistoryCutoff("pro", AFTER_FULL_FEATURE_TRIAL), undefined);
  assert.equal(getHistoryCutoff("founder", AFTER_FULL_FEATURE_TRIAL), undefined);
  assert.equal(getHistoryCutoff("partner", AFTER_FULL_FEATURE_TRIAL), undefined);
});

test("Free full-featured trial allows unlimited agents and Pro feature gates", async ({ db }) => {

  const owner = await seedUser("trial-free-owner");
  const server = await createServer("Trial Free Billing", `trial-free-billing-${randomUUID()}`, owner.id);

  for (let i = 0; i < 6; i += 1) {
    await createAgent(server.id, `trial-free-agent-${i}`, { runtime: "codex" });
  }

  const usage = await getServerBillingUsage(getDb(), server.id);
  assert.equal(usage.agents, 6);
  const entitlement = await getServerBillingEntitlement(getDb(), server.id, DURING_FULL_FEATURE_TRIAL);
  assert.deepEqual(entitlement.capacity, {
    maxHumans: -1,
    maxAgents: -1,
    maxUniversalSeats: -1,
  });
  assert.doesNotThrow(() => assertAgentCapacityAvailable(entitlement, usage));
  await requireTeamBillingFeature(getDb(), server.id, "Joint channels", DURING_FULL_FEATURE_TRIAL);
  await requireTeamBillingFeature(getDb(), server.id, "Agent migration", DURING_FULL_FEATURE_TRIAL);
  await assert.rejects(
    () => requireTeamBillingFeature(getDb(), server.id, "Agent migration", AFTER_FULL_FEATURE_TRIAL),
    /Agent migration requires the Pro plan/,
  );
});

test("Agent migration entitlement includes Pro, Founder, and Partner", async ({ db: database }) => {

  const db = getDb();
  const owner = await seedUser("pro-feature-access-owner");
  const proServer = await createServer("Pro Feature Access", `pro-feature-access-${randomUUID()}`, owner.id);
  await insertProSubscription({ serverId: proServer.id, ownerId: owner.id, status: "active" });

  await requireTeamBillingFeature(db, proServer.id, "Agent migration", AFTER_FULL_FEATURE_TRIAL);

  for (const plan of ["founder", "partner"] as const) {
    const server = await createServer(`${plan} Feature Access`, `${plan}-feature-access-${randomUUID()}`, owner.id);
    await db.update(servers).set({ plan }).where(eq(servers.id, server.id));
    await requireTeamBillingFeature(db, server.id, "Agent migration", AFTER_FULL_FEATURE_TRIAL);
  }
});

test("Free allows unlimited humans and agents after the full-featured trial", async ({ db }) => {

  const owner = await seedUser("free-owner");
  const server = await createServer("Free Billing", `free-billing-${randomUUID()}`, owner.id);

  for (let i = 0; i < 5; i += 1) {
    const member = await seedUser(`free-member-${i}`);
    assert.equal(await addMember(server.id, member.id), true);
  }

  const usageBeforeAgents = await getServerBillingUsage(getDb(), server.id);
  assert.equal(usageBeforeAgents.humans, 6);
  const entitlement = await getServerBillingEntitlement(getDb(), server.id, AFTER_FULL_FEATURE_TRIAL);
  assert.deepEqual(entitlement.capacity, {
    maxHumans: -1,
    maxAgents: -1,
    maxUniversalSeats: -1,
  });

  for (let i = 0; i < 12; i += 1) {
    await createAgent(server.id, `free-agent-${i}`, { runtime: "codex" });
  }
  const cappedUsage = await getServerBillingUsage(getDb(), server.id);
  assert.equal(cappedUsage.agents, 12);
  assert.doesNotThrow(() => assertAgentCapacityAvailable(entitlement, cappedUsage));
});

test("Pro capacity scales by paid pack quantity", async ({ db: database }) => {

  const db = getDb();
  const owner = await seedUser("pro-owner");
  const server = await createServer("Pro Billing", `pro-billing-${randomUUID()}`, owner.id);
  await insertProSubscription({ serverId: server.id, ownerId: owner.id, packQuantity: 2 });

  const entitlement = await getServerBillingEntitlement(db, server.id);
  assert.equal(entitlement.source, "subscription");
  assert.equal(entitlement.plan, "pro");
  assert.equal(entitlement.proPackQuantity, 2);
  assert.deepEqual(entitlement.capacity, {
    maxHumans: -1,
    maxAgents: -1,
    maxUniversalSeats: 2,
  });

  const secondHuman = await seedUser("pro-second-human");
  assert.equal(await addMember(server.id, secondHuman.id), true);
  const thirdHuman = await seedUser("pro-third-human");
  await assert.rejects(
    () => addMember(server.id, thirdHuman.id),
    /Seat limit reached \(2\/2 on Pro plan\)/,
  );

  const agentServer = await createServer("Pro Agent Billing", `pro-agent-billing-${randomUUID()}`, owner.id);
  await insertProSubscription({ serverId: agentServer.id, ownerId: owner.id, packQuantity: 2 });
  const agentEntitlement = await getServerBillingEntitlement(db, agentServer.id);
  for (let i = 0; i < 10; i += 1) {
    await createAgent(agentServer.id, `pro-agent-${i}`, { runtime: "codex" });
  }
  const overCapUsage = await getServerBillingUsage(db, agentServer.id);
  assert.equal(overCapUsage.agents, 10);
  assert.throws(
    () => assertAgentCapacityAvailable(agentEntitlement, overCapUsage),
    /Seat limit reached \(2\/2 on Pro plan\)/,
  );
});

test("Pro billing capacity uses pack agent seats without Free quota stacking", async ({ db: database }) => {

  const db = getDb();
  const owner = await seedUser("pro-non-additive-owner");
  const server = await createServer("Pro Non Additive Billing", `pro-non-additive-${randomUUID()}`, owner.id);
  await insertProSubscription({ serverId: server.id, ownerId: owner.id, packQuantity: 1 });

  const entitlement = await getServerBillingEntitlement(db, server.id);
  assert.deepEqual(entitlement.capacity, {
    maxHumans: -1,
    maxAgents: -1,
    maxUniversalSeats: 1,
  });
});

test("entitlement projection serializes Pro provider metadata and gates paid features", async ({ db: database }) => {

  const db = getDb();
  const owner = await seedUser("projection-owner");
  const server = await createServer("Projection Billing", `projection-billing-${randomUUID()}`, owner.id);

  await assert.rejects(
    () => requireTeamBillingFeature(db, server.id, "Joint channels", AFTER_FULL_FEATURE_TRIAL),
    /Joint channels requires the Pro plan/,
  );

  await insertProSubscription({ serverId: server.id, ownerId: owner.id, status: "past_due", packQuantity: 3 });

  const entitlement = await getServerBillingEntitlement(db, server.id);
  assert.equal(entitlement.source, "subscription");
  assert.equal(entitlement.plan, "pro");
  assert.equal(entitlement.status, "past_due");
  assert.equal(entitlement.provisionedHumanSeats, 3);
  assert.equal(entitlement.provisionedAgentSeats, 30);
  assert.equal(entitlement.proPackQuantity, 3);
  assert.equal(entitlement.trialFreePackQuantity, 1);
  assert.deepEqual(entitlement.capacity, {
    maxHumans: -1,
    maxAgents: -1,
    maxUniversalSeats: 3,
  });
  await requireTeamBillingFeature(db, server.id, "Joint channels");
});

test("the single free Joint Channel and its threads remain writable permanently", async ({ db }) => {

  const owner = await seedUser("joint-retained-owner");
  const server = await createServer("Joint Retained", `joint-retained-${randomUUID()}`, owner.id);
  const { hostProjection: joint } = await createRetainedJointChannel({
    hostServerId: server.id,
    hostOwnerId: owner.id,
  });

  assert.equal(await isChannelReadOnlyByBillingFeature(joint.id, server.id, DURING_FULL_FEATURE_TRIAL), false);
  assert.equal(await isChannelReadOnlyByBillingFeature(joint.id, server.id, AFTER_FULL_FEATURE_TRIAL), false);

  const parent = await createMessage(joint.id, "user", owner.id, "retained joint thread parent");
  const thread = await getOrCreateThread(parent.id, owner.id, "user");
  assert.equal(await isChannelReadOnlyByBillingFeature(thread.id, server.id, AFTER_FULL_FEATURE_TRIAL), false);

  await insertProSubscription({ serverId: server.id, ownerId: owner.id, packQuantity: 1 });
  assert.equal(await isChannelReadOnlyByBillingFeature(joint.id, server.id, AFTER_FULL_FEATURE_TRIAL), false);
  assert.equal(await isChannelReadOnlyByBillingFeature(thread.id, server.id, AFTER_FULL_FEATURE_TRIAL), false);
});

test("Free may create one active Joint Channel permanently", async ({ db }) => {

  const owner = await seedUser("joint-free-owner");
  const server = await createServer("Joint Free", `joint-free-${randomUUID()}`, owner.id);
  const farFuture = new Date("2040-01-01T00:00:00Z");

  const freeEntitlement = await getJointChannelCreationEntitlement(
    getDb(),
    server.id,
    farFuture,
  );
  assert.equal(freeEntitlement, "free");
  await assertJointChannelCreationCapacity(getDb(), server.id, freeEntitlement);

  await createRetainedJointChannel({
    hostServerId: server.id,
    hostOwnerId: owner.id,
  });
  await assert.rejects(
    () => assertJointChannelCreationCapacity(getDb(), server.id, freeEntitlement),
    /Creating a second Joint Channel requires the Pro plan/,
  );
});

test("only the oldest active host-created Joint Channel stays permanently free", async ({ db }) => {

  const owner = await seedUser("joint-free-retained-owner");
  const server = await createServer("Joint Free Retained", `joint-free-retained-${randomUUID()}`, owner.id);
  const first = await createRetainedJointChannel({
    hostServerId: server.id,
    hostOwnerId: owner.id,
    createdAt: new Date("2026-08-01T00:00:00Z"),
  });
  const second = await createRetainedJointChannel({
    hostServerId: server.id,
    hostOwnerId: owner.id,
    createdAt: new Date("2026-08-02T00:00:00Z"),
  });
  const farFuture = new Date("2040-01-01T00:00:00Z");

  assert.equal(
    await isChannelReadOnlyByBillingFeature(first.hostProjection.id, server.id, farFuture),
    false,
  );
  assert.equal(
    await isChannelReadOnlyByBillingFeature(second.hostProjection.id, server.id, farFuture),
    true,
  );
});

test("joint channels remain writable while any active participant server has Pro", async ({ db: database }) => {

  const db = getDb();
  const hostOwner = await seedUser("joint-host-owner");
  const targetOwner = await seedUser("joint-target-owner");
  const hostServer = await createServer("Joint Host", `joint-host-${randomUUID()}`, hostOwner.id);
  const targetServer = await createServer("Joint Target", `joint-target-${randomUUID()}`, targetOwner.id);
  await createRetainedJointChannel({
    hostServerId: hostServer.id,
    hostOwnerId: hostOwner.id,
    createdAt: new Date("2026-08-01T00:00:00Z"),
  });
  await insertProSubscription({ serverId: hostServer.id, ownerId: hostOwner.id, packQuantity: 1 });

  const { hostProjection, targetProjection } = await createRetainedJointChannel({
    hostServerId: hostServer.id,
    hostOwnerId: hostOwner.id,
    targetServerId: targetServer.id,
    targetOwnerId: targetOwner.id,
    createdAt: new Date("2026-08-02T00:00:00Z"),
  });
  assert.ok(targetProjection);

  assert.equal(await isChannelReadOnlyByBillingFeature(hostProjection.id, hostServer.id, AFTER_FULL_FEATURE_TRIAL), false);
  assert.equal(await isChannelReadOnlyByBillingFeature(targetProjection.id, targetServer.id, AFTER_FULL_FEATURE_TRIAL), false);

  const parent = await createMessage(targetProjection.id, "user", targetOwner.id, "target joint thread parent");
  const thread = await getOrCreateThread(parent.id, targetOwner.id, "user");
  assert.equal(await isChannelReadOnlyByBillingFeature(thread.id, targetServer.id, AFTER_FULL_FEATURE_TRIAL), false);

  await db.update(subscriptions)
    .set({ status: "canceled" })
    .where(eq(subscriptions.serverId, hostServer.id));

  assert.equal(await isChannelReadOnlyByBillingFeature(hostProjection.id, hostServer.id, AFTER_FULL_FEATURE_TRIAL), true);
  assert.equal(await isChannelReadOnlyByBillingFeature(targetProjection.id, targetServer.id, AFTER_FULL_FEATURE_TRIAL), true);
  assert.equal(await isChannelReadOnlyByBillingFeature(thread.id, targetServer.id, AFTER_FULL_FEATURE_TRIAL), true);
});

test("Founder and Partner plans never lock retained Joint Channels", async ({ db: database }) => {

  const db = getDb();
  for (const plan of ["founder", "partner"] as const) {
    const owner = await seedUser(`${plan}-joint-owner`);
    const server = await createServer(`${plan} Joint Retained`, `${plan}-joint-${randomUUID()}`, owner.id);
    await db.update(servers).set({ plan }).where(eq(servers.id, server.id));
    const { hostProjection: joint } = await createRetainedJointChannel({
      hostServerId: server.id,
      hostOwnerId: owner.id,
    });
    const parent = await createMessage(joint.id, "user", owner.id, `${plan} retained joint thread parent`);
    const thread = await getOrCreateThread(parent.id, owner.id, "user");

    await requireTeamBillingFeature(db, server.id, "Joint channels", AFTER_FULL_FEATURE_TRIAL);
    assert.equal(await isChannelReadOnlyByBillingFeature(joint.id, server.id, AFTER_FULL_FEATURE_TRIAL), false);
    assert.equal(await isChannelReadOnlyByBillingFeature(thread.id, server.id, AFTER_FULL_FEATURE_TRIAL), false);
  }
});

test("non-entitling subscriptions cannot grant Pro capacity through stale server plan", async ({ db: database }) => {

  const db = getDb();

  for (const status of ["canceled", "incomplete"] as const) {
    const owner = await seedUser(`stale-${status}-owner`);
    const server = await createServer(`Stale ${status}`, `stale-${status}-${randomUUID()}`, owner.id);
    await db.update(servers).set({ plan: "pro" }).where(eq(servers.id, server.id));
    await insertProSubscription({ serverId: server.id, ownerId: owner.id, status, packQuantity: 2 });

    const entitlement = await getServerBillingEntitlement(db, server.id);
    assert.equal(entitlement.source, "server");
    assert.equal(entitlement.status, status);
    assert.equal(entitlement.plan, "free");
    assert.equal(entitlement.provisionedHumanSeats, null);
    assert.equal(entitlement.provisionedAgentSeats, null);
    assert.equal(entitlement.proPackQuantity, null);
    assert.notDeepEqual(entitlement.capacity, {
      maxHumans: 2,
      maxAgents: 20,
      maxUniversalSeats: -1,
    });
    await assert.rejects(
      () => requireTeamBillingFeature(db, server.id, "Joint channels", AFTER_FULL_FEATURE_TRIAL),
      /Joint channels requires the Pro plan/,
    );
  }
});

test("founder plan remains grandfathered even with a non-entitling subscription row", async ({ db: database }) => {

  const db = getDb();
  const owner = await seedUser("founder-stale-owner");
  const server = await createServer("Founder Stale", `founder-stale-${randomUUID()}`, owner.id);
  await db.update(servers).set({ plan: "founder" }).where(eq(servers.id, server.id));
  await insertProSubscription({ serverId: server.id, ownerId: owner.id, status: "canceled", packQuantity: 2 });

  const entitlement = await getServerBillingEntitlement(db, server.id);
  assert.equal(entitlement.plan, "founder");
  assert.deepEqual(entitlement.capacity, {
    maxHumans: -1,
    maxAgents: -1,
    maxUniversalSeats: -1,
  });
  await requireTeamBillingFeature(db, server.id, "Joint channels");
});

test("partner plan remains Founder-equivalent with non-entitling or active subscription rows", async ({ db: database }) => {

  const db = getDb();

  for (const status of ["canceled", "incomplete", "active"] as const) {
    const owner = await seedUser(`partner-${status}-owner`);
    const server = await createServer(`Partner ${status}`, `partner-${status}-${randomUUID()}`, owner.id);
    await db.update(servers).set({ plan: "partner" }).where(eq(servers.id, server.id));
    await insertProSubscription({ serverId: server.id, ownerId: owner.id, status, packQuantity: 2 });

    const entitlement = await getServerBillingEntitlement(db, server.id, AFTER_FULL_FEATURE_TRIAL);
    assert.equal(entitlement.source, "server");
    assert.equal(entitlement.status, status);
    assert.equal(entitlement.plan, "partner");
    assert.equal(entitlement.provisionedHumanSeats, null);
    assert.equal(entitlement.provisionedAgentSeats, null);
    assert.equal(entitlement.proPackQuantity, null);
    assert.deepEqual(entitlement.capacity, {
      maxHumans: -1,
      maxAgents: -1,
      maxUniversalSeats: -1,
    });
    await requireTeamBillingFeature(db, server.id, "Joint channels", AFTER_FULL_FEATURE_TRIAL);
  }
});
