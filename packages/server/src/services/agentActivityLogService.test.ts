import { dbTest as test } from "../test/integration/dbTest.js";
import { closeTestDatabase } from "../test/integration/database.js";
import assert from "node:assert/strict";
import { afterEach } from "vitest";
import type { TrajectoryEntry } from "@botiverse/raft-shared";
import { getDb } from "../db/index.js";
import { agents, servers, users } from "../db/schema.js";
import { appendAgentActivityEvent, listRecentAgentTrajectory } from "./agentActivityLogService.js";


afterEach(async () => {
  await closeTestDatabase();
});

async function seedAgent(agentId: string, suffix: string) {
  const db = getDb();
  const [owner] = await db.insert(users).values({
    id: `10000000-0000-4000-8000-${suffix.padStart(12, "0")}`,
    email: `owner-${suffix}@example.com`,
    name: `owner-${suffix}`,
    displayName: `owner-${suffix}`,
    passwordHash: "hash",
    emailVerified: true,
  }).returning();

  const [server] = await db.insert(servers).values({
    id: `20000000-0000-4000-8000-${suffix.padStart(12, "0")}`,
    name: `Server ${suffix}`,
    slug: `server-${suffix}`,
    ownerId: owner.id,
  }).returning();

  await db.insert(agents).values({
    id: agentId,
    serverId: server.id,
    name: `agent-${suffix}`,
    status: "active",
    model: "gpt-5",
    runtime: "codex",
  });
}

test("activity log dedupes projection writes per agent and dedupe key", async ({ db }) => {

  const agentId = "30000000-0000-4000-8000-000000000001";
  await seedAgent(agentId, "1");

  const entry: TrajectoryEntry = { kind: "status", activity: "offline", detail: "Runtime interrupted" };
  const firstInserted = await appendAgentActivityEvent(
    agentId,
    "offline",
    "Runtime interrupted",
    [entry],
    new Date("2026-05-12T00:00:00.000Z"),
    "agent:agent-1:machine:machine-1:connectionEpoch:epoch-1:readyReconcile:mark-inactive-offline",
  );
  const secondInserted = await appendAgentActivityEvent(
    agentId,
    "offline",
    "Runtime interrupted",
    [entry],
    new Date("2026-05-12T00:00:01.000Z"),
    "agent:agent-1:machine:machine-1:connectionEpoch:epoch-1:readyReconcile:mark-inactive-offline",
  );

  assert.equal(firstInserted, true);
  assert.equal(secondInserted, false);
  assert.deepEqual(await listRecentAgentTrajectory(agentId), [
    { timestamp: Date.parse("2026-05-12T00:00:00.000Z"), entry },
  ]);
});

test("activity log dedupe keys are scoped to a single agent", async ({ db }) => {

  const agentOne = "30000000-0000-4000-8000-000000000011";
  const agentTwo = "30000000-0000-4000-8000-000000000012";
  await seedAgent(agentOne, "11");
  await seedAgent(agentTwo, "12");

  const entry: TrajectoryEntry = { kind: "status", activity: "offline", detail: "Runtime interrupted" };
  const dedupeKey = "machine:shared-epoch:readyReconcile";
  const firstInserted = await appendAgentActivityEvent(
    agentOne,
    "offline",
    "Runtime interrupted",
    [entry],
    new Date("2026-05-12T00:00:00.000Z"),
    dedupeKey,
  );
  const secondInserted = await appendAgentActivityEvent(
    agentTwo,
    "offline",
    "Runtime interrupted",
    [entry],
    new Date("2026-05-12T00:00:00.000Z"),
    dedupeKey,
  );

  assert.equal(firstInserted, true);
  assert.equal(secondInserted, true);
  assert.equal((await listRecentAgentTrajectory(agentOne)).length, 1);
  assert.equal((await listRecentAgentTrajectory(agentTwo)).length, 1);
});
