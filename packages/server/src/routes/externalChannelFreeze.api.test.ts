// The free plan's external channel freeze (external_channels_v1; services
// externalChannelFreezeService / externalChannelFreezeState): a free server in
// more than one external channel is frozen out of all of them once its
// freeze_at has passed; its humans, its agents and the Guests of the channels
// it hosts can't post there, the other servers of a joint still can, and
// cleanup unfreezes it in the same transaction.
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDb } from "../db/index";
import { channels, externalFreezeLaunchBackfill, jointChannelServers, messages, serverAgentMembers, serverExternalFreezes, serverMembers, servers } from "../db/schema";
import { createAgent } from "../services/agentService";
import { mintAgentCredential } from "../services/agentCredentialService";
import {
  acceptJointChannelInvite,
  addAgent,
  archiveChannel,
  createChannel,
  createJointChannel,
  disconnectJointChannel,
  getOrCreateThreadForChannel,
} from "../services/channelService";
import { createMessage } from "../services/messageService";
import { createServer, removeMember } from "../services/serverService";
import { countExternalChannelsOfServer, getExternalFreezeOfChannel } from "../services/externalChannelFreezeState";
import {
  __resetExternalFreezeBackfillLogForTests,
  EXTERNAL_FREEZE_LAUNCH_GRACE_MS,
  reconcileExternalFreezeForBillingChange,
  reconcileServerExternalFreeze,
  runExternalFreezeLaunchBackfill,
  sweepExternalChannelFreezes,
} from "../services/externalChannelFreezeService";
import { hasOtherExternalChannel } from "../services/externalChannelLimitService";
import { createTasks } from "../services/taskService";
import { ensureTaskConversation } from "../services/taskConversationService";
import { createApiTest } from "../test/integration/apiTest";
import { enableTaskV2ConversationsForServer } from "../test/integration/taskV2Flag";
import { enableExternalChannelsFlag, login, seedUser, seedWorld } from "../test/externalInviteFixture";
import { capturePaywallHits } from "../test/integration/paywallHits";
import { seedBoundGuest } from "../test/guestFixture";
import { setChannelArchivedForAgent } from "./agentChannelLifecycle";

const test = createApiTest();

type Person = Awaited<ReturnType<typeof seedUser>> & { token: string };
type Plan = "free" | "pro" | "founder";

const tag = () => randomBytes(4).toString("hex");

async function person(baseUrl: string, label: string): Promise<Person> {
  const user = await seedUser(`${label}-${tag()}`);
  return { ...user, token: await login(baseUrl, user.email) };
}

async function serverOf(owner: Person, plan: Plan, options: { flag?: boolean } = {}) {
  const server = await createServer("Freeze", `freeze-${tag()}`, owner.id);
  await setPlan(server.id, plan);
  if (options.flag) await enableExternalChannelsFlag(server.id);
  return server;
}

async function setPlan(serverId: string, plan: Plan) {
  await getDb().update(servers).set({ plan }).where(eq(servers.id, serverId));
}

async function markLaunchBackfillDone() {
  await getDb().insert(externalFreezeLaunchBackfill).values({ id: 1, launchAt: new Date(), completedAt: new Date() }).onConflictDoNothing();
}

async function storedFreezeAt(serverId: string): Promise<Date | null> {
  const [row] = await getDb().select({ freezeAt: serverExternalFreezes.freezeAt }).from(serverExternalFreezes).where(eq(serverExternalFreezes.serverId, serverId));
  return row?.freezeAt ?? null;
}

/** `host` hosts a joint channel `target` connects to with the ordinary joint invite accept. Both local channels. */
async function connectJoint(host: { owner: Person; serverId: string }, target: { owner: Person; serverId: string; slug: string }) {
  const created = await createJointChannel({
    hostServerId: host.serverId,
    createdByUserId: host.owner.id,
    name: `joint-${tag()}`,
    jointInvites: [{ targetServerSlug: target.slug, invitedPeople: [target.owner.email] }],
  });
  const invite = created.invites.find((row) => row.toServerId === target.serverId)!;
  const targetLocal = await acceptJointChannelInvite({ inviteId: invite.id, targetServerId: target.serverId, acceptedByUserId: target.owner.id });
  return { hostLocal: created.channel, targetLocal, canonicalChannelId: created.jointChannel.canonicalChannelId };
}

async function post(baseUrl: string, as: Person, serverId: string, channelId: string) {
  const response = await fetch(`${baseUrl}/api/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${as.token}`, "Content-Type": "application/json", "X-Server-Id": serverId },
    body: JSON.stringify({ channelId, content: `hello ${tag()}` }),
  });
  return { status: response.status, body: await response.json() as { error?: string; code?: string; externalFreezeAt?: string } };
}

async function agentIn(serverId: string, channelId: string) {
  const agent = await createAgent(serverId, `freeze-agent-${tag()}`, { runtime: "codex" });
  await addAgent(channelId, agent.id);
  const { apiKey } = await mintAgentCredential({ agentId: agent.id, scopes: ["send", "read"], name: "freeze", issuedVia: "computer", createdByUserId: null });
  return apiKey;
}

async function agentPost(baseUrl: string, apiKey: string, target: string) {
  const response = await fetch(`${baseUrl}/internal/agent-api/send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ target, content: `agent ${tag()}` }),
  });
  return { status: response.status, body: await response.json() as { error?: string; code?: string } };
}

function assertFrozen(result: { status: number; body: { code?: string; externalFreezeAt?: string } }, label: string) {
  assert.equal(result.status, 403, `${label}: ${JSON.stringify(result.body)}`);
  assert.equal(result.body.code, "external_limit_frozen", label);
}

/** A free server S with the flag on, in two joint channels hosted by two paid servers (their flag off). */
async function freeParticipantInTwoJoints(baseUrl: string, options: { flag?: boolean } = {}) {
  const sOwner = await person(baseUrl, "fz-s");
  const s = await serverOf(sOwner, "free", { flag: options.flag !== false });
  const hosts = [];
  for (const label of ["fz-h1", "fz-h2"]) {
    const owner = await person(baseUrl, label);
    const server = await serverOf(owner, "pro");
    hosts.push({ owner, server });
  }
  const before = new Date();
  const first = await connectJoint({ owner: hosts[0]!.owner, serverId: hosts[0]!.server.id }, { owner: sOwner, serverId: s.id, slug: s.slug });
  const secondAt = new Date();
  const second = await connectJoint({ owner: hosts[1]!.owner, serverId: hosts[1]!.server.id }, { owner: sOwner, serverId: s.id, slug: s.slug });
  return { sOwner, s, hosts, first, second, before, secondAt };
}

test("a free server in two joint channels: its humans and agents are frozen out of both at once, the other servers keep posting, reads stay open; disconnecting one unfreezes it in the same transaction", async ({ app }) => {
  await markLaunchBackfillDone();
  const world = await freeParticipantInTwoJoints(app.baseUrl);
  const { sOwner, s, hosts, first, second } = world;

  // A new over-limit gets no grace: freeze_at is the second accept's time.
  const freezeAt = await storedFreezeAt(s.id);
  assert.ok(freezeAt, "the second external channel freezes the free server");
  assert.ok(freezeAt.getTime() >= world.secondAt.getTime() && freezeAt.getTime() <= Date.now(), "freeze_at = now, no grace");
  assert.equal(await storedFreezeAt(hosts[0]!.server.id), null, "paid hosts are never frozen");

  const humanFirst = await post(app.baseUrl, sOwner, s.id, first.targetLocal.id);
  assertFrozen(humanFirst, "S's human in the first joint");
  assert.equal(humanFirst.body.externalFreezeAt, freezeAt.toISOString());
  assertFrozen(await post(app.baseUrl, sOwner, s.id, second.targetLocal.id), "S's human in the second joint");

  const apiKey = await agentIn(s.id, first.targetLocal.id);
  assertFrozen(await agentPost(app.baseUrl, apiKey, `#${first.targetLocal.name}`), "S's agent (agent API send)");

  // The other server of the same joint keeps writing, in its own projection.
  assert.equal((await post(app.baseUrl, hosts[0]!.owner, hosts[0]!.server.id, first.hostLocal.id)).status, 200);

  // Reads stay open.
  const read = await fetch(`${app.baseUrl}/api/messages/channel/${first.targetLocal.id}`, {
    headers: { Authorization: `Bearer ${sOwner.token}`, "X-Server-Id": s.id },
  });
  assert.equal(read.status, 200);

  // Cleanup: disconnecting one joint (not a message write) is allowed and unfreezes at once.
  await disconnectJointChannel(second.targetLocal.id, sOwner.id);
  assert.equal(await storedFreezeAt(s.id), null, "the row goes in the disconnect's transaction");
  assert.equal((await post(app.baseUrl, sOwner, s.id, first.targetLocal.id)).status, 200);
  assert.equal((await agentPost(app.baseUrl, apiKey, `#${first.targetLocal.name}`)).status, 200);
});

test("a frozen host: its members, its agents and the Guests of its channel can't post; removing the last Guest unfreezes it", async ({ app }) => {
  await markLaunchBackfillDone();
  // A free host (flag on) with a private room that has a bound Guest...
  const world = await seedWorld(app.baseUrl);
  const owner = { ...world.owner, token: await login(app.baseUrl, world.owner.email) };
  const guest = { ...world.guest, token: await login(app.baseUrl, world.guest.email) };
  // Seeded directly (no accept), so the room's server is reconciled by nothing yet.
  assert.equal(await storedFreezeAt(world.server.id), null);
  // ...that also hosts a joint channel a paid server joins: two external channels.
  const peerOwner = await person(app.baseUrl, "fz-peer");
  const peer = await serverOf(peerOwner, "pro");
  const joint = await connectJoint({ owner, serverId: world.server.id }, { owner: peerOwner, serverId: peer.id, slug: peer.slug });
  assert.ok(await storedFreezeAt(world.server.id), "the host's second external channel freezes it");

  assertFrozen(await post(app.baseUrl, owner, world.server.id, world.room.id), "the host's member in the Guest channel");
  assertFrozen(await post(app.baseUrl, owner, world.server.id, joint.hostLocal.id), "the host's member in the joint");
  assertFrozen(await post(app.baseUrl, guest, world.server.id, world.room.id), "the Guest (entry server: the host)");
  const apiKey = await agentIn(world.server.id, world.room.id);
  assertFrozen(await agentPost(app.baseUrl, apiKey, `#${world.room.name}`), "the host's agent");
  // A channel that is not external stays writable.
  const plain = await createChannel(world.server.id, `fz-plain-${tag()}`, undefined, "private", { type: "user", id: owner.id });
  assert.equal((await post(app.baseUrl, owner, world.server.id, plain.id)).status, 200);
  // The paid side of the joint keeps writing.
  assert.equal((await post(app.baseUrl, peerOwner, peer.id, joint.targetLocal.id)).status, 200);

  // Cleanup: removing the room's only Guest leaves one external channel.
  await removeMember(world.server.id, world.guest.id);
  assert.equal(await storedFreezeAt(world.server.id), null, "the row goes in the removal's transaction");
  assert.equal((await post(app.baseUrl, owner, world.server.id, world.room.id)).status, 200);
  assert.equal((await post(app.baseUrl, owner, world.server.id, joint.hostLocal.id)).status, 200);
});

test("a frozen host's agent can't update its card message in the Guest channel either: 403 external_limit_frozen, the card unchanged (RFC 082, #12644)", async ({ app }) => {
  await markLaunchBackfillDone();
  const world = await seedWorld(app.baseUrl);
  const owner = { ...world.owner, token: await login(app.baseUrl, world.owner.email) };
  const apiKey = await agentIn(world.server.id, world.room.id);
  const card = (state: string) => ({ version: 1, root: "root", elements: {
    root: { type: "Stack", props: {}, children: ["state"] },
    state: { type: "Badge", props: { text: state } },
  } });
  const agentApi = async (method: string, path: string, body: unknown) => {
    const response = await fetch(`${app.baseUrl}/internal/agent-api${path}`, {
      method,
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as { code?: string; messageId?: string; message?: { id?: string } } };
  };
  // Sent before the freeze.
  const sent = await agentApi("POST", "/v2/send", { target: `#${world.room.name}`, card: card("Building") });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const messageId = sent.body.messageId ?? sent.body.message?.id;
  assert.ok(messageId, JSON.stringify(sent.body));
  const [before] = await getDb().select({ content: messages.content, actionMetadata: messages.actionMetadata }).from(messages).where(eq(messages.id, messageId));

  // The host's second external channel freezes it.
  const peerOwner = await person(app.baseUrl, "fz-card-peer");
  const peer = await serverOf(peerOwner, "pro");
  await connectJoint({ owner, serverId: world.server.id }, { owner: peerOwner, serverId: peer.id, slug: peer.slug });
  assert.ok(await storedFreezeAt(world.server.id));

  const refused = await agentApi("PUT", `/messages/${messageId}/card`, { card: card("Shipped") });
  assertFrozen(refused, "the frozen host's agent updating its card");
  const [after] = await getDb().select({ content: messages.content, actionMetadata: messages.actionMetadata }).from(messages).where(eq(messages.id, messageId));
  assert.deepEqual(after, before, "the card and its fallback did not change");
});

test("upgrading the server (billing change hook) deletes its freeze row and it posts again", async ({ app }) => {
  await markLaunchBackfillDone();
  const { sOwner, s, first } = await freeParticipantInTwoJoints(app.baseUrl);
  assert.ok(await storedFreezeAt(s.id));
  await setPlan(s.id, "pro");
  assert.equal(await reconcileExternalFreezeForBillingChange(s.id), "cleared");
  assert.equal(await storedFreezeAt(s.id), null);
  assert.equal((await post(app.baseUrl, sOwner, s.id, first.targetLocal.id)).status, 200);
  // A downgrade freezes again at once.
  await setPlan(s.id, "free");
  const downgradedAt = new Date();
  assert.equal(await reconcileExternalFreezeForBillingChange(s.id, downgradedAt), "frozen");
  assert.equal((await storedFreezeAt(s.id))?.getTime(), downgradedAt.getTime());
  assertFrozen(await post(app.baseUrl, sOwner, s.id, first.targetLocal.id), "after the downgrade");
});

test("flag off for the server: no freeze row, writes allowed", async ({ app }) => {
  await markLaunchBackfillDone();
  const { sOwner, s, first, second } = await freeParticipantInTwoJoints(app.baseUrl, { flag: false });
  assert.equal(await countExternalChannelsOfServer(getDb(), s.id), 2, "over by count");
  assert.equal(await storedFreezeAt(s.id), null);
  assert.equal(await reconcileServerExternalFreeze(getDb(), s.id, new Date()), "none");
  assert.equal((await sweepExternalChannelFreezes()).frozen, 0);
  assert.equal(await storedFreezeAt(s.id), null);
  assert.equal((await post(app.baseUrl, sOwner, s.id, first.targetLocal.id)).status, 200);
  assert.equal((await post(app.baseUrl, sOwner, s.id, second.targetLocal.id)).status, 200);
  // A row left from when the flag was on does not freeze it either.
  await getDb().insert(serverExternalFreezes).values({ serverId: s.id, freezeAt: new Date(Date.now() - 1000) });
  assert.equal(await getExternalFreezeOfChannel(first.targetLocal.id, s.id), null);
  const channel = await fetch(`${app.baseUrl}/api/channels/${first.targetLocal.id}`, { headers: { Authorization: `Bearer ${sOwner.token}`, "X-Server-Id": s.id } });
  assert.equal(((await channel.json()) as { externalFreezeAt?: string | null }).externalFreezeAt, null, "no notice either");
});

test("a free server in one joint channel with many threads and task conversations is not over", async ({ app }) => {
  await markLaunchBackfillDone();
  const sOwner = await person(app.baseUrl, "fz-one");
  const s = await serverOf(sOwner, "free", { flag: true });
  const hostOwner = await person(app.baseUrl, "fz-one-host");
  const host = await serverOf(hostOwner, "pro");
  await enableTaskV2ConversationsForServer(host.id);
  await enableTaskV2ConversationsForServer(s.id);
  const joint = await connectJoint({ owner: hostOwner, serverId: host.id }, { owner: sOwner, serverId: s.id, slug: s.slug });
  for (let i = 0; i < 3; i++) {
    const parent = await createMessage(joint.canonicalChannelId, "user", hostOwner.id, `parent ${i}`);
    await getOrCreateThreadForChannel(joint.hostLocal.id, parent.id, hostOwner.id, "user");
    await getOrCreateThreadForChannel(joint.targetLocal.id, parent.id, sOwner.id, "user");
  }
  for (let i = 0; i < 2; i++) {
    const created = await createTasks(joint.canonicalChannelId, "user", hostOwner.id, [{ title: `task ${i}` }], { initiatingServerId: host.id });
    assert.ok(await ensureTaskConversation(created.tasks[0]!.id, { initiatingServerId: host.id }));
  }
  assert.equal(await countExternalChannelsOfServer(getDb(), s.id), 1, "sub-records follow their parent joint");
  assert.equal(await hasOtherExternalChannel(getDb(), s.id, joint.targetLocal.id), false, "the admission rule agrees");
  assert.equal(await reconcileServerExternalFreeze(getDb(), s.id, new Date()), "none");
  assert.equal((await sweepExternalChannelFreezes()).frozen, 0);
  assert.equal(await storedFreezeAt(s.id), null);
  assert.equal((await post(app.baseUrl, sOwner, s.id, joint.targetLocal.id)).status, 200);
});

test("the sweep and the launch backfill: nothing is created before the backfill has run; the backfill gives launch + 14 days, never overwrites, and reports counts only; the sweep then creates and clears", async ({ app }) => {
  __resetExternalFreezeBackfillLogForTests();
  // Over before any freeze can be written: the accepts create nothing.
  const { sOwner, s } = await freeParticipantInTwoJoints(app.baseUrl);
  assert.equal(await storedFreezeAt(s.id), null, "no row before the backfill");
  const beforeBackfill = await sweepExternalChannelFreezes();
  assert.equal(beforeBackfill.backfillDone, false);
  assert.equal(beforeBackfill.frozen, 0);
  assert.ok(beforeBackfill.over >= 1);
  assert.equal(await storedFreezeAt(s.id), null, "the sweep creates nothing either");

  // A second over server with the flag off: the backfill ignores the flag.
  const other = await freeParticipantInTwoJoints(app.baseUrl, { flag: false });
  const expectedSha = createHash("sha256").update([s.id, other.s.id].sort().join("\n")).digest("hex");

  const dryRun = await runExternalFreezeLaunchBackfill({ apply: false, launchAt: null });
  assert.equal(dryRun.mode, "dry-run");
  assert.equal(dryRun.over, 2);
  assert.equal(dryRun.inserted, 2);
  assert.equal(dryRun.overIdsSha256, expectedSha);
  assert.ok(!JSON.stringify(dryRun).includes(s.id), "no ids in the report");
  assert.equal(await storedFreezeAt(s.id), null, "a dry run writes nothing");
  assert.equal((await getDb().select().from(externalFreezeLaunchBackfill)).length, 0);

  // One server already has a row (e.g. a manual one): kept as it is.
  const kept = new Date(Date.now() + 60_000);
  await getDb().insert(serverExternalFreezes).values({ serverId: other.s.id, freezeAt: kept });
  const launchAt = new Date("2026-11-10T00:00:00.000Z");
  const applied = await runExternalFreezeLaunchBackfill({ apply: true, launchAt });
  assert.equal(applied.inserted, 1);
  assert.equal(applied.existing, 1);
  assert.equal(applied.overIdsSha256, expectedSha);
  assert.equal((await storedFreezeAt(s.id))?.getTime(), launchAt.getTime() + EXTERNAL_FREEZE_LAUNCH_GRACE_MS);
  assert.equal((await storedFreezeAt(other.s.id))?.getTime(), kept.getTime(), "an existing row is not overwritten");
  const [marker] = await getDb().select().from(externalFreezeLaunchBackfill);
  assert.equal(marker?.launchAt.getTime(), launchAt.getTime());
  assert.equal((await runExternalFreezeLaunchBackfill({ apply: true, launchAt })).inserted, 0, "re-running is a no-op");

  // In grace: still writable.
  assert.equal((await post(app.baseUrl, sOwner, s.id, (await connectedLocal(s.id)).id)).status, 200);

  // The sweep keeps the backfilled time, clears a server no longer over...
  await setPlan(other.s.id, "pro");
  const third = await freeParticipantInTwoJoints(app.baseUrl);
  await getDb().delete(serverExternalFreezes).where(eq(serverExternalFreezes.serverId, third.s.id));
  const swept = await sweepExternalChannelFreezes();
  assert.equal(swept.backfillDone, true);
  assert.equal(await storedFreezeAt(other.s.id), null, "cleared: upgraded");
  assert.equal((await storedFreezeAt(s.id))?.getTime(), launchAt.getTime() + EXTERNAL_FREEZE_LAUNCH_GRACE_MS, "never moved");
  // ...and creates a missing one (no grace) now that the backfill has run.
  assert.ok(await storedFreezeAt(third.s.id), "created");
  assert.ok(swept.frozen >= 1 && swept.cleared >= 1);
});

async function connectedLocal(serverId: string) {
  const [row] = await getDb().select({ id: jointChannelServers.localChannelId }).from(jointChannelServers)
    .where(eq(jointChannelServers.serverId, serverId)).limit(1);
  return row!;
}

test("the write gate re-checks the rule: a server that left the limit on a path that did not reconcile writes at once", async ({ app }) => {
  await markLaunchBackfillDone();
  const { sOwner, s, first, second } = await freeParticipantInTwoJoints(app.baseUrl);
  assertFrozen(await post(app.baseUrl, sOwner, s.id, first.targetLocal.id), "frozen to begin with");
  const metadataFreezeAt = async () => {
    const view = await fetch(`${app.baseUrl}/api/channels/${first.targetLocal.id}`, { headers: { Authorization: `Bearer ${sOwner.token}`, "X-Server-Id": s.id } });
    assert.equal(view.status, 200);
    return ((await view.json()) as { externalFreezeAt?: string | null }).externalFreezeAt ?? null;
  };
  assert.equal(await metadataFreezeAt(), (await storedFreezeAt(s.id))!.toISOString(), "genuinely frozen: the metadata names the freeze");

  // Paid by a path that calls no billing hook: allowed at once, the stale row left for the sweep.
  await setPlan(s.id, "pro");
  assert.equal((await post(app.baseUrl, sOwner, s.id, first.targetLocal.id)).status, 200);
  assert.ok(await storedFreezeAt(s.id), "the row is not the gate's to delete");
  assert.equal(await metadataFreezeAt(), null, "stale row, paid: no notice either");
  await setPlan(s.id, "free");
  assertFrozen(await post(app.baseUrl, sOwner, s.id, first.targetLocal.id), "free again");

  // The second channel gone by a path that does not reconcile: one external channel left.
  await getDb().update(jointChannelServers).set({ status: "disconnected" }).where(eq(jointChannelServers.localChannelId, second.targetLocal.id));
  assert.equal((await post(app.baseUrl, sOwner, s.id, first.targetLocal.id)).status, 200);
  assert.ok(await storedFreezeAt(s.id));
  assert.equal(await metadataFreezeAt(), null, "stale row, one external channel: no notice either");
  await sweepExternalChannelFreezes();
  assert.equal(await storedFreezeAt(s.id), null, "the sweep deletes the stale row");
});

async function unarchive(baseUrl: string, as: Person, serverId: string, channelId: string) {
  const response = await fetch(`${baseUrl}/api/channels/${channelId}/unarchive`, {
    method: "POST",
    headers: { Authorization: `Bearer ${as.token}`, "X-Server-Id": serverId },
  });
  return { status: response.status, body: await response.json() as { error?: string; code?: string; limitSide?: string; limitServerId?: string } };
}

async function archivedAt(channelId: string) {
  const [row] = await getDb().select({ archivedAt: channels.archivedAt }).from(channels).where(eq(channels.id, channelId));
  return row?.archivedAt ?? null;
}

/** A free host (flag as given) with a Guest channel, and a second private channel with a bound Guest, archived. */
async function hostWithArchivedGuestChannel(baseUrl: string, flag: boolean) {
  const world = await seedWorld(baseUrl, { flag });
  const owner = { ...world.owner, token: await login(baseUrl, world.owner.email) };
  const archived = await createChannel(world.server.id, `fz-archived-${tag()}`, undefined, "private", { type: "user", id: owner.id });
  await archiveChannel(archived.id, owner.id);
  const guest = await seedUser(`fz-archived-guest-${tag()}`);
  await seedBoundGuest({ serverId: world.server.id, userId: guest.id, channelId: archived.id });
  return { world, owner, archived };
}

test("unarchiving a second external channel of a free server is refused like an admission (free_external_limit); paid or flag off, it is allowed", async ({ app }) => {
  await markLaunchBackfillDone();
  const { world, owner, archived } = await hostWithArchivedGuestChannel(app.baseUrl, true);
  const paywall = capturePaywallHits(app);
  const refused = await unarchive(app.baseUrl, owner, world.server.id, archived.id);
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.code, "free_external_limit");
  // The server's own person stopped by its own limit: a paywall hit (#wg-rbac:#60).
  await paywall.expect(1, "the refused unarchive");
  assert.deepEqual(paywall.hits().map((hit) => ({ properties: hit.properties, serverId: hit.serverId })), [
    { properties: { gate: "external_channel_free_limit", actor: "person", plan: "free", viewer_role: "owner", limit_side: "host" }, serverId: world.server.id },
  ]);
  assert.deepEqual({ side: refused.body.limitSide, server: refused.body.limitServerId }, { side: "host", server: world.server.id });
  assert.match(refused.body.error ?? "", /Free plan/);
  assert.ok(await archivedAt(archived.id), "still archived");
  assert.equal(await storedFreezeAt(world.server.id), null, "nothing is frozen");

  // Paid: allowed.
  await setPlan(world.server.id, "pro");
  assert.equal((await unarchive(app.baseUrl, owner, world.server.id, archived.id)).status, 200);
  assert.equal(await archivedAt(archived.id), null);

  // Flag off: allowed as today (and nothing frozen).
  const off = await hostWithArchivedGuestChannel(app.baseUrl, false);
  assert.equal((await unarchive(app.baseUrl, off.owner, off.world.server.id, off.archived.id)).status, 200);
  assert.equal(await storedFreezeAt(off.world.server.id), null);
});

test("unarchiving a joint channel is refused when a free server in it already has another external channel (the host's flag)", async ({ app }) => {
  await markLaunchBackfillDone();
  const sOwner = await person(app.baseUrl, "fz-ua-s");
  const s = await serverOf(sOwner, "free", { flag: true });
  const h2Owner = await person(app.baseUrl, "fz-ua-h2");
  const h2 = await serverOf(h2Owner, "pro", { flag: true });
  const j2 = await connectJoint({ owner: h2Owner, serverId: h2.id }, { owner: sOwner, serverId: s.id, slug: s.slug });
  await archiveChannel(j2.hostLocal.id, h2Owner.id);
  const h1Owner = await person(app.baseUrl, "fz-ua-h1");
  const h1 = await serverOf(h1Owner, "pro");
  await connectJoint({ owner: h1Owner, serverId: h1.id }, { owner: sOwner, serverId: s.id, slug: s.slug });
  assert.equal(await countExternalChannelsOfServer(getDb(), s.id), 1);

  const paywall = capturePaywallHits(app);
  const refused = await unarchive(app.baseUrl, h2Owner, h2.id, j2.hostLocal.id);
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.code, "free_external_limit");
  assert.deepEqual({ side: refused.body.limitSide, server: refused.body.limitServerId }, { side: "connecting", server: s.id });
  assert.ok(await archivedAt(j2.hostLocal.id));
  assert.equal(await storedFreezeAt(s.id), null);
  // Another organisation's server is the one at its limit: its plan is not told (#wg-rbac:#61).
  const OTHER_SERVER = "This channel can't be unarchived right now: one of the servers connected to it can't be in another shared channel. Ask that server's admins, or disconnect it from this channel first.";
  assert.equal(refused.body.error, OTHER_SERVER);
  assert.equal(/free|plan|upgrade/i.test(refused.body.error ?? ""), false);
  // An admin agent of the unarchiving server is answered the same.
  // (A plan with a seat for the agent; the unarchiving server's own plan decides nothing here.)
  await getDb().update(servers).set({ plan: "founder" }).where(eq(servers.id, h2.id));
  const agent = await createAgent(h2.id, `freeze-admin-${tag()}`, { runtime: "codex" });
  await getDb().update(serverAgentMembers).set({ role: "admin" }).where(and(eq(serverAgentMembers.serverId, h2.id), eq(serverAgentMembers.agentId, agent.id)));
  await addAgent(j2.hostLocal.id, agent.id);
  const byAgent = await setChannelArchivedForAgent({ actor: { id: agent.id, name: agent.name, serverId: h2.id }, serverId: h2.id, channelId: j2.hostLocal.id, archived: false });
  assert.equal(byAgent.status, 409, JSON.stringify(byAgent.body));
  assert.deepEqual(byAgent.body, { error: OTHER_SERVER, code: "free_external_limit", limitSide: "connecting", limitServerId: s.id });

  // Stopped by another organisation's limit, a person and an agent: no paywall hit, for either server (#wg-rbac:#60).
  await paywall.expect(0, "another server's limit");

  // Only the host unarchives a joint channel (computed joint membership): a
  // participant server's own admin is refused before any limit is read.
  assert.equal((await unarchive(app.baseUrl, sOwner, s.id, j2.targetLocal.id)).status, 403);
  await paywall.expect(0, "a refused participant unarchive records nothing");

  await setPlan(s.id, "pro");
  assert.equal((await unarchive(app.baseUrl, h2Owner, h2.id, j2.hostLocal.id)).status, 200);
});

test("the sweep deletes freeze rows of servers that are deleted or gone (no foreign key keeps them out)", async ({ app }) => {
  await markLaunchBackfillDone();
  const { s } = await freeParticipantInTwoJoints(app.baseUrl);
  assert.ok(await storedFreezeAt(s.id));
  await getDb().update(servers).set({ deletedAt: new Date() }).where(eq(servers.id, s.id));
  const gone = randomUUID();
  await getDb().insert(serverExternalFreezes).values({ serverId: gone, freezeAt: new Date() });
  const swept = await sweepExternalChannelFreezes();
  assert.ok(swept.cleared >= 2);
  assert.equal(await storedFreezeAt(s.id), null, "a soft-deleted server's row");
  assert.equal(await storedFreezeAt(gone), null, "an orphan row");
});

test("the billing summary counts every external channel the server is in, hosted or connected to, as the freeze counts them (externalChannelsTotal); only to those who read billing", async ({ app }) => {
  const { sOwner, s } = await freeParticipantInTwoJoints(app.baseUrl);
  const admin = await person(app.baseUrl, "fz-total-admin");
  const member = await person(app.baseUrl, "fz-total-member");
  await getDb().insert(serverMembers).values([{ serverId: s.id, userId: admin.id, role: "admin" }, { serverId: s.id, userId: member.id, role: "member" }]);
  const summary = async (as: Person) => {
    const response = await fetch(`${app.baseUrl}/api/billing/subscription`, { headers: { Authorization: `Bearer ${as.token}`, "X-Server-Id": s.id } });
    return { status: response.status, body: await response.json() as { externalChannelsTotal?: number } };
  };
  const total = async (as: Person) => {
    const read = await summary(as);
    assert.equal(read.status, 200, JSON.stringify(read.body));
    return read.body.externalChannelsTotal;
  };

  // Connected to two joints another server hosts.
  assert.equal(await total(sOwner), 2);
  // Hosting one with a Guest: three, the freeze's own count.
  const guestChannel = await seedBoundGuest({ serverId: s.id, userId: (await person(app.baseUrl, "fz-total-guest")).id });
  assert.equal(await total(sOwner), 3);
  assert.equal(await total(sOwner), await countExternalChannelsOfServer(getDb(), s.id));
  // An admin reads billing too; a member reads none of it.
  assert.equal(await total(admin), 3);
  const refused = await summary(member);
  assert.equal(refused.status, 403);
  assert.equal(refused.body.externalChannelsTotal, undefined);
  // Archived: not external.
  await getDb().update(channels).set({ archivedAt: new Date() }).where(eq(channels.id, guestChannel));
  assert.equal(await total(sOwner), 2);
});
