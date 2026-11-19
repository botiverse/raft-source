import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";

import { getDb } from "../db/index";
import { agentCredentials, computers, integrationAuditEvents, oauthAccessTokens, sessionFamilies } from "../db/schema";
import { signAccessToken } from "../middleware/auth";
import { createAgent } from "../services/agentService";
import { mintAgentCredential } from "../services/agentCredentialService";
import { revokeWhatRevokedSessionsApproved } from "../services/approverSessionGrants";
import { __setMySessionsCascadeForTests } from "../services/mySessions";
import { findComputerByApiKeyWithReason } from "../services/computerCredentialService";
import { createOAuthClient, hashSecret } from "../services/oauthService";
import { STEP_UP_ACTIONS, STEP_UP_WINDOW_MS } from "../services/secondFactor/stepUpGate";
import { proofForDeviceLogin } from "../services/sessionIssueGate";
import { createSession } from "../services/sessionService";
import { onSocketAccessRevoked, type SocketAccessRevocation } from "../socket/accessRevocation";
import { createApiTest } from "../test/integration/apiTest";
import { signInForTest, signInThroughSecondStepForTest } from "../test/integration/credentials";
import { enrollSecondFactor, useTotpSecretKey } from "../test/integration/secondFactor";

// A person's own sign-ins (routes/mySessions.ts, services/mySessions.ts):
// GET /api/me/sessions lists their live `full` sign-ins; DELETE
// /api/me/sessions/:familyId and POST /api/me/sessions/revoke-others sign
// other ones out, `sign_out` (logout-like: what they approved keeps working)
// or `lost_device` (a security revoke: what they approved goes too).

const test = createApiTest({ skipAuthRateLimit: true });
useTotpSecretKey();

const ENV = { AGENT_BOOTSTRAP_TOKEN_PEPPER: "my-sessions-test-pepper-0123456789abcdef", SLOCK_DEVICE_LOGIN_ENABLED: undefined } as const;
const previousEnv = Object.fromEntries(Object.keys(ENV).map((key) => [key, process.env[key]]));
function applyEnv(values: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
beforeAll(() => { applyEnv(ENV); });
afterAll(() => { applyEnv(previousEnv); });

type Json = Record<string, any>;
type Res = { status: number; body: Json };
type SeedHuman = { id: string; email: string };

async function call(baseUrl: string, method: string, path: string, token: string | null, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: await res.json().catch(() => null) as Json };
}

const list = (baseUrl: string, token: string, headers: Record<string, string> = {}) => call(baseUrl, "GET", "/api/me/sessions", token, undefined, headers);
const revokeOne = (baseUrl: string, token: string, familyId: string, body: unknown) => call(baseUrl, "DELETE", `/api/me/sessions/${familyId}`, token, body);
const revokeOthers = (baseUrl: string, token: string, body: unknown) => call(baseUrl, "POST", "/api/me/sessions/revoke-others", token, body);

async function refresh(baseUrl: string, refreshToken: string, headers: Record<string, string> = {}): Promise<{ status: number; code?: string }> {
  const res = await call(baseUrl, "POST", "/api/auth/refresh", null, { refreshToken }, headers);
  return { status: res.status, code: res.body?.code };
}

async function family(id: string) {
  const [row] = await getDb().select().from(sessionFamilies).where(eq(sessionFamilies.id, id));
  return row!;
}

/** As if the sign-in were made more than 10 minutes ago and never re-authenticated. */
async function ageSignIn(familyId: string) {
  await getDb().update(sessionFamilies)
    .set({ createdAt: new Date(Date.now() - STEP_UP_WINDOW_MS - 60_000), reauthenticatedAt: null })
    .where(eq(sessionFamilies.id, familyId));
}

function captureSocketRevocations() {
  const seen: SocketAccessRevocation[] = [];
  const stop = onSocketAccessRevoked(async (revocation) => { seen.push(revocation); });
  return { seen, stop };
}

// --- Listing ---

test("the list shows the person's own live full sign-ins, the current one flagged and never unknown; not another person's, not a device sign-in", async ({ app, seed }) => {
  const human = await seed.human();
  // Signed in through the real route, from the desktop app: its claims are recorded at sign-in.
  const login = await call(app.baseUrl, "POST", "/api/auth/login", null, { email: human.email, password: "password123" },
    { "X-Raft-Client-Platform": "desktop_app", "X-Raft-Client-Version": "1.21.0" });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  const desktopFamily = (await getDb().select({ id: sessionFamilies.id }).from(sessionFamilies)
    .where(and(eq(sessionFamilies.userId, human.id), eq(sessionFamilies.clientPlatform, "desktop_app"))))[0]!.id;
  assert.equal((await family(desktopFamily)).clientVersion, "1.21.0");

  // An old sign-in (no claims recorded) and the current one (none recorded either).
  const old = await signInForTest(human.id);
  const current = await signInForTest(human.id);
  const device = await createSession(await proofForDeviceLogin(human.id, current.familyId), undefined, { scope: "device" });
  const someoneElse = await signInForTest((await seed.human()).id);
  const signedOut = await signInForTest(human.id);
  await call(app.baseUrl, "POST", "/api/auth/logout", null, { refreshToken: signedOut.refreshToken });

  const res = await list(app.baseUrl, current.token, { "X-Raft-Client-Platform": "browser", "X-Raft-Client-Version": "1.21.3" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const sessions = res.body.sessions as Json[];
  assert.deepEqual(sessions.map((s) => s.id).sort(), [desktopFamily, old.familyId, current.familyId].sort());
  for (const id of [device.familyId, someoneElse.familyId, signedOut.familyId]) assert.ok(!sessions.some((s) => s.id === id), id);
  assert.deepEqual(Object.keys(sessions[0]!).sort(), ["createdAt", "current", "id", "lastActiveAt", "lostDeviceReach", "platform", "secondFactorVerified", "version"]);

  const byId = new Map(sessions.map((s) => [s.id, s]));
  assert.equal(sessions[0]!.id, current.familyId, "the current one first");
  assert.deepEqual([byId.get(current.familyId)!.current, byId.get(current.familyId)!.platform, byId.get(current.familyId)!.version], [true, "browser", "1.21.3"]);
  assert.deepEqual([byId.get(old.familyId)!.current, byId.get(old.familyId)!.platform, byId.get(old.familyId)!.version], [false, null, null]);
  assert.deepEqual([byId.get(desktopFamily)!.platform, byId.get(desktopFamily)!.version], ["desktop_app", "1.21.0"]);
  assert.equal(byId.get(old.familyId)!.secondFactorVerified, false);
  // The current family's empty claims were stored from the asking request.
  const stored = await family(current.familyId);
  assert.deepEqual([stored.clientPlatform, stored.clientVersion], ["browser", "1.21.3"]);
});

test("a refresh marks the sign-in active and keeps its version current; a family from before the column falls back to its newest refresh", async ({ app, seed }) => {
  const human = await seed.human();
  const current = await signInForTest(human.id);
  const other = await signInForTest(human.id);
  // As a family from before the column.
  await getDb().update(sessionFamilies).set({ lastActiveAt: null, createdAt: new Date("2026-01-01T00:00:00Z") }).where(eq(sessionFamilies.id, other.familyId));
  const fallback = (await list(app.baseUrl, current.token)).body.sessions.find((s: Json) => s.id === other.familyId);
  assert.ok(Date.parse(fallback.lastActiveAt) > Date.parse("2026-01-02T00:00:00Z"), "the newest refresh row, not the family's creation");

  const before = Date.now();
  const refreshed = await call(app.baseUrl, "POST", "/api/auth/refresh", null, { refreshToken: other.refreshToken },
    { "X-Raft-Client-Platform": "ios", "X-Raft-Client-Version": "2.0.1" });
  assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body));
  const row = await family(other.familyId);
  assert.ok(row.lastActiveAt && row.lastActiveAt.getTime() >= before - 1000);
  assert.deepEqual([row.clientPlatform, row.clientVersion], ["ios", "2.0.1"]);
  // A refresh that sends no claims keeps the recorded ones.
  assert.equal((await refresh(app.baseUrl, refreshed.body.refreshToken as string)).status, 200);
  const again = await family(other.familyId);
  assert.deepEqual([again.clientPlatform, again.clientVersion], ["ios", "2.0.1"]);
});

// --- Who may call ---

test("a device sign-in, an agent key and an App token are refused on all three routes, reads included", async ({ app, seed }) => {
  const human = await seed.human();
  const server = await seed.server({ owner: human });
  const current = await signInForTest(human.id);
  const other = await signInForTest(human.id);
  const device = await createSession(await proofForDeviceLogin(human.id, current.familyId), undefined, { scope: "device" });
  const agent = await createAgent(server.id, `ext-${human.id.slice(0, 8)}`, { runtime: "external", creatorType: "user", creatorId: human.id });
  const agentKey = await mintAgentCredential({ agentId: agent.id, scopes: ["send", "read"], name: "k", issuedVia: "human", createdByUserId: human.id });
  const client = await createOAuthClient({ serverId: server.id, createdByUserId: human.id, appType: "third_party_global", name: "Some App", clientId: `sessions-${randomUUID().slice(0, 8)}`, allowedScopes: ["openid"] });
  const appToken = `slock_at_${randomBytes(32).toString("hex")}`;
  await getDb().insert(oauthAccessTokens).values({
    clientId: client.client.id, userId: human.id, principalType: "human", serverId: server.id,
    tokenHash: hashSecret(appToken), scopes: ["openid"], expiresAt: new Date(Date.now() + 3_600_000),
  });

  const callers = {
    device: signAccessToken(human.id, device.familyId),
    agent: agentKey.apiKey,
    app: appToken,
  };
  for (const [name, token] of Object.entries(callers)) {
    for (const res of [
      await list(app.baseUrl, token),
      await revokeOne(app.baseUrl, token, other.familyId, { reason: "sign_out" }),
      await revokeOthers(app.baseUrl, token, { reason: "sign_out" }),
    ]) {
      assert.ok(res.status === 401 || res.status === 403, `${name}: ${res.status} ${JSON.stringify(res.body)}`);
    }
  }
  assert.equal((await family(other.familyId)).revokedAt, null, "nothing was signed out");
  assert.equal((await list(app.baseUrl, current.token)).status, 200);
});

// --- Not yours ---

test("another person's sign-in, an unknown id, a device sign-in and an already revoked one get the same 404; the current one 400; no reason 400", async ({ app, seed }) => {
  const human = await seed.human();
  const current = await signInForTest(human.id);
  const other = await signInForTest(human.id);
  const device = await createSession(await proofForDeviceLogin(human.id, current.familyId), undefined, { scope: "device" });
  const theirs = await signInForTest((await seed.human()).id);
  const revoked = await signInForTest(human.id);
  await call(app.baseUrl, "POST", "/api/auth/logout", null, { refreshToken: revoked.refreshToken });

  const bodies: Json[] = [];
  for (const id of [theirs.familyId, randomUUID(), device.familyId, revoked.familyId, "not-a-uuid"]) {
    const res = await revokeOne(app.baseUrl, current.token, id, { reason: "lost_device" });
    assert.equal(res.status, 404, `${id}: ${JSON.stringify(res.body)}`);
    bodies.push(res.body);
  }
  for (const body of bodies) assert.deepEqual(body, { error: "That sign-in was not found.", code: "session_not_found", errorCode: "session_not_found" });
  assert.equal((await family(theirs.familyId)).revokedAt, null);
  assert.equal((await family(device.familyId)).revokedAt, null);

  const self = await revokeOne(app.baseUrl, current.token, current.familyId, { reason: "sign_out" });
  assert.equal(self.status, 400);
  assert.equal(self.body.code, "current_session");

  for (const body of [{}, { reason: "nope" }, undefined]) {
    assert.equal((await revokeOne(app.baseUrl, current.token, other.familyId, body)).body?.code, "reason_required");
    assert.equal((await revokeOthers(app.baseUrl, current.token, body)).body?.code, "reason_required");
  }
  assert.equal((await family(other.familyId)).revokedAt, null);
});

// --- Step-up ---

test("both writes need a recent re-authentication on this sign-in", async ({ app, seed }) => {
  const human = await seed.human();
  const current = await signInForTest(human.id);
  const other = await signInForTest(human.id);
  await ageSignIn(current.familyId);

  for (const res of [
    await revokeOne(app.baseUrl, current.token, other.familyId, { reason: "sign_out" }),
    await revokeOthers(app.baseUrl, current.token, { reason: "sign_out" }),
  ]) {
    assert.equal(res.status, 403);
    assert.equal(res.body.code, "reauth_required");
    assert.equal(res.body.error, "Confirm it's you again before signing out a sign-in.");
  }
  assert.equal((await family(other.familyId)).revokedAt, null);

  // Re-authenticated with the password on this sign-in: allowed.
  assert.equal((await call(app.baseUrl, "POST", "/api/auth/second-factor/reauth/password", current.token, { password: "password123" })).status, 204);
  assert.deepEqual((await revokeOne(app.baseUrl, current.token, other.familyId, { reason: "sign_out" })).body, { cascade: "none" });
});

test("with two-step verification on, lost_device on both writes also needs the second factor on this sign-in in the last 10 minutes", async ({ app, seed }) => {
  const human = await seed.human();
  await enrollSecondFactor(human.id);
  const current = await signInThroughSecondStepForTest(human.id);
  const other = await signInThroughSecondStepForTest(human.id);
  // Re-authenticated (signed in just now) but the second factor is old.
  await getDb().update(sessionFamilies).set({ secondFactorVerifiedAt: new Date(Date.now() - STEP_UP_WINDOW_MS - 60_000) })
    .where(eq(sessionFamilies.id, current.familyId));

  for (const res of [
    await revokeOne(app.baseUrl, current.token, other.familyId, { reason: "lost_device" }),
    await revokeOthers(app.baseUrl, current.token, { reason: "lost_device" }),
  ]) {
    assert.equal(res.status, 403);
    assert.equal(res.body.code, "second_factor_step_up_required");
    assert.equal(res.body.error, STEP_UP_ACTIONS.session_revoke);
  }
  assert.equal((await family(other.familyId)).revokedAt, null);

  await getDb().update(sessionFamilies).set({ secondFactorVerifiedAt: new Date() }).where(eq(sessionFamilies.id, current.familyId));
  assert.deepEqual((await revokeOne(app.baseUrl, current.token, other.familyId, { reason: "lost_device" })).body, { cascade: "done" });
});

test("with two-step verification on, sign_out on both writes needs the re-authentication only, not the second factor (#triage:#386)", async ({ app, seed }) => {
  const human = await seed.human();
  await enrollSecondFactor(human.id);
  const current = await signInThroughSecondStepForTest(human.id);
  const one = await signInThroughSecondStepForTest(human.id);
  const rest = await signInThroughSecondStepForTest(human.id);
  // The authenticator went with the lost device: this sign-in's second factor is old, and stays old.
  await ageSignIn(current.familyId);
  await getDb().update(sessionFamilies).set({ secondFactorVerifiedAt: new Date(Date.now() - STEP_UP_WINDOW_MS - 60_000) })
    .where(eq(sessionFamilies.id, current.familyId));

  // Without the re-authentication: refused for it, either write.
  for (const res of [
    await revokeOne(app.baseUrl, current.token, one.familyId, { reason: "sign_out" }),
    await revokeOthers(app.baseUrl, current.token, { reason: "sign_out" }),
  ]) {
    assert.equal(res.status, 403);
    assert.equal(res.body.code, "reauth_required");
  }

  // The password on this sign-in, and no second step: sign_out goes on both writes.
  assert.equal((await call(app.baseUrl, "POST", "/api/auth/second-factor/reauth/password", current.token, { password: "password123" })).status, 204);
  assert.deepEqual((await revokeOne(app.baseUrl, current.token, one.familyId, { reason: "sign_out" })).body, { cascade: "none" });
  assert.notEqual((await family(one.familyId)).revokedAt, null);
  assert.deepEqual((await revokeOthers(app.baseUrl, current.token, { reason: "sign_out" })).body, { revoked: 1, cascade: "none" });
  assert.notEqual((await family(rest.familyId)).revokedAt, null);
  assert.equal((await family(current.familyId)).revokedAt, null);

  // lost_device, re-authenticated the same way: still refused for the second factor.
  const another = await signInThroughSecondStepForTest(human.id);
  for (const res of [
    await revokeOne(app.baseUrl, current.token, another.familyId, { reason: "lost_device" }),
    await revokeOthers(app.baseUrl, current.token, { reason: "lost_device" }),
  ]) {
    assert.equal(res.status, 403);
    assert.equal(res.body.code, "second_factor_step_up_required");
  }
  assert.equal((await family(another.familyId)).revokedAt, null);
});

// --- Signing one out ---

test("signing another sign-in out: its refresh is session_revoked, its access token stops, Socket is told, it is audited", async ({ app, seed }) => {
  const human = await seed.human();
  const current = await signInForTest(human.id);
  const other = await signInForTest(human.id);
  const third = await signInForTest(human.id);
  const sockets = captureSocketRevocations();
  try {
    assert.deepEqual((await revokeOne(app.baseUrl, current.token, other.familyId, { reason: "sign_out" })).body, { cascade: "none" });
  } finally {
    sockets.stop();
  }
  assert.deepEqual(sockets.seen, [{ userId: human.id, familyId: other.familyId }]);
  assert.deepEqual(await refresh(app.baseUrl, other.refreshToken), { status: 401, code: "session_revoked" });
  assert.equal((await call(app.baseUrl, "GET", "/api/auth/me", other.token)).status, 401);
  assert.equal((await refresh(app.baseUrl, current.refreshToken)).status, 200);
  assert.equal((await refresh(app.baseUrl, third.refreshToken)).status, 200);
  assert.equal((await family(other.familyId)).revokedReason, "user_signed_out");

  const [event] = await getDb().select().from(integrationAuditEvents)
    .where(and(eq(integrationAuditEvents.actorId, human.id), eq(integrationAuditEvents.eventType, "account.session_revoked")));
  assert.equal(event!.serverId, null);
  assert.deepEqual(event!.metadata, {
    sessionFamilyId: current.familyId, revokedSessionFamilyIds: [other.familyId], reason: "sign_out", scope: "one", signedOutSessionCount: 1,
  });
});

test("signing out every other sign-in keeps this one and the device sign-ins, and tells Socket for each", async ({ app, seed }) => {
  const human = await seed.human();
  const current = await signInForTest(human.id);
  const a = await signInForTest(human.id);
  const b = await signInForTest(human.id);
  const device = await createSession(await proofForDeviceLogin(human.id, current.familyId), undefined, { scope: "device" });
  const sockets = captureSocketRevocations();
  let res: Res;
  try {
    res = await revokeOthers(app.baseUrl, current.token, { reason: "sign_out" });
  } finally {
    sockets.stop();
  }
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body, { revoked: 2, cascade: "none" });
  assert.deepEqual(sockets.seen.map((r) => (r as { familyId: string }).familyId).sort(), [a.familyId, b.familyId].sort());
  for (const signIn of [a, b]) assert.deepEqual(await refresh(app.baseUrl, signIn.refreshToken), { status: 401, code: "session_revoked" });
  assert.equal((await refresh(app.baseUrl, current.refreshToken)).status, 200);
  assert.equal((await refresh(app.baseUrl, device.refreshToken)).status, 200);
  assert.equal((await family(a.familyId)).revokedReason, "user_signed_out");
  assert.equal((await family(device.familyId)).revokedAt, null);
});

// --- What a sign-in approved: kept by sign_out, taken by lost_device ---

type App = { baseUrl: string };

async function approveGrant(app: App, bearer: string, grant: Json, pick: Json) {
  const started = await call(app.baseUrl, "POST", "/api/auth/device/authorize", null, { clientName: "raft-computer", grant });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  const { deviceCode, userCode } = started.body as { deviceCode: string; userCode: string };
  const described = await call(app.baseUrl, "POST", "/api/auth/device/describe", bearer, { userCode });
  assert.equal(described.status, 200, JSON.stringify(described.body));
  const approved = await call(app.baseUrl, "POST", "/api/auth/device/approve", bearer, { userCode, approvalTicket: described.body.approvalTicket, ...pick });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  const token = await call(app.baseUrl, "POST", "/api/auth/device/token", null, { deviceCode });
  assert.equal(token.status, 200, JSON.stringify(token.body));
  return token.body;
}

/** A Computer attached through a one-time grant `bearer`'s sign-in approved. */
async function computerApprovedBy(app: App, bearer: string, serverId: string, name: string): Promise<{ apiKey: string; serverMachineId: string }> {
  const { attachToken } = await approveGrant(app, bearer, { kind: "computer_attach", machineName: name, hostname: name, os: "macOS" }, { serverId });
  const attached = await call(app.baseUrl, "POST", "/api/computer/attach", attachToken as string, {});
  assert.equal(attached.status, 201, JSON.stringify(attached.body));
  return attached.body as { apiKey: string; serverMachineId: string };
}

/** An agent key minted through a one-time grant `bearer`'s sign-in approved. */
async function agentKeyApprovedBy(app: App, bearer: string, agentId: string): Promise<{ apiKey: string; credentialId: string }> {
  const token = await approveGrant(app, bearer, { kind: "agent_key" }, { agentId });
  return { apiKey: token.apiKey as string, credentialId: token.credentialId as string };
}

async function computerState(computer: { apiKey: string }) {
  const auth = await findComputerByApiKeyWithReason(computer.apiKey);
  return auth.ok ? "live" : "revoked";
}

async function agentKeyState(app: App, apiKey: string) {
  const res = await fetch(`${app.baseUrl}/internal/agent-api/`, { headers: { Authorization: `Bearer ${apiKey}` } });
  return res.status === 200 ? "live" : res.status === 401 ? "revoked" : `status:${res.status}`;
}

/** A person, their server and an external agent, signed in three times (`current`, `lost`, `kept`), each having approved a Computer. */
async function approvals(app: App, seed: { human(): Promise<SeedHuman>; server(input: { owner: SeedHuman }): Promise<{ id: string }> }) {
  const human = await seed.human();
  const server = await seed.server({ owner: human });
  const agent = await createAgent(server.id, `ext-${human.id.slice(0, 8)}`, { runtime: "external" });
  const current = await signInForTest(human.id);
  const lost = await signInForTest(human.id);
  const kept = await signInForTest(human.id);
  return {
    human, server, current, lost, kept,
    currentComputer: await computerApprovedBy(app, current.token, server.id, "my-desk"),
    lostComputer: await computerApprovedBy(app, lost.token, server.id, "lost-laptop"),
    lostKey: await agentKeyApprovedBy(app, lost.token, agent.id),
    keptComputer: await computerApprovedBy(app, kept.token, server.id, "home-laptop"),
  };
}

test("the list counts, per sign-in and for every other one, the Computers and agent keys a lost-device revoke would turn off", async ({ app, seed }) => {
  const f = await approvals(app, seed);
  const res = await list(app.baseUrl, f.current.token);
  const byId = new Map((res.body.sessions as Json[]).map((s) => [s.id, s]));
  assert.deepEqual(byId.get(f.lost.familyId)!.lostDeviceReach, { computers: 1, agentKeys: 1 });
  assert.deepEqual(byId.get(f.kept.familyId)!.lostDeviceReach, { computers: 1, agentKeys: 0 });
  assert.deepEqual(byId.get(f.current.familyId)!.lostDeviceReach, { computers: 1, agentKeys: 0 });
  assert.deepEqual(res.body.othersLostDeviceReach, { computers: 2, agentKeys: 1 });
});

test("signing one sign-in out (sign_out) keeps what it approved", async ({ app, seed }) => {
  const f = await approvals(app, seed);
  assert.deepEqual((await revokeOne(app.baseUrl, f.current.token, f.lost.familyId, { reason: "sign_out" })).body, { cascade: "none" });
  assert.equal(await computerState(f.lostComputer), "live");
  assert.equal(await agentKeyState(app, f.lostKey.apiKey), "live");
  // Maintenance's repair doesn't reach it either: a sign-out is not a security revoke.
  await revokeWhatRevokedSessionsApproved("security_revoked", "repair");
  assert.equal(await computerState(f.lostComputer), "live");
});

test("revoking one sign-in as a lost device takes what it approved, and nothing another sign-in approved", async ({ app, seed }) => {
  const f = await approvals(app, seed);
  const sockets = captureSocketRevocations();
  try {
    assert.deepEqual((await revokeOne(app.baseUrl, f.current.token, f.lost.familyId, { reason: "lost_device" })).body, { cascade: "done" });
  } finally {
    sockets.stop();
  }
  assert.ok(sockets.seen.some((r) => "familyId" in r && r.familyId === f.lost.familyId));
  assert.equal((await family(f.lost.familyId)).revokedReason, "user_revoked");
  assert.equal(await computerState(f.lostComputer), "revoked");
  assert.equal(await agentKeyState(app, f.lostKey.apiKey), "revoked");
  assert.equal(await computerState(f.keptComputer), "live");
  assert.equal(await computerState(f.currentComputer), "live");
  assert.deepEqual(await refresh(app.baseUrl, f.lost.refreshToken), { status: 401, code: "session_revoked" });
  assert.equal((await refresh(app.baseUrl, f.kept.refreshToken)).status, 200);
});

test("signing every other sign-in out (sign_out) keeps what they approved", async ({ app, seed }) => {
  const f = await approvals(app, seed);
  assert.deepEqual((await revokeOthers(app.baseUrl, f.current.token, { reason: "sign_out" })).body, { revoked: 2, cascade: "none" });
  assert.equal(await computerState(f.lostComputer), "live");
  assert.equal(await agentKeyState(app, f.lostKey.apiKey), "live");
  assert.equal(await computerState(f.keptComputer), "live");
  assert.equal(await computerState(f.currentComputer), "live");
});

test("revoking every other sign-in as lost devices takes what they approved, a sign-in signed out earlier included; this sign-in's Computer and the device sign-ins stay", async ({ app, seed }) => {
  const f = await approvals(app, seed);
  // Signed out earlier (a thief covering their tracks): still reached.
  assert.equal((await call(app.baseUrl, "POST", "/api/auth/logout", null, { refreshToken: f.kept.refreshToken })).status, 200);
  const device = await createSession(await proofForDeviceLogin(f.human.id, f.current.familyId), undefined, { scope: "device" });

  assert.deepEqual((await revokeOthers(app.baseUrl, f.current.token, { reason: "lost_device" })).body, { revoked: 1, cascade: "done" });
  assert.equal((await family(f.lost.familyId)).revokedReason, "user_revoked_others");
  assert.equal(await computerState(f.lostComputer), "revoked");
  assert.equal(await agentKeyState(app, f.lostKey.apiKey), "revoked");
  assert.equal(await computerState(f.keptComputer), "revoked");
  assert.equal(await computerState(f.currentComputer), "live", "the Computer this sign-in approved stays online");
  assert.equal((await refresh(app.baseUrl, f.current.refreshToken)).status, 200);
  assert.equal((await refresh(app.baseUrl, device.refreshToken)).status, 200);
});

test("maintenance repairs a lost-device revoke whose cascade failed, one sign-in or every other one, and keeps this sign-in's Computer", async ({ app, seed }) => {
  const f = await approvals(app, seed);
  assert.deepEqual((await revokeOne(app.baseUrl, f.current.token, f.lost.familyId, { reason: "lost_device" })).body, { cascade: "done" });
  // As if the cascade had failed after the revoke committed.
  const undo = async (ids: string[]) => getDb().update(computers).set({ revokedAt: null, revokedReason: null }).where(inArray(computers.id, ids));
  await undo([f.lostComputer.serverMachineId]);
  await getDb().update(agentCredentials).set({ revokedAt: null, revokedReason: null }).where(eq(agentCredentials.id, f.lostKey.credentialId));
  assert.equal(await computerState(f.lostComputer), "live");
  await revokeWhatRevokedSessionsApproved("security_revoked", "repair");
  assert.equal(await computerState(f.lostComputer), "revoked");
  assert.equal(await agentKeyState(app, f.lostKey.apiKey), "revoked");
  assert.equal(await computerState(f.keptComputer), "live");

  assert.deepEqual((await revokeOthers(app.baseUrl, f.current.token, { reason: "lost_device" })).body, { revoked: 1, cascade: "done" });
  await undo([f.keptComputer.serverMachineId]);
  assert.equal(await computerState(f.keptComputer), "live");
  await revokeWhatRevokedSessionsApproved("security_revoked", "repair");
  assert.equal(await computerState(f.keptComputer), "revoked");
  assert.equal(await computerState(f.currentComputer), "live");
});

test("a lost-device cascade that fails is pending when the revoke stored its reason (the repair finishes it), and an error when revoke-others revoked nothing new", async ({ app, seed }) => {
  const f = await approvals(app, seed);
  __setMySessionsCascadeForTests(async () => { throw new Error("cascade down"); });
  try {
    assert.deepEqual((await revokeOne(app.baseUrl, f.current.token, f.lost.familyId, { reason: "lost_device" })).body, { cascade: "pending" });
    assert.equal(await computerState(f.lostComputer), "live", "the cascade did not run");
    assert.deepEqual((await revokeOthers(app.baseUrl, f.current.token, { reason: "lost_device" })).body, { revoked: 1, cascade: "pending" });
    assert.equal(await computerState(f.keptComputer), "live");

    // Nothing left to revoke: no stored revoke for the repair to retry from, so the failure is the caller's.
    const nothingNew = await revokeOthers(app.baseUrl, f.current.token, { reason: "lost_device" });
    assert.equal(nothingNew.status, 500, JSON.stringify(nothingNew.body));
    assert.equal(nothingNew.body.cascade, undefined);
  } finally {
    __setMySessionsCascadeForTests(null);
  }
  // The pending ones: the hourly repair does them.
  await revokeWhatRevokedSessionsApproved("security_revoked", "repair");
  assert.equal(await computerState(f.lostComputer), "revoked");
  assert.equal(await agentKeyState(app, f.lostKey.apiKey), "revoked");
  assert.equal(await computerState(f.keptComputer), "revoked");
  assert.equal(await computerState(f.currentComputer), "live");

  // Working again, with nothing new to revoke: done.
  assert.deepEqual((await revokeOthers(app.baseUrl, f.current.token, { reason: "lost_device" })).body, { revoked: 0, cascade: "done" });
});

// A UUID spelling must not separate the committed revoke from its live Socket transport.
for (const reason of ["sign_out", "lost_device"] as const) {
  test(`revoking an upper-case session UUID closes its actual Socket connection (${reason})`, async ({ app, seed }) => {
    const { createRequire } = await import("node:module");
    const { io: clientIo } = createRequire(new URL("../../../web/package.json", import.meta.url))("socket.io-client");
    const human = await seed.human();
    const server = await seed.server({ owner: human });
    const current = await signInForTest(human.id);
    const other = await signInForTest(human.id);
    const upper = other.familyId.toUpperCase();
    assert.notEqual(upper, other.familyId, "fixture must exercise a different UUID spelling");
    const socket = clientIo(app.baseUrl, { auth: { token: other.token, serverId: server.id }, transports: ["websocket"], reconnection: false });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Socket did not join its rooms")), 5000);
        socket.once("rooms:joined", () => { clearTimeout(timer); resolve(); });
        socket.once("connect_error", (err: Error) => { clearTimeout(timer); reject(err); });
      });
      const transport = app.io.of("/").sockets.get(socket.id);
      assert.ok(transport, "the real Socket server accepted this sign-in");
      assert.equal(transport.data.familyId, other.familyId);
      const outcome = new Promise<"closed" | "live">((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Neither Socket close nor synthetic probe arrived")), 5000);
        const settled = (result: "closed" | "live") => { clearTimeout(timer); resolve(result); };
        socket.once("disconnect", () => settled("closed"));
        socket.once("session-revoke-test-probe", () => settled("live"));
      });
      const response = await revokeOne(app.baseUrl, current.token, upper, { reason });
      assert.equal(response.status, 200);
      assert.ok((await family(other.familyId)).revokedAt, "the UUID found and revoked the database family");
      // A transport which escaped the real eviction can still receive a packet. No sleep or fake eviction listener.
      transport.emit("session-revoke-test-probe");
      const observed = await outcome;
      assert.equal((await call(app.baseUrl, "GET", "/api/auth/me", other.token)).status, 401);
      assert.equal(observed, "closed", "the successful revoke must close the live Socket, regardless of UUID letter case");
    } finally {
      socket.disconnect();
    }
  });
}
