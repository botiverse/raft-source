// PR 6 of passkeys + two-step verification: email recovery with a 72-hour
// wait (services/secondFactor/recovery.ts). Time is moved by writing the
// request's own times (eligible_at, link_expires_at), not the clock.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";

import { createApiTest } from "../test/integration/apiTest";
import { getDb } from "../db/index";
import {
  integrationAuditEvents,
  notificationOutbox,
  passwordResets,
  secondFactorRecoveryRequests,
  sessionFamilies,
  userBackupCodes,
  users,
  userTotp,
  webauthnCredentials,
} from "../db/schema";
import { __setEmailDeliveryObserverForTests, type EmailDelivery } from "../services/emailService";
import * as securityRevokeCascade from "../services/securityRevokeCascade";
import { RECOVERY_DELAY_MS, sweepRecoveryRequests } from "../services/secondFactor/recovery";
import { createSession } from "../services/sessionService";
import { proofForDeviceLogin } from "../services/sessionIssueGate";
import { signAccessToken } from "../middleware/auth";
import { createServer } from "../services/serverService";
import { createAgent } from "../services/agentService";
import { requestPasswordReset } from "../services/userService";
import { fixturePasswordHash, signInForTest } from "../test/integration/credentials";
import { enrollSecondFactor, leaveRetiredSecondFactorFlagRowOff, totpCode, useTotpSecretKey } from "../test/integration/secondFactor";
import { __settleSecondFactorRecoveryStartsForTests, SECOND_FACTOR_RECOVERY_START_BODY } from "./secondFactor";

const test = createApiTest();
useTotpSecretKey();

const ENV = { APP_URL: "https://app.raft.test", AGENT_BOOTSTRAP_TOKEN_PEPPER: "second-factor-recovery-test-pepper-0123456789" } as const;
const previousEnv = Object.fromEntries(Object.keys(ENV).map((key) => [key, process.env[key]]));
beforeAll(() => { Object.assign(process.env, ENV); });
afterAll(() => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

let mailbox: EmailDelivery[] = [];
beforeEach(() => {
  mailbox = [];
  __setEmailDeliveryObserverForTests((delivery) => mailbox.push(delivery));
});
afterEach(() => { __setEmailDeliveryObserverForTests(null); });

type Json = Record<string, any>;
type Human = { id: string; email: string };
type Seed = { human(values?: Json): Promise<Human> };

async function call(baseUrl: string, method: "GET" | "POST" | "DELETE", path: string, body?: unknown, token?: string) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json().catch(() => null) as Json };
}

const post = (baseUrl: string, path: string, body: unknown, token?: string) => call(baseUrl, "POST", path, body, token);

/** A person with a password (unless `password: false`) and two-step verification on. */
async function enforced(seed: Seed, options: { password?: boolean } = {}) {
  // No password: the hash is an unknowable placeholder, as a social or passkey signup leaves it.
  const human = await seed.human(options.password === false
    ? { passwordHash: await fixturePasswordHash(randomBytes(16).toString("hex")) }
    : { passwordCredentialEstablishedAt: new Date() });
  return { human, ...(await enrollSecondFactor(human.id)) };
}

/** A full web session made directly (the person's other devices; the password gate would ask for a second step). */
async function webSession(userId: string, verified = false) {
  process.env.JWT_SECRET ||= "test-jwt-secret";
  const session = await createSession({ flow: "signup", userId, secondFactor: "not_required" } as never);
  if (verified) {
    await getDb().update(sessionFamilies).set({ secondFactorVerifiedAt: new Date(), secondFactorMethod: "totp" }).where(eq(sessionFamilies.id, session.familyId));
  }
  return { ...session, token: signAccessToken(userId, session.familyId) };
}

async function start(baseUrl: string, email: string) {
  const res = await post(baseUrl, "/api/auth/second-factor/recovery", { email });
  await __settleSecondFactorRecoveryStartsForTests();
  return res;
}

function tokenIn(delivery: EmailDelivery | undefined, param: "second_factor_recovery" | "cancel_second_factor_recovery"): string {
  const match = delivery?.text?.match(new RegExp(`[?&]${param}=([A-Za-z0-9_-]{43})`));
  assert.ok(match, `no ${param} link in ${delivery?.subject}`);
  return match[1]!;
}

const mailTo = (email: string) => mailbox.filter((delivery) => delivery.to === email);

/** Start and confirm: the wait is running. Returns the cancel token from the "someone asked" email. */
async function waiting(baseUrl: string, human: Human) {
  await start(baseUrl, human.email);
  const link = tokenIn(mailTo(human.email).at(-1), "second_factor_recovery");
  const confirmed = await post(baseUrl, "/api/auth/second-factor/recovery/confirm", { token: link });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  return { link, cancelToken: tokenIn(mailTo(human.email).at(-1), "cancel_second_factor_recovery"), confirmed: confirmed.body };
}

async function rowsOf(userId: string) {
  return getDb().select().from(secondFactorRecoveryRequests).where(eq(secondFactorRecoveryRequests.userId, userId));
}

async function makeReady(userId: string, eligibleAgoMs = 60_000) {
  await getDb().update(secondFactorRecoveryRequests).set({ eligibleAt: new Date(Date.now() - eligibleAgoMs) })
    .where(and(eq(secondFactorRecoveryRequests.userId, userId), eq(secondFactorRecoveryRequests.status, "waiting")));
}

function login(baseUrl: string, human: Human, password = "password123") {
  return post(baseUrl, "/api/auth/login", { email: human.email, password });
}

test("no account enumeration: the same 200 and body for an unknown address, no two-step verification and an eligible person (a leftover flag row off changes nothing); only the last is emailed", async ({ app, seed }) => {
  await leaveRetiredSecondFactorFlagRowOff();
  const plain = await seed.human();
  const eligible = await enforced(seed);
  const answers = [];
  for (const email of [`nobody-${randomUUID()}@test.invalid`, plain.email, eligible.human.email.toUpperCase()]) {
    answers.push(await start(app.baseUrl, email));
  }
  for (const answer of answers) {
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.body, SECOND_FACTOR_RECOVERY_START_BODY);
  }
  assert.deepEqual(mailbox.map((delivery) => delivery.to), [eligible.human.email]);
  assert.equal((await rowsOf(plain.id)).length, 0);
  const [row] = await rowsOf(eligible.human.id);
  assert.equal(row!.status, "pending_confirmation");
  // Only the hash is stored.
  const link = tokenIn(mailbox[0], "second_factor_recovery");
  assert.notEqual(row!.linkTokenHash, link);
  assert.equal(row!.linkTokenHash.length, 64);
  // An unconfirmed link is not shown to the person's sessions (anyone can type an address).
  const session = await webSession(eligible.human.id);
  assert.equal((await call(app.baseUrl, "GET", "/api/auth/second-factor/status", undefined, session.token)).body.recovery, null);
});

test("the per-address limit answers 429 the same for every address; the per-person limit sends at most three links an hour", async ({ app, seed }) => {
  const { human } = await enforced(seed);
  for (let n = 0; n < 4; n += 1) assert.equal((await start(app.baseUrl, human.email)).status, 200);
  assert.equal(mailTo(human.email).length, 3);
  const rows = await rowsOf(human.id);
  assert.equal(rows.length, 3);
  // Each new link supersedes the earlier one: only one is active.
  assert.equal(rows.filter((row) => row.status === "pending_confirmation").length, 1);
  for (let n = 0; n < 6; n += 1) await start(app.baseUrl, `nobody-${n}@test.invalid`);
  const limited = await start(app.baseUrl, `nobody-else@test.invalid`);
  assert.equal(limited.status, 429);
});

test("the link is single use and expires after 30 minutes; a superseded link no longer works", async ({ app, seed }) => {
  const { human } = await enforced(seed);
  await start(app.baseUrl, human.email);
  const first = tokenIn(mailTo(human.email)[0], "second_factor_recovery");
  await start(app.baseUrl, human.email);
  const second = tokenIn(mailTo(human.email)[1], "second_factor_recovery");
  const superseded = await post(app.baseUrl, "/api/auth/second-factor/recovery/confirm", { token: first });
  assert.equal(superseded.status, 400);
  assert.equal(superseded.body.code, "recovery_token_invalid");

  await getDb().update(secondFactorRecoveryRequests).set({ linkExpiresAt: new Date(Date.now() - 1000) })
    .where(eq(secondFactorRecoveryRequests.status, "pending_confirmation"));
  const expired = await post(app.baseUrl, "/api/auth/second-factor/recovery/confirm", { token: second });
  assert.equal(expired.status, 400);
  assert.equal(expired.body.code, "recovery_token_invalid");

  await start(app.baseUrl, human.email);
  const third = tokenIn(mailTo(human.email).at(-1), "second_factor_recovery");
  const before = Date.now();
  const confirmed = await post(app.baseUrl, "/api/auth/second-factor/recovery/confirm", { token: third });
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.body.recovery.status, "waiting");
  assert.equal(confirmed.body.recovery.firstFactorRequired, null);
  const eligibleAt = Date.parse(confirmed.body.recovery.eligibleAt);
  assert.ok(eligibleAt >= before + RECOVERY_DELAY_MS && eligibleAt <= Date.now() + RECOVERY_DELAY_MS);
  const again = await post(app.baseUrl, "/api/auth/second-factor/recovery/confirm", { token: third });
  assert.equal(again.status, 400);
  assert.equal(again.body.code, "recovery_token_invalid");
  assert.equal((await rowsOf(human.id)).filter((row) => row.status === "waiting").length, 1);
  // The "someone asked" email, with a cancel link.
  const asked = mailTo(human.email).at(-1)!;
  assert.match(asked.subject, /Someone asked to reset two-step verification/);
  tokenIn(asked, "cancel_second_factor_recovery");
});

test("one active request per person: the database refuses a second one, and starting again while one waits sends nothing", async ({ app, seed }) => {
  const { human } = await enforced(seed);
  await waiting(app.baseUrl, human);
  const sent = mailTo(human.email).length;
  await start(app.baseUrl, human.email);
  assert.equal(mailTo(human.email).length, sent);
  assert.equal((await rowsOf(human.id)).length, 1);
  await assert.rejects(getDb().insert(secondFactorRecoveryRequests).values({
    userId: human.id, status: "pending_confirmation", linkTokenHash: randomBytes(32).toString("hex"),
    linkExpiresAt: new Date(Date.now() + 60_000), requestedAt: new Date(),
  }), (err: { cause?: { constraint?: string } }) => err.cause?.constraint === "idx_second_factor_recovery_requests_user_active");
});

test("every session of the person sees the waiting request in GET /status and GET /recovery (web and mobile alike); one push goes to their devices", async ({ app, seed }) => {
  const { human } = await enforced(seed);
  const owner = await seed.human();
  const server = await createServer("Recovery Co", `recovery-${randomUUID()}`, human.id);
  void owner;
  const laptop = await webSession(human.id);
  const phone = await webSession(human.id);
  await waiting(app.baseUrl, human);
  for (const session of [laptop, phone]) {
    const status = await call(app.baseUrl, "GET", "/api/auth/second-factor/status", undefined, session.token);
    assert.equal(status.status, 200);
    assert.deepEqual(Object.keys(status.body.recovery).sort(), ["eligibleAt", "expiresAt", "firstFactorRequired", "requestedAt", "status"]);
    assert.equal(status.body.recovery.status, "waiting");
    const own = await call(app.baseUrl, "GET", "/api/auth/second-factor/recovery", undefined, session.token);
    assert.deepEqual(own.body.recovery, status.body.recovery);
  }
  const pushes = await getDb().select().from(notificationOutbox).where(eq(notificationOutbox.receiverId, human.id));
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0]!.category, "system_notice");
  assert.equal(pushes[0]!.serverId, server.id);
  const payload = pushes[0]!.payload as Json;
  assert.equal(payload.title, "Someone asked to reset your two-step verification");
  assert.equal(payload.titleKey, undefined);
  assert.equal(payload.opensActivity, true);
  assert.equal(payload.securityNotice, true);
  // Another person sees nothing.
  const stranger = await webSession(owner.id);
  assert.equal((await call(app.baseUrl, "GET", "/api/auth/second-factor/status", undefined, stranger.token)).body.recovery, null);
});

test("a right second-factor answer cancels the request: step-up on a session, and the second step of a sign-in", async ({ app, seed }) => {
  const { human, secret } = await enforced(seed);
  const session = await webSession(human.id);
  await waiting(app.baseUrl, human);
  const stepUp = await post(app.baseUrl, "/api/auth/second-factor/step-up", { code: totpCode(secret) }, session.token);
  assert.equal(stepUp.status, 200, JSON.stringify(stepUp.body));
  const [cancelled] = await rowsOf(human.id);
  assert.equal(cancelled!.status, "cancelled");
  assert.equal(cancelled!.cancelledBy, "auto_factor");
  assert.match(mailTo(human.email).at(-1)!.subject, /reset was cancelled/);
  assert.equal((await call(app.baseUrl, "GET", "/api/auth/second-factor/status", undefined, session.token)).body.recovery, null);

  await waiting(app.baseUrl, human);
  const challenge = await login(app.baseUrl, human);
  assert.equal(challenge.status, 200);
  assert.deepEqual(challenge.body.methods, ["totp", "backup_code"]);
  const signedIn = await post(app.baseUrl, "/api/auth/second-factor/verify", { challenge: challenge.body.challenge, code: totpCode(secret, 1) });
  assert.equal(signedIn.status, 200, JSON.stringify(signedIn.body));
  const rows = await rowsOf(human.id);
  assert.deepEqual(rows.map((row) => [row.status, row.cancelledBy]), [["cancelled", "auto_factor"], ["cancelled", "auto_factor"]]);
  const audits = await getDb().select().from(integrationAuditEvents)
    .where(and(eq(integrationAuditEvents.actorId, human.id), eq(integrationAuditEvents.eventType, "account.second_factor_recovery_cancelled")));
  assert.equal(audits.length, 2);
});

test("cancel from any signed-in session (no step-up) and by the emailed cancel link; each mails, a used cancel link answers nothing", async ({ app, seed }) => {
  const { human } = await enforced(seed);
  const session = await webSession(human.id);
  await waiting(app.baseUrl, human);
  const cancelled = await call(app.baseUrl, "DELETE", "/api/auth/second-factor/recovery", undefined, session.token);
  assert.equal(cancelled.status, 200);
  assert.deepEqual(cancelled.body, { cancelled: true, recovery: null });
  assert.equal((await rowsOf(human.id))[0]!.cancelledBy, "user");
  assert.match(mailTo(human.email).at(-1)!.subject, /reset was cancelled/);
  const nothing = await call(app.baseUrl, "DELETE", "/api/auth/second-factor/recovery", undefined, session.token);
  assert.deepEqual(nothing.body, { cancelled: false, recovery: null });

  const { cancelToken } = await waiting(app.baseUrl, human);
  const byLink = await post(app.baseUrl, "/api/auth/second-factor/recovery/cancel", { token: cancelToken });
  assert.equal(byLink.status, 200);
  assert.deepEqual(byLink.body, { cancelled: true });
  assert.equal((await rowsOf(human.id)).find((row) => row.cancelledBy === "token")?.status, "cancelled");
  assert.match(mailTo(human.email).at(-1)!.subject, /reset was cancelled/);
  const reused = await post(app.baseUrl, "/api/auth/second-factor/recovery/cancel", { token: cancelToken });
  assert.equal(reused.status, 400);
  assert.equal(reused.body.code, "recovery_token_invalid");
});

test("finishing before the wait is over is refused, and sign-in does not offer it", async ({ app, seed }) => {
  const { human } = await enforced(seed);
  await waiting(app.baseUrl, human);
  const challenge = await login(app.baseUrl, human);
  assert.deepEqual(challenge.body.methods, ["totp", "backup_code"]);
  const refused = await post(app.baseUrl, "/api/auth/second-factor/verify", { challenge: challenge.body.challenge, recovery: true });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, "recovery_not_ready");
  assert.ok(refused.body.eligibleAt);
  assert.equal("accessToken" in refused.body, false);
  assert.equal((await rowsOf(human.id))[0]!.status, "waiting");
  assert.ok((await getDb().select().from(userTotp).where(eq(userTotp.userId, human.id))).length === 1);
});

test("after the wait, a password sign-in finishes it: every factor removed, two-step verification off, every other sign-in and device session revoked, the cascade run, emails sent", async ({ app, seed }) => {
  const { human } = await enforced(seed);
  const other = await webSession(human.id, true);
  const device = await createSession(await proofForDeviceLogin(human.id, other.familyId), undefined, { scope: "device" });
  const server = await createServer("Keys Co", `keys-${randomUUID()}`, human.id);
  const agent = await createAgent(server.id, "outside", { runtime: "external" });
  const minted = await post(app.baseUrl, `/api/agents/${agent.id}/credentials`, {}, other.token);
  assert.equal(minted.status, 201, JSON.stringify(minted.body));
  const agentKeyLive = async () => (await fetch(`${app.baseUrl}/internal/agent-api/`, { headers: { Authorization: `Bearer ${minted.body.apiKey}` } })).status;
  assert.equal(await agentKeyLive(), 200);
  await getDb().insert(webauthnCredentials).values({
    userId: human.id, credentialId: randomBytes(16), publicKey: randomBytes(64), name: "Laptop",
  });
  await waiting(app.baseUrl, human);
  await makeReady(human.id);
  await getDb().delete(notificationOutbox).where(eq(notificationOutbox.receiverId, human.id));

  const challenge = await login(app.baseUrl, human);
  assert.deepEqual(challenge.body.methods, ["totp", "backup_code", "recovery"]);
  const cascade = vi.spyOn(securityRevokeCascade, "runSecurityRevokeCascade");
  try {
    const done = await post(app.baseUrl, "/api/auth/second-factor/verify", { challenge: challenge.body.challenge, recovery: true });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.ok(done.body.accessToken && done.body.refreshToken);
    assert.ok(cascade.mock.calls.some(([scope, trigger]) => trigger === "second_factor_recovered" && typeof scope === "object" && "userId" in scope && scope.userId === human.id));

    const [user] = await getDb().select().from(users).where(eq(users.id, human.id));
    assert.equal(user!.secondFactorRequiredAt, null);
    assert.equal((await getDb().select().from(userTotp).where(eq(userTotp.userId, human.id))).length, 0);
    assert.equal((await getDb().select().from(userBackupCodes).where(eq(userBackupCodes.userId, human.id))).length, 0);
    const passkeys = await getDb().select().from(webauthnCredentials).where(eq(webauthnCredentials.userId, human.id));
    assert.ok(passkeys.every((passkey) => passkey.revokedAt));
    assert.equal((await rowsOf(human.id))[0]!.status, "completed");

    const families = await getDb().select().from(sessionFamilies).where(eq(sessionFamilies.userId, human.id));
    const live = families.filter((family) => !family.revokedAt);
    assert.equal(live.length, 1, "only the new sign-in is live");
    for (const familyId of [other.familyId, device.familyId]) {
      assert.equal(families.find((family) => family.id === familyId)?.revokedReason, "revoke_all");
    }
    assert.equal(await agentKeyLive(), 401, "what the other session issued is revoked by the cascade");
    const statusOfOld = await call(app.baseUrl, "GET", "/api/auth/second-factor/status", undefined, other.token);
    assert.equal(statusOfOld.status, 401);
    const subjects = mailTo(human.email).map((delivery) => delivery.subject);
    assert.ok(subjects.some((subject) => /Two-step verification was reset/.test(subject)), subjects.join(" | "));
    // Signing in again needs only the password now.
    const again = await login(app.baseUrl, human);
    assert.ok(again.body.accessToken, JSON.stringify(again.body));
    const audits = await getDb().select().from(integrationAuditEvents)
      .where(and(eq(integrationAuditEvents.actorId, human.id), eq(integrationAuditEvents.eventType, "account.second_factor_recovery_completed")));
    assert.equal(audits.length, 1);
  } finally {
    cascade.mockRestore();
  }
});

test("two finishes at once (two sign-ins): exactly one completes", async ({ app, seed }) => {
  const { human } = await enforced(seed);
  await waiting(app.baseUrl, human);
  await makeReady(human.id);
  const first = await login(app.baseUrl, human);
  const second = await login(app.baseUrl, human);
  const outcomes = await Promise.all([first, second].map((challenge) =>
    post(app.baseUrl, "/api/auth/second-factor/verify", { challenge: challenge.body.challenge, recovery: true })));
  assert.deepEqual(outcomes.map((outcome) => outcome.status).sort(), [200, 409]);
  assert.equal(outcomes.find((outcome) => outcome.status === 409)!.body.code, "recovery_not_found");
  const live = (await getDb().select().from(sessionFamilies).where(eq(sessionFamilies.userId, human.id))).filter((family) => !family.revokedAt);
  assert.equal(live.length, 1);
});

test("a request not finished within 7 days of the wait's end expires: not offered, refused, hidden; the sweep mails 'ready' once and expires", async ({ app, seed }) => {
  const { human } = await enforced(seed);
  const session = await webSession(human.id);
  await waiting(app.baseUrl, human);
  await makeReady(human.id, 8 * 24 * 60 * 60_000);
  const challenge = await login(app.baseUrl, human);
  assert.deepEqual(challenge.body.methods, ["totp", "backup_code"]);
  const refused = await post(app.baseUrl, "/api/auth/second-factor/verify", { challenge: challenge.body.challenge, recovery: true });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, "recovery_not_found");
  assert.equal((await call(app.baseUrl, "GET", "/api/auth/second-factor/status", undefined, session.token)).body.recovery, null);
  assert.equal((await rowsOf(human.id))[0]!.status, "expired");

  // The sweep: a fresh request whose wait just ended gets one "ready" email.
  const ready = await enforced(seed);
  await waiting(app.baseUrl, ready.human);
  await makeReady(ready.human.id);
  const before = mailTo(ready.human.email).length;
  await sweepRecoveryRequests();
  await sweepRecoveryRequests();
  const readyMails = mailTo(ready.human.email).slice(before);
  assert.equal(readyMails.length, 1);
  assert.match(readyMails[0]!.subject, /You can finish resetting/);
  const [readyRow] = await rowsOf(ready.human.id);
  assert.ok(readyRow!.readyNotifiedAt);
  await makeReady(ready.human.id, 8 * 24 * 60 * 60_000);
  assert.ok((await sweepRecoveryRequests()).expired >= 1);
  assert.equal((await rowsOf(ready.human.id))[0]!.status, "expired");
});

test("a passkey-only account (no password, no connected sign-in) cannot finish by email alone: told to set a password; reset-password issues no session and keeps the second step", async ({ app, seed }) => {
  const { human, secret } = await enforced(seed, { password: false });
  const { confirmed } = await waiting(app.baseUrl, human);
  assert.equal(confirmed.recovery.firstFactorRequired, "set_password");
  assert.match(mailTo(human.email).at(-1)!.text ?? "", /Forgot password/);
  await makeReady(human.id);
  // Nothing unauthenticated finishes it: there is no sign-in challenge without a first factor.
  const noFirstFactor = await login(app.baseUrl, human);
  assert.equal(noFirstFactor.status, 401);

  await requestPasswordReset(human.email);
  const resetToken = mailTo(human.email).at(-1)!.html.match(/[?&]reset=([0-9a-f]{64})/)?.[1];
  assert.ok(resetToken);
  const reset = await post(app.baseUrl, "/api/auth/reset-password", { token: resetToken, password: "a-new-password-1" });
  assert.equal(reset.status, 200);
  assert.deepEqual(reset.body, { ok: true }, "a password reset issues no session");
  assert.equal((await getDb().select().from(passwordResets).where(eq(passwordResets.userId, human.id))).length, 0);
  // Still two-step: the reset does not bypass the second factor.
  const challenge = await login(app.baseUrl, human, "a-new-password-1");
  assert.equal(challenge.body.secondFactorRequired, true);
  assert.equal("accessToken" in challenge.body, false);
  assert.deepEqual(challenge.body.methods, ["totp", "backup_code", "recovery"]);
  void secret;
  const done = await post(app.baseUrl, "/api/auth/second-factor/verify", { challenge: challenge.body.challenge, recovery: true });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.ok(done.body.accessToken);
});

test("a leftover auth_second_factor_v1 row switched off changes nothing: the signed-in routes answer and the emailed cancel link works", async ({ app, seed }) => {
  await leaveRetiredSecondFactorFlagRowOff();
  const { human } = await enforced(seed);
  const session = await webSession(human.id);
  const { cancelToken } = await waiting(app.baseUrl, human);
  const view = await call(app.baseUrl, "GET", "/api/auth/second-factor/recovery", undefined, session.token);
  assert.equal(view.status, 200);
  assert.ok(view.body.recovery, "the waiting recovery is shown");
  const cancel = await post(app.baseUrl, "/api/auth/second-factor/recovery/cancel", { token: cancelToken });
  assert.equal(cancel.status, 200);
});

test("someone without two-step verification sees no change: status says recovery null, sign-in and verify unchanged", async ({ app, seed }) => {
  const human = await seed.human({ passwordCredentialEstablishedAt: new Date() });
  const signedIn = await login(app.baseUrl, human);
  assert.ok(signedIn.body.accessToken);
  assert.equal("secondFactorRequired" in signedIn.body, false);
  const session = await signInForTest(human.id);
  const missing = await post(app.baseUrl, "/api/auth/second-factor/verify", { challenge: "x".repeat(43), recovery: true });
  assert.ok([400, 410].includes(missing.status));
  // The signed-in route answers: no recovery for someone without two-step verification.
  const view = await call(app.baseUrl, "GET", "/api/auth/second-factor/recovery", undefined, session.token);
  assert.equal(view.status, 200);
  assert.equal(view.body.recovery, null);
});
