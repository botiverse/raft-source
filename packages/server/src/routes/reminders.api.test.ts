import { tokenForHuman, fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";

import { getDb } from "../db/index";
import { users } from "../db/schema";
import { addMember, createServer } from "../services/serverService";
import { createAgent } from "../services/agentService";
import { createReminder } from "../apps/reminder/service";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });



function authHeaders(token: string, serverId: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "X-Server-Id": serverId,
    "Content-Type": "application/json",
  };
}

// v0 contract: /api/reminders is read-only for humans. The write side lives
// behind /internal/agent/:id/reminders and is agent-only (via MCP). If one of
// these methods comes back as 200/201/2xx in the future, the spec boundary
// has been rewritten — re-read v0 before “fixing” this test.
test("POST /api/reminders is not exposed to humans (v0 read-only boundary)", async ({ app }) => {
  const db = getDb();
  const [owner] = await db
    .insert(users)
    .values({
      email: "reminders-http-owner@slock.test",
      name: "reminders-http-owner",
      displayName: "Owner",
      passwordHash: await fixturePasswordHash("password123"),
      emailVerified: true,
      profileSetupCompletedAt: new Date(),
    })
    .returning();

  const server = await createServer("Reminders HTTP", "reminders-http", owner.id);
  const agent = await createAgent(server.id, "r-agent", { runtime: "claude" });
  const token = await tokenForHuman(owner.email);

  const res = await fetch(`${app.baseUrl}/api/reminders`, {
    method: "POST",
    headers: authHeaders(token, server.id),
    body: JSON.stringify({
      ownerAgentId: agent.id,
      title: "nope",
      fireAt: new Date(Date.now() + 60_000).toISOString(),
    }),
  });
  assert.equal(res.status, 404, `expected 404, got ${res.status}`);
});

test("DELETE /api/reminders/:id is not exposed to humans (v0 read-only boundary)", async ({ app }) => {
  const db = getDb();
  const [owner] = await db
    .insert(users)
    .values({
      email: "reminders-delete-owner@slock.test",
      name: "reminders-delete-owner",
      displayName: "Owner",
      passwordHash: await fixturePasswordHash("password123"),
      emailVerified: true,
      profileSetupCompletedAt: new Date(),
    })
    .returning();
  const server = await createServer("Reminders Del", "reminders-del", owner.id);
  const agent = await createAgent(server.id, "r-agent-del", { runtime: "claude" });
  const reminder = await createReminder({
    serverId: server.id,
    ownerAgentId: agent.id,
    msgId: null,
    title: "keep me",
    fireAt: new Date(Date.now() + 60_000),
    payload: null,
    createdBy: { type: "agent", id: agent.id },
  });
  const token = await tokenForHuman(owner.email);

  const res = await fetch(`${app.baseUrl}/api/reminders/${reminder.id}`, {
    method: "DELETE",
    headers: authHeaders(token, server.id),
  });
  assert.equal(res.status, 404, `expected 404, got ${res.status}`);
});

test("GET /api/reminders still returns the read-only listing", async ({ app }) => {
  const db = getDb();
  const [owner] = await db
    .insert(users)
    .values({
      email: "reminders-get-owner@slock.test",
      name: "reminders-get-owner",
      displayName: "Owner",
      passwordHash: await fixturePasswordHash("password123"),
      emailVerified: true,
      profileSetupCompletedAt: new Date(),
    })
    .returning();
  const server = await createServer("Reminders Get", "reminders-get", owner.id);
  const agent = await createAgent(server.id, "r-agent-get", { runtime: "claude" });
  await createReminder({
    serverId: server.id,
    ownerAgentId: agent.id,
    msgId: null,
    title: "standup",
    fireAt: new Date(Date.now() + 60_000),
    payload: null,
    createdBy: { type: "agent", id: agent.id },
  });
  const token = await tokenForHuman(owner.email);

  const res = await fetch(`${app.baseUrl}/api/reminders?ownerAgentId=${agent.id}`, {
    headers: authHeaders(token, server.id),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { reminders: Array<{ title: string }> };
  assert.equal(body.reminders.length, 1);
  assert.equal(body.reminders[0].title, "standup");
});

// Reminders are a private surface of their owner agent (same rule as the
// agent's workspace/activity tabs). Without `ownerAgentId` the listing must
// not widen into every agent of the server.
test("GET /api/reminders without ownerAgentId lists only reminders of agents the caller may inspect", async ({ app }) => {
  const db = getDb();
  const [owner, creator, bystander] = await db
    .insert(users)
    .values(await Promise.all(["owner", "creator", "bystander"].map(async (name) => ({
      email: `reminders-scope-${name}@slock.test`,
      name: `reminders-scope-${name}`,
      displayName: name,
      passwordHash: await fixturePasswordHash("password123"),
      emailVerified: true,
      profileSetupCompletedAt: new Date(),
    }))))
    .returning();
  const server = await createServer("Reminders Scope", "reminders-scope", owner.id);
  await addMember(server.id, creator.id);
  await addMember(server.id, bystander.id);
  const agentX = await createAgent(server.id, "r-agent-x", { runtime: "claude" });
  const agentY = await createAgent(server.id, "r-agent-y", {
    runtime: "claude",
    creatorType: "user",
    creatorId: creator.id,
  });
  for (const [agent, title] of [[agentX, "x-standup"], [agentY, "y-review"]] as const) {
    await createReminder({
      serverId: server.id,
      ownerAgentId: agent.id,
      msgId: null,
      title,
      fireAt: new Date(Date.now() + 60_000),
      payload: null,
      createdBy: { type: "agent", id: agent.id },
    });
  }

  const visibleTitles = async (user: { email: string }, query = ""): Promise<string[] | number> => {
    const res = await fetch(`${app.baseUrl}/api/reminders${query}`, {
      headers: authHeaders(await tokenForHuman(user.email), server.id),
    });
    if (res.status !== 200) return res.status;
    const body = (await res.json()) as { reminders: Array<{ title: string }> };
    return body.reminders.map((r) => r.title).sort();
  };

  // Server owner holds `editAgents`: every agent's reminders.
  assert.deepEqual(await visibleTitles(owner), ["x-standup", "y-review"]);
  // A plain member sees exactly the agents they created.
  assert.deepEqual(await visibleTitles(creator), ["y-review"]);
  // A plain member with no agents sees nothing rather than the whole server.
  assert.deepEqual(await visibleTitles(bystander), []);
  // The explicit filter keeps refusing an agent the caller may not inspect.
  assert.equal(await visibleTitles(bystander, `?ownerAgentId=${agentX.id}`), 403);
  assert.deepEqual(await visibleTitles(creator, `?ownerAgentId=${agentY.id}`), ["y-review"]);
});
