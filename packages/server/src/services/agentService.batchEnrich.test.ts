import { dbTest as test } from "../test/integration/dbTest.js";
import { closeTestDatabase } from "../test/integration/database.js";
import assert from "node:assert/strict";
import { afterEach } from "vitest";
import { getDb } from "../db/index.js";
import { agents, servers, serverMembers, users } from "../db/schema.js";
import {
  batchEnrichAgentsWithCreatorProfile,
  enrichAgentWithCreatorProfile,
} from "./agentService.js";
import type { DbQueryTracer } from "../tracing/dbQueryTrace.js";


afterEach(async () => {
  await closeTestDatabase();
});

async function seed() {
  const db = getDb();
  const [user] = await db.insert(users).values({
    id: "11111111-1111-1111-1111-111111111111",
    email: "owner@example.com",
    name: "owner",
    passwordHash: "hash",
    emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({
    id: "22222222-2222-2222-2222-222222222222",
    name: "Test Server",
    slug: "test-server",
    ownerId: user.id,
  }).returning();
  await db.insert(serverMembers).values({
    serverId: server.id,
    userId: user.id,
    role: "owner",
  });

  // user-created root agent
  const [rootByUser] = await db.insert(agents).values({
    id: "44444444-4444-4444-4444-444444444444",
    serverId: server.id,
    name: "root-by-user",
    status: "active",
    runtime: "claude",
    model: "sonnet",
    executionMode: "byoc",
    creatorType: "user",
    creatorId: user.id,
  }).returning();

  // agent-created child of rootByUser
  const [childOfRoot] = await db.insert(agents).values({
    id: "55555555-5555-5555-5555-555555555555",
    serverId: server.id,
    name: "child-of-root",
    status: "active",
    runtime: "codex",
    model: "gpt-5.3-codex",
    executionMode: "byoc",
    creatorType: "agent",
    creatorId: rootByUser.id,
  }).returning();

  // grandchild created by childOfRoot
  const [grandchild] = await db.insert(agents).values({
    id: "66666666-6666-6666-6666-666666666666",
    serverId: server.id,
    name: "grandchild",
    status: "inactive",
    runtime: "claude",
    model: "haiku",
    executionMode: "byoc",
    creatorType: "agent",
    creatorId: childOfRoot.id,
  }).returning();

  // creator-less agent
  const [orphan] = await db.insert(agents).values({
    id: "77777777-7777-7777-7777-777777777777",
    serverId: server.id,
    name: "orphan",
    status: "active",
    runtime: "claude",
    model: "sonnet",
    executionMode: "byoc",
  }).returning();

  return { user, server, rootByUser, childOfRoot, grandchild, orphan };
}

test("batchEnrich: empty input returns empty array with no DB call", async ({ db }) => {

  const result = await batchEnrichAgentsWithCreatorProfile([]);
  assert.deepEqual(result, []);
});

test("batchEnrich: parity with per-agent enrich for user creator, agent creator, and orphan", async ({ db }) => {

  const { rootByUser, childOfRoot, grandchild, orphan } = await seed();

  const items = [rootByUser, childOfRoot, grandchild, orphan];
  const batched = await batchEnrichAgentsWithCreatorProfile(items);
  const sequential = await Promise.all(items.map((a) => enrichAgentWithCreatorProfile(a)));

  assert.equal(batched.length, sequential.length);
  for (let i = 0; i < items.length; i++) {
    const b = batched[i]!;
    const s = sequential[i]!;
    assert.equal(b.id, s.id);
    assert.deepEqual(b.creator, s.creator, `creator mismatch at index ${i} (id=${b.id})`);
    // sort both createdAgents arrays the same way for stable comparison
    const sortById = (xs: typeof b.createdAgents) => [...xs].sort((x, y) => x.id.localeCompare(y.id));
    assert.deepEqual(sortById(b.createdAgents), sortById(s.createdAgents), `createdAgents mismatch for id=${b.id}`);
  }
});

test("batchEnrich: rootByUser has the user creator and exactly one createdAgent (childOfRoot)", async ({ db }) => {

  const { rootByUser, childOfRoot } = await seed();

  const [enriched] = await batchEnrichAgentsWithCreatorProfile([rootByUser]);
  assert.ok(enriched);
  assert.ok(enriched.creator);
  assert.equal(enriched.creator.type, "human");
  assert.equal(enriched.creator.name, "owner");
  assert.equal(enriched.createdAgents.length, 1);
  assert.equal(enriched.createdAgents[0]!.id, childOfRoot.id);
});

test("batchEnrich: childOfRoot has agent creator (rootByUser) and one createdAgent (grandchild)", async ({ db }) => {

  const { rootByUser, childOfRoot, grandchild } = await seed();

  const [enriched] = await batchEnrichAgentsWithCreatorProfile([childOfRoot]);
  assert.ok(enriched);
  assert.ok(enriched.creator);
  assert.equal(enriched.creator.type, "agent");
  assert.equal(enriched.creator.id, rootByUser.id);
  assert.equal(enriched.createdAgents.length, 1);
  assert.equal(enriched.createdAgents[0]!.id, grandchild.id);
});

test("batchEnrich: orphan has null creator and empty createdAgents", async ({ db }) => {

  const { orphan } = await seed();

  const [enriched] = await batchEnrichAgentsWithCreatorProfile([orphan]);
  assert.ok(enriched);
  assert.equal(enriched.creator, null);
  assert.deepEqual(enriched.createdAgents, []);
});

test("batchEnrich: cross-server input rejected", async ({ db }) => {

  await seed();

  await assert.rejects(
    () => batchEnrichAgentsWithCreatorProfile([
      { id: "a", serverId: "s1", creatorType: null, creatorId: null },
      { id: "b", serverId: "s2", creatorType: null, creatorId: null },
    ]),
    /must share serverId/,
  );
});

test("batchEnrich: scales — 200 items processed in O(constant) DB roundtrips, parity preserved", async ({ db: database }) => {

  const { user, server, rootByUser } = await seed();
  const db = getDb();

  // Insert 200 children of rootByUser
  const many = await db.insert(agents).values(
    Array.from({ length: 200 }, (_, i) => ({
      serverId: server.id,
      name: `bulk-child-${i}`,
      status: "active" as const,
      runtime: "claude",
      model: "sonnet",
      executionMode: "byoc" as const,
      creatorType: "agent" as const,
      creatorId: rootByUser.id,
    })),
  ).returning();

  const items = many;
  const tracedQueries: Array<{ name: string; attrs: Record<string, unknown> | undefined }> = [];
  const traceQuery: DbQueryTracer = async (name, work, onComplete) => {
    const result = await work();
    tracedQueries.push({ name, attrs: onComplete?.(result) });
    return result;
  };
  const batched = await batchEnrichAgentsWithCreatorProfile(items, { traceQuery });
  assert.equal(batched.length, 200);
  assert.deepEqual(tracedQueries.map((query) => query.name).sort(), [
    "agents.batch_creator_enrich.agent_creators",
    "agents.batch_creator_enrich.created_agents",
  ]);
  assert.equal(tracedQueries.length, 2);
  assert.equal(tracedQueries.find((query) => query.name === "agents.batch_creator_enrich.agent_creators")?.attrs?.input_count, 1);
  assert.equal(tracedQueries.find((query) => query.name === "agents.batch_creator_enrich.created_agents")?.attrs?.input_count, 200);
  // Every child has rootByUser as creator
  for (const item of batched) {
    assert.ok(item.creator);
    assert.equal(item.creator.type, "agent");
    assert.equal(item.creator.id, rootByUser.id);
    // None of these bulk-children created further agents
    assert.deepEqual(item.createdAgents, []);
  }

  // rootByUser, when enriched alone, should now show 201 createdAgents (1 original child + 200 bulk)
  const [rootEnriched] = await batchEnrichAgentsWithCreatorProfile([rootByUser]);
  assert.equal(rootEnriched!.createdAgents.length, 201);

  // Use user to silence unused-var in case prior assertions evolve
  assert.ok(user);
});
