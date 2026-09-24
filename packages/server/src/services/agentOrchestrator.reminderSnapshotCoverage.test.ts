import { dbTest as test } from "../test/integration/dbTest.js";
import { closeTestDatabase } from "../test/integration/database.js";
import assert from "node:assert/strict";
import { afterEach } from "vitest";

import { getDb } from "../db/index.js";
import { reminders, users } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { AgentOrchestrator } from "./agentOrchestrator.js";
import { createAgent } from "./agentService.js";
import { registerMachine } from "./machineService.js";
import { createServer } from "./serverService.js";
import { createReminder } from "../apps/reminder/service.js";

afterEach(async () => {
  await closeTestDatabase();
});

// Task #2 (#proj-reminder): after a Computer restart, reminder snapshots were
// only requested for agents with running/idle sessions, so an owner outside
// that set never got its reminders loaded — missed fires that never recover.
// The fix pushes a snapshot for EVERY scheduled-reminder owner on the machine,
// from the server's authoritative view, session or not.
test("machine connect pushes reminder snapshots for every scheduled owner on that machine", async ({ db }) => {
  const [user] = await getDb()
    .insert(users)
    .values({
      email: "reminder-snapshot-coverage@slock.test",
      name: "reminder-snapshot-coverage",
      passwordHash: "hash",
      emailVerified: true,
    })
    .returning();
  const server = await createServer(
    "Reminder snapshot coverage",
    "reminder-snapshot-coverage",
    user!.id,
  );
  const { machine } = await registerMachine(server.id, user!.id, "coverage-machine");
  const { machine: otherMachine } = await registerMachine(server.id, user!.id, "other-machine");

  // Owner with a scheduled reminder on the covered machine — MUST be pushed
  // even though it has no running/idle session anywhere in this test.
  const owner = await createAgent(server.id, "sleeping-owner", { machineId: machine.id });
  // Agent on the same machine without reminders — must NOT produce a push.
  await createAgent(server.id, "no-reminders", { machineId: machine.id });
  // Owner on a different machine — must NOT be pushed for this machine.
  const elsewhereOwner = await createAgent(server.id, "elsewhere-owner", {
    machineId: otherMachine.id,
  });
  // Owner on the covered machine whose only reminder is no longer scheduled —
  // must NOT be pushed (coverage follows the reminders table's live view).
  const canceledOwner = await createAgent(server.id, "canceled-owner", {
    machineId: machine.id,
  });

  const ownerReminder = await createReminder({
    serverId: server.id,
    ownerAgentId: owner.id,
    msgId: null,
    title: "daily digest",
    fireAt: new Date(Date.now() + 60_000),
    payload: null,
    recurrence: { version: 1, rule: { kind: "interval", seconds: 86_400 } },
    createdBy: { type: "human", id: user!.id },
  });
  await createReminder({
    serverId: server.id,
    ownerAgentId: elsewhereOwner.id,
    msgId: null,
    title: "other machine",
    fireAt: new Date(Date.now() + 60_000),
    payload: null,
    createdBy: { type: "human", id: user!.id },
  });
  const canceledReminder = await createReminder({
    serverId: server.id,
    ownerAgentId: canceledOwner.id,
    msgId: null,
    title: "already canceled",
    fireAt: new Date(Date.now() + 60_000),
    payload: null,
    createdBy: { type: "human", id: user!.id },
  });
  await getDb()
    .update(reminders)
    .set({ status: "canceled" })
    .where(eq(reminders.id, canceledReminder.id));

  const orchestrator = new AgentOrchestrator();
  const deliveries: Array<{ machineId: string; message: any }> = [];
  (orchestrator as any).sendToMachine = async (machineId: string, message: any) => {
    deliveries.push({ machineId, message });
    return true;
  };

  await (orchestrator as any).pushReminderSnapshotsForMachine(machine.id);

  const snapshots = deliveries.filter(
    (delivery) => delivery.message?.type === "reminder.snapshot",
  );
  assert.equal(
    snapshots.length,
    1,
    "exactly one owner on this machine holds scheduled reminders",
  );
  const snapshot = snapshots[0]!;
  assert.equal(snapshot.machineId, machine.id);
  assert.equal(snapshot.message.agentId, owner.id);
  assert.deepEqual(
    snapshot.message.reminders.map((job: { reminderId: string }) => job.reminderId),
    [ownerReminder.id],
  );
});
