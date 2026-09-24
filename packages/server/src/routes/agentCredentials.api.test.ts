import { createApiTest } from "../test/integration/apiTest.js";
/**
 * Integration tests for `POST /api/agents/:id/credentials` — the external-agent
 * credential mint endpoint that consumes a user session and produces
 * `sk_agent_*`.
 *
 * Three things this file pins, beyond the standard auth gates already
 * covered by `agents.credentials.gate.test.ts`:
 *
 *   1. **No X-Server-Id required.** The route lives outside the
 *      `requireServer`-gated `agentRouter` and derives server context
 *      from `agent.serverId`. A request that authenticates via user
 *      session alone (no X-Server-Id header) must reach the handler.
 *   2. **Anti-enumeration 404.** A user who is NOT a member of the
 *      agent's server gets the same `agent_missing` 404 as a request
 *      for a truly nonexistent agent. This is the XX msg=dc316ca3
 *      regression gate — without it a logged-in user could probe agent
 *      ids across servers via response-code differences.
 *   3. **`insufficient_role` 403** for members without
 *      `issueAgentCredentials` or human creator authority.
 */

import assert from "node:assert/strict";

import argon2 from "argon2";

import { openTestApp } from "../test/integration/app.js";
import { getDb } from "../db/index.js";
import { users, serverMembers, agentCredentials } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { createServer } from "../services/serverService.js";
import { createAgent, deleteAgent } from "../services/agentService.js";
import { mintAgentCredential } from "../services/agentCredentialService.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

const PEPPER = "test-pepper";

async function withDeviceAuthGateOn<T>(fn: () => Promise<T>): Promise<T> {
  const prevGate = process.env.SLOCK_DEVICE_LOGIN_ENABLED;
  const prevPepper = process.env.AGENT_BOOTSTRAP_TOKEN_PEPPER;
  process.env.SLOCK_DEVICE_LOGIN_ENABLED = "true";
  process.env.AGENT_BOOTSTRAP_TOKEN_PEPPER = PEPPER;
  try {
    return await fn();
  } finally {
    if (prevGate === undefined) delete process.env.SLOCK_DEVICE_LOGIN_ENABLED;
    else process.env.SLOCK_DEVICE_LOGIN_ENABLED = prevGate;
    if (prevPepper === undefined) delete process.env.AGENT_BOOTSTRAP_TOKEN_PEPPER;
    else process.env.AGENT_BOOTSTRAP_TOKEN_PEPPER = prevPepper;
  }
}

async function seedUser(email: string, name: string) {
  const db = getDb();
  const [user] = await db.insert(users).values({
    email,
    name,
    displayName: name,
    passwordHash: await argon2.hash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user;
}

async function login(baseUrl: string, email: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "password123" }),
  });
  assert.equal(res.status, 200, `login failed for ${email}: ${res.status}`);
  const data = (await res.json()) as { accessToken: string };
  return data.accessToken;
}

test("owner of agent's server mints sk_agent_* without X-Server-Id header", async () => {
  await withDeviceAuthGateOn(async () => {
    const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
    try {
      const owner = await seedUser("owner-mint@slock.test", "owner-mint");
      const server = await createServer("Mint Test", "mint-test", owner.id);
      const agent = await createAgent(server.id, "mint-agent", { runtime: "codex" });

      const token = await login(app.baseUrl, owner.email);
      const res = await fetch(`${app.baseUrl}/api/agents/${agent.id}/credentials`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          // Deliberately NO X-Server-Id — the route MUST derive it from the agent row.
        },
        body: JSON.stringify({}),
      });
      assert.equal(res.status, 201, `expected 201, got ${res.status}`);
      const body = (await res.json()) as {
        credentialId: string;
        apiKey: string;
        agentId: string;
        serverId: string;
      };
      assert.ok(body.apiKey.startsWith("sk_agent_"), `expected sk_agent_*, got ${body.apiKey.slice(0, 12)}…`);
      assert.equal(res.headers.get("cache-control"), "no-store");
      assert.equal(body.agentId, agent.id);
      assert.equal(body.serverId, server.id);
      assert.ok(typeof body.credentialId === "string" && body.credentialId.length > 0);
      const whoami = await fetch(`${app.baseUrl}/internal/agent-api/`, {
        headers: { Authorization: `Bearer ${body.apiKey}` },
      });
      assert.equal(whoami.status, 200, "a Web-issued token works immediately without device approval");
      const identity = await whoami.json();
      assert.equal(identity.agentId, agent.id);
      assert.equal(identity.credentialId, body.credentialId);
      // A credential from the pre-existing service remains usable and manageable.
      const old = await mintAgentCredential({ agentId: agent.id, scopes: ["read"], createdByUserId: owner.id, name: "Existing deployment" });
      const otherAgent = await createAgent(server.id, "other-credential-agent", { runtime: "external" });
      const other = await mintAgentCredential({ agentId: otherAgent.id, scopes: ["read"], createdByUserId: owner.id });
      const headers = { Authorization: `Bearer ${token}` };
      const list = await fetch(`${app.baseUrl}/api/agents/${agent.id}/credentials`, { headers });
      assert.equal(list.status, 200);
      assert.equal(list.headers.get("cache-control"), "no-store");
      const inventory = await list.json();
      assert.equal(inventory.credentials.length, 2);
      assert.ok(inventory.credentials.some((c: { id: string }) => c.id === old.credentialId));
      assert.deepEqual(Object.keys(inventory.credentials[0]).sort(), ["createdAt", "id", "lastUsedAt", "maskedToken", "name", "revokedAt", "scopes"]);
      assert.equal(inventory.credentials.find((c: { id: string }) => c.id === old.credentialId).maskedToken, `${old.apiKey.slice(0, 14)}***`);
      assert.equal(inventory.credentials.find((c: { id: string }) => c.id === body.credentialId).maskedToken, `${body.apiKey.slice(0, 14)}***`);
      assert.ok(!JSON.stringify(inventory).includes(old.apiKey));
      assert.ok(!JSON.stringify(inventory).includes(body.apiKey));
      const foreign = await fetch(`${app.baseUrl}/api/agents/${agent.id}/credentials/${other.credentialId}`, { method: "DELETE", headers });
      assert.equal(foreign.status, 404, "never revoke another agent's token through this subject");
      for (const credential of [old, other]) {
        assert.equal((await fetch(`${app.baseUrl}/internal/agent-api/`, { headers: { Authorization: `Bearer ${credential.apiKey}` } })).status, 200);
      }
      // Revocation remains available even if new credential issuance is disabled.
      process.env.SLOCK_DEVICE_LOGIN_ENABLED = "false";
      for (let i = 0; i < 2; i++) {
        const revoke = await fetch(`${app.baseUrl}/api/agents/${agent.id}/credentials/${body.credentialId}`, { method: "DELETE", headers });
        assert.equal(revoke.status, 204, "revocation is idempotent");
      }
      const revoked = await fetch(`${app.baseUrl}/internal/agent-api/`, {
        headers: { Authorization: `Bearer ${body.apiKey}` },
      });
      assert.equal(revoked.status, 401, "revocation immediately rejects the same token");
      assert.equal((await fetch(`${app.baseUrl}/internal/agent-api/`, { headers: { Authorization: `Bearer ${old.apiKey}` } })).status, 200, "the other token stays usable");
      const after = await (await fetch(`${app.baseUrl}/api/agents/${agent.id}/credentials`, { headers })).json();
      assert.ok(after.credentials.find((c: { id: string }) => c.id === body.credentialId).revokedAt);
      const [audit] = await getDb().select({ actor: agentCredentials.revokedByUserId, reason: agentCredentials.revokedReason })
        .from(agentCredentials).where(eq(agentCredentials.id, body.credentialId));
      assert.deepEqual(audit, { actor: owner.id, reason: "user_revoked" });
    } finally {
      await app.close();
    }
  });
});

test("agent creator keeps issueAgentCredentials authority after demotion to member", async () => {
  await withDeviceAuthGateOn(async () => {
    const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
    try {
      const owner = await seedUser("creator-mint-owner@slock.test", "creator-mint-owner");
      const creator = await seedUser("creator-mint-member@slock.test", "creator-mint-member");
      const server = await createServer("Creator Mint Test", "creator-mint-test", owner.id);
      await getDb().insert(serverMembers).values({ serverId: server.id, userId: creator.id, role: "member" });
      const agent = await createAgent(server.id, "creator-mint-agent", {
        runtime: "codex",
        creatorType: "user",
        creatorId: creator.id,
      });

      const token = await login(app.baseUrl, creator.email);
      const res = await fetch(`${app.baseUrl}/api/agents/${agent.id}/credentials`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({}),
      });
      assert.equal(res.status, 201);
      const minted = await res.json();
      const headers = { Authorization: `Bearer ${token}` };
      assert.equal((await fetch(`${app.baseUrl}/api/agents/${agent.id}/credentials`, { headers })).status, 200);
      assert.equal((await fetch(`${app.baseUrl}/api/agents/${agent.id}/credentials/${minted.credentialId}`, { method: "DELETE", headers })).status, 204);
    } finally {
      await app.close();
    }
  });
});

test("user who is not a member of agent's server gets 404 agent_missing (anti-enumeration)", async () => {
  await withDeviceAuthGateOn(async () => {
    const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
    try {
      // user_A is the owner of server_X. agent_Y belongs to server_Z, which
      // user_A is NOT a member of. user_A must NOT be able to learn agent_Y
      // exists by hitting this endpoint.
      const userA = await seedUser("anti-enum-a@slock.test", "anti-enum-a");
      const userZ = await seedUser("anti-enum-z@slock.test", "anti-enum-z");
      await createServer("Server X", "anti-enum-x", userA.id);
      const serverZ = await createServer("Server Z", "anti-enum-z", userZ.id);
      const agentY = await createAgent(serverZ.id, "anti-enum-y", { runtime: "codex" });

      const tokenA = await login(app.baseUrl, userA.email);
      const res = await fetch(`${app.baseUrl}/api/agents/${agentY.id}/credentials`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${tokenA}`,
        },
        body: JSON.stringify({}),
      });
      assert.equal(res.status, 404, `expected 404 (anti-enum), got ${res.status}`);
      const body = (await res.json()) as { code: string };
      assert.equal(body.code, "agent_missing", `expected agent_missing, got ${body.code}`);
      for (const method of ["GET", "DELETE"]) {
        const suffix = method === "DELETE" ? "/00000000-0000-0000-0000-000000000001" : "";
        const denied = await fetch(`${app.baseUrl}/api/agents/${agentY.id}/credentials${suffix}`, { method, headers: { Authorization: `Bearer ${tokenA}` } });
        assert.equal(denied.status, 404);
        assert.equal((await denied.json()).code, "agent_missing");
      }
    } finally {
      await app.close();
    }
  });
});

test("server member without issueAgentCredentials or creator authority gets 403 insufficient_role", async () => {
  await withDeviceAuthGateOn(async () => {
    const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
    try {
      const owner = await seedUser("role-owner@slock.test", "role-owner");
      const member = await seedUser("role-member@slock.test", "role-member");
      const server = await createServer("Role Test", "role-test", owner.id);
      const db = getDb();
      await db.insert(serverMembers).values({
        serverId: server.id,
        userId: member.id,
        role: "member",
      });
      const agent = await createAgent(server.id, "role-agent", { runtime: "codex" });

      const token = await login(app.baseUrl, member.email);
      const res = await fetch(`${app.baseUrl}/api/agents/${agent.id}/credentials`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({}),
      });
      assert.equal(res.status, 403, `expected 403, got ${res.status}`);
      const body = (await res.json()) as { code: string; error: string };
      assert.equal(body.code, "insufficient_role");
      assert.match(body.error, /issueAgentCredentials/);
      assert.match(body.error, /human creator authority/);
      assert.doesNotMatch(body.error, /owners and admins/);
      for (const method of ["GET", "DELETE"]) {
        const suffix = method === "DELETE" ? "/00000000-0000-0000-0000-000000000001" : "";
        const denied = await fetch(`${app.baseUrl}/api/agents/${agent.id}/credentials${suffix}`, { method, headers: { Authorization: `Bearer ${token}` } });
        assert.equal(denied.status, 403);
        assert.equal((await denied.json()).code, "insufficient_role");
      }
    } finally {
      await app.close();
    }
  });
});

test("soft-deleted agent returns 404 agent_missing — not 403, not 400 (Hao gate)", async () => {
  await withDeviceAuthGateOn(async () => {
    const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
    try {
      // Two probes against a soft-deleted agent:
      //   (a) the server owner: must see anti-enum 404 (not 400 from bad
      //       body validation that would otherwise run after a deleted
      //       agent was let through).
      //   (b) a member without `manageAgents`: must see the same 404
      //       (not 403 `insufficient_role`), so deletion state can't be
      //       inferred from response code.
      const owner = await seedUser("deleted-owner@slock.test", "deleted-owner");
      const member = await seedUser("deleted-member@slock.test", "deleted-member");
      const server = await createServer("Deleted Agent Test", "deleted-agent-test", owner.id);
      const db = getDb();
      await db.insert(serverMembers).values({
        serverId: server.id,
        userId: member.id,
        role: "member",
      });
      const agent = await createAgent(server.id, "to-be-deleted", { runtime: "codex" });
      await deleteAgent(agent.id);

      const ownerToken = await login(app.baseUrl, owner.email);
      const ownerRes = await fetch(`${app.baseUrl}/api/agents/${agent.id}/credentials`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${ownerToken}`,
        },
        // Deliberately bad body — if the handler reached body validation,
        // we'd see 400 `scopes_invalid` here. The deletion check must
        // short-circuit BEFORE body validation.
        body: JSON.stringify({ scopes: "not an array" }),
      });
      assert.equal(ownerRes.status, 404, `owner: expected 404 for deleted agent, got ${ownerRes.status}`);
      const ownerBody = (await ownerRes.json()) as { code: string };
      assert.equal(ownerBody.code, "agent_missing");

      const memberToken = await login(app.baseUrl, member.email);
      const memberRes = await fetch(`${app.baseUrl}/api/agents/${agent.id}/credentials`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${memberToken}`,
        },
        body: JSON.stringify({}),
      });
      assert.equal(
        memberRes.status,
        404,
        `member-without-manageAgents: expected 404 (anti-enum), got ${memberRes.status}`,
      );
      const memberBody = (await memberRes.json()) as { code: string };
      assert.equal(memberBody.code, "agent_missing");
      for (const method of ["GET", "DELETE"]) {
        const suffix = method === "DELETE" ? "/00000000-0000-0000-0000-000000000001" : "";
        const denied = await fetch(`${app.baseUrl}/api/agents/${agent.id}/credentials${suffix}`, { method, headers: { Authorization: `Bearer ${ownerToken}` } });
        assert.equal(denied.status, 404);
        assert.equal((await denied.json()).code, "agent_missing");
      }
    } finally {
      await app.close();
    }
  });
});

test("unknown agent id returns 404 agent_missing (same shape as cross-server)", async () => {
  await withDeviceAuthGateOn(async () => {
    const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
    try {
      const user = await seedUser("unknown-agent-user@slock.test", "unknown-agent-user");
      await createServer("Unknown Agent Test", "unknown-agent-test", user.id);

      const token = await login(app.baseUrl, user.email);
      const res = await fetch(
        `${app.baseUrl}/api/agents/00000000-0000-0000-0000-000000000000/credentials`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({}),
        },
      );
      assert.equal(res.status, 404, `expected 404, got ${res.status}`);
      const body = (await res.json()) as { code: string };
      assert.equal(body.code, "agent_missing");
    } finally {
      await app.close();
    }
  });
});
