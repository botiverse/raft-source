import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { vi } from "vitest";
import { CURRENT_LEGAL_ACCEPTANCE, mintAgentContextViewGrantId } from "@botiverse/raft-shared";

import { createApiTest } from "../test/integration/apiTest";
import { seedBoundGuest } from "../test/guestFixture";
import { getDb } from "../db/index";
import {
  accountDeletionRequests,
  actionCards,
  agentBootstrapTokens,
  agentContextViewGrants,
  agents,
  computers,
  appSumoRedemptionClaims,
  inboxNotificationFacts,
  integrationAuditEvents,
  machines,
  newsletterAudienceContacts,
  notificationOutbox,
  objectInboxStates,
  onboardingEmailJourneys,
  paidLifecycleJourneys,
  pushRegistrations,
  pushSubscriptions,
  serverInvites,
  serverJoinLinks,
  serverMembers,
  servers,
  sessionFamilies,
  subscriptions,
  threadFollows,
  userChannelReadCursors,
  userNotificationSettings,
  userRetirementReceipts,
  userSaved,
  users,
} from "../db/schema";
import {
  deletedUserEmail,
  deletedUserHandle,
  runAccountDeletionCleanup,
  type AccountDeletionCleanupDeps,
  type AccountDeletionCleanupOptions,
} from "../services/accountDeletion/cleanup";
import { requestAccountDeletion } from "../services/accountDeletion/requests";
import { USER_FOREIGN_KEY_CLASSIFICATION, USER_NO_FOREIGN_KEY_PERSONAL_TABLES, type UserForeignKeyClassification } from "../services/accountDeletion/tableClassification";
import { createAgent } from "../services/agentService";
import { deleteStoredUserAvatarIfUnused, isUserAvatarHashStillShown } from "../services/avatarService";
import { agentHandedOverNoticeText } from "../services/agentActionRequiredNoticeService";
import { __setEmailDeliveryObserverForTests, type EmailDelivery } from "../services/emailService";
import { listMessages } from "../services/messageService";
import { addMember } from "../services/serverService";
import { createUser } from "../services/userService";
import { signInForTest, signInThroughSecondStepForTest } from "../test/integration/credentials";
import * as tracing from "../tracing/semanticTrace";
import { enrollSecondFactor, useTotpSecretKey } from "../test/integration/secondFactor";

// Account deletion cleanup, PR 2 (design "删除账号：服务端设计 v2" §7, §7.1):
// the hourly job retires and scrubs a due account in one transaction, hands
// its servers over, then deletes the person's data per the table
// classification in bounded batches. Nobody else, and nobody not yet due, is
// touched.

const test = createApiTest();
useTotpSecretKey();

type Human = typeof users.$inferSelect;

function captureEmails() {
  const deliveries: EmailDelivery[] = [];
  __setEmailDeliveryObserverForTests((delivery) => deliveries.push(delivery));
  return { deliveries, stop: () => __setEmailDeliveryObserverForTests(null) };
}

/** Stubs for the external calls, recording what they were asked. */
function externalCalls() {
  const calls = { contacts: [] as string[], cancelledEmails: [] as string[], stripe: [] as string[] };
  const deps: AccountDeletionCleanupDeps = {
    deleteResendContact: async (contact) => { calls.contacts.push("id" in contact ? `id:${contact.id}` : `email:${contact.email}`); },
    cancelScheduledEmail: async (emailId) => { calls.cancelledEmails.push(emailId); },
    cancelStripeSubscription: async (_serverId, subscriptionId) => { calls.stripe.push(subscriptionId); },
  };
  return { calls, deps };
}

/** A request whose grace period ended a minute ago. */
async function dueRequest(human: Human, source: "self" | "ops" = "self", actorUserId: string = human.id) {
  const outcome = await requestAccountDeletion({ userId: human.id, source, actorUserId, ticketRef: source === "ops" ? "TICKET-1" : null });
  assert.equal(outcome.kind, "scheduled");
  await getDb().update(accountDeletionRequests).set({ scheduledFor: new Date(Date.now() - 60_000) })
    .where(and(eq(accountDeletionRequests.userId, human.id), eq(accountDeletionRequests.state, "pending")));
}

const requestOf = async (userId: string) => (await getDb().select().from(accountDeletionRequests).where(eq(accountDeletionRequests.userId, userId)))[0];
const userRow = async (userId: string) => (await getDb().select().from(users).where(eq(users.id, userId)))[0]!;

async function runUntilCompleted(userId: string, options: AccountDeletionCleanupOptions, maxRuns = 50): Promise<number> {
  for (let run = 1; run <= maxRuns; run += 1) {
    await runAccountDeletionCleanup(options);
    if ((await requestOf(userId))?.state === "completed") return run;
  }
  throw new Error(`not completed after ${maxRuns} runs`);
}

test("nobody without a due request is touched: no request, or a request still in its grace period", async ({ seed }) => {
  const untouched = await seed.human({ description: "hello", avatarUrl: "https://example.test/a.png" });
  const waiting = await seed.human();
  await seed.server({ owner: untouched });
  const session = await signInForTest(untouched.id);
  await requestAccountDeletion({ userId: waiting.id, source: "self", actorUserId: waiting.id });
  const before = { untouched: await userRow(untouched.id), waiting: await userRow(waiting.id) };
  const emails = captureEmails();
  try {
    const report = await runAccountDeletionCleanup({ deps: externalCalls().deps });
    assert.deepEqual(report, { retired: [], completed: [], resumeLater: [] });
    assert.deepEqual(await userRow(untouched.id), before.untouched);
    assert.deepEqual(await userRow(waiting.id), before.waiting);
    assert.equal((await requestOf(waiting.id))?.state, "pending");
    assert.equal((await requestOf(waiting.id))?.accountRetiredAt, null);
    const [family] = await getDb().select({ revokedAt: sessionFamilies.revokedAt }).from(sessionFamilies).where(eq(sessionFamilies.id, session.familyId));
    assert.equal(family?.revokedAt, null);
    assert.deepEqual(emails.deliveries, []);
  } finally {
    emails.stop();
  }
});

test("a due account is retired and scrubbed, its receipt written, the request completed, and the old address told and free again", async ({ seed }) => {
  const human = await seed.human({
    description: "about me",
    avatarUrl: "https://example.test/me.png",
    preferredTimezone: "Europe/Paris",
    firstObservedTimezone: "Europe/Paris",
    firstObservedTimezoneAt: new Date(),
    referralSource: "friend",
    signupRole: "engineer",
    signupSurveyCompletedAt: new Date(),
    passwordCredentialEstablishedAt: new Date(),
  });
  await enrollSecondFactor(human.id);
  const colleague = await seed.human();
  const shared = await seed.server({ owner: colleague, members: [human] });
  const channel = await seed.channel({ server: shared, members: [colleague, human] });
  const message = await seed.message({ channel, author: human, content: "a message that outlives its author" });
  const oldEmail = human.email;
  const before = await userRow(human.id);
  await dueRequest(human);
  const emails = captureEmails();
  try {
    const { deps } = externalCalls();
    const report = await runAccountDeletionCleanup({ deps });
    assert.deepEqual(report.retired, [human.id]);
    assert.deepEqual(report.completed, [human.id]);

    const after = await userRow(human.id);
    assert.ok(after.retiredAt);
    assert.equal(after.retiredReason, "account_deleted");
    assert.notEqual(after.traceUserId, before.traceUserId);
    assert.equal(after.email, deletedUserEmail(human.id));
    assert.equal(after.name, deletedUserHandle(human.id));
    assert.equal(after.displayName, "Deleted user");
    assert.equal(after.emailVerified, false);
    for (const field of ["description", "avatarUrl", "preferredTimezone", "firstObservedTimezone", "referralSource", "signupRole", "signupSurveyCompletedAt", "passwordCredentialEstablishedAt", "secondFactorRequiredAt", "webauthnUserHandle"] as const) {
      assert.equal(after[field], null, field);
    }
    assert.notEqual(after.passwordHash, before.passwordHash);

    const [receipt] = await getDb().select().from(userRetirementReceipts).where(eq(userRetirementReceipts.userId, human.id));
    assert.equal(receipt?.actorUserId, human.id);
    assert.equal(receipt?.environment, "production");
    assert.equal(receipt?.terminalState, "retired");
    assert.deepEqual(receipt?.serverHandoffs, []);
    const request = await requestOf(human.id);
    assert.equal(request?.state, "completed");
    assert.ok(request?.completedAt && request.accountRetiredAt);
    assert.equal(request?.cleanupLeaseUntil, null);

    // One email, to the address the account had.
    assert.deepEqual(emails.deliveries.map((mail) => mail.to), [oldEmail]);
    assert.match(emails.deliveries[0]!.subject, /account has been deleted/);

    // The message stays, shown as from "Deleted user".
    const listed = await listMessages(channel.id, 50);
    const kept = listed.find((row) => row.id === message.id);
    assert.equal(kept?.content, "a message that outlives its author");
    assert.equal(kept?.senderName, "Deleted user");

    // The address can sign up again, as a new account.
    const again = await createUser(oldEmail, "password123", `again-${randomUUID().slice(0, 8)}`, {
      acceptTerms: true,
      termsVersion: CURRENT_LEGAL_ACCEPTANCE.termsVersion,
      privacyVersion: CURRENT_LEGAL_ACCEPTANCE.privacyVersion,
    });
    assert.notEqual(again.id, human.id);
  } finally {
    emails.stop();
  }
});

test("an ops request's receipt names the operator", async ({ seed }) => {
  const human = await seed.human();
  const operator = await seed.human();
  await dueRequest(human, "ops", operator.id);
  await runAccountDeletionCleanup({ deps: externalCalls().deps });
  const [receipt] = await getDb().select().from(userRetirementReceipts).where(eq(userRetirementReceipts.userId, human.id));
  assert.equal(receipt?.actorUserId, operator.id);
});

test("two runs at once retire each account once", async ({ seed }) => {
  const first = await seed.human();
  const second = await seed.human();
  await dueRequest(first);
  await dueRequest(second);
  const emails = captureEmails();
  try {
    const { deps } = externalCalls();
    const reports = await Promise.all([runAccountDeletionCleanup({ deps }), runAccountDeletionCleanup({ deps })]);
    const retired = reports.flatMap((report) => report.retired).sort();
    assert.deepEqual(retired, [first.id, second.id].sort());
    const completed = reports.flatMap((report) => report.completed).sort();
    assert.deepEqual(completed, [first.id, second.id].sort());
    assert.equal(emails.deliveries.length, 2);
    assert.equal((await getDb().select().from(userRetirementReceipts)).length, 2);
    // A later run finds nothing.
    assert.deepEqual(await runAccountDeletionCleanup({ deps }), { retired: [], completed: [], resumeLater: [] });
  } finally {
    emails.stop();
  }
});

test("servers are handed over: another owner, else the earliest admin, else the earliest member; agents and guests never; nobody left deletes it", async ({ seed }) => {
  const owner = await seed.human();
  const coOwnerServer = await seed.server({ owner, name: "Co-owned" });
  const adminServer = await seed.server({ owner, name: "Admins" });
  const memberServer = await seed.server({ owner, name: "Members" });
  const guestOnlyServer = await seed.server({ owner, name: "Guests and agents" });
  const aloneServer = await seed.server({ owner, name: "Alone" });
  await getDb().insert(subscriptions).values({ serverId: aloneServer.id, stripeCustomerId: "cus_alone", stripeSubscriptionId: "sub_alone", status: "active" });
  // Asked while only they were in each; people joined during the grace period.
  await dueRequest(owner);

  const at = (minutes: number) => new Date(Date.UTC(2026, 0, 1, 0, minutes));
  const join = async (serverId: string, human: Human, role: "owner" | "admin" | "member" | "guest", joinedAt: Date) => {
    if (role === "guest") await seedBoundGuest({ serverId, userId: human.id });
    else await addMember(serverId, human.id, role === "owner" ? "member" : role);
    await getDb().update(serverMembers).set({ role, joinedAt }).where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, human.id)));
  };
  const [lateOwner, earlyOwner, admin1] = [await seed.human(), await seed.human(), await seed.human()];
  await join(coOwnerServer.id, admin1, "admin", at(0));
  await join(coOwnerServer.id, lateOwner, "owner", at(5));
  await join(coOwnerServer.id, earlyOwner, "owner", at(3));
  const [earlyMember, laterAdmin, earliestAdmin] = [await seed.human(), await seed.human(), await seed.human({ name: "Earliest Admin" })];
  await join(adminServer.id, earlyMember, "member", at(0));
  await join(adminServer.id, laterAdmin, "admin", at(9));
  await join(adminServer.id, earliestAdmin, "admin", at(4));
  const [guest, firstMember, secondMember] = [await seed.human(), await seed.human(), await seed.human()];
  await join(memberServer.id, guest, "guest", at(0));
  await join(memberServer.id, secondMember, "member", at(7));
  await join(memberServer.id, firstMember, "member", at(6));
  await createAgent(memberServer.id, "an-agent", { runtime: "external" });
  const onlyGuest = await seed.human();
  await join(guestOnlyServer.id, onlyGuest, "guest", at(0));
  await createAgent(guestOnlyServer.id, "lonely-agent", { runtime: "external" });

  const emails = captureEmails();
  try {
    const { calls, deps } = externalCalls();
    await runAccountDeletionCleanup({ deps });
    const serverRow = async (id: string) => (await getDb().select().from(servers).where(eq(servers.id, id)))[0]!;
    const roleOf = async (serverId: string, userId: string) => (await getDb().select({ role: serverMembers.role }).from(serverMembers)
      .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId))))[0]?.role;

    assert.equal((await serverRow(coOwnerServer.id)).ownerId, earlyOwner.id);
    assert.equal((await serverRow(adminServer.id)).ownerId, earliestAdmin.id);
    assert.equal(await roleOf(adminServer.id, earliestAdmin.id), "owner");
    assert.equal(await roleOf(adminServer.id, laterAdmin.id), "admin");
    assert.equal((await serverRow(memberServer.id)).ownerId, firstMember.id);
    assert.equal(await roleOf(memberServer.id, firstMember.id), "owner");
    assert.equal(await roleOf(memberServer.id, guest.id), "guest");
    for (const server of [coOwnerServer, adminServer, memberServer]) assert.equal((await serverRow(server.id)).deletedAt, null, server.name);
    assert.ok((await serverRow(guestOnlyServer.id)).deletedAt);
    assert.ok((await serverRow(aloneServer.id)).deletedAt);
    assert.deepEqual(calls.stripe, ["sub_alone"]);

    const [receipt] = await getDb().select().from(userRetirementReceipts).where(eq(userRetirementReceipts.userId, owner.id));
    const handoffs = [...(receipt?.serverHandoffs ?? [])].sort((a, b) => a.serverId.localeCompare(b.serverId));
    assert.deepEqual(handoffs, [
      { serverId: coOwnerServer.id, outcome: "owner_reassigned", newOwnerUserId: earlyOwner.id },
      { serverId: adminServer.id, outcome: "owner_promoted", newOwnerUserId: earliestAdmin.id, previousRole: "admin" },
      { serverId: memberServer.id, outcome: "owner_promoted", newOwnerUserId: firstMember.id, previousRole: "member" },
      { serverId: guestOnlyServer.id, outcome: "server_deleted" },
      { serverId: aloneServer.id, outcome: "server_deleted" },
    ].sort((a, b) => a.serverId.localeCompare(b.serverId)));

    // The promoted people are told; the co-owner was already an owner.
    const ownerMails = emails.deliveries.filter((mail) => /You are now the owner/.test(mail.subject));
    assert.deepEqual(ownerMails.map((mail) => mail.to).sort(), [earliestAdmin.email, firstMember.email].sort());
    assert.match(ownerMails.find((mail) => mail.to === earliestAdmin.email)!.subject, /Admins/);
  } finally {
    emails.stop();
  }
});

test("the person's agents go to the server's owner, stopped (unbound from the person's Computer); the personal assistant is archived; someone else's agent is untouched", async ({ seed }) => {
  const human = await seed.human();
  const colleague = await seed.human();
  const server = await seed.server({ owner: colleague, members: [human] });
  const db = getDb();
  const onTheirComputer = await createAgent(server.id, "made-by-them", { runtime: "external", creatorType: "user", creatorId: human.id });
  const onColleagueComputer = await createAgent(server.id, "made-by-them-too", { runtime: "external", creatorType: "user", creatorId: human.id });
  const assistant = await createAgent(server.id, "their-helper", { runtime: "external" });
  await db.update(agents).set({ assistantOwnerUserId: human.id }).where(eq(agents.id, assistant.id));
  const others = await createAgent(server.id, "colleagues", { runtime: "external", creatorType: "user", creatorId: colleague.id });
  await dueRequest(human);
  const [theirMachine] = await db.insert(machines).values({ serverId: server.id, userId: human.id, name: "laptop", apiKeyHash: "hash-1", hostname: "their-laptop.local", os: "darwin" }).returning();
  const [colleagueMachine] = await db.insert(machines).values({ serverId: server.id, userId: colleague.id, name: "box", apiKeyHash: "hash-2", hostname: "box.local", os: "linux" }).returning();
  await db.update(agents).set({ machineId: theirMachine!.id, status: "active" }).where(eq(agents.id, onTheirComputer.id));
  await db.update(agents).set({ machineId: colleagueMachine!.id }).where(eq(agents.id, onColleagueComputer.id));
  const emails = captureEmails();
  const handedOver: Array<{ agentId: string; deletedName: string; machineCleared: boolean }> = [];
  try {
    await runAccountDeletionCleanup({ deps: { ...externalCalls().deps, noticeAgentHandedOver: async (notice, deletedName) => { handedOver.push({ agentId: notice.agentId, deletedName, machineCleared: notice.machineCleared }); } } });
  } finally {
    emails.stop();
  }
  const row = async (id: string) => (await db.select().from(agents).where(eq(agents.id, id)))[0]!;

  for (const id of [onTheirComputer.id, onColleagueComputer.id]) {
    const agent = await row(id);
    assert.equal(agent.deletedAt, null, "handed over, not archived");
    assert.equal(agent.creatorType, "user");
    assert.equal(agent.creatorId, colleague.id);
    assert.equal(agent.status, "stopped");
  }
  assert.equal((await row(onTheirComputer.id)).machineId, null, "the person's revoked Computer is unbound");
  assert.equal((await row(onColleagueComputer.id)).machineId, colleagueMachine!.id, "someone else's Computer stays bound");
  assert.ok((await row(assistant.id)).deletedAt, "the personal assistant is archived");
  assert.equal((await row(others.id)).deletedAt, null);
  assert.equal((await row(others.id)).creatorId, colleague.id);
  const archives = await db.execute(sql`select agent_id from agent_archives`);
  assert.deepEqual((archives.rows as Array<{ agent_id: string }>).map((r) => r.agent_id), [assistant.id]);

  const [receipt] = await db.select().from(userRetirementReceipts).where(eq(userRetirementReceipts.userId, human.id));
  const byAgent = new Map((receipt!.agentDispositions ?? []).map((d) => [d.agentId, d]));
  assert.deepEqual(byAgent.get(onTheirComputer.id), { agentId: onTheirComputer.id, serverId: server.id, outcome: "transferred", toUserId: colleague.id, machineCleared: true, hosted: false });
  assert.deepEqual(byAgent.get(onColleagueComputer.id), { agentId: onColleagueComputer.id, serverId: server.id, outcome: "transferred", toUserId: colleague.id, machineCleared: false, hosted: false });
  assert.deepEqual(byAgent.get(assistant.id), { agentId: assistant.id, serverId: server.id, outcome: "archived", reason: "personal_assistant" });
  assert.equal(byAgent.has(others.id), false);

  // The same handover in the new owner's DM with each agent.
  assert.deepEqual(
    handedOver.map(({ agentId, machineCleared }) => ({ agentId, machineCleared })).sort((x, y) => x.agentId.localeCompare(y.agentId)),
    [{ agentId: onTheirComputer.id, machineCleared: true }, { agentId: onColleagueComputer.id, machineCleared: false }].sort((x, y) => x.agentId.localeCompare(y.agentId)),
  );
  assert.ok(handedOver.every((n) => n.deletedName.length > 0));
  const notices = emails.deliveries.filter((d) => d.to === colleague.email && /agents are now yours/.test(d.subject));
  assert.equal(notices.length, 1, "one email to the new owner for both agents");
  assert.match(notices[0]!.text ?? "", /made-by-them/);
  assert.match(notices[0]!.text ?? "", /did not come along/);
});

test("a shared server the person paid for: its new owner checks billing even after cancellation was requested", async ({ seed }) => {
  const human = await seed.human();
  const member = await seed.human();
  const server = await seed.server({ owner: human, members: [member], name: "Paid team" });
  await getDb().update(serverMembers).set({ role: "owner" }).where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, member.id)));
  const periodEnd = new Date("2026-12-01T00:00:00Z");
  await getDb().insert(subscriptions).values({ serverId: server.id, stripeCustomerId: "cus_paid", stripeSubscriptionId: "sub_paid", status: "active", createdByUserId: human.id, currentPeriodEnd: periodEnd });
  await dueRequest(human);
  const scheduled: string[] = [];
  const emails = captureEmails();
  try {
    await runAccountDeletionCleanup({ deps: { ...externalCalls().deps, cancelSubscriptionAtPeriodEnd: async (serverId) => { scheduled.push(serverId); } } });
  } finally {
    emails.stop();
  }
  // The request did not set cancel_at_period_end here (no Stripe in tests), so the cleanup schedules it.
  assert.deepEqual(scheduled, [server.id]);
  const notice = emails.deliveries.find((d) => d.to === member.email && /Check the subscription for Paid team/.test(d.subject));
  assert.ok(notice, "the new owner is told");
  assert.match(notice!.text ?? "", /current status in Plan & Billing before making changes/);
  assert.doesNotMatch(`${notice!.subject} ${notice!.text ?? ""}`, /2026|subscribe again|subscription.*ends on|subscription stops on/);
});

test("a failed retirement cancellation is not reported to the owner as confirmed", async ({ seed }) => {
  const human = await seed.human();
  const member = await seed.human();
  const server = await seed.server({ owner: human, members: [member], name: "Synthetic paid team" });
  await getDb().update(serverMembers).set({ role: "owner" }).where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, member.id)));
  await getDb().insert(subscriptions).values({ serverId: server.id, stripeCustomerId: "cus_synthetic", stripeSubscriptionId: "sub_synthetic", status: "active", createdByUserId: human.id, currentPeriodEnd: new Date("2099-01-01T00:00:00Z") });
  await dueRequest(human);
  const emails = captureEmails();
  let attempts = 0;
  try {
    const report = await runAccountDeletionCleanup({ deps: { ...externalCalls().deps, cancelSubscriptionAtPeriodEnd: async () => { attempts++; throw new Error("synthetic cancellation failure"); } } });
    assert.equal(attempts, 1);
    assert.ok(report.retired.includes(human.id));
    const notice = emails.deliveries.find(delivery => delivery.to === member.email && /subscription for Synthetic paid team/i.test(delivery.subject));
    assert.ok(notice, "the server owner received a billing notice");
    assert.doesNotMatch(`${notice.subject}\n${notice.text ?? ""}`, /subscription.*ends on|subscription stops on|2099|subscribe again/i, "failed cancellation must not be described as confirmed");
    assert.match(notice.text ?? "", /current status in Plan & Billing before making changes/);
  } finally {
    emails.stop();
  }
});

test("an agent in a server deleted with the account goes with it", async ({ seed }) => {
  const human = await seed.human();
  const server = await seed.server({ owner: human, name: "Only me" });
  const agent = await createAgent(server.id, "solo-agent", { runtime: "external", creatorType: "user", creatorId: human.id });
  await dueRequest(human);
  await runAccountDeletionCleanup({ deps: externalCalls().deps });
  const [row] = await getDb().select().from(agents).where(eq(agents.id, agent.id));
  assert.ok(row!.deletedAt);
  const [receipt] = await getDb().select().from(userRetirementReceipts).where(eq(userRetirementReceipts.userId, human.id));
  assert.deepEqual(receipt!.agentDispositions, [{ agentId: agent.id, serverId: server.id, outcome: "archived", reason: "server_deleted" }]);
});

/** Rows in many of the classified tables for `human`, in `server`/`channel`. */
async function seedPersonalRows(human: Human, server: { id: string }, channel: { id: string }, message: { id: string; seq: number }) {
  const db = getDb();
  await signInForTest(human.id);
  await enrollSecondFactor(human.id);
  const now = new Date();
  for (let i = 0; i < 3; i += 1) {
    await db.insert(notificationOutbox).values({ receiverType: "user", receiverId: human.id, serverId: server.id, activityAt: now, eventKey: `test:${randomUUID()}` });
  }
  await db.insert(inboxNotificationFacts).values({ receiverType: "user", receiverId: human.id, serverId: server.id, kind: "channel", sourceChannelId: channel.id, messageId: message.id, messageSeq: message.seq, activityAt: now });
  await db.insert(threadFollows).values({ threadChannelId: channel.id, followerType: "user", followerId: human.id, parentMessageId: message.id, reason: "manual" });
  await db.insert(objectInboxStates).values({ userId: human.id, objectKind: "test", objectId: randomUUID(), serverId: server.id, homeKind: "server", lastEventId: randomUUID(), lastEventSeq: 1, lastEventAt: now });
  await db.insert(pushSubscriptions).values({ userId: human.id, endpoint: `https://push.test/${randomUUID()}`, p256dh: "k", auth: "a" });
  await db.insert(userNotificationSettings).values({ userId: human.id });
  await db.insert(userChannelReadCursors).values({ userId: human.id, channelId: channel.id, lastReadSeq: 1 });
  await db.insert(userSaved).values({ userId: human.id, messageId: message.id, serverId: server.id });
  await db.insert(newsletterAudienceContacts).values({ userId: human.id, email: human.email, audienceId: "aud", resendContactId: `contact-${human.id}` });
  await db.insert(paidLifecycleJourneys).values({ userId: human.id, firstPaidAt: now, contactId: `paid-${human.id}` });
  await db.insert(onboardingEmailJourneys).values({ userId: human.id, email: human.email, releaseMode: "all", qualifiedAt: now, day1Status: "scheduled", day1EmailId: `email-${human.id}` });
  const hex = () => createHash("sha256").update(randomUUID()).digest("hex");
  await db.insert(appSumoRedemptionClaims).values({ tokenHash: hex(), codeHash: hex(), productId: "p", userId: human.id, state: "exchanging", expiresAt: new Date(now.getTime() + 60_000) });
  await db.insert(appSumoRedemptionClaims).values({ tokenHash: hex(), codeHash: hex(), productId: "p", userId: human.id, state: "consumed", licenseKey: randomUUID() as never, expiresAt: now });
  // A View Context grant the person gave (one active grant per agent, so a grantee agent per person).
  const grantee = await createAgent(server.id, `grantee-${human.id.slice(0, 8)}`, { runtime: "external" });
  await db.insert(agentContextViewGrants).values({ id: mintAgentContextViewGrantId(), serverId: server.id, granteeAgentId: grantee.id, granterUserId: human.id });
}

const deleteCondition = (key: string) => {
  const column = key.split(".")[1]!;
  return key === "appsumo_redemption_claims.user_id" ? `${column} = $1 AND state <> 'consumed'` : `${column} = $1`;
};

/** The person's row count in every table the cleanup deletes from (classified keys and the no-foreign-key tables). */
async function personalRowCounts(userId: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  const count = async (name: string, table: string, where: string) => {
    const parts = where.split("$1");
    const result = await getDb().execute(sql`select count(*)::int as n from ${sql.identifier(table)} where ${sql.join(parts.map((part) => sql.raw(part)), sql`${userId}`)}`);
    counts[name] = Number((result.rows[0] as { n: number }).n);
  };
  for (const [key, classification] of Object.entries(USER_FOREIGN_KEY_CLASSIFICATION) as Array<[string, UserForeignKeyClassification]>) {
    if (classification.cleanup === "delete") await count(key, key.split(".")[0]!, deleteCondition(key));
  }
  for (const entry of USER_NO_FOREIGN_KEY_PERSONAL_TABLES) await count(entry.table, entry.table, entry.where);
  return counts;
}

test("every table the classification deletes from is emptied for the person and untouched for someone else; Resend and the scheduled email go first", async ({ seed }) => {
  const human = await seed.human();
  const other = await seed.human();
  const owner = await seed.human();
  const server = await seed.server({ owner, members: [human, other] });
  const channel = await seed.channel({ server, members: [owner, human, other] });
  const message = await seed.message({ channel, author: owner, content: "hello" });
  await seedPersonalRows(human, server, channel, message);
  await seedPersonalRows(other, server, channel, message);
  const seeded = await personalRowCounts(human.id);
  // At least the big tables, sessions, two-step verification, notifications and the external ones.
  for (const key of ["inbox_notification_facts", "thread_follows", "object_inbox_states", "notification_outbox.receiver_id", "sessions.user_id", "session_families.user_id", "user_totp.user_id", "user_backup_codes.user_id", "push_subscriptions.user_id", "user_notification_settings.user_id", "user_channel_read_cursors.user_id", "user_saved.user_id", "newsletter_audience_contacts.user_id", "paid_lifecycle_journeys.user_id", "onboarding_email_journeys.user_id", "appsumo_redemption_claims.user_id", "user_analytics_ids.user_id", "agent_context_view_grants.granter_user_id"]) {
    assert.ok(seeded[key]! > 0, `seeded ${key}`);
  }
  const otherBefore = await personalRowCounts(other.id);
  await dueRequest(human);
  // The request signed the person out; a stray sign-in during the grace period is taken too.
  // Two-step verification is on for them (seedPersonalRows), so it goes through the second step.
  await signInThroughSecondStepForTest(human.id);

  const { calls, deps } = externalCalls();
  const report = await runAccountDeletionCleanup({ deps });
  assert.deepEqual(report.completed, [human.id]);
  const after = await personalRowCounts(human.id);
  const leftovers = Object.entries(after).filter(([, n]) => n > 0);
  assert.deepEqual(leftovers, []);
  assert.deepEqual(await personalRowCounts(other.id), otherBefore);
  // A redeemed AppSumo claim is the license's audit: kept.
  const claims = await getDb().select({ state: appSumoRedemptionClaims.state }).from(appSumoRedemptionClaims).where(eq(appSumoRedemptionClaims.userId, human.id));
  assert.deepEqual(claims, [{ state: "consumed" }]);
  assert.deepEqual(calls.contacts.sort(), [`id:contact-${human.id}`, `id:paid-${human.id}`].sort());
  assert.deepEqual(calls.cancelledEmails, [`email-${human.id}`]);
});

test("a failed Resend call keeps its row and the request pending; the next run retries and completes", async ({ seed }) => {
  const human = await seed.human();
  await getDb().insert(newsletterAudienceContacts).values({ userId: human.id, email: human.email, audienceId: "aud" });
  await dueRequest(human);
  let fail = true;
  const deps: AccountDeletionCleanupDeps = {
    ...externalCalls().deps,
    deleteResendContact: async () => { if (fail) throw new Error("resend down"); },
  };
  const trace = vi.spyOn(tracing, "safeAddTraceEvent");
  try {
    const first = await runAccountDeletionCleanup({ deps });
    assert.deepEqual(first, { retired: [human.id], completed: [], resumeLater: [human.id] });
    // The run's trace counts the failure by step and error class, never the person.
    const events = (name: string) => trace.mock.calls.filter(([n]) => n === name).map(([, attrs]) => attrs());
    assert.deepEqual(events("account_deletion.cleanup.finished"), [{
      retired_count: 1, completed_count: 0, resume_later_count: 1, retire_failed_count: 0, after_retire_failed_count: 0, cleanup_failed_count: 1,
    }]);
    assert.deepEqual(events("account_deletion.cleanup.step_failed"), [{ phase: "cleanup", step: "delete_newsletter_contact", error_class: "Error", count: 1 }]);
    assert.ok(!JSON.stringify(trace.mock.calls.map(([, attrs]) => attrs())).includes(human.id));
    trace.mockClear();
    assert.equal((await requestOf(human.id))?.state, "pending");
    assert.equal((await getDb().select().from(newsletterAudienceContacts).where(eq(newsletterAudienceContacts.userId, human.id))).length, 1);
    fail = false;
    const second = await runAccountDeletionCleanup({ deps });
    assert.deepEqual(second, { retired: [], completed: [human.id], resumeLater: [] });
    assert.deepEqual(events("account_deletion.cleanup.step_failed"), []);
    assert.equal(events("account_deletion.cleanup.finished")[0]?.completed_count, 1);
  } finally {
    trace.mockRestore();
  }
  assert.equal((await getDb().select().from(newsletterAudienceContacts).where(eq(newsletterAudienceContacts.userId, human.id))).length, 0);
});

test("a failed effect after retirement counts under after_retire, by its fixed name, with no account details", async ({ seed }) => {
  const human = await seed.human();
  await dueRequest(human);
  const request = (await requestOf(human.id))!;
  const trace = vi.spyOn(tracing, "safeAddTraceEvent");
  try {
    await runAccountDeletionCleanup({ deps: { ...externalCalls().deps, deleteStoredUserAvatar: async () => { throw new TypeError("storage down"); } } });
    const attrs: Array<Record<string, unknown>> = trace.mock.calls.map(([name, getAttrs]) => ({ name, ...getAttrs() }));
    assert.deepEqual(attrs.filter((a) => a.name === "account_deletion.cleanup.step_failed"), [
      { name: "account_deletion.cleanup.step_failed", phase: "after_retire", step: "delete_avatar", error_class: "TypeError", count: 1 },
    ]);
    assert.equal(attrs.find((a) => a.name === "account_deletion.cleanup.finished")?.after_retire_failed_count, 1);
    const text = JSON.stringify(attrs);
    for (const secret of [human.id, human.email, request.id, "storage down"]) assert.ok(!text.includes(secret), secret);
  } finally {
    trace.mockRestore();
  }
});

test("big tables go in bounded batches: a run stops at its budget and the next one resumes", async ({ seed }) => {
  const human = await seed.human();
  const other = await seed.human();
  const owner = await seed.human();
  const server = await seed.server({ owner, members: [human, other] });
  const channel = await seed.channel({ server, members: [owner, human, other] });
  const now = new Date();
  for (const receiver of [human, other]) {
    for (let i = 0; i < 5; i += 1) {
      const message = await seed.message({ channel, author: owner, content: `m${i}` });
      await getDb().insert(inboxNotificationFacts).values({ receiverType: "user", receiverId: receiver.id, serverId: server.id, kind: "channel", sourceChannelId: channel.id, messageId: message.id, messageSeq: message.seq, activityAt: now });
      await getDb().insert(notificationOutbox).values({ receiverType: "user", receiverId: receiver.id, serverId: server.id, activityAt: now, eventKey: `test:${randomUUID()}` });
    }
  }
  await dueRequest(human);
  const facts = async (userId: string) => (await getDb().select().from(inboxNotificationFacts).where(eq(inboxNotificationFacts.receiverId, userId))).length;
  const options: AccountDeletionCleanupOptions = { deps: externalCalls().deps, batchSize: 2, batchesPerRequest: 2 };

  const first = await runAccountDeletionCleanup(options);
  assert.deepEqual(first, { retired: [human.id], completed: [], resumeLater: [human.id] });
  // Two batches of two: one fact left, nothing of anyone else's.
  assert.equal(await facts(human.id), 1);
  assert.equal(await facts(other.id), 5);
  assert.equal((await requestOf(human.id))?.cleanupLeaseUntil, null);

  const runs = await runUntilCompleted(human.id, options);
  assert.ok(runs >= 2, `completed after ${runs} more runs`);
  assert.equal(await facts(human.id), 0);
  assert.equal((await getDb().select().from(notificationOutbox).where(eq(notificationOutbox.receiverId, human.id))).length, 0);
  assert.equal(await facts(other.id), 5);
  assert.equal((await getDb().select().from(notificationOutbox).where(eq(notificationOutbox.receiverId, other.id))).length, 5);
});

test("kept rows: pending invites expire, links and unused tokens are revoked, Computers deleted, preferences reset, cards voided, push registrations revoked", async ({ seed }) => {
  const human = await seed.human();
  const owner = await seed.human();
  const server = await seed.server({ owner, members: [human] });
  const channel = await seed.channel({ server, members: [owner, human] });
  const message = await seed.message({ channel, author: human, content: "card" });
  const db = getDb();
  const future = new Date(Date.now() + 86_400_000);
  const [invite] = await db.insert(serverInvites).values({ serverId: server.id, invitedEmail: "x@test.invalid", invitedByUserId: human.id, tokenHash: randomUUID(), expiresAt: future }).returning();
  const [link] = await db.insert(serverJoinLinks).values({ serverId: server.id, createdByUserId: human.id, token: randomUUID() }).returning();
  const agent = await createAgent(server.id, "token-target", { runtime: "external" });
  const [token] = await db.insert(agentBootstrapTokens).values({ tokenLookupHash: Buffer.from(randomUUID()), tokenHash: "h", tokenPrefix: "p", targetAgentId: agent.id, serverId: server.id, issuedByUserId: human.id, scopes: ["send"], ttlExpiresAt: future }).returning();
  await db.update(serverMembers).set({ theme: "raft-blue", hiddenDmIds: ["x"], serverPushMode: "none" }).where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, human.id)));
  const [card] = await db.insert(actionCards).values({ serverId: server.id, messageId: message.id, requesterUserId: human.id, actionType: "test", payload: {}, state: "prepared" }).returning();
  await db.execute(sql`update messages set action_metadata = '{"kind":"action-card","state":"prepared"}'::json where id = ${message.id}`);
  const [push] = await db.insert(pushRegistrations).values({ installationId: "inst", provider: "apns", userId: human.id, deviceToken: "tok", topic: "t", env: "production" }).returning();
  await dueRequest(human);
  const [machine] = await db.insert(machines).values({ serverId: server.id, userId: human.id, name: "laptop", apiKeyHash: "hash", hostname: "my-laptop.local", os: "darwin" }).returning();
  await runAccountDeletionCleanup({ deps: externalCalls().deps });

  assert.equal((await db.select().from(serverInvites).where(eq(serverInvites.id, invite!.id)))[0]?.status, "expired");
  assert.ok((await db.select().from(serverJoinLinks).where(eq(serverJoinLinks.id, link!.id)))[0]?.revokedAt);
  const [revokedToken] = await db.select().from(agentBootstrapTokens).where(eq(agentBootstrapTokens.id, token!.id));
  assert.ok(revokedToken?.revokedAt);
  assert.equal(revokedToken?.revokedReason, "account_deleted");
  // Deleted at expiry, as the app's "Delete Computer" does (artin, #triage:d10ace06).
  assert.deepEqual(await db.select({ id: machines.id }).from(machines).where(eq(machines.id, machine!.id)), []);
  const [membership] = await db.select().from(serverMembers).where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, human.id)));
  assert.equal(membership?.role, "member");
  assert.equal(membership?.theme, null);
  assert.equal(membership?.hiddenDmIds, null);
  assert.equal(membership?.serverPushMode, "all");
  assert.equal((await db.select().from(actionCards).where(eq(actionCards.id, card!.id)))[0]?.state, "expired");
  const metadata = await db.execute(sql`select action_metadata->>'state' as state from messages where id = ${message.id}`);
  assert.equal((metadata.rows[0] as { state: string }).state, "expired");
  const [revokedPush] = await db.select().from(pushRegistrations).where(eq(pushRegistrations.id, push!.id));
  assert.ok(revokedPush?.revokedAt);
  assert.equal(revokedPush?.userId, human.id);
});

test("the person's avatar image is handed to the image deletion after retirement; a URL that is not a stored user avatar is left alone", async ({ seed }) => {
  const human = await seed.human();
  const avatarUrl = `/api/avatars/users/${"a".repeat(32)}.webp`;
  await getDb().update(users).set({ avatarUrl }).where(eq(users.id, human.id));
  await dueRequest(human);
  const asked: Array<string | null> = [];
  const { deps } = externalCalls();
  await runAccountDeletionCleanup({ deps: { ...deps, deleteStoredUserAvatar: async (url) => { asked.push(url); } } });
  assert.deepEqual(asked, [avatarUrl]);
  const [row] = await getDb().select({ avatarUrl: users.avatarUrl }).from(users).where(eq(users.id, human.id));
  assert.equal(row!.avatarUrl, null);

  assert.equal(await deleteStoredUserAvatarIfUnused("https://example.com/me.png", async () => false), false);
  assert.equal(await deleteStoredUserAvatarIfUnused(null, async () => false), false);
});

test("an avatar image counts as still shown by its content hash, whatever origin or query the other user's URL has; not by a retired user", async ({ seed }) => {
  const hash = "b".repeat(32);
  const other = await seed.human();
  await getDb().update(users).set({ avatarUrl: `https://cdn.other-origin.example/avatars/users/${hash}.webp?v=2` }).where(eq(users.id, other.id));
  assert.equal(await isUserAvatarHashStillShown(hash), true, "another spelling of the same object");
  await getDb().update(users).set({ retiredAt: new Date() }).where(eq(users.id, other.id));
  assert.equal(await isUserAvatarHashStillShown(hash), false, "a retired account shows nothing");
  assert.equal(await isUserAvatarHashStillShown("not-a-hash"), true, "anything but a hash is never deleted");
});

test("the person's Computer is deleted by the cleanup; another member's agent on it is unbound and stopped, and its owner is told", async ({ seed }) => {
  const human = await seed.human();
  const colleague = await seed.human();
  const server = await seed.server({ owner: colleague, members: [human] });
  const db = getDb();
  await dueRequest(human);
  const [laptop] = await db.insert(machines).values({ serverId: server.id, userId: human.id, name: "laptop", apiKeyHash: `hash-${randomUUID()}` }).returning();
  await db.insert(computers).values({
    serverId: server.id, name: "laptop", machineId: laptop!.id, apiKeyHash: "h", apiKeyPrefix: `sk_computer_${randomUUID().slice(0, 8)}`,
    attachedByUserId: human.id,
  });
  const theirs = await createAgent(server.id, "colleagues-on-laptop", { runtime: "external", creatorType: "user", creatorId: colleague.id });
  await db.update(agents).set({ machineId: laptop!.id, status: "active" }).where(eq(agents.id, theirs.id));
  const told: unknown[] = [];
  const { deps } = externalCalls();
  await runAccountDeletionCleanup({ deps: { ...deps, noticeDetachedComputer: async (computer, agentIds) => { told.push({ computer, agentIds }); } } });

  assert.deepEqual(await db.select({ id: machines.id }).from(machines).where(eq(machines.id, laptop!.id)), [], "the Computer is deleted");
  assert.deepEqual(told, [{ computer: { machineId: laptop!.id, serverId: server.id, computerName: "laptop" }, agentIds: [theirs.id] }]);
  const [agent] = await db.select({ machineId: agents.machineId, status: agents.status, deletedAt: agents.deletedAt }).from(agents).where(eq(agents.id, theirs.id));
  assert.deepEqual(agent, { machineId: null, status: "stopped", deletedAt: null }, "someone else's agent stays, unbound and stopped, for its owner to move");
});

test("Computers the person owned but someone else connected become Public, on every server, audited (Computer owner v1)", async ({ seed }) => {
  const human = await seed.human();
  const colleague = await seed.human();
  const one = await seed.server({ owner: colleague, members: [human] });
  const two = await seed.server({ owner: colleague, members: [human] });
  const db = getDb();
  await dueRequest(human);
  const boxes = [];
  for (const server of [one, two]) {
    const [box] = await db.insert(machines).values({ serverId: server.id, userId: colleague.id, name: "colleagues-box", apiKeyHash: `hash-${randomUUID()}`, ownerUserId: human.id }).returning();
    boxes.push(box!);
  }
  const { deps } = externalCalls();
  await runUntilCompleted(human.id, { deps });

  const rows = await db.select({ id: machines.id, ownerUserId: machines.ownerUserId }).from(machines).where(eq(machines.userId, colleague.id));
  assert.deepEqual(rows.map((row) => row.ownerUserId), [null, null], "both still there, Public");
  const audits = await db.select({ serverId: integrationAuditEvents.serverId, actorType: integrationAuditEvents.actorType, metadata: integrationAuditEvents.metadata })
    .from(integrationAuditEvents).where(eq(integrationAuditEvents.eventType, "computer.owner_changed"));
  assert.deepEqual(new Set(audits.map((row) => row.serverId)), new Set([one.id, two.id]));
  for (const row of audits) {
    assert.equal(row.actorType, "system");
    assert.equal((row.metadata as { reason?: string }).reason, "owner_account_deleted");
  }
});

test("the handover notice says the agent is stopped and, when it ran on the deleted person's computer, that it needs another one", () => {
  const onTheirs = agentHandedOverNoticeText({ agentName: "helper", deletedName: "Sam", machineCleared: true, hosted: false, agentUrl: "https://app.example/s/x/agent/1" });
  assert.match(onTheirs, /@helper is yours now: Sam deleted their account/);
  assert.match(onTheirs, /stopped and won't run until you start it/);
  assert.match(onTheirs, /choose one of your computers when you start it\. Files it kept on that computer did not come along/);
  assert.match(onTheirs, /Agent page: https:\/\/app\.example\/s\/x\/agent\/1/);
  assert.doesNotMatch(agentHandedOverNoticeText({ agentName: "helper", deletedName: "Sam", machineCleared: false, hosted: false, agentUrl: null }), /computer/);
});

test("the cleanup revokes a Computer the person attached on someone else's machine that is still live, audited as leaving; another member's stays", async ({ seed }) => {
  const human = await seed.human();
  const colleague = await seed.human();
  const server = await seed.server({ owner: colleague, members: [human] });
  const db = getDb();
  await dueRequest(human);
  // Live at expiry (the request revoked what existed then): the cleanup repairs it.
  const [desk] = await db.insert(machines).values({ serverId: server.id, userId: colleague.id, name: "desk", apiKeyHash: `hash-${randomUUID()}` }).returning();
  const attach = async (attachedByUserId: string) => (await db.insert(computers).values({
    serverId: server.id, name: "desk", machineId: desk!.id, apiKeyHash: `h-${randomUUID()}`, apiKeyPrefix: `sk_computer_${randomUUID().slice(0, 8)}`, attachedByUserId,
  }).returning({ id: computers.id }))[0]!.id;
  const borrowed = await attach(human.id);
  const colleagues = await attach(colleague.id);
  await runAccountDeletionCleanup({ deps: externalCalls().deps });

  const revokedAt = async (id: string) => (await db.select({ revokedAt: computers.revokedAt }).from(computers).where(eq(computers.id, id)))[0]!.revokedAt;
  assert.ok(await revokedAt(borrowed), "revoked by the cleanup");
  assert.equal(await revokedAt(colleagues), null, "another member's Computer is untouched");
  const [audit] = await db.select({ actorType: integrationAuditEvents.actorType, metadata: integrationAuditEvents.metadata }).from(integrationAuditEvents)
    .where(and(eq(integrationAuditEvents.eventType, "computer.key_revoked"), eq(integrationAuditEvents.targetId, borrowed)));
  assert.deepEqual({ actorType: audit!.actorType, via: audit!.metadata.via, departureReason: audit!.metadata.departureReason }, { actorType: "system", via: "member_removed", departureReason: "account_deleted" });
});
