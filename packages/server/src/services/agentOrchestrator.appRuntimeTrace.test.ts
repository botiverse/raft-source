import { dbTest as test } from "../test/integration/dbTest.js";
import { closeTestDatabase } from "../test/integration/database.js";
import assert from "node:assert/strict";
import { afterEach } from "vitest";

import { BasicTracer, MemoryTraceSink } from "@botiverse/raft-shared";

import { getDb } from "../db/index.js";
import { users } from "../db/schema.js";
import { AgentOrchestrator } from "./agentOrchestrator.js";
import { createAgent } from "./agentService.js";
import { registerMachine } from "./machineService.js";
import { createServer } from "./serverService.js";


afterEach(async () => {
  await closeTestDatabase();
});

test("Server built-in App pushes expose content-free identities shared with Computer stages", async ({ db }) => {

  const [user] = await getDb()
    .insert(users)
    .values({
      email: "app-runtime-trace@slock.test",
      name: "app-runtime-trace",
      passwordHash: "hash",
      emailVerified: true,
    })
    .returning();
  const server = await createServer(
    "App runtime trace",
    "app-runtime-trace",
    user!.id,
  );
  const { machine } = await registerMachine(
    server.id,
    user!.id,
    "trace-machine",
  );
  const agent = await createAgent(server.id, "trace-agent", {
    machineId: machine.id,
  });

  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({ sink });
  const orchestrator = new AgentOrchestrator(undefined, undefined, tracer);
  const deliveries: unknown[] = [];
  (orchestrator as any).sendToMachine = async (
    _machineId: string,
    message: unknown,
  ) => {
    deliveries.push(message);
    return true;
  };

  assert.equal(
    await orchestrator.pushAppConfigUpsert(agent.id, {
      appId: "system.cleaner",
      ownerAgentId: agent.id,
      revision: 4,
      effective: { enabled: true, thresholdBytes: 65_536, intervalMs: 900_000 },
    }),
    true,
  );
  assert.equal(
    await orchestrator.pushReminderCancel(agent.id, "reminder-a", 6),
    true,
  );
  assert.equal(deliveries.length, 2);

  const spans = sink.getAllSpans();
  const config = spans.find(
    (span) => span.name === "server.app_config.transport",
  );
  const reminder = spans.find(
    (span) => span.name === "server.app_source.transport",
  );
  if (!config?.attrs || !reminder?.attrs) {
    throw new Error("expected config and reminder transport trace attributes");
  }
  assert.equal(
    config.attrs.app_correlation_id,
    `config:system.cleaner:${agent.id}:4`,
  );
  assert.equal(config.attrs.outcome, "sent");
  assert.equal(
    reminder.attrs.app_correlation_id,
    `source:${agent.id}:reminder:reminder-a:6`,
  );
  assert.equal(reminder.attrs.outcome, "sent");
  for (const attrs of [config.attrs, reminder.attrs]) {
    for (const forbidden of [
      "effective",
      "title",
      "summary",
      "action_cli",
      "argv",
      "path",
    ]) {
      assert.equal(Object.hasOwn(attrs, forbidden), false);
    }
  }
});

test("Server outcomes follow DB results, snapshot exceptions terminate, and unknown attrs are dropped", async ({ db }) => {

  const [user] = await getDb()
    .insert(users)
    .values({
      email: "app-runtime-terminal@slock.test",
      name: "app-runtime-terminal",
      passwordHash: "hash",
      emailVerified: true,
    })
    .returning();
  const server = await createServer(
    "App runtime terminal",
    "app-runtime-terminal",
    user!.id,
  );
  const { machine } = await registerMachine(
    server.id,
    user!.id,
    "trace-terminal-machine",
  );
  const agent = await createAgent(server.id, "trace-terminal-agent", {
    machineId: machine.id,
  });

  const sink = new MemoryTraceSink();
  const orchestrator = new AgentOrchestrator(
    undefined,
    undefined,
    new BasicTracer({ sink }),
  );
  (orchestrator as any).validateMachineAgentMessage = async () => agent;
  (orchestrator as any).recordBuiltInAppTrace("server.app_config.transport", {
    app_id: "system.cleaner",
    owner_agent_id: agent.id,
    config_revision: 1,
    app_correlation_id: `config:system.cleaner:${agent.id}:1`,
    outcome: "sent",
    payload: JSON.stringify({ thresholdBytes: 123 }),
    arbitrary_content: "must never be recorded",
  });

  await orchestrator.handleMachineMessage(machine.id, {
    type: "reminder.armed",
    agentId: agent.id,
    reminderId: "11111111-1111-4111-8111-111111111111",
    version: 1,
    armedAtClient: new Date(0).toISOString(),
  });
  await orchestrator.handleMachineMessage(machine.id, {
    type: "reminder.arm_rejected",
    agentId: agent.id,
    reminderId: "22222222-2222-4222-8222-222222222222",
    version: 1,
    reason: "invalid_fire_at",
  });
  const receipts = sink.getAllSpans().filter((span) =>
    span.name === "server.app_source.receipt"
  );
  assert.deepEqual(
    receipts.map((span) => ({ outcome: span.attrs?.outcome, status: span.status })),
    [
      { outcome: "not_recorded", status: "error" },
      { outcome: "not_recorded", status: "error" },
    ],
  );

  await closeTestDatabase();
  await orchestrator.handleMachineMessage(machine.id, {
    type: "reminder.snapshot.request",
    agentId: agent.id,
  });
  await orchestrator.handleMachineMessage(machine.id, {
    type: "app_config.snapshot.request",
    agentId: agent.id,
  });

  const spans = sink.getAllSpans();
  const injected = spans.find((span) =>
    span.name === "server.app_config.transport" && span.attrs?.outcome === "sent"
  );
  assert.equal(Object.hasOwn(injected?.attrs ?? {}, "payload"), false);
  assert.equal(Object.hasOwn(injected?.attrs ?? {}, "arbitrary_content"), false);
  const snapshotFailures = spans.filter((span) =>
    span.attrs?.outcome === "snapshot_failed"
  );
  assert.deepEqual(
    snapshotFailures.map((span) => ({
      name: span.name,
      status: span.status,
      correlation: span.attrs?.app_correlation_id,
    })),
    [
      {
        name: "server.app_source.transport",
        status: "error",
        correlation: `snapshot:reminder:system.reminder:${agent.id}`,
      },
      {
        name: "server.app_config.transport",
        status: "error",
        correlation: `snapshot:app_config:system.cleaner:${agent.id}`,
      },
    ],
  );
});
