// Contract v0.3 §18.5–§18.11 (joint channel limits), test matrix 30–39.
// Every scenario builds its own servers and plans from scratch.
import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase } from "../test/integration/database";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { JOINT_CHANNEL_OVER_LIMIT_GRACE_MS, PRO_AGENT_SEAT_BLOCK_SIZE } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { jointChannels, jointChannelServers, jointMembershipDepartures, servers, subscriptions, users } from "../db/schema";
import { cleanJointMembershipDepartureBatch, type JointMembershipDepartureId } from "./jointMembershipDeparture";
import { createServer, deleteServer } from "./serverService";
import {
  acceptJointChannelInvite,
  acceptJointChannelInvites,
  createChannel,
  createJointChannel,
  disconnectJointChannel,
  getOrCreateThreadForChannel,
  inviteServerToJointChannel,
} from "./channelService";
import { createMessage } from "./messageService";
import { isChannelReadOnlyByBillingFeature } from "./planService";
import { startChannelToJointConversion } from "./channelConversionService";
import {
  countHostedJointChannels,
  JointChannelLimitError,
  onJointLimitStateChanged,
  reconcileJointsForServer,
  sweepJointOverLimit,
} from "./jointChannelLimitService";
import { emitJointLimitStateChange } from "../routes/channels";
import { enableExternalChannelsFlag } from "../test/externalInviteFixture";
import { ExternalChannelLimitError } from "./externalChannelLimitService";

afterEach(async () => {
  await closeTestDatabase();
});

type Plan = "free" | "founder" | "partner" | "pro";
type Seeded = { owner: typeof users.$inferSelect; server: Awaited<ReturnType<typeof createServer>> };

async function seedServer(label: string, plan: Plan): Promise<Seeded> {
  const suffix = randomUUID().slice(0, 8);
  const [owner] = await getDb().insert(users).values({
    email: `${label}-${suffix}@slock.test`,
    name: `${label}-${suffix}`,
    displayName: label,
    passwordHash: "hash",
    emailVerified: true,
  }).returning();
  const server = await createServer(`${label} ${suffix}`, `${label}-${suffix}`, owner.id);
  await setPlan(server.id, plan);
  return { owner, server };
}

async function setPlan(serverId: string, plan: Plan) {
  await getDb().update(servers).set({ plan }).where(eq(servers.id, serverId));
}

async function insertSubscription(serverId: string, ownerId: string, status: "active" | "past_due" | "canceled") {
  const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  await getDb().insert(subscriptions).values({
    serverId,
    plan: "pro",
    provider: "stripe",
    stripeCustomerId: `cus_${randomUUID()}`,
    stripeSubscriptionId: `sub_${randomUUID()}`,
    stripeProPackItemId: `si_pro_${randomUUID()}`,
    status,
    provisionedHumanSeats: 1,
    provisionedAgentSeats: PRO_AGENT_SEAT_BLOCK_SIZE,
    proPackQuantity: 1,
    trialFreePackQuantity: 1,
    firstPackTrialEndsAt: future,
    currentPeriodStart: new Date(),
    currentPeriodEnd: future,
    createdByUserId: ownerId,
    updatedByUserId: ownerId,
  });
}

async function createJoint(host: Seeded, targets: Seeded[] = []) {
  return createJointChannel({
    hostServerId: host.server.id,
    createdByUserId: host.owner.id,
    name: `joint-${randomUUID().slice(0, 8)}`,
    jointInvites: targets.map((target) => ({ targetServerSlug: target.server.slug, invitedPeople: [target.owner.email] })),
  });
}

function inviteFor(result: Awaited<ReturnType<typeof createJoint>>, target: Seeded) {
  const invite = result.invites.find((row) => row.toServerId === target.server.id);
  assert.ok(invite, "invite for target");
  return invite;
}

async function accept(inviteId: string, target: Seeded) {
  return acceptJointChannelInvite({ inviteId, targetServerId: target.server.id, acceptedByUserId: target.owner.id });
}

async function invite(localChannelId: string, from: Seeded, target: Seeded) {
  return inviteServerToJointChannel({
    localChannelId,
    fromServerId: from.server.id,
    invitedByUserId: from.owner.id,
    targetServerSlug: target.server.slug,
    invitedPeople: [target.owner.email],
  });
}

async function overLimitSince(jointId: string) {
  const [row] = await getDb().select({ since: jointChannels.overLimitSince }).from(jointChannels).where(eq(jointChannels.id, jointId));
  return row?.since ?? null;
}

function rejectsWith(code: "joint_free_server_limit" | "joint_server_limit" | "joint_channel_free_limit_reached") {
  return (error: unknown) => error instanceof JointChannelLimitError && error.code === code;
}

/** Host free + free participant + paid participant, all accepted. */
async function jointAtTwoFreePlusPaid() {
  const host = await seedServer("host", "free");
  const freeA = await seedServer("free-a", "free");
  const paid = await seedServer("paid", "founder");
  const created = await createJoint(host, [freeA, paid]);
  await accept(inviteFor(created, freeA).id, freeA);
  await accept(inviteFor(created, paid).id, paid);
  return {
    host, freeA, paid, created,
    jointId: created.jointChannel.id,
    hostLocal: created.channel.id,
    canonicalId: created.jointChannel.canonicalChannelId,
  };
}

test("30: an invite that would make a third free server is rejected, and pending invites count", async ({ db: _db }) => {
  const host = await seedServer("host", "founder");
  const freeA = await seedServer("free-a", "free");
  const freeB = await seedServer("free-b", "free");
  const freeC = await seedServer("free-c", "free");
  const created = await createJoint(host, [freeA]);
  // A is only pending; B makes 2 free (pending included); C would make 3.
  await invite(created.channel.id, host, freeB);
  await assert.rejects(() => invite(created.channel.id, host, freeC), rejectsWith("joint_free_server_limit"));

  // Creating with three free servers up front is rejected the same way.
  const freeHost = await seedServer("free-host", "free");
  await assert.rejects(() => createJoint(freeHost, [freeA, freeB]), rejectsWith("joint_free_server_limit"));
});

test("30b: a joint already at two free servers can still invite paid servers", async ({ db: _db }) => {
  const host = await seedServer("host", "free");
  const freeA = await seedServer("free-a", "free");
  const paid = await seedServer("paid", "pro");
  await insertSubscription(paid.server.id, paid.owner.id, "active");
  const created = await createJoint(host, [freeA]);
  await accept(inviteFor(created, freeA).id, freeA);
  const result = await invite(created.channel.id, host, paid);
  assert.equal(result.invites.length, 1);
});

test("32: after a downgrade, accepting an old free invite is rejected; only one of two concurrent accepts succeeds", async ({ db: _db }) => {
  const host = await seedServer("host", "founder");
  const freeB = await seedServer("free-b", "free");
  const freeC = await seedServer("free-c", "free");
  const created = await createJoint(host, [freeB, freeC]);
  await setPlan(host.server.id, "free");

  const results = await Promise.allSettled([
    accept(inviteFor(created, freeB).id, freeB),
    accept(inviteFor(created, freeC).id, freeC),
  ]);
  const fulfilled = results.filter((result) => result.status === "fulfilled");
  const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.ok(rejectsWith("joint_free_server_limit")(rejected[0]!.reason));
});

// Free host cap (task #32, 2026-10-13 rule): a free server may host at most
// one joint channel that another server has actually joined.

async function startConversion(host: Seeded) {
  const channel = await createChannel(host.server.id, `convert-${randomUUID().slice(0, 8)}`, "convert me", "channel");
  return startChannelToJointConversion({ serverId: host.server.id, sourceChannelId: channel.id, createdByUserId: host.owner.id });
}

function freeHostRejection(blockingChannelName?: string) {
  return (error: unknown) => rejectsWith("joint_channel_free_limit_reached")(error)
    && (blockingChannelName === undefined || (error as JointChannelLimitError).details.blockingChannelName === blockingChannelName);
}

test("33: a free host's joints nobody has joined do not use the slot: create, convert and invite all go through", async ({ db: _db }) => {
  const host = await seedServer("host", "free");
  const x = await seedServer("x", "founder");
  const y = await seedServer("y", "founder");
  const z = await seedServer("z", "founder");
  await createJoint(host, [x]);
  const b = await createJoint(host, [y]);
  assert.equal((await startConversion(host)).status, "pending");
  await invite(b.channel.id, host, z);
  assert.equal(await countHostedJointChannels(getDb(), host.server.id), 0);
});

test("33a: once a server joins A, a first join of B is rejected and B's new invites are preflight-rejected", async ({ db: _db }) => {
  const host = await seedServer("host", "free");
  const x = await seedServer("x", "founder");
  const y = await seedServer("y", "founder");
  const z = await seedServer("z", "founder");
  const a = await createJoint(host, [x]);
  const b = await createJoint(host, [y]);
  await accept(inviteFor(a, x).id, x);
  assert.equal(await countHostedJointChannels(getDb(), host.server.id), 1);

  await assert.rejects(() => accept(inviteFor(b, y).id, y), freeHostRejection());
  await assert.rejects(() => invite(b.channel.id, host, z), freeHostRejection(a.channel.name));
  await assert.rejects(() => createJoint(host, [z]), freeHostRejection(a.channel.name));

  // A itself keeps working: inviting and adding a third server is not checked.
  const sent = await invite(a.channel.id, host, z);
  await accept(sent.invites[0]!.id, z);
  assert.equal(await countHostedJointChannels(getDb(), host.server.id), 1);
});

test("33b: X disconnecting from A frees the slot for B; X coming back to A while B is joined is rejected", async ({ db: _db }) => {
  const host = await seedServer("host", "free");
  const x = await seedServer("x", "founder");
  const y = await seedServer("y", "founder");
  const a = await createJoint(host, [x]);
  const b = await createJoint(host, [y]);
  const xLocal = await accept(inviteFor(a, x).id, x);
  await assert.rejects(() => accept(inviteFor(b, y).id, y), freeHostRejection());

  await disconnectJointChannel(xLocal.id, x.owner.id);
  assert.equal(await countHostedJointChannels(getDb(), host.server.id), 0);
  // The disconnect's membership cleanup finishes before X may come back.
  for (const departure of await getDb().select().from(jointMembershipDepartures).where(eq(jointMembershipDepartures.localChannelId, xLocal.id))) {
    while (!await cleanJointMembershipDepartureBatch(departure.id as JointMembershipDepartureId, { revoke: async () => {} }));
  }
  // While A is alone again the host may invite X back...
  const reinvite = await invite(a.channel.id, host, x);
  // ...but B takes the slot first, so X's reconnect is a first join of A.
  const yInvite = await invite(b.channel.id, host, y);
  await accept(yInvite.invites[0]!.id, y);
  await assert.rejects(() => accept(reinvite.invites[0]!.id, x), freeHostRejection());
});

test("33c: a deleted server does not keep the slot", async ({ db: _db }) => {
  const host = await seedServer("host", "free");
  const x = await seedServer("x", "founder");
  const y = await seedServer("y", "founder");
  const a = await createJoint(host, [x]);
  const b = await createJoint(host, [y]);
  await accept(inviteFor(a, x).id, x);
  await deleteServer(x.server.id);
  assert.equal(await countHostedJointChannels(getDb(), host.server.id), 0);
  await accept(inviteFor(b, y).id, y);
});

test("33d: paid hosts are not capped; after a downgrade existing joints stay and only new first joins are blocked", async ({ db: _db }) => {
  const host = await seedServer("host", "founder");
  const x = await seedServer("x", "founder");
  const y = await seedServer("y", "founder");
  const z = await seedServer("z", "founder");
  const w = await seedServer("w", "founder");
  const a = await createJoint(host, [x]);
  const b = await createJoint(host, [y]);
  const c = await createJoint(host, [w]);
  await accept(inviteFor(a, x).id, x);
  await accept(inviteFor(b, y).id, y);
  assert.equal(await countHostedJointChannels(getDb(), host.server.id), 2);

  await setPlan(host.server.id, "free");
  // Both connected joints keep working, including adding servers to them.
  const sent = await invite(b.channel.id, host, z);
  await accept(sent.invites[0]!.id, z);
  // A first join of a third joint is not.
  await assert.rejects(() => accept(inviteFor(c, w).id, w), freeHostRejection());
  await assert.rejects(() => createJoint(host, [w]), freeHostRejection());
});

test("33e: joint sub-threads the free server opens elsewhere never use its slot", async ({ db: _db }) => {
  const free = await seedServer("free", "free");
  const peer = await seedServer("peer", "founder");
  const x = await seedServer("x", "founder");

  // A thread the free server opens in another server's joint records the
  // free server as creator of the sub-thread joint, and the peer has a
  // projection of it; it is still not hosting.
  const other = await createJoint(peer, [free]);
  const accepted = await accept(inviteFor(other, free).id, free);
  const parent = await createMessage(other.jointChannel.canonicalChannelId, "user", free.owner.id, "parent");
  await getOrCreateThreadForChannel(accepted.id, parent.id, free.owner.id, "user");
  const [threadJoint] = await getDb().select({ id: jointChannels.id }).from(jointChannels)
    .where(eq(jointChannels.createdByServerId, free.server.id));
  assert.ok(threadJoint, "the sub-thread joint is recorded as created by the free server");
  assert.equal(await countHostedJointChannels(getDb(), free.server.id), 0);

  const own = await createJoint(free, [x]);
  await accept(inviteFor(own, x).id, x);
  assert.equal(await countHostedJointChannels(getDb(), free.server.id), 1);
});

test("34: downgrade starts the grace, read-only after 3 days, writable again after upgrade", async ({ db: _db }) => {
  const { paid, jointId, hostLocal, host } = await jointAtTwoFreePlusPaid();
  assert.equal(await overLimitSince(jointId), null);

  const t0 = new Date();
  await setPlan(paid.server.id, "free");
  await reconcileJointsForServer(paid.server.id, t0);
  const since = await overLimitSince(jointId);
  assert.equal(since?.getTime(), t0.getTime());

  const justBefore = new Date(t0.getTime() + JOINT_CHANNEL_OVER_LIMIT_GRACE_MS - 1);
  const atEnd = new Date(t0.getTime() + JOINT_CHANNEL_OVER_LIMIT_GRACE_MS);
  assert.equal(await isChannelReadOnlyByBillingFeature(hostLocal, host.server.id, justBefore), false);
  assert.equal(await isChannelReadOnlyByBillingFeature(hostLocal, host.server.id, atEnd), true);

  await setPlan(paid.server.id, "founder");
  await reconcileJointsForServer(paid.server.id, atEnd);
  assert.equal(await overLimitSince(jointId), null);
  assert.equal(await isChannelReadOnlyByBillingFeature(hostLocal, host.server.id, atEnd), false);
});

test("35 + existing defect: joint sub-threads follow the parent, including local thread projections", async ({ db: _db }) => {
  const { paid, host, freeA, hostLocal, created, canonicalId } = await jointAtTwoFreePlusPaid();
  // Joint messages persist in the canonical storage channel.
  const parent = await createMessage(canonicalId, "user", host.owner.id, "parent in joint");
  const thread = await getOrCreateThreadForChannel(hostLocal, parent.id, host.owner.id, "user");

  const t0 = new Date();
  await setPlan(paid.server.id, "free");
  await reconcileJointsForServer(paid.server.id, t0);
  const afterGrace = new Date(t0.getTime() + JOINT_CHANNEL_OVER_LIMIT_GRACE_MS);

  // Before this change a local joint-thread projection (type "thread" with no
  // parentMessageId) resolved to "not joint" and stayed writable.
  assert.equal(await isChannelReadOnlyByBillingFeature(thread.id, host.server.id, afterGrace), true);
  assert.equal(await isChannelReadOnlyByBillingFeature(thread.id, host.server.id, t0), false);

  // The sub-thread's own joint record never carries its own state.
  const [threadJoint] = await getDb()
    .select({ id: jointChannels.id, since: jointChannels.overLimitSince })
    .from(jointChannels)
    .where(eq(jointChannels.canonicalChannelId, thread.canonicalThreadChannelId));
  assert.ok(threadJoint && threadJoint.id !== created.jointChannel.id);
  assert.equal(threadJoint.since, null);
  void freeA;
});

test("36: paid means founder, partner, pro subscription active/past_due, or pro without a subscription; canceled pro is free", async ({ db: _db }) => {
  const host = await seedServer("host", "free");
  const freeA = await seedServer("free-a", "free");
  const created = await createJoint(host, [freeA]);
  await accept(inviteFor(created, freeA).id, freeA);

  const founder = await seedServer("founder", "founder");
  const partner = await seedServer("partner", "partner");
  const proActive = await seedServer("pro-active", "pro");
  await insertSubscription(proActive.server.id, proActive.owner.id, "active");
  const proPastDue = await seedServer("pro-past-due", "pro");
  await insertSubscription(proPastDue.server.id, proPastDue.owner.id, "past_due");
  const proNoSub = await seedServer("pro-no-sub", "pro");
  for (const paid of [founder, partner, proActive, proPastDue, proNoSub]) {
    await invite(created.channel.id, host, paid);
  }

  const proCanceled = await seedServer("pro-canceled", "pro");
  await insertSubscription(proCanceled.server.id, proCanceled.owner.id, "canceled");
  await assert.rejects(() => invite(created.channel.id, host, proCanceled), rejectsWith("joint_free_server_limit"));
});

test("37: the sweep finds an idle joint that went over and starts its grace", async ({ db: _db }) => {
  const { paid, jointId } = await jointAtTwoFreePlusPaid();
  await setPlan(paid.server.id, "free"); // no hook runs: nobody posts, no billing event
  const t0 = new Date();
  const result = await sweepJointOverLimit(t0);
  assert.ok(result.started >= 1);
  assert.equal((await overLimitSince(jointId))?.getTime(), t0.getTime());

  // Idempotent: a second sweep keeps the first observation.
  await sweepJointOverLimit(new Date(t0.getTime() + 60_000));
  assert.equal((await overLimitSince(jointId))?.getTime(), t0.getTime());
});

test("38: going over, recovering, then going over again starts a fresh grace", async ({ db: _db }) => {
  const { paid, jointId } = await jointAtTwoFreePlusPaid();
  const t1 = new Date("2027-01-01T00:00:00Z");
  const t2 = new Date("2027-01-02T00:00:00Z");
  const t3 = new Date("2027-01-03T00:00:00Z");
  await setPlan(paid.server.id, "free");
  await sweepJointOverLimit(t1);
  assert.equal((await overLimitSince(jointId))?.getTime(), t1.getTime());
  await setPlan(paid.server.id, "founder");
  await sweepJointOverLimit(t2);
  assert.equal(await overLimitSince(jointId), null);
  await setPlan(paid.server.id, "free");
  await sweepJointOverLimit(t3);
  assert.equal((await overLimitSince(jointId))?.getTime(), t3.getTime());
});

test("39: a deleted participant server never makes the joint go over", async ({ db: _db }) => {
  const { paid, jointId } = await jointAtTwoFreePlusPaid();
  await getDb().update(servers).set({ plan: "free", deletedAt: new Date() }).where(eq(servers.id, paid.server.id));
  await sweepJointOverLimit(new Date());
  assert.equal(await overLimitSince(jointId), null);
});

test("sub-thread joint records are not counted as joints by the sweep", async ({ db: _db }) => {
  const { host, hostLocal, canonicalId } = await jointAtTwoFreePlusPaid();
  const before = await sweepJointOverLimit(new Date());
  const parent = await createMessage(canonicalId, "user", host.owner.id, "parent");
  await getOrCreateThreadForChannel(hostLocal, parent.id, host.owner.id, "user");
  const after = await sweepJointOverLimit(new Date());
  assert.equal(after.scanned, before.scanned);
});

test("background observers notify clients only when the over-limit state changes", async ({ db: _db }) => {
  const { paid, jointId } = await jointAtTwoFreePlusPaid();
  const notified: string[] = [];
  onJointLimitStateChanged((parentJointId) => { notified.push(parentJointId); });
  try {
    const t0 = new Date("2027-02-01T00:00:00Z");
    // Billing sync: going over, staying over, recovering.
    await setPlan(paid.server.id, "free");
    await reconcileJointsForServer(paid.server.id, t0);
    assert.deepEqual(notified.splice(0), [jointId], "entering grace notifies");
    await reconcileJointsForServer(paid.server.id, new Date(t0.getTime() + 1000));
    assert.deepEqual(notified.splice(0), [], "no change, no notification");
    await setPlan(paid.server.id, "founder");
    await reconcileJointsForServer(paid.server.id, new Date(t0.getTime() + 2000));
    assert.deepEqual(notified.splice(0), [jointId], "recovering notifies");

    // Sweep: same three cases.
    await sweepJointOverLimit(new Date(t0.getTime() + 3000));
    assert.deepEqual(notified.splice(0), [], "a sweep with nothing to change is silent");
    await setPlan(paid.server.id, "free");
    await sweepJointOverLimit(new Date(t0.getTime() + 4000));
    assert.deepEqual(notified.splice(0), [jointId], "the sweep starting a grace notifies");
    await setPlan(paid.server.id, "founder");
    await sweepJointOverLimit(new Date(t0.getTime() + 5000));
    assert.deepEqual(notified.splice(0), [jointId], "the sweep clearing it notifies");
  } finally {
    onJointLimitStateChanged(null);
  }
});

test("a joint limit state change pushes fresh metadata to every participant's projection", async ({ db: _db }) => {
  const { paid, jointId, created } = await jointAtTwoFreePlusPaid();
  const t0 = new Date();
  await setPlan(paid.server.id, "free");
  await reconcileJointsForServer(paid.server.id, t0);

  const emitted: Array<{ room: string; event: string; channel: { id: string; jointOverLimitGraceEndsAt?: string | null } }> = [];
  const io = {
    to: (room: string) => ({
      emit: (event: string, payload: { channel: { id: string; jointOverLimitGraceEndsAt?: string | null } }) => {
        emitted.push({ room, event, channel: payload.channel });
      },
    }),
  };
  await emitJointLimitStateChange(io as never, jointId);

  assert.equal(emitted.length, 3, "host, free participant and paid participant each get their projection");
  assert.ok(emitted.every((entry) => entry.event === "channel:updated" && entry.room === `channel:${entry.channel.id}`));
  assert.ok(emitted.some((entry) => entry.channel.id === created.channel.id), "the host's local channel is included");
  const graceEndsAt = new Date(t0.getTime() + JOINT_CHANNEL_OVER_LIMIT_GRACE_MS).toISOString();
  assert.ok(
    emitted.every((entry) => new Date(entry.channel.jointOverLimitGraceEndsAt ?? 0).toISOString() === graceEndsAt),
    "each payload carries the new grace deadline",
  );
});


// external_channels_v1 on for the joint's host: the free-plan rules of
// external channels replace the per-joint free-server cap and its grace. A
// free server is in at most one external channel; existing channels over a
// limit are never frozen, only new connections are blocked.

async function seedServerOwnedBy(owner: typeof users.$inferSelect, label: string, plan: Plan): Promise<Seeded> {
  const suffix = randomUUID().slice(0, 8);
  const server = await createServer(`${label} ${suffix}`, `${label}-${suffix}`, owner.id);
  await setPlan(server.id, plan);
  return { owner, server };
}

function rejectsWithConnectingLimit(serverId: string) {
  return (error: unknown) => error instanceof ExternalChannelLimitError
    && error.code === "free_external_limit" && error.limitSide === "connecting" && error.limitServerId === serverId;
}

async function activeServerIds(jointId: string) {
  const rows = await getDb().select({ serverId: jointChannelServers.serverId }).from(jointChannelServers)
    .where(and(eq(jointChannelServers.jointChannelId, jointId), eq(jointChannelServers.status, "active")));
  return rows.map((row) => row.serverId).sort();
}

/** A free host with external channels on, and two free participants accepted: three free servers. */
async function externalJointWithThreeFree() {
  const host = await seedServer("ext-host", "free");
  await enableExternalChannelsFlag(host.server.id);
  const freeA = await seedServer("ext-free-a", "free");
  const freeB = await seedServer("ext-free-b", "free");
  const created = await createJoint(host, [freeA, freeB]);
  await accept(inviteFor(created, freeA).id, freeA);
  await accept(inviteFor(created, freeB).id, freeB);
  return { host, freeA, freeB, created, jointId: created.jointChannel.id, hostLocal: created.channel.id };
}

test("external channels on for the host: a joint takes a third free server, at create, invite and accept", async ({ db: _db }) => {
  const { host, freeA, freeB, created, jointId } = await externalJointWithThreeFree();
  assert.deepEqual(await activeServerIds(jointId), [host.server.id, freeA.server.id, freeB.server.id].sort());

  // A fourth free server can be invited and accepted too.
  const freeC = await seedServer("ext-free-c", "free");
  const invited = await invite(created.channel.id, host, freeC);
  await accept(invited.invites[0]!.id, freeC);
  assert.equal((await activeServerIds(jointId)).length, 4);

  // Flag off for the host: the cap still refuses the third free server.
  const plainHost = await seedServer("plain-host", "free");
  const plainA = await seedServer("plain-a", "free");
  const plainB = await seedServer("plain-b", "free");
  await assert.rejects(() => createJoint(plainHost, [plainA, plainB]), rejectsWith("joint_free_server_limit"));
});

test("external channels on for the host: a free server already in an external channel is refused a second by a joint invite accept; a paid one is not", async ({ db: _db }) => {
  const host1 = await seedServer("ext-host-1", "founder");
  const host2 = await seedServer("ext-host-2", "founder");
  await enableExternalChannelsFlag(host1.server.id);
  await enableExternalChannelsFlag(host2.server.id);
  const free = await seedServer("ext-free", "free");
  const paid = await seedServer("ext-paid", "founder");
  const first = await createJoint(host1, [free, paid]);
  const second = await createJoint(host2, [free, paid]);

  await accept(inviteFor(first, free).id, free);
  await assert.rejects(() => accept(inviteFor(second, free).id, free), rejectsWithConnectingLimit(free.server.id));
  assert.deepEqual(await activeServerIds(second.jointChannel.id), [host2.server.id]);

  await accept(inviteFor(first, paid).id, paid);
  await accept(inviteFor(second, paid).id, paid);
  assert.deepEqual(await activeServerIds(second.jointChannel.id), [host2.server.id, paid.server.id].sort());

  // The host of the second joint without the flag: the old rules, no such refusal.
  const plainHost = await seedServer("plain-host", "founder");
  const third = await createJoint(plainHost, [free]);
  await accept(inviteFor(third, free).id, free);
  assert.deepEqual(await activeServerIds(third.jointChannel.id), [plainHost.server.id, free.server.id].sort());
});

test("external channels on for the host: a batch accept that would put a free server in a second external channel is refused as a whole", async ({ db: _db }) => {
  const host1 = await seedServer("ext-host-1", "founder");
  const host2 = await seedServer("ext-host-2", "founder");
  await enableExternalChannelsFlag(host1.server.id);
  await enableExternalChannelsFlag(host2.server.id);
  const acceptor = (await seedServer("acceptor-home", "founder")).owner;
  const free = await seedServerOwnedBy(acceptor, "ext-free", "free");
  const paid = await seedServerOwnedBy(acceptor, "ext-paid", "founder");
  const first = await createJoint(host1, [free]);
  await accept(inviteFor(first, free).id, free);

  const second = await createJoint(host2, [free, paid]);
  await assert.rejects(
    () => acceptJointChannelInvites({ inviteIds: [inviteFor(second, free).id, inviteFor(second, paid).id], acceptedByUserId: acceptor.id }),
    rejectsWithConnectingLimit(free.server.id),
  );
  assert.deepEqual(await activeServerIds(second.jointChannel.id), [host2.server.id], "nothing connected");
  await acceptJointChannelInvites({ inviteIds: [inviteFor(second, paid).id], acceptedByUserId: acceptor.id });
  assert.deepEqual(await activeServerIds(second.jointChannel.id), [host2.server.id, paid.server.id].sort());
});

test("external channels on for the host: an over-limit joint never goes read-only; reconcile and the sweep clear a stored round and never start one", async ({ db: _db }) => {
  const { host, freeA, jointId, hostLocal } = await externalJointWithThreeFree();
  assert.equal(await overLimitSince(jointId), null, "the accept that made three free servers started no round");
  const t0 = new Date("2027-03-01T00:00:00Z");
  const afterGrace = new Date(t0.getTime() + JOINT_CHANNEL_OVER_LIMIT_GRACE_MS);
  const notified: string[] = [];
  onJointLimitStateChanged((parentJointId) => { notified.push(parentJointId); });
  try {
    // A round stored before the host's flag went on.
    await getDb().update(jointChannels).set({ overLimitSince: t0 }).where(eq(jointChannels.id, jointId));
    await sweepJointOverLimit(afterGrace);
    assert.equal(await overLimitSince(jointId), null, "the sweep clears it");
    assert.deepEqual(notified.splice(0), [jointId], "clearing notifies");
    await sweepJointOverLimit(afterGrace);
    assert.equal(await overLimitSince(jointId), null, "the sweep never starts one");
    assert.deepEqual(notified.splice(0), [], "nothing changed, nothing notified");

    await getDb().update(jointChannels).set({ overLimitSince: t0 }).where(eq(jointChannels.id, jointId));
    await reconcileJointsForServer(freeA.server.id, afterGrace);
    assert.equal(await overLimitSince(jointId), null, "billing reconcile clears it");
    assert.deepEqual(notified.splice(0), [jointId], "clearing notifies");
    await reconcileJointsForServer(freeA.server.id, afterGrace);
    assert.equal(await overLimitSince(jointId), null, "billing reconcile never starts one");
    assert.deepEqual(notified.splice(0), []);
  } finally {
    onJointLimitStateChanged(null);
  }
  assert.equal(await isChannelReadOnlyByBillingFeature(hostLocal, host.server.id, afterGrace), false);
});
