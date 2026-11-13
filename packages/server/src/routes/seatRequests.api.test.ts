import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
// Seat requests (task #10 #proj-commercial): a member or admin who runs out of
// Pro seats asks an owner with a card in their DM, an action card like an
// agent's. Authority: whether the caller can see the card first, then what its
// type takes (seats:add: an owner). Once the seats count, an owner completes
// it: invites and a Guest's promotion are done as the owner; an agent or
// assistant is left for the requester (for an agent, the owner may send back
// an ordinary agent:create card). The requester is told in the card's thread
// how it ended, as an agent is. No decline. Behind pro_seat_add; open 7 days;
// what it holds is cleared once it ends.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import type { Server as SocketServer } from "socket.io";
import { PRO_AGENT_SEAT_BLOCK_SIZE, PRO_SEAT_ADD_FEATURE_FLAG_KEY, SERVER_GUEST_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import type { ActionCardMetadata } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { actionCards, channelHumans, channels, featureFlags, inboxNotificationFacts, messages, productEvents, serverInvites, serverMembers, servers, subscriptions, users } from "../db/schema";
import { createAgent } from "../services/agentService";
import type { AgentOrchestrator } from "../services/agentOrchestrator";
import { findOrCreateUserDM, listDMChannels } from "../services/channelService";
import { createServer } from "../services/serverService";
import { completeUpgradeRequests, sweepExpiredSeatRequests } from "../services/seatRequestService";
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

async function setFlag(enabled: boolean, key: string = PRO_SEAT_ADD_FEATURE_FLAG_KEY) {
  await getDb().insert(featureFlags)
    .values({ key, randomizationUnit: "server", salt: "test", defaultEnabled: true, enabled })
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

/** An owner, an admin and a member on a Pro server whose 3 seats they fill. */
async function seedWorld() {
  const owner = await seedUser("seats-owner");
  const admin = await seedUser("seats-admin");
  const member = await seedUser("seats-member");
  const server = await createServer("Seat Requests", `seat-requests-${randomUUID().slice(0, 8)}`, owner.id);
  await getDb().insert(serverMembers).values([
    { serverId: server.id, userId: admin.id, role: "admin" },
    { serverId: server.id, userId: member.id, role: "member" },
  ]);
  await setSeats(server.id, owner.id, 3);
  await setFlag(true);
  return { owner, admin, member, server };
}

async function call(baseUrl: string, email: string, serverId: string, path: string, body: unknown = {}) {
  const token = await tokenForHuman(email);
  return fetch(`${baseUrl}/api${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "X-Server-Id": serverId, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function get(baseUrl: string, email: string, serverId: string, path: string) {
  const token = await tokenForHuman(email);
  return fetch(`${baseUrl}/api${path}`, { headers: { Authorization: `Bearer ${token}`, "X-Server-Id": serverId } });
}

const INVITE = { kind: "invite", emails: ["grace@lumen.test", "alan@lumen.test"] } as const;
const REASON = "Grace and Alan start Monday.";

async function card(messageId: string) {
  const [row] = await getDb().select().from(actionCards).where(eq(actionCards.messageId, messageId)).limit(1);
  const [message] = await getDb().select().from(messages).where(eq(messages.id, messageId)).limit(1);
  return { row: row!, message: message!, metadata: message!.actionMetadata as ActionCardMetadata };
}

/**
 * Once a seat request ends, nothing it held is left: not on the card row, not
 * on its message (the action, the card drawn from it, what history and
 * `message:updated` carry). The card is still drawn: its title and nothing
 * else of what was asked.
 */
async function assertHoldsNothing(messageId: string) {
  const { row, message, metadata } = await card(messageId);
  for (const [what, value] of [["card row", row], ["message", message]] as const) {
    const json = JSON.stringify(value);
    assert.ok(!json.includes("grace@") && !json.includes("alan@"), `no address on the ${what}`);
    assert.ok(!json.includes(REASON), `no reason on the ${what}`);
  }
  const spec = metadata.presentation?.card;
  assert.ok(spec, "still drawn from the shared spec");
  assert.match(spec.title.key, /^actionCard\.title\.addSeats\./);
  const nodes = JSON.stringify(spec.spec.elements);
  assert.ok(!nodes.includes("actionCard.field.for") && !nodes.includes("actionCard.seats."), "no For row, no note on what it was for");
  assert.ok(!nodes.includes("\"actionCard.reason\""), "no reason row");
}

/** The result replies in a card's thread (postActionCardResultReply), oldest first. */
async function replies(messageId: string) {
  const [thread] = await getDb().select({ id: channels.id }).from(channels)
    .where(and(eq(channels.type, "thread"), eq(channels.parentMessageId, messageId))).limit(1);
  if (!thread) return [];
  const rows = await getDb().select().from(messages)
    .where(and(eq(messages.channelId, thread.id), eq(messages.systemSubtype, "action_card.result_reply")));
  return rows.sort((a, b) => Number(a.seq) - Number(b.seq));
}

/** The reply is a personal mention for `userId`: unread for them (it reaches them), born-read for whoever caused it. */
async function assertMentions(replyId: string, userId: string, causedBy: string) {
  const facts = await getDb().select().from(inboxNotificationFacts).where(eq(inboxNotificationFacts.messageId, replyId));
  const theirs = facts.find((fact) => fact.receiverType === "user" && fact.receiverId === userId);
  assert.ok(theirs, "the requester has an inbox fact for the reply");
  assert.equal(theirs.personalMention, true);
  assert.equal(theirs.unreadEligible, true, "unread for the requester");
  assert.ok(facts.filter((fact) => fact.receiverType === "user" && fact.receiverId === causedBy).every((fact) => fact.unreadEligible === false), "born-read for the one who caused it");
}

function realtime(app: { app: { get: (key: string) => unknown } }) {
  return { io: app.app.get("io") as SocketServer, orchestrator: app.app.get("agentOrchestrator") as AgentOrchestrator };
}

test("an admin asks an owner for seats: one card from the admin in their DM, counted by the server", async ({ app }) => {
  const { owner, admin, server } = await seedWorld();
  const res = await call(app.baseUrl, admin.email, server.id, "/actions/seat-requests", { ownerUserId: owner.id, purpose: INVITE, reason: REASON });
  assert.equal(res.status, 201);
  const out = await res.json() as { messageId: string; channelId: string; existing: boolean };
  const { row, message, metadata } = await card(out.messageId);
  assert.equal(row.requesterUserId, admin.id);
  assert.equal(row.requesterAgentId, null);
  assert.equal(row.actionType, "seats:add");
  assert.equal(message.senderType, "user");
  assert.equal(message.senderId, admin.id);
  assert.equal(metadata.state, "prepared");
  assert.equal(metadata.requesterUserId, admin.id);
  assert.equal(metadata.action.type, "seats:add");
  if (metadata.action.type !== "seats:add") return;
  assert.equal(metadata.action.seats, 2, "3/3 used, two more people: 2 seats");
  assert.deepEqual(metadata.action.purpose, INVITE);
  assert.equal(metadata.action.reason, REASON);

  const again = await call(app.baseUrl, admin.email, server.id, "/actions/seat-requests", { ownerUserId: owner.id, purpose: INVITE });
  assert.equal(again.status, 200);
  assert.deepEqual(await again.json(), { ...out, existing: true }, "the same request answers with the open card");
});

test("asking is refused with the flag off, to an owner who asks, to a guest, and to a non-owner recipient", async ({ app }) => {
  const { owner, admin, member, server } = await seedWorld();
  await setFlag(false);
  let res = await call(app.baseUrl, admin.email, server.id, "/actions/seat-requests", { ownerUserId: owner.id, purpose: INVITE });
  assert.equal(res.status, 403);
  assert.equal((await res.json() as { errorCode: string }).errorCode, "FEATURE_DISABLED");
  await setFlag(true);

  res = await call(app.baseUrl, owner.email, server.id, "/actions/seat-requests", { ownerUserId: owner.id, purpose: INVITE });
  assert.equal((await res.json() as { errorCode: string }).errorCode, "OWNER_ADDS_SEATS");
  res = await call(app.baseUrl, member.email, server.id, "/actions/seat-requests", { ownerUserId: admin.id, purpose: { kind: "assistant:create" } });
  assert.equal((await res.json() as { errorCode: string }).errorCode, "NOT_AN_OWNER");
  res = await call(app.baseUrl, member.email, server.id, "/actions/seat-requests", { ownerUserId: owner.id, purpose: INVITE });
  assert.equal(res.status, 403, "a member doesn't send invites, so can't ask for seats for them");
  assert.equal((await res.json() as { errorCode: string }).errorCode, "NOT_ALLOWED");
  await seedBoundGuest({ serverId: server.id, userId: member.id });
  res = await call(app.baseUrl, member.email, server.id, "/actions/seat-requests", { ownerUserId: owner.id, purpose: { kind: "assistant:create" } });
  assert.equal((await res.json() as { errorCode: string }).errorCode, "NOT_A_MEMBER");
});

test("there is no decline: a request ends done or expired, and stays open until then", async ({ app }) => {
  const { owner, admin, server } = await seedWorld();
  const { messageId } = await (await call(app.baseUrl, admin.email, server.id, "/actions/seat-requests", { ownerUserId: owner.id, purpose: INVITE })).json() as { messageId: string };
  const res = await call(app.baseUrl, owner.email, server.id, `/actions/${messageId}/decline`);
  assert.equal(res.status, 404, "no such route");
  assert.equal((await card(messageId)).row.state, "prepared");
});

test("with the flag off, an owner can't check, complete or send back either", async ({ app }) => {
  const { owner, admin, server } = await seedWorld();
  const { messageId } = await (await call(app.baseUrl, admin.email, server.id, "/actions/seat-requests", { ownerUserId: owner.id, purpose: INVITE })).json() as { messageId: string };
  await setSeats(server.id, owner.id, 5);
  await setFlag(false);
  for (const res of [
    await call(app.baseUrl, owner.email, server.id, `/actions/${messageId}/seats-added`),
    await get(app.baseUrl, owner.email, server.id, `/actions/${messageId}/seat-request`),
    await call(app.baseUrl, owner.email, server.id, `/actions/${messageId}/send-create-agent-card`),
  ]) {
    assert.equal(res.status, 403);
    assert.equal((await res.json() as { errorCode: string }).errorCode, "FEATURE_DISABLED");
  }
  assert.equal((await card(messageId)).row.state, "prepared");
  assert.equal((await getDb().select().from(serverInvites).where(eq(serverInvites.serverId, server.id))).length, 0);
});

test("before paying, an owner learns whether the requester still can and how many seats are short", async ({ app }) => {
  const { owner, admin, server } = await seedWorld();
  const { messageId } = await (await call(app.baseUrl, admin.email, server.id, "/actions/seat-requests", { ownerUserId: owner.id, purpose: INVITE })).json() as { messageId: string };
  let res = await get(app.baseUrl, owner.email, server.id, `/actions/${messageId}/seat-request`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { requesterAllowed: true, seatsShort: 2 });
  res = await get(app.baseUrl, admin.email, server.id, `/actions/${messageId}/seat-request`);
  assert.equal(res.status, 403, "owners only");

  const agentAsk = await ask(app.baseUrl, admin.email, server.id, { ownerUserId: owner.id, purpose: { kind: "agent:create", name: "scout" } });
  await seedBoundGuest({ serverId: server.id, userId: admin.id });
  res = await get(app.baseUrl, owner.email, server.id, `/actions/${agentAsk.body.messageId}/seat-request`);
  // (A Guest takes no seat, so nothing is short now either.)
  assert.equal((await res.json() as { requesterAllowed: boolean }).requesterAllowed, false, "a Guest can't create agents: the owner is told before paying");
  res = await get(app.baseUrl, owner.email, server.id, `/actions/${messageId}/seat-request`);
  assert.deepEqual(await res.json(), { requesterAllowed: true, seatsShort: 1 }, "invites are the owner's to send, whoever asked (and the Guest freed a seat)");
});

test("completing waits for the seats, then the owner's invites go out, once", async ({ app }) => {
  const { owner, admin, server } = await seedWorld();
  const { messageId } = await (await call(app.baseUrl, admin.email, server.id, "/actions/seat-requests", { ownerUserId: owner.id, purpose: INVITE, reason: REASON })).json() as { messageId: string };

  let res = await call(app.baseUrl, owner.email, server.id, `/actions/${messageId}/seats-added`);
  assert.equal(res.status, 409);
  assert.equal((await res.json() as { errorCode: string }).errorCode, "SEATS_STILL_SHORT");

  await setSeats(server.id, owner.id, 5);
  res = await call(app.baseUrl, owner.email, server.id, `/actions/${messageId}/seats-added`);
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json() as { outcome: unknown }).outcome, { kind: "invites", sent: 2, failed: 0 });
  const invites = await getDb().select({ by: serverInvites.invitedByUserId }).from(serverInvites).where(eq(serverInvites.serverId, server.id));
  assert.deepEqual(invites.map((invite) => invite.by), [owner.id, owner.id], "sent as the owner, who saw them on the card");
  const { row, metadata } = await card(messageId);
  assert.equal(row.state, "executed");
  assert.equal(row.executedByUserId, owner.id);
  assert.equal(metadata.action.type === "seats:add" ? metadata.action.purpose : "x", null);
  assert.deepEqual(metadata.seatOutcome, { kind: "invites", sent: 2, failed: 0 });
  await assertHoldsNothing(messageId);

  res = await call(app.baseUrl, owner.email, server.id, `/actions/${messageId}/seats-added`);
  assert.equal(res.status, 409, "idempotent: done once");
  assert.equal((await getDb().select().from(serverInvites).where(eq(serverInvites.serverId, server.id))).length, 2);
});

test("an agent request whose requester can no longer create one ends when the owner answers it, with nothing to pay", async ({ app }) => {
  const { owner, admin, server } = await seedWorld();
  const { messageId } = await (await call(app.baseUrl, admin.email, server.id, "/actions/seat-requests", { ownerUserId: owner.id, purpose: { kind: "agent:create", name: "scout" } })).json() as { messageId: string };
  // No longer an admin: a member doesn't create agents.
  await getDb().update(serverMembers).set({ role: "member" }).where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, admin.id)));
  // The seat is still short: no SEATS_STILL_SHORT, it ends.
  let res = await get(app.baseUrl, owner.email, server.id, `/actions/${messageId}/seat-request`);
  assert.deepEqual(await res.json(), { requesterAllowed: false, seatsShort: 1 });
  assert.equal((await card(messageId)).row.state, "prepared", "the check changes nothing");
  res = await call(app.baseUrl, owner.email, server.id, `/actions/${messageId}/seats-added`);
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json() as { outcome: unknown }).outcome, { kind: "requester_cannot" });
  const { row, metadata } = await card(messageId);
  assert.equal(row.state, "executed", "ended now, not left to expire");
  assert.equal(row.executedByUserId, owner.id);
  assert.deepEqual(metadata.seatOutcome, { kind: "requester_cannot" });
  assert.equal(metadata.action.type === "seats:add" ? metadata.action.purpose : "x", null);
  assert.ok(!JSON.stringify(metadata).includes("scout"), "what it held is cleared");
  assert.deepEqual((await replies(messageId)).map((reply) => reply.content), [`seats-owner closed your request; @${admin.name}, you can no longer do this here.`]);
});

test("a seat request is never run by the generic execute", async ({ app }) => {
  const { owner, admin, server } = await seedWorld();
  const { messageId } = await (await call(app.baseUrl, admin.email, server.id, "/actions/seat-requests", { ownerUserId: owner.id, purpose: INVITE })).json() as { messageId: string };
  const res = await call(app.baseUrl, owner.email, server.id, `/actions/${messageId}/execute`, {});
  assert.equal(res.status, 409);
  assert.equal((await res.json() as { errorCode: string }).errorCode, "NOT_EXECUTABLE");
});

test("a request open past its 7 days expires, holds nothing, and the requester is told in its thread", async ({ app }) => {
  const { owner, admin, server } = await seedWorld();
  const { messageId } = await (await call(app.baseUrl, admin.email, server.id, "/actions/seat-requests", { ownerUserId: owner.id, purpose: INVITE, reason: REASON })).json() as { messageId: string };
  const { row } = await card(messageId);
  await getDb().update(actionCards)
    .set({ payload: { ...(row.payload as object), expiresAt: new Date(Date.now() - 1000).toISOString() } })
    .where(eq(actionCards.id, row.id));
  const { io, orchestrator } = realtime(app);
  assert.ok(await sweepExpiredSeatRequests(io, orchestrator) >= 1);
  const after = await card(messageId);
  assert.equal(after.row.state, "expired");
  assert.equal(after.metadata.state, "expired");
  assert.equal((after.row.payload as { purpose: unknown }).purpose, null);
  await assertHoldsNothing(messageId);
  const [reply] = await replies(messageId);
  assert.ok(reply, "a reply in the card's thread");
  assert.equal(reply.content, `No owner answered within 7 days, @${admin.name}; nothing changed.`);
  await assertMentions(reply.id, admin.id, owner.id);
  await setSeats(server.id, owner.id, 5);
  const res = await call(app.baseUrl, owner.email, server.id, `/actions/${messageId}/seats-added`);
  assert.equal(res.status, 409);
});

test("an owner completing a request past its time ends it expired, and the requester is told", async ({ app }) => {
  const { owner, admin, server } = await seedWorld();
  const { messageId } = await (await call(app.baseUrl, admin.email, server.id, "/actions/seat-requests", { ownerUserId: owner.id, purpose: INVITE, reason: REASON })).json() as { messageId: string };
  const { row } = await card(messageId);
  await getDb().update(actionCards)
    .set({ payload: { ...(row.payload as object), expiresAt: new Date(Date.now() - 1000).toISOString() } })
    .where(eq(actionCards.id, row.id));
  await setSeats(server.id, owner.id, 5);
  const res = await call(app.baseUrl, owner.email, server.id, `/actions/${messageId}/seats-added`);
  assert.equal(res.status, 409);
  assert.equal((await res.json() as { errorCode: string }).errorCode, "EXPIRED");
  assert.equal((await card(messageId)).row.state, "expired");
  await assertHoldsNothing(messageId);
  assert.deepEqual((await replies(messageId)).map((reply) => reply.content), [`No owner answered within 7 days, @${admin.name}; nothing changed.`]);
  assert.equal((await getDb().select().from(serverInvites).where(eq(serverInvites.serverId, server.id))).length, 0, "nothing was sent");
});

test("a member of a Free server asks an owner for Pro with the upgrade card, which only opens the upgrade dialog", async ({ app }) => {
  const { owner, member, server } = await seedWorld();
  await getDb().delete(subscriptions).where(eq(subscriptions.serverId, server.id));
  const reason = "I need last quarter's launch notes, older than 30 days.";
  let res = await call(app.baseUrl, member.email, server.id, "/actions/upgrade-requests", { ownerUserId: owner.id, gate: "history_30d", reason });
  assert.equal(res.status, 201);
  const { messageId } = await res.json() as { messageId: string };
  const { row, message, metadata } = await card(messageId);
  assert.equal(row.actionType, "plan:upgrade");
  assert.equal(row.requesterUserId, member.id);
  assert.equal(message.senderId, member.id);
  assert.deepEqual(metadata.action, { type: "plan:upgrade", reason, gate: "history_30d" });

  res = await call(app.baseUrl, member.email, server.id, "/actions/upgrade-requests", { ownerUserId: owner.id, gate: "history_30d", reason });
  assert.equal(res.status, 200, "one open request per gate");
  res = await call(app.baseUrl, member.email, server.id, "/actions/upgrade-requests", { ownerUserId: owner.id, reason: "<why>" });
  assert.equal(res.status, 400, "the card's own reason rules apply");

  // As an agent's upgrade card: nothing runs from it; and the member who sent
  // it doesn't answer it, as an agent never runs its own.
  res = await call(app.baseUrl, owner.email, server.id, `/actions/${messageId}/execute`, {});
  assert.equal(res.status, 409);
  assert.equal((await res.json() as { errorCode: string }).errorCode, "NOT_EXECUTABLE");
  res = await call(app.baseUrl, member.email, server.id, `/actions/${messageId}/execute`, {});
  assert.equal(res.status, 403);
  assert.equal((await res.json() as { errorCode: string }).errorCode, "OWN_REQUEST");
  assert.equal((await card(messageId)).row.state, "prepared");

  // The action-card funnel is the cards agents prepare: a person's records nothing.
  res = await call(app.baseUrl, owner.email, server.id, `/actions/${messageId}/event`, { eventType: "action_card.open" });
  assert.equal(res.status, 204);
  assert.deepEqual(await getDb().select().from(productEvents).where(eq(productEvents.subjectId, row.id)), []);
});

test("on Pro, asking for Pro is refused", async ({ app }) => {
  const { owner, member, server } = await seedWorld();
  const res = await call(app.baseUrl, member.email, server.id, "/actions/upgrade-requests", { ownerUserId: owner.id, reason: "I need more." });
  assert.equal(res.status, 409);
  assert.equal((await res.json() as { errorCode: string }).errorCode, "NOT_PRO");
});

async function ask(baseUrl: string, email: string, serverId: string, body: unknown) {
  const res = await call(baseUrl, email, serverId, "/actions/seat-requests", body);
  return { status: res.status, body: await res.json() as { messageId: string; existing: boolean; errorCode?: string } };
}

test("two identical asks at once give one card, not a 500", async ({ app }) => {
  const { owner, admin, server } = await seedWorld();
  const [a, b] = await Promise.all([
    ask(app.baseUrl, admin.email, server.id, { ownerUserId: owner.id, purpose: INVITE }),
    ask(app.baseUrl, admin.email, server.id, { ownerUserId: owner.id, purpose: INVITE }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 201]);
  assert.equal(a.body.messageId, b.body.messageId);
});

test("two owners completing at once: done once", async ({ app }) => {
  const { owner, admin, server } = await seedWorld();
  const second = await seedUser("seats-owner-2");
  await getDb().insert(serverMembers).values({ serverId: server.id, userId: second.id, role: "owner" });
  await setSeats(server.id, owner.id, 6);
  const { body } = await ask(app.baseUrl, admin.email, server.id, { ownerUserId: owner.id, purpose: INVITE });
  // Seats were enough when asked too: complete straight away, twice at once.
  const results = await Promise.all([
    call(app.baseUrl, owner.email, server.id, `/actions/${body.messageId}/seats-added`),
    call(app.baseUrl, owner.email, server.id, `/actions/${body.messageId}/seats-added`),
  ]);
  assert.deepEqual(results.map((res) => res.status).sort(), [200, 409]);
  assert.equal((await getDb().select().from(serverInvites).where(eq(serverInvites.serverId, server.id))).length, 2);
});

test("a seat request takes an owner on the generic card routes too, and is never run by them", async ({ app }) => {
  const { owner, admin, server } = await seedWorld();
  const { body } = await ask(app.baseUrl, admin.email, server.id, { ownerUserId: owner.id, purpose: INVITE });
  for (const path of ["execute", "mark-executed", "reconfirm"]) {
    let res = await call(app.baseUrl, admin.email, server.id, `/actions/${body.messageId}/${path}`, { result: { kind: "agent", id: randomUUID(), name: "x" } });
    assert.equal(res.status, 403, `${path} as the requester`);
    assert.equal((await res.json() as { errorCode: string }).errorCode, "OWNER_ONLY");
    res = await call(app.baseUrl, owner.email, server.id, `/actions/${body.messageId}/${path}`, { result: { kind: "agent", id: randomUUID(), name: "x" } });
    assert.equal(res.status, 409, `${path} as the owner`);
    assert.equal((await res.json() as { errorCode: string }).errorCode, "NOT_EXECUTABLE");
  }
  assert.equal((await card(body.messageId)).row.state, "prepared");
});

test("visibility comes first: an owner who can't see the request (it's in another owner's DM) is refused everywhere", async ({ app }) => {
  const { owner, admin, member, server } = await seedWorld();
  const other = await seedUser("seats-owner-other");
  await getDb().insert(serverMembers).values({ serverId: server.id, userId: other.id, role: "owner" });
  const { body } = await ask(app.baseUrl, admin.email, server.id, { ownerUserId: owner.id, purpose: { kind: "agent:create", name: "scout" } });
  // Four people on three seats: the owner it went to adds two.
  await setSeats(server.id, owner.id, 5);
  for (const who of [other, member]) {
    for (const [method, path] of [["GET", "seat-request"], ["POST", "seats-added"], ["POST", "send-create-agent-card"], ["POST", "execute"], ["POST", "mark-executed"]] as const) {
      const res = method === "GET"
        ? await get(app.baseUrl, who.email, server.id, `/actions/${body.messageId}/${path}`)
        : await call(app.baseUrl, who.email, server.id, `/actions/${body.messageId}/${path}`, { result: { kind: "agent", id: randomUUID(), name: "x" } });
      assert.equal(res.status, 404, `${path} as ${who === other ? "another owner, who has manageBilling" : "a member"}: not said to exist`);
    }
  }
  assert.equal((await card(body.messageId)).row.state, "prepared");
  // The owner it went to completes it; the other owner still can't send the card back.
  assert.equal((await call(app.baseUrl, owner.email, server.id, `/actions/${body.messageId}/seats-added`)).status, 200);
  assert.equal((await call(app.baseUrl, other.email, server.id, `/actions/${body.messageId}/send-create-agent-card`)).status, 404);
});

test("Guest → member: the server names the Guest, only a Guest qualifies, and the owner's Add Seats changes the role", async ({ app }) => {
  const { owner, admin, member, server } = await seedWorld();
  await setFlag(true, SERVER_GUEST_FEATURE_FLAG_KEY);
  const guest = await seedUser("seats-guest");
  await seedBoundGuest({ serverId: server.id, userId: guest.id });

  let res = await ask(app.baseUrl, admin.email, server.id, { ownerUserId: owner.id, purpose: { kind: "member:promote", userId: member.id, name: "Bob", role: "member" } });
  assert.equal(res.status, 400);
  assert.equal(res.body.errorCode, "NOT_A_GUEST", "a member isn't promoted into a seat");

  res = await ask(app.baseUrl, admin.email, server.id, { ownerUserId: owner.id, purpose: { kind: "member:promote", userId: guest.id, name: "Somebody Else", role: "member" } });
  assert.equal(res.status, 201);
  const { metadata } = await card(res.body.messageId);
  assert.equal(metadata.action.type === "seats:add" && metadata.action.purpose?.kind === "member:promote" ? metadata.action.purpose.name : null, "seats-guest", "the card shows the Guest's real name");

  await setSeats(server.id, owner.id, 4);
  const done = await call(app.baseUrl, owner.email, server.id, `/actions/${res.body.messageId}/seats-added`);
  assert.equal(done.status, 200);
  const [row] = await getDb().select({ role: serverMembers.role }).from(serverMembers).where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, guest.id)));
  assert.equal(row?.role, "member");
  assert.deepEqual((await card(res.body.messageId)).metadata.seatOutcome, { kind: "promoted", name: "seats-guest", role: "member" }, "both see what came of it");
});

test("the requester is told what came of it in the card's thread, @mentioned as an agent is: counts, never an address", async ({ app }) => {
  const { owner, admin, server } = await seedWorld();
  const { body } = await ask(app.baseUrl, admin.email, server.id, { ownerUserId: owner.id, purpose: INVITE });
  await setSeats(server.id, owner.id, 5);
  assert.equal((await call(app.baseUrl, owner.email, server.id, `/actions/${body.messageId}/seats-added`)).status, 200);
  const [reply, ...more] = await replies(body.messageId);
  assert.ok(reply, "a system reply in the card's thread");
  assert.deepEqual(more, []);
  assert.equal(reply.content, `seats-owner added 2 seats; @${admin.name}, 2 invites went out.`, "who did it first, as many seats as the card asked for, then the mention");
  assert.doesNotMatch(reply.content, /@lumen\.test/, "no address");
  await assertMentions(reply.id, admin.id, owner.id);
  const { message } = await card(body.messageId);
  const inDm = await getDb().select({ id: messages.id }).from(messages)
    .where(and(eq(messages.channelId, message.channelId), eq(messages.senderId, "system")));
  assert.deepEqual(inDm, [], "in the thread, not the DM itself");
});

test("an agent request: the requester is told they can create it, and the owner sends back an ordinary agent:create card, once", async ({ app }) => {
  const { owner, admin, member, server } = await seedWorld();
  const { body } = await ask(app.baseUrl, admin.email, server.id, { ownerUserId: owner.id, purpose: { kind: "agent:create", name: "scout" } });
  let res = await call(app.baseUrl, owner.email, server.id, `/actions/${body.messageId}/send-create-agent-card`);
  assert.equal(res.status, 409, "not before it's done");
  assert.equal((await res.json() as { errorCode: string }).errorCode, "NOT_READY");

  await setSeats(server.id, owner.id, 4);
  res = await call(app.baseUrl, owner.email, server.id, `/actions/${body.messageId}/seats-added`);
  assert.deepEqual((await res.json() as { outcome: unknown }).outcome, { kind: "ready", purpose: "agent:create", name: "scout" });
  assert.deepEqual((await replies(body.messageId)).map((reply) => reply.content), [`seats-owner added a seat; @${admin.name}, you can create scout now.`]);

  res = await call(app.baseUrl, admin.email, server.id, `/actions/${body.messageId}/send-create-agent-card`);
  assert.equal(res.status, 403, "the requester doesn't send it to themselves");
  // A name in the body is not read: the card's name is the outcome's.
  res = await call(app.baseUrl, owner.email, server.id, `/actions/${body.messageId}/send-create-agent-card`, { name: "mallory" });
  assert.equal(res.status, 201);
  const sent = await res.json() as { messageId: string; channelId: string; existing: boolean };
  const original = await card(body.messageId);
  const back = await card(sent.messageId);
  assert.equal(sent.channelId, original.message.channelId, "in the request's own DM");
  assert.equal(back.message.channelId, original.message.channelId);
  assert.equal(back.message.senderId, owner.id);
  assert.equal(back.row.actionType, "agent:create");
  assert.equal(back.row.requesterUserId, owner.id, "a person's card: the owner asked");
  assert.equal(back.row.requesterAgentId, null);
  assert.deepEqual(back.metadata.action, { type: "agent:create", name: "scout" });
  assert.equal(back.metadata.requesterUserId, owner.id);
  assert.equal(back.metadata.state, "prepared");
  assert.ok(back.metadata.presentation?.card, "drawn from the same spec as an agent's agent:create card");

  res = await call(app.baseUrl, owner.email, server.id, `/actions/${body.messageId}/send-create-agent-card`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ...sent, existing: true }, "a repeat answers with the same card");
  assert.equal((await getDb().select().from(actionCards).where(eq(actionCards.requesterUserId, owner.id))).length, 1);

  // A member outside the DM doesn't see it at all.
  res = await call(app.baseUrl, member.email, server.id, `/actions/${sent.messageId}/mark-executed`, { result: { kind: "agent", id: randomUUID(), name: "scout" } });
  assert.equal(res.status, 404);

  // The owner who sent it doesn't answer it: it's the requester's.
  res = await call(app.baseUrl, owner.email, server.id, `/actions/${sent.messageId}/mark-executed`, { result: { kind: "agent", id: randomUUID(), name: "scout" } });
  assert.equal(res.status, 403);
  assert.equal((await res.json() as { errorCode: string }).errorCode, "OWN_REQUEST");

  // The requester creates the agent from it as from any agent:create card
  // (requester_agent_id is null): marked executed, and the owner is told in its thread.
  const agent = await createAgent(server.id, "scout", { runtime: "claude" });
  res = await call(app.baseUrl, admin.email, server.id, `/actions/${sent.messageId}/mark-executed`, { result: { kind: "agent", id: agent.id, name: "scout" } });
  assert.equal(res.status, 200, await res.clone().text());
  const done = await card(sent.messageId);
  assert.equal(done.row.state, "executed");
  assert.equal(done.row.executedByUserId, admin.id);
  assert.equal(done.metadata.state, "executed");
  assert.equal(done.metadata.requesterUserId, owner.id, "still a person's card");
  const [toOwner] = await replies(sent.messageId);
  assert.ok(toOwner, "the owner is told, as the requester was");
  assert.match(toOwner.content, new RegExp(`^seats-admin used your card \\S+ \\([^)]*\\), @${owner.name}\\.`));
  assert.match(toOwner.content, /created agent @scout/);
  await assertMentions(toOwner.id, owner.id, admin.id);
  // Sent once, still: the executed card is the one.
  res = await call(app.baseUrl, owner.email, server.id, `/actions/${body.messageId}/send-create-agent-card`);
  assert.deepEqual(await res.json(), { ...sent, existing: true });
});

test("the card is sent back only for a done agent request, within 7 days of it", async ({ app }) => {
  const { owner, admin, member, server } = await seedWorld();
  await setSeats(server.id, owner.id, 6);
  const invite = await ask(app.baseUrl, admin.email, server.id, { ownerUserId: owner.id, purpose: INVITE });
  assert.equal((await call(app.baseUrl, owner.email, server.id, `/actions/${invite.body.messageId}/seats-added`)).status, 200);
  let res = await call(app.baseUrl, owner.email, server.id, `/actions/${invite.body.messageId}/send-create-agent-card`);
  assert.equal(res.status, 409);
  assert.equal((await res.json() as { errorCode: string }).errorCode, "NOT_READY", "invites were sent by the owner");

  const assistant = await ask(app.baseUrl, member.email, server.id, { ownerUserId: owner.id, purpose: { kind: "assistant:create" } });
  assert.equal((await call(app.baseUrl, owner.email, server.id, `/actions/${assistant.body.messageId}/seats-added`)).status, 200);
  res = await call(app.baseUrl, owner.email, server.id, `/actions/${assistant.body.messageId}/send-create-agent-card`);
  assert.equal((await res.json() as { errorCode: string }).errorCode, "NOT_READY", "an assistant has no card: the reply says they can create it");
  assert.deepEqual((await replies(assistant.body.messageId)).map((reply) => reply.content), [`seats-owner added a seat; @${member.name}, you can create your assistant now.`]);

  const agent = await ask(app.baseUrl, admin.email, server.id, { ownerUserId: owner.id, purpose: { kind: "agent:create", name: "scout" } });
  assert.equal((await call(app.baseUrl, owner.email, server.id, `/actions/${agent.body.messageId}/seats-added`)).status, 200);
  await getDb().update(actionCards).set({ executedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) }).where(eq(actionCards.messageId, agent.body.messageId));
  res = await call(app.baseUrl, owner.email, server.id, `/actions/${agent.body.messageId}/send-create-agent-card`);
  assert.equal(res.status, 409);
  assert.equal((await res.json() as { errorCode: string }).errorCode, "EXPIRED");
});

test("an assistant request ends ready: the member creates it themselves", async ({ app }) => {
  const { owner, member, server } = await seedWorld();
  const { body } = await ask(app.baseUrl, member.email, server.id, { ownerUserId: owner.id, purpose: { kind: "assistant:create" } });
  await setSeats(server.id, owner.id, 4);
  const res = await call(app.baseUrl, owner.email, server.id, `/actions/${body.messageId}/seats-added`);
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json() as { outcome: unknown }).outcome, { kind: "ready", purpose: "assistant:create" });
});

test("a member's open Pro request is done once the server is on Pro, and they're told", async ({ app }) => {
  const { owner, member, server } = await seedWorld();
  await getDb().delete(subscriptions).where(eq(subscriptions.serverId, server.id));
  const res = await call(app.baseUrl, member.email, server.id, "/actions/upgrade-requests", { ownerUserId: owner.id, reason: "I need more agents." });
  const { messageId } = await res.json() as { messageId: string };
  const asked = await card(messageId);
  const { io, orchestrator } = realtime(app);
  await completeUpgradeRequests(io, server.id, orchestrator);
  assert.equal((await card(messageId)).row.state, "prepared", "still Free: nothing changes");
  assert.deepEqual(await replies(messageId), []);
  await setSeats(server.id, owner.id, 3);
  await completeUpgradeRequests(io, server.id, orchestrator);
  const { row, metadata } = await card(messageId);
  assert.equal(row.state, "executed");
  assert.equal(metadata.state, "executed");
  // A Pro request holds only the requester's own sentence, which the card keeps.
  assert.deepEqual(metadata.presentation, asked.metadata.presentation, "drawn again from the same action");
  const [reply] = await replies(messageId);
  assert.equal(reply?.content, `Seat Requests is no longer on the Free plan, @${member.name}; your request for Pro is done.`);
  await assertMentions(reply!.id, member.id, owner.id);
});

test("an open request past its time doesn't stand in for a new one; expiry clears the message too", async ({ app }) => {
  const { owner, admin, server } = await seedWorld();
  const first = await ask(app.baseUrl, admin.email, server.id, { ownerUserId: owner.id, purpose: INVITE, reason: REASON });
  const { row } = await card(first.body.messageId);
  await getDb().update(actionCards)
    .set({ payload: { ...(row.payload as object), expiresAt: new Date(Date.now() - 1000).toISOString() } })
    .where(eq(actionCards.id, row.id));
  const second = await ask(app.baseUrl, admin.email, server.id, { ownerUserId: owner.id, purpose: INVITE });
  assert.equal(second.status, 201);
  assert.notEqual(second.body.messageId, first.body.messageId);
  const old = await card(first.body.messageId);
  assert.equal(old.row.state, "expired");
  assert.equal(old.metadata.action.type === "seats:add" ? old.metadata.action.purpose : "x", null, "the emails are gone from the message");
  await assertHoldsNothing(first.body.messageId);
});

test("a request is drawn from the shared spec, so every client shows a person's card as it shows an agent's", async ({ app }) => {
  const { owner, admin, server } = await seedWorld();
  const { body } = await ask(app.baseUrl, admin.email, server.id, { ownerUserId: owner.id, purpose: { kind: "agent:create", name: "scout" } });
  const { metadata } = await card(body.messageId);
  const spec = metadata.presentation?.card;
  assert.ok(spec, "presentation.card is built");
  assert.equal(spec.title.key, "actionCard.title.addSeats.one");
  const nodes = Object.values(spec.spec.elements);
  assert.ok(nodes.some((node) => node.type === "Button" && node.props.action.kind === "open" && node.props.action.intent === "add_seats"), "Add Seats opens the owner's flow");
  assert.ok(JSON.stringify(spec).includes(admin.id), "the note names the requester by reference");
});

/** Who is in the DM a card was posted in. */
async function dmPeople(messageId: string): Promise<string[]> {
  const { message } = await card(messageId);
  const rows = await getDb().select({ userId: channelHumans.userId }).from(channelHumans).where(eq(channelHumans.channelId, message.channelId));
  return rows.map((row) => row.userId).sort();
}

/** The other people `userId` has a DM with in the server. */
async function dmPeers(serverId: string, userId: string): Promise<string[]> {
  return (await listDMChannels(serverId, userId)).filter((dm) => dm.peerType === "user" && dm.peerId !== userId).map((dm) => dm.peerId);
}

test("a member the server hides its people from doesn't choose the owner: the server picks one, whatever id they send", async ({ app }) => {
  const { owner, admin, member, server } = await seedWorld();
  const other = await seedUser("seats-owner-other");
  await getDb().insert(serverMembers).values({ serverId: server.id, userId: other.id, role: "owner" });
  await getDb().update(servers).set({ hideHumansFromMembers: true }).where(eq(servers.id, server.id));

  // Another person's id (not an owner): no NOT_AN_OWNER to tell them so; the card goes to the server's creator.
  const first = await ask(app.baseUrl, member.email, server.id, { ownerUserId: admin.id, purpose: { kind: "assistant:create" } });
  assert.equal(first.status, 201);
  assert.deepEqual(Object.keys(first.body).sort(), ["channelId", "existing", "messageId"], "nothing about the id they sent");
  assert.deepEqual(await dmPeople(first.body.messageId), [member.id, owner.id].sort());
  // An owner they have no DM with, or no id at all: the same owner, the same open card.
  for (const body of [{ ownerUserId: other.id }, {}]) {
    const again = await ask(app.baseUrl, member.email, server.id, { ...body, purpose: { kind: "assistant:create" } });
    assert.equal(again.status, 200);
    assert.equal(again.body.messageId, first.body.messageId);
  }
  assert.deepEqual(await dmPeers(server.id, member.id), [owner.id], "no DM with anyone they named");

  // A Pro request the same way.
  await getDb().delete(subscriptions).where(eq(subscriptions.serverId, server.id));
  const res = await call(app.baseUrl, member.email, server.id, "/actions/upgrade-requests", { ownerUserId: admin.id, reason: "I need more agents." });
  assert.equal(res.status, 201);
  assert.deepEqual(await dmPeople((await res.json() as { messageId: string }).messageId), [member.id, owner.id].sort());
  assert.deepEqual(await dmPeers(server.id, member.id), [owner.id]);
});

test("with the people hidden, an owner the member already has a DM with is asked, the creator first", async ({ app }) => {
  const { owner, member, server } = await seedWorld();
  const other = await seedUser("seats-owner-other");
  await getDb().insert(serverMembers).values({ serverId: server.id, userId: other.id, role: "owner" });
  await getDb().update(servers).set({ hideHumansFromMembers: true }).where(eq(servers.id, server.id));
  await findOrCreateUserDM(server.id, member.id, other.id);

  const toOther = await ask(app.baseUrl, member.email, server.id, { ownerUserId: owner.id, purpose: { kind: "assistant:create" } });
  assert.equal(toOther.status, 201);
  assert.deepEqual(await dmPeople(toOther.body.messageId), [member.id, other.id].sort(), "the owner they already talk to, not the one they named");
  assert.deepEqual(await dmPeers(server.id, member.id), [other.id]);

  await findOrCreateUserDM(server.id, member.id, owner.id);
  const toCreator = await ask(app.baseUrl, member.email, server.id, { ownerUserId: other.id, purpose: { kind: "assistant:create" } });
  assert.equal(toCreator.status, 201);
  assert.deepEqual(await dmPeople(toCreator.body.messageId), [member.id, owner.id].sort(), "with DMs with both, the creator");
});

test("with the people visible, the requester chooses, and it must be an owner", async ({ app }) => {
  const { admin, member, server } = await seedWorld();
  const other = await seedUser("seats-owner-other");
  await getDb().insert(serverMembers).values({ serverId: server.id, userId: other.id, role: "owner" });
  let res = await ask(app.baseUrl, member.email, server.id, { purpose: { kind: "assistant:create" } });
  assert.equal(res.status, 400);
  assert.equal(res.body.errorCode, "NOT_AN_OWNER", "no owner named");
  res = await ask(app.baseUrl, member.email, server.id, { ownerUserId: admin.id, purpose: { kind: "assistant:create" } });
  assert.equal(res.body.errorCode, "NOT_AN_OWNER");
  res = await ask(app.baseUrl, member.email, server.id, { ownerUserId: other.id, purpose: { kind: "assistant:create" } });
  assert.equal(res.status, 201);
  assert.deepEqual(await dmPeople(res.body.messageId), [member.id, other.id].sort(), "the owner they chose, not the creator");
  // An admin is never hidden from: they choose even on a server that hides its people from members.
  await getDb().update(servers).set({ hideHumansFromMembers: true }).where(eq(servers.id, server.id));
  res = await ask(app.baseUrl, admin.email, server.id, { ownerUserId: admin.id, purpose: { kind: "agent:create", name: "scout" } });
  assert.equal(res.body.errorCode, "NOT_AN_OWNER");
  res = await ask(app.baseUrl, admin.email, server.id, { ownerUserId: other.id, purpose: { kind: "agent:create", name: "scout" } });
  assert.equal(res.status, 201);
  assert.deepEqual(await dmPeople(res.body.messageId), [admin.id, other.id].sort());
});

test("bodies are checked: an owner id that isn't a uuid, an address that isn't one, too many open requests", async ({ app }) => {
  const { owner, admin, server } = await seedWorld();
  let res = await ask(app.baseUrl, admin.email, server.id, { ownerUserId: "not-a-uuid", purpose: INVITE });
  assert.equal(res.status, 400);
  res = await ask(app.baseUrl, admin.email, server.id, { ownerUserId: owner.id, purpose: { kind: "invite", emails: ["not an address"] } });
  assert.equal(res.status, 400);
  for (let i = 0; i < 10; i += 1) {
    res = await ask(app.baseUrl, admin.email, server.id, { ownerUserId: owner.id, purpose: { kind: "agent:create", name: `agent-${i}` } });
    assert.equal(res.status, 201);
  }
  res = await ask(app.baseUrl, admin.email, server.id, { ownerUserId: owner.id, purpose: { kind: "agent:create", name: "agent-10" } });
  assert.equal(res.status, 429);
  assert.equal(res.body.errorCode, "TOO_MANY_OPEN");
});
