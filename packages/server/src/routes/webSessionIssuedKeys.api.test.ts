import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

import argon2 from "argon2";
import { and, eq, inArray } from "drizzle-orm";
import jwt from "jsonwebtoken";

import { getDb } from "../db/index";
import { agentBootstrapTokens, agentCredentials, agents, computers, integrationAuditEvents, machines, passwordResets, servers, sessionFamilies, users } from "../db/schema";
import { __setEmailDeliveryObserverForTests, type EmailDelivery } from "../services/emailService";
import { runSecurityRevokeCascade } from "../services/securityRevokeCascade";
import { findComputerByApiKeyWithReason } from "../services/computerCredentialService";
import { findMachineByApiKey, registerMachine } from "../services/machineService";
import { openTestApp } from "../test/integration/app";
import { signAccessToken } from "../middleware/auth";
import { createServer } from "../services/serverService";
import { createAgent } from "../services/agentService";
import { consumeAgentBootstrapToken } from "../services/agentCredentialService";
import { subscribeAgentCredentialRevocation } from "../services/agentCredentialRevocationBus";
import { setMachineConnectionDropHandler, type MachineConnectionDropReason } from "../replicaRouter";
import { createSession, DeviceSessionRevokedError } from "../services/sessionService";
import { proofForDeviceLogin } from "../services/sessionIssueGate";
import { signInForTest } from "../test/integration/credentials";
import { changePassword, resetPassword } from "../services/userService";
import { revokeWhatRevokedWebSessionsIssued } from "../services/webSessionIssuedKeys";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

// What a person's own web (full) session issued through the ordinary web
// routes (an agent key, a bootstrap token, a Computer attach, a legacy machine
// key) records the session's family, and a security revoke of it (a password
// change) revokes them (webSessionIssuedKeys.ts). A plain logout never does.

const PEPPER = "web-session-keys-test-pepper-0123456789abcdef";

async function withApp<T>(fn: (app: Awaited<ReturnType<typeof openTestApp>>, mailbox: EmailDelivery[]) => Promise<T>): Promise<T> {
  const saved = {
    gate: process.env.SLOCK_DEVICE_LOGIN_ENABLED,
    pepper: process.env.AGENT_BOOTSTRAP_TOKEN_PEPPER,
    bootstrap: process.env.SLOCK_SELF_HOSTED_RUNNER_BOOTSTRAP_ENABLED,
  };
  delete process.env.SLOCK_DEVICE_LOGIN_ENABLED;
  process.env.AGENT_BOOTSTRAP_TOKEN_PEPPER = PEPPER;
  process.env.SLOCK_SELF_HOSTED_RUNNER_BOOTSTRAP_ENABLED = "true";
  const mailbox: EmailDelivery[] = [];
  __setEmailDeliveryObserverForTests((delivery) => mailbox.push(delivery));
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  const restore = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  try {
    return await fn(app, mailbox);
  } finally {
    await app.close();
    __setEmailDeliveryObserverForTests(null);
    restore("SLOCK_DEVICE_LOGIN_ENABLED", saved.gate);
    restore("AGENT_BOOTSTRAP_TOKEN_PEPPER", saved.pepper);
    restore("SLOCK_SELF_HOSTED_RUNNER_BOOTSTRAP_ENABLED", saved.bootstrap);
  }
}

type App = { baseUrl: string };

async function seedUser(): Promise<{ id: string }> {
  const suffix = randomUUID();
  const [u] = await getDb().insert(users).values({
    email: `web-keys-${suffix}@slock.test`,
    name: `web-keys-${suffix}`,
    displayName: "Web Keys Tester",
    passwordHash: await argon2.hash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return { id: u!.id };
}

/** A person's own web sign-in: a `full` session family, its access and refresh tokens. */
async function webSession(userId: string) {
  const session = await signInForTest(userId);
  return { familyId: session.familyId, refreshToken: session.refreshToken, bearer: session.token };
}

async function post(app: App, path: string, body: unknown, token?: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${app.baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, any> };
}

/** POST /api/agents/:id/credentials with the session: an sk_agent_* for an external agent. */
async function mintAgentKey(app: App, bearer: string, agentId: string) {
  const minted = await post(app, `/api/agents/${agentId}/credentials`, {}, bearer);
  assert.equal(minted.status, 201, JSON.stringify(minted.body));
  return { apiKey: minted.body.apiKey as string, credentialId: minted.body.credentialId as string };
}

/** POST /api/agents/:id/bootstrap-tokens with the session; exchanged later by whoever holds it. */
async function issueBootstrapToken(app: App, bearer: string, serverId: string, agentId: string) {
  const issued = await post(app, `/api/agents/${agentId}/bootstrap-tokens`, {}, bearer, { "X-Server-Id": serverId });
  assert.equal(issued.status, 201, JSON.stringify(issued.body));
  return { token: issued.body.bootstrapToken as string, tokenId: issued.body.tokenId as string };
}

type AttachedComputer = { apiKey: string; serverMachineId: string; machineId: string };

/** POST /api/computer/attach with the session (no attach token). */
async function attachWithSession(app: App, bearer: string, serverSlug: string, name: string): Promise<AttachedComputer> {
  const attached = await post(app, "/api/computer/attach", { serverSlug, name }, bearer);
  assert.equal(attached.status, 201, JSON.stringify(attached.body));
  return attached.body as AttachedComputer;
}

/** POST /api/servers/:id/machines with the session: a legacy sk_machine_* key. */
async function registerLegacyMachine(app: App, bearer: string, serverId: string, name: string) {
  const registered = await post(app, `/api/servers/${serverId}/machines`, { name }, bearer, { "X-Server-Id": serverId });
  assert.equal(registered.status, 200, JSON.stringify(registered.body));
  return { apiKey: registered.body.apiKey as string, machineId: registered.body.machine.id as string };
}

/** An agent on the machine and the runner credential the machine's key minted for it. */
async function runnerOn(app: App, serverId: string, machine: { apiKey: string; machineId: string }, name: string) {
  const agent = await createAgent(serverId, name, { runtime: "external" });
  await getDb().update(agents).set({ machineId: machine.machineId }).where(eq(agents.id, agent.id));
  const minted = await post(app, `/internal/computer/runners/${agent.id}/credentials`, {}, machine.apiKey);
  assert.equal(minted.status, 201, JSON.stringify(minted.body));
  return { agentId: agent.id, apiKey: minted.body.apiKey as string, credentialId: minted.body.credentialId as string };
}

async function agentKeyState(app: App, apiKey: string) {
  const res = await fetch(`${app.baseUrl}/internal/agent-api/`, { headers: { Authorization: `Bearer ${apiKey}` } });
  return res.status === 200 ? "live" : res.status === 401 ? "revoked" : `status:${res.status}`;
}

async function computerState(computer: { apiKey: string }) {
  const auth = await findComputerByApiKeyWithReason(computer.apiKey);
  return auth.ok ? "live" : auth.reason;
}

async function machineKeyState(apiKey: string) {
  return (await findMachineByApiKey(apiKey)) ? "live" : "discarded";
}

async function captureClosures<T>(agentIds: string[], work: (closed: { drops: Array<[string, MachineConnectionDropReason]>; signals: string[] }) => Promise<T>): Promise<T> {
  const closed = { drops: [] as Array<[string, MachineConnectionDropReason]>, signals: [] as string[] };
  setMachineConnectionDropHandler((machineId, reason) => { closed.drops.push([machineId, reason]); });
  const unsubscribe = agentIds.map((agentId) => subscribeAgentCredentialRevocation(agentId, () => closed.signals.push(agentId)));
  try {
    return await work(closed);
  } finally {
    for (const off of unsubscribe) off();
    setMachineConnectionDropHandler(null);
  }
}

/** Everything one web session issues through the ordinary web routes, on one server of the person. */
async function issueEverything(app: App, userId: string, bearer: string, label: string) {
  const server = await createServer(`${label} Co`, `${label}-${randomUUID()}`, userId);
  const external = await createAgent(server.id, `${label}-outside`, { runtime: "external" });
  const viaToken = await createAgent(server.id, `${label}-bootstrapped`, { runtime: "external" });
  const key = await mintAgentKey(app, bearer, external.id);
  const bootstrap = await issueBootstrapToken(app, bearer, server.id, viaToken.id);
  const exchanged = await consumeAgentBootstrapToken(bootstrap.token);
  assert.ok(exchanged.ok);
  const pending = await issueBootstrapToken(app, bearer, server.id, viaToken.id);
  const laptop = await attachWithSession(app, bearer, server.slug, `${label}-laptop`);
  const laptopRunner = await runnerOn(app, server.id, laptop, `${label}-laptop-agent`);
  const legacy = await registerLegacyMachine(app, bearer, server.id, `${label}-legacy`);
  const legacyRunner = await runnerOn(app, server.id, legacy, `${label}-legacy-agent`);
  return { server, external, viaToken, key, exchanged: { apiKey: exchanged.apiKey, credentialId: exchanged.credentialId }, pending, laptop, laptopRunner, legacy, legacyRunner };
}

type Issued = Awaited<ReturnType<typeof issueEverything>>;

async function stateOf(app: App, issued: Issued) {
  return {
    key: await agentKeyState(app, issued.key.apiKey),
    exchanged: await agentKeyState(app, issued.exchanged.apiKey),
    laptop: await computerState(issued.laptop),
    laptopRunner: await agentKeyState(app, issued.laptopRunner.apiKey),
    legacy: await machineKeyState(issued.legacy.apiKey),
    legacyRunner: await agentKeyState(app, issued.legacyRunner.apiKey),
  };
}

const ALL_LIVE = { key: "live", exchanged: "live", laptop: "live", laptopRunner: "live", legacy: "live", legacyRunner: "live" };
const ALL_REVOKED = { key: "revoked", exchanged: "revoked", laptop: "computer_revoked", laptopRunner: "revoked", legacy: "discarded", legacyRunner: "revoked" };

test("each web route records the issuing web session's family in its own column, never the device-session one", async () => {
  await withApp(async (app) => {
    const { id: userId } = await seedUser();
    const web = await webSession(userId);
    const issued = await issueEverything(app, userId, web.bearer, "alpha");
    const credentials = await getDb()
      .select({ id: agentCredentials.id, web: agentCredentials.issuedByWebSessionFamilyId, device: agentCredentials.issuedBySessionFamilyId })
      .from(agentCredentials)
      .where(inArray(agentCredentials.id, [issued.key.credentialId, issued.exchanged.credentialId, issued.laptopRunner.credentialId, issued.legacyRunner.credentialId]));
    const byId = new Map(credentials.map((row) => [row.id, row]));
    assert.deepEqual(byId.get(issued.key.credentialId), { id: issued.key.credentialId, web: web.familyId, device: null });
    assert.deepEqual(byId.get(issued.exchanged.credentialId), { id: issued.exchanged.credentialId, web: web.familyId, device: null });
    // Runner credentials go with their Computer or machine, not by family.
    assert.equal(byId.get(issued.laptopRunner.credentialId)!.web, null);
    assert.equal(byId.get(issued.legacyRunner.credentialId)!.web, null);
    const [computer] = await getDb().select({ web: computers.keyIssuedByWebSessionFamilyId, device: computers.keyIssuedBySessionFamilyId })
      .from(computers).where(eq(computers.id, issued.laptop.serverMachineId));
    assert.deepEqual(computer, { web: web.familyId, device: null });
    const [legacy] = await getDb().select({ web: machines.keyIssuedByWebSessionFamilyId }).from(machines).where(eq(machines.id, issued.legacy.machineId));
    assert.equal(legacy!.web, web.familyId);
    // The machine an attach registers for its Computer keeps none: its key is discarded at attach.
    const [attachMachine] = await getDb().select({ web: machines.keyIssuedByWebSessionFamilyId }).from(machines).where(eq(machines.id, issued.laptop.machineId));
    assert.equal(attachMachine!.web, null);
    const tokens = await getDb().select({ web: agentBootstrapTokens.issuedByWebSessionFamilyId }).from(agentBootstrapTokens)
      .where(inArray(agentBootstrapTokens.id, [issued.pending.tokenId]));
    assert.deepEqual(tokens, [{ web: web.familyId }]);

    // A rotation from the web records the rotating session; the old key is gone.
    const other = await webSession(userId);
    const rotated = await post(app, `/api/servers/${issued.server.id}/machines/${issued.legacy.machineId}/rotate-key`, {}, other.bearer, { "X-Server-Id": issued.server.id });
    assert.equal(rotated.status, 200, JSON.stringify(rotated.body));
    const [afterRotate] = await getDb().select({ web: machines.keyIssuedByWebSessionFamilyId }).from(machines).where(eq(machines.id, issued.legacy.machineId));
    assert.equal(afterRotate!.web, other.familyId);
  });
});

test("a password change revokes what the person's web sessions issued, closes it and audits each; another person's are untouched; a second run does nothing", async () => {
  await withApp(async (app) => {
    const { id: userId } = await seedUser();
    const stolen = await webSession(userId);
    const issued = await issueEverything(app, userId, stolen.bearer, "alpha");
    const { id: otherId } = await seedUser();
    const other = await webSession(otherId);
    const theirs = await issueEverything(app, otherId, other.bearer, "beta");
    assert.deepEqual(await stateOf(app, issued), ALL_LIVE);

    await captureClosures([issued.external.id, issued.viaToken.id, issued.laptopRunner.agentId, issued.legacyRunner.agentId, theirs.external.id], async (closed) => {
      await changePassword(userId, "password123", "a-new-password-456");
      assert.deepEqual(closed.drops.map(([machineId]) => machineId).sort(), [issued.laptop.machineId, issued.legacy.machineId].sort());
      assert.ok(closed.drops.every(([, reason]) => reason === "credential_revoked"));
      assert.deepEqual([...new Set(closed.signals)].sort(), [issued.external.id, issued.viaToken.id, issued.laptopRunner.agentId, issued.legacyRunner.agentId].sort());
    });
    assert.deepEqual(await stateOf(app, issued), ALL_REVOKED);
    assert.deepEqual(await stateOf(app, theirs), ALL_LIVE);
    // The token not yet exchanged is revoked: exchanging it now mints nothing.
    assert.deepEqual(await consumeAgentBootstrapToken(issued.pending.token), { ok: false, error: "token_revoked" });
    assert.ok((await consumeAgentBootstrapToken(theirs.pending.token)).ok);

    const targets = [issued.key.credentialId, issued.exchanged.credentialId, issued.laptop.serverMachineId, issued.laptopRunner.credentialId, issued.legacy.machineId, issued.legacyRunner.credentialId];
    const audits = await getDb()
      .select({ type: integrationAuditEvents.eventType, targetId: integrationAuditEvents.targetId, actorType: integrationAuditEvents.actorType, requesterId: integrationAuditEvents.requesterId, metadata: integrationAuditEvents.metadata })
      .from(integrationAuditEvents)
      .where(inArray(integrationAuditEvents.targetId, targets));
    const revokes = audits.filter((audit) => audit.type === "computer.key_revoked" || audit.type === "agent_credential.revoked");
    assert.deepEqual(revokes.map((audit) => [audit.type, audit.targetId]).sort(), [
      ["agent_credential.revoked", issued.exchanged.credentialId],
      ["agent_credential.revoked", issued.key.credentialId],
      ["agent_credential.revoked", issued.laptopRunner.credentialId],
      ["agent_credential.revoked", issued.legacyRunner.credentialId],
      ["computer.key_revoked", issued.laptop.serverMachineId],
      ["computer.key_revoked", issued.legacy.machineId],
    ].sort());
    for (const audit of revokes) {
      assert.equal(audit.actorType, "system");
      assert.equal(audit.requesterId, userId);
      assert.equal(audit.metadata.via, "web_session_revoked");
      assert.equal(audit.metadata.trigger, "password_change");
    }
    const reasons = await getDb().select({ id: agentCredentials.id, reason: agentCredentials.revokedReason }).from(agentCredentials)
      .where(inArray(agentCredentials.id, [issued.key.credentialId, issued.exchanged.credentialId]));
    assert.deepEqual(reasons.map((row) => row.reason), ["web_session_revoked", "web_session_revoked"]);
    // The discarded legacy key's machine is no longer marked: nothing left to follow.
    const [legacy] = await getDb().select({ web: machines.keyIssuedByWebSessionFamilyId }).from(machines).where(eq(machines.id, issued.legacy.machineId));
    assert.equal(legacy!.web, null);

    assert.deepEqual(await revokeWhatRevokedWebSessionsIssued({ userId }, "password_change"), { bootstrapTokens: 0, computers: 0, machines: 0, credentials: 0 });
    const again = await getDb().select({ id: integrationAuditEvents.id }).from(integrationAuditEvents).where(inArray(integrationAuditEvents.targetId, targets));
    assert.equal(again.length, audits.length);
  });
});

test("signing the issuing session out leaves what it issued live, and doesn't let it escape a later password change", async () => {
  await withApp(async (app) => {
    const { id: userId } = await seedUser();
    const stolen = await webSession(userId);
    const issued = await issueEverything(app, userId, stolen.bearer, "alpha");
    await captureClosures([issued.external.id, issued.laptopRunner.agentId], async (closed) => {
      assert.equal((await post(app, "/api/auth/logout", { refreshToken: stolen.refreshToken })).status, 200);
      assert.deepEqual(closed.drops, [], "the machines stay connected");
      assert.deepEqual(closed.signals, []);
    });
    const [family] = await getDb().select({ revokedReason: sessionFamilies.revokedReason }).from(sessionFamilies).where(eq(sessionFamilies.id, stolen.familyId));
    assert.equal(family!.revokedReason, "logout");
    assert.deepEqual(await stateOf(app, issued), ALL_LIVE);
    // Maintenance never reaches a session only signed out.
    assert.deepEqual(await revokeWhatRevokedWebSessionsIssued("security_revoked", "repair"), { bootstrapTokens: 0, computers: 0, machines: 0, credentials: 0 });
    assert.deepEqual(await stateOf(app, issued), ALL_LIVE);

    await changePassword(userId, "password123", "a-new-password-456");
    assert.deepEqual(await stateOf(app, issued), ALL_REVOKED);
  });
});

test("a revoke scoped to one family leaves what another session of the person issued", async () => {
  await withApp(async (app) => {
    const { id: userId } = await seedUser();
    const first = await webSession(userId);
    const second = await webSession(userId);
    const fromFirst = await issueEverything(app, userId, first.bearer, "alpha");
    const fromSecond = await issueEverything(app, userId, second.bearer, "beta");
    await getDb().update(sessionFamilies).set({ revokedAt: new Date(), revokedReason: "device_login_revoked" }).where(eq(sessionFamilies.id, first.familyId));
    assert.deepEqual(await revokeWhatRevokedWebSessionsIssued({ familyId: first.familyId }, "device_login_revoked"), { bootstrapTokens: 1, computers: 1, machines: 1, credentials: 2 });
    assert.deepEqual(await stateOf(app, fromFirst), ALL_REVOKED);
    assert.deepEqual(await stateOf(app, fromSecond), ALL_LIVE);
    // A family that isn't revoked is never followed, even when named.
    assert.deepEqual(await revokeWhatRevokedWebSessionsIssued({ familyId: second.familyId }, "device_login_revoked"), { bootstrapTokens: 0, computers: 0, machines: 0, credentials: 0 });
    assert.deepEqual(await stateOf(app, fromSecond), ALL_LIVE);
  });
});

test("a token with no family issues nothing; keys issued before the column never cascade, and nothing errors", async () => {
  await withApp(async (app) => {
    const { id: userId } = await seedUser();
    const web = await webSession(userId);
    const beforeColumn = await issueEverything(app, userId, web.bearer, "beta");
    // A token with no family, as signed before session families existed, no longer authenticates at all.
    const legacyBearer = jwt.sign({ sub: userId, type: "access" }, process.env.JWT_SECRET!, { expiresIn: "15m" });
    const serverHeader = { "X-Server-Id": beforeColumn.server.id };
    assert.equal((await post(app, `/api/agents/${beforeColumn.external.id}/credentials`, {}, legacyBearer)).status, 401);
    assert.equal((await post(app, `/api/agents/${beforeColumn.viaToken.id}/bootstrap-tokens`, {}, legacyBearer, serverHeader)).status, 401);
    assert.equal((await post(app, "/api/computer/attach", { serverSlug: beforeColumn.server.slug, name: "legacy-laptop" }, legacyBearer)).status, 401);
    assert.equal((await post(app, `/api/servers/${beforeColumn.server.id}/machines`, { name: "legacy-machine" }, legacyBearer, serverHeader)).status, 401);
    // As written by a server from before the columns.
    await getDb().update(agentCredentials).set({ issuedByWebSessionFamilyId: null });
    await getDb().update(computers).set({ keyIssuedByWebSessionFamilyId: null });
    await getDb().update(machines).set({ keyIssuedByWebSessionFamilyId: null });
    await getDb().update(agentBootstrapTokens).set({ issuedByWebSessionFamilyId: null });
    const errors: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => { errors.push(args); originalError(...args); };
    try {
      await changePassword(userId, "password123", "a-new-password-456");
    } finally {
      console.error = originalError;
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(await stateOf(app, beforeColumn), ALL_LIVE);
    assert.ok((await consumeAgentBootstrapToken(beforeColumn.pending.token)).ok);
  });
});

test("a device login's session is unchanged: it records only the device-session column, and its keys still go with any revoke of it", async () => {
  await withApp(async (app) => {
    const { id: userId } = await seedUser();
    const server = await createServer("Alpha Co", `alpha-${randomUUID()}`, userId);
    const external = await createAgent(server.id, "outside-agent", { runtime: "external" });
    const device = await createSession(await proofForDeviceLogin(userId, null), undefined, { scope: "device" });
    const deviceBearer = signAccessToken(userId, device.familyId);
    const key = await mintAgentKey(app, deviceBearer, external.id);
    const laptop = await attachWithSession(app, deviceBearer, server.slug, "device-laptop");
    const [credential] = await getDb().select({ web: agentCredentials.issuedByWebSessionFamilyId, device: agentCredentials.issuedBySessionFamilyId })
      .from(agentCredentials).where(eq(agentCredentials.id, key.credentialId));
    assert.deepEqual(credential, { web: null, device: device.familyId });
    const [computer] = await getDb().select({ web: computers.keyIssuedByWebSessionFamilyId, device: computers.keyIssuedBySessionFamilyId })
      .from(computers).where(eq(computers.id, laptop.serverMachineId));
    assert.deepEqual(computer, { web: null, device: device.familyId });
    // A device session can't use the other web routes.
    assert.equal((await post(app, `/api/servers/${server.id}/machines`, { name: "nope" }, deviceBearer, { "X-Server-Id": server.id })).status, 403);

    // Signing it out (not a security revoke) still revokes them, as before.
    assert.equal((await post(app, "/api/auth/logout", { refreshToken: device.refreshToken })).status, 200);
    assert.equal(await agentKeyState(app, key.apiKey), "revoked");
    assert.equal(await computerState(laptop), "computer_revoked");
    const [revoked] = await getDb().select({ reason: agentCredentials.revokedReason }).from(agentCredentials).where(eq(agentCredentials.id, key.credentialId));
    assert.equal(revoked!.reason, "device_login_revoked");
  });
});

test("maintenance repairs a password change whose cascade failed after it committed", async () => {
  await withApp(async (app) => {
    const { id: userId } = await seedUser();
    const stolen = await webSession(userId);
    const issued = await issueEverything(app, userId, stolen.bearer, "alpha");
    // As if the cascade had failed: the families are revoked, everything is still live.
    await getDb().update(sessionFamilies).set({ revokedAt: new Date(), revokedReason: "revoke_all" }).where(eq(sessionFamilies.userId, userId));
    assert.deepEqual(await stateOf(app, issued), ALL_LIVE);
    assert.deepEqual(await revokeWhatRevokedWebSessionsIssued("security_revoked", "repair"), { bootstrapTokens: 1, computers: 1, machines: 1, credentials: 2 });
    assert.deepEqual(await stateOf(app, issued), ALL_REVOKED);
    const [audit] = await getDb().select({ metadata: integrationAuditEvents.metadata }).from(integrationAuditEvents)
      .where(and(eq(integrationAuditEvents.eventType, "computer.key_revoked"), eq(integrationAuditEvents.targetId, issued.laptop.serverMachineId)));
    assert.equal(audit!.metadata.trigger, "repair");
  });
});

test("a session revoked after its request was authenticated issues nothing: the issue fences its family", async () => {
  await withApp(async (app) => {
    const { id: userId } = await seedUser();
    const server = await createServer("Alpha Co", `alpha-${randomUUID()}`, userId);
    const web = await webSession(userId);
    assert.equal((await post(app, "/api/auth/logout", { refreshToken: web.refreshToken })).status, 200);
    await assert.rejects(
      registerMachine(server.id, userId, "late", { capability: "registerMachines", webSessionFamilyId: web.familyId }),
      DeviceSessionRevokedError,
    );
    assert.equal((await getDb().select({ id: machines.id }).from(machines).where(eq(machines.serverId, server.id))).length, 0);
  });
});

// --- The session that changes the password keeps what it issued; one email per cascade ---

/** PATCH /api/auth/me with the current password, as the web's Change Password does. */
async function changePasswordFrom(app: App, bearer: string) {
  const res = await fetch(`${app.baseUrl}/api/auth/me`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ currentPassword: "password123", newPassword: "a-new-password-456" }),
  });
  assert.equal(res.status, 200, await res.text());
}

async function resetThePassword(userId: string) {
  const token = randomUUID();
  await getDb().insert(passwordResets).values({
    userId, tokenHash: createHash("sha256").update(token).digest("hex"), expiresAt: new Date(Date.now() + 60_000),
  });
  assert.deepEqual(await resetPassword(token, "a-third-password-789"), { success: true, userId });
}

const revokeNotices = (mailbox: EmailDelivery[]) => mailbox.filter((mail) => /disconnected|revoked/.test(mail.subject));

test("the session that changes the password keeps what it issued; every other session's, signed out ones too, is revoked; the repair keeps the exemption; a reset later takes it", async () => {
  await withApp(async (app) => {
    const { id: userId } = await seedUser();
    const changing = await webSession(userId);
    const other = await webSession(userId);
    const signedOut = await webSession(userId);
    const fromChanging = await issueEverything(app, userId, changing.bearer, "alpha");
    const fromOther = await issueEverything(app, userId, other.bearer, "beta");
    const fromSignedOut = await issueEverything(app, userId, signedOut.bearer, "gamma");
    assert.equal((await post(app, "/api/auth/logout", { refreshToken: signedOut.refreshToken })).status, 200);

    await changePasswordFrom(app, changing.bearer);
    assert.deepEqual(await stateOf(app, fromChanging), ALL_LIVE);
    assert.deepEqual(await stateOf(app, fromOther), ALL_REVOKED);
    assert.deepEqual(await stateOf(app, fromSignedOut), ALL_REVOKED);
    assert.ok((await consumeAgentBootstrapToken(fromChanging.pending.token)).ok, "its pending token still exchanges");
    // It is signed out like the others, with its own reason.
    const families = new Map((await getDb().select({ id: sessionFamilies.id, reason: sessionFamilies.revokedReason }).from(sessionFamilies)
      .where(eq(sessionFamilies.userId, userId))).map((row) => [row.id, row.reason]));
    assert.equal(families.get(changing.familyId), "password_changed");
    assert.equal(families.get(other.familyId), "revoke_all");

    // The hourly repair can't tell who changed it, but reads the reason.
    assert.deepEqual(await revokeWhatRevokedWebSessionsIssued("security_revoked", "repair"), { bootstrapTokens: 0, computers: 0, machines: 0, credentials: 0 });
    assert.deepEqual(await stateOf(app, fromChanging), ALL_LIVE);

    // A reset names no session: everything goes, the earlier exemption included.
    await resetThePassword(userId);
    assert.deepEqual(await stateOf(app, fromChanging), ALL_REVOKED);
  });
});

test("a password reset revokes what every session issued", async () => {
  await withApp(async (app) => {
    const { id: userId } = await seedUser();
    const live = await webSession(userId);
    const issued = await issueEverything(app, userId, live.bearer, "alpha");
    await resetThePassword(userId);
    assert.deepEqual(await stateOf(app, issued), ALL_REVOKED);
    const [audit] = await getDb().select({ metadata: integrationAuditEvents.metadata }).from(integrationAuditEvents)
      .where(and(eq(integrationAuditEvents.eventType, "computer.key_revoked"), eq(integrationAuditEvents.targetId, issued.laptop.serverMachineId)));
    assert.equal(audit!.metadata.trigger, "password_reset");
  });
});

test("one email per cascade that revoked anything, with the counts, names escaped; none when nothing was revoked, none on a rerun or the repair", async () => {
  await withApp(async (app, mailbox) => {
    const { id: userId } = await seedUser();
    await getDb().update(users).set({ displayName: "<b>Eve</b> & co" }).where(eq(users.id, userId));
    const changing = await webSession(userId);
    const other = await webSession(userId);
    const issued = await issueEverything(app, userId, other.bearer, "alpha");
    await getDb().update(servers).set({ name: "<script>x</script> Co" }).where(eq(servers.id, issued.server.id));
    // Someone with nothing to revoke changes theirs too: no email.
    const { id: idleId } = await seedUser();
    const idle = await webSession(idleId);
    await changePasswordFrom(app, idle.bearer);
    assert.deepEqual(revokeNotices(mailbox), []);

    await changePasswordFrom(app, changing.bearer);
    const notices = revokeNotices(mailbox);
    assert.equal(notices.length, 1);
    const [notice] = notices;
    const [user] = await getDb().select({ email: users.email }).from(users).where(eq(users.id, userId));
    assert.equal(notice!.to, user!.email);
    // The Computer and the legacy machine; the minted key and the bootstrapped one.
    assert.equal(notice!.subject, "2 computers disconnected, 2 agent keys revoked — Raft");
    assert.match(notice!.html, /2 computers were disconnected/);
    assert.match(notice!.html, /2 agent keys were revoked/);
    assert.match(notice!.html, /&lt;b&gt;Eve&lt;\/b&gt; &amp; co/);
    assert.match(notice!.html, /&lt;script&gt;x&lt;\/script&gt; Co/);
    assert.ok(!notice!.html.includes("<script>") && !notice!.html.includes("<b>Eve"));
    assert.ok(notice!.html.includes(`/s/${issued.server.slug}/computers`));
    assert.ok(notice!.text?.includes("Hey <b>Eve</b> & co,"));
    assert.ok(notice!.text?.includes("- 2 computers were disconnected"));
    assert.ok(notice!.text?.includes(`/s/${issued.server.slug}/computers`));

    await runSecurityRevokeCascade({ userId }, "password_change");
    await runSecurityRevokeCascade("security_revoked", "repair");
    assert.equal(revokeNotices(mailbox).length, 1);
  });
});
