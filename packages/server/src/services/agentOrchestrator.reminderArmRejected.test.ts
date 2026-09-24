import { dbTest as test } from "../test/integration/dbTest.js";
import { closeTestDatabase } from "../test/integration/database.js";
import assert from "node:assert/strict";
import { afterEach } from "vitest";

import type { MachineToServerMessage } from "@botiverse/raft-shared";
import { eq } from "drizzle-orm";

import { getDb } from "../db/index.js";
import { agents, reminders, servers, users } from "../db/schema.js";
import { createReminder, getReminderById } from "../apps/reminder/service.js";
import { AgentOrchestrator } from "./agentOrchestrator.js";


afterEach(async () => {
  await closeTestDatabase();
});

async function seedServerAndAgents() {
  const db = getDb();
  const [user] = await db.insert(users).values({
    id: "11111111-1111-4111-8111-111111111111",
    email: "reminder-arm-owner@example.com",
    name: "Reminder Owner",
    passwordHash: "hash",
    emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({
    id: "22222222-2222-4222-8222-222222222222",
    name: "Reminder Server",
    slug: "reminder-arm-server",
    ownerId: user.id,
  }).returning();
  const [agentA, agentB] = await db.insert(agents).values([
    {
      id: "33333333-3333-4333-8333-333333333333",
      serverId: server.id,
      name: "agent-a",
      status: "active",
      model: "sonnet",
      runtime: "claude",
      executionMode: "byoc",
    },
    {
      id: "44444444-4444-4444-8444-444444444444",
      serverId: server.id,
      name: "agent-b",
      status: "active",
      model: "sonnet",
      runtime: "claude",
      executionMode: "byoc",
    },
  ]).returning();
  return { user, server, agentA, agentB };
}

function bindValidatedAgent(orchestrator: AgentOrchestrator, agent: { id: string; serverId: string }) {
  (orchestrator as any).validateMachineAgentMessage = async () => agent;
}

function armRejectedMessage(agentId: string, reminderId: string, version: number): MachineToServerMessage {
  return {
    type: "reminder.arm_rejected",
    agentId,
    reminderId,
    version,
    reason: "invalid_fire_at",
  };
}

test("arm_rejected ingress persists not_armed without an immediate schedule re-push", async ({ db }) => {

  const { user, server, agentA } = await seedServerAndAgents();
  const reminder = await createReminder({
    serverId: server.id,
    ownerAgentId: agentA.id,
    msgId: null,
    title: "invalid on the Computer",
    fireAt: new Date("2026-08-09T12:00:00.000Z"),
    payload: null,
    createdBy: { type: "human", id: user.id },
  });
  const orchestrator = new AgentOrchestrator();
  bindValidatedAgent(orchestrator, agentA);
  let immediatePushes = 0;
  orchestrator.pushReminderUpsert = async () => {
    immediatePushes += 1;
    return true;
  };

  await orchestrator.handleMachineMessage(
    "machine-a",
    armRejectedMessage(agentA.id, reminder.id, reminder.version),
  );

  const persisted = await getReminderById(reminder.id);
  assert.equal(persisted?.armState, "not_armed");
  assert.equal(persisted?.armedVersion, null);
  assert.equal(immediatePushes, 0, "only the bounded arm watchdog may re-push a rejected schedule");
});

test("arm_rejected ingress cannot mutate another agent's reminder on the same Server", async ({ db }) => {

  const { user, server, agentA, agentB } = await seedServerAndAgents();
  const reminder = await createReminder({
    serverId: server.id,
    ownerAgentId: agentB.id,
    msgId: null,
    title: "agent B private reminder",
    fireAt: new Date("2026-08-09T12:00:00.000Z"),
    payload: null,
    createdBy: { type: "human", id: user.id },
  });
  const originalArmUpdatedAt = new Date("2026-08-09T01:00:00.000Z");
  await getDb().update(reminders).set({
    armState: "armed",
    armedVersion: null,
    armUpdatedAt: originalArmUpdatedAt,
  }).where(eq(reminders.id, reminder.id));

  const orchestrator = new AgentOrchestrator();
  bindValidatedAgent(orchestrator, agentA);
  let immediatePushes = 0;
  orchestrator.pushReminderUpsert = async () => {
    immediatePushes += 1;
    return true;
  };

  await orchestrator.handleMachineMessage(
    "machine-a",
    armRejectedMessage(agentA.id, reminder.id, reminder.version),
  );

  const persisted = await getReminderById(reminder.id);
  assert.equal(persisted?.ownerAgentId, agentB.id);
  assert.equal(persisted?.armState, "armed");
  assert.equal(persisted?.armedVersion, null);
  assert.equal(persisted?.armUpdatedAt?.toISOString(), originalArmUpdatedAt.toISOString());
  assert.equal(immediatePushes, 0);
});
