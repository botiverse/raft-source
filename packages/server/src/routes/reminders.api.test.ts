import { tokenForHuman, fixturePasswordHash } from "../test/integration/credentials.js";
import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";

import { getDb } from "../db/index.js";
import { users } from "../db/schema.js";
import { createServer } from "../services/serverService.js";
import { createAgent } from "../services/agentService.js";
import { createReminder } from "../apps/reminder/service.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });



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
