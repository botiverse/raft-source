import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, afterAll, beforeEach } from "vitest";
import { and, asc, eq, like } from "drizzle-orm";

import { getDb } from "../db/index";
import {
  actionCards,
  agents,
  channelAgents,
  featureFlags,
  integrationAuditEvents,
  managedMcpAssignments,
  managedMcpCredentials,
  managedMcpOAuthAttempts,
  managedMcpPersonalGrants,
  managedMcpServers,
  notificationOutbox,
  serverMembers,
  users,
} from "../db/schema";
import { createApiTest } from "../test/integration/apiTest";
import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
import { seedBoundGuest } from "../test/guestFixture";
import { addMember, createServer } from "../services/serverService";
import { createAgent } from "../services/agentService";
import { createChannel } from "../services/channelService";
import { ensureMcpConnectionCard } from "../services/managedMcpConnectionCardService";
import { mintAgentCredential } from "../services/agentCredentialService";
import { encryptManagedMcpSecret } from "../services/managedMcpCredentialService";
import { __setManagedMcpOAuthGatewayForTests } from "../services/managedMcpOAuthService";
import { admittedMcpConnectionId } from "../services/managedMcpService";
import { listServerAuditEvents } from "../services/integrationAuditService";
import { MCP_PERSONAL_ACCOUNTS_FEATURE_FLAG_KEY } from "../services/featureFlagService";
import express from "express";
import type { AddressInfo } from "node:net";
import { dispatchOwnerRoute } from "../services/assistantOwnerActionCards";
import { runInOwnerDispatch } from "../services/ownerDispatchContext";
import { managedMcpRouter } from "./managedMcp";

// RFC 087 PR 2: members' own MCP accounts. Who may switch "Members can connect their own account",
// start and finish a personal sign-in (re-checked at the callback), choose a Connection's agents
// (personal grants and moves, shared pins and the default), delete or revoke one, and what each role
// reads; the notices (Tenny's guard on O6) and the `mcp_connection.*` audit, which never carries the
// account label, the endpoint or a secret.
const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

const ENDPOINT = "https://docs-accounts.example.test/mcp";
const LABEL = "member-mailbox@corp.example";
const originalCredentialKey = process.env.SLOCK_MCP_CREDENTIAL_KEY;
beforeAll(() => {
  process.env.SLOCK_MCP_CREDENTIAL_KEY = Buffer.alloc(32, 11).toString("base64");
});
afterAll(() => {
  if (originalCredentialKey === undefined) delete process.env.SLOCK_MCP_CREDENTIAL_KEY;
  else process.env.SLOCK_MCP_CREDENTIAL_KEY = originalCredentialKey;
});
beforeEach(() => {
  __setManagedMcpOAuthGatewayForTests({
    start: async (_endpoint, provider) => {
      provider.redirectToAuthorization(new URL(`https://auth.example.test/authorize?state=${encodeURIComponent(await provider.state!())}`));
      return "REDIRECT";
    },
    complete: async (_endpoint, provider, code) => {
      await provider.saveTokens({ access_token: `access-for-${code}`, token_type: "Bearer", workspace_name: LABEL } as never);
    },
    listTools: async () => [{ name: "search", inputSchema: { type: "object" } }],
  });
});
afterEach(() => {
  __setManagedMcpOAuthGatewayForTests(null);
});

type Json = Record<string, any>;

async function seedUser(label: string) {
  const suffix = randomUUID();
  const [user] = await getDb().insert(users).values({
    email: `${label}-${suffix}@raft.test`,
    name: `${label}-${suffix.slice(0, 8)}`,
    displayName: label,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user!;
}

async function setFlag(on: boolean): Promise<void> {
  await getDb().insert(featureFlags)
    .values({ key: MCP_PERSONAL_ACCOUNTS_FEATURE_FLAG_KEY, randomizationUnit: "server", salt: "test", defaultEnabled: on })
    .onConflictDoUpdate({ target: featureFlags.key, set: { defaultEnabled: on } });
}

const storage = (token: string) => encryptManagedMcpSecret({ redirectUrl: "https://raft.example.test/api/mcp/oauth/callback", tokens: { access_token: token, token_type: "Bearer" } });

/**
 * An owner, an admin, two members and a guest; an OAuth App every agent has (vouched) with two ready
 * shared Connections (Team: the default, added by the owner; Ops, added by the admin); agents of the
 * owner and of each member, and each member's personal assistant.
 */
async function seed() {
  const suffix = randomUUID().slice(0, 6);
  const owner = await seedUser("acct-owner");
  const admin = await seedUser("acct-admin");
  const member = await seedUser("acct-member");
  const other = await seedUser("acct-other");
  const guest = await seedUser("acct-guest");
  const server = await createServer("MCP Accounts", `mcp-accounts-${suffix}`, owner.id);
  await addMember(server.id, admin.id, "admin");
  await addMember(server.id, member.id, "member");
  await addMember(server.id, other.id, "member");
  await seedBoundGuest({ serverId: server.id, userId: guest.id });
  const agent = (label: string, creatorId: string) =>
    createAgent(server.id, `${label}${suffix}`, { runtime: "claude", model: "sonnet", creatorType: "user", creatorId });
  const ownersAgent = await agent("OwnersBot", owner.id);
  const membersAgent = await agent("MembersBot", member.id);
  const othersAgent = await agent("OthersBot", other.id);
  const membersAssistant = await agent("MembersPA", member.id);
  await getDb().update(agents).set({ assistantOwnerUserId: member.id }).where(eq(agents.id, membersAssistant.id));
  const othersAssistant = await agent("OthersPA", other.id);
  await getDb().update(agents).set({ assistantOwnerUserId: other.id }).where(eq(agents.id, othersAssistant.id));
  const [app] = await getDb().insert(managedMcpServers).values({
    serverId: server.id, name: "Docs", endpointUrl: ENDPOINT, authMode: "oauth", sourceKind: "url",
    serverVouchedAt: new Date(), oauthStatus: "connected", toolCatalog: [{ name: "search", inputSchema: { type: "object" } }],
  }).returning();
  const shared = async (name: string, createdByUserId: string, isServerDefault: boolean) => (await getDb().insert(managedMcpCredentials).values({
    serverId: server.id, mcpServerId: app!.id, isServerDefault, name, authKind: "oauth", authStatus: "ready", createdByUserId,
    signedInByUserId: createdByUserId, encryptedOAuth: storage(`${name}-token`), authorizedEndpointUrl: ENDPOINT, accountLabel: `${name.toLowerCase()}@corp.example`,
  }).returning())[0]!;
  const team = await shared("Team", owner.id, true);
  const ops = await shared("Ops", admin.id, false);
  return { suffix, owner, admin, member, other, guest, server, app: app!, team, ops, ownersAgent, membersAgent, othersAgent, membersAssistant, othersAssistant };
}
type Seeded = Awaited<ReturnType<typeof seed>>;

/** A ready personal Connection of `ownerId`, as a completed personal sign-in leaves it. */
async function personalConnection(f: Seeded, ownerId: string, name: string) {
  return (await getDb().insert(managedMcpCredentials).values({
    serverId: f.server.id, mcpServerId: f.app.id, isServerDefault: false, name, authKind: "oauth", authStatus: "ready",
    createdByUserId: ownerId, signedInByUserId: ownerId, ownerKind: "personal", ownerUserId: ownerId,
    encryptedOAuth: storage(`${name}-token`), authorizedEndpointUrl: ENDPOINT, accountLabel: LABEL,
  }).returning())[0]!;
}

async function call(baseUrl: string, f: Seeded, method: string, path: string, email: string, body?: unknown) {
  const res = await fetch(`${baseUrl}/api/mcp${path}`, {
    method,
    headers: { Authorization: `Bearer ${await tokenForHuman(email)}`, "X-Server-Id": f.server.id, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as Json, headers: res.headers };
}

/** An agent's own credential: never a person's own session. */
async function asAgent(baseUrl: string, f: Seeded, method: string, path: string, body?: unknown) {
  const { apiKey } = await mintAgentCredential({ agentId: f.ownersAgent.id, scopes: ["read", "send"], name: `acct-${randomUUID().slice(0, 6)}`, issuedVia: "computer", createdByUserId: null });
  const res = await fetch(`${baseUrl}/api/mcp${path}`, {
    method,
    headers: { Authorization: `Bearer ${apiKey}`, "X-Server-Id": f.server.id, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return res.status;
}

async function audit(f: Seeded, eventType: string) {
  return getDb().select().from(integrationAuditEvents)
    .where(and(eq(integrationAuditEvents.serverId, f.server.id), eq(integrationAuditEvents.eventType, eventType)))
    .orderBy(asc(integrationAuditEvents.createdAt), asc(integrationAuditEvents.id));
}

async function notices(prefix: string) {
  const rows = await getDb()
    .select({ receiverId: notificationOutbox.receiverId, eventKey: notificationOutbox.eventKey, payload: notificationOutbox.payload })
    .from(notificationOutbox)
    .where(like(notificationOutbox.eventKey, `${prefix}%`));
  return rows.map((row) => ({ ...row, eventKey: row.eventKey ?? "" }));
}

async function grantsOf(f: Seeded) {
  const rows = await getDb().select().from(managedMcpPersonalGrants).where(eq(managedMcpPersonalGrants.mcpServerId, f.app.id));
  return new Map(rows.map((row) => [row.agentId, row.connectionId]));
}

async function pinOf(agentId: string, appId: string) {
  const [row] = await getDb().select().from(managedMcpAssignments)
    .where(and(eq(managedMcpAssignments.agentId, agentId), eq(managedMcpAssignments.mcpServerId, appId)));
  return row ? { mode: row.connectionMode, bound: row.boundConnectionId } : null;
}

/** A personal sign-in through the routes, as the browser does it; returns what the callback needs. */
async function startPersonal(baseUrl: string, f: Seeded, email: string, body: Json) {
  const started = await call(baseUrl, f, "POST", `/apps/${f.app.id}/connections/oauth/start`, email, { kind: "personal", ...body });
  if (started.status !== 200) return { started, finish: null };
  const state = new URL(started.body.authorizationUrl as string).searchParams.get("state")!;
  const cookie = started.headers.getSetCookie()[0]!.split(";")[0]!;
  const finish = async (code: string) => fetch(`${baseUrl}/api/mcp/oauth/callback?state=${encodeURIComponent(state)}&code=${code}`, { headers: { Cookie: cookie } });
  return { started, finish };
}

test("members-can-connect: admins in their own session while the flag is on; audited; everyone reads it", async ({ app }) => {
  const f = await seed();
  const path = `/apps/${f.app.id}/members-can-connect`;

  // Flag off (no row): refused for everyone; reads say off and that personal accounts are not here.
  const off = await call(app.baseUrl, f, "PUT", path, f.owner.email, { enabled: true });
  assert.equal(off.status, 409);
  assert.equal(off.body.code, "managed_mcp_personal_accounts_off");
  const offView = await call(app.baseUrl, f, "GET", `/apps/${f.app.id}`, f.member.email);
  assert.equal(offView.body.membersCanConnect, false);
  assert.equal(offView.body.personalAccounts, false);

  await setFlag(true);
  assert.equal((await call(app.baseUrl, f, "PUT", path, f.member.email, { enabled: true })).status, 403, "a member");
  assert.equal((await call(app.baseUrl, f, "PUT", path, f.guest.email, { enabled: true })).status, 403, "a guest");
  const agentStatus = await asAgent(app.baseUrl, f, "PUT", path, { enabled: true });
  assert.ok(agentStatus === 401 || agentStatus === 403, `an agent's credential (${agentStatus})`);
  assert.equal((await call(app.baseUrl, f, "PUT", path, f.admin.email, { enabled: "yes" })).status, 400);
  assert.equal((await call(app.baseUrl, f, "PUT", path, f.admin.email, {})).status, 400);

  const on = await call(app.baseUrl, f, "PUT", path, f.admin.email, { enabled: true });
  assert.equal(on.status, 200);
  assert.equal(on.body.membersCanConnect, true);
  assert.equal((await call(app.baseUrl, f, "PUT", path, f.owner.email, { enabled: true })).status, 200, "again: no change");
  const memberView = await call(app.baseUrl, f, "GET", `/apps/${f.app.id}`, f.member.email);
  assert.equal(memberView.body.membersCanConnect, true, "every viewer reads it");
  assert.equal(memberView.body.personalAccounts, true);

  // Off keeps existing personal Connections (Q26).
  const mine = await personalConnection(f, f.member.id, "Mine");
  assert.equal((await call(app.baseUrl, f, "PUT", path, f.owner.email, { enabled: false })).status, 200);
  assert.equal((await getDb().select().from(managedMcpCredentials).where(eq(managedMcpCredentials.id, mine.id))).length, 1);

  const events = await audit(f, "mcp_connection.members_can_connect_changed");
  assert.deepEqual(events.map((event) => [event.actorId, (event.metadata as Json).enabled, (event.metadata as Json).previous]), [
    [f.admin.id, true, false],
    [f.owner.id, false, true],
  ]);
  assert.equal(events[0]!.eventCategory, "membership");
  assert.equal((events[0]!.metadata as Json).actorRole, "admin");
  const page = await listServerAuditEvents(f.server.id, { limit: 200 });
  assert.equal(page.events.filter((event) => event.eventType === "mcp_connection.members_can_connect_changed").length, 2, "on the server's audit page");

  // Flag off again: writes refused, the stored value reads as off.
  await setFlag(false);
  assert.equal((await call(app.baseUrl, f, "PUT", path, f.owner.email, { enabled: true })).status, 409);
});

test("personal sign-in: a member, toggle and flag on; the callback makes the starter's own Connection and gives it the agents, telling their owners and the admins", async ({ app }) => {
  const f = await seed();
  await setFlag(true);
  const startPath = `/apps/${f.app.id}/connections/oauth/start`;

  // Toggle off: refused, nothing written.
  const refused = await call(app.baseUrl, f, "POST", startPath, f.member.email, { kind: "personal", name: "Mine" });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.code, "managed_mcp_members_cannot_connect");
  await getDb().update(managedMcpServers).set({ membersCanConnect: true }).where(eq(managedMcpServers.id, f.app.id));

  // A guest never; an agent's credential never; no default; agents the member can't find are no agents.
  const byGuest = await call(app.baseUrl, f, "POST", startPath, f.guest.email, { kind: "personal", name: "Guest's" });
  assert.equal(byGuest.status, 403);
  assert.equal(byGuest.body.code, "managed_mcp_personal_not_member");
  const agentStatus = await asAgent(app.baseUrl, f, "POST", startPath, { kind: "personal", name: "Agent's" });
  assert.ok(agentStatus === 401 || agentStatus === 403, `an agent's credential (${agentStatus})`);
  assert.equal((await call(app.baseUrl, f, "POST", startPath, f.member.email, { kind: "personal", name: "Mine", makeDefault: true })).status, 400);
  assert.equal((await call(app.baseUrl, f, "POST", startPath, f.member.email, { kind: "personal", name: "Mine", intent: { agentIds: [f.othersAssistant.id] } })).status, 404);
  // A shared sign-in is still the admins'; it names agents only while the flag is on (RFC 087 §7.1, PR 3).
  assert.equal((await call(app.baseUrl, f, "POST", startPath, f.member.email, { name: "Shared" })).status, 403);
  await setFlag(false);
  assert.equal((await call(app.baseUrl, f, "POST", startPath, f.owner.email, { name: "Shared", intent: { agentIds: [f.ownersAgent.id] } })).status, 400);
  await setFlag(true);
  assert.equal((await getDb().select().from(managedMcpCredentials).where(eq(managedMcpCredentials.mcpServerId, f.app.id))).length, 2, "nothing written by a refusal");

  const { started, finish } = await startPersonal(app.baseUrl, f, f.member.email, { name: "Mine", intent: { agentIds: [f.membersAgent.id, f.othersAgent.id] } });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const connectionId = started.body.connectionId as string;
  const [pending] = await getDb().select().from(managedMcpCredentials).where(eq(managedMcpCredentials.id, connectionId));
  assert.equal(pending!.ownerKind, "personal");
  assert.equal(pending!.ownerUserId, f.member.id);
  assert.equal(pending!.isServerDefault, false);
  const [attempt] = await getDb().select().from(managedMcpOAuthAttempts).where(eq(managedMcpOAuthAttempts.id, started.body.attemptId as string));
  assert.deepEqual(attempt!.intent, { kind: "personal", agentIds: [f.membersAgent.id, f.othersAgent.id], name: "Mine" });

  // Nobody else signs in someone's own Connection, an admin included.
  const adminTry = await call(app.baseUrl, f, "POST", startPath, f.owner.email, { connectionId });
  assert.equal(adminTry.status, 404);
  const otherTry = await call(app.baseUrl, f, "POST", startPath, f.other.email, { kind: "personal", connectionId });
  assert.equal(otherTry.status, 404);

  const done = await finish!("member-code");
  assert.equal(done.status, 200, await done.text());
  const [ready] = await getDb().select().from(managedMcpCredentials).where(eq(managedMcpCredentials.id, connectionId));
  assert.equal(ready!.authStatus, "ready");
  assert.equal(ready!.signedInByUserId, f.member.id);
  assert.equal(ready!.ownerUserId, f.member.id);
  const grants = await grantsOf(f);
  assert.equal(grants.get(f.membersAgent.id), connectionId);
  assert.equal(grants.get(f.othersAgent.id), connectionId);
  assert.equal(await admittedMcpConnectionId(getDb(), f.server.id, f.othersAgent.id, f.app.id), connectionId, "the agent now acts as the member");

  // Tenny's guard: the other member's agent (not the member's own) tells its owner and the admins;
  // the member's own agent tells nobody; the member is never told about their own act.
  const sent = await notices("mcp_personal_grant:");
  const receivers = sent.map((notice) => notice.receiverId).sort();
  assert.deepEqual(receivers, [f.owner.id, f.admin.id, f.other.id].sort());
  assert.ok(sent.every((notice) => notice.eventKey.endsWith(f.othersAgent.id)));
  const text = JSON.stringify(sent[0]!.payload);
  assert.match(text, /acct-member/u);
  assert.match(text, /Docs/u);
  assert.match(text, new RegExp(`OthersBot${f.suffix}`, "u"));

  // Audit: created, signed_in, agents_changed (via sign_in), none carrying the label or the endpoint.
  const [created] = await audit(f, "mcp_connection.created");
  assert.equal(created!.actorId, f.member.id);
  assert.deepEqual(created!.metadata, { appId: f.app.id, appName: "Docs", connectionId, ownerKind: "personal", ownerUserId: f.member.id, authKind: "oauth" });
  assert.equal((await audit(f, "mcp_connection.signed_in")).length, 1);
  const [changed] = await audit(f, "mcp_connection.agents_changed");
  assert.deepEqual((changed!.metadata as Json).added, [f.membersAgent.id, f.othersAgent.id]);
  assert.equal((changed!.metadata as Json).via, "sign_in");
  assert.equal((changed!.metadata as Json).granted_by, f.member.id);
  assert.equal((changed!.metadata as Json).actorRole, "member", "the callback's grant runs under the owner's membership fence");

  // Signing in again on one's own Connection: a sign-in, not a creation.
  const again = await startPersonal(app.baseUrl, f, f.member.email, { connectionId });
  assert.equal(again.started.status, 200);
  assert.equal((await again.finish!("again")).status, 200);
  assert.equal((await audit(f, "mcp_connection.created")).length, 1);
  assert.equal((await audit(f, "mcp_connection.signed_in")).length, 2);

  // A personal account needs an OAuth App (API-key personal Connections are not built: O2).
  await getDb().update(managedMcpServers).set({ authMode: "headers" }).where(eq(managedMcpServers.id, f.app.id));
  const keyApp = await call(app.baseUrl, f, "POST", startPath, f.member.email, { kind: "personal", name: "Key" });
  assert.equal(keyApp.status, 400);
  assert.equal(keyApp.body.code, "managed_mcp_personal_oauth_only");

  const all = JSON.stringify(await getDb().select().from(integrationAuditEvents).where(eq(integrationAuditEvents.serverId, f.server.id)));
  assert.equal(all.includes(LABEL), false, "never the account label");
  assert.equal(all.includes("docs-accounts.example.test"), false, "never the endpoint");
  assert.equal(all.includes("access-for-"), false, "never a token");
});

test("personal sign-in callback re-checks: toggle off, flag off, the person a guest or gone in between: nothing is created", async ({ app }) => {
  const f = await seed();
  await setFlag(true);
  await getDb().update(managedMcpServers).set({ membersCanConnect: true }).where(eq(managedMcpServers.id, f.app.id));

  const refusedCase = async (label: string, change: () => Promise<void>, undo: () => Promise<void>) => {
    const { started, finish } = await startPersonal(app.baseUrl, f, f.member.email, { name: `Mine ${label}`, intent: { agentIds: [f.membersAgent.id] } });
    assert.equal(started.status, 200, `${label}: ${JSON.stringify(started.body)}`);
    await change();
    const res = await finish!(`code-${label}`);
    assert.equal(res.status, 400, label);
    const rows = await getDb().select().from(managedMcpCredentials).where(eq(managedMcpCredentials.id, started.body.connectionId as string));
    assert.equal(rows.length, 0, `${label}: the pending Connection is not created`);
    assert.equal((await grantsOf(f)).size, 0, `${label}: no grant`);
    await undo();
  };

  await refusedCase("toggle", async () => {
    assert.equal((await call(app.baseUrl, f, "PUT", `/apps/${f.app.id}/members-can-connect`, f.admin.email, { enabled: false })).status, 200);
  }, async () => {
    await getDb().update(managedMcpServers).set({ membersCanConnect: true }).where(eq(managedMcpServers.id, f.app.id));
  });
  await refusedCase("flag", () => setFlag(false), () => setFlag(true));
  await refusedCase("guest", async () => {
    await seedBoundGuest({ serverId: f.server.id, userId: f.member.id });
  }, async () => {
    await getDb().update(serverMembers).set({ role: "member", guestChannelId: null })
      .where(and(eq(serverMembers.serverId, f.server.id), eq(serverMembers.userId, f.member.id)));
  });
  await refusedCase("left", async () => {
    await getDb().delete(serverMembers).where(and(eq(serverMembers.serverId, f.server.id), eq(serverMembers.userId, f.member.id)));
  }, async () => {
    await addMember(f.server.id, f.member.id, "member");
  });

  assert.equal((await audit(f, "mcp_connection.created")).length, 0);
  assert.equal((await audit(f, "mcp_connection.signed_in")).length, 0);

  // A sign-in on an existing own Connection refused at the callback keeps the Connection.
  const mine = await personalConnection(f, f.member.id, "Kept");
  const { started, finish } = await startPersonal(app.baseUrl, f, f.member.email, { connectionId: mine.id });
  assert.equal(started.status, 200);
  await setFlag(false);
  assert.equal((await finish!("kept")).status, 400);
  assert.equal((await getDb().select().from(managedMcpCredentials).where(eq(managedMcpCredentials.id, mine.id))).length, 1);
});

test("agents API, personal: the owner only, any agent they can find, a move in one write tells the previous owner, the agent's owner and the admins", async ({ app }) => {
  const f = await seed();
  await setFlag(true);
  const mine = await personalConnection(f, f.member.id, "Mine");
  const theirs = await personalConnection(f, f.other.id, "Theirs");
  const put = (email: string, connectionId: string, body: Json) => call(app.baseUrl, f, "PUT", `/connections/${connectionId}/agents`, email, body);

  // The other member gives theirs to the owner's agent: not theirs, so its owner and the admins are told.
  const first = await put(f.other.email, theirs.id, { agentIds: [f.ownersAgent.id] });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.deepEqual(first.body, { connectionId: theirs.id, kind: "personal", allAgents: false, agentIds: [f.ownersAgent.id], added: [f.ownersAgent.id], removed: [], moved: [] });
  assert.deepEqual((await notices("mcp_personal_grant:")).map((notice) => notice.receiverId).sort(), [f.owner.id, f.admin.id].sort());

  // Who may: the owner only, flag on; not all agents; not someone else's personal assistant.
  assert.equal((await put(f.admin.email, mine.id, { agentIds: [f.membersAgent.id] })).status, 403, "an admin");
  assert.equal((await put(f.other.email, mine.id, { agentIds: [f.membersAgent.id] })).status, 403, "another member");
  assert.equal((await put(f.guest.email, mine.id, { agentIds: [f.membersAgent.id] })).status, 403, "a guest");
  const agentStatus = await asAgent(app.baseUrl, f, "PUT", `/connections/${mine.id}/agents`, { agentIds: [f.membersAgent.id] });
  assert.ok(agentStatus === 401 || agentStatus === 403, `an agent's credential (${agentStatus})`);
  assert.equal((await put(f.member.email, mine.id, { allAgents: true, agentIds: [] })).status, 400);
  assert.equal((await put(f.member.email, mine.id, { agentIds: [f.othersAssistant.id] })).status, 404, "another person's personal assistant is no agent to them");
  assert.equal((await put(f.member.email, randomUUID(), { agentIds: [] })).status, 404);
  await setFlag(false);
  const flagOff = await put(f.member.email, mine.id, { agentIds: [f.membersAgent.id] });
  assert.equal(flagOff.status, 409);
  assert.equal(flagOff.body.code, "managed_mcp_personal_accounts_off");
  await setFlag(true);
  // The toggle off does not stop the owner choosing agents for an existing Connection (Q26).
  assert.equal((await getDb().select().from(managedMcpServers).where(eq(managedMcpServers.id, f.app.id)))[0]!.membersCanConnect, false);

  // The member gives theirs to their own assistant and to the owner's agent: the latter MOVES.
  const moved = await put(f.member.email, mine.id, { agentIds: [f.membersAssistant.id, f.ownersAgent.id] });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.deepEqual(moved.body.moved, [{ agentId: f.ownersAgent.id, fromConnectionId: theirs.id, fromKind: "personal", fromOwnerUserId: f.other.id }]);
  const grants = await grantsOf(f);
  assert.equal(grants.get(f.ownersAgent.id), mine.id, "one grant per agent and App: replaced");
  assert.equal(grants.get(f.membersAssistant.id), mine.id);
  assert.equal(await admittedMcpConnectionId(getDb(), f.server.id, f.ownersAgent.id, f.app.id), mine.id);

  const sent = await notices(`mcp_personal_grant:`);
  const forMove = sent.filter((notice) => notice.eventKey.includes(f.ownersAgent.id));
  const previous = await notices("mcp_personal_grant_moved:");
  assert.deepEqual(previous.map((notice) => notice.receiverId), [f.other.id], "the previous owner");
  assert.match(JSON.stringify(previous[0]!.payload), /no longer uses your Docs account/u);
  // Owner and admin told twice (the other member's grant, then the move); never the member themselves.
  assert.equal(forMove.filter((notice) => notice.receiverId === f.owner.id).length, 2);
  assert.equal(forMove.filter((notice) => notice.receiverId === f.admin.id).length, 2);
  assert.equal(sent.some((notice) => notice.receiverId === f.member.id), false);
  assert.equal(sent.some((notice) => notice.eventKey.includes(f.membersAssistant.id)), false, "their own assistant tells nobody");

  // Choosing none removes them all; the agent falls back to its shared account (the default).
  const none = await put(f.member.email, mine.id, { agentIds: [] });
  assert.deepEqual(none.body.removed.sort(), [f.membersAssistant.id, f.ownersAgent.id].sort());
  assert.equal(await admittedMcpConnectionId(getDb(), f.server.id, f.ownersAgent.id, f.app.id), f.team.id);

  const changed = await audit(f, "mcp_connection.agents_changed");
  const move = changed.find((event) => (event.metadata as Json).connectionId === mine.id && ((event.metadata as Json).added as string[]).length === 2)!;
  assert.deepEqual((move.metadata as Json).moved_from, [{ agentId: f.ownersAgent.id, connectionId: theirs.id, ownerKind: "personal", ownerUserId: f.other.id }]);
  assert.equal((move.metadata as Json).via, "agents_api");
  assert.equal(move.subjectId, f.member.id);
  const all = JSON.stringify(changed);
  assert.equal(all.includes(LABEL), false);
  assert.equal(all.includes("docs-accounts.example.test"), false);
});

test("agents API, shared: admins only; pins exactly the listed agents, unlisted ones follow the default; allAgents is the default; an admin pinning someone else's Connection is audited, from every route", async ({ app }) => {
  const f = await seed();
  const put = (email: string, connectionId: string, body: Json) => call(app.baseUrl, f, "PUT", `/connections/${connectionId}/agents`, email, body);

  assert.equal((await put(f.member.email, f.ops.id, { agentIds: [f.membersAgent.id] })).status, 403, "a member");
  assert.equal((await put(f.guest.email, f.ops.id, { agentIds: [] })).status, 403, "a guest");
  const agentStatus = await asAgent(app.baseUrl, f, "PUT", `/connections/${f.ops.id}/agents`, { agentIds: [] });
  assert.ok(agentStatus === 401 || agentStatus === 403, `an agent's credential (${agentStatus})`);

  // The admin pins two agents to the Connection they added.
  const pinned = await put(f.admin.email, f.ops.id, { agentIds: [f.membersAgent.id, f.othersAgent.id] });
  assert.equal(pinned.status, 200, JSON.stringify(pinned.body));
  assert.deepEqual(await pinOf(f.membersAgent.id, f.app.id), { mode: "pinned", bound: f.ops.id });
  assert.equal(await admittedMcpConnectionId(getDb(), f.server.id, f.othersAgent.id, f.app.id), f.ops.id);

  // The owner narrows it to one: the other goes back to the default (its shared account), not a dead pin.
  const narrowed = await put(f.owner.email, f.ops.id, { agentIds: [f.membersAgent.id] });
  assert.deepEqual(narrowed.body.removed, [f.othersAgent.id]);
  assert.deepEqual(await pinOf(f.othersAgent.id, f.app.id), { mode: "default", bound: null });
  assert.equal(await admittedMcpConnectionId(getDb(), f.server.id, f.othersAgent.id, f.app.id), f.team.id);

  // Pinning to another shared Connection reports the move.
  const toTeam = await put(f.admin.email, f.team.id, { agentIds: [f.membersAgent.id] });
  assert.deepEqual(toTeam.body.moved, [{ agentId: f.membersAgent.id, fromConnectionId: f.ops.id, fromKind: "shared", fromOwnerUserId: null }]);

  // allAgents: the default; with agentIds it is refused.
  assert.equal((await put(f.owner.email, f.ops.id, { allAgents: true, agentIds: [f.ownersAgent.id] })).status, 400);
  const all = await put(f.owner.email, f.ops.id, { allAgents: true, agentIds: [] });
  assert.equal(all.status, 200);
  assert.equal(all.body.allAgents, true);
  const [opsRow] = await getDb().select().from(managedMcpCredentials).where(eq(managedMcpCredentials.id, f.ops.id));
  assert.equal(opsRow!.isServerDefault, true);
  assert.equal(await admittedMcpConnectionId(getDb(), f.server.id, f.ownersAgent.id, f.app.id), f.ops.id);
  // A personal Connection is never pinned through the shared path, nor the default.
  await setFlag(true);
  const mine = await personalConnection(f, f.member.id, "Mine");
  assert.equal((await put(f.owner.email, mine.id, { allAgents: true, agentIds: [] })).status, 403, "an admin can't choose a member's own account's agents");

  // The assignments routes write the same audit (Tenny): the owner pins an agent to the admin's Connection.
  const single = await call(app.baseUrl, f, "PUT", `/agents/${f.ownersAgent.id}/assignments/${f.app.id}`, f.owner.email, { connectionId: f.team.id });
  assert.equal(single.status, 200, JSON.stringify(single.body));
  const bulk = await call(app.baseUrl, f, "PUT", `/agents/${f.othersAgent.id}/assignments`, f.owner.email, { assignments: [{ mcpServerId: f.app.id, connectionId: f.ops.id }] });
  assert.equal(bulk.status, 200, JSON.stringify(bulk.body));

  const events = await audit(f, "mcp_connection.agents_changed");
  const row = (connectionId: string, actorId: string, via: string, added: string[]) =>
    events.find((event) => {
      const metadata = event.metadata as Json;
      return metadata.connectionId === connectionId && event.actorId === actorId && metadata.via === via && JSON.stringify(metadata.added) === JSON.stringify(added);
    });
  const byCreator = row(f.ops.id, f.admin.id, "agents_api", [f.membersAgent.id, f.othersAgent.id]);
  assert.equal((byCreator!.metadata as Json).byConnectionCreator, true);
  const ownerOnAdmins = events.find((event) => (event.metadata as Json).connectionId === f.ops.id && event.actorId === f.owner.id && (event.metadata as Json).via === "agents_api" && ((event.metadata as Json).removed as string[]).length === 1);
  assert.equal((ownerOnAdmins!.metadata as Json).connectionCreatedBy, f.admin.id);
  assert.equal((ownerOnAdmins!.metadata as Json).byConnectionCreator, false, "an admin changed pins of a Connection someone else added");
  const allAgentsEvent = events.find((event) => (event.metadata as Json).allAgents === true);
  assert.equal((allAgentsEvent!.metadata as Json).connectionId, f.ops.id);
  const viaSingle = row(f.team.id, f.owner.id, "assignments", [f.ownersAgent.id]);
  assert.ok(viaSingle, "the single assignment route");
  const viaBulk = row(f.ops.id, f.owner.id, "assignments", [f.othersAgent.id]);
  assert.equal((viaBulk!.metadata as Json).byConnectionCreator, false, "the bulk route: the owner pinned to the admin's Connection");
  assert.equal(JSON.stringify(events).includes("@corp.example"), false, "never a label");
});

test("delete: a member's own by its owner or an admin (revoke, the owner told); a shared one by admins; tokens and grants go", async ({ app }) => {
  const f = await seed();
  await setFlag(true);
  const mine = await personalConnection(f, f.member.id, "Mine");
  const theirs = await personalConnection(f, f.other.id, "Theirs");
  await getDb().insert(managedMcpPersonalGrants).values({ serverId: f.server.id, agentId: f.othersAgent.id, mcpServerId: f.app.id, connectionId: theirs.id, grantedByUserId: f.other.id });
  const del = (email: string, connectionId: string) => call(app.baseUrl, f, "DELETE", `/connections/${connectionId}`, email);

  assert.equal((await del(f.other.email, mine.id)).status, 403, "another member");
  assert.equal((await del(f.guest.email, mine.id)).status, 403, "a guest");
  assert.equal((await del(f.member.email, f.team.id)).status, 403, "a member, a shared one");
  const agentStatus = await asAgent(app.baseUrl, f, "DELETE", `/connections/${mine.id}`);
  assert.ok(agentStatus === 401 || agentStatus === 403, `an agent's credential (${agentStatus})`);

  // The owner deletes their own, flag off or not; nobody is told.
  await setFlag(false);
  assert.equal((await del(f.member.email, mine.id)).status, 204);
  await setFlag(true);
  assert.equal((await notices("mcp_personal_revoked:")).length, 0);

  // An admin revokes the other member's: its grant goes with it, the agent falls back, the owner is told.
  assert.equal((await del(f.admin.email, theirs.id)).status, 204);
  assert.equal((await getDb().select().from(managedMcpCredentials).where(eq(managedMcpCredentials.id, theirs.id))).length, 0);
  assert.equal((await grantsOf(f)).size, 0);
  assert.equal(await admittedMcpConnectionId(getDb(), f.server.id, f.othersAgent.id, f.app.id), f.team.id);
  const revoked = await notices("mcp_personal_revoked:");
  assert.deepEqual(revoked.map((notice) => notice.receiverId), [f.other.id]);
  assert.match(JSON.stringify(revoked[0]!.payload), /removed your Docs account/u);

  // A shared one: an admin, through either route; it was the default, so the App has none now.
  assert.equal((await call(app.baseUrl, f, "DELETE", `/apps/${f.app.id}/connections/${f.ops.id}`, f.member.email)).status, 403);
  assert.equal((await call(app.baseUrl, f, "DELETE", `/apps/${f.app.id}/connections/${f.ops.id}`, f.owner.email)).status, 204);
  assert.equal((await del(f.owner.email, f.team.id)).status, 204);
  const [appRow] = await getDb().select().from(managedMcpServers).where(eq(managedMcpServers.id, f.app.id));
  assert.equal(appRow!.oauthStatus, "disconnected");
  assert.equal((await del(f.owner.email, f.team.id)).status, 404);

  const deleted = await audit(f, "mcp_connection.deleted");
  assert.deepEqual(deleted.map((event) => [event.actorId, (event.metadata as Json).connectionId, (event.metadata as Json).revokedBy ?? null]), [
    [f.member.id, mine.id, null],
    [f.admin.id, theirs.id, f.admin.id],
    [f.owner.id, f.ops.id, null],
    [f.owner.id, f.team.id, null],
  ]);
  assert.deepEqual((deleted[1]!.metadata as Json).agentIds, [f.othersAgent.id]);
  assert.equal((deleted[3]!.metadata as Json).wasServerDefault, true);
  assert.equal(JSON.stringify(deleted).includes("@corp.example"), false);
});

test("reads: GET /accounts and the App view per role; agents in external channels are marked", async ({ app }) => {
  const f = await seed();
  await setFlag(true);
  const mine = await personalConnection(f, f.member.id, "Mine");
  const theirs = await personalConnection(f, f.other.id, "Theirs");
  await getDb().insert(managedMcpPersonalGrants).values([
    { serverId: f.server.id, agentId: f.membersAssistant.id, mcpServerId: f.app.id, connectionId: mine.id, grantedByUserId: f.member.id },
    { serverId: f.server.id, agentId: f.membersAgent.id, mcpServerId: f.app.id, connectionId: mine.id, grantedByUserId: f.member.id },
    { serverId: f.server.id, agentId: f.othersAssistant.id, mcpServerId: f.app.id, connectionId: theirs.id, grantedByUserId: f.other.id },
  ]);
  await getDb().insert(managedMcpAssignments).values({ serverId: f.server.id, agentId: f.ownersAgent.id, mcpServerId: f.app.id, enabled: true, connectionMode: "pinned", boundConnectionId: f.ops.id });
  // The member's agent is in a channel with a Guest bound to it: an external channel.
  const external = await createChannel(f.server.id, `external-${f.suffix}`, undefined, "private");
  const visitor = await seedUser("acct-visitor");
  await seedBoundGuest({ serverId: f.server.id, userId: visitor.id, channelId: external.id });
  await getDb().insert(channelAgents).values({ channelId: external.id, agentId: f.membersAgent.id });

  const asMember = await call(app.baseUrl, f, "GET", "/accounts", f.member.email);
  assert.equal(asMember.status, 200);
  assert.deepEqual(Object.keys(asMember.body).sort(), ["mine", "personalAccounts"]);
  assert.equal(asMember.body.mine.length, 1);
  const row = asMember.body.mine[0];
  assert.equal(row.connectionId, mine.id);
  assert.equal(row.kind, "personal");
  assert.equal(row.label, LABEL);
  assert.deepEqual(row.owner, { userId: f.member.id, departed: false });
  assert.deepEqual(row.signedInBy, { userId: f.member.id, departed: false });
  assert.equal(row.status, "ready");
  assert.deepEqual(row.app, { id: f.app.id, name: "Docs", logoUrl: null });
  // Agents created in the same millisecond tie on created_at: compare as a set.
  const byAgentId = (a: Json, b: Json) => String(a.agentId).localeCompare(String(b.agentId));
  assert.deepEqual([...row.agents].sort(byAgentId), [
    { agentId: f.membersAgent.id, inExternalChannels: true },
    { agentId: f.membersAssistant.id, inExternalChannels: false },
  ].sort(byAgentId));

  const asAdmin = await call(app.baseUrl, f, "GET", "/accounts", f.admin.email);
  assert.deepEqual(asAdmin.body.mine, []);
  // Rows created in the same millisecond tie on createdAt and fall back to the random id: compare as sets.
  const byId = (a: readonly unknown[], b: readonly unknown[]) => String(a[0]).localeCompare(String(b[0]));
  assert.deepEqual(asAdmin.body.shared.map((account: Json) => [account.connectionId, account.allAgents]).sort(byId), [[f.team.id, true], [f.ops.id, false]].sort(byId));
  assert.deepEqual(asAdmin.body.shared.find((account: Json) => account.connectionId === f.ops.id).agents, [{ agentId: f.ownersAgent.id, inExternalChannels: false }]);
  assert.deepEqual(asAdmin.body.members.map((account: Json) => account.connectionId).sort(), [mine.id, theirs.id].sort());
  const theirsRow = asAdmin.body.members.find((account: Json) => account.connectionId === theirs.id);
  assert.deepEqual(theirsRow.agents, [], "another person's personal assistant is not shown to an admin");
  assert.equal((await call(app.baseUrl, f, "GET", "/accounts", f.guest.email)).status, 403);

  // The App view: a member sees only their own Connections and what their own agents use.
  const memberView = await call(app.baseUrl, f, "GET", `/apps/${f.app.id}`, f.member.email);
  assert.deepEqual(memberView.body.connections.map((connection: Json) => [connection.id, connection.ownerKind, connection.owner?.userId]), [[mine.id, "personal", f.member.id]]);
  const accountOf = (view: Json, agentId: string) => view.myAgents.find((entry: Json) => entry.agentId === agentId)?.account;
  assert.deepEqual(accountOf(memberView.body, f.membersAgent.id), { kind: "personal", connectionId: mine.id, name: "Mine", label: LABEL, ownerUserId: f.member.id });
  const otherView = await call(app.baseUrl, f, "GET", `/apps/${f.app.id}`, f.other.email);
  assert.deepEqual(otherView.body.connections.map((connection: Json) => connection.id), [theirs.id]);
  assert.deepEqual(accountOf(otherView.body, f.othersAgent.id), { kind: "shared", name: "Team", label: "team@corp.example" }, "kind and label, no shared id for a member");
  const adminView = await call(app.baseUrl, f, "GET", `/apps/${f.app.id}`, f.admin.email);
  assert.deepEqual(adminView.body.connections.map((connection: Json) => [connection.id, connection.ownerKind]).sort(byId), [
    [f.team.id, "shared"], [f.ops.id, "shared"], [mine.id, "personal"], [theirs.id, "personal"],
  ].sort(byId));
  assert.deepEqual(adminView.body.connections.find((connection: Json) => connection.id === f.team.id).owner, null);
});

test("a personal sign-in leaves the App's tool catalogue alone; a shared one updates it", async ({ app }) => {
  const f = await seed();
  await setFlag(true);
  await getDb().update(managedMcpServers)
    .set({ membersCanConnect: true, toolCatalog: [{ name: "shared-only", inputSchema: { type: "object" } }] })
    .where(eq(managedMcpServers.id, f.app.id));
  const catalogue = async () => {
    const [row] = await getDb().select({ toolCatalog: managedMcpServers.toolCatalog, catalogVersion: managedMcpServers.catalogVersion })
      .from(managedMcpServers).where(eq(managedMcpServers.id, f.app.id));
    return { names: row!.toolCatalog.map((tool) => tool.name), version: row!.catalogVersion };
  };
  const before = await catalogue();

  // The member's own account lists other tools (the fake provider lists `search`): what everyone sees stays.
  const personal = await startPersonal(app.baseUrl, f, f.member.email, { name: "Mine" });
  assert.equal(personal.started.status, 200);
  assert.equal((await personal.finish!("member-code")).status, 200);
  const [mine] = await getDb().select().from(managedMcpCredentials).where(eq(managedMcpCredentials.id, personal.started.body.connectionId as string));
  assert.equal(mine!.authStatus, "ready", "the member's sign-in completed");
  assert.deepEqual(await catalogue(), before, "a member's own account doesn't change the App's catalogue");

  // A shared sign-in (an admin's new Connection) does, as before.
  const started = await call(app.baseUrl, f, "POST", `/apps/${f.app.id}/connections/oauth/start`, f.owner.email, { name: "Another shared" });
  assert.equal(started.status, 200);
  const state = new URL(started.body.authorizationUrl as string).searchParams.get("state")!;
  const cookie = started.headers.getSetCookie()[0]!.split(";")[0]!;
  const done = await fetch(`${app.baseUrl}/api/mcp/oauth/callback?state=${encodeURIComponent(state)}&code=shared-code`, { headers: { Cookie: cookie } });
  assert.equal(done.status, 200);
  const after = await catalogue();
  assert.deepEqual(after.names, ["search"]);
  assert.ok(after.version > before.version);
});

test("GET /apps connectionCount: managers count every Connection; anyone else the shared ones and their own", async ({ app }) => {
  const f = await seed();
  await personalConnection(f, f.member.id, "Mine");
  await personalConnection(f, f.other.id, "Theirs");
  await personalConnection(f, f.other.id, "Theirs too");
  const countAs = async (email: string) => {
    const res = await call(app.baseUrl, f, "GET", "/apps", email);
    assert.equal(res.status, 200);
    return (res.body.apps as Json[]).find((item) => item.id === f.app.id)!.status.connectionCount as number;
  };
  assert.equal(await countAs(f.admin.email), 5, "2 shared + 3 personal");
  assert.equal(await countAs(f.owner.email), 5);
  assert.equal(await countAs(f.member.email), 3, "2 shared + their own");
  assert.equal(await countAs(f.other.email), 4, "2 shared + their two");
});

test("shared agents API: the list an admin saves is the list they can see; the agents' config revision moves", async ({ app }) => {
  const f = await seed();
  // The admin's own personal assistant, pinned to Ops by the admin (nobody else can find it).
  const adminsAssistant = await createAgent(f.server.id, `AdminsPA${f.suffix}`, { runtime: "claude", model: "sonnet", creatorType: "user", creatorId: f.admin.id });
  await getDb().update(agents).set({ assistantOwnerUserId: f.admin.id }).where(eq(agents.id, adminsAssistant.id));
  const pinAssistant = await call(app.baseUrl, f, "PUT", `/agents/${adminsAssistant.id}/assignments/${f.app.id}`, f.admin.email, { connectionId: f.ops.id });
  assert.equal(pinAssistant.status, 200, JSON.stringify(pinAssistant.body));
  const revision = async (agentId: string) => (await getDb().select({ revision: agents.configRevision }).from(agents).where(eq(agents.id, agentId)))[0]!.revision;
  const before = await revision(f.membersAgent.id);

  // The owner saves Ops' list: the admin's assistant is neither unpinned nor named back.
  const saved = await call(app.baseUrl, f, "PUT", `/connections/${f.ops.id}/agents`, f.owner.email, { agentIds: [f.membersAgent.id] });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual(saved.body.agentIds, [f.membersAgent.id]);
  assert.deepEqual(saved.body.removed, []);
  assert.deepEqual(await pinOf(adminsAssistant.id, f.app.id), { mode: "pinned", bound: f.ops.id });
  assert.ok(await revision(f.membersAgent.id) > before, "the pinned agent's config revision moved, so its daemon takes the change");
  const all = await call(app.baseUrl, f, "PUT", `/connections/${f.ops.id}/agents`, f.owner.email, { allAgents: true, agentIds: [] });
  assert.deepEqual(all.body.agentIds, [f.membersAgent.id], "allAgents names only agents the caller can find");
  assert.deepEqual(await pinOf(adminsAssistant.id, f.app.id), { mode: "pinned", bound: f.ops.id });

  // PUT /apps/:appId/default is audited the same way (allAgents on the new default and the old one).
  const toTeam = await call(app.baseUrl, f, "PUT", `/apps/${f.app.id}/default`, f.owner.email, { connectionId: f.team.id });
  assert.equal(toTeam.status, 200);
  const defaults = (await audit(f, "mcp_connection.agents_changed"))
    .filter((event) => (event.metadata as Json).via === "default")
    .map((event) => [(event.metadata as Json).connectionId, (event.metadata as Json).allAgents, (event.metadata as Json).actorRole])
    // One transaction's rows share created_at: compare as a set.
    .sort((a, b) => Number(b[1]) - Number(a[1]));
  assert.deepEqual(defaults, [[f.team.id, true, "owner"], [f.ops.id, false, "owner"]]);
  const viaApi = (await audit(f, "mcp_connection.agents_changed")).filter((event) => (event.metadata as Json).allAgents === true && (event.metadata as Json).via === "agents_api");
  assert.equal(viaApi.length, 1, "the agents API's allAgents is audited once");
});

test("older per-Connection routes on a member's own Connection: sign-out by its owner or an admin (revoke), rename by its owner, App-scoped delete by its owner", async ({ app }) => {
  const f = await seed();
  await setFlag(true);
  const mine = await personalConnection(f, f.member.id, "Mine");
  const theirs = await personalConnection(f, f.other.id, "Theirs");
  const signOut = (email: string, connectionId: string) => call(app.baseUrl, f, "DELETE", `/apps/${f.app.id}/connections/${connectionId}/oauth`, email);
  const row = async (id: string) => (await getDb().select().from(managedMcpCredentials).where(eq(managedMcpCredentials.id, id)))[0];

  // Sign-out: another member no; the owner yes (no admin capability needed), nobody told.
  assert.equal((await signOut(f.other.email, mine.id)).status, 403);
  assert.equal((await row(mine.id))!.authStatus, "ready", "a refusal signs nothing out");
  assert.equal((await signOut(f.member.email, mine.id)).status, 204);
  assert.equal((await row(mine.id))!.authStatus, "needs_auth");
  assert.equal((await row(mine.id))!.signedInByUserId, null);
  // An admin signing out someone else's: a revoke, audited and told.
  assert.equal((await signOut(f.admin.email, theirs.id)).status, 204);
  const signedOut = await audit(f, "mcp_connection.signed_out");
  assert.deepEqual(signedOut.map((event) => [event.actorId, (event.metadata as Json).connectionId, (event.metadata as Json).revokedBy ?? null]), [
    [f.member.id, mine.id, null],
    [f.admin.id, theirs.id, f.admin.id],
  ]);
  const told = await notices("mcp_personal_signed_out:");
  assert.deepEqual(told.map((notice) => notice.receiverId), [f.other.id]);
  assert.match(JSON.stringify(told[0]!.payload), /signed out your Docs account/u);
  // A shared one: as before, admins only.
  assert.equal((await signOut(f.member.email, f.ops.id)).status, 403);
  assert.equal((await signOut(f.admin.email, f.ops.id)).status, 204);

  // Rename: the owner only, a name only; an admin can't rename a member's own.
  const rename = (email: string, connectionId: string, patch: Json) => call(app.baseUrl, f, "PATCH", `/apps/${f.app.id}/connections/${connectionId}`, email, patch);
  const renamed = await rename(f.member.email, mine.id, { name: "Work mail" });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
  assert.equal((await row(mine.id))!.name, "Work mail");
  assert.equal((await rename(f.admin.email, mine.id, { name: "Admin's" })).status, 403);
  assert.equal((await rename(f.member.email, mine.id, { headers: { "X-Api-Key": "k" } })).status, 400);
  assert.equal((await rename(f.member.email, f.ops.id, { name: "Not mine" })).status, 403, "a member can't rename a shared one");
  const agentStatus = await asAgent(app.baseUrl, f, "PATCH", `/apps/${f.app.id}/connections/${mine.id}`, { name: "Agent's" });
  assert.ok(agentStatus === 401 || agentStatus === 403, `an agent's credential (${agentStatus})`);

  // A refused delete leaves the sign-in alone (authorized before any token goes).
  const kept = await personalConnection(f, f.member.id, "Kept");
  assert.equal((await call(app.baseUrl, f, "DELETE", `/apps/${f.app.id}/connections/${kept.id}`, f.other.email)).status, 403);
  assert.equal((await row(kept.id))!.encryptedOAuth, kept.encryptedOAuth, "the tokens are untouched");
  assert.equal((await row(kept.id))!.authStatus, "ready");
  // The App-scoped delete: the owner, with no admin capability.
  assert.equal((await call(app.baseUrl, f, "DELETE", `/apps/${f.app.id}/connections/${kept.id}`, f.member.email)).status, 204);
  assert.equal(await row(kept.id), undefined);
});

test("abuse guards: rate limits, reclaim only one's own abandoned rows, a grant notice once per Connection and agent", async ({ app }) => {
  const f = await seed();
  await setFlag(true);
  const mine = await personalConnection(f, f.member.id, "Mine");

  // Grant, take back, grant again: the admins hear about it once (the outbox's stable key).
  const put = (agentIds: string[]) => call(app.baseUrl, f, "PUT", `/connections/${mine.id}/agents`, f.member.email, { agentIds });
  assert.equal((await put([f.othersAgent.id])).status, 200);
  assert.equal((await put([])).status, 200);
  assert.equal((await put([f.othersAgent.id])).status, 200);
  const sent = await notices("mcp_personal_grant:");
  assert.equal(sent.filter((notice) => notice.receiverId === f.admin.id).length, 1);
  assert.equal(sent.filter((notice) => notice.receiverId === f.other.id).length, 1);

  // An admin's abandoned shared sign-in survives a member's personal start; a shared start reclaims it.
  await getDb().update(managedMcpServers).set({ membersCanConnect: true }).where(eq(managedMcpServers.id, f.app.id));
  const longAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  const [abandoned] = await getDb().insert(managedMcpCredentials).values({
    serverId: f.server.id, mcpServerId: f.app.id, isServerDefault: false, name: "Abandoned", authKind: "oauth", authStatus: "pending",
    createdByUserId: f.admin.id, createdAt: longAgo,
  }).returning();
  const personal = await call(app.baseUrl, f, "POST", `/apps/${f.app.id}/connections/oauth/start`, f.member.email, { kind: "personal", name: "Fresh" });
  assert.equal(personal.status, 200);
  assert.equal((await getDb().select().from(managedMcpCredentials).where(eq(managedMcpCredentials.id, abandoned!.id))).length, 1, "not the member's to reclaim");
  const shared = await call(app.baseUrl, f, "POST", `/apps/${f.app.id}/connections/oauth/start`, f.owner.email, { name: "Another" });
  assert.equal(shared.status, 200);
  assert.equal((await getDb().select().from(managedMcpCredentials).where(eq(managedMcpCredentials.id, abandoned!.id))).length, 0, "a shared start reclaims shared rows");

  // Rate limits: the agents API and personal starts, per person.
  let last = 0;
  for (let i = 0; i < 31; i += 1) last = (await call(app.baseUrl, f, "PUT", `/connections/${mine.id}/agents`, f.member.email, { agentIds: "nope" })).status;
  assert.equal(last, 429, "the agents API is rate limited");
  for (let i = 0; i < 11; i += 1) last = (await call(app.baseUrl, f, "POST", `/apps/${f.app.id}/connections/oauth/start`, f.other.email, { kind: "personal" })).status;
  assert.equal(last, 429, "personal starts are rate limited");
  assert.notEqual((await call(app.baseUrl, f, "POST", `/apps/${f.app.id}/connections/oauth/start`, f.owner.email, { name: "Shared again" })).status, 429, "a shared start is not");
});

test("sign-in starts and agent assignments: a person's own session only (assistant as owner, card dispatch refused); the person's own session works", async ({ app }) => {
  const f = await seed();
  const routes: Array<{ method: "POST" | "PUT"; path: string; body: Json }> = [
    { method: "POST", path: `/apps/${f.app.id}/connections/oauth/start`, body: { name: "Shared start" } },
    { method: "POST", path: `/servers/${f.app.id}/oauth/start`, body: {} },
    // The Connect card dialog's own write.
    { method: "PUT", path: `/agents/${f.membersAgent.id}/assignments/${f.app.id}`, body: { connectionId: f.ops.id, enabled: true } },
    { method: "PUT", path: `/agents/${f.membersAgent.id}/assignments`, body: { assignments: [{ mcpServerId: f.app.id, connectionId: f.ops.id, enabled: true }] } },
  ];
  const attempts = async () => (await getDb().select().from(managedMcpOAuthAttempts).where(eq(managedMcpOAuthAttempts.mcpServerId, f.app.id))).length;

  // An assistant acting as its owner: assistantAsOwner admits nothing under /api/mcp today, so the
  // route's own check is exercised with the request as it would arrive (sessionScope, viaAssistant).
  const stub = express();
  stub.use(express.json());
  stub.use((req, _res, next) => {
    req.userId = f.owner.id;
    req.serverId = f.server.id as typeof req.serverId;
    req.sessionScope = "assistant_as_owner";
    req.viaAssistant = { agentId: f.ownersAgent.id, serverId: f.server.id, actionKey: "test" };
    next();
  });
  stub.use("/api/mcp", managedMcpRouter);
  const listener = stub.listen(0);
  try {
    const port = (listener.address() as AddressInfo).port;
    for (const route of routes) {
      const res = await fetch(`http://127.0.0.1:${port}/api/mcp${route.path}`, {
        method: route.method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(route.body),
      });
      assert.equal(res.status, 403, `${route.method} ${route.path} as an assistant`);
      assert.equal((await res.json() as Json).code, "MCP_ACCOUNT_PERSON_ONLY", route.path);
    }
  } finally {
    await new Promise((resolve) => listener.close(resolve));
  }

  // A confirmed card's dispatch: the owner's full session, run inside a dispatch (ownerDispatchRequestId set).
  // dispatchOwnerRoute itself refuses /api/mcp before any request (the delegable backstop), so the route's
  // own check is exercised with the request as a dispatch would run it.
  const dispatchStub = express();
  dispatchStub.use(express.json());
  dispatchStub.use((req, _res, next) => {
    req.userId = f.owner.id;
    req.serverId = f.server.id as typeof req.serverId;
    req.sessionScope = "full";
    runInOwnerDispatch(randomUUID(), () => next());
  });
  dispatchStub.use("/api/mcp", managedMcpRouter);
  const dispatchListener = dispatchStub.listen(0);
  try {
    const port = (dispatchListener.address() as AddressInfo).port;
    for (const route of routes) {
      const res = await fetch(`http://127.0.0.1:${port}/api/mcp${route.path}`, {
        method: route.method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(route.body),
      });
      assert.equal(res.status, 403, `${route.method} ${route.path} inside a dispatch`);
      assert.equal((await res.json() as Json).code, "MCP_ACCOUNT_PERSON_ONLY", route.path);
    }
  } finally {
    await new Promise((resolve) => dispatchListener.close(resolve));
  }
  // And the real dispatcher, with the owner's own token: refused by its backstop before the route.
  const ownerToken = await tokenForHuman(f.owner.email);
  const expressApp = app.app as unknown as Parameters<typeof dispatchOwnerRoute>[0]["ownerRequest"]["app"];
  const dispatched = await dispatchOwnerRoute({
    ownerRequest: { app: expressApp, headers: { authorization: `Bearer ${ownerToken}` }, clientIp: "203.0.113.7" },
    serverId: f.server.id,
    request: { method: routes[2]!.method, path: `/api/mcp${routes[2]!.path}`, body: routes[2]!.body },
    cardMessageId: randomUUID(),
  });
  assert.equal(dispatched.status, 409, JSON.stringify(dispatched.body));
  assert.equal(dispatched.body.code, "request_not_available");
  assert.equal(await attempts(), 0, "no sign-in started by a refusal");
  assert.equal(await pinOf(f.membersAgent.id, f.app.id), null, "no assignment written by a refusal");

  // The person's own session: every one of them works.
  for (const route of routes) {
    const own = await call(app.baseUrl, f, route.method, route.path, f.owner.email, route.body);
    assert.equal(own.status, 200, `${route.method} ${route.path}: ${JSON.stringify(own.body)}`);
  }
  assert.equal(await attempts(), 2);
  assert.deepEqual(await pinOf(f.membersAgent.id, f.app.id), { mode: "pinned", bound: f.ops.id });
  // The member who created the agent, in their own session: the card's single-assignment PUT re-sends the current choice.
  const byCreator = await call(app.baseUrl, f, "PUT", `/agents/${f.membersAgent.id}/assignments/${f.app.id}`, f.member.email, { connectionId: f.ops.id, enabled: true });
  assert.equal(byCreator.status, 200, JSON.stringify(byCreator.body));
});

/* ------------------------------------------------------------------ RFC 087 PR 3: the Connect card (§7.1) */

/** An open `integration:connect_mcp` card for this agent, posted in a channel it is in. */
async function openCard(f: Seeded, agentId: string): Promise<string> {
  const channel = await createChannel(f.server.id, `card-${randomUUID().slice(0, 8)}`, undefined, "private");
  await getDb().insert(channelAgents).values({ channelId: channel.id, agentId });
  const card = await ensureMcpConnectionCard({ serverId: f.server.id, agentId, mcpServerId: f.app.id, revision: 1, targetChannelId: channel.id });
  assert.ok(card.cardMessageId);
  return card.cardMessageId;
}

async function cardState(messageId: string) {
  return (await getDb().select({ state: actionCards.state }).from(actionCards).where(eq(actionCards.messageId, messageId)))[0]?.state;
}

const CARD_VIEW_KEYS = ["agentId", "app", "binding", "canAuthorizeNew", "canSetServerDefault", "candidates", "mcpServerId", "newConnectionPinnable", "pendingGrant", "viewerRole"];

test("card view: options and the agent's account per role (admin, member with the toggle on and off, guest); flag off is today's view", async ({ app }) => {
  const f = await seed();
  const view = async (email: string, agentId: string) => {
    const res = await call(app.baseUrl, f, "GET", `/servers/${f.app.id}/connection-authorization?agentId=${agentId}`, email);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body;
  };
  await getDb().insert(managedMcpAssignments).values({ serverId: f.server.id, agentId: f.ownersAgent.id, mcpServerId: f.app.id, enabled: true, connectionMode: "pinned", boundConnectionId: f.ops.id });

  // Flag off: exactly the fields old clients read, for every role.
  for (const email of [f.admin.email, f.member.email, f.guest.email]) {
    assert.deepEqual(Object.keys(await view(email, f.membersAgent.id)).sort(), CARD_VIEW_KEYS, email);
  }

  await setFlag(true);
  // An admin: the shared accounts with the agents each names, and connecting a new one.
  const asAdmin = await view(f.admin.email, f.membersAgent.id);
  assert.deepEqual(Object.keys(asAdmin).sort(), [...CARD_VIEW_KEYS, "account", "options"].sort(), "additive");
  assert.equal(asAdmin.viewerRole, "server_manager");
  assert.deepEqual(asAdmin.options.shared, {
    connections: [
      { connectionId: f.team.id, name: "Team", label: "team@corp.example", status: "ready", agentIds: [], allAgents: true },
      { connectionId: f.ops.id, name: "Ops", label: "ops@corp.example", status: "ready", agentIds: [f.ownersAgent.id], allAgents: false },
    ],
    canConnectShared: true,
  });
  assert.deepEqual(asAdmin.options.personal, { connections: [], canConnectPersonal: false }, "the App doesn't let members connect yet");
  assert.deepEqual(asAdmin.account, { kind: "shared", connectionId: f.team.id, name: "Team", label: "team@corp.example" });

  // A member, the toggle off, no account of their own: nothing to press on someone else's agent
  // ("Ask an admin"), and no more than an observer learned before.
  const offOthers = await view(f.member.email, f.othersAgent.id);
  assert.equal(offOthers.viewerRole, "observer");
  assert.deepEqual(offOthers.options, { personal: { connections: [], canConnectPersonal: false } });
  assert.equal(offOthers.account, null);
  assert.deepEqual(offOthers.candidates, []);
  // On their own agent: the account it uses (kind and label; no shared id for a member, as the App view).
  const offOwn = await view(f.member.email, f.membersAgent.id);
  assert.equal(offOwn.viewerRole, "agent_manager");
  assert.equal(offOwn.options.shared, undefined, "shared accounts are the admins'");
  assert.deepEqual(offOwn.account, { kind: "shared", name: "Team", label: "team@corp.example" });

  // The toggle on: the member may connect their own; their READY own Connections are listed.
  await getDb().update(managedMcpServers).set({ membersCanConnect: true }).where(eq(managedMcpServers.id, f.app.id));
  const mine = await personalConnection(f, f.member.id, "Mine");
  const pending = await personalConnection(f, f.member.id, "Pending");
  await getDb().update(managedMcpCredentials).set({ authStatus: "pending" }).where(eq(managedMcpCredentials.id, pending.id));
  await personalConnection(f, f.other.id, "Theirs");
  const onOthers = await view(f.member.email, f.othersAgent.id);
  assert.deepEqual(onOthers.options, {
    personal: { connections: [{ connectionId: mine.id, name: "Mine", label: LABEL, status: "ready", agentIds: [] }], canConnectPersonal: true },
  }, "no shared accounts: they are the admins'");
  assert.deepEqual(onOthers.account, { kind: "shared", name: null, label: null }, "may act, so the kind; the label is the agent's managers'");
  // The toggle off again: their existing account can still be given (Q26), no new one.
  await getDb().update(managedMcpServers).set({ membersCanConnect: false }).where(eq(managedMcpServers.id, f.app.id));
  const kept = await view(f.member.email, f.othersAgent.id);
  assert.deepEqual(kept.options.personal.connections.map((option: Json) => option.connectionId), [mine.id]);
  assert.equal(kept.options.personal.canConnectPersonal, false);
  await getDb().update(managedMcpServers).set({ membersCanConnect: true }).where(eq(managedMcpServers.id, f.app.id));

  // A guest: never a personal account, nothing to press.
  const asGuest = await view(f.guest.email, f.membersAgent.id);
  assert.deepEqual(asGuest.options, { personal: { connections: [], canConnectPersonal: false } });
  assert.equal(asGuest.account, null);
  // Someone else's personal assistant is no agent to them.
  const hidden = await view(f.member.email, f.othersAssistant.id);
  assert.deepEqual(hidden.options, { personal: { connections: [], canConnectPersonal: false } });

  // Given the member's account, the agent uses it: its owner sees which, others whose it is.
  await getDb().insert(managedMcpPersonalGrants).values({ serverId: f.server.id, agentId: f.othersAgent.id, mcpServerId: f.app.id, connectionId: mine.id, grantedByUserId: f.member.id });
  assert.deepEqual((await view(f.member.email, f.othersAgent.id)).account, {
    kind: "personal", connectionId: mine.id, name: "Mine", label: LABEL, ownerUserId: f.member.id, ownerDisplayName: "acct-member",
  });
  assert.deepEqual((await view(f.member.email, f.othersAgent.id)).options.personal.connections[0].agentIds, [f.othersAgent.id]);
  assert.deepEqual((await view(f.other.email, f.othersAgent.id)).account, {
    kind: "personal", name: "Mine", label: LABEL, ownerUserId: f.member.id, ownerDisplayName: "acct-member",
  }, "the agent's own manager: R15");
  assert.deepEqual((await view(f.admin.email, f.othersAgent.id)).account.connectionId, mine.id);
  assert.equal((await view(f.guest.email, f.othersAgent.id)).account, null, "nothing to do here: nothing learned");
});

test("card choice: a member gives their own account (grant, notices, audit, the card closes); never someone else's or a shared one; an admin pins a shared one", async ({ app }) => {
  const f = await seed();
  await setFlag(true);
  const mine = await personalConnection(f, f.member.id, "Mine");
  const theirs = await personalConnection(f, f.other.id, "Theirs");
  const choose = (email: string, connectionId: string, agentId: string) => call(app.baseUrl, f, "PUT", `/connections/${connectionId}/agents/${agentId}`, email);
  // The other member's agent is refused (its shared account expired) and asked in a card.
  await getDb().update(managedMcpCredentials).set({ authStatus: "expired" }).where(eq(managedMcpCredentials.id, f.team.id));
  const card = await openCard(f, f.othersAgent.id);
  assert.equal(await admittedMcpConnectionId(getDb(), f.server.id, f.othersAgent.id, f.app.id), null);

  // Who may not: someone else's own account, a shared one (a member), an agent's credential, a card
  // dispatch, the flag off, an agent the member can't find.
  assert.equal((await choose(f.member.email, theirs.id, f.othersAgent.id)).status, 403, "another member's own account");
  assert.equal((await choose(f.member.email, f.ops.id, f.othersAgent.id)).status, 403, "a shared one");
  assert.equal((await choose(f.admin.email, mine.id, f.othersAgent.id)).status, 403, "an admin can't give a member's own account");
  assert.equal((await choose(f.guest.email, mine.id, f.othersAgent.id)).status, 403, "a guest");
  assert.equal((await choose(f.member.email, mine.id, f.othersAssistant.id)).status, 404, "someone else's personal assistant");
  const agentStatus = await asAgent(app.baseUrl, f, "PUT", `/connections/${mine.id}/agents/${f.othersAgent.id}`);
  assert.ok(agentStatus === 401 || agentStatus === 403, `an agent's credential (${agentStatus})`);
  // A card dispatch: the real dispatcher refuses /api/mcp by its backstop before any request; the
  // route's own check still holds for a request run inside a dispatch (the member's full session).
  const dispatched = await dispatchOwnerRoute({
    ownerRequest: { app: app.app as unknown as Parameters<typeof dispatchOwnerRoute>[0]["ownerRequest"]["app"], headers: { authorization: `Bearer ${await tokenForHuman(f.member.email)}` }, clientIp: "203.0.113.7" },
    serverId: f.server.id,
    request: { method: "PUT", path: `/api/mcp/connections/${mine.id}/agents/${f.othersAgent.id}`, body: {} },
    cardMessageId: randomUUID(),
  });
  assert.equal(dispatched.status, 409, JSON.stringify(dispatched.body));
  assert.equal(dispatched.body.code, "request_not_available");
  const choiceStub = express();
  choiceStub.use(express.json());
  choiceStub.use((req, _res, next) => {
    req.userId = f.member.id;
    req.serverId = f.server.id as typeof req.serverId;
    req.sessionScope = "full";
    runInOwnerDispatch(randomUUID(), () => next());
  });
  choiceStub.use("/api/mcp", managedMcpRouter);
  const choiceListener = choiceStub.listen(0);
  try {
    const port = (choiceListener.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}/api/mcp/connections/${mine.id}/agents/${f.othersAgent.id}`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    assert.equal(res.status, 403, "inside a dispatch");
    assert.equal((await res.json() as Json).code, "MCP_ACCOUNT_PERSON_ONLY");
  } finally {
    await new Promise((resolve) => choiceListener.close(resolve));
  }
  await setFlag(false);
  const flagOff = await choose(f.member.email, mine.id, f.othersAgent.id);
  assert.equal(flagOff.status, 409);
  assert.equal(flagOff.body.code, "managed_mcp_personal_accounts_off");
  await setFlag(true);
  assert.equal((await grantsOf(f)).size, 0, "nothing written by a refusal");
  assert.equal(await cardState(card), "prepared");

  // The member's own agent first, then the card's: the account keeps its agents (add, not replace).
  assert.equal((await choose(f.member.email, mine.id, f.membersAgent.id)).status, 200);
  const chosen = await choose(f.member.email, mine.id, f.othersAgent.id);
  assert.equal(chosen.status, 200, JSON.stringify(chosen.body));
  assert.deepEqual(chosen.body, { connectionId: mine.id, kind: "personal", allAgents: false, agentIds: [f.membersAgent.id, f.othersAgent.id], added: [f.othersAgent.id], removed: [], moved: [] });
  assert.equal(await admittedMcpConnectionId(getDb(), f.server.id, f.othersAgent.id, f.app.id), mine.id);
  assert.equal(await cardState(card), "executed", "the personal grant admits the agent: the card closes");
  // Not the member's agent: its owner and the admins are told; the member's own agent tells nobody.
  const sent = await notices("mcp_personal_grant:");
  assert.deepEqual(sent.map((notice) => notice.receiverId).sort(), [f.owner.id, f.admin.id, f.other.id].sort());
  assert.ok(sent.every((notice) => notice.eventKey.endsWith(f.othersAgent.id)));
  const changed = (await audit(f, "mcp_connection.agents_changed")).map((event) => event.metadata as Json);
  assert.deepEqual(changed.map((metadata) => [metadata.connectionId, metadata.added, metadata.removed, metadata.via]), [
    [mine.id, [f.membersAgent.id], [], "agents_api"],
    [mine.id, [f.othersAgent.id], [], "agents_api"],
  ]);
  // Choosing it again changes nothing and tells nobody again.
  assert.deepEqual((await choose(f.member.email, mine.id, f.othersAgent.id)).body.added, []);
  assert.equal((await notices("mcp_personal_grant:")).length, sent.length);

  // An admin chooses a shared account for an agent: a pin; the account's other pins and the default stay.
  await getDb().insert(managedMcpAssignments).values({ serverId: f.server.id, agentId: f.membersAgent.id, mcpServerId: f.app.id, enabled: true, connectionMode: "pinned", boundConnectionId: f.ops.id });
  const adminCard = await openCard(f, f.ownersAgent.id);
  assert.equal((await choose(f.member.email, f.ops.id, f.ownersAgent.id)).status, 403, "a member never pins");
  const pinned = await choose(f.admin.email, f.ops.id, f.ownersAgent.id);
  assert.equal(pinned.status, 200, JSON.stringify(pinned.body));
  assert.deepEqual(pinned.body, { connectionId: f.ops.id, kind: "shared", allAgents: false, agentIds: [f.membersAgent.id, f.ownersAgent.id], added: [f.ownersAgent.id], removed: [], moved: [] });
  assert.deepEqual(await pinOf(f.ownersAgent.id, f.app.id), { mode: "pinned", bound: f.ops.id });
  assert.deepEqual(await pinOf(f.membersAgent.id, f.app.id), { mode: "pinned", bound: f.ops.id });
  assert.equal((await getDb().select().from(managedMcpCredentials).where(eq(managedMcpCredentials.id, f.team.id)))[0]!.isServerDefault, true);
  assert.equal(await cardState(adminCard), "executed");
  const pinEvent = (await audit(f, "mcp_connection.agents_changed")).map((event) => event.metadata as Json).find((metadata) => metadata.connectionId === f.ops.id);
  assert.deepEqual([pinEvent!.added, pinEvent!.via], [[f.ownersAgent.id], "agents_api"]);
});

test("card sign-in: a new personal account from the card is the member's and is given the card's agent; a new shared one is pinned; the callback re-checks the toggle, the person and the agents", async ({ app }) => {
  const f = await seed();
  await setFlag(true);
  await getDb().update(managedMcpServers).set({ membersCanConnect: true }).where(eq(managedMcpServers.id, f.app.id));
  await getDb().update(managedMcpCredentials).set({ authStatus: "expired" }).where(eq(managedMcpCredentials.id, f.team.id));
  const card = await openCard(f, f.othersAgent.id);

  // Personal, from the card: the intent is stored before the redirect, the callback makes the
  // member's own Connection and gives it the agent, which closes the card.
  const personal = await startPersonal(app.baseUrl, f, f.member.email, { name: "Mine", intent: { agentIds: [f.othersAgent.id], actionCardMessageId: card } });
  assert.equal(personal.started.status, 200, JSON.stringify(personal.started.body));
  const [attempt] = await getDb().select().from(managedMcpOAuthAttempts).where(eq(managedMcpOAuthAttempts.id, personal.started.body.attemptId as string));
  assert.deepEqual(attempt!.intent, { kind: "personal", actionCardMessageId: card, agentIds: [f.othersAgent.id], name: "Mine" });
  assert.equal((await personal.finish!("card-code")).status, 200);
  const connectionId = personal.started.body.connectionId as string;
  const [created] = await getDb().select().from(managedMcpCredentials).where(eq(managedMcpCredentials.id, connectionId));
  assert.deepEqual([created!.ownerKind, created!.ownerUserId, created!.authStatus], ["personal", f.member.id, "ready"]);
  assert.equal((await grantsOf(f)).get(f.othersAgent.id), connectionId);
  assert.equal(await cardState(card), "executed");

  // Mid sign-in the toggle goes off, or the person leaves: nothing is created, the card stays open.
  const second = await openCard(f, f.ownersAgent.id);
  const toggled = await startPersonal(app.baseUrl, f, f.member.email, { name: "Toggled", intent: { agentIds: [f.ownersAgent.id], actionCardMessageId: second } });
  await getDb().update(managedMcpServers).set({ membersCanConnect: false }).where(eq(managedMcpServers.id, f.app.id));
  assert.equal((await toggled.finish!("toggled")).status, 400);
  await getDb().update(managedMcpServers).set({ membersCanConnect: true }).where(eq(managedMcpServers.id, f.app.id));
  const left = await startPersonal(app.baseUrl, f, f.other.email, { name: "Left", intent: { agentIds: [f.ownersAgent.id], actionCardMessageId: second } });
  await getDb().delete(serverMembers).where(and(eq(serverMembers.serverId, f.server.id), eq(serverMembers.userId, f.other.id)));
  assert.equal((await left.finish!("left")).status, 400);
  for (const refused of [toggled, left]) {
    assert.equal((await getDb().select().from(managedMcpCredentials).where(eq(managedMcpCredentials.id, refused.started.body.connectionId as string))).length, 0);
  }
  assert.equal((await grantsOf(f)).has(f.ownersAgent.id), false);
  assert.equal(await cardState(second), "prepared");

  // The agent deleted mid sign-in: the account is made, given to the agents still there.
  const gone = await startPersonal(app.baseUrl, f, f.member.email, { name: "Gone", intent: { agentIds: [f.membersAgent.id, f.ownersAgent.id] } });
  await getDb().update(agents).set({ deletedAt: new Date() }).where(eq(agents.id, f.ownersAgent.id));
  assert.equal((await gone.finish!("gone")).status, 200);
  const grants = await grantsOf(f);
  assert.equal(grants.get(f.membersAgent.id), gone.started.body.connectionId);
  assert.equal(grants.has(f.ownersAgent.id), false, "a deleted agent is given nothing");
  await getDb().update(agents).set({ deletedAt: null }).where(eq(agents.id, f.ownersAgent.id));

  // Shared, from the card (an admin): the new Connection is pinned to the card's agent at the callback,
  // with the agents re-checked then; the card closes.
  const sharedStart = await call(app.baseUrl, f, "POST", `/apps/${f.app.id}/connections/oauth/start`, f.admin.email, {
    name: "Ops 2", intent: { agentIds: [f.ownersAgent.id, f.othersAgent.id], actionCardMessageId: second },
  });
  assert.equal(sharedStart.status, 200, JSON.stringify(sharedStart.body));
  const [sharedAttempt] = await getDb().select().from(managedMcpOAuthAttempts).where(eq(managedMcpOAuthAttempts.id, sharedStart.body.attemptId as string));
  assert.deepEqual(sharedAttempt!.intent, { kind: "shared", actionCardMessageId: second, agentIds: [f.ownersAgent.id, f.othersAgent.id], name: "Ops 2" });
  await getDb().update(agents).set({ deletedAt: new Date() }).where(eq(agents.id, f.othersAgent.id));
  const state = new URL(sharedStart.body.authorizationUrl as string).searchParams.get("state")!;
  const cookie = sharedStart.headers.getSetCookie()[0]!.split(";")[0]!;
  const sharedDone = await fetch(`${app.baseUrl}/api/mcp/oauth/callback?state=${encodeURIComponent(state)}&code=shared`, { headers: { Cookie: cookie } });
  assert.equal(sharedDone.status, 200, await sharedDone.text());
  const sharedId = sharedStart.body.connectionId as string;
  assert.deepEqual(await pinOf(f.ownersAgent.id, f.app.id), { mode: "pinned", bound: sharedId });
  assert.equal(await pinOf(f.othersAgent.id, f.app.id), null, "a deleted agent is not pinned");
  assert.equal(await cardState(second), "executed");
  const pinEvent = (await audit(f, "mcp_connection.agents_changed")).map((event) => event.metadata as Json).find((metadata) => metadata.connectionId === sharedId);
  assert.deepEqual([pinEvent!.added, pinEvent!.via], [[f.ownersAgent.id], "sign_in"]);

  // A member's shared start is still refused, agents or not.
  assert.equal((await call(app.baseUrl, f, "POST", `/apps/${f.app.id}/connections/oauth/start`, f.member.email, { name: "Nope", intent: { agentIds: [f.membersAgent.id] } })).status, 403);
});
