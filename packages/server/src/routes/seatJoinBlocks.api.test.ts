import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
// Join links that can't let someone in (task #10 #proj-commercial, behind
// pro_seat_add): a signed-in person a full invite or join link turned away is
// recorded (POST /api/invites/seat-blocked) with the link's creator from the
// token; the server's owners, admins and that creator see it (GET
// /api/servers/:id/seat-join-blocks, which only reads) until the person joins,
// there's a seat again, or 7 days pass. A `join` seat request asks an owner
// for that seat: an action card like any seat request, which ends at once if
// the person is no longer waiting, and keeps no one off the server once ended.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { PRO_AGENT_SEAT_BLOCK_SIZE, PRO_SEAT_ADD_FEATURE_FLAG_KEY, SEAT_JOIN_BLOCKS_CHANGED_EVENT } from "@botiverse/raft-shared";
import type { ActionCardMetadata, SeatJoinBlocksResponse } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { actionCards, channelHumans, channels, featureFlags, messages, seatJoinBlocks, serverInvites, serverJoinLinks, serverMembers, servers, subscriptions, users } from "../db/schema";
import { addMember, createServer, removeMember, removeMemberInTransaction, transitionMemberRole } from "../services/serverService";
import { sweepExpiredSeatRequests } from "../services/seatRequestService";
import { MAX_ACTIVE_SEAT_JOIN_BLOCKS, RESOLVED_SEAT_JOIN_BLOCK_RETENTION_MS, resolveSeatJoinBlock, resolveSeatJoinBlocksWithRoom } from "../services/seatJoinBlockService";
import { setListChangedRealtimeIO } from "../services/listChangedRealtime";
import { seedBoundGuest } from "../test/guestFixture";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

async function seedUser(label: string) {
  const suffix = randomUUID().slice(0, 8);
  const [user] = await getDb().insert(users).values({
    email: `${label}-${suffix}@test.invalid`,
    name: `${label}-${suffix}`,
    displayName: label,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user!;
}

async function setFlag(enabled: boolean) {
  await getDb().insert(featureFlags)
    .values({ key: PRO_SEAT_ADD_FEATURE_FLAG_KEY, randomizationUnit: "server", salt: "test", defaultEnabled: true, enabled })
    .onConflictDoUpdate({ target: featureFlags.key, set: { enabled, defaultEnabled: true, killSwitch: false } });
}

async function setSeats(serverId: string, ownerId: string, seats: number) {
  const db = getDb();
  const [existing] = await db.select({ id: subscriptions.id }).from(subscriptions).where(eq(subscriptions.serverId, serverId)).limit(1);
  const values = {
    provisionedHumanSeats: seats,
    provisionedAgentSeats: seats * PRO_AGENT_SEAT_BLOCK_SIZE,
    proPackQuantity: seats,
  };
  if (existing) {
    await db.update(subscriptions).set(values).where(eq(subscriptions.id, existing.id));
    return;
  }
  await db.insert(subscriptions).values({
    serverId,
    plan: "pro",
    provider: "stripe",
    stripeCustomerId: `cus_${randomUUID()}`,
    stripeSubscriptionId: `sub_${randomUUID()}`,
    stripeProPackItemId: `si_pro_${randomUUID()}`,
    status: "active",
    ...values,
    trialFreePackQuantity: 1,
    firstPackTrialEndsAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
    currentPeriodStart: new Date(),
    currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    createdByUserId: ownerId,
    updatedByUserId: ownerId,
  });
}

async function joinLink(serverId: string, createdByUserId: string) {
  const token = `link-${randomUUID().slice(0, 12)}`;
  await getDb().insert(serverJoinLinks).values({ serverId, createdByUserId, token });
  return token;
}

/**
 * An owner, an admin, a member and Lin (a member who made a join link while an
 * admin) on a Pro server whose 4 seats they fill, and Grace, outside it.
 */
async function seedWorld() {
  const owner = await seedUser("blocks-owner");
  const admin = await seedUser("blocks-admin");
  const member = await seedUser("blocks-member");
  const lin = await seedUser("Lin Mo");
  const grace = await seedUser("Grace Hopper");
  const server = await createServer("Lumen Studio", `lumen-${randomUUID().slice(0, 8)}`, owner.id);
  await getDb().insert(serverMembers).values([
    { serverId: server.id, userId: admin.id, role: "admin" },
    { serverId: server.id, userId: member.id, role: "member" },
    { serverId: server.id, userId: lin.id, role: "member" },
  ]);
  await setSeats(server.id, owner.id, 4);
  await setFlag(true);
  const token = await joinLink(server.id, lin.id);
  return { owner, admin, member, lin, grace, server, token };
}

async function post(baseUrl: string, email: string, path: string, body: unknown, serverId?: string) {
  const auth = await tokenForHuman(email);
  return fetch(`${baseUrl}/api${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${auth}`, "Content-Type": "application/json", ...(serverId ? { "X-Server-Id": serverId } : {}) },
    body: JSON.stringify(body),
  });
}

async function blocked(baseUrl: string, email: string, body: unknown) {
  const res = await post(baseUrl, email, "/invites/seat-blocked", body);
  return { status: res.status, body: await res.json() as { recorded?: boolean } };
}

async function list(baseUrl: string, email: string, serverId: string) {
  const auth = await tokenForHuman(email);
  const res = await fetch(`${baseUrl}/api/servers/${serverId}/seat-join-blocks`, { headers: { Authorization: `Bearer ${auth}`, "X-Server-Id": serverId } });
  assert.equal(res.status, 200);
  return (await res.json() as SeatJoinBlocksResponse).blocks;
}

async function rows(serverId: string) {
  return getDb().select().from(seatJoinBlocks).where(eq(seatJoinBlocks.serverId, serverId));
}

async function listed(baseUrl: string, email: string, serverId: string) {
  const auth = await tokenForHuman(email);
  const res = await fetch(`${baseUrl}/api/servers/${serverId}/seat-join-blocks`, { headers: { Authorization: `Bearer ${auth}`, "X-Server-Id": serverId } });
  return await res.json() as SeatJoinBlocksResponse;
}

/** An admin asks the owner for a seat for Grace (she was turned away first); the card's message id. */
async function askJoin(baseUrl: string, world: Awaited<ReturnType<typeof seedWorld>>) {
  await blocked(baseUrl, world.grace.email, { token: world.token });
  const res = await post(baseUrl, world.admin.email, "/actions/seat-requests", { ownerUserId: world.owner.id, purpose: { kind: "join", userId: world.grace.id, name: "Grace Hopper" } }, world.server.id);
  assert.equal(res.status, 201, await res.clone().text());
  return (await res.json() as { messageId: string }).messageId;
}

async function check(baseUrl: string, email: string, serverId: string, messageId: string) {
  const res = await fetch(`${baseUrl}/api/actions/${messageId}/seat-request`, {
    headers: { Authorization: `Bearer ${await tokenForHuman(email)}`, "X-Server-Id": serverId },
  });
  return await res.json() as { requesterAllowed: boolean; seatsShort: number };
}

/** The result replies in a card's thread (postActionCardResultReply). */
async function replies(messageId: string) {
  const [thread] = await getDb().select({ id: channels.id }).from(channels)
    .where(and(eq(channels.type, "thread"), eq(channels.parentMessageId, messageId))).limit(1);
  if (!thread) return [];
  return getDb().select({ content: messages.content }).from(messages)
    .where(and(eq(messages.channelId, thread.id), eq(messages.systemSubtype, "action_card.result_reply")));
}

/** An ended join request keeps no one who isn't on the server: not on its row, not on its message (the card drawn again). */
async function assertNamesNoOne(messageId: string, grace: { id: string }) {
  const [row] = await getDb().select().from(actionCards).where(eq(actionCards.messageId, messageId)).limit(1);
  const [message] = await getDb().select().from(messages).where(eq(messages.id, messageId)).limit(1);
  for (const [what, value] of [["card row", row], ["message", message]] as const) {
    const json = JSON.stringify(value);
    assert.ok(!json.includes(grace.id) && !json.includes("Grace"), `no Grace on the ${what}`);
  }
  const nodes = JSON.stringify((message!.actionMetadata as ActionCardMetadata).presentation?.card?.spec.elements);
  assert.ok(!nodes.includes("actionCard.field.for") && !nodes.includes("actionCard.seats."), "no For row, no note");
}

test("a signed-in person a full link turned away is recorded once, with the link's creator from the token", async ({ app }) => {
  const { owner, admin, lin, grace, server, token } = await seedWorld();
  // What the body says about who invited them is not read.
  const first = await blocked(app.baseUrl, grace.email, { token, inviterUserId: admin.id });
  assert.deepEqual(first, { status: 200, body: { recorded: true } });
  let stored = await rows(server.id);
  assert.equal(stored.length, 1);
  assert.equal(stored[0]!.userId, grace.id);
  assert.equal(stored[0]!.state, "active");
  assert.equal(stored[0]!.inviterUserId, lin.id, "Lin made the link");

  // Again, or through someone else's link: the first row stays.
  const ownersLink = await joinLink(server.id, owner.id);
  assert.deepEqual(await blocked(app.baseUrl, grace.email, { token }), { status: 200, body: { recorded: true } });
  assert.deepEqual(await blocked(app.baseUrl, grace.email, { token: ownersLink }), { status: 200, body: { recorded: true } });
  stored = await rows(server.id);
  assert.equal(stored.length, 1);
  assert.equal(stored[0]!.inviterUserId, lin.id, "the first link's creator stays");
});

test("nothing is recorded with the flag off, with a seat free, for a member, or for an invite that isn't theirs or takes no seat", async ({ app }) => {
  const { owner, member, grace, server, token } = await seedWorld();
  await setFlag(false);
  assert.deepEqual(await blocked(app.baseUrl, grace.email, { token }), { status: 200, body: { recorded: false } });
  await setFlag(true);

  assert.deepEqual(await blocked(app.baseUrl, member.email, { token }), { status: 200, body: { recorded: false } }, "a member isn't turned away");

  const emailToken = randomUUID();
  const invite = (role: "member" | "guest", email: string, raw: string) => getDb().insert(serverInvites).values({
    serverId: server.id,
    invitedEmail: email,
    invitedByUserId: owner.id,
    role,
    tokenHash: createHash("sha256").update(raw).digest("hex"),
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  });
  await invite("member", "someone-else@test.invalid", emailToken);
  assert.deepEqual(await blocked(app.baseUrl, grace.email, { token: emailToken }), { status: 200, body: { recorded: false } }, "another address's invite");
  const guestToken = randomUUID();
  await invite("guest", grace.email, guestToken);
  assert.deepEqual(await blocked(app.baseUrl, grace.email, { token: guestToken }), { status: 200, body: { recorded: false } }, "a Guest takes no seat");

  await setSeats(server.id, owner.id, 5);
  assert.deepEqual(await blocked(app.baseUrl, grace.email, { token }), { status: 200, body: { recorded: false } }, "there's a seat");
  assert.equal((await rows(server.id)).length, 0);

  assert.equal((await blocked(app.baseUrl, grace.email, { token: "no-such-link" })).status, 404);
  assert.equal((await blocked(app.baseUrl, grace.email, {})).status, 400);
});

test("an email invite to its own address is recorded with the inviter who sent it", async ({ app }) => {
  const { admin, grace, server } = await seedWorld();
  const raw = randomUUID();
  await getDb().insert(serverInvites).values({
    serverId: server.id,
    invitedEmail: grace.email,
    invitedByUserId: admin.id,
    role: "member",
    tokenHash: createHash("sha256").update(raw).digest("hex"),
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  });
  assert.deepEqual(await blocked(app.baseUrl, grace.email, { token: raw }), { status: 200, body: { recorded: true } });
  assert.equal((await rows(server.id))[0]!.inviterUserId, admin.id);
});

test(`a server keeps at most ${MAX_ACTIVE_SEAT_JOIN_BLOCKS} active notices; past that nothing is recorded`, async ({ app }) => {
  const { server, token } = await seedWorld();
  const people = await Promise.all(Array.from({ length: MAX_ACTIVE_SEAT_JOIN_BLOCKS }, (_, i) => seedUser(`outsider-${i}`)));
  await getDb().insert(seatJoinBlocks).values(people.map((person) => ({ serverId: server.id, userId: person.id })));
  const late = await seedUser("late");
  assert.deepEqual(await blocked(app.baseUrl, late.email, { token }), { status: 200, body: { recorded: false } });
  assert.equal((await rows(server.id)).length, MAX_ACTIVE_SEAT_JOIN_BLOCKS);
});

test("owners and admins see every notice, the link's creator their own, anyone else none; names only", async ({ app }) => {
  const { owner, admin, member, lin, grace, server, token } = await seedWorld();
  const alan = await seedUser("Alan Turing");
  const ownersLink = await joinLink(server.id, owner.id);
  await blocked(app.baseUrl, grace.email, { token });
  await blocked(app.baseUrl, alan.email, { token: ownersLink });

  for (const viewer of [owner, admin]) {
    const blocks = await list(app.baseUrl, viewer.email, server.id);
    assert.deepEqual(blocks.map((block) => block.name).sort(), ["Alan Turing", "Grace Hopper"]);
  }
  // With the seats, which a member can't read from billing (the numbers a seat refusal gives them).
  assert.deepEqual((await listed(app.baseUrl, lin.email, server.id)).usage, { seats: 4, humans: 4, agents: 0 });
  const linsView = await list(app.baseUrl, lin.email, server.id);
  assert.equal(linsView.length, 1);
  assert.deepEqual(
    { userId: linsView[0]!.userId, name: linsView[0]!.name, inviterUserId: linsView[0]!.inviterUserId, inviterName: linsView[0]!.inviterName },
    { userId: grace.id, name: "Grace Hopper", inviterUserId: lin.id, inviterName: "Lin Mo" },
  );
  assert.ok(!JSON.stringify(linsView).includes("@"), "never an email");
  assert.deepEqual(await listed(app.baseUrl, member.email, server.id), { blocks: [] }, "a member whose link it wasn't: no seats either");
  await seedBoundGuest({ serverId: server.id, userId: lin.id });
  assert.deepEqual(await list(app.baseUrl, lin.email, server.id), [], "a Guest sees none");

  await setFlag(false);
  assert.deepEqual(await list(app.baseUrl, owner.email, server.id), [], "flag off");
});

test("the list only reads: a seat free or a person who joined hides the notice without ending it", async ({ app }) => {
  const { owner, grace, server, token } = await seedWorld();
  await blocked(app.baseUrl, grace.email, { token });
  await setSeats(server.id, owner.id, 5);
  assert.deepEqual(await list(app.baseUrl, owner.email, server.id), [], "not full any more");
  assert.equal((await rows(server.id))[0]!.state, "active", "the read wrote nothing");

  await setSeats(server.id, owner.id, 4);
  await seedBoundGuest({ serverId: server.id, userId: grace.id });
  assert.deepEqual(await list(app.baseUrl, owner.email, server.id), [], "a member now (a Guest takes no seat, so it's still full)");
  assert.equal((await rows(server.id))[0]!.state, "active");
});

test("joining through the link ends the notice", async ({ app }) => {
  const { owner, grace, server, token } = await seedWorld();
  await blocked(app.baseUrl, grace.email, { token });
  await setSeats(server.id, owner.id, 5);
  const res = await post(app.baseUrl, grace.email, "/auth/accept-invite", { token });
  assert.equal(res.status, 200, await res.clone().text());
  const [row] = await rows(server.id);
  assert.equal(row!.state, "resolved");
  assert.equal(row!.resolvedReason, "joined");
  assert.ok(row!.resolvedAt);
});

test("seats added (the Stripe sync) end every notice once a person fits, not before", async ({ app }) => {
  const { owner, grace, server, token } = await seedWorld();
  await blocked(app.baseUrl, grace.email, { token });
  assert.equal(await resolveSeatJoinBlocksWithRoom(server.id), 0, "still full");
  assert.equal((await rows(server.id))[0]!.state, "active");
  await setSeats(server.id, owner.id, 5);
  assert.equal(await resolveSeatJoinBlocksWithRoom(server.id), 1);
  const [row] = await rows(server.id);
  assert.equal(row!.state, "resolved");
  assert.equal(row!.resolvedReason, "room");
});

test("a join seat request needs an active notice, names the person itself, and comes from an admin or the link's creator", async ({ app }) => {
  const { owner, admin, member, lin, grace, server, token } = await seedWorld();
  const ask = async (email: string, userId: string) => {
    const res = await post(app.baseUrl, email, "/actions/seat-requests", { ownerUserId: owner.id, purpose: { kind: "join", userId, name: "Someone Else" } }, server.id);
    return { status: res.status, body: await res.json() as { messageId: string; errorCode?: string } };
  };
  let res = await ask(admin.email, grace.id);
  assert.equal(res.status, 400);
  assert.equal(res.body.errorCode, "NOT_BLOCKED", "no one by that id is waiting");

  await blocked(app.baseUrl, grace.email, { token });
  res = await ask(member.email, grace.id);
  assert.equal(res.status, 403, "a member whose link it wasn't");
  assert.equal(res.body.errorCode, "NOT_ALLOWED");

  res = await ask(lin.email, grace.id);
  assert.equal(res.status, 201, "the link's creator");
  const [card] = await getDb().select().from(messages).where(eq(messages.id, res.body.messageId)).limit(1);
  const metadata = card!.actionMetadata as ActionCardMetadata;
  assert.deepEqual(metadata.action.type === "seats:add" ? { seats: metadata.action.seats, purpose: metadata.action.purpose } : null, {
    seats: 1,
    purpose: { kind: "join", userId: grace.id, name: "Grace Hopper" },
  }, "the server's name for them, and one seat");

  res = await ask(admin.email, grace.id);
  assert.equal(res.status, 201, "an admin");
});

test("completing a join request does nothing as the owner, ends the notice, tells the asker who can come back, and keeps no one on the card", async ({ app }) => {
  const world = await seedWorld();
  const { owner, admin, grace, server } = world;
  const messageId = await askJoin(app.baseUrl, world);
  const [asked] = await getDb().select().from(messages).where(eq(messages.id, messageId)).limit(1);
  const askedCard = JSON.stringify((asked!.actionMetadata as ActionCardMetadata).presentation?.card);
  assert.ok(askedCard.includes("actionCard.seats.purpose.join") && askedCard.includes("actionCard.seats.notice.join"), "drawn by the shared spec: For: Let Grace join, and Raft's note");
  assert.deepEqual(await check(app.baseUrl, owner.email, server.id, messageId), { requesterAllowed: true, seatsShort: 1 });

  const short = await post(app.baseUrl, owner.email, `/actions/${messageId}/seats-added`, {}, server.id);
  assert.equal(short.status, 409, "the seat first");
  await setSeats(server.id, owner.id, 5);
  const done = await post(app.baseUrl, owner.email, `/actions/${messageId}/seats-added`, {}, server.id);
  assert.equal(done.status, 200);
  assert.deepEqual((await done.json() as { outcome: unknown }).outcome, { kind: "ready", purpose: "join" });
  const [row] = await rows(server.id);
  assert.equal(row!.state, "resolved");
  assert.equal(row!.resolvedReason, "room");
  const membership = await getDb().select().from(serverMembers).where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, grace.id)));
  assert.deepEqual(membership, [], "she opens the link herself");
  const [stored] = await getDb().select({ state: actionCards.state, result: actionCards.result }).from(actionCards).where(eq(actionCards.messageId, messageId));
  assert.equal(stored!.state, "executed");
  assert.deepEqual(stored!.result, { kind: "ready", purpose: "join" });
  await assertNamesNoOne(messageId, grace);
  assert.deepEqual((await replies(messageId)).map((reply) => reply.content), [`blocks-owner added a seat; @${admin.name}, Grace Hopper can open the link again now.`]);
});

test("a paid join request ends ready, though the Stripe sync ended the notice `room` before the owner's dialog completed it", async ({ app }) => {
  const world = await seedWorld();
  const { owner, admin, server } = world;
  const messageId = await askJoin(app.baseUrl, world);
  assert.deepEqual(await check(app.baseUrl, owner.email, server.id, messageId), { requesterAllowed: true, seatsShort: 1 });
  // The owner pays: the sync writes the seats and ends every notice with room (billingService), then the dialog calls /seats-added.
  await setSeats(server.id, owner.id, 5);
  assert.equal(await resolveSeatJoinBlocksWithRoom(server.id), 1);
  const done = await post(app.baseUrl, owner.email, `/actions/${messageId}/seats-added`, {}, server.id);
  assert.equal(done.status, 200);
  assert.deepEqual((await done.json() as { outcome: unknown }).outcome, { kind: "ready", purpose: "join" });
  assert.deepEqual((await replies(messageId)).map((reply) => reply.content), [`blocks-owner added a seat; @${admin.name}, Grace Hopper can open the link again now.`]);
});

test("two people turned away, a join request for each, one seat bought: both notices end `room` and both requests end ready", async ({ app }) => {
  const world = await seedWorld();
  const { owner, admin, grace, server, token } = world;
  const bob = await seedUser("Bob Kahn");
  const graceRequest = await askJoin(app.baseUrl, world);
  await blocked(app.baseUrl, bob.email, { token });
  const asked = await post(app.baseUrl, admin.email, "/actions/seat-requests", { ownerUserId: owner.id, purpose: { kind: "join", userId: bob.id, name: "Bob Kahn" } }, server.id);
  assert.equal(asked.status, 201, await asked.clone().text());
  const bobRequest = (await asked.json() as { messageId: string }).messageId;

  await setSeats(server.id, owner.id, 5);
  assert.equal(await resolveSeatJoinBlocksWithRoom(server.id), 2);
  assert.deepEqual((await rows(server.id)).map((row) => row.resolvedReason), ["room", "room"]);
  // Each can open the link again; whoever comes first takes the seat.
  for (const [messageId, name] of [[graceRequest, "Grace Hopper"], [bobRequest, "Bob Kahn"]] as const) {
    const done = await post(app.baseUrl, owner.email, `/actions/${messageId}/seats-added`, {}, server.id);
    assert.equal(done.status, 200, name);
    assert.deepEqual((await done.json() as { outcome: unknown }).outcome, { kind: "ready", purpose: "join" }, name);
    assert.deepEqual((await replies(messageId)).map((reply) => reply.content), [`blocks-owner added a seat; @${admin.name}, ${name} can open the link again now.`]);
  }
  const joined = await getDb().select().from(serverMembers).where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, grace.id)));
  assert.deepEqual(joined, [], "no one is joined for them");
});

test("a notice that expired while the owner paid still needs the seat: the check lets the owner pay, and the request ends ready", async ({ app }) => {
  const world = await seedWorld();
  const { owner, server } = world;
  const messageId = await askJoin(app.baseUrl, world);
  await getDb().update(seatJoinBlocks).set({ state: "resolved", resolvedAt: new Date(), resolvedReason: "expired" }).where(eq(seatJoinBlocks.serverId, server.id));
  assert.deepEqual(await check(app.baseUrl, owner.email, server.id, messageId), { requesterAllowed: true, seatsShort: 1 }, "not a member: the dialog opens");
  await setSeats(server.id, owner.id, 5);
  const done = await post(app.baseUrl, owner.email, `/actions/${messageId}/seats-added`, {}, server.id);
  assert.equal(done.status, 200);
  assert.deepEqual((await done.json() as { outcome: unknown }).outcome, { kind: "ready", purpose: "join" });
  assert.equal((await rows(server.id))[0]!.resolvedReason, "expired", "its notice keeps how it ended");
});

test("a join request for someone who has joined since ends at once when the owner answers it, with nothing to pay", async ({ app }) => {
  // Grace joined through the link once a seat came free (her notice ended `joined`), and the seats are full again.
  let world = await seedWorld();
  let messageId = await askJoin(app.baseUrl, world);
  await setSeats(world.server.id, world.owner.id, 5);
  const accepted = await post(app.baseUrl, world.grace.email, "/auth/accept-invite", { token: world.token });
  assert.equal(accepted.status, 200, await accepted.clone().text());
  assert.equal((await rows(world.server.id))[0]!.resolvedReason, "joined");
  assert.deepEqual(await check(app.baseUrl, world.owner.email, world.server.id, messageId), { requesterAllowed: false, seatsShort: 1 }, "the card's Add Seats then ends it without a dialog");
  let res = await post(app.baseUrl, world.owner.email, `/actions/${messageId}/seats-added`, {}, world.server.id);
  assert.equal(res.status, 200, "no SEATS_STILL_SHORT: nothing to pay for");
  assert.deepEqual((await res.json() as { outcome: unknown }).outcome, { kind: "not_needed" });
  await assertNamesNoOne(messageId, world.grace);
  assert.deepEqual((await replies(messageId)).map((reply) => reply.content), [`blocks-owner closed your request; @${world.admin.name}, Grace Hopper no longer needs a seat to join.`]);

  // A member now some other way (her notice still active): not needed either.
  world = await seedWorld();
  messageId = await askJoin(app.baseUrl, world);
  await getDb().insert(serverMembers).values({ serverId: world.server.id, userId: world.grace.id, role: "member" });
  assert.equal((await check(app.baseUrl, world.owner.email, world.server.id, messageId)).requesterAllowed, false);
  res = await post(app.baseUrl, world.owner.email, `/actions/${messageId}/seats-added`, {}, world.server.id);
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json() as { outcome: unknown }).outcome, { kind: "not_needed" });
});

test("a link's creator on a server that hides its people asks the owner the server picks", async ({ app }) => {
  const { owner, admin, lin, grace, server, token } = await seedWorld();
  await getDb().update(servers).set({ hideHumansFromMembers: true }).where(eq(servers.id, server.id));
  await blocked(app.baseUrl, grace.email, { token });
  // An id Lin sends (here an admin's) is not read.
  const res = await post(app.baseUrl, lin.email, "/actions/seat-requests", { ownerUserId: admin.id, purpose: { kind: "join", userId: grace.id, name: "x" } }, server.id);
  assert.equal(res.status, 201, await res.clone().text());
  const { channelId } = await res.json() as { channelId: string };
  const people = (await getDb().select({ userId: channelHumans.userId }).from(channelHumans).where(eq(channelHumans.channelId, channelId))).map((human) => human.userId).sort();
  assert.deepEqual(people, [lin.id, owner.id].sort(), "the server's owner, not the id sent");
});

test("a notice older than 7 days expires in the seat request sweep; one ended 30 days ago is deleted", async ({ app }) => {
  const { grace, lin, server, token } = await seedWorld();
  await blocked(app.baseUrl, grace.email, { token });
  await getDb().update(seatJoinBlocks).set({ createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) }).where(eq(seatJoinBlocks.serverId, server.id));
  await sweepExpiredSeatRequests(null);
  const [row] = await rows(server.id);
  assert.equal(row!.state, "resolved");
  assert.equal(row!.resolvedReason, "expired");

  // Ended long ago: read by nothing, so gone; a recent one stays.
  const old = new Date(Date.now() - RESOLVED_SEAT_JOIN_BLOCK_RETENTION_MS - 60_000);
  await getDb().update(seatJoinBlocks).set({ resolvedAt: old }).where(eq(seatJoinBlocks.id, row!.id));
  await getDb().insert(seatJoinBlocks).values({ serverId: server.id, userId: lin.id, state: "resolved", resolvedAt: new Date(), resolvedReason: "joined" });
  await sweepExpiredSeatRequests(null);
  assert.deepEqual((await rows(server.id)).map((left) => left.userId), [lin.id]);
});

test("invite-info says whether the page shows the seat notice", async ({ app }) => {
  const { owner, server, token } = await seedWorld();
  const info = async () => (await (await fetch(`${app.baseUrl}/api/auth/invite-info?token=${encodeURIComponent(token)}`)).json()) as { humanSeatLimitReached: boolean; seatNoticeEnabled: boolean };
  assert.deepEqual(await info().then(({ humanSeatLimitReached, seatNoticeEnabled }) => ({ humanSeatLimitReached, seatNoticeEnabled })), { humanSeatLimitReached: true, seatNoticeEnabled: true });
  await setFlag(false);
  assert.deepEqual(await info().then(({ humanSeatLimitReached, seatNoticeEnabled }) => ({ humanSeatLimitReached, seatNoticeEnabled })), { humanSeatLimitReached: true, seatNoticeEnabled: false });
  await setFlag(true);
  await setSeats(server.id, owner.id, 5);
  assert.deepEqual(await info().then(({ humanSeatLimitReached, seatNoticeEnabled }) => ({ humanSeatLimitReached, seatNoticeEnabled })), { humanSeatLimitReached: false, seatNoticeEnabled: false });
});

test("seat-join-blocks:changed: a block recorded or ended pings the server's room once, after its commit; a rollback or no change pings nothing", async ({ app }) => {
  const { owner, grace, server, token } = await seedWorld();
  const ada = await seedUser("Ada Lovelace");
  const late = await seedUser("Late Comer");
  const frames: string[] = [];
  setListChangedRealtimeIO({ to: (room: string) => ({ emit: (event: string, payload: unknown) => {
    if (event === SEAT_JOIN_BLOCKS_CHANGED_EVENT) frames.push(`${room} ${JSON.stringify(payload)}`);
    return true;
  } }) } as never);
  const take = () => frames.splice(0);
  const ping = [`server:${server.id} ${JSON.stringify({ serverId: server.id })}`];
  try {
    await blocked(app.baseUrl, grace.email, { token });
    assert.deepEqual(take(), ping, "recorded");
    await blocked(app.baseUrl, grace.email, { token });
    assert.deepEqual(take(), [], "already recorded: no change");
    await blocked(app.baseUrl, ada.email, { token });
    assert.deepEqual(take(), ping);

    await assert.rejects(getDb().transaction(async () => {
      assert.equal(await resolveSeatJoinBlock({ serverId: server.id, userId: grace.id, reason: "room" }), true);
      throw new Error("roll back");
    }), /roll back/);
    assert.deepEqual(take(), [], "a rolled-back end pings nothing");
    assert.equal(await resolveSeatJoinBlocksWithRoom(server.id), 0);
    assert.deepEqual(take(), [], "still full: nothing ends");

    await setSeats(server.id, owner.id, 5);
    const joined = await post(app.baseUrl, grace.email, "/auth/accept-invite", { token });
    assert.equal(joined.status, 200, await joined.clone().text());
    assert.deepEqual(take(), ping, "Grace joined: her notice ends");

    await setSeats(server.id, owner.id, 6);
    assert.equal(await resolveSeatJoinBlocksWithRoom(server.id), 1);
    assert.deepEqual(take(), ping, "the Stripe sync's seat: Ada's ends");

    await getDb().insert(seatJoinBlocks).values({ serverId: server.id, userId: late.id, createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) });
    await sweepExpiredSeatRequests(null);
    assert.deepEqual(take(), ping, "the sweep expired one");
    await sweepExpiredSeatRequests(null);
    assert.deepEqual(take(), [], "nothing left to expire");
  } finally {
    setListChangedRealtimeIO((app as unknown as { app: { get(key: string): never } }).app.get("io"));
  }
});

test("seat-join-blocks:changed: a member leaving, joining or changing role pings a server with an active notice once it commits (seats freed or taken, or who sees which notice); no notice or a rollback pings nothing", async ({ app }) => {
  const { owner, member, lin, grace, server, token } = await seedWorld();
  const quietOwner = await seedUser("blocks-quiet-owner");
  const quietMember = await seedUser("blocks-quiet-member");
  const quiet = await createServer("Quiet", `quiet-${randomUUID().slice(0, 8)}`, quietOwner.id);
  await addMember(quiet.id, quietMember.id, "member");
  await blocked(app.baseUrl, grace.email, { token });
  assert.equal((await list(app.baseUrl, owner.email, server.id)).length, 1);
  const frames: string[] = [];
  setListChangedRealtimeIO({ to: (room: string) => ({ emit: (event: string, payload: unknown) => {
    if (event === SEAT_JOIN_BLOCKS_CHANGED_EVENT) frames.push(`${room} ${JSON.stringify(payload)}`);
    return true;
  } }) } as never);
  const take = () => frames.splice(0);
  const ping = [`server:${server.id} ${JSON.stringify({ serverId: server.id })}`];
  try {
    await assert.rejects(getDb().transaction(async (tx) => {
      assert.ok(await removeMemberInTransaction(tx, server.id, member.id));
      throw new Error("roll back");
    }), /roll back/);
    assert.deepEqual(take(), [], "a rolled-back leave pings nothing");

    await removeMember(server.id, member.id);
    assert.deepEqual(take(), ping, "a seat freed: the notice is no longer shown");
    assert.deepEqual(await list(app.baseUrl, owner.email, server.id), []);

    await addMember(server.id, member.id, "member");
    assert.deepEqual(take(), ping, "the seat taken again: the notice is back");
    assert.equal((await list(app.baseUrl, owner.email, server.id)).length, 1);

    // Lin made a Guest (silently, in the database): a seat is free.
    await seedBoundGuest({ serverId: server.id, userId: lin.id });
    assert.deepEqual(await list(app.baseUrl, owner.email, server.id), []);
    await transitionMemberRole({ serverId: server.id, actorUserId: owner.id, targetUserId: lin.id, nextRole: "member" });
    assert.deepEqual(take(), ping, "from Guest takes a seat");
    assert.equal((await list(app.baseUrl, owner.email, server.id)).length, 1);
    const memberSees = async () => (await list(app.baseUrl, member.email, server.id)).length;
    assert.equal(await memberSees(), 0, "a member sees only the notices they invited");
    await transitionMemberRole({ serverId: server.id, actorUserId: owner.id, targetUserId: member.id, nextRole: "admin" });
    assert.deepEqual(take(), ping, "member to admin: the seats are unchanged, but what they are shown is not");
    assert.equal(await memberSees(), 1, "an admin sees every notice");

    await removeMember(quiet.id, quietMember.id);
    assert.deepEqual(take(), [], "no active notice there: nothing to tell");
  } finally {
    setListChangedRealtimeIO((app as unknown as { app: { get(key: string): never } }).app.get("io"));
  }
});
