import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase } from "../test/integration/database";
import assert from "node:assert/strict";
import { vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { PRO_AGENT_SEAT_BLOCK_SIZE } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { serverMembers, subscriptions, servers, users } from "../db/schema";
import { createAgent } from "./agentService";
import {
  assertAgentCapacityAvailable,
  getHistoryCutoff,
  getServerPlan,
  getServerHistoryWindow,
  getServerBillingEntitlement,
  getServerBillingUsage,
  isChannelReadOnlyByBillingFeature,
  requireTeamBillingFeature,
} from "./planService";
import { addMember, createServer } from "./serverService";
import { createChannel, getOrCreateThread } from "./channelService";
import { createMessage } from "./messageService";
import { seedBoundGuest } from "../test/guestFixture";


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

test("billing usage excludes Guests from paid human seats", async ({ db }) => {
  const owner = await seedUser("guest-seat-owner");
  const guest = await seedUser("guest-seat-guest");
  const member = await seedUser("guest-seat-member");
  const server = await createServer("Guest seats", `guest-seats-${randomUUID()}`, owner.id);
  await db.insert(serverMembers).values([
    { serverId: server.id, userId: member.id, role: "member" },
  ]);
  await seedBoundGuest({ serverId: server.id, userId: guest.id }, db);

  const usage = await getServerBillingUsage(db, server.id);
  assert.equal(usage.humans, 2, "owner and Member consume seats; Guest does not");
  assert.equal(usage.universalSeats, 2);
});

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

// AppSumo fixtures exercise the stored-license reader, not a mocked plan switch.
async function seedAppSumoGrant(serverId: string, ownerId: string, tier: 1 | 2 | 3 | 4 = 1) {
  const { appSumoLicenses, appSumoLicenseBindings } = await import("../db/schema");
  const { parseAppSumoLicenseKey } = await import("./appSumoContracts");
  const key = parseAppSumoLicenseKey(randomUUID())!;
  await getDb().insert(appSumoLicenses).values({
    productId: "233088", licenseKey: key, tier, status: "active", verifiedAt: new Date(),
  });
  await getDb().insert(appSumoLicenseBindings).values({
    serverId, productId: "233088", originalLicenseKey: key, currentLicenseKey: key,
    boundByUserId: ownerId, activatedAt: new Date(),
  });
  return key;
}

test("plan and history reads use one server query before activation, while Pro and after revocation", async ({ db }) => {
  const owner = await seedUser("appsumo-read-owner");
  const server = await createServer("AppSumo reads", `appsumo-read-${randomUUID()}`, owner.id);
  await seedAppSumoGrant(server.id, owner.id);
  // Model the lifecycle writer's compatibility projection; hot reads do not resolve licenses.
  for (const plan of ["free", "pro", "free"] as const) {
    await db.update(servers).set({ plan }).where(eq(servers.id, server.id));
    const select = vi.spyOn(db, "select");
    try {
      const actualPlan = await getServerPlan(server.id);
      assert.equal(select.mock.calls.length, 1, "ordinary plan read must not join the license tables");
      assert.equal(actualPlan, plan);
      select.mockClear();
      const history = await getServerHistoryWindow(server.id, AFTER_FULL_FEATURE_TRIAL);
      assert.equal(history.plan, plan);
      assert.equal(history.cutoff?.toISOString(), getHistoryCutoff(plan, AFTER_FULL_FEATURE_TRIAL)?.toISOString());
      assert.equal(select.mock.calls.length, 1, "history read must not join the license tables");
    } finally {
      select.mockRestore();
    }
  }
  assert.equal(await getServerPlan(randomUUID()), "free");
});

test("AppSumo admits the included humans and agents together, but cannot borrow spare seats", async ({ db }) => {
  const owner = await seedUser("appsumo-owner");
  const second = await seedUser("appsumo-second");
  const third = await seedUser("appsumo-third");
  const server = await createServer("AppSumo", `appsumo-${randomUUID()}`, owner.id);
  await seedAppSumoGrant(server.id, owner.id);
  await addMember(server.id, second.id);
  await assert.rejects(() => addMember(server.id, third.id), /Human.*limit|human.*limit|human.*seat/i);
  for (let i = 0; i < 10; i++) await createAgent(server.id, `agent-${i}`, { runtime: "external" });
  await assert.rejects(() => createAgent(server.id, "agent-over", { runtime: "external" }), /Agent.*limit|agent.*limit/i);
  const entitlement = await getServerBillingEntitlement(db, server.id);
  assert.equal(entitlement.source, "appsumo");
  assert.deepEqual(entitlement.capacity, { maxHumans: 2, maxAgents: 10, maxUniversalSeats: -1 });
  await requireTeamBillingFeature(db, server.id, "Agent migration", AFTER_FULL_FEATURE_TRIAL);
  const { getBillingSummary, createCheckoutSession } = await import("./billingService");
  const summary = await getBillingSummary(server.id);
  assert.equal(summary.price, null);
  assert.equal(summary.subscription, null);
  assert.equal(summary.appsumo?.tier, 1);
  assert.equal(JSON.stringify(summary).includes("currentLicenseKey"), false);
  await assert.rejects(() => createCheckoutSession(server.id, owner.id, "https://raft.build/ok", "https://raft.build/cancel"), /AppSumo/);
});

test("AppSumo monthly uploads reserve the exact allowance, release failures and reset at UTC month", async ({ db }) => {
  const { withFileUploadQuota, getFileUploadQuotaSummary, FileUploadQuotaExceededError, buildFileUploadQuotaExceededResponse } = await import("./fileUploadQuotaService");
  const owner = await seedUser("appsumo-upload-owner");
  const server = await createServer("AppSumo uploads", `appsumo-upload-${randomUUID()}`, owner.id);
  await seedAppSumoGrant(server.id, owner.id);
  const now = new Date("2026-10-31T23:59:00Z");
  await assert.rejects(() => withFileUploadQuota(server.id, 123, async () => { throw new Error("upload failed"); }, now), /upload failed/);
  assert.equal((await getFileUploadQuotaSummary(server.id, now)).reservedBytes, 0);
  await withFileUploadQuota(server.id, 1024 ** 3, async () => "ok", now);
  const summary = await getFileUploadQuotaSummary(server.id, now);
  assert.equal(summary.appsumo?.tier, 1);
  const refusal = await buildFileUploadQuotaExceededResponse(server.id, new FileUploadQuotaExceededError(summary, 1), "human");
  assert.match(refusal.error, /AppSumo/);
  assert.doesNotMatch(refusal.suggestedNextAction, /upgrade to Pro/i);
  assert.equal(summary.usedBytes, 1024 ** 3);
  assert.equal(summary.limitBytes, 1024 ** 3);
  assert.equal(summary.remainingBytes, 0);
  await assert.rejects(() => withFileUploadQuota(server.id, 1, async () => "no", now), FileUploadQuotaExceededError);
  assert.equal((await getFileUploadQuotaSummary(server.id, new Date("2026-11-01T00:00:00Z"))).usedBytes, 0);
});

test("AppSumo hosted Joint cap counts connections, permits an upgrade and preserves existing channels on downgrade", async ({ db }) => {
  const { createJointChannel, acceptJointChannelInvite } = await import("./channelService");
  const { countHostedJointChannels } = await import("./jointChannelLimitService");
  const { appSumoLicenses } = await import("../db/schema");
  const owner = await seedUser("appsumo-joint-owner");
  const peerOwner = await seedUser("appsumo-joint-peer");
  const host = await createServer("AppSumo host", `appsumo-joint-${randomUUID()}`, owner.id);
  const peer = await createServer("Peer", `appsumo-peer-${randomUUID()}`, peerOwner.id);
  await db.update(servers).set({ plan: "partner" }).where(eq(servers.id, peer.id));
  const licenseKey = await seedAppSumoGrant(host.id, owner.id);
  const makeJoint = () => createJointChannel({
    hostServerId: host.id, createdByUserId: owner.id, name: `joint-${randomUUID().slice(0, 8)}`,
    jointInvites: [{ targetServerSlug: peer.slug, invitedPeople: [peerOwner.email] }],
  });
  const pending = await makeJoint();
  assert.equal(await countHostedJointChannels(db, host.id), 0, "unaccepted invitations consume no slot");
  for (let i = 0; i < 2; i++) {
    const joint = await makeJoint();
    await acceptJointChannelInvite({ inviteId: joint.invites[0].id, targetServerId: peer.id, acceptedByUserId: peerOwner.id });
  }
  assert.equal(await countHostedJointChannels(db, host.id), 2);
  const acceptPending = () => acceptJointChannelInvite({ inviteId: pending.invites[0].id, targetServerId: peer.id, acceptedByUserId: peerOwner.id });
  await assert.rejects(acceptPending, (error: Error & { code?: string }) => error.code === "joint_channel_plan_limit_reached");
  await db.update(appSumoLicenses).set({ tier: 2 }).where(eq(appSumoLicenses.licenseKey, licenseKey));
  await acceptPending();
  assert.equal(await countHostedJointChannels(db, host.id), 3);
  await db.update(appSumoLicenses).set({ tier: 1 }).where(eq(appSumoLicenses.licenseKey, licenseKey));
  assert.equal(await countHostedJointChannels(db, host.id), 3, "downgrade preserves the existing channels");
  await assert.rejects(makeJoint, (error: Error & { code?: string }) => error.code === "joint_channel_plan_limit_reached");
});


test("internal plans outrank a stored AppSumo grant and active Stripe conflicts remain visible", async ({ db }) => {
  const { getBillingSummary } = await import("./billingService");
  const owner = await seedUser("source-precedence");
  const server = await createServer("Sources", `sources-${randomUUID()}`, owner.id);
  await seedAppSumoGrant(server.id, owner.id);
  for (const plan of ["partner", "founder"] as const) {
    await db.update(servers).set({ plan }).where(eq(servers.id, server.id));
    const entitlement = await getServerBillingEntitlement(db, server.id);
    assert.equal(entitlement.plan, plan);
    assert.equal(entitlement.source, "server");
    assert.equal(entitlement.appsumo, undefined);
    assert.deepEqual(entitlement.capacity, { maxHumans: -1, maxAgents: -1, maxUniversalSeats: -1 });
  }
  await db.update(servers).set({ plan: "pro" }).where(eq(servers.id, server.id));
  await insertProSubscription({ serverId: server.id, ownerId: owner.id });
  const summary = await getBillingSummary(server.id);
  assert.equal(summary.source, "appsumo");
  assert.equal(summary.sourceConflict, "appsumo_stripe");
  assert.equal(summary.subscription?.status, "active");
  assert.ok(summary.subscription?.currentPeriodEnd);
  assert.equal(summary.subscription?.cancelAtPeriodEnd, false);
  assert.equal(summary.appsumo?.tier, 1);
});
