import { fixturePasswordHash } from "../test/integration/credentials.js";
import { createApiTest } from "../test/integration/apiTest.js";
/**
 * Integration tests for `GET /api/agents/manageable` — the agent-readable
 * discovery surface that `slock agent list` and friends call.
 *
 * Things pinned here:
 *   1. Cross-server union: a user who has `issueAgentCredentials` on multiple
 *      servers sees every agent in all of them; each row carries its
 *      own `serverId` so the calling agent can group + render.
 *   2. Capability filter: agents in servers where the user is a member
 *      WITHOUT `issueAgentCredentials` are not returned unless that user created them
 *      a member of that server).
 *   3. Empty-shape: a logged-in user with no credential authority anywhere
 *      gets `agents: []` plus a stable `reason` enum, NOT a 4xx error.
 *      Distinguishing "no permission" from "permission but no agents"
 *      matters for the agent-readable recovery story.
 *   4. No `X-Server-Id` required (the route mounts before agentRouter).
 *   5. Server NEVER returns CLI-specific copy. Response shape is
 *      `{ agents, reason, manageable_server_count }` — `reason` is a
 *      machine-readable enum; the client (CLI / web / SDK) owns the
 *      next-action text (see CLI `describeListResult` in
 *      `packages/cli/src/commands/agent/list.ts`). Contract per
 *      @xxchan #wg-self-hosted-agent msg=4acca4ce + @Hao msg=27f60c48.
 */

import assert from "node:assert/strict";


import { getDb } from "../db/index.js";
import { users, serverMembers } from "../db/schema.js";
import { createServer } from "../services/serverService.js";
import { createAgent } from "../services/agentService.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

async function seedUser(email: string, name: string) {
  const db = getDb();
  const [user] = await db.insert(users).values({
    email,
    name,
    displayName: name,
    passwordHash: await fixturePasswordHash("password123"),
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
  return ((await res.json()) as { accessToken: string }).accessToken;
}

interface ListResponse {
  ok: boolean;
  data: {
    agents: Array<{
      id: string;
      name: string;
      serverId: string;
      serverName: string | null;
    }>;
    reason: "ok" | "no_manageable_server" | "no_agents_on_manageable_servers";
    manageable_server_count: number;
    suggested_next_action?: string;
  };
}

test("returns the union of manageable agents across all servers (no X-Server-Id)", async ({ app }) => {
  const user = await seedUser("manageable-multi@slock.test", "manageable-multi");
  const serverA = await createServer("Server A", "manageable-a", user.id);
  const serverB = await createServer("Server B", "manageable-b", user.id);
  const agentA1 = await createAgent(serverA.id, "agent-a1", { runtime: "codex" });
  const agentA2 = await createAgent(serverA.id, "agent-a2", { runtime: "codex" });
  const agentB1 = await createAgent(serverB.id, "agent-b1", { runtime: "codex" });

  const token = await login(app.baseUrl, user.email);
  const res = await fetch(`${app.baseUrl}/api/agents/manageable`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(res.status, 200, `expected 200, got ${res.status}`);
  const body = (await res.json()) as ListResponse;
  assert.equal(body.ok, true);
  const returnedIds = new Set(body.data.agents.map((a) => a.id));
  assert.ok(returnedIds.has(agentA1.id));
  assert.ok(returnedIds.has(agentA2.id));
  assert.ok(returnedIds.has(agentB1.id));
  // Sanity: every row carries its serverId/name
  for (const agent of body.data.agents) {
    assert.ok(agent.serverId);
    assert.ok(typeof agent.serverName === "string" || agent.serverName === null);
  }
  assert.equal(body.data.reason, "ok");
  assert.equal(body.data.manageable_server_count, 2);
  // Server must NOT return CLI-specific copy.
  assert.equal(
    body.data.suggested_next_action,
    undefined,
    "server must not embed CLI-specific suggested_next_action in API response; CLI owns the copy via describeListResult",
  );
});

test("members see only agents covered by creator override when they lack issueAgentCredentials", async ({ app }) => {
  const owner = await seedUser("filter-owner@slock.test", "filter-owner");
  const member = await seedUser("filter-member@slock.test", "filter-member");
  const server = await createServer("Filter Test", "filter-test", owner.id);
  const db = getDb();
  await db.insert(serverMembers).values({
    serverId: server.id,
    userId: member.id,
    role: "member",
  });
  const otherAgent = await createAgent(server.id, "filter-agent", { runtime: "codex" });
  const createdAgent = await createAgent(server.id, "creator-agent", {
    runtime: "codex",
    creatorType: "user",
    creatorId: member.id,
  });

  const token = await login(app.baseUrl, member.email);
  const res = await fetch(`${app.baseUrl}/api/agents/manageable`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as ListResponse;
  assert.deepEqual(body.data.agents.map((agent) => agent.id), [createdAgent.id]);
  assert.ok(!body.data.agents.some((agent) => agent.id === otherAgent.id));
  assert.equal(body.data.reason, "ok");
  assert.equal(body.data.manageable_server_count, 1);
  assert.equal(body.data.suggested_next_action, undefined);
});

test("user with issueAgentCredentials but no agents yet gets empty agents + grant-related hint", async ({ app }) => {
  const owner = await seedUser("empty-owner@slock.test", "empty-owner");
  await createServer("Empty Test", "empty-test", owner.id);
  // No createAgent calls — manageable server exists but is empty.

  const token = await login(app.baseUrl, owner.email);
  const res = await fetch(`${app.baseUrl}/api/agents/manageable`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as ListResponse;
  assert.equal(body.data.agents.length, 0);
  assert.equal(body.data.reason, "no_agents_on_manageable_servers");
  assert.equal(body.data.manageable_server_count, 1);
  assert.equal(body.data.suggested_next_action, undefined);
});
