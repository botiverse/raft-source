import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

import argon2 from "argon2";
import { and, eq, inArray, ne } from "drizzle-orm";
import jwt from "jsonwebtoken";

import { getDb } from "../db/index";
import { agentCredentials, agents, computerRevokeTokens, messages, computers, deviceAuthorizations, deviceLoginGrants, integrationAuditEvents, passwordResets, serverMembers, sessionFamilies, users } from "../db/schema";
import { findComputerByApiKeyWithReason } from "../services/computerCredentialService";
import { __setEmailDeliveryObserverForTests, type EmailDelivery } from "../services/emailService";
import { openTestApp } from "../test/integration/app";
import { signAccessToken } from "../middleware/auth";
import { createServer } from "../services/serverService";
import { createAgent } from "../services/agentService";
import * as channelService from "../services/channelService";
import { approveDeviceAuthorization, scrubDeviceAuthorizationRequesterDetails } from "../services/deviceAuthService";
import { computeTokenLookupHash, mintAgentCredential } from "../services/agentCredentialService";
import { subscribeAgentCredentialRevocation } from "../services/agentCredentialRevocationBus";
import { setMachineConnectionDropHandler, type MachineConnectionDropReason } from "../replicaRouter";
import { signInForTest } from "../test/integration/credentials";
import { changePassword, resetPassword, retireStagingSelfAccount } from "../services/userService";
import { revokeWhatRevokedSessionsApproved } from "../services/approverSessionGrants";
import { __setAgentCredentialMintRateLimitsForTests, AGENT_LIVE_HUMAN_CREDENTIALS_MAX } from "../services/agentCredentialMintLimits";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

// One-time device-login grants (device-auth design v2 §3.1, §3.4): a device
// login with `grant` gets an attach token (computer_attach) or an agent key
// (agent_key), once, for what the person explicitly picked; never a session.
// A login without `grant` is the legacy device session, unchanged
// (deviceAuth.api.test.ts covers that path in full).

const PEPPER = "device-code-test-pepper-0123456789abcdef";

async function withApp<T>(fn: (app: Awaited<ReturnType<typeof openTestApp>>, mailbox: EmailDelivery[]) => Promise<T>): Promise<T> {
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

type App = { baseUrl: string };

function jsonHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { "Content-Type": "application/json", ...extra };
}

async function seedUser(): Promise<{ id: string; bearer: string; familyId: string }> {
  const suffix = randomUUID();
  const [u] = await getDb().insert(users).values({
    email: `grant-${suffix}@slock.test`,
    name: `grant-${suffix}`,
    displayName: "Grant Tester",
    passwordHash: await argon2.hash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  const web = await signInForTest(u!.id);
  return { id: u!.id, bearer: web.token, familyId: web.familyId };
}

async function post(app: App, path: string, body: unknown, token?: string) {
  const res = await fetch(`${app.baseUrl}${path}`, {
    method: "POST",
    headers: jsonHeaders(token ? { Authorization: `Bearer ${token}` } : {}),
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, any> };
}

async function authorize(app: App, grant?: unknown) {
  const res = await post(app, "/api/auth/device/authorize", { clientName: "raft-computer", ...(grant === undefined ? {} : { grant }) });
  return res;
}

async function startGrant(app: App, grant: unknown) {
  const res = await authorize(app, grant);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body as { deviceCode: string; userCode: string };
}

async function describeCode(app: App, bearer: string, userCode: string) {
  const res = await post(app, "/api/auth/device/describe", { userCode }, bearer);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
}

async function approve(app: App, bearer: string, userCode: string, pick: { serverId?: string; agentId?: string } = {}) {
  const described = await describeCode(app, bearer, userCode);
  return post(app, "/api/auth/device/approve", { userCode, approvalTicket: described.approvalTicket, ...pick }, bearer);
}

async function poll(app: App, deviceCode: string) {
  return post(app, "/api/auth/device/token", { deviceCode });
}

async function attach(app: App, token: string, body: Record<string, unknown> = {}) {
  return post(app, "/api/computer/attach", body, token);
}

async function grantRow(deviceCodeUserCode: string) {
  const [row] = await getDb()
    .select({
      id: deviceLoginGrants.id,
      status: deviceLoginGrants.status,
      serverId: deviceLoginGrants.serverId,
      agentId: deviceLoginGrants.agentId,
      approverUserId: deviceLoginGrants.approverUserId,
      expiresAt: deviceLoginGrants.expiresAt,
      approvedAt: deviceLoginGrants.approvedAt,
      consumedAt: deviceLoginGrants.consumedAt,
      consumedComputerId: deviceLoginGrants.consumedComputerId,
      consumedAgentCredentialId: deviceLoginGrants.consumedAgentCredentialId,
      machineName: deviceLoginGrants.machineName,
      requestedUserAgent: deviceLoginGrants.requestedUserAgent,
    })
    .from(deviceLoginGrants)
    .innerJoin(deviceAuthorizations, eq(deviceAuthorizations.id, deviceLoginGrants.deviceAuthorizationId))
    .where(eq(deviceAuthorizations.userCode, deviceCodeUserCode));
  return row;
}

/** The person's session families other than their own web sign-in (seedUser's). */
async function deviceFamilies(userId: string, webFamilyId: string) {
  return getDb().select({ id: sessionFamilies.id }).from(sessionFamilies)
    .where(and(eq(sessionFamilies.userId, userId), ne(sessionFamilies.id, webFamilyId)));
}

async function mailCount(mailbox: EmailDelivery[], count: number) {
  for (let i = 0; i < 100 && mailbox.length < count; i += 1) await new Promise((r) => setTimeout(r, 20));
  assert.equal(mailbox.length, count);
}

async function addMember(serverId: string, userId: string, role: "admin" | "member") {
  await getDb().insert(serverMembers).values({ serverId, userId, role });
}

const ATTACH = { kind: "computer_attach", machineName: "Maria's laptop", hostname: "maria-mbp", os: "macOS" };

test("a login without grant is still a device session, and records no grant", async () => {
  await withApp(async (app) => {
    const { bearer } = await seedUser();
    const login = await startGrant(app, undefined);
    const described = await describeCode(app, bearer, login.userCode);
    assert.equal("grant" in described, false);
    const approved = await approve(app, bearer, login.userCode);
    assert.equal(approved.status, 200);
    const token = await poll(app, login.deviceCode);
    assert.equal(token.status, 200);
    assert.ok(token.body.accessToken && token.body.refreshToken);
    assert.equal("attachToken" in token.body, false);
    assert.equal((await getDb().select({ id: deviceLoginGrants.id }).from(deviceLoginGrants)).length, 0);
  });
});

test("authorize refuses a malformed grant, and an unknown kind as unsupported", async () => {
  await withApp(async (app) => {
    for (const grant of ["attach", [], {}, { kind: 5 }, { kind: "computer_attach", machineName: 5 }, { kind: "computer_attach", agentId: randomUUID() }, { kind: "agent_key", agentId: "not-a-uuid" }]) {
      const res = await authorize(app, grant);
      assert.equal(res.status, 400, JSON.stringify(grant));
      assert.equal(res.body.code, "grant_invalid");
    }
    // A kind the server does not know (a newer client), including the retired computer_adopt.
    for (const kind of ["session", "computer_adopt", "computer_future"]) {
      const res = await authorize(app, { kind });
      assert.equal(res.status, 400, kind);
      assert.equal(res.body.code, "grant_kind_unsupported", kind);
    }
    assert.equal((await getDb().select({ id: deviceAuthorizations.id }).from(deviceAuthorizations)).length, 0);
  });
});

test("computer_attach: the person picks a server they may add machines to; the token phase returns an attach token once, no session", async () => {
  await withApp(async (app, mailbox) => {
    const { id: userId, bearer, familyId: webFamilyId } = await seedUser();
    const owned = await createServer("Alpha Co", `alpha-${randomUUID()}`, userId);
    const other = await createServer("Beta Co", `beta-${randomUUID()}`, userId);
    const { id: strangerId } = await seedUser();
    const memberOnly = await createServer("Gamma Co", `gamma-${randomUUID()}`, strangerId);
    await addMember(memberOnly.id, userId, "member");
    const notMine = await createServer("Delta Co", `delta-${randomUUID()}`, strangerId);

    const login = await startGrant(app, ATTACH);
    const pendingRow = await grantRow(login.userCode);
    assert.equal(pendingRow?.status, "pending");
    assert.equal(pendingRow?.machineName, "Maria's laptop");

    const described = await describeCode(app, bearer, login.userCode);
    assert.equal(described.grant.kind, "computer_attach");
    assert.equal(described.grant.machineName, "Maria's laptop");
    assert.equal(described.grant.hostname, "maria-mbp");
    assert.equal(described.grant.os, "macOS");
    // Only where the person has registerMachines; never pre-picked.
    assert.deepEqual((described.grant.servers as Array<{ id: string }>).map((s) => s.id).sort(), [owned.id, other.id].sort());

    // No pick: refused, even though the person could pick. Still pending.
    const noPick = await approve(app, bearer, login.userCode);
    assert.equal(noPick.status, 400);
    assert.equal(noPick.body.code, "grant_selection_required");
    assert.equal((await poll(app, login.deviceCode)).body.code, "authorization_pending");

    // A server where they are only a member, one they're not in, one that doesn't exist.
    for (const serverId of [memberOnly.id, notMine.id, randomUUID()]) {
      const refused = await approve(app, bearer, login.userCode, { serverId });
      assert.equal(refused.status, 403);
      assert.equal(refused.body.code, "grant_selection_not_allowed");
    }

    const approved = await approve(app, bearer, login.userCode, { serverId: owned.id });
    assert.equal(approved.status, 200);
    const row = await grantRow(login.userCode);
    assert.equal(row?.status, "approved");
    assert.equal(row?.serverId, owned.id);
    assert.equal(row?.approverUserId, userId);
    assert.equal(row!.expiresAt!.getTime() - row!.approvedAt!.getTime(), 10 * 60_000);
    // A one-time grant mails when it is used, not at approval.
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(mailbox.length, 0);

    const token = await poll(app, login.deviceCode);
    assert.equal(token.status, 200);
    assert.equal(token.body.kind, "computer_attach");
    assert.match(token.body.attachToken, /^dvat_/);
    assert.equal(token.body.serverId, owned.id);
    assert.equal(token.body.serverSlug, owned.slug);
    assert.ok(token.body.expiresIn > 0 && token.body.expiresIn <= 600);
    assert.equal("accessToken" in token.body, false);
    assert.equal("refreshToken" in token.body, false);
    assert.equal((await deviceFamilies(userId, webFamilyId)).length, 0, "no session");
    // Once.
    const again = await poll(app, login.deviceCode);
    assert.equal(again.status, 410);
    assert.equal(again.body.code, "device_code_consumed");
  });
});

test("an attach token attaches once, to its server only, as the approver; the key records the grant", async () => {
  await withApp(async (app, mailbox) => {
    const { id: userId, bearer } = await seedUser();
    const owned = await createServer("Alpha Co", `alpha-${randomUUID()}`, userId);
    const other = await createServer("Beta Co", `beta-${randomUUID()}`, userId);
    const login = await startGrant(app, ATTACH);
    assert.equal((await approve(app, bearer, login.userCode, { serverId: owned.id })).status, 200);
    const { attachToken } = (await poll(app, login.deviceCode)).body as { attachToken: string };

    // Another server: refused, token still good.
    const wrong = await attach(app, attachToken, { serverSlug: other.slug });
    assert.equal(wrong.status, 403);
    assert.equal(wrong.body.code, "attach_token_server_mismatch");
    // Not a token at all.
    const garbage = await attach(app, `dvat_${randomUUID()}`);
    assert.equal(garbage.status, 401);
    assert.equal(garbage.body.code, "attach_token_invalid");

    // Two at once: exactly one attaches. A name the client sends is ignored:
    // the Computer gets the name the approver saw.
    const [first, second] = await Promise.all([
      attach(app, attachToken, { serverSlug: owned.slug, name: "Not what you approved" }),
      attach(app, attachToken, { name: "Not what you approved" }),
    ]);
    const statuses = [first.status, second.status].sort();
    assert.deepEqual(statuses, [201, 410]);
    const won = first.status === 201 ? first : second;
    const lost = first.status === 201 ? second : first;
    assert.equal(lost.body.code, "attach_token_consumed");
    assert.equal(won.body.serverId, owned.id);
    assert.match(won.body.apiKey, /^sk_computer_/);

    const row = await grantRow(login.userCode);
    assert.equal(row?.status, "consumed");
    assert.ok(row?.consumedAt);
    assert.equal(row?.consumedComputerId, won.body.serverMachineId);
    const [computer] = await getDb()
      .select({ grantId: computers.keyIssuedByGrantId, family: computers.keyIssuedBySessionFamilyId, by: computers.attachedByUserId, name: computers.name, serverId: computers.serverId })
      .from(computers).where(eq(computers.id, won.body.serverMachineId));
    assert.deepEqual(computer, { grantId: row!.id, family: null, by: userId, name: "Maria's laptop", serverId: owned.id });
    const auth = await findComputerByApiKeyWithReason(won.body.apiKey);
    assert.equal(auth.ok, true);
    assert.equal((await getDb().select({ id: computers.id }).from(computers)).length, 1);

    // Reuse after the fact.
    const reused = await attach(app, attachToken);
    assert.equal(reused.status, 410);
    assert.equal(reused.body.code, "attach_token_consumed");

    // The approver is told what they added, where.
    await mailCount(mailbox, 1);
    const [user] = await getDb().select({ email: users.email }).from(users).where(eq(users.id, userId));
    assert.equal(mailbox[0]!.to, user!.email);
    assert.equal(mailbox[0]!.subject, "You added a machine to Alpha Co — Raft");
    assert.ok(mailbox[0]!.html.includes("You added Maria&#39;s laptop to Alpha Co") || mailbox[0]!.html.includes("You added Maria's laptop to Alpha Co"), mailbox[0]!.html);
    // With a one-time link that revokes this Computer only (not a device login's dvr_ link).
    assert.match(mailbox[0]!.html, /\?revoke_device_login=dvcr_/);
    assert.equal(mailbox[0]!.html.includes("revoke_device_login=dvr_"), false);
    assert.ok(mailbox[0]!.html.includes("Revoke This Machine"));
    assert.equal(mailbox[0]!.html.includes("Not what you approved"), false);
  });
});

test("an attach token is refused once expired, and a grant that expired before the poll hands out none", async () => {
  await withApp(async (app) => {
    const { bearer, id: userId } = await seedUser();
    const owned = await createServer("Alpha Co", `alpha-${randomUUID()}`, userId);

    const login = await startGrant(app, ATTACH);
    await approve(app, bearer, login.userCode, { serverId: owned.id });
    const { attachToken } = (await poll(app, login.deviceCode)).body as { attachToken: string };
    await getDb().update(deviceLoginGrants).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(deviceLoginGrants.id, (await grantRow(login.userCode))!.id));
    const expired = await attach(app, attachToken);
    assert.equal(expired.status, 410);
    assert.equal(expired.body.code, "attach_token_expired");
    assert.equal((await grantRow(login.userCode))?.status, "expired");
    assert.equal((await getDb().select({ id: computers.id }).from(computers)).length, 0);

    const late = await startGrant(app, ATTACH);
    await approve(app, bearer, late.userCode, { serverId: owned.id });
    await getDb().update(deviceLoginGrants).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(deviceLoginGrants.id, (await grantRow(late.userCode))!.id));
    const polled = await poll(app, late.deviceCode);
    assert.equal(polled.status, 410);
    assert.equal(polled.body.code, "expired_token");
    assert.equal(polled.body.error, "This device login can't be completed. Start it again.");
    assert.equal("attachToken" in polled.body, false);
  });
});

test("an attach token stops working when its approver loses the right to add machines", async () => {
  await withApp(async (app) => {
    const { id: ownerId } = await seedUser();
    const server = await createServer("Alpha Co", `alpha-${randomUUID()}`, ownerId);
    const { id: adminId, bearer } = await seedUser();
    await addMember(server.id, adminId, "admin");
    const login = await startGrant(app, ATTACH);
    assert.equal((await approve(app, bearer, login.userCode, { serverId: server.id })).status, 200);
    const { attachToken } = (await poll(app, login.deviceCode)).body as { attachToken: string };

    await getDb().update(serverMembers).set({ role: "member" }).where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, adminId)));
    const refused = await attach(app, attachToken);
    assert.equal(refused.status, 403);
    assert.equal(refused.body.code, "requires_admin");
    assert.equal((await grantRow(login.userCode))?.status, "approved", "not consumed by a refused attach");
    assert.equal((await getDb().select({ id: computers.id }).from(computers)).length, 0);
  });
});

test("agent_key: the person picks an external agent they may key; the token phase returns sk_agent once, then consumed", async () => {
  await withApp(async (app, mailbox) => {
    const { id: userId, bearer, familyId: webFamilyId } = await seedUser();
    const server = await createServer("Alpha Co", `alpha-${randomUUID()}`, userId);
    const external = await createAgent(server.id, "outside-agent", { runtime: "external" });
    const managed = await createAgent(server.id, "inside-agent");

    const login = await startGrant(app, { kind: "agent_key", machineName: "ci-runner", agentId: external.id });
    const described = await describeCode(app, bearer, login.userCode);
    assert.equal(described.grant.kind, "agent_key");
    assert.equal(described.grant.requestedAgentId, external.id);
    assert.deepEqual((described.grant.agents as Array<{ id: string }>).map((a) => a.id), [external.id], "managed agents are not keyable");

    // The hint is not a pick.
    const noPick = await approve(app, bearer, login.userCode);
    assert.equal(noPick.status, 400);
    assert.equal(noPick.body.code, "grant_selection_required");
    const managedPick = await approve(app, bearer, login.userCode, { agentId: managed.id });
    assert.equal(managedPick.status, 403);
    assert.equal(managedPick.body.code, "grant_selection_not_allowed");

    assert.equal((await approve(app, bearer, login.userCode, { agentId: external.id })).status, 200);
    const row = await grantRow(login.userCode);
    assert.equal(row?.agentId, external.id);
    assert.equal(row?.serverId, server.id);

    const token = await poll(app, login.deviceCode);
    assert.equal(token.status, 200, JSON.stringify(token.body));
    assert.equal(token.body.kind, "agent_key");
    assert.match(token.body.apiKey, /^sk_agent_/);
    assert.equal(token.body.agentId, external.id);
    assert.equal("accessToken" in token.body, false);
    assert.equal((await deviceFamilies(userId, webFamilyId)).length, 0, "no session");
    const agentApi = await fetch(`${app.baseUrl}/internal/agent-api/`, { headers: { Authorization: `Bearer ${token.body.apiKey}` } });
    assert.equal(agentApi.status, 200);

    const again = await poll(app, login.deviceCode);
    assert.equal(again.status, 410);
    assert.equal(again.body.code, "device_code_consumed");
    assert.equal("apiKey" in again.body, false);

    const consumed = await grantRow(login.userCode);
    assert.equal(consumed?.status, "consumed");
    assert.equal(consumed?.consumedAgentCredentialId, token.body.credentialId);
    const [credential] = await getDb()
      .select({ createdBy: agentCredentials.createdByUserId, family: agentCredentials.issuedBySessionFamilyId })
      .from(agentCredentials).where(eq(agentCredentials.id, token.body.credentialId));
    assert.deepEqual(credential, { createdBy: userId, family: null });
    const audits = await getDb().select({ type: integrationAuditEvents.eventType }).from(integrationAuditEvents)
      .where(eq(integrationAuditEvents.targetId, token.body.credentialId));
    assert.deepEqual(audits.map((a) => a.type), ["agent_credential.issued"]);

    await mailCount(mailbox, 1);
    assert.equal(mailbox[0]!.subject, "You gave an agent a key — Raft");
    assert.ok(mailbox[0]!.html.includes("outside-agent"));
  });
});

test("agent_key: a person without authority over the agent can't pick it, and a key isn't minted after authority is lost", async () => {
  await withApp(async (app) => {
    const { id: ownerId } = await seedUser();
    const server = await createServer("Alpha Co", `alpha-${randomUUID()}`, ownerId);
    const agent = await createAgent(server.id, "outside-agent", { runtime: "external" });
    const { id: memberId, bearer: memberBearer } = await seedUser();
    await addMember(server.id, memberId, "member");

    const login = await startGrant(app, { kind: "agent_key" });
    assert.deepEqual((await describeCode(app, memberBearer, login.userCode)).grant.agents, []);
    const refused = await approve(app, memberBearer, login.userCode, { agentId: agent.id });
    assert.equal(refused.status, 403);
    assert.equal(refused.body.code, "grant_selection_not_allowed");

    const { id: adminId, bearer: adminBearer } = await seedUser();
    await addMember(server.id, adminId, "admin");
    assert.equal((await approve(app, adminBearer, login.userCode, { agentId: agent.id })).status, 200);
    await getDb().update(serverMembers).set({ role: "member" }).where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, adminId)));
    const token = await poll(app, login.deviceCode);
    assert.equal(token.status, 403);
    assert.equal(token.body.code, "access_denied");
    assert.equal((await getDb().select({ id: agentCredentials.id }).from(agentCredentials).where(eq(agentCredentials.agentId, agent.id))).length, 0);
  });
});

test("agent_key: at the agent's live-key cap the token phase is refused 409 and ends the login, the grant rolled back like a refused permission", async () => {
  await withApp(async (app) => {
    const { id: userId, bearer } = await seedUser();
    const server = await createServer("Alpha Co", `alpha-${randomUUID()}`, userId);
    const agent = await createAgent(server.id, "outside-agent", { runtime: "external" });
    await getDb().insert(agentCredentials).values(Array.from({ length: AGENT_LIVE_HUMAN_CREDENTIALS_MAX }, (_, i) => ({
      agentId: agent.id, apiKeyHash: "seeded", apiKeyPrefix: `sk_agent_seed${i}`, scopes: ["read"], issuedVia: "human" as const, createdByUserId: userId,
    })));

    const login = await startGrant(app, { kind: "agent_key" });
    assert.equal((await approve(app, bearer, login.userCode, { agentId: agent.id })).status, 200);
    const token = await poll(app, login.deviceCode);
    assert.equal(token.status, 409, JSON.stringify(token.body));
    assert.equal(token.body.code, "agent_credential_limit_reached");
    assert.match(token.body.error, /already has 50 active keys/);
    assert.equal("apiKey" in token.body, false);
    const row = await grantRow(login.userCode);
    assert.equal(row?.status, "approved", "the grant's consume rolled back with the mint");
    assert.equal(row?.consumedAgentCredentialId, null);
    assert.equal((await getDb().select({ id: agentCredentials.id }).from(agentCredentials).where(eq(agentCredentials.agentId, agent.id))).length, AGENT_LIVE_HUMAN_CREDENTIALS_MAX);
    const again = await poll(app, login.deviceCode);
    assert.equal(again.status, 410);
    assert.equal(again.body.code, "device_code_consumed");
  });
});

test("agent_key: approving spends the person's and the agent's mint budget; past it approve is refused 429 and the code stays pending", async () => {
  await withApp(async (app) => {
    __setAgentCredentialMintRateLimitsForTests({ perUser: 100, perAgent: 1 });
    try {
      const { id: userId, bearer } = await seedUser();
      const server = await createServer("Alpha Co", `alpha-${randomUUID()}`, userId);
      const agent = await createAgent(server.id, "outside-agent", { runtime: "external" });
      await agentKeyByGrant(app, bearer, agent.id);

      const login = await startGrant(app, { kind: "agent_key" });
      const refused = await approve(app, bearer, login.userCode, { agentId: agent.id });
      assert.equal(refused.status, 429, JSON.stringify(refused.body));
      assert.equal(refused.body.code, "agent_credential_mint_rate_limited");
      assert.ok(refused.body.retryAfterSeconds > 0);
      assert.equal((await grantRow(login.userCode))?.status, "pending", "the person can approve again later");

      __setAgentCredentialMintRateLimitsForTests({ perUser: 100, perAgent: 100 });
      assert.equal((await approve(app, bearer, login.userCode, { agentId: agent.id })).status, 200);
      assert.equal((await poll(app, login.deviceCode)).status, 200);
    } finally {
      __setAgentCredentialMintRateLimitsForTests(null);
    }
  });
});

test("denying a grant request leaves nothing to collect", async () => {
  await withApp(async (app) => {
    const { bearer } = await seedUser();
    const login = await startGrant(app, ATTACH);
    const denied = await post(app, "/api/auth/device/approve", { userCode: login.userCode, approve: false }, bearer);
    assert.equal(denied.status, 200);
    assert.equal((await grantRow(login.userCode))?.status, "denied");
    const token = await poll(app, login.deviceCode);
    assert.equal(token.status, 403);
    assert.equal(token.body.code, "access_denied");
  });
});

test("a grant keeps who asked (user agent) and clears it after 30 days with the login's other details", async () => {
  await withApp(async (app) => {
    const res = await fetch(`${app.baseUrl}/api/auth/device/authorize`, {
      method: "POST",
      headers: jsonHeaders({ "User-Agent": "raft-computer/1.0 (darwin)" }),
      body: JSON.stringify({ grant: ATTACH }),
    });
    assert.equal(res.status, 201);
    const { userCode } = (await res.json()) as { userCode: string };
    assert.equal((await grantRow(userCode))?.requestedUserAgent, "raft-computer/1.0 (darwin)");
    // Kept on the grant only, not also on its authorization.
    const [authorization] = await getDb()
      .select({ requestedUserAgent: deviceAuthorizations.requestedUserAgent })
      .from(deviceAuthorizations)
      .where(eq(deviceAuthorizations.userCode, userCode));
    assert.equal(authorization?.requestedUserAgent, null);
    await getDb().update(deviceLoginGrants).set({ createdAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000) });
    await scrubDeviceAuthorizationRequesterDetails();
    assert.equal((await grantRow(userCode))?.requestedUserAgent, null);
  });
});

// --- Per-Computer revoke (device-auth design v2 §3.1 step 6) ---

type AttachedComputer = { apiKey: string; serverMachineId: string; machineId: string; revokeToken: string };

/** A Computer added through a one-time grant, its "You added X to Y" email's revoke token included. */
async function attachByGrant(app: App, mailbox: EmailDelivery[], bearer: string, serverId: string, machineName: string): Promise<AttachedComputer> {
  const login = await startGrant(app, { ...ATTACH, machineName });
  assert.equal((await approve(app, bearer, login.userCode, { serverId })).status, 200);
  const { attachToken } = (await poll(app, login.deviceCode)).body as { attachToken: string };
  const mails = mailbox.length;
  const attached = await attach(app, attachToken);
  assert.equal(attached.status, 201, JSON.stringify(attached.body));
  await mailCount(mailbox, mails + 1);
  const token = mailbox.at(-1)!.html.match(/revoke_device_login=(dvcr_[A-Za-z0-9_-]+)/)?.[1];
  assert.ok(token, "the email carries this Computer's revoke link");
  return { ...(attached.body as Omit<AttachedComputer, "revokeToken">), revokeToken: token };
}

/** An agent on the Computer's machine and the runner credential the Computer minted for it. */
async function runnerOn(app: App, serverId: string, computer: AttachedComputer, name: string, creatorId?: string) {
  const agent = await createAgent(serverId, name, { runtime: "external", ...(creatorId ? { creatorType: "user" as const, creatorId } : {}) });
  await getDb().update(agents).set({ machineId: computer.machineId }).where(eq(agents.id, agent.id));
  const minted = await post(app, `/internal/computer/runners/${agent.id}/credentials`, {}, computer.apiKey);
  assert.equal(minted.status, 201, JSON.stringify(minted.body));
  return { agentId: agent.id, apiKey: minted.body.apiKey as string, credentialId: minted.body.credentialId as string };
}

async function keyState(app: App, computer: AttachedComputer, runner: { apiKey: string }) {
  const auth = await findComputerByApiKeyWithReason(computer.apiKey);
  const agentApi = await fetch(`${app.baseUrl}/internal/agent-api/`, { headers: { Authorization: `Bearer ${runner.apiKey}` } });
  return { computer: auth.ok ? "live" : auth.reason, runner: agentApi.status === 200 ? "live" : agentApi.status === 401 ? "revoked" : `status:${agentApi.status}` };
}

async function revokeLink(app: App, token: unknown) {
  return post(app, "/api/auth/device/revoke", { token });
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

const LIVE = { computer: "live", runner: "live" };
const REVOKED = { computer: "computer_revoked", runner: "revoked" };

test("a Computer's revoke link revokes its key and its agents' keys and closes their connections; the person's other Computer is untouched", async () => {
  await withApp(async (app, mailbox) => {
    const { id: userId, bearer } = await seedUser();
    const server = await createServer("Alpha Co", `alpha-${randomUUID()}`, userId);
    const laptop = await attachByGrant(app, mailbox, bearer, server.id, "laptop");
    const desktop = await attachByGrant(app, mailbox, bearer, server.id, "desktop");
    const laptopRunner = await runnerOn(app, server.id, laptop, "laptop-agent");
    const desktopRunner = await runnerOn(app, server.id, desktop, "desktop-agent");
    assert.deepEqual(await keyState(app, laptop, laptopRunner), LIVE);
    assert.deepEqual(await keyState(app, desktop, desktopRunner), LIVE);

    await captureClosures([laptopRunner.agentId, desktopRunner.agentId], async (closed) => {
      assert.deepEqual(await revokeLink(app, laptop.revokeToken), { status: 200, body: { ok: true, revoked: "computer" } });
      assert.deepEqual(await keyState(app, laptop, laptopRunner), REVOKED);
      assert.deepEqual(await keyState(app, desktop, desktopRunner), LIVE);
      // The laptop's connection and its agent's streams are closed; nothing of the desktop's.
      assert.deepEqual(closed.drops, [[laptop.machineId, "credential_revoked"]]);
      assert.deepEqual(closed.signals, [laptopRunner.agentId]);
    });

    // The revoked key mints nothing more; the other still does.
    const again = await post(app, `/internal/computer/runners/${laptopRunner.agentId}/credentials`, {}, laptop.apiKey);
    assert.equal(again.status, 401);
    await runnerOn(app, server.id, desktop, "desktop-agent-2");

    // Soft revoke: the machine and its agent stay.
    const [row] = await getDb().select({ revokedReason: computers.revokedReason, machineId: computers.machineId }).from(computers)
      .where(eq(computers.id, laptop.serverMachineId));
    assert.deepEqual(row, { revokedReason: "computer_key_revoked", machineId: laptop.machineId });
    const [agentRow] = await getDb().select({ machineId: agents.machineId }).from(agents).where(eq(agents.id, laptopRunner.agentId));
    assert.equal(agentRow!.machineId, laptop.machineId);

    // Audited: the key and the credential, through the link, for the person it was mailed to.
    const audits = await getDb()
      .select({ type: integrationAuditEvents.eventType, targetId: integrationAuditEvents.targetId, actorType: integrationAuditEvents.actorType, requesterId: integrationAuditEvents.requesterId, metadata: integrationAuditEvents.metadata })
      .from(integrationAuditEvents)
      .where(inArray(integrationAuditEvents.targetId, [laptop.serverMachineId, laptopRunner.credentialId, desktop.serverMachineId, desktopRunner.credentialId]));
    const revokes = audits.filter((audit) => audit.type === "computer.key_revoked" || audit.type === "agent_credential.revoked");
    assert.deepEqual(revokes.map((audit) => [audit.type, audit.targetId]).sort(), [
      ["agent_credential.revoked", laptopRunner.credentialId],
      ["computer.key_revoked", laptop.serverMachineId],
    ].sort());
    for (const audit of revokes) {
      assert.equal(audit.actorType, "system");
      assert.equal(audit.requesterId, userId);
      assert.equal(audit.metadata.via, "revoke_link");
      assert.equal(audit.metadata.reason, "computer_key_revoked");
    }
  });
});

test("a Computer's revoke link works once and expires after 24 hours", async () => {
  await withApp(async (app, mailbox) => {
    const { id: userId, bearer } = await seedUser();
    const server = await createServer("Alpha Co", `alpha-${randomUUID()}`, userId);
    const first = await attachByGrant(app, mailbox, bearer, server.id, "first");
    const second = await attachByGrant(app, mailbox, bearer, server.id, "second");
    const firstRunner = await runnerOn(app, server.id, first, "first-agent");
    const secondRunner = await runnerOn(app, server.id, second, "second-agent");

    const [link] = await getDb().select({ createdAt: computerRevokeTokens.createdAt, expiresAt: computerRevokeTokens.expiresAt, computerId: computerRevokeTokens.computerId })
      .from(computerRevokeTokens).where(eq(computerRevokeTokens.tokenLookupHash, computeTokenLookupHash(first.revokeToken)));
    assert.equal(link!.computerId, first.serverMachineId);
    assert.ok(Math.abs(link!.expiresAt.getTime() - link!.createdAt.getTime() - 24 * 60 * 60 * 1000) < 5_000);

    // Unknown and malformed links revoke nothing.
    assert.deepEqual(await revokeLink(app, `dvcr_${randomUUID()}`), { status: 404, body: { error: "This revoke link can't be used", code: "revoke_link_invalid" } });
    assert.equal((await revokeLink(app, `dvcr_${"x".repeat(200)}`)).status, 404);

    // Expired: refused, and the Computer stays live.
    await getDb().update(computerRevokeTokens).set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(computerRevokeTokens.tokenLookupHash, computeTokenLookupHash(second.revokeToken)));
    assert.deepEqual(await revokeLink(app, second.revokeToken), { status: 410, body: { error: "This revoke link can't be used", code: "revoke_link_expired" } });
    assert.deepEqual(await keyState(app, second, secondRunner), LIVE);

    // Once: a second click is told it was used (two at once: one revokes).
    const answers = await Promise.all([revokeLink(app, first.revokeToken), revokeLink(app, first.revokeToken)]);
    assert.deepEqual(answers.map((answer) => answer.status).sort(), [200, 409]);
    assert.equal(answers.find((answer) => answer.status === 409)!.body.code, "revoke_link_used");
    assert.deepEqual(await keyState(app, first, firstRunner), REVOKED);
    const audits = await getDb().select({ id: integrationAuditEvents.id }).from(integrationAuditEvents)
      .where(and(eq(integrationAuditEvents.eventType, "computer.key_revoked"), eq(integrationAuditEvents.targetId, first.serverMachineId)));
    assert.equal(audits.length, 1, "revoked once");

    // A used link still repairs a cascade that left a credential live, and says it was used.
    await getDb().update(agentCredentials).set({ revokedAt: null, revokedReason: null }).where(eq(agentCredentials.id, firstRunner.credentialId));
    assert.equal((await keyState(app, first, firstRunner)).runner, "live");
    assert.equal((await revokeLink(app, first.revokeToken)).body.code, "revoke_link_used");
    assert.deepEqual(await keyState(app, first, firstRunner), REVOKED);
    // The other Computer was never touched.
    assert.deepEqual(await keyState(app, second, secondRunner), LIVE);
  });
});

test("from the Computers page: whoever may remove the machine revokes its Computer's key, with the same cascade", async () => {
  await withApp(async (app, mailbox) => {
    const { id: ownerId, bearer: ownerBearer } = await seedUser();
    const server = await createServer("Alpha Co", `alpha-${randomUUID()}`, ownerId);
    const { id: memberId, bearer: memberBearer } = await seedUser();
    await addMember(server.id, memberId, "member");
    const laptop = await attachByGrant(app, mailbox, ownerBearer, server.id, "laptop");
    const desktop = await attachByGrant(app, mailbox, ownerBearer, server.id, "desktop");
    // The owner's own agents: someone else's would block the revoke (servers.revokeComputerOthersAgents.api.test.ts).
    const laptopRunner = await runnerOn(app, server.id, laptop, "laptop-agent", ownerId);
    const desktopRunner = await runnerOn(app, server.id, desktop, "desktop-agent", ownerId);
    const revokeKey = async (bearer: string, machineId: string) => {
      const res = await fetch(`${app.baseUrl}/api/servers/${server.id}/machines/${machineId}/revoke-computer-key`, {
        method: "POST",
        headers: jsonHeaders({ Authorization: `Bearer ${bearer}`, "X-Server-Id": server.id }),
        body: "{}",
      });
      return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, any> };
    };

    // A member who didn't connect it may not.
    const refused = await revokeKey(memberBearer, laptop.machineId);
    assert.equal(refused.status, 403);
    assert.deepEqual(await keyState(app, laptop, laptopRunner), LIVE);
    assert.equal((await revokeKey(ownerBearer, randomUUID())).status, 404);

    await captureClosures([laptopRunner.agentId, desktopRunner.agentId], async (closed) => {
      assert.deepEqual(await revokeKey(ownerBearer, laptop.machineId), { status: 200, body: { ok: true, revokedComputers: 1, unboundAgentIds: [] } });
      assert.deepEqual(closed.drops, [[laptop.machineId, "credential_revoked"]]);
      assert.deepEqual(closed.signals, [laptopRunner.agentId]);
    });
    assert.deepEqual(await keyState(app, laptop, laptopRunner), REVOKED);
    assert.deepEqual(await keyState(app, desktop, desktopRunner), LIVE);
    // Nothing live left on it.
    assert.equal((await revokeKey(ownerBearer, laptop.machineId)).body.code, "no_live_computer_key");

    const [audit] = await getDb()
      .select({ actorType: integrationAuditEvents.actorType, actorId: integrationAuditEvents.actorId, source: integrationAuditEvents.source, metadata: integrationAuditEvents.metadata })
      .from(integrationAuditEvents)
      .where(and(eq(integrationAuditEvents.eventType, "computer.key_revoked"), eq(integrationAuditEvents.targetId, laptop.serverMachineId)));
    assert.deepEqual({ actorType: audit!.actorType, actorId: audit!.actorId, source: audit!.source, via: audit!.metadata.via, actorRole: audit!.metadata.actorRole, revokedCount: audit!.metadata.revokedCount },
      { actorType: "human", actorId: ownerId, source: "web", via: "web", actorRole: "owner", revokedCount: 1 });
    const [computer] = await getDb().select({ revokedBy: computers.revokedByUserId }).from(computers).where(eq(computers.id, laptop.serverMachineId));
    assert.equal(computer!.revokedBy, ownerId);

    // The laptop's emailed link now finds it revoked: nothing more to do, nothing of the desktop's touched.
    assert.equal((await revokeLink(app, laptop.revokeToken)).status, 200);
    assert.deepEqual(await keyState(app, desktop, desktopRunner), LIVE);
  });
});

test("detaching a Computer tells the owners of other members' agents on it that they are offline; not whoever detached it", async () => {
  await withApp(async (app, mailbox) => {
    const { id: ownerId, bearer: ownerBearer } = await seedUser();
    const server = await createServer("Shared Co", `shared-${randomUUID()}`, ownerId);
    const { id: memberId } = await seedUser();
    await addMember(server.id, memberId, "member");
    const laptop = await attachByGrant(app, mailbox, ownerBearer, server.id, "laptop");
    const theirs = await createAgent(server.id, "theirs", { runtime: "external", creatorType: "user", creatorId: memberId });
    const mine = await createAgent(server.id, "mine", { runtime: "external", creatorType: "user", creatorId: ownerId });
    await getDb().update(agents).set({ machineId: laptop.machineId }).where(inArray(agents.id, [theirs.id, mine.id]));
    const notices = async (userId: string, agentId: string) => {
      const dm = await channelService.findOrCreateDM(server.id, userId, agentId);
      const rows = await getDb().select({ content: messages.content }).from(messages)
        .where(and(eq(messages.channelId, dm!.id), eq(messages.messageType, "system")));
      return rows.map((row) => row.content);
    };

    // The member's agent blocks the revoke until it is moved or named in forceAgentIds (then unbound, its owner told).
    assert.equal((await revokeComputerKey(app, ownerBearer, server.id, laptop.machineId)).body.code, "others_agents_on_computer");
    assert.equal((await revokeComputerKey(app, ownerBearer, server.id, laptop.machineId, { forceAgentIds: [theirs.id] })).status, 200);
    const told = await notices(memberId, theirs.id);
    assert.equal(told.length, 1);
    assert.match(told[0]!, /@theirs is offline: the computer "laptop" it runs on was detached/);
    assert.deepEqual(await notices(ownerId, mine.id), []);
  });
});

async function revokeComputerKey(app: App, bearer: string, serverId: string, machineId: string, body: object = {}) {
  const res = await fetch(`${app.baseUrl}/api/servers/${serverId}/machines/${machineId}/revoke-computer-key`, {
    method: "POST",
    headers: jsonHeaders({ Authorization: `Bearer ${bearer}`, "X-Server-Id": serverId }),
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, any> };
}

test("revoking from the web: the person who connected it may even without removeMachines, another admin may, a machine of another server may not", async () => {
  await withApp(async (app, mailbox) => {
    const { id: ownerId, bearer: ownerBearer } = await seedUser();
    const server = await createServer("Alpha Co", `alpha-${randomUUID()}`, ownerId);
    const elsewhere = await createServer("Beta Co", `beta-${randomUUID()}`, ownerId);
    const { id: adminId, bearer: adminBearer } = await seedUser();
    await addMember(server.id, adminId, "admin");
    const { id: otherAdminId, bearer: otherAdminBearer } = await seedUser();
    await addMember(server.id, otherAdminId, "admin");

    // The admin connects a machine, then is demoted: still its creator.
    const own = await attachByGrant(app, mailbox, adminBearer, server.id, "admin-laptop");
    await getDb().update(serverMembers).set({ role: "member" }).where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, adminId)));
    assert.deepEqual(await revokeComputerKey(app, adminBearer, server.id, own.machineId), { status: 200, body: { ok: true, revokedComputers: 1, unboundAgentIds: [] } });
    assert.equal((await findComputerByApiKeyWithReason(own.apiKey)).ok, false);

    // Another admin, who didn't connect it, may (removeMachines).
    const owners = await attachByGrant(app, mailbox, ownerBearer, server.id, "owner-laptop");
    assert.equal((await revokeComputerKey(app, otherAdminBearer, server.id, owners.machineId)).status, 200);
    assert.equal((await findComputerByApiKeyWithReason(owners.apiKey)).ok, false);

    // A real machine of another server, named under this one: not found, untouched.
    const foreign = await attachByGrant(app, mailbox, ownerBearer, elsewhere.id, "beta-laptop");
    assert.equal((await revokeComputerKey(app, ownerBearer, server.id, foreign.machineId)).status, 404);
    assert.equal((await findComputerByApiKeyWithReason(foreign.apiKey)).ok, true);
  });
});

test("a used revoke link's repair reaches only what the revoked key minted, and only while the link is unexpired", async () => {
  await withApp(async (app, mailbox) => {
    const { id: userId, bearer } = await seedUser();
    const server = await createServer("Alpha Co", `alpha-${randomUUID()}`, userId);
    const laptop = await attachByGrant(app, mailbox, bearer, server.id, "laptop");
    const runner = await runnerOn(app, server.id, laptop, "laptop-agent");
    assert.equal((await revokeLink(app, laptop.revokeToken)).status, 200);
    assert.deepEqual(await keyState(app, laptop, runner), REVOKED);

    // A credential the machine minted after the key was revoked (another key of
    // the machine): not this key's, so a repair leaves it alone.
    await new Promise((r) => setTimeout(r, 5));
    const later = await mintAgentCredential({
      agentId: runner.agentId, scopes: ["send", "read"], name: "later", issuedVia: "computer", issuedByMachineId: laptop.machineId, createdByUserId: null,
    });
    // And one the key minted, left live by a failed first cascade: repaired.
    await getDb().update(agentCredentials).set({ revokedAt: null, revokedReason: null }).where(eq(agentCredentials.id, runner.credentialId));
    assert.equal((await revokeLink(app, laptop.revokeToken)).body.code, "revoke_link_used");
    assert.equal((await keyState(app, laptop, runner)).runner, "revoked");
    assert.equal((await keyState(app, laptop, later)).runner, "live", "minted after the revoke: not repaired");

    // Expired: a used link is inert, it repairs nothing.
    await getDb().update(agentCredentials).set({ revokedAt: null, revokedReason: null }).where(eq(agentCredentials.id, runner.credentialId));
    await getDb().update(computerRevokeTokens).set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(computerRevokeTokens.tokenLookupHash, computeTokenLookupHash(laptop.revokeToken)));
    assert.equal((await revokeLink(app, laptop.revokeToken)).body.code, "revoke_link_used");
    assert.equal((await keyState(app, laptop, runner)).runner, "live", "an expired link repairs nothing");
  });
});

// --- What a web session approved goes with it on a security revoke (approverSessionGrants.ts) ---

/** A person's own web sign-in: a `full` session family, its access and refresh tokens. */
async function webSession(userId: string) {
  const session = await signInForTest(userId);
  return { familyId: session.familyId, refreshToken: session.refreshToken, bearer: session.token };
}

/** The agent key an agent_key grant approved by `bearer` hands out. */
async function agentKeyByGrant(app: App, bearer: string, agentId: string) {
  const login = await startGrant(app, { kind: "agent_key" });
  assert.equal((await approve(app, bearer, login.userCode, { agentId })).status, 200);
  const token = await poll(app, login.deviceCode);
  assert.equal(token.status, 200, JSON.stringify(token.body));
  return { apiKey: token.body.apiKey as string, credentialId: token.body.credentialId as string, userCode: login.userCode };
}

async function agentKeyState(app: App, apiKey: string) {
  const res = await fetch(`${app.baseUrl}/internal/agent-api/`, { headers: { Authorization: `Bearer ${apiKey}` } });
  return res.status === 200 ? "live" : res.status === 401 ? "revoked" : `status:${res.status}`;
}

test("approve records the approving web session's family on the grant; a token with no family is refused and records none", async () => {
  await withApp(async (app) => {
    const { id: userId } = await seedUser();
    const server = await createServer("Alpha Co", `alpha-${randomUUID()}`, userId);
    const web = await webSession(userId);
    const withFamily = await startGrant(app, ATTACH);
    assert.equal((await approve(app, web.bearer, withFamily.userCode, { serverId: server.id })).status, 200);
    // A (legacy) access token without a session family no longer authenticates at all.
    const withoutFamily = await startGrant(app, ATTACH);
    const { approvalTicket } = await describeCode(app, web.bearer, withoutFamily.userCode);
    const familyless = jwt.sign({ sub: userId, type: "access" }, process.env.JWT_SECRET!, { expiresIn: "15m" });
    const refused = await post(app, "/api/auth/device/approve", { userCode: withoutFamily.userCode, approvalTicket, serverId: server.id }, familyless);
    assert.equal(refused.status, 401, JSON.stringify(refused.body));
    assert.equal((await grantRow(withoutFamily.userCode))?.status, "pending");
    const familyOf = async (userCode: string) => (await getDb()
      .select({ family: deviceLoginGrants.approverSessionFamilyId })
      .from(deviceLoginGrants)
      .innerJoin(deviceAuthorizations, eq(deviceAuthorizations.id, deviceLoginGrants.deviceAuthorizationId))
      .where(eq(deviceAuthorizations.userCode, userCode)))[0]!.family;
    assert.equal(await familyOf(withFamily.userCode), web.familyId);
    assert.equal(await familyOf(withoutFamily.userCode), null);
  });
});

test("a password change revokes the Computers and agent keys the person's sessions approved, closes them, and audits each; another person's are untouched", async () => {
  await withApp(async (app, mailbox) => {
    const { id: userId } = await seedUser();
    const server = await createServer("Alpha Co", `alpha-${randomUUID()}`, userId);
    const external = await createAgent(server.id, "outside-agent", { runtime: "external" });
    const stolen = await webSession(userId);
    const laptop = await attachByGrant(app, mailbox, stolen.bearer, server.id, "thief-laptop");
    const runner = await runnerOn(app, server.id, laptop, "thief-agent");
    const key = await agentKeyByGrant(app, stolen.bearer, external.id);
    // Approved but not yet used when the password changes: never usable after.
    const pending = await startGrant(app, { ...ATTACH, machineName: "not-yet" });
    assert.equal((await approve(app, stolen.bearer, pending.userCode, { serverId: server.id })).status, 200);

    // Someone else's session T, on a server they own: nothing of theirs is touched.
    const { id: otherId } = await seedUser();
    const otherServer = await createServer("Beta Co", `beta-${randomUUID()}`, otherId);
    const other = await webSession(otherId);
    const theirs = await attachByGrant(app, mailbox, other.bearer, otherServer.id, "their-laptop");
    const theirRunner = await runnerOn(app, otherServer.id, theirs, "their-agent");

    await captureClosures([runner.agentId, external.id, theirRunner.agentId], async (closed) => {
      await changePassword(userId, "password123", "a-new-password-456");
      assert.deepEqual(closed.drops, [[laptop.machineId, "credential_revoked"]]);
      assert.deepEqual(closed.signals.sort(), [runner.agentId, external.id].sort());
    });
    assert.deepEqual(await keyState(app, laptop, runner), REVOKED);
    assert.equal(await agentKeyState(app, key.apiKey), "revoked");
    assert.deepEqual(await keyState(app, theirs, theirRunner), LIVE);
    assert.equal((await grantRow(pending.userCode))?.status, "expired");
    assert.equal((await poll(app, pending.deviceCode)).body.code, "expired_token");

    const audits = await getDb()
      .select({ type: integrationAuditEvents.eventType, targetId: integrationAuditEvents.targetId, actorType: integrationAuditEvents.actorType, requesterId: integrationAuditEvents.requesterId, metadata: integrationAuditEvents.metadata })
      .from(integrationAuditEvents)
      .where(inArray(integrationAuditEvents.targetId, [laptop.serverMachineId, runner.credentialId, key.credentialId]));
    const revokes = audits.filter((audit) => audit.type === "computer.key_revoked" || audit.type === "agent_credential.revoked");
    assert.deepEqual(revokes.map((audit) => [audit.type, audit.targetId]).sort(), [
      ["agent_credential.revoked", key.credentialId],
      ["agent_credential.revoked", runner.credentialId],
      ["computer.key_revoked", laptop.serverMachineId],
    ].sort());
    for (const audit of revokes) {
      assert.equal(audit.actorType, "system");
      assert.equal(audit.requesterId, userId);
      assert.equal(audit.metadata.via, "approver_session_revoked");
      assert.equal(audit.metadata.trigger, "password_change");
      assert.ok(audit.metadata.grantId);
    }
    const [credential] = await getDb().select({ reason: agentCredentials.revokedReason }).from(agentCredentials).where(eq(agentCredentials.id, key.credentialId));
    assert.equal(credential!.reason, "approver_session_revoked");

    // Idempotent: running it again revokes and audits nothing more.
    assert.deepEqual(await revokeWhatRevokedSessionsApproved({ userId }, "password_change"), { expiredGrants: 0, computers: 0, credentials: 0 });
    const again = await getDb().select({ id: integrationAuditEvents.id }).from(integrationAuditEvents)
      .where(inArray(integrationAuditEvents.targetId, [laptop.serverMachineId, runner.credentialId, key.credentialId]));
    assert.equal(again.length, audits.length);
  });
});

test("signing the approving session out doesn't revoke what it approved, and doesn't let it escape a later password change", async () => {
  await withApp(async (app, mailbox) => {
    const { id: userId } = await seedUser();
    const server = await createServer("Alpha Co", `alpha-${randomUUID()}`, userId);
    const external = await createAgent(server.id, "outside-agent", { runtime: "external" });
    const stolen = await webSession(userId);
    const laptop = await attachByGrant(app, mailbox, stolen.bearer, server.id, "laptop");
    const runner = await runnerOn(app, server.id, laptop, "laptop-agent");
    const key = await agentKeyByGrant(app, stolen.bearer, external.id);

    await captureClosures([runner.agentId, external.id], async (closed) => {
      assert.equal((await post(app, "/api/auth/logout", { refreshToken: stolen.refreshToken })).status, 200);
      assert.deepEqual(closed.drops, [], "the machine stays connected");
      assert.deepEqual(closed.signals, []);
    });
    const [family] = await getDb().select({ revokedReason: sessionFamilies.revokedReason }).from(sessionFamilies).where(eq(sessionFamilies.id, stolen.familyId));
    assert.equal(family!.revokedReason, "logout");
    assert.deepEqual(await keyState(app, laptop, runner), LIVE);
    assert.equal(await agentKeyState(app, key.apiKey), "live");

    // Signed out first, then the password changes: still revoked.
    await changePassword(userId, "password123", "a-new-password-456");
    assert.deepEqual(await keyState(app, laptop, runner), REVOKED);
    assert.equal(await agentKeyState(app, key.apiKey), "revoked");
  });
});

test("a one-time grant's code keeps its own rule: the approving session signed out before the poll, the poll still gets what it asked for", async () => {
  await withApp(async (app) => {
    const { id: userId } = await seedUser();
    const server = await createServer("Alpha Co", `alpha-${randomUUID()}`, userId);
    const web = await webSession(userId);
    const login = await startGrant(app, ATTACH);
    assert.equal((await approve(app, web.bearer, login.userCode, { serverId: server.id })).status, 200);
    // A logout denies the device codes that session approved for a device
    // session (sessionService.denyLoginCodesApprovedBy), not a grant's.
    assert.equal((await post(app, "/api/auth/logout", { refreshToken: web.refreshToken })).status, 200);
    const [code] = await getDb().select({ status: deviceAuthorizations.status }).from(deviceAuthorizations)
      .where(eq(deviceAuthorizations.userCode, login.userCode));
    assert.equal(code!.status, "approved");
    const token = await poll(app, login.deviceCode);
    assert.equal(token.status, 200, JSON.stringify(token.body));
    assert.match(token.body.attachToken, /^dvat_/);
  });
});

test("a password reset revokes what the person's sessions approved", async () => {
  await withApp(async (app, mailbox) => {
    const { id: userId } = await seedUser();
    const server = await createServer("Alpha Co", `alpha-${randomUUID()}`, userId);
    const stolen = await webSession(userId);
    const laptop = await attachByGrant(app, mailbox, stolen.bearer, server.id, "laptop");
    const runner = await runnerOn(app, server.id, laptop, "laptop-agent");
    const resetToken = randomUUID();
    await getDb().insert(passwordResets).values({
      userId, tokenHash: createHash("sha256").update(resetToken).digest("hex"), expiresAt: new Date(Date.now() + 60_000),
    });
    assert.deepEqual(await resetPassword(resetToken, "a-new-password-456"), { success: true, userId });
    assert.deepEqual(await keyState(app, laptop, runner), REVOKED);
  });
});

test("retiring the account revokes what its sessions approved", async () => {
  const oldBranch = process.env.SLOCK_RELEASE_BRANCH;
  process.env.SLOCK_RELEASE_BRANCH = "staging";
  try {
    await withApp(async (app, mailbox) => {
      const { id: userId } = await seedUser();
      const server = await createServer("Alpha Co", `alpha-${randomUUID()}`, userId);
      const external = await createAgent(server.id, "outside-agent", { runtime: "external" });
      const stolen = await webSession(userId);
      const laptop = await attachByGrant(app, mailbox, stolen.bearer, server.id, "laptop");
      const runner = await runnerOn(app, server.id, laptop, "laptop-agent");
      const key = await agentKeyByGrant(app, stolen.bearer, external.id);
      const capability = randomUUID();
      await getDb().update(users).set({
        email: `retire-${randomUUID()}@mail.build`,
        stagingSelfAccountCapabilityHash: createHash("sha256").update(capability).digest("hex"),
      }).where(eq(users.id, userId));
      assert.ok(await retireStagingSelfAccount(userId, userId, capability));
      assert.deepEqual(await keyState(app, laptop, runner), REVOKED);
      assert.equal(await agentKeyState(app, key.apiKey), "revoked");
      const [audit] = await getDb().select({ metadata: integrationAuditEvents.metadata }).from(integrationAuditEvents)
        .where(and(eq(integrationAuditEvents.eventType, "computer.key_revoked"), eq(integrationAuditEvents.targetId, laptop.serverMachineId)));
      assert.equal(audit!.metadata.trigger, "account_retired");
    });
  } finally {
    if (oldBranch === undefined) delete process.env.SLOCK_RELEASE_BRANCH;
    else process.env.SLOCK_RELEASE_BRANCH = oldBranch;
  }
});

test("a device login's \"this wasn't me\" link revokes what that session approved, and nothing another session of the person approved", async () => {
  await withApp(async (app, mailbox) => {
    const { id: userId } = await seedUser();
    const server = await createServer("Alpha Co", `alpha-${randomUUID()}`, userId);
    const own = await webSession(userId);
    // A device login, approved on the web, mails a "this wasn't me" link.
    const login = await startGrant(app, undefined);
    assert.equal((await approve(app, own.bearer, login.userCode)).status, 200);
    await mailCount(mailbox, 1);
    const revokeToken = mailbox[0]!.html.match(/revoke_device_login=(dvr_[A-Za-z0-9_-]+)/)?.[1];
    assert.ok(revokeToken);
    const issued = await poll(app, login.deviceCode);
    assert.equal(issued.status, 200);
    const [authorization] = await getDb().select({ familyId: deviceAuthorizations.consumedSessionFamilyId }).from(deviceAuthorizations)
      .where(eq(deviceAuthorizations.userCode, login.userCode));
    // A device session can't approve today (approve isn't a device-session
    // route); one issued before device-scoped sessions existed was `full`.
    await getDb().update(sessionFamilies).set({ scope: "full" }).where(eq(sessionFamilies.id, authorization!.familyId!));
    const deviceBearer = signAccessToken(userId, authorization!.familyId!);
    const approvedByDevice = await attachByGrant(app, mailbox, deviceBearer, server.id, "thief-laptop");
    const deviceRunner = await runnerOn(app, server.id, approvedByDevice, "thief-agent");
    // The person's own web session T approved another.
    const approvedByOwn = await attachByGrant(app, mailbox, own.bearer, server.id, "own-laptop");
    const ownRunner = await runnerOn(app, server.id, approvedByOwn, "own-agent");

    assert.equal((await revokeLink(app, revokeToken)).status, 200);
    assert.deepEqual(await keyState(app, approvedByDevice, deviceRunner), REVOKED);
    assert.deepEqual(await keyState(app, approvedByOwn, ownRunner), LIVE);
    const [audit] = await getDb().select({ metadata: integrationAuditEvents.metadata }).from(integrationAuditEvents)
      .where(and(eq(integrationAuditEvents.eventType, "computer.key_revoked"), eq(integrationAuditEvents.targetId, approvedByDevice.serverMachineId)));
    assert.equal(audit!.metadata.trigger, "device_login_revoked");
  });
});

test("a grant approved before approver families were recorded never cascades, and nothing errors", async () => {
  await withApp(async (app, mailbox) => {
    const { id: userId } = await seedUser();
    const server = await createServer("Alpha Co", `alpha-${randomUUID()}`, userId);
    const web = await webSession(userId);
    const old = await attachByGrant(app, mailbox, web.bearer, server.id, "old-laptop");
    const runner = await runnerOn(app, server.id, old, "old-agent");
    // As written by a server from before the column.
    await getDb().update(deviceLoginGrants).set({ approverSessionFamilyId: null });
    const errors: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => { errors.push(args); originalError(...args); };
    try {
      await changePassword(userId, "password123", "a-new-password-456");
    } finally {
      console.error = originalError;
    }
    assert.deepEqual(await keyState(app, old, runner), LIVE);
    assert.deepEqual(errors, []);
  });
});

test("an attach token handed out but not yet used stops working when the approving session is security-revoked", async () => {
  await withApp(async (app) => {
    const { id: userId } = await seedUser();
    const server = await createServer("Alpha Co", `alpha-${randomUUID()}`, userId);
    const stolen = await webSession(userId);
    const login = await startGrant(app, ATTACH);
    assert.equal((await approve(app, stolen.bearer, login.userCode, { serverId: server.id })).status, 200);
    const { attachToken } = (await poll(app, login.deviceCode)).body as { attachToken: string };
    await changePassword(userId, "password123", "a-new-password-456");
    const attached = await attach(app, attachToken);
    assert.equal(attached.status, 410, JSON.stringify(attached.body));
    assert.equal(attached.body.code, "attach_token_expired");
    assert.equal((await getDb().select({ id: computers.id }).from(computers).where(eq(computers.attachedByUserId, userId))).length, 0);
  });
});

test("a session revoked while it approves records nothing: approve refuses it", async () => {
  await withApp(async (app) => {
    const { id: userId } = await seedUser();
    const server = await createServer("Alpha Co", `alpha-${randomUUID()}`, userId);
    const web = await webSession(userId);
    const login = await startGrant(app, ATTACH);
    const { approvalTicket } = await describeCode(app, web.bearer, login.userCode);
    // Revoked after its request was authenticated, before the approve's write.
    assert.equal((await post(app, "/api/auth/logout", { refreshToken: web.refreshToken })).status, 200);
    const result = await approveDeviceAuthorization({
      userCode: login.userCode, userId, approve: true, approvalTicket, selection: { serverId: server.id }, approverSessionFamilyId: web.familyId,
    });
    assert.deepEqual(result, { ok: false, error: "approver_session_revoked" });
    assert.equal((await grantRow(login.userCode))?.status, "pending");
  });
});

test("maintenance repairs a security revoke whose cascade failed, and never reaches a session that was only signed out", async () => {
  await withApp(async (app, mailbox) => {
    const { id: userId } = await seedUser();
    const server = await createServer("Alpha Co", `alpha-${randomUUID()}`, userId);
    const external = await createAgent(server.id, "outside-agent", { runtime: "external" });
    const stolen = await webSession(userId);
    const laptop = await attachByGrant(app, mailbox, stolen.bearer, server.id, "laptop");
    const runner = await runnerOn(app, server.id, laptop, "laptop-agent");
    const key = await agentKeyByGrant(app, stolen.bearer, external.id);
    await changePassword(userId, "password123", "a-new-password-456");
    // As if the cascade had failed after the password change committed.
    await getDb().update(computers).set({ revokedAt: null, revokedReason: null }).where(eq(computers.id, laptop.serverMachineId));
    await getDb().update(agentCredentials).set({ revokedAt: null, revokedReason: null }).where(inArray(agentCredentials.id, [runner.credentialId, key.credentialId]));
    assert.deepEqual(await keyState(app, laptop, runner), LIVE);

    // Someone else who only signed out.
    const { id: otherId } = await seedUser();
    const otherServer = await createServer("Beta Co", `beta-${randomUUID()}`, otherId);
    const other = await webSession(otherId);
    const theirs = await attachByGrant(app, mailbox, other.bearer, otherServer.id, "their-laptop");
    const theirRunner = await runnerOn(app, otherServer.id, theirs, "their-agent");
    assert.equal((await post(app, "/api/auth/logout", { refreshToken: other.refreshToken })).status, 200);

    assert.deepEqual(await revokeWhatRevokedSessionsApproved("security_revoked", "repair"), { expiredGrants: 0, computers: 1, credentials: 1 });
    assert.deepEqual(await keyState(app, laptop, runner), REVOKED);
    assert.equal(await agentKeyState(app, key.apiKey), "revoked");
    assert.deepEqual(await keyState(app, theirs, theirRunner), LIVE);
  });
});

test("the session that changes the password keeps what it approved, another session's grants go, the repair keeps it, and a reset takes it", async () => {
  await withApp(async (app, mailbox) => {
    const { id: userId } = await seedUser();
    const server = await createServer("Alpha Co", `alpha-${randomUUID()}`, userId);
    const external = await createAgent(server.id, "outside-agent", { runtime: "external" });
    const changing = await webSession(userId);
    const other = await webSession(userId);
    const kept = await attachByGrant(app, mailbox, changing.bearer, server.id, "own-laptop");
    const keptRunner = await runnerOn(app, server.id, kept, "own-agent");
    const keptKey = await agentKeyByGrant(app, changing.bearer, external.id);
    const keptPending = await startGrant(app, ATTACH);
    assert.equal((await approve(app, changing.bearer, keptPending.userCode, { serverId: server.id })).status, 200);
    const gone = await attachByGrant(app, mailbox, other.bearer, server.id, "thief-laptop");
    const goneRunner = await runnerOn(app, server.id, gone, "thief-agent");
    const goneKey = await agentKeyByGrant(app, other.bearer, external.id);

    const changed = await fetch(`${app.baseUrl}/api/auth/me`, {
      method: "PATCH",
      headers: jsonHeaders({ Authorization: `Bearer ${changing.bearer}` }),
      body: JSON.stringify({ currentPassword: "password123", newPassword: "a-new-password-456" }),
    });
    assert.equal(changed.status, 200, await changed.text());
    assert.deepEqual(await keyState(app, kept, keptRunner), LIVE);
    assert.equal(await agentKeyState(app, keptKey.apiKey), "live");
    assert.equal((await grantRow(keptPending.userCode))?.status, "approved");
    assert.deepEqual(await keyState(app, gone, goneRunner), REVOKED);
    assert.equal(await agentKeyState(app, goneKey.apiKey), "revoked");

    assert.deepEqual(await revokeWhatRevokedSessionsApproved("security_revoked", "repair"), { expiredGrants: 0, computers: 0, credentials: 0 });
    assert.deepEqual(await keyState(app, kept, keptRunner), LIVE);

    const resetToken = randomUUID();
    await getDb().insert(passwordResets).values({
      userId, tokenHash: createHash("sha256").update(resetToken).digest("hex"), expiresAt: new Date(Date.now() + 60_000),
    });
    assert.deepEqual(await resetPassword(resetToken, "a-third-password-789"), { success: true, userId });
    assert.deepEqual(await keyState(app, kept, keptRunner), REVOKED);
    assert.equal(await agentKeyState(app, keptKey.apiKey), "revoked");
    assert.equal((await grantRow(keptPending.userCode))?.status, "expired");
  });
});
