import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import { createApiTest } from "../test/integration/apiTest";
import { getDb } from "../db/index";
import {
  accountDeletionRequests,
  agentCredentials,
  agentMigrationReceiptChannels,
  agentMigrations,
  agentRuntimeProvisions,
  agents,
  channelAgents,
  channels,
  authChallenges,
  computers,
  featureFlags,
  integrationAuditEvents,
  machines,
  messages,
  secondFactorAttemptWindows,
  serverMembers,
  reauthAttemptWindows,
  sessionFamilies,
  sessions,
  subscriptions,
} from "../db/schema";
import { verifyActiveAccessToken } from "../middleware/auth";
import {
  claimAccountDeletionEmailCode,
  consumeAccountDeletionEmailCode,
  sendAccountDeletionEmailCode,
} from "../services/accountDeletion/emailCode";
import { cancelAccountDeletion, findOthersAgentsOnComputers, requestAccountDeletion, requestAccountDeletionInTransaction, runAccountDeletionRequestedEffects } from "../services/accountDeletion/requests";
import { AGENT_OWNER_NOTICE_INTERVAL_MS, notifyAgentOwners } from "../services/accountDeletion/ownerNotices";
import * as channelService from "../services/channelService";
import type { DatabaseExecutor } from "../db/index";
import { autoAssignMachine, createAgent } from "../services/agentService";
import { findComputerByApiKeyWithReason } from "../services/computerCredentialService";
import { __setEmailDeliveryObserverForTests, type EmailDelivery } from "../services/emailService";
import { signInForTest } from "../test/integration/credentials";
import type { createSeed } from "../test/integration/seed";
import { enrollSecondFactor, totpCode, useTotpSecretKey, wrongTotpCode } from "../test/integration/secondFactor";

// Account deletion requests, PR 1 (design "删除账号：服务端设计 v1" §2-§6):
// re-authentication per kind of account, the sole-owner refusal, what a
// request revokes and stops, the restricted sign-in while it is pending, and
// cancelling. First of all: a person who never asked sees no change.

/** The retired `account_deletion_v0` row as production may still hold it (#raft-architecture:#32): read by nothing now. */
async function seedRetiredDeletionFlag(defaultEnabled: boolean): Promise<void> {
  await getDb().insert(featureFlags)
    .values({ key: "account_deletion_v0", randomizationUnit: "user", salt: "test", defaultEnabled })
    .onConflictDoUpdate({ target: featureFlags.key, set: { defaultEnabled } });
}

const test = createApiTest();
useTotpSecretKey();

const saved = { gate: process.env.SLOCK_DEVICE_LOGIN_ENABLED, pepper: process.env.AGENT_BOOTSTRAP_TOKEN_PEPPER };
beforeAll(() => {
  delete process.env.SLOCK_DEVICE_LOGIN_ENABLED;
  process.env.AGENT_BOOTSTRAP_TOKEN_PEPPER = "account-deletion-test-pepper-0123456789abcdef";
});
afterAll(() => {
  if (saved.gate === undefined) delete process.env.SLOCK_DEVICE_LOGIN_ENABLED;
  else process.env.SLOCK_DEVICE_LOGIN_ENABLED = saved.gate;
  if (saved.pepper === undefined) delete process.env.AGENT_BOOTSTRAP_TOKEN_PEPPER;
  else process.env.AGENT_BOOTSTRAP_TOKEN_PEPPER = saved.pepper;
});

type Json = Record<string, any>;

async function call(baseUrl: string, token: string | null, method: string, path: string, body?: unknown): Promise<{ status: number; body: Json }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as Json };
}

const DELETION = "/api/me/account/deletion";

/** A web sign-in made an hour ago: not recent enough to count as re-authentication. */
async function staleSession(userId: string) {
  const session = await signInForTest(userId);
  await getDb().update(sessionFamilies).set({ createdAt: new Date(Date.now() - 60 * 60_000) }).where(eq(sessionFamilies.id, session.familyId));
  return session;
}

async function passwordLogin(baseUrl: string, email: string): Promise<string> {
  const res = await call(baseUrl, null, "POST", "/api/auth/login", { email, password: "password123" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.accessToken as string;
}

function captureEmails() {
  const deliveries: EmailDelivery[] = [];
  __setEmailDeliveryObserverForTests((delivery) => deliveries.push(delivery));
  return { deliveries, stop: () => __setEmailDeliveryObserverForTests(null) };
}

const requestRows = (userId: string) => getDb().select().from(accountDeletionRequests).where(eq(accountDeletionRequests.userId, userId));
const passwordUser = { passwordCredentialEstablishedAt: new Date() };

test("a person who never asked: sign-in, sessions and every route unchanged; GET/DELETE answer none and write nothing", async ({ app, seed }) => {
  const human = await seed.human(passwordUser);
  const server = await seed.server({ owner: human });
  // Someone else's pending request changes nothing for this person.
  const other = await seed.human(passwordUser);
  const otherSession = await signInForTest(other.id);
  assert.equal((await call(app.baseUrl, otherSession.token, "POST", DELETION)).status, 200);
  const emails = captureEmails();
  try {
    const login = await call(app.baseUrl, null, "POST", "/api/auth/login", { email: human.email, password: "password123" });
    assert.equal(login.status, 200);
    assert.equal("accountDeletion" in login.body, false, "no field for a person with nothing scheduled");
    const token = login.body.accessToken as string;
    const me = await call(app.baseUrl, token, "GET", "/api/auth/me");
    assert.equal(me.status, 200);
    const servers = await call(app.baseUrl, token, "GET", "/api/servers");
    assert.equal(servers.status, 200);
    assert.ok((servers.body as unknown as Array<{ id: string }>).some((row) => row.id === server.id));
    assert.equal((await call(app.baseUrl, token, "GET", "/api/me/notification-settings")).status, 200);
    assert.equal((await verifyActiveAccessToken(token))?.sub, human.id);

    // The server only this person is in would be closed with the account.
    assert.deepEqual(await call(app.baseUrl, token, "GET", DELETION), { status: 200, body: { status: "none", soleOwnerServers: [], soleMemberServers: [{ id: server.id, name: server.name, slug: server.slug }], paidServersEndingAtPeriodEnd: [], agents: [], computers: [], graceDays: 7 } });
    assert.deepEqual(await call(app.baseUrl, token, "DELETE", DELETION), { status: 200, body: { status: "none" } });
    assert.deepEqual(await requestRows(human.id), []);
    assert.deepEqual(emails.deliveries, []);
    // Still signed in, every family live.
    assert.equal((await call(app.baseUrl, token, "GET", "/api/auth/me")).status, 200);
    const families = await getDb().select({ revokedAt: sessionFamilies.revokedAt }).from(sessionFamilies).where(eq(sessionFamilies.userId, human.id));
    assert.ok(families.length > 0 && families.every((family) => family.revokedAt === null));
  } finally {
    emails.stop();
  }
});

test("without re-authentication: 403 reauth_required listing the methods each kind of account can use", async ({ app, seed }) => {
  const withPassword = await seed.human(passwordUser);
  const socialOnly = await seed.human();
  const twoStep = await seed.human(passwordUser);
  // Signed in before turning two-step verification on (a first factor alone
  // no longer issues a session once it is on); the sessions stay valid.
  const sessions = new Map([[withPassword.id, await staleSession(withPassword.id)], [socialOnly.id, await staleSession(socialOnly.id)], [twoStep.id, await staleSession(twoStep.id)]]);
  const fresh = await signInForTest(twoStep.id);
  await enrollSecondFactor(twoStep.id);

  for (const [human, methods] of [[withPassword, ["password"]], [socialOnly, ["email_code"]], [twoStep, ["totp", "backup_code"]]] as const) {
    const session = sessions.get(human.id)!;
    const refused = await call(app.baseUrl, session.token, "POST", DELETION, {});
    assert.equal(refused.status, 403, human.email);
    assert.equal(refused.body.code, "reauth_required");
    assert.deepEqual(refused.body.methods, methods);
    assert.deepEqual(await requestRows(human.id), []);
  }
  // Two-step verification on: even a fresh sign-in needs the step-up answer.
  const refused = await call(app.baseUrl, fresh.token, "POST", DELETION, {});
  assert.equal(refused.status, 403);
  assert.deepEqual(refused.body.methods, ["totp", "backup_code"]);
});

test("password: re-authenticating the sign-in lets it request; the request is scheduled after the grace period", async ({ app, seed }) => {
  const human = await seed.human(passwordUser);
  const session = await staleSession(human.id);
  assert.equal((await call(app.baseUrl, session.token, "POST", DELETION)).status, 403);
  const reauth = await call(app.baseUrl, session.token, "POST", "/api/auth/second-factor/reauth/password", { password: "password123" });
  assert.equal(reauth.status, 204);
  const before = Date.now();
  const requested = await call(app.baseUrl, session.token, "POST", DELETION);
  assert.equal(requested.status, 200, JSON.stringify(requested.body));
  assert.deepEqual(Object.keys(requested.body).sort(), ["requestId", "requestedAt", "scheduledFor", "status"]);
  assert.equal(requested.body.status, "scheduled");
  const graceMs = Date.parse(requested.body.scheduledFor) - Date.parse(requested.body.requestedAt);
  assert.equal(graceMs, 7 * 24 * 60 * 60_000);
  assert.ok(Date.parse(requested.body.requestedAt) >= before - 1000);
  const [row] = await requestRows(human.id);
  assert.equal(row?.state, "pending");
  assert.equal(row?.source, "self");
  assert.equal(row?.actorUserId, human.id);
});

test("two-step verification: a wrong code counts toward the second-step lock and changes nothing; a right one requests", async ({ app, seed }) => {
  const human = await seed.human(passwordUser);
  // Signed in before turning it on (a first factor alone issues no session once it is on).
  const session = await signInForTest(human.id);
  const { secret } = await enrollSecondFactor(human.id);
  const wrong = await call(app.baseUrl, session.token, "POST", DELETION, { secondFactor: { code: wrongTotpCode(secret) } });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.code, "second_factor_code_invalid");
  assert.equal((await getDb().select().from(secondFactorAttemptWindows).where(eq(secondFactorAttemptWindows.userId, human.id)))[0]?.attempts, 1);
  assert.deepEqual(await requestRows(human.id), []);

  const right = await call(app.baseUrl, session.token, "POST", DELETION, { secondFactor: { code: totpCode(secret) } });
  assert.equal(right.status, 200, JSON.stringify(right.body));
  assert.equal(right.body.status, "scheduled");
  // The right answer gave its claim back; the wrong one stays counted.
  assert.equal((await getDb().select().from(secondFactorAttemptWindows).where(eq(secondFactorAttemptWindows.userId, human.id)))[0]?.attempts, 1);
});

test("email code: says someone asked to delete the account, bound to the sign-in, wrong answers count, then it confirms", async ({ app, seed }) => {
  const human = await seed.human();
  const emails = captureEmails();
  try {
    const session = await staleSession(human.id);
    const other = await staleSession(human.id);
    // Not offered to a person with a password.
    const withPassword = await seed.human(passwordUser);
    const notOffered = await call(app.baseUrl, (await staleSession(withPassword.id)).token, "POST", `${DELETION}/email-code`);
    assert.equal(notOffered.status, 409);
    assert.equal(notOffered.body.code, "email_code_not_available");

    const sent = await call(app.baseUrl, session.token, "POST", `${DELETION}/email-code`);
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    assert.equal(sent.body.sent, true);
    assert.equal(emails.deliveries.length, 1);
    const mail = emails.deliveries[0]!;
    assert.equal(mail.to, human.email);
    assert.match(mail.subject, /asked to delete your Raft account/);
    assert.match(mail.text!, /asked to delete it/);
    const code = /\b(\d{6})\b/.exec(mail.text!)![1]!;
    // Only a keyed digest is stored.
    const [stored] = await getDb().select().from(authChallenges).where(and(eq(authChallenges.userId, human.id), eq(authChallenges.kind, "account_deletion_email_code")));
    assert.ok(stored && !JSON.stringify(stored).includes(code));

    // At most one a minute.
    const again = await call(app.baseUrl, session.token, "POST", `${DELETION}/email-code`);
    assert.equal(again.status, 429);
    assert.equal(again.body.code, "email_code_recently_sent");

    // Another sign-in of the same person cannot use it.
    const elsewhere = await call(app.baseUrl, other.token, "POST", DELETION, { emailCode: code });
    assert.equal(elsewhere.status, 400);
    assert.equal(elsewhere.body.code, "email_code_invalid");
    const wrongCode = code === "000000" ? "000001" : "000000";
    const wrong = await call(app.baseUrl, session.token, "POST", DELETION, { emailCode: wrongCode });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.body.code, "email_code_invalid");
    assert.equal((await getDb().select().from(secondFactorAttemptWindows).where(eq(secondFactorAttemptWindows.userId, human.id)))[0]?.attempts, 2);
    assert.deepEqual(await requestRows(human.id), []);

    const right = await call(app.baseUrl, session.token, "POST", DELETION, { emailCode: code });
    assert.equal(right.status, 200, JSON.stringify(right.body));
    assert.equal(right.body.status, "scheduled");
    const [used] = await getDb().select().from(authChallenges).where(eq(authChallenges.id, stored!.id));
    assert.ok(used?.consumedAt);
    assert.equal((await getDb().select().from(secondFactorAttemptWindows).where(eq(secondFactorAttemptWindows.userId, human.id)))[0]?.attempts, 2);
  } finally {
    emails.stop();
  }
});

test("email code: single use, expires after 10 minutes, and the second-step lock refuses before checking", async ({ seed }) => {
  const human = await seed.human();
  const emails = captureEmails();
  try {
    const familyId = randomUUID();
    const now = new Date();
    assert.equal((await sendAccountDeletionEmailCode({ userId: human.id, familyId, now })).ok, true);
    const code = /\b(\d{6})\b/.exec(emails.deliveries[0]!.text!)![1]!;
    const claimed = await claimAccountDeletionEmailCode({ userId: human.id, familyId, code, now });
    assert.ok(claimed.ok);
    assert.equal(await getDb().transaction((tx) => consumeAccountDeletionEmailCode(tx, { userId: human.id, challengeId: claimed.challengeId, now })), true);
    assert.equal(await getDb().transaction((tx) => consumeAccountDeletionEmailCode(tx, { userId: human.id, challengeId: claimed.challengeId, now })), false);
    assert.deepEqual(await claimAccountDeletionEmailCode({ userId: human.id, familyId, code, now }), { ok: false, reason: "invalid" });

    // A new code, answered 10 minutes later: expired.
    const later = new Date(now.getTime() + 61_000);
    assert.equal((await sendAccountDeletionEmailCode({ userId: human.id, familyId, now: later })).ok, true);
    const second = /\b(\d{6})\b/.exec(emails.deliveries[1]!.text!)![1]!;
    assert.deepEqual(await claimAccountDeletionEmailCode({ userId: human.id, familyId, code: second, now: new Date(later.getTime() + 10 * 60_000) }), { ok: false, reason: "invalid" });

    // Locked: refused before the code is looked at.
    const lockedUntil = new Date(later.getTime() + 15 * 60_000);
    await getDb().insert(secondFactorAttemptWindows).values({ userId: human.id, windowStartedAt: later, attempts: 11, lockedUntil })
      .onConflictDoUpdate({ target: secondFactorAttemptWindows.userId, set: { attempts: 11, lockedUntil } });
    const locked = await claimAccountDeletionEmailCode({ userId: human.id, familyId, code: second, now: later });
    assert.equal(locked.ok, false);
    assert.equal(!locked.ok && locked.reason, "locked");
  } finally {
    emails.stop();
  }
});

test("sole owner of a server with other members: 409 listing it, and nothing changes", async ({ app, seed }) => {
  const owner = await seed.human(passwordUser);
  const member = await seed.human();
  const shared = await seed.server({ owner, members: [member], name: "Shared" });
  await seed.server({ owner, name: "Alone" });
  const session = await signInForTest(owner.id);
  const conflict = await call(app.baseUrl, session.token, "POST", DELETION);
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, "sole_owner_servers");
  assert.deepEqual(conflict.body.servers, [{ id: shared.id, name: "Shared", slug: shared.slug, memberCount: 2 }]);
  assert.deepEqual(await requestRows(owner.id), []);
  assert.equal((await call(app.baseUrl, session.token, "GET", "/api/auth/me")).status, 200);
  assert.ok((await getDb().select().from(sessions).where(eq(sessions.userId, owner.id))).length > 0);

  // Another owner among the members: no conflict.
  await getDb().update(serverMembers).set({ role: "owner" }).where(and(eq(serverMembers.serverId, shared.id), eq(serverMembers.userId, member.id)));
  const requested = await call(app.baseUrl, session.token, "POST", DELETION);
  assert.equal(requested.status, 200, JSON.stringify(requested.body));
});

/** A machine row for `userId`, optionally with a linked Computer row (`revoked` soft-revokes it). */
async function seedMachine(serverId: string, userId: string, name: string, computer?: "live" | "revoked") {
  const [machine] = await getDb().insert(machines).values({ serverId, userId, name, apiKeyHash: `hash-${randomUUID()}` }).returning();
  if (computer) {
    await getDb().insert(computers).values({
      serverId, name, machineId: machine!.id, apiKeyHash: "h", apiKeyPrefix: `sk_computer_${randomUUID().slice(0, 8)}`,
      attachedByUserId: userId, revokedAt: computer === "revoked" ? new Date() : null,
    });
  }
  return machine!;
}

test("the person's own attached Computers: GET lists them with their agents; their own agents don't block POST", async ({ app, seed }) => {
  const human = await seed.human(passwordUser);
  const colleague = await seed.human();
  const server = await seed.server({ owner: human, members: [colleague], name: "Home" });
  await getDb().update(serverMembers).set({ role: "owner" }).where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, colleague.id)));
  const laptop = await seedMachine(server.id, human.id, "laptop", "live");
  const legacy = await seedMachine(server.id, human.id, "legacy-box");
  const oldDesktop = await seedMachine(server.id, human.id, "old-desktop", "revoked");
  const colleagues = await seedMachine(server.id, colleague.id, "their-box", "live");
  const gone = await seed.server({ owner: human, name: "Gone" });
  await seedMachine(gone.id, human.id, "in-a-deleted-server", "live");
  await getDb().execute(sql`update servers set deleted_at = now() where id = ${gone.id}`);
  const zeta = await createAgent(server.id, "zeta", { runtime: "external", creatorType: "user", creatorId: human.id });
  const archived = await createAgent(server.id, "archived", { runtime: "external", creatorType: "user", creatorId: human.id });
  const elsewhere = await createAgent(server.id, "on-their-box", { runtime: "external", creatorType: "user", creatorId: human.id });
  // Someone else's agents, but not on a live Computer of the person: a deleted
  // agent, one on their revoked Computer, one on the colleague's own box.
  const colleaguesDeleted = await createAgent(server.id, "colleagues-deleted", { runtime: "external", creatorType: "user", creatorId: colleague.id });
  const onRevoked = await createAgent(server.id, "on-revoked", { runtime: "external", creatorType: "user", creatorId: colleague.id });
  const colleaguesOwn = await createAgent(server.id, "colleagues-own", { runtime: "external", creatorType: "user", creatorId: colleague.id });
  await getDb().update(agents).set({ machineId: laptop.id, displayName: "Zed" }).where(eq(agents.id, zeta.id));
  await getDb().update(agents).set({ machineId: laptop.id, deletedAt: new Date() }).where(eq(agents.id, archived.id));
  await getDb().update(agents).set({ machineId: laptop.id, deletedAt: new Date() }).where(eq(agents.id, colleaguesDeleted.id));
  await getDb().update(agents).set({ machineId: oldDesktop.id }).where(eq(agents.id, onRevoked.id));
  await getDb().update(agents).set({ machineId: colleagues.id }).where(inArray(agents.id, [elsewhere.id, colleaguesOwn.id]));
  const session = await signInForTest(human.id);

  // Not the revoked Computer, not someone else's, not one in a deleted server; live agents only.
  const homeServer = { id: server.id, name: "Home", slug: server.slug };
  const expected = [
    { id: laptop.id, name: "laptop", server: homeServer, agents: [{ id: zeta.id, name: "Zed", ownedByMe: true }] },
    { id: legacy.id, name: "legacy-box", server: homeServer, agents: [] },
  ];
  const overview = await call(app.baseUrl, session.token, "GET", DELETION);
  assert.equal(overview.status, 200);
  assert.deepEqual(overview.body.computers, expected);

  // They do not block: the cleanup detaches them when the grace period ends.
  const requested = await call(app.baseUrl, session.token, "POST", DELETION);
  assert.equal(requested.status, 200, JSON.stringify(requested.body));
  assert.equal(requested.body.status, "scheduled");
  assert.equal((await requestRows(human.id)).length, 1);
});

/** A person with a live laptop in a shared server, and a colleague (who owns it too) with their own box. */
async function seedSharedComputers(seed: ReturnType<typeof createSeed>) {
  const human = await seed.human(passwordUser);
  const colleague = await seed.human({ name: "Colleague" });
  const server = await seed.server({ owner: human, members: [colleague], name: "Home" });
  await getDb().update(serverMembers).set({ role: "owner" }).where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, colleague.id)));
  const laptop = await seedMachine(server.id, human.id, "laptop", "live");
  const theirBox = await seedMachine(server.id, colleague.id, "their-box", "live");
  return { human, colleague, server, laptop, theirBox, homeServer: { id: server.id, name: "Home", slug: server.slug } };
}

test("someone else's agent on the person's live Computer: GET lists its owner, POST is a 409 listing it and changes nothing, until it is moved or deleted", async ({ app, seed }) => {
  const { human, colleague, server, laptop, theirBox, homeServer } = await seedSharedComputers(seed);
  const legacy = await seedMachine(server.id, human.id, "legacy-box");
  const alpha = await createAgent(server.id, "alpha", { runtime: "external", creatorType: "user", creatorId: colleague.id });
  const beta = await createAgent(server.id, "beta", { runtime: "external", creatorType: "user", creatorId: colleague.id });
  await getDb().update(agents).set({ machineId: laptop.id }).where(eq(agents.id, alpha.id));
  // A legacy machine (no Computer row) counts as live too.
  await getDb().update(agents).set({ machineId: legacy.id }).where(eq(agents.id, beta.id));
  const session = await signInForTest(human.id);
  const owner = { id: colleague.id, name: "Colleague" };

  const overview = await call(app.baseUrl, session.token, "GET", DELETION);
  assert.deepEqual(overview.body.computers, [
    { id: laptop.id, name: "laptop", server: homeServer, agents: [{ id: alpha.id, name: "alpha", ownedByMe: false, owner, personalAssistant: false, ownerNotifiedAt: null, ownerNextNotifyAt: null }] },
    { id: legacy.id, name: "legacy-box", server: homeServer, agents: [{ id: beta.id, name: "beta", ownedByMe: false, owner, personalAssistant: false, ownerNotifiedAt: null, ownerNextNotifyAt: null }] },
  ]);

  const conflict = await call(app.baseUrl, session.token, "POST", DELETION);
  assert.equal(conflict.status, 409, JSON.stringify(conflict.body));
  assert.equal(conflict.body.code, "others_agents_on_computers");
  assert.deepEqual(conflict.body.agents, [
    { id: alpha.id, name: "alpha", server: homeServer, computer: { id: laptop.id, name: "laptop" }, owner, personalAssistant: false, ownerNotifiedAt: null, ownerNextNotifyAt: null },
    { id: beta.id, name: "beta", server: homeServer, computer: { id: legacy.id, name: "legacy-box" }, owner, personalAssistant: false, ownerNotifiedAt: null, ownerNextNotifyAt: null },
  ]);
  // Nothing changed: no request, still signed in, the Computers' keys live.
  assert.deepEqual(await requestRows(human.id), []);
  assert.equal((await call(app.baseUrl, session.token, "GET", "/api/auth/me")).status, 200);
  const [laptopKey] = await getDb().select({ revokedAt: computers.revokedAt }).from(computers).where(eq(computers.machineId, laptop.id));
  assert.equal(laptopKey!.revokedAt, null);
  const [legacyRow] = await getDb().select({ apiKeyHash: machines.apiKeyHash }).from(machines).where(eq(machines.id, legacy.id));
  assert.doesNotMatch(legacyRow!.apiKeyHash, /^revoked:/);
  // The same answer under the lock (the ops entry and the re-authenticated paths).
  const outcome = await requestAccountDeletion({ userId: human.id, source: "self", actorUserId: human.id });
  assert.equal(outcome.kind === "conflict" ? outcome.code : outcome.kind, "others_agents_on_computers");
  assert.deepEqual(await requestRows(human.id), []);

  // Its owner moves one and deletes the other: no conflict any more.
  await getDb().update(agents).set({ machineId: theirBox.id }).where(eq(agents.id, alpha.id));
  assert.equal((await call(app.baseUrl, session.token, "POST", DELETION)).status, 409, "the other one still blocks");
  await getDb().update(agents).set({ deletedAt: new Date() }).where(eq(agents.id, beta.id));
  const requested = await call(app.baseUrl, session.token, "POST", DELETION);
  assert.equal(requested.status, 200, JSON.stringify(requested.body));
});

test("the Computer keys are revoked in the request's own transaction: rolled back together, committed together", async ({ seed }) => {
  const { human, laptop } = await seedSharedComputers(seed);
  const laptopRevokedAt = async (executor: DatabaseExecutor = getDb()) =>
    (await executor.select({ revokedAt: computers.revokedAt }).from(computers).where(eq(computers.machineId, laptop.id)))[0]!.revokedAt;
  class Rollback extends Error {}
  await assert.rejects(getDb().transaction(async (tx) => {
    const outcome = await requestAccountDeletionInTransaction(tx, { userId: human.id, source: "self", actorUserId: human.id });
    assert.equal(outcome.kind, "scheduled");
    assert.ok(await laptopRevokedAt(tx), "revoked inside the request's transaction");
    throw new Rollback();
  }), Rollback);
  assert.deepEqual(await requestRows(human.id), []);
  assert.equal(await laptopRevokedAt(), null, "rolled back with the request");

  const outcome = await requestAccountDeletion({ userId: human.id, source: "self", actorUserId: human.id });
  assert.equal(outcome.kind, "scheduled");
  const [request] = await requestRows(human.id);
  assert.equal((await laptopRevokedAt())?.getTime(), request!.requestedAt.getTime(), "committed with the request, at its time");
});

test("notify-agent-owners: a system notice to the owner naming only the computer, once per 24 hours; others skipped with why; GET and the 409 carry ownerNotifiedAt", async ({ app, seed }) => {
  const { human, colleague, server, laptop, theirBox, homeServer } = await seedSharedComputers(seed);
  const alpha = await createAgent(server.id, "alpha", { runtime: "external", creatorType: "user", creatorId: colleague.id });
  const mine = await createAgent(server.id, "mine", { runtime: "external", creatorType: "user", creatorId: human.id });
  const foreignElsewhere = await createAgent(server.id, "foreign-elsewhere", { runtime: "external", creatorType: "user", creatorId: colleague.id });
  const byAgent = await createAgent(server.id, "by-agent", { runtime: "external", creatorType: "agent", creatorId: alpha.id });
  await getDb().update(agents).set({ machineId: laptop.id }).where(inArray(agents.id, [alpha.id, mine.id, byAgent.id]));
  await getDb().update(agents).set({ machineId: theirBox.id }).where(eq(agents.id, foreignElsewhere.id));
  const session = await signInForTest(human.id);
  const NOTIFY = `${DELETION}/notify-agent-owners`;

  for (const body of [{}, { agentIds: [] }, { agentIds: [1] }, { agentIds: [""] }, { agentIds: Array.from({ length: 201 }, () => randomUUID()) }]) {
    const refused = await call(app.baseUrl, session.token, "POST", NOTIFY, body);
    assert.equal(refused.status, 400, JSON.stringify(body).slice(0, 80));
    assert.equal(refused.body.code, "invalid_agent_ids");
  }

  const unknown = randomUUID();
  const first = await call(app.baseUrl, session.token, "POST", NOTIFY, { agentIds: [alpha.id, mine.id, foreignElsewhere.id, byAgent.id, unknown, alpha.id] });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.notified.length, 1);
  const notifiedAt = first.body.notified[0].notifiedAt as string;
  assert.deepEqual(first.body, {
    notified: [{ agentId: alpha.id, notifiedAt }],
    skipped: [
      { agentId: mine.id, reason: "not_on_your_computer" },
      { agentId: foreignElsewhere.id, reason: "not_on_your_computer" },
      { agentId: byAgent.id, reason: "no_owner" },
      { agentId: unknown, reason: "not_on_your_computer" },
    ],
  });

  // The notice: a system message in the owner's DM with the agent, naming the computer, not the person.
  const dm = await channelService.findOrCreateDM(server.id, colleague.id, alpha.id);
  const notices = await getDb().select({ content: messages.content, senderType: messages.senderType }).from(messages)
    .where(and(eq(messages.channelId, dm!.id), eq(messages.messageType, "system")));
  assert.equal(notices.length, 1);
  assert.match(notices[0]!.content, /move @alpha to another computer/);
  assert.match(notices[0]!.content, /"laptop"/);
  assert.match(notices[0]!.content, /The computer's owner can't delete their account/);
  for (const secret of [human.email, human.name, human.displayName!]) assert.ok(!notices[0]!.content.includes(secret), "nothing about the person");

  // Again within 24 hours: rate limited, no second notice.
  const nextAllowedAt = new Date(Date.parse(notifiedAt) + AGENT_OWNER_NOTICE_INTERVAL_MS).toISOString();
  const again = await call(app.baseUrl, session.token, "POST", NOTIFY, { agentIds: [alpha.id] });
  assert.deepEqual(again.body, {
    notified: [],
    skipped: [{ agentId: alpha.id, reason: "rate_limited", nextAllowedAt }],
  });
  assert.equal((await getDb().select({ id: messages.id }).from(messages).where(and(eq(messages.channelId, dm!.id), eq(messages.messageType, "system")))).length, 1);

  // GET and the 409 say when.
  const overview = await call(app.baseUrl, session.token, "GET", DELETION);
  const listed = (overview.body.computers as Array<{ agents: Array<Record<string, unknown>> }>)[0]!.agents;
  assert.deepEqual(listed.find((agent) => agent.id === alpha.id), { id: alpha.id, name: "alpha", ownedByMe: false, owner: { id: colleague.id, name: "Colleague" }, personalAssistant: false, ownerNotifiedAt: notifiedAt, ownerNextNotifyAt: nextAllowedAt });
  assert.deepEqual(listed.find((agent) => agent.id === byAgent.id), { id: byAgent.id, name: "by-agent", ownedByMe: false, owner: null, personalAssistant: false, ownerNotifiedAt: null, ownerNextNotifyAt: null });
  assert.deepEqual(listed.find((agent) => agent.id === mine.id), { id: mine.id, name: "mine", ownedByMe: true });
  const conflict = await call(app.baseUrl, session.token, "POST", DELETION);
  assert.equal(conflict.status, 409);
  assert.deepEqual(conflict.body.agents, [
    { id: alpha.id, name: "alpha", server: homeServer, computer: { id: laptop.id, name: "laptop" }, owner: { id: colleague.id, name: "Colleague" }, personalAssistant: false, ownerNotifiedAt: notifiedAt, ownerNextNotifyAt: nextAllowedAt },
    { id: byAgent.id, name: "by-agent", server: homeServer, computer: { id: laptop.id, name: "laptop" }, owner: null, personalAssistant: false, ownerNotifiedAt: null, ownerNextNotifyAt: null },
  ]);

  // After 24 hours the person may ask again.
  const posted: string[] = [];
  const later = await notifyAgentOwners({
    requesterId: human.id,
    agentIds: [alpha.id],
    blocking: await findOthersAgentsOnComputers(getDb(), human.id),
    now: new Date(Date.parse(notifiedAt) + AGENT_OWNER_NOTICE_INTERVAL_MS + 1),
    post: async ({ agentId }) => { posted.push(agentId); return true; },
  });
  assert.deepEqual(later.notified.map((row) => row.agentId), [alpha.id]);
  assert.deepEqual(posted, [alpha.id]);
});

test("sole owner and an attached Computer: sole_owner_servers is answered first", async ({ app, seed }) => {
  const owner = await seed.human(passwordUser);
  const member = await seed.human();
  const shared = await seed.server({ owner, members: [member], name: "Shared" });
  await seedMachine(shared.id, owner.id, "laptop", "live");
  const session = await signInForTest(owner.id);
  const conflict = await call(app.baseUrl, session.token, "POST", DELETION);
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, "sole_owner_servers");
  assert.deepEqual(conflict.body.servers, [{ id: shared.id, name: "Shared", slug: shared.slug, memberCount: 2 }]);
  const outcome = await requestAccountDeletion({ userId: owner.id, source: "self", actorUserId: owner.id });
  assert.equal(outcome.kind, "conflict");
  assert.deepEqual(await requestRows(owner.id), []);
});

test("a server only the person is in is no conflict; GET lists it in soleMemberServers, not a server with others", async ({ app, seed }) => {
  const owner = await seed.human(passwordUser);
  const alone = await seed.server({ owner, name: "Alone" });
  const member = await seed.human();
  const shared = await seed.server({ owner, members: [member], name: "Shared" });
  await getDb().update(serverMembers).set({ role: "owner" }).where(and(eq(serverMembers.serverId, shared.id), eq(serverMembers.userId, member.id)));
  const elsewhere = await seed.server({ owner: member, members: [owner], name: "Elsewhere" });
  const closing = await createAgent(alone.id, "closing", { runtime: "external", creatorType: "user", creatorId: owner.id });
  const pending = await createAgent(shared.id, "pending-owner", { runtime: "external", creatorType: "user", creatorId: owner.id });
  const handed = await createAgent(elsewhere.id, "handed", { runtime: "external", creatorType: "user", creatorId: owner.id });
  const assistant = await createAgent(elsewhere.id, "assistant", { runtime: "external" });
  await getDb().update(agents).set({ assistantOwnerUserId: owner.id }).where(eq(agents.id, assistant.id));
  const session = await signInForTest(owner.id);
  const before = await call(app.baseUrl, session.token, "GET", DELETION);
  assert.deepEqual(before.body.soleMemberServers, [{ id: alone.id, name: "Alone", slug: alone.slug }]);
  const preview = new Map((before.body.agents as Array<{ id: string; outcome: string; toUser: { id: string } | null }>).map((a) => [a.id, a]));
  assert.equal(preview.get(closing.id)?.outcome, "closes_with_server");
  assert.deepEqual([preview.get(pending.id)?.outcome, preview.get(pending.id)?.toUser], ["transfer_to_owner", null], "still theirs to hand over");
  assert.deepEqual([preview.get(handed.id)?.outcome, preview.get(handed.id)?.toUser?.id], ["transfer_to_owner", member.id]);
  assert.equal(preview.get(assistant.id)?.outcome, "archive_personal_assistant");
  assert.equal((await call(app.baseUrl, session.token, "POST", DELETION)).status, 200);
});

test("a request signs out everywhere, revokes keys and Computers, stops the person's agents, and sends one email", async ({ app, seed }) => {
  const human = await seed.human(passwordUser);
  const server = await seed.server({ owner: human });
  const created = await createAgent(server.id, "made-by-me", { runtime: "external", creatorType: "user", creatorId: human.id });
  const assistant = await createAgent(server.id, "my-assistant", { runtime: "external", kind: "personal_assistant" });
  await getDb().update(agents).set({ assistantOwnerUserId: human.id }).where(eq(agents.id, assistant.id));
  const someoneElses = await createAgent(server.id, "not-mine", { runtime: "external", creatorType: "user", creatorId: randomUUID() });

  const web = await signInForTest(human.id);
  const minted = await call(app.baseUrl, web.token, "POST", `/api/agents/${created.id}/credentials`, {});
  assert.equal(minted.status, 201, JSON.stringify(minted.body));
  const attached = await call(app.baseUrl, web.token, "POST", "/api/computer/attach", { serverSlug: server.slug, name: "laptop" });
  assert.equal(attached.status, 201, JSON.stringify(attached.body));
  // The Computer this sign-in issued the key for is on someone else's machine:
  // the security-revoke cascade still revokes it, by the issuing session.
  const keeper = await seed.human();
  await getDb().update(machines).set({ userId: keeper.id }).where(eq(machines.id, attached.body.machineId as string));
  const agentKeyLive = async () => (await fetch(`${app.baseUrl}/internal/agent-api/`, { headers: { Authorization: `Bearer ${minted.body.apiKey}` } })).status;
  assert.equal(await agentKeyLive(), 200);

  const stopped: string[] = [];
  const orchestrator = app.app.get("agentOrchestrator") as { stopAgent: (agentId: string, reason?: string, options?: { daemonReason?: string }) => Promise<{ delivered: boolean }> };
  const originalStop = orchestrator.stopAgent;
  orchestrator.stopAgent = async (agentId: string, reason?: string, options?: { daemonReason?: string }) => { stopped.push(`${agentId}:${reason}:${options?.daemonReason}`); return { delivered: true }; };
  const emails = captureEmails();
  try {
    const current = await signInForTest(human.id);
    const requested = await call(app.baseUrl, current.token, "POST", DELETION);
    assert.equal(requested.status, 200, JSON.stringify(requested.body));

    // Every sign-in, this one included.
    assert.equal((await call(app.baseUrl, current.token, "GET", DELETION)).status, 401);
    assert.equal((await call(app.baseUrl, web.token, "GET", "/api/auth/me")).status, 401);
    assert.deepEqual(await getDb().select().from(sessions).where(eq(sessions.userId, human.id)), []);
    const families = await getDb().select({ revokedReason: sessionFamilies.revokedReason }).from(sessionFamilies).where(eq(sessionFamilies.userId, human.id));
    assert.ok(families.length >= 2 && families.every((family) => family.revokedReason === "revoke_all"));
    // What the sessions issued.
    assert.equal(await agentKeyLive(), 401);
    const computer = await findComputerByApiKeyWithReason(attached.body.apiKey as string);
    assert.equal(computer.ok ? "live" : computer.reason, "computer_revoked");
    // The agents the person created and their assistant; not someone else's.
    // Told `deleted`, so their `raft proc` jobs end with them.
    assert.deepEqual(stopped.sort(), [`${created.id}:manual:deleted`, `${assistant.id}:manual:deleted`].sort());
    assert.ok(!stopped.some((entry) => entry.startsWith(someoneElses.id)));
    // One email: the deletion's own, not a security-revoke notice too.
    assert.equal(emails.deliveries.length, 1, emails.deliveries.map((mail) => mail.subject).join(" | "));
    assert.match(emails.deliveries[0]!.subject, /will be deleted on/);
    assert.match(emails.deliveries[0]!.text!, /sign in and cancel/);
  } finally {
    emails.stop();
    orchestrator.stopAgent = originalStop;
  }
});

test("a Computer the person attached on someone else's machine: the server's owner is told with the account deletion's own text", async ({ app, seed }) => {
  const owner = await seed.human();
  const human = await seed.human(passwordUser);
  const server = await seed.server({ owner, members: [human] });
  await getDb().update(serverMembers).set({ role: "admin" }).where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, human.id)));
  const web = await signInForTest(human.id);
  const attached = await call(app.baseUrl, web.token, "POST", "/api/computer/attach", { serverSlug: server.slug, name: "borrowed-desk" });
  assert.equal(attached.status, 201, JSON.stringify(attached.body));
  const keeper = await seed.human();
  await getDb().update(machines).set({ userId: keeper.id }).where(eq(machines.id, attached.body.machineId as string));
  const mine = await createAgent(server.id, "desk-agent", { runtime: "external", creatorType: "user", creatorId: human.id });
  await getDb().update(agents).set({ machineId: attached.body.machineId as string }).where(eq(agents.id, mine.id));

  const emails = captureEmails();
  try {
    const requested = await call(app.baseUrl, web.token, "POST", DELETION);
    assert.equal(requested.status, 200, JSON.stringify(requested.body));
  } finally {
    emails.stop();
  }

  const dm = await channelService.findOrCreateDM(server.id, owner.id, mine.id);
  const notices = await getDb().select({ content: messages.content }).from(messages).where(and(eq(messages.channelId, dm!.id), eq(messages.messageType, "system")));
  assert.equal(notices.length, 1, JSON.stringify(notices));
  assert.match(
    notices[0]!.content,
    /^@desk-agent is offline: the computer "borrowed-desk" it runs on was disconnected because the person who set it up is deleting their account\. It stays disconnected even if they cancel\. Someone in this server can set up that machine again \(the agent comes back as it was\), or move the agent to another computer\.\nAgent page: /,
  );
});

// A personal assistant is never on a Computer (agents_assistant_not_on_machine), so a blocker's owner is its creator.
test("a blocker's owner is null once its creator left the agent's server", async ({ app, seed }) => {
  const { human, server, laptop } = await seedSharedComputers(seed);
  const creatorLeaver = await seed.human({ name: "CreatorLeaver" });
  await getDb().insert(serverMembers).values({ serverId: server.id, userId: creatorLeaver.id, role: "member" });
  const leftCreator = await createAgent(server.id, "made-by-leaver", { runtime: "external", creatorType: "user", creatorId: creatorLeaver.id });
  await getDb().update(agents).set({ machineId: laptop.id }).where(eq(agents.id, leftCreator.id));
  await getDb().delete(serverMembers).where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, creatorLeaver.id)));
  const session = await signInForTest(human.id);

  const overview = await call(app.baseUrl, session.token, "GET", DELETION);
  const listed = new Map((overview.body.computers[0].agents as Array<Record<string, any>>).map((agent) => [agent.id, agent]));
  assert.deepEqual([listed.get(leftCreator.id)?.owner, listed.get(leftCreator.id)?.personalAssistant], [null, false]);

  const notify = await call(app.baseUrl, session.token, "POST", `${DELETION}/notify-agent-owners`, { agentIds: [leftCreator.id] });
  assert.equal(notify.status, 200, JSON.stringify(notify.body));
  assert.deepEqual(notify.body.notified, []);
  assert.deepEqual(notify.body.skipped, [{ agentId: leftCreator.id, reason: "no_owner" }]);
});

test("forceAgentIds naming every blocker: they are unbound and stopped (not deleted), one audit record per server on its audit, their owners told; stale ids ignored", async ({ app, seed }) => {
  const { human, colleague, server, laptop, theirBox } = await seedSharedComputers(seed);
  const alpha = await createAgent(server.id, "alpha", { runtime: "external", creatorType: "user", creatorId: colleague.id });
  const byAgent = await createAgent(server.id, "by-agent", { runtime: "external", creatorType: "agent", creatorId: alpha.id });
  const moved = await createAgent(server.id, "moved", { runtime: "external", creatorType: "user", creatorId: colleague.id });
  await getDb().update(agents).set({ machineId: laptop.id, status: "active" }).where(inArray(agents.id, [alpha.id, byAgent.id]));
  // A second server, where the colleague is an owner too, with the person's desktop and the colleague's agent on it.
  const work = await seed.server({ owner: human, members: [colleague], name: "Work" });
  await getDb().update(serverMembers).set({ role: "owner" }).where(and(eq(serverMembers.serverId, work.id), eq(serverMembers.userId, colleague.id)));
  const desktop = await seedMachine(work.id, human.id, "desktop", "live");
  const gamma = await createAgent(work.id, "gamma", { runtime: "external", creatorType: "user", creatorId: colleague.id });
  await getDb().update(agents).set({ machineId: desktop.id, status: "active" }).where(eq(agents.id, gamma.id));
  await getDb().update(agents).set({ machineId: theirBox.id, status: "active" }).where(eq(agents.id, moved.id));
  const session = await signInForTest(human.id);

  for (const forceAgentIds of ["x", [1], [""], Array.from({ length: 201 }, () => randomUUID())]) {
    const refused = await call(app.baseUrl, session.token, "POST", DELETION, { forceAgentIds });
    assert.equal(refused.status, 400, JSON.stringify(forceAgentIds).slice(0, 60));
    assert.equal(refused.body.code, "invalid_force_agent_ids");
  }

  const requested = await call(app.baseUrl, session.token, "POST", DELETION, { forceAgentIds: [alpha.id, byAgent.id, gamma.id, moved.id, randomUUID()] });
  assert.equal(requested.status, 200, JSON.stringify(requested.body));
  assert.equal((await requestRows(human.id)).length, 1);
  const rows = await getDb().select({ id: agents.id, machineId: agents.machineId, status: agents.status, deletedAt: agents.deletedAt }).from(agents)
    .where(inArray(agents.id, [alpha.id, byAgent.id, gamma.id, moved.id]));
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const id of [alpha.id, byAgent.id, gamma.id]) assert.deepEqual(byId.get(id), { id, machineId: null, status: "stopped", deletedAt: null }, "unbound and stopped, not deleted");
  assert.deepEqual(byId.get(moved.id), { id: moved.id, machineId: theirBox.id, status: "active", deletedAt: null }, "no longer blocking: untouched");
  const [laptopKey] = await getDb().select({ revokedAt: computers.revokedAt }).from(computers).where(eq(computers.machineId, laptop.id));
  assert.ok(laptopKey!.revokedAt);
  // Unbound by force: the next Computer that comes online does not take them (Tenny, PR #12858); a
  // Computer-runtime agent the person forced off stays unbound, one nobody forced is auto-assigned.
  const loose = await createAgent(server.id, "loose", { runtime: "external", creatorType: "user", creatorId: colleague.id });
  await getDb().update(agents).set({ runtime: "claude" }).where(inArray(agents.id, [alpha.id, loose.id]));
  await getDb().update(agents).set({ machineId: null }).where(eq(agents.id, loose.id));
  await autoAssignMachine(server.id, theirBox.id);
  const placed = await getDb().select({ id: agents.id, machineId: agents.machineId }).from(agents).where(inArray(agents.id, [alpha.id, loose.id]));
  assert.deepEqual(new Map(placed.map((row) => [row.id, row.machineId])), new Map([[alpha.id, null], [loose.id, theirBox.id]]));
  const [marked] = await getDb().select({ reason: agents.machineReleaseReason, at: agents.machineReleasedAt }).from(agents).where(eq(agents.id, gamma.id));
  assert.equal(marked!.reason, "forced_by_computer_owner");
  assert.ok(marked!.at);

  const audits = await getDb().select().from(integrationAuditEvents).where(eq(integrationAuditEvents.eventType, "account.deletion_unbound_others_agents"));
  // One per server, written with that server's id (its owners and admins see it), naming only its own agents.
  const mine = audits.filter((row) => row.requesterId === human.id);
  assert.equal(mine.length, 2);
  const home = mine.find((row) => row.serverId === server.id)!;
  const other = mine.find((row) => row.serverId === work.id)!;
  for (const row of [home, other]) {
    assert.equal(row.actorId, human.id);
    assert.equal(row.eventCategory, "computer");
  }
  assert.deepEqual({ ...home.metadata, agentIds: [...(home.metadata.agentIds as string[])].sort() }, {
    agentIds: [alpha.id, byAgent.id].sort(), machineIds: [laptop.id],
  });
  assert.deepEqual(other.metadata, { agentIds: [gamma.id], machineIds: [desktop.id] });

  // Alpha's owner is told, as when a Computer is detached; nothing about the person. by-agent has nobody to tell.
  const dm = await channelService.findOrCreateDM(server.id, colleague.id, alpha.id);
  const notices = await getDb().select({ content: messages.content }).from(messages).where(and(eq(messages.channelId, dm!.id), eq(messages.messageType, "system")));
  assert.equal(notices.length, 1);
  assert.match(notices[0]!.content, /@alpha is offline: the computer "laptop" it runs on was detached/);
  for (const secret of [human.email, human.name, human.displayName!]) assert.ok(!notices[0]!.content.includes(secret), "nothing about the person");
});

test("forceAgentIds missing a blocker: 409 with the fresh list, nothing unbound, revoked or audited", async ({ app, seed }) => {
  const { human, colleague, server, laptop } = await seedSharedComputers(seed);
  const alpha = await createAgent(server.id, "alpha", { runtime: "external", creatorType: "user", creatorId: colleague.id });
  const beta = await createAgent(server.id, "beta", { runtime: "external", creatorType: "user", creatorId: colleague.id });
  await getDb().update(agents).set({ machineId: laptop.id }).where(inArray(agents.id, [alpha.id, beta.id]));
  const session = await signInForTest(human.id);

  const conflict = await call(app.baseUrl, session.token, "POST", DELETION, { forceAgentIds: [alpha.id] });
  assert.equal(conflict.status, 409, JSON.stringify(conflict.body));
  assert.equal(conflict.body.code, "others_agents_on_computers");
  assert.deepEqual(conflict.body.agents.map((agent: { id: string }) => agent.id), [alpha.id, beta.id]);
  // Under the lock too.
  const outcome = await requestAccountDeletion({ userId: human.id, source: "self", actorUserId: human.id, forceAgentIds: [alpha.id] });
  assert.equal(outcome.kind === "conflict" ? outcome.code : outcome.kind, "others_agents_on_computers");

  assert.deepEqual(await requestRows(human.id), []);
  const bound = await getDb().select({ machineId: agents.machineId }).from(agents).where(inArray(agents.id, [alpha.id, beta.id]));
  assert.deepEqual(bound.map((row) => row.machineId), [laptop.id, laptop.id]);
  const [laptopKey] = await getDb().select({ revokedAt: computers.revokedAt }).from(computers).where(eq(computers.machineId, laptop.id));
  assert.equal(laptopKey!.revokedAt, null);
  const audits = await getDb().select({ id: integrationAuditEvents.id }).from(integrationAuditEvents)
    .where(and(eq(integrationAuditEvents.eventType, "account.deletion_unbound_others_agents"), eq(integrationAuditEvents.requesterId, human.id)));
  assert.deepEqual(audits, []);
});

test("pending: signing in works, but only the deletion's status, cancel and logout are reachable; cancelling restores everything", async ({ app, seed }) => {
  const human = await seed.human(passwordUser);
  const server = await seed.server({ owner: human });
  const first = await signInForTest(human.id);
  const requested = await call(app.baseUrl, first.token, "POST", DELETION);
  assert.equal(requested.status, 200);
  const scheduledFor = requested.body.scheduledFor as string;

  const emails = captureEmails();
  try {
    // The sign-in itself says the deletion is scheduled, so the web needs no probe.
    const login = await call(app.baseUrl, null, "POST", "/api/auth/login", { email: human.email, password: "password123" });
    assert.equal(login.status, 200);
    assert.deepEqual(login.body.accountDeletion, { status: "scheduled", scheduledFor });
    const token = login.body.accessToken as string;
    for (const [method, path] of [["GET", "/api/auth/me"], ["GET", "/api/servers"], ["GET", "/api/me/notification-settings"], ["POST", DELETION], ["POST", `${DELETION}/email-code`], ["POST", "/api/auth/device/approve"], ["POST", "/api/computer/attach"]] as const) {
      const refused = await call(app.baseUrl, token, method, path, method === "POST" ? { userCode: "ABCD-EFGH", serverSlug: server.slug } : undefined);
      assert.equal(refused.status, 403, `${method} ${path}`);
      assert.deepEqual(refused.body, {
        error: "This account is scheduled for deletion. Cancel the deletion to use it again.",
        code: "account_deletion_pending",
        scheduledFor,
      }, `${method} ${path}`);
    }
    // Sockets and other token checks see no session at all.
    assert.equal(await verifyActiveAccessToken(token), null);

    const status = await call(app.baseUrl, token, "GET", DELETION);
    assert.deepEqual(status, { status: 200, body: { status: "scheduled", requestId: requested.body.requestId, requestedAt: requested.body.requestedAt, scheduledFor, soleOwnerServers: [], soleMemberServers: [{ id: server.id, name: server.name, slug: server.slug }], paidServersEndingAtPeriodEnd: [], agents: [], computers: [], graceDays: 7 } });

    // Logout needs no access token and works as before.
    const other = await call(app.baseUrl, null, "POST", "/api/auth/login", { email: human.email, password: "password123" });
    assert.equal(other.status, 200);
    assert.deepEqual(await call(app.baseUrl, null, "POST", "/api/auth/logout", { refreshToken: other.body.refreshToken }), { status: 200, body: { ok: true } });

    const cancelled = await call(app.baseUrl, token, "DELETE", DELETION);
    assert.deepEqual(cancelled, { status: 200, body: { status: "none", requestId: requested.body.requestId, subscriptionRestoration: "restored" } });
    const [row] = await requestRows(human.id);
    assert.equal(row?.state, "cancelled");
    assert.ok(row?.cancelledAt);
    assert.equal(emails.deliveries.length, 1);
    assert.match(emails.deliveries[0]!.subject, /will not be deleted/);

    // The same sign-in is a normal one again.
    assert.equal((await call(app.baseUrl, token, "GET", "/api/auth/me")).status, 200);
    assert.equal((await call(app.baseUrl, token, "GET", "/api/servers")).status, 200);
    assert.equal((await verifyActiveAccessToken(token))?.sub, human.id);
    assert.deepEqual(await call(app.baseUrl, token, "GET", DELETION), { status: 200, body: { status: "none", soleOwnerServers: [], soleMemberServers: [{ id: server.id, name: server.name, slug: server.slug }], paidServersEndingAtPeriodEnd: [], agents: [], computers: [], graceDays: 7 } });
    // Cancelling again: nothing to cancel, no email.
    assert.deepEqual(await call(app.baseUrl, token, "DELETE", DELETION), { status: 200, body: { status: "none" } });
    assert.equal(emails.deliveries.length, 1);
  } finally {
    emails.stop();
  }
});

test("requesting twice answers the same pending request and revokes nothing more", async ({ seed }) => {
  const human = await seed.human(passwordUser);
  const emails = captureEmails();
  try {
    const first = await requestAccountDeletion({ userId: human.id, source: "self", actorUserId: human.id });
    assert.equal(first.kind, "scheduled");
    const later = await signInForTest(human.id);
    const second = await requestAccountDeletion({ userId: human.id, source: "self", actorUserId: human.id });
    assert.equal(second.kind, "scheduled");
    assert.equal(first.kind === "scheduled" && second.kind === "scheduled" && first.request.id === second.request.id, true);
    assert.equal(second.kind === "scheduled" && second.effects, null);
    assert.equal((await requestRows(human.id)).length, 1);
    // The sign-in made in between is not signed out by the repeat.
    const [family] = await getDb().select({ revokedAt: sessionFamilies.revokedAt }).from(sessionFamilies).where(eq(sessionFamilies.id, later.familyId));
    assert.equal(family?.revokedAt, null);
    assert.equal(emails.deliveries.length, 1);
  } finally {
    emails.stop();
  }
});

test("subscriptions set to cancel at period end, after commit: servers only the person is in, and shared servers they pay for; GET and the email list the shared ones", async ({ app, seed }) => {
  const human = await seed.human(passwordUser);
  const coOwner = await seed.human();
  const alone = await seed.server({ owner: human, name: "Alone" });
  const shared = await seed.server({ owner: human, members: [coOwner], name: "Shared" });
  await getDb().update(serverMembers).set({ role: "owner" }).where(and(eq(serverMembers.serverId, shared.id), eq(serverMembers.userId, coOwner.id)));
  // Someone else's server the person paid for (they checked out as an admin).
  const theirs = await seed.server({ owner: coOwner, members: [human], name: "Paid by them" });
  // A shared server someone else pays for: untouched.
  const paidByOther = await seed.server({ owner: human, members: [coOwner], name: "Paid by other" });
  await getDb().update(serverMembers).set({ role: "owner" }).where(and(eq(serverMembers.serverId, paidByOther.id), eq(serverMembers.userId, coOwner.id)));
  const periodEnd = new Date("2026-12-01T00:00:00Z");
  for (const [server, payer] of [[alone, human], [shared, human], [theirs, human], [paidByOther, coOwner]] as const) {
    await getDb().insert(subscriptions).values({ serverId: server.id, stripeCustomerId: `cus_${server.id}`, stripeSubscriptionId: `sub_${server.id}`, status: "active", createdByUserId: payer.id, currentPeriodEnd: periodEnd });
  }
  const session = await signInForTest(human.id);
  const before = await call(app.baseUrl, session.token, "GET", DELETION);
  assert.deepEqual(before.body.paidServersEndingAtPeriodEnd, [
    { id: theirs.id, name: "Paid by them", slug: theirs.slug, periodEnd: periodEnd.toISOString() },
    { id: shared.id, name: "Shared", slug: shared.slug, periodEnd: periodEnd.toISOString() },
  ]);
  assert.deepEqual(before.body.soleOwnerServers, []);

  const cancelled: string[] = [];
  const emails = captureEmails();
  try {
    const outcome = await requestAccountDeletion({ userId: human.id, source: "self", actorUserId: human.id }, {
      cancelSubscriptionAtPeriodEnd: async (serverId, userId) => {
        // After commit: the request is already visible outside the transaction.
        assert.equal((await requestRows(userId)).length, 1);
        cancelled.push(serverId);
        return { stripeSubscriptionId: `sub_${serverId}`, canceledAt: 100 };
      },
    });
    assert.equal(outcome.kind, "scheduled");
  } finally {
    emails.stop();
  }
  assert.deepEqual(cancelled.sort(), [alone.id, shared.id, theirs.id].sort());
  const requested = emails.deliveries.find((d) => /will be deleted/.test(d.subject));
  assert.match(requested?.text ?? "", /You pay for Shared: its subscription was scheduled to end with the current period/);
  assert.match(requested?.text ?? "", /You pay for Paid by them/);
  assert.doesNotMatch(requested?.text ?? "", /Paid by other/);
});

test("cancelling resumes only the subscriptions the request set to cancel; a provider failure is reported as unknown in the email", async ({ seed }) => {
  const human = await seed.human(passwordUser);
  const coOwner = await seed.human();
  const alone = await seed.server({ owner: human, name: "Alone" });
  const shared = await seed.server({ owner: human, members: [coOwner], name: "Shared" });
  await getDb().update(serverMembers).set({ role: "owner" }).where(and(eq(serverMembers.serverId, shared.id), eq(serverMembers.userId, coOwner.id)));
  const already = await seed.server({ owner: human, members: [coOwner], name: "Already cancelled" });
  await getDb().update(serverMembers).set({ role: "owner" }).where(and(eq(serverMembers.serverId, already.id), eq(serverMembers.userId, coOwner.id)));
  for (const [server, cancelAtPeriodEnd] of [[alone, false], [shared, false], [already, true]] as const) {
    await getDb().insert(subscriptions).values({ serverId: server.id, stripeCustomerId: `cus_${server.id}`, stripeSubscriptionId: `sub_${server.id}`, status: "active", createdByUserId: human.id, cancelAtPeriodEnd });
  }
  const outcome = await requestAccountDeletion({ userId: human.id, source: "self", actorUserId: human.id }, { cancelSubscriptionAtPeriodEnd: async (serverId, _userId, stripeSubscriptionId) => serverId === already.id ? null : ({ stripeSubscriptionId, canceledAt: 100 }) });
  assert.equal(outcome.kind, "scheduled");
  const [row] = await requestRows(human.id);
  assert.deepEqual(Object.keys(row!.cancelledSubscriptionSnapshots ?? {}).sort(), [alone.id, shared.id, already.id].sort(), "every candidate is checked against the provider even when the projection says cancelled");
  assert.deepEqual(row!.cancelledSubscriptionServerIds, [], "an old backend must not resume a new request by Server id");
  assert.equal(row!.cancelledSubscriptionSnapshots?.[alone.id]?.canceledAt, 100, "the provider response was persisted");

  const resumed: string[] = [];
  const emails = captureEmails();
  try {
    await cancelAccountDeletion({ userId: human.id }, {
      resumeSubscription: async (serverId, _userId, snapshot) => {
        if (serverId === already.id) { assert.equal(snapshot?.canceledAt, null); return "not_restored"; }
        assert.deepEqual(snapshot, { stripeSubscriptionId: `sub_${serverId}`, canceledAt: 100 });
        if (serverId === shared.id) throw new Error("stripe down");
        resumed.push(serverId);
        return "restored" as const;
      },
    });
  } finally {
    emails.stop();
  }
  assert.deepEqual(resumed, [alone.id]);
  const notice = emails.deliveries.find((d) => /will not be deleted/.test(d.subject));
  assert.match(notice?.text ?? "", /could not confirm your subscription/);
  assert.doesNotMatch(notice?.text ?? "", /Alone/);
  assert.match(notice?.text ?? "", /Already cancelled was not automatically restored/);
});

test("password in the request: re-authenticates in the same call; wrong ones count toward the re-authentication lock", async ({ app, seed }) => {
  const human = await seed.human(passwordUser);
  const session = await staleSession(human.id);

  const wrong = await call(app.baseUrl, session.token, "POST", DELETION, { password: "not-the-password" });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.code, "password_incorrect");
  assert.equal((await getDb().select().from(reauthAttemptWindows).where(eq(reauthAttemptWindows.userId, human.id)))[0]?.attempts, 1);
  assert.deepEqual(await requestRows(human.id), []);

  const right = await call(app.baseUrl, session.token, "POST", DELETION, { password: "password123" });
  assert.equal(right.status, 200, JSON.stringify(right.body));
  assert.equal(right.body.status, "scheduled");
  // The right one gave its claim back; the wrong one stays counted.
  assert.equal((await getDb().select().from(reauthAttemptWindows).where(eq(reauthAttemptWindows.userId, human.id)))[0]?.attempts, 1);
});

test("password in the request: enough wrong ones lock re-authentication, and then even the right one is refused", async ({ app, seed }) => {
  const human = await seed.human(passwordUser);
  const session = await staleSession(human.id);
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const wrong = await call(app.baseUrl, session.token, "POST", DELETION, { password: `wrong-${attempt}` });
    assert.equal(wrong.status, 401, `attempt ${attempt}`);
  }
  const locked = await call(app.baseUrl, session.token, "POST", DELETION, { password: "wrong-11" });
  assert.equal(locked.status, 429);
  assert.equal(locked.body.code, "reauth_locked");
  assert.ok(locked.body.lockedUntil);
  const right = await call(app.baseUrl, session.token, "POST", DELETION, { password: "password123" });
  assert.equal(right.status, 429);
  assert.equal(right.body.code, "reauth_locked");
  assert.deepEqual(await requestRows(human.id), []);
  // Still signed in: nothing was revoked.
  assert.equal((await call(app.baseUrl, session.token, "GET", "/api/auth/me")).status, 200);
});

test("account deletion is open to everyone: a leftover account_deletion_v0 row, even off, does not hide the routes", async ({ app, seed }) => {
  await seedRetiredDeletionFlag(false);
  const person = await seed.human(passwordUser);
  const session = await signInForTest(person.id);
  const status = await call(app.baseUrl, session.token, "GET", DELETION);
  assert.equal(status.status, 200);
  assert.equal(status.body.status, "none");
});

test("asking revokes every key of the person, however issued, and fails a move to or from their Computers; not a provider-held key", async ({ seed }) => {
  const human = await seed.human(passwordUser);
  const colleague = await seed.human();
  const server = await seed.server({ owner: colleague, members: [human], name: "Shared" });
  const db = getDb();
  const laptop = await seedMachine(server.id, human.id, "laptop", "live");
  const legacy = await seedMachine(server.id, human.id, "legacy-box");
  const desk = await seedMachine(server.id, colleague.id, "desk", "live");
  const mine = await createAgent(server.id, "mine", { runtime: "external", creatorType: "user", creatorId: human.id });
  const theirs = await createAgent(server.id, "theirs", { runtime: "external", creatorType: "user", creatorId: colleague.id });
  const hosted = await createAgent(server.id, "hosted-mine", { runtime: "external", creatorType: "user", creatorId: human.id });
  const credential = async (agentId: string, createdByUserId: string | null) => (await db.insert(agentCredentials).values({
    agentId, apiKeyHash: `h-${randomUUID()}`, apiKeyPrefix: `sk_agent_${randomUUID().slice(0, 6)}`, scopes: ["send"], createdByUserId,
  } as typeof agentCredentials.$inferInsert).returning({ id: agentCredentials.id }))[0]!.id;
  const minesKey = await credential(mine.id, null);
  const madeForTheirs = await credential(theirs.id, human.id);
  const theirsOwnKey = await credential(theirs.id, colleague.id);
  const providerKey = await credential(hosted.id, human.id);
  // Both conditions (their agent, made by them): revoked once.
  const bothKey = await credential(mine.id, human.id);
  // Revoked before: keeps its own revocation.
  const earlier = new Date("2026-01-01T00:00:00Z");
  const alreadyRevoked = await credential(mine.id, human.id);
  await db.update(agentCredentials).set({ revokedAt: earlier, revokedReason: "rotated" }).where(eq(agentCredentials.id, alreadyRevoked));
  await db.insert(agentRuntimeProvisions).values({
    agentId: hosted.id, serverId: server.id, provider: "antiproton", state: "active", credentialId: providerKey,
    provisionedName: "hosted-mine", provisionedInstructions: "",
  } as typeof agentRuntimeProvisions.$inferInsert);
  // The receipt surface the migration service creates: a DM with only the agent in it.
  const [receiptChannel] = await db.insert(channels).values({ serverId: server.id, name: `migration-receipt-${randomUUID()}`, type: "dm" }).returning();
  await db.insert(channelAgents).values({ channelId: receiptChannel!.id, agentId: theirs.id, addedAt: new Date() });
  const deadline = new Date(Date.now() + 3_600_000);
  const [move] = await db.insert(agentMigrations).values({
    serverId: server.id, agentId: theirs.id, sourceMachineId: laptop.id, targetMachineId: desk.id, state: "in_transit",
    contractVersion: 2, grantKey: `deletion-test:${randomUUID()}`, prepDeadlineAt: deadline, transferDeadlineAt: deadline,
    arrivalDeadlineAt: deadline, sourceMachineNameSnapshot: "laptop", targetMachineNameSnapshot: "desk", initiatedByUserId: colleague.id,
    receiptChannelId: receiptChannel!.id,
  } as typeof agentMigrations.$inferInsert).returning();
  await db.insert(agentMigrationReceiptChannels).values({ channelId: receiptChannel!.id, migrationId: move!.id, serverId: server.id, agentId: theirs.id, createdAt: new Date() });

  const outcome = await requestAccountDeletion({ userId: human.id, source: "self", actorUserId: human.id });
  assert.equal(outcome.kind, "scheduled");

  const [laptopKey] = await db.select({ revokedAt: computers.revokedAt }).from(computers).where(eq(computers.machineId, laptop.id));
  assert.ok(laptopKey!.revokedAt, "their Computer's key");
  const [legacyRow] = await db.select({ apiKeyHash: machines.apiKeyHash }).from(machines).where(eq(machines.id, legacy.id));
  assert.match(legacyRow!.apiKeyHash, /^revoked:/, "their legacy machine key");
  const [deskKey] = await db.select({ revokedAt: computers.revokedAt }).from(computers).where(eq(computers.machineId, desk.id));
  assert.equal(deskKey!.revokedAt, null, "not someone else's Computer");
  const revokedAt = async (id: string) => (await db.select({ revokedAt: agentCredentials.revokedAt }).from(agentCredentials).where(eq(agentCredentials.id, id)))[0]!.revokedAt;
  assert.ok(await revokedAt(minesKey), "their agent's key");
  assert.ok(await revokedAt(madeForTheirs), "a key they made for someone else's agent");
  assert.equal(await revokedAt(theirsOwnKey), null, "not the colleague's own key");
  assert.equal(await revokedAt(providerKey), null, "not a provider-held key");
  assert.ok(await revokedAt(bothKey), "a key matching both conditions");
  assert.deepEqual(await revokedAt(alreadyRevoked), earlier, "an earlier revocation is kept");
  const [failedMove] = await db.select({ state: agentMigrations.state, failureReason: agentMigrations.failureReason }).from(agentMigrations).where(eq(agentMigrations.id, move!.id));
  assert.deepEqual(failedMove, { state: "failed", failureReason: "MIGRATION_COMPUTER_OWNER_DELETED" });
});

/** A Computer row on `machine`, attached by `attachedByUserId`, with a runner credential that machine minted. */
async function seedAttachedComputer(serverId: string, machineId: string, attachedByUserId: string, agentId: string) {
  const db = getDb();
  const [computer] = await db.insert(computers).values({
    serverId, name: `computer-${randomUUID().slice(0, 6)}`, machineId, apiKeyHash: `h-${randomUUID()}`, apiKeyPrefix: `sk_computer_${randomUUID().slice(0, 8)}`,
    attachedByUserId,
  }).returning({ id: computers.id });
  const [credential] = await db.insert(agentCredentials).values({
    agentId, apiKeyHash: `h-${randomUUID()}`, apiKeyPrefix: `sk_agent_${randomUUID().slice(0, 6)}`, scopes: ["send"], issuedByMachineId: machineId,
  } as typeof agentCredentials.$inferInsert).returning({ id: agentCredentials.id });
  return { computerId: computer!.id, credentialId: credential!.id };
}

test("asking revokes every Computer the person attached, on any server and anyone's machine, audited as leaving; and every Computer on their own machines; not another member's; cancelling restores none", async ({ seed }) => {
  const human = await seed.human(passwordUser);
  const colleague = await seed.human();
  const bystander = await seed.human();
  const shared = await seed.server({ owner: colleague, members: [human, bystander], name: "Shared" });
  const other = await seed.server({ owner: colleague, members: [human], name: "Other" });
  const db = getDb();
  const runner = await createAgent(shared.id, "runner", { runtime: "external", creatorType: "user", creatorId: colleague.id });
  const otherRunner = await createAgent(other.id, "other-runner", { runtime: "external", creatorType: "user", creatorId: colleague.id });
  // The colleague's machines; the person attached a Computer on one here and one on the other server.
  const desk = await seedMachine(shared.id, colleague.id, "desk");
  const otherDesk = await seedMachine(other.id, colleague.id, "other-desk");
  const borrowed = await seedAttachedComputer(shared.id, desk.id, human.id, runner.id);
  const borrowedElsewhere = await seedAttachedComputer(other.id, otherDesk.id, human.id, otherRunner.id);
  // The person's machine, which the colleague attached: the machine is deleted with the account.
  const lentBox = await seedMachine(shared.id, human.id, "lent-box");
  const lent = await seedAttachedComputer(shared.id, lentBox.id, colleague.id, runner.id);
  // Another member's own Computer on their own machine.
  const bystanderBox = await seedMachine(shared.id, bystander.id, "bystander-box");
  const untouched = await seedAttachedComputer(shared.id, bystanderBox.id, bystander.id, runner.id);

  const told: Array<{ computers: unknown; actorUserId: string }> = [];
  const outcome = await requestAccountDeletion({ userId: human.id, source: "self", actorUserId: human.id }, {
    noticeDetachedComputers: async (detached, actorUserId) => { told.push({ computers: detached, actorUserId }); },
  });
  assert.equal(outcome.kind, "scheduled");
  const [request] = await requestRows(human.id);

  const computerRow = async (id: string) => (await db.select({ revokedAt: computers.revokedAt, revokedByUserId: computers.revokedByUserId }).from(computers).where(eq(computers.id, id)))[0]!;
  const credentialRevokedAt = async (id: string) => (await db.select({ revokedAt: agentCredentials.revokedAt }).from(agentCredentials).where(eq(agentCredentials.id, id)))[0]!.revokedAt;
  for (const [what, computer] of [["on someone else's machine", borrowed], ["on another server", borrowedElsewhere], ["on their machine, attached by someone else", lent]] as const) {
    assert.equal((await computerRow(computer.computerId)).revokedAt?.getTime(), request!.requestedAt.getTime(), `${what}: revoked with the request`);
    assert.ok(await credentialRevokedAt(computer.credentialId), `${what}: what its machine minted is revoked`);
  }
  assert.equal((await computerRow(borrowed.computerId)).revokedByUserId, human.id);
  assert.equal((await computerRow(untouched.computerId)).revokedAt, null, "another member's Computer is untouched");
  assert.equal(await credentialRevokedAt(untouched.credentialId), null);

  const audit = async (eventType: string, targetId: string) => db.select({
    source: integrationAuditEvents.source, actorType: integrationAuditEvents.actorType, actorId: integrationAuditEvents.actorId,
    requesterId: integrationAuditEvents.requesterId, serverId: integrationAuditEvents.serverId, metadata: integrationAuditEvents.metadata,
  }).from(integrationAuditEvents).where(and(eq(integrationAuditEvents.eventType, eventType), eq(integrationAuditEvents.targetId, targetId)));
  const [borrowedAudit, ...extraBorrowed] = await audit("computer.key_revoked", borrowed.computerId);
  assert.deepEqual(extraBorrowed, []);
  assert.deepEqual(
    { source: borrowedAudit!.source, actorType: borrowedAudit!.actorType, actorId: borrowedAudit!.actorId, requesterId: borrowedAudit!.requesterId, serverId: borrowedAudit!.serverId, via: borrowedAudit!.metadata.via, departureReason: borrowedAudit!.metadata.departureReason, revokedCount: borrowedAudit!.metadata.revokedCount },
    { source: "web", actorType: "human", actorId: human.id, requesterId: human.id, serverId: shared.id, via: "member_removed", departureReason: "account_deleted", revokedCount: 1 },
  );
  const [elsewhereAudit] = await audit("computer.key_revoked", borrowedElsewhere.computerId);
  assert.deepEqual({ serverId: elsewhereAudit!.serverId, departureReason: elsewhereAudit!.metadata.departureReason }, { serverId: other.id, departureReason: "account_deleted" });
  assert.ok(borrowedAudit!.metadata.operationId, "one operation for the request");
  assert.equal(elsewhereAudit!.metadata.operationId, borrowedAudit!.metadata.operationId);
  const [credentialAudit] = await audit("agent_credential.revoked", borrowed.credentialId);
  assert.deepEqual({ via: credentialAudit!.metadata.via, departureReason: credentialAudit!.metadata.departureReason }, { via: "member_removed", departureReason: "account_deleted" });
  const [lentAudit] = await audit("computer.key_revoked", lent.computerId);
  assert.deepEqual(
    { actorType: lentAudit!.actorType, requesterId: lentAudit!.requesterId, via: lentAudit!.metadata.via, trigger: lentAudit!.metadata.trigger, departureReason: lentAudit!.metadata.departureReason },
    { actorType: "system", requesterId: colleague.id, via: "web_session_revoked", trigger: "account_deletion_requested", departureReason: undefined },
  );
  assert.deepEqual(await audit("computer.key_revoked", untouched.computerId), []);

  // The owners of the agents on the Computers revoked on someone else's machine are told; not for the person's own machine.
  assert.equal(told.length, 1);
  assert.equal(told[0]!.actorUserId, human.id);
  const toldOf = (told[0]!.computers as Array<{ machineId: string; serverId: string }>).map((c) => `${c.serverId}:${c.machineId}`).sort();
  assert.deepEqual(toldOf, [`${shared.id}:${desk.id}`, `${other.id}:${otherDesk.id}`].sort());

  // Cancelling brings none of them back: the person reattaches.
  assert.deepEqual(await cancelAccountDeletion({ userId: human.id }), { cancelled: true, requestId: request!.id, subscriptionRestoration: "restored" });
  assert.ok((await computerRow(borrowed.computerId)).revokedAt);
  assert.ok((await computerRow(lent.computerId)).revokedAt);
  assert.equal((await computerRow(untouched.computerId)).revokedAt, null);
});


test("a new deletion without cancellation proof never uses legacy ids; undo succeeds and tells the person", async ({ app, seed }) => {
  const human = await seed.human(passwordUser);
  const server = await seed.server({ owner: human, name: "Not restored" });
  await getDb().insert(subscriptions).values({ serverId: server.id, stripeCustomerId: "cus_missing_proof", stripeSubscriptionId: "sub_missing_proof", status: "active", createdByUserId: human.id });
  await requestAccountDeletion({ userId: human.id, source: "self", actorUserId: human.id }, { cancelSubscriptionAtPeriodEnd: async () => null });
  // Even when an old carrier is present, a new request's unconfirmed snapshot is not legacy.
  await getDb().update(accountDeletionRequests).set({ cancelledSubscriptionServerIds: [server.id] }).where(eq(accountDeletionRequests.userId, human.id));
  const session = await signInForTest(human.id);
  const emails = captureEmails();
  try {
    const pending = await call(app.baseUrl, session.token, "GET", DELETION);
    assert.equal(pending.body.status, "scheduled");
    assert.equal(pending.body.subscriptionCancellationUnconfirmed, true, "a lost or failed provider response remains visible from its stored incomplete proof");
    const result = await call(app.baseUrl, session.token, "DELETE", DELETION);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { status: "none", subscriptionNotResumed: true, requestId: (await requestRows(human.id))[0].id, subscriptionRestoration: "not_restored" });
    assert.equal((await requestRows(human.id))[0]?.state, "cancelled");
    assert.match(emails.deliveries.at(-1)?.text ?? "", /was not automatically restored/);
  } finally { emails.stop(); }
});

test("legacy deletion records explicitly use the guarded legacy resume branch", async ({ seed }) => {
  const human = await seed.human(passwordUser);
  const server = await seed.server({ owner: human });
  await getDb().insert(accountDeletionRequests).values({ userId: human.id, source: "self", actorUserId: human.id,
    requestedAt: new Date(), scheduledFor: new Date(Date.now() + 86400_000), state: "pending", cancelledSubscriptionServerIds: [server.id] });
  const calls: string[] = [];
  assert.deepEqual(await cancelAccountDeletion({ userId: human.id }, { resumeSubscription: async (id, userId, snapshot) => {
    assert.equal(userId, human.id); assert.equal(snapshot, undefined); calls.push(id); return "restored" as const;
  } }), { cancelled: true, requestId: (await requestRows(human.id))[0].id, subscriptionRestoration: "restored" });
  assert.deepEqual(calls, [server.id]);
});

test("a cancellation response arriving after deletion undo is bound and compensated, with no late requested email", async ({ seed }) => {
  const human = await seed.human(passwordUser);
  const server = await seed.server({ owner: human });
  await getDb().insert(subscriptions).values({ serverId: server.id, stripeCustomerId: "cus_late", stripeSubscriptionId: "sub_late", status: "active", createdByUserId: human.id });
  const outcome = await getDb().transaction(tx => requestAccountDeletionInTransaction(tx, { userId: human.id, source: "self", actorUserId: human.id }));
  assert.equal(outcome.kind, "scheduled");
  if (outcome.kind !== "scheduled" || !outcome.effects) assert.fail("new request has effects");
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const resumed: string[] = []; const emails = captureEmails();
  const effects = runAccountDeletionRequestedEffects(outcome.effects, {
    cancelSubscriptionAtPeriodEnd: async (_id, _user, stripeSubscriptionId) => { entered(); await gate; return { stripeSubscriptionId, canceledAt: 123 }; },
    resumeSubscription: async (id, userId, snapshot) => { assert.equal(userId, human.id); assert.deepEqual(snapshot, { stripeSubscriptionId: "sub_late", canceledAt: 123 }); resumed.push(id); return "restored" as const; },
  });
  try {
    await started;
    const cancelled = await cancelAccountDeletion({ userId: human.id }, { resumeSubscription: async () => "not_restored" as const });
    assert.deepEqual(cancelled, { cancelled: true, requestId: outcome.request.id, subscriptionNotResumed: true, subscriptionRestoration: "not_restored" });
    release(); await effects;
    const [row] = await requestRows(human.id);
    assert.equal(row.state, "cancelled");
    assert.deepEqual(row.cancelledSubscriptionSnapshots?.[server.id], { stripeSubscriptionId: "sub_late", canceledAt: 123 });
    assert.deepEqual(resumed, [server.id]);
    assert.equal(emails.deliveries.some(mail => /will be deleted on/.test(mail.subject)), false);
  } finally { release(); await effects; emails.stop(); }
});


test("restoration receipt is scoped to its person and request after a lost response", async ({ app, seed }) => {
  const human = await seed.human(passwordUser);
  const stranger = await seed.human({ ...passwordUser, email: `receipt-${randomUUID()}@example.test`, name: `receipt-${randomUUID()}` });
  const server = await seed.server({ owner: human });
  await getDb().insert(subscriptions).values({ serverId: server.id, stripeCustomerId: "cus_receipt", stripeSubscriptionId: "sub_receipt", status: "active", createdByUserId: human.id });
  const first = await requestAccountDeletion({ userId: human.id, source: "self", actorUserId: human.id }, { cancelSubscriptionAtPeriodEnd: async () => null });
  assert.equal(first.kind, "scheduled");
  if (first.kind !== "scheduled") assert.fail("expected request");
  const session = await signInForTest(human.id);
  // Discard the response, as if it was lost after the server committed undo.
  assert.equal((await call(app.baseUrl, session.token, "DELETE", `${DELETION}/requests/${first.request.id}`)).status, 200);
  const receipt = await call(app.baseUrl, session.token, "GET", `${DELETION}?requestId=${first.request.id}`);
  assert.equal(receipt.body.status, "none");
  assert.equal(receipt.body.requestId, first.request.id);
  assert.equal(receipt.body.subscriptionRestoration, "not_restored");
  const otherSession = await signInForTest(stranger.id);
  const hidden = await call(app.baseUrl, otherSession.token, "GET", `${DELETION}?requestId=${first.request.id}`);
  assert.equal(hidden.body.subscriptionRestoration, "unknown");
  assert.equal(hidden.body.requestId, undefined);

  const second = await getDb().transaction(tx => requestAccountDeletionInTransaction(tx, { userId: human.id, source: "self", actorUserId: human.id }));
  assert.equal(second.kind, "scheduled");
  const nextSession = await signInForTest(human.id);
  const staleUndo = await call(app.baseUrl, nextSession.token, "DELETE", `${DELETION}/requests/${first.request.id}`);
  const latest = await call(app.baseUrl, nextSession.token, "GET", DELETION);
  assert.equal(latest.body.status, "scheduled", "an old page cannot undo a newer deletion request");
  assert.equal(latest.body.requestId, second.kind === "scheduled" ? second.request.id : undefined);
  assert.equal(staleUndo.status, 409);
  assert.equal(staleUndo.body.code, "account_deletion_pending");
  assert.equal(staleUndo.body.details.accountDeletion.status, "scheduled");
  assert.equal(staleUndo.body.details.accountDeletion.requestId, second.kind === "scheduled" ? second.request.id : undefined);
  assert.deepEqual(staleUndo.body.details.accountDeletion.cancellationReceipt, { requestId: first.request.id, subscriptionRestoration: "not_restored" });
  assert.notEqual(staleUndo.body.status, "none", "the stale undo response must not claim no deletion is pending");
  const oldReceipt = await call(app.baseUrl, nextSession.token, "GET", `${DELETION}?requestId=${first.request.id}`);
  assert.equal(oldReceipt.body.status, "scheduled", "the current request takes priority over an old cancellation receipt");
  assert.equal(oldReceipt.body.requestId, second.kind === "scheduled" ? second.request.id : undefined);
  assert.deepEqual(oldReceipt.body.cancellationReceipt, { requestId: first.request.id, subscriptionRestoration: "not_restored" });
  assert.equal(oldReceipt.body.subscriptionRestoration, undefined, "do not present A's receipt as B's outcome");
  assert.equal((await call(app.baseUrl, nextSession.token, "DELETE", `${DELETION}?requestId=invalid`)).status, 400);
  assert.equal((await call(app.baseUrl, nextSession.token, "GET", DELETION)).body.status, "scheduled", "an invalid binding must not fall back to cancelling the current request");
  assert.equal((await call(app.baseUrl, nextSession.token, "DELETE", DELETION)).body.status, "none", "older clients keep the explicit unbound endpoint");
});

test("an incomplete snapshot result cannot overwrite a later confirmed restoration", async ({ seed }) => {
  const human = await seed.human(passwordUser);
  const server = await seed.server({ owner: human });
  await getDb().insert(subscriptions).values({ serverId: server.id, stripeCustomerId: "cus_outcome_order", stripeSubscriptionId: "sub_outcome_order", status: "active", createdByUserId: human.id });
  const requested = await getDb().transaction(tx => requestAccountDeletionInTransaction(tx, { userId: human.id, source: "self", actorUserId: human.id }));
  if (requested.kind !== "scheduled" || !requested.effects) assert.fail("expected request effects");
  let returnProvider!: () => void, providerEntered!: () => void, returnOldResult!: () => void, oldResultEntered!: () => void;
  const providerGate = new Promise<void>(resolve => { returnProvider = resolve; });
  const providerStarted = new Promise<void>(resolve => { providerEntered = resolve; });
  const oldResultGate = new Promise<void>(resolve => { returnOldResult = resolve; });
  const oldResultStarted = new Promise<void>(resolve => { oldResultEntered = resolve; });
  const emails = captureEmails();
  const effects = runAccountDeletionRequestedEffects(requested.effects, {
    cancelSubscriptionAtPeriodEnd: async (_serverId, _userId, stripeSubscriptionId) => { providerEntered(); await providerGate; return { stripeSubscriptionId, canceledAt: 123 }; },
    resumeSubscription: async () => "restored",
  });
  let undo: ReturnType<typeof cancelAccountDeletion> | undefined;
  try {
    await providerStarted;
    // Model an older result finishing late (for example while another Server
    // in this request was being processed). It was based on incomplete proof.
    undo = cancelAccountDeletion({ userId: human.id }, { resumeSubscription: async (_serverId, _userId, snapshot) => {
      assert.equal(snapshot?.canceledAt, null); oldResultEntered(); await oldResultGate; return "not_restored";
    } });
    await oldResultStarted;
    returnProvider(); await effects;
    assert.equal((await requestRows(human.id))[0].subscriptionRestorationResults?.[server.id], "restored");
    returnOldResult();
    assert.equal((await undo).subscriptionRestoration, "restored", "an old incomplete-proof result must not replace the confirmed provider outcome");
    assert.equal((await requestRows(human.id))[0].subscriptionRestorationResults?.[server.id], "restored");
  } finally { returnProvider(); returnOldResult(); await effects; await undo; emails.stop(); }
});

test("a cancellation email does not promise account safety when a newer deletion exists", async ({ seed }) => {
  const human = await seed.human(passwordUser);
  const server = await seed.server({ owner: human });
  await getDb().insert(subscriptions).values({ serverId: server.id, stripeCustomerId: "cus_newer_notice", stripeSubscriptionId: "sub_newer_notice", status: "active", createdByUserId: human.id });
  const emails = captureEmails();
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  let undo: ReturnType<typeof cancelAccountDeletion> | undefined;
  try {
    await requestAccountDeletion({ userId: human.id, source: "self", actorUserId: human.id }, { cancelSubscriptionAtPeriodEnd: async (_serverId, _userId, stripeSubscriptionId) => ({ stripeSubscriptionId, canceledAt: 123 }) });
    undo = cancelAccountDeletion({ userId: human.id }, { resumeSubscription: async () => { entered(); await gate; return "restored"; } });
    await started;
    const newer = await getDb().transaction(tx => requestAccountDeletionInTransaction(tx, { userId: human.id, source: "self", actorUserId: human.id }));
    assert.equal(newer.kind, "scheduled");
    release(); await undo;
    const notice = emails.deliveries.at(-1)!;
    assert.match(notice.subject ?? "", /earlier account deletion request/);
    assert.match(notice.text ?? "", /A newer deletion request is still scheduled/);
    assert.doesNotMatch(notice.text ?? "", /Your account works as before/);
  } finally { release(); await undo; emails.stop(); }
});


test("the bound deletion path authenticates pending users and never treats a malformed ID as unbound", async ({ app, seed }) => {
  const human = await seed.human(passwordUser);
  const outcome = await requestAccountDeletion({ userId: human.id, source: "self", actorUserId: human.id });
  assert.equal(outcome.kind, "scheduled");
  if (outcome.kind !== "scheduled") throw new Error("expected a pending deletion");
  const session = await signInForTest(human.id);
  const malformed = await call(app.baseUrl, session.token, "DELETE", `${DELETION}/requests/not-an-id`);
  assert.equal(malformed.status, 403, "the pending-account middleware refuses a path outside the exact allowlist");
  assert.equal((await call(app.baseUrl, session.token, "GET", DELETION)).body.status, "scheduled");
  const cancelled = await call(app.baseUrl, session.token, "DELETE", `${DELETION}/requests/${outcome.request.id}`);
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.status, "none");
  assert.equal(cancelled.body.requestId, outcome.request.id);
  assert.equal((await call(app.baseUrl, session.token, "GET", DELETION)).body.status, "none");
  assert.equal((await call(app.baseUrl, session.token, "DELETE", `${DELETION}/requests/not-an-id`)).status, 400, "an active user's malformed binding is refused by the route, without fallback");
});
