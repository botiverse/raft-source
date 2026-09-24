import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { agents, productEvents, users } from "../db/schema.js";
import { createAgent } from "./agentService.js";
import { createServer } from "./serverService.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

async function seedOwner(label: string) {
  const [owner] = await getDb().insert(users).values({
    email: `${label}-${randomUUID()}@slock.test`,
    name: `${label}-${randomUUID().slice(0, 8)}`,
    displayName: label,
    passwordHash: "test-hash",
    emailVerified: true,
  }).returning();
  return owner;
}

test("human-created second-ever agent records one atomic server milestone", async ({ app }) => {
  const db = getDb();
  const owner = await seedOwner("second-agent-owner");
  const server = await createServer("Second agent", `second-agent-${randomUUID()}`, owner.id);

  const first = await createAgent(server.id, "first", {
    runtime: "external",
    creatorType: "user",
    creatorId: owner.id,
  });
  assert.equal((await db.select().from(productEvents).where(eq(productEvents.eventType, "agent.second_created"))).length, 0);

  // Deletion must not reset an ever-reached creation ordinal.
  await db.update(agents).set({ deletedAt: new Date() }).where(eq(agents.id, first.id));
  const second = await createAgent(server.id, "second", {
    runtime: "external",
    creatorType: "user",
    creatorId: owner.id,
  });
  await createAgent(server.id, "third", {
    runtime: "external",
    creatorType: "user",
    creatorId: owner.id,
  });

  const rows = await db.select().from(productEvents).where(eq(productEvents.eventType, "agent.second_created"));
  assert.equal(rows.length, 1, "first and third creates must not emit the milestone");
  const [event] = rows;
  assert.equal(event.subjectType, "server");
  assert.equal(event.subjectId, server.id);
  assert.equal(event.actorType, "human");
  assert.equal(event.actorId, owner.id);
  assert.equal(event.occurredAt.toISOString(), second.createdAt.toISOString());
  assert.equal(event.source, "server");
  assert.equal(event.idempotencyKey, "server-second-agent-created-v1");
  assert.deepEqual(event.metadata, {
    agent_id: second.id,
    agent_ordinal: 2,
    scope: "server",
    capture_mode: "live",
    writer: "agent_service.create_agent",
  });
});

test("an agent-created second agent is not mislabeled as a human feature-use event", async ({ app }) => {
  const db = getDb();
  const owner = await seedOwner("agent-created-owner");
  const server = await createServer("Agent-created second", `agent-created-${randomUUID()}`, owner.id);
  const first = await createAgent(server.id, "first", {
    runtime: "external",
    creatorType: "user",
    creatorId: owner.id,
  });
  await createAgent(server.id, "second", {
    runtime: "external",
    creatorType: "agent",
    creatorId: first.id,
  });
  await createAgent(server.id, "third", {
    runtime: "external",
    creatorType: "user",
    creatorId: owner.id,
  });

  const rows = await db.select().from(productEvents).where(eq(productEvents.eventType, "agent.second_created"));
  assert.equal(rows.length, 0, "the event requires the second creation itself to have a human actor");
});

test("second-agent event failure rolls back the agent row", async ({ app }) => {
  const db = getDb();
  const owner = await seedOwner("second-agent-atomic");
  const server = await createServer("Second agent atomic", `second-agent-atomic-${randomUUID()}`, owner.id);
  await createAgent(server.id, "first", {
    runtime: "external",
    creatorType: "user",
    creatorId: owner.id,
  });

  await db.execute(`
    ALTER TABLE "product_events"
    ADD CONSTRAINT "reject_second_agent_event_${server.id.replaceAll("-", "_")}"
    CHECK ("event_type" <> 'agent.second_created')
  `);

  await assert.rejects(() => createAgent(server.id, "second", {
    runtime: "external",
    creatorType: "user",
    creatorId: owner.id,
  }));

  const agentRows = await db.select({ id: agents.id }).from(agents).where(eq(agents.serverId, server.id));
  const eventRows = await db.select({ id: productEvents.id }).from(productEvents)
    .where(eq(productEvents.eventType, "agent.second_created"));
  assert.equal(agentRows.length, 1, "the second agent must not commit without its receipt");
  assert.equal(eventRows.length, 0);
});
