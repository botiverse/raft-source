import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import argon2 from "argon2";
import { and, eq, ne } from "drizzle-orm";

import { getDb } from "../db/index";
import { computers, deviceAuthorizations, deviceLoginGrants, integrationAuditEvents, machines, serverMembers, sessionFamilies, users } from "../db/schema";
import { notifyComputerKeyReplacedByOther, notifyLegacyMachineMovedByOther } from "../services/computerAdoptionService";
import { findComputerByApiKeyWithReason } from "../services/computerCredentialService";
import { __setEmailDeliveryObserverForTests, type EmailDelivery } from "../services/emailService";
import { extractApiKeyFingerprint, registerMachine } from "../services/machineService";
import { createServer } from "../services/serverService";
import { changePassword } from "../services/userService";
import { openTestApp } from "../test/integration/app";
import { signInForTest } from "../test/integration/credentials";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

// The computer_migrate one-time grant (`raft-computer setup`'s legacy-daemon
// migration): the person picks a server on the approval page, the token phase
// returns a `dvmt_*` migrate token (never a session), and that token reaches
// exactly two routes, as the approver, for that server: their own legacy
// roster (GET /api/computer/legacy-machines) and adopting one legacy machine
// (POST /api/computer/adopt-legacy, which consumes it): their own, or by its
// id another member's while they hold registerMachines there.

const PEPPER = "device-code-test-pepper-0123456789abcdef";
const MIGRATE = { kind: "computer_migrate", machineName: "Maria's laptop", hostname: "maria-mbp", os: "macOS" };

type App = { baseUrl: string };

async function withApp<T>(fn: (app: App, mailbox: EmailDelivery[]) => Promise<T>): Promise<T> {
  const oldGate = process.env.SLOCK_DEVICE_LOGIN_ENABLED;
  const oldPepper = process.env.AGENT_BOOTSTRAP_TOKEN_PEPPER;
  delete process.env.SLOCK_DEVICE_LOGIN_ENABLED;
  process.env.AGENT_BOOTSTRAP_TOKEN_PEPPER = PEPPER;
  const mailbox: EmailDelivery[] = [];
  __setEmailDeliveryObserverForTests((delivery) => mailbox.push(delivery));
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    return await fn(app, mailbox);
  } finally {
    await app.close();
    __setEmailDeliveryObserverForTests(null);
    if (oldGate === undefined) delete process.env.SLOCK_DEVICE_LOGIN_ENABLED;
    else process.env.SLOCK_DEVICE_LOGIN_ENABLED = oldGate;
    if (oldPepper === undefined) delete process.env.AGENT_BOOTSTRAP_TOKEN_PEPPER;
    else process.env.AGENT_BOOTSTRAP_TOKEN_PEPPER = oldPepper;
  }
}

async function seedUser(): Promise<{ id: string; bearer: string; familyId: string }> {
  const suffix = randomUUID();
  const [u] = await getDb().insert(users).values({
    email: `migrate-${suffix}@slock.test`,
    name: `migrate-${suffix}`,
    displayName: "Migrate Tester",
    passwordHash: await argon2.hash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  const web = await signInForTest(u!.id);
  return { id: u!.id, bearer: web.token, familyId: web.familyId };
}

async function call(app: App, method: string, path: string, token?: string, body?: unknown) {
  const res = await fetch(`${app.baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, any> };
}

async function startGrant(app: App, grant: unknown) {
  const res = await call(app, "POST", "/api/auth/device/authorize", undefined, { clientName: "raft-computer", grant });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body as { deviceCode: string; userCode: string };
}

async function describeCode(app: App, bearer: string, userCode: string) {
  const res = await call(app, "POST", "/api/auth/device/describe", bearer, { userCode });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
}

async function approve(app: App, bearer: string, userCode: string, pick: { serverId?: string } = {}) {
  const described = await describeCode(app, bearer, userCode);
  return call(app, "POST", "/api/auth/device/approve", bearer, { userCode, approvalTicket: described.approvalTicket, ...pick });
}

async function poll(app: App, deviceCode: string) {
  return call(app, "POST", "/api/auth/device/token", undefined, { deviceCode });
}

/** A migrate token approved by `bearer` for `serverId`. */
async function migrateToken(app: App, bearer: string, serverId: string): Promise<{ token: string; userCode: string }> {
  const login = await startGrant(app, MIGRATE);
  assert.equal((await approve(app, bearer, login.userCode, { serverId })).status, 200);
  const polled = await poll(app, login.deviceCode);
  assert.equal(polled.status, 200, JSON.stringify(polled.body));
  return { token: polled.body.migrateToken as string, userCode: login.userCode };
}

async function grantRow(userCode: string) {
  const [row] = await getDb()
    .select({
      id: deviceLoginGrants.id,
      kind: deviceLoginGrants.kind,
      status: deviceLoginGrants.status,
      serverId: deviceLoginGrants.serverId,
      consumedComputerId: deviceLoginGrants.consumedComputerId,
    })
    .from(deviceLoginGrants)
    .innerJoin(deviceAuthorizations, eq(deviceAuthorizations.id, deviceLoginGrants.deviceAuthorizationId))
    .where(eq(deviceAuthorizations.userCode, userCode));
  return row;
}

function roster(app: App, token: string, serverSlug: string, includeAll = false) {
  return call(app, "GET", `/api/computer/legacy-machines?serverSlug=${encodeURIComponent(serverSlug)}${includeAll ? "&includeAll=1" : ""}`, token);
}

function adopt(app: App, token: string, body: Record<string, unknown>) {
  return call(app, "POST", "/api/computer/adopt-legacy", token, body);
}

function movedAudits(serverId: string) {
  return getDb().select().from(integrationAuditEvents)
    .where(and(eq(integrationAuditEvents.serverId, serverId), eq(integrationAuditEvents.eventType, "computer.legacy_adopted_by_other")));
}

async function mailCount(mailbox: EmailDelivery[], count: number) {
  for (let i = 0; i < 100 && mailbox.length < count; i += 1) await new Promise((r) => setTimeout(r, 20));
  assert.equal(mailbox.length, count);
}

test("computer_migrate: the person picks a server they may add computers to; the token phase returns a dvmt_ migrate token once, no session", async () => {
  await withApp(async (app) => {
    const { id: userId, bearer, familyId } = await seedUser();
    const owned = await createServer("Alpha Co", `alpha-${randomUUID()}`, userId);
    const { id: strangerId } = await seedUser();
    const memberOnly = await createServer("Gamma Co", `gamma-${randomUUID()}`, strangerId);
    await getDb().insert(serverMembers).values({ serverId: memberOnly.id, userId, role: "member" });

    const login = await startGrant(app, MIGRATE);
    const described = await describeCode(app, bearer, login.userCode);
    assert.equal(described.grant.kind, "computer_migrate");
    assert.equal(described.grant.machineName, "Maria's laptop");
    assert.deepEqual((described.grant.servers as Array<{ id: string }>).map((s) => s.id), [owned.id]);

    const noPick = await approve(app, bearer, login.userCode);
    assert.equal(noPick.status, 400);
    assert.equal(noPick.body.code, "grant_selection_required");
    const notAllowed = await approve(app, bearer, login.userCode, { serverId: memberOnly.id });
    assert.equal(notAllowed.status, 403);
    assert.equal(notAllowed.body.code, "grant_selection_not_allowed");

    assert.equal((await approve(app, bearer, login.userCode, { serverId: owned.id })).status, 200);
    assert.equal((await grantRow(login.userCode))?.kind, "computer_migrate");
    const token = await poll(app, login.deviceCode);
    assert.equal(token.status, 200);
    assert.equal(token.body.kind, "computer_migrate");
    assert.match(token.body.migrateToken, /^dvmt_/);
    assert.equal(token.body.serverId, owned.id);
    assert.equal(token.body.serverSlug, owned.slug);
    assert.ok(token.body.expiresIn > 0 && token.body.expiresIn <= 600);
    for (const field of ["accessToken", "refreshToken", "attachToken"]) assert.equal(field in token.body, false, field);
    const families = await getDb().select({ id: sessionFamilies.id }).from(sessionFamilies)
      .where(and(eq(sessionFamilies.userId, userId), ne(sessionFamilies.id, familyId)));
    assert.equal(families.length, 0, "no session");
    assert.equal((await poll(app, login.deviceCode)).body.code, "device_code_consumed");
  });
});

test("a migrate token lists the approver's own legacy machines on its server only, and works nowhere else", async () => {
  await withApp(async (app) => {
    const { id: userId, bearer } = await seedUser();
    const { id: otherId } = await seedUser();
    const server = await createServer("Alpha Co", `alpha-${randomUUID()}`, userId);
    const second = await createServer("Beta Co", `beta-${randomUUID()}`, userId);
    await getDb().insert(serverMembers).values({ serverId: server.id, userId: otherId, role: "member" });
    const mine = await registerMachine(server.id, userId, "my-daemon");
    await registerMachine(server.id, otherId, "their-daemon");
    await registerMachine(second.id, userId, "my-other-server-daemon");
    const { token } = await migrateToken(app, bearer, server.id);

    // Read as often as setup needs, until it is used or expires.
    for (let i = 0; i < 2; i += 1) {
      const listed = await roster(app, token, server.slug);
      assert.equal(listed.status, 200, JSON.stringify(listed.body));
      assert.deepEqual((listed.body.entries as Array<{ daemonId: string }>).map((e) => e.daemonId), [mine.machine.id]);
    }
    const all = await roster(app, token, server.slug, true);
    assert.deepEqual((all.body.entries as Array<{ daemonId: string }>).map((e) => e.daemonId), [mine.machine.id]);

    // Another server of the same person: refused.
    const wrongServer = await roster(app, token, second.slug);
    assert.equal(wrongServer.status, 403);
    assert.equal(wrongServer.body.code, "migrate_token_server_mismatch");

    // Not a session anywhere else.
    for (const [method, path, body] of [
      ["GET", "/api/auth/me", undefined],
      ["GET", "/api/servers", undefined],
      ["GET", `/api/servers/${server.id}/machines`, undefined],
      ["POST", "/api/computer/attach", { serverSlug: server.slug }],
      ["GET", "/api/agents/manageable", undefined],
    ] as const) {
      const res = await call(app, method, path, token, body);
      assert.equal(res.status, 401, `${method} ${path}: ${res.status} ${JSON.stringify(res.body)}`);
    }
    // Nor a token of another grant kind on these two routes.
    assert.equal((await roster(app, "dvat_notAMigrateToken", server.slug)).status, 401);
    const forged = await roster(app, "dvmt_forgedToken0123456789", server.slug);
    assert.equal(forged.status, 401);
    assert.equal(forged.body.code, "migrate_token_invalid");
  });
});

test("a migrate token adopts one of the approver's own legacy machines once, as the approver; the key records the grant; a security revoke takes it", async () => {
  await withApp(async (app, mailbox) => {
    const { id: userId, bearer } = await seedUser();
    const { id: otherId } = await seedUser();
    const server = await createServer("Alpha Co", `alpha-${randomUUID()}`, userId);
    await getDb().insert(serverMembers).values({ serverId: server.id, userId: otherId, role: "member" });
    const mine = await registerMachine(server.id, userId, "my-daemon");
    const theirs = await registerMachine(server.id, otherId, "their-daemon");
    const { token, userCode } = await migrateToken(app, bearer, server.id);

    // Another person's machine is not reached by its fingerprint (the roster is the approver's own).
    const otherFp = await adopt(app, token, { serverSlug: server.slug, legacyMachineId: theirs.machine.id, apiKeyFingerprint: extractApiKeyFingerprint(theirs.apiKey) });
    assert.equal(otherFp.status, 401);
    assert.equal(otherFp.body.code, "legacy_key_invalid");
    // By its raw key: refused, even for one's own machine.
    const rawKey = await adopt(app, token, { legacyApiKey: mine.apiKey });
    assert.equal(rawKey.status, 403);
    assert.equal(rawKey.body.code, "migrate_token_selection_required");
    // Another server named: refused.
    const wrongServer = await adopt(app, token, { serverSlug: `nope-${randomUUID()}`, daemonId: mine.machine.id });
    assert.equal(wrongServer.status, 403);
    assert.equal(wrongServer.body.code, "migrate_token_server_mismatch");
    const [theirRow] = await getDb().select({ migratedAt: machines.legacyKeyMigratedAt }).from(machines).where(eq(machines.id, theirs.machine.id));
    assert.equal(theirRow?.migratedAt, null);
    assert.equal((await grantRow(userCode))?.status, "approved", "refusals leave the grant unused");

    const won = await adopt(app, token, {
      serverSlug: server.slug,
      legacyMachineId: mine.machine.id,
      apiKeyFingerprint: extractApiKeyFingerprint(mine.apiKey),
    });
    assert.equal(won.status, 201, JSON.stringify(won.body));
    assert.match(won.body.apiKey, /^sk_computer_/);
    assert.equal(won.body.machineId, mine.machine.id);
    const row = await grantRow(userCode);
    assert.equal(row?.status, "consumed");
    assert.equal(row?.consumedComputerId, won.body.computerId);
    const [computer] = await getDb()
      .select({ grantId: computers.keyIssuedByGrantId, family: computers.keyIssuedBySessionFamilyId, web: computers.keyIssuedByWebSessionFamilyId, by: computers.attachedByUserId })
      .from(computers).where(eq(computers.id, won.body.computerId));
    assert.deepEqual(computer, { grantId: row!.id, family: null, web: null, by: userId });
    assert.equal((await findComputerByApiKeyWithReason(won.body.apiKey)).ok, true);

    // Once: no second adoption, and the roster is closed with it.
    const again = await adopt(app, token, { serverSlug: server.slug, daemonId: mine.machine.id });
    assert.equal(again.status, 410);
    assert.equal(again.body.code, "migrate_token_consumed");
    assert.equal((await roster(app, token, server.slug)).body.code, "migrate_token_consumed");

    // The approver is told, with the Computer's revoke link. Their own machine: no audit of a move, nobody else told.
    await mailCount(mailbox, 1);
    assert.equal((await movedAudits(server.id)).length, 0);

    // A security revoke of the approving session revokes what the grant issued.
    await changePassword(userId, "password123", "a-new-password-456");
    assert.equal((await findComputerByApiKeyWithReason(won.body.apiKey)).ok, false);
  });
});

test("a migrate token moves another member's legacy machine for an owner: audited once, and that member is told", async () => {
  await withApp(async (app, mailbox) => {
    const { id: ownerId, bearer } = await seedUser();
    const { id: memberId } = await seedUser();
    const server = await createServer("Alpha Co", `alpha-${randomUUID()}`, ownerId);
    await getDb().insert(serverMembers).values({ serverId: server.id, userId: memberId, role: "member" });
    const theirs = await registerMachine(server.id, memberId, "their-daemon");
    const { token, userCode } = await migrateToken(app, bearer, server.id);

    const won = await adopt(app, token, { serverSlug: server.slug, daemonId: theirs.machine.id });
    assert.equal(won.status, 201, JSON.stringify(won.body));
    assert.equal(won.body.machineId, theirs.machine.id);
    assert.equal((await grantRow(userCode))?.status, "consumed");
    const [computer] = await getDb().select({ by: computers.attachedByUserId }).from(computers).where(eq(computers.id, won.body.computerId));
    assert.equal(computer?.by, ownerId, "the Computer is attached by the person who moved it");

    const audits = await movedAudits(server.id);
    assert.equal(audits.length, 1);
    assert.deepEqual(
      { actor: audits[0]!.actorId, subject: audits[0]!.subjectId, target: audits[0]!.targetId },
      { actor: ownerId, subject: memberId, target: won.body.computerId },
    );
    assert.equal(audits[0]!.metadata.machineId, theirs.machine.id);
    assert.equal(audits[0]!.metadata.machineAddedByUserId, memberId);
    assert.equal(audits[0]!.metadata.via, "migrate_grant");
    assert.equal(audits[0]!.metadata.grantId, (await grantRow(userCode))!.id);

    // Two emails: the approver's "you added a Computer", and the member's "your machine was moved".
    await mailCount(mailbox, 2);
    const [{ email: memberEmail }] = await getDb().select({ email: users.email }).from(users).where(eq(users.id, memberId));
    const moved = mailbox.filter((mail) => mail.to === memberEmail);
    assert.equal(moved.length, 1);
    assert.match(moved[0]!.subject, /moved your machine their-daemon to a Raft Computer/);
    assert.match(moved[0]!.text ?? "", /a machine you added to Alpha Co/);
  });
});

test("moving a machine whose member has left the server is audited and emails nobody but the approver", async () => {
  await withApp(async (app, mailbox) => {
    const { id: ownerId, bearer } = await seedUser();
    const { id: goneId } = await seedUser();
    const server = await createServer("Alpha Co", `alpha-${randomUUID()}`, ownerId);
    await getDb().insert(serverMembers).values({ serverId: server.id, userId: goneId, role: "member" });
    const theirs = await registerMachine(server.id, goneId, "left-behind");
    await getDb().delete(serverMembers).where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, goneId)));
    const { token } = await migrateToken(app, bearer, server.id);

    const won = await adopt(app, token, { serverSlug: server.slug, daemonId: theirs.machine.id });
    assert.equal(won.status, 201, JSON.stringify(won.body));
    const audits = await movedAudits(server.id);
    assert.equal(audits.length, 1);
    assert.equal(audits[0]!.subjectId, goneId);
    await mailCount(mailbox, 1);
    // The notice itself, awaited: nothing for a member who left, nor for a retired account still listed.
    const notice = { serverId: server.id, machineId: theirs.machine.id, machineAddedByUserId: goneId, movedByUserId: ownerId };
    await notifyLegacyMachineMovedByOther(notice);
    assert.equal(mailbox.length, 1, "the member who left gets no email");
    await getDb().insert(serverMembers).values({ serverId: server.id, userId: goneId, role: "member" });
    await getDb().update(users).set({ retiredAt: new Date() }).where(eq(users.id, goneId));
    await notifyLegacyMachineMovedByOther(notice);
    assert.equal(mailbox.length, 1, "a retired account gets no email");
    await getDb().update(users).set({ retiredAt: null }).where(eq(users.id, goneId));
    await notifyLegacyMachineMovedByOther(notice);
    assert.equal(mailbox.length, 2, "a current member with a live account is told");
  });
});

test("a migrate token never takes over a Computer someone else attached: a machine already moved by its member, or attached the normal way", async () => {
  await withApp(async (app, mailbox) => {
    const { id: ownerId, bearer } = await seedUser();
    const { id: adminId, bearer: adminBearer } = await seedUser();
    const server = await createServer("Alpha Co", `alpha-${randomUUID()}`, ownerId);
    await getDb().insert(serverMembers).values({ serverId: server.id, userId: adminId, role: "admin" });

    // The admin moved their own old daemon earlier: a live Computer they attached.
    const theirs = await registerMachine(server.id, adminId, "their-daemon");
    const own = await migrateToken(app, adminBearer, server.id);
    const moved = await adopt(app, own.token, { serverSlug: server.slug, daemonId: theirs.machine.id });
    assert.equal(moved.status, 201, JSON.stringify(moved.body));
    // And a Computer the admin attached the normal way (its machine row was never a legacy daemon).
    const attached = await call(app, "POST", "/api/computer/attach", adminBearer, { serverSlug: server.slug, name: "attached-computer" });
    assert.equal(attached.status, 201, JSON.stringify(attached.body));
    await mailCount(mailbox, 1);

    // The owner's approval (say, one they were tricked into) reaches neither.
    const { token, userCode } = await migrateToken(app, bearer, server.id);
    for (const daemonId of [theirs.machine.id, attached.body.machineId as string]) {
      const refused = await adopt(app, token, { serverSlug: server.slug, daemonId });
      assert.equal(refused.status, 409, `${daemonId}: ${JSON.stringify(refused.body)}`);
      assert.equal(refused.body.code, "legacy_machine_key_migrated");
    }
    assert.equal((await findComputerByApiKeyWithReason(moved.body.apiKey)).ok, true, "the member's Computer key still works");
    assert.equal((await findComputerByApiKeyWithReason(attached.body.apiKey)).ok, true, "the attached Computer's key still works");
    assert.equal((await grantRow(userCode))?.status, "approved", "the refusals leave the grant unused");
    assert.equal((await movedAudits(server.id)).length, 0);
    const rotations = await getDb().select({ id: integrationAuditEvents.id }).from(integrationAuditEvents)
      .where(and(eq(integrationAuditEvents.serverId, server.id), eq(integrationAuditEvents.eventType, "computer.key_rotated")));
    assert.equal(rotations.length, 0, "no key was rotated");
    assert.equal(mailbox.length, 1, "nobody else was mailed");
  });
});

const keyReplacedMails = (mailbox: EmailDelivery[], to: string) => mailbox.filter((mail) => mail.to === to && /replaced the key of your Computer/.test(mail.subject));

test("an owner's session that sets up again a Computer a member's key runs replaces the key and tells that member once, by the name they knew; a retry tells nobody", async () => {
  await withApp(async (app, mailbox) => {
    const { id: ownerId, bearer } = await seedUser();
    const { id: adminId, bearer: adminBearer } = await seedUser();
    const server = await createServer("Alpha Co", `alpha-${randomUUID()}`, ownerId);
    await getDb().insert(serverMembers).values({ serverId: server.id, userId: adminId, role: "admin" });
    const [{ email: adminEmail }] = await getDb().select({ email: users.email }).from(users).where(eq(users.id, adminId));
    const theirs = await registerMachine(server.id, adminId, "their-daemon");
    const moved = await adopt(app, (await migrateToken(app, adminBearer, server.id)).token, { serverSlug: server.slug, daemonId: theirs.machine.id, name: "their-computer" });
    assert.equal(moved.status, 201, JSON.stringify(moved.body));
    await mailCount(mailbox, 1);

    // The owner, signed in (not a migrate token), resumes that Computer by its machine id, and renames it.
    const taken = await call(app, "POST", "/api/computer/adopt-legacy", bearer, { serverSlug: server.slug, daemonId: theirs.machine.id, name: "build-box" });
    assert.equal(taken.status, 201, JSON.stringify(taken.body));
    assert.equal(taken.body.computerId, moved.body.computerId);
    assert.equal(taken.body.resumed, true);
    assert.equal((await findComputerByApiKeyWithReason(moved.body.apiKey)).ok, false, "the member's key was replaced");
    await vi.waitFor(() => assert.equal(keyReplacedMails(mailbox, adminEmail).length, 1), { timeout: 3_000 });
    assert.match(keyReplacedMails(mailbox, adminEmail)[0]!.subject, /your Computer their-computer$/, "the name it had, not the one the owner gave it");
    const [rotation] = await getDb().select().from(integrationAuditEvents)
      .where(and(eq(integrationAuditEvents.serverId, server.id), eq(integrationAuditEvents.eventType, "computer.key_rotated")));
    assert.equal(rotation?.actorId, ownerId);
    assert.equal(rotation?.requesterId, adminId);
    assert.equal((await movedAudits(server.id)).length, 0, "not a move: the old daemon's key was retired by its own member");

    // The owner's setup retries: the key replaced now is the owner's own. Nobody is told again.
    const retried = await call(app, "POST", "/api/computer/adopt-legacy", bearer, { serverSlug: server.slug, daemonId: theirs.machine.id, name: "build-box" });
    assert.equal(retried.status, 201, JSON.stringify(retried.body));
    assert.equal((await findComputerByApiKeyWithReason(taken.body.apiKey)).ok, false);
    // The same for a Computer the owner attached themselves.
    const own = await registerMachine(server.id, ownerId, "own-daemon");
    for (let i = 0; i < 2; i += 1) {
      const res = await call(app, "POST", "/api/computer/adopt-legacy", bearer, { serverSlug: server.slug, daemonId: own.machine.id });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.resumed, i === 1);
    }
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(mailbox.filter((mail) => /replaced the key of your Computer/.test(mail.subject)).length, 1, "one notice, for the one takeover");

    // The member takes it back with their own session: now the owner held the key, and the owner is told.
    const back = await call(app, "POST", "/api/computer/adopt-legacy", adminBearer, { serverSlug: server.slug, daemonId: theirs.machine.id });
    assert.equal(back.status, 201, JSON.stringify(back.body));
    const [{ email: ownerEmail }] = await getDb().select({ email: users.email }).from(users).where(eq(users.id, ownerId));
    await vi.waitFor(() => assert.equal(keyReplacedMails(mailbox, ownerEmail).length, 1), { timeout: 3_000 });
    assert.match(keyReplacedMails(mailbox, ownerEmail)[0]!.subject, /your Computer build-box$/);
  });
});

test("a replaced key follows its new holder: the previous holder's security revoke no longer takes it, the new holder's does", async () => {
  await withApp(async (app) => {
    const { id: ownerId, bearer } = await seedUser();
    const { id: adminId, bearer: adminBearer } = await seedUser();
    const server = await createServer("Alpha Co", `alpha-${randomUUID()}`, ownerId);
    await getDb().insert(serverMembers).values({ serverId: server.id, userId: adminId, role: "admin" });
    // The admin moved their old daemon with an approval: the Computer's key is bound to that grant.
    const theirs = await registerMachine(server.id, adminId, "their-daemon");
    const approval = await migrateToken(app, adminBearer, server.id);
    const moved = await adopt(app, approval.token, { serverSlug: server.slug, daemonId: theirs.machine.id });
    assert.equal(moved.status, 201, JSON.stringify(moved.body));
    const grantId = (await grantRow(approval.userCode))!.id;
    const binding = async () => (await getDb()
      .select({ grant: computers.keyIssuedByGrantId, device: computers.keyIssuedBySessionFamilyId, web: computers.keyIssuedByWebSessionFamilyId })
      .from(computers).where(eq(computers.id, moved.body.computerId)))[0]!;
    assert.deepEqual(await binding(), { grant: grantId, device: null, web: null });

    // The owner replaces the key with their own session: bound to that session alone.
    const taken = await call(app, "POST", "/api/computer/adopt-legacy", bearer, { serverSlug: server.slug, daemonId: theirs.machine.id });
    assert.equal(taken.status, 201, JSON.stringify(taken.body));
    const after = await binding();
    assert.equal(after.grant, null, "the previous holder's approval no longer binds the key");
    assert.ok(after.device ?? after.web, "bound to the owner's session");

    // The admin's password change (a security revoke of what their sessions approved) does not take the owner's key.
    await changePassword(adminId, "password123", "admins-new-password-456");
    assert.equal((await findComputerByApiKeyWithReason(taken.body.apiKey)).ok, true, "the previous holder's security revoke misses it");
    // The owner's does.
    await changePassword(ownerId, "password123", "owners-new-password-456");
    assert.equal((await findComputerByApiKeyWithReason(taken.body.apiKey)).ok, false, "the new holder's security revoke takes it");
  });
});

test("an owner's session that takes over a Computer a member attached the normal way sends the key-replaced notice only: nothing was moved", async () => {
  await withApp(async (app, mailbox) => {
    const { id: ownerId, bearer } = await seedUser();
    const { id: adminId, bearer: adminBearer } = await seedUser();
    const server = await createServer("Alpha Co", `alpha-${randomUUID()}`, ownerId);
    await getDb().insert(serverMembers).values({ serverId: server.id, userId: adminId, role: "admin" });
    const [{ email: adminEmail }] = await getDb().select({ email: users.email }).from(users).where(eq(users.id, adminId));
    const attached = await call(app, "POST", "/api/computer/attach", adminBearer, { serverSlug: server.slug, name: "attached-computer" });
    assert.equal(attached.status, 201, JSON.stringify(attached.body));
    const before = mailbox.length;

    const taken = await call(app, "POST", "/api/computer/adopt-legacy", bearer, { serverSlug: server.slug, daemonId: attached.body.machineId });
    assert.equal(taken.status, 201, JSON.stringify(taken.body));
    const live = await getDb().select({ id: computers.id }).from(computers).where(eq(computers.machineId, attached.body.machineId));
    assert.deepEqual(live.map((row) => row.id), [taken.body.computerId], "the same Computer, not a second one");
    assert.equal(taken.body.resumed, true);
    assert.equal((await findComputerByApiKeyWithReason(attached.body.apiKey)).ok, false);
    await vi.waitFor(() => assert.equal(keyReplacedMails(mailbox, adminEmail).length, 1), { timeout: 3_000 });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(mailbox.length, before + 1, "one email: the key-replaced notice");
    assert.equal(mailbox.filter((mail) => /moved your machine/.test(mail.subject)).length, 0);
    assert.equal((await movedAudits(server.id)).length, 0);

    // The notice itself, awaited: nobody who left the server, no retired account.
    const notice = { serverId: server.id, computerName: "attached-computer", keyHolderUserId: adminId, replacedByUserId: ownerId };
    await getDb().update(users).set({ retiredAt: new Date() }).where(eq(users.id, adminId));
    await notifyComputerKeyReplacedByOther(notice);
    assert.equal(keyReplacedMails(mailbox, adminEmail).length, 1, "a retired account gets no email");
    await getDb().update(users).set({ retiredAt: null }).where(eq(users.id, adminId));
    await getDb().delete(serverMembers).where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, adminId)));
    await notifyComputerKeyReplacedByOther(notice);
    assert.equal(keyReplacedMails(mailbox, adminEmail).length, 1, "someone who left the server gets no email");
    await getDb().insert(serverMembers).values({ serverId: server.id, userId: adminId, role: "member" });
    await notifyComputerKeyReplacedByOther(notice);
    assert.equal(keyReplacedMails(mailbox, adminEmail).length, 2);
  });
});

test("a second approval by the same owner resumes their own move of another member's machine, without a second move event or notice", async () => {
  await withApp(async (app, mailbox) => {
    const { id: ownerId, bearer } = await seedUser();
    const { id: memberId } = await seedUser();
    const server = await createServer("Alpha Co", `alpha-${randomUUID()}`, ownerId);
    await getDb().insert(serverMembers).values({ serverId: server.id, userId: memberId, role: "member" });
    const theirs = await registerMachine(server.id, memberId, "their-daemon");

    const first = await adopt(app, (await migrateToken(app, bearer, server.id)).token, { serverSlug: server.slug, daemonId: theirs.machine.id });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    await mailCount(mailbox, 2);
    // Setup retried (its local half had not finished): a new approval, the same Computer.
    const again = await adopt(app, (await migrateToken(app, bearer, server.id)).token, { serverSlug: server.slug, daemonId: theirs.machine.id });
    assert.equal(again.status, 201, JSON.stringify(again.body));
    assert.equal(again.body.computerId, first.body.computerId);
    assert.equal(again.body.resumed, true);
    assert.equal((await movedAudits(server.id)).length, 1);
    await mailCount(mailbox, 3);
    const [{ email: memberEmail }] = await getDb().select({ email: users.email }).from(users).where(eq(users.id, memberId));
    assert.equal(mailbox.filter((mail) => mail.to === memberEmail).length, 1, "the member is told once");
  });
});

test("a migrate token whose approver is no longer an owner or admin moves their own machine only", async () => {
  await withApp(async (app, mailbox) => {
    const { id: founderId } = await seedUser();
    const { id: adminId, bearer } = await seedUser();
    const { id: memberId } = await seedUser();
    const server = await createServer("Alpha Co", `alpha-${randomUUID()}`, founderId);
    await getDb().insert(serverMembers).values([
      { serverId: server.id, userId: adminId, role: "admin" },
      { serverId: server.id, userId: memberId, role: "member" },
    ]);
    const mine = await registerMachine(server.id, adminId, "my-daemon");
    const theirs = await registerMachine(server.id, memberId, "their-daemon");
    const { token, userCode } = await migrateToken(app, bearer, server.id);
    // Demoted after approving: the role is read when the machine is adopted.
    await getDb().update(serverMembers).set({ role: "member" }).where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, adminId)));

    const other = await adopt(app, token, { serverSlug: server.slug, daemonId: theirs.machine.id });
    assert.equal(other.status, 403, JSON.stringify(other.body));
    assert.equal(other.body.code, "requires_admin");
    const [theirRow] = await getDb().select({ migratedAt: machines.legacyKeyMigratedAt }).from(machines).where(eq(machines.id, theirs.machine.id));
    assert.equal(theirRow?.migratedAt, null);
    assert.equal((await grantRow(userCode))?.status, "approved", "the refusal leaves the grant unused");
    assert.equal((await movedAudits(server.id)).length, 0);

    const own = await adopt(app, token, { serverSlug: server.slug, daemonId: mine.machine.id });
    assert.equal(own.status, 201, JSON.stringify(own.body));
    assert.equal((await movedAudits(server.id)).length, 0);
    await mailCount(mailbox, 1);
  });
});

test("a migrate token past its 10 minutes, or approved by a session security-revoked since, adopts nothing", async () => {
  await withApp(async (app) => {
    const { id: userId, bearer } = await seedUser();
    const server = await createServer("Alpha Co", `alpha-${randomUUID()}`, userId);
    const mine = await registerMachine(server.id, userId, "my-daemon");

    const expired = await migrateToken(app, bearer, server.id);
    await getDb().update(deviceLoginGrants).set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(deviceLoginGrants.id, (await grantRow(expired.userCode))!.id));
    const late = await adopt(app, expired.token, { serverSlug: server.slug, daemonId: mine.machine.id });
    assert.equal(late.status, 410);
    assert.equal(late.body.code, "migrate_token_expired");
    assert.equal((await roster(app, expired.token, server.slug)).body.code, "migrate_token_expired");

    const revoked = await migrateToken(app, bearer, server.id);
    await changePassword(userId, "password123", "a-new-password-456");
    const afterRevoke = await adopt(app, revoked.token, { serverSlug: server.slug, daemonId: mine.machine.id });
    assert.equal(afterRevoke.status, 410);
    assert.equal(afterRevoke.body.code, "migrate_token_expired");
    const [row] = await getDb().select({ migratedAt: machines.legacyKeyMigratedAt }).from(machines).where(eq(machines.id, mine.machine.id));
    assert.equal(row?.migratedAt, null);
  });
});
