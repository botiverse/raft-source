import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase } from "../test/integration/database";
import assert from "node:assert/strict";

import { BasicTracer, MemoryTraceSink } from "@botiverse/raft-shared";

import { getDb } from "../db/index";
import { users } from "../db/schema";
import { AgentOrchestrator } from "./agentOrchestrator";
import { createAgent } from "./agentService";
import { registerMachine } from "./machineService";
import { createServer } from "./serverService";


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
  // A bare cancel only disarms; `canceled` is sent only for a reminder that was itself canceled (RFC 081 D21).
  assert.deepEqual(deliveries[1], { type: "reminder.cancel", agentId: agent.id, reminderId: "reminder-a", version: 6 });
  assert.equal(await orchestrator.pushReminderCancel(agent.id, "reminder-a", 7, { canceled: true }), true);
  assert.deepEqual(deliveries[2], { type: "reminder.cancel", agentId: agent.id, reminderId: "reminder-a", version: 7, canceled: true });

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
  const realSendToMachine = (orchestrator as any).sendToMachine;
  (orchestrator as any).sendToMachine = async () => true;
  await (orchestrator as any).sendAppTransport({
    spanName: "server.app_config.transport",
    traceAttrs: {
      app_id: "system.cleaner",
      owner_agent_id: agent.id,
      config_revision: 1,
      app_correlation_id: `config:system.cleaner:${agent.id}:1`,
      payload: JSON.stringify({ thresholdBytes: 123 }),
      arbitrary_content: "must never be recorded",
    },
    machineId: machine.id,
    message: { type: "app_config.snapshot", agentId: agent.id, configs: [] },
  });
  (orchestrator as any).sendToMachine = realSendToMachine;

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
  const snapshotFailures = sink.getAllLogEvents().filter((event) =>
    event.attrs?.outcome === "snapshot_failed"
  );
  assert.deepEqual(
    snapshotFailures.map((event) => ({
      name: event.name,
      status: spans.find((span) => span.context.spanId === event.context?.spanId)?.status,
      correlation: event.attrs?.app_correlation_id,
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

test("Transport push outcomes: owner_offline is ok, send_failed carries low-cardinality reason, send exceptions are traced without throwing", async ({ db }) => {

  const [user] = await getDb()
    .insert(users)
    .values({
      email: "app-runtime-transport-outcomes@slock.test",
      name: "app-runtime-transport-outcomes",
      passwordHash: "hash",
      emailVerified: true,
    })
    .returning();
  const server = await createServer(
    "App runtime transport outcomes",
    "app-runtime-transport-outcomes",
    user!.id,
  );
  // Create the offline agent before any machine exists: createAgent
  // auto-assigns the first available machine for managed runtimes.
  const offlineAgent = await createAgent(server.id, "trace-transport-offline-agent", {});
  const { machine } = await registerMachine(
    server.id,
    user!.id,
    "trace-transport-machine",
  );
  const machineAgent = await createAgent(server.id, "trace-transport-agent", {
    machineId: machine.id,
  });

  const sink = new MemoryTraceSink();
  const orchestrator = new AgentOrchestrator(
    undefined,
    undefined,
    new BasicTracer({ sink }),
  );

  // owner_offline: agent without a machine is an expected state (recovered by
  // snapshot refill on reconnect), not an error.
  assert.equal(await orchestrator.pushReminderCancel(offlineAgent.id, "reminder-offline", 1), false);
  const offlineEvent = sink.getAllLogEvents().find(
    (event) => event.name === "server.app_source.transport" && event.attrs?.outcome === "owner_offline",
  );
  assert.ok(offlineEvent);
  assert.equal(sink.getAllSpans().some((span) => span.status === "error"), false);

  // send_failed without a throw: machine has no ready connection.
  (orchestrator as any).sendToMachine = async () => false;
  assert.equal(await orchestrator.pushReminderCancel(machineAgent.id, "reminder-unreachable", 2), false);
  const unreachableSpan = sink.getAllSpans().find(
    (span) => span.name === "server.app_source.transport" && span.attrs?.outcome === "send_failed",
  );
  assert.equal(unreachableSpan?.status, "error");
  assert.equal(unreachableSpan?.attrs?.reason, "machine_unreachable");
  assert.equal(Object.hasOwn(unreachableSpan?.attrs ?? {}, "error_class"), false);

  // send exception: failure is traced with error_class and reported via the
  // boolean; best-effort pushes do not throw (dropped pushes recover on
  // reconnect, same as the snapshot path).
  (orchestrator as any).sendToMachine = async () => {
    throw new TypeError("socket collapsed");
  };
  assert.equal(await orchestrator.pushReminderCancel(machineAgent.id, "reminder-threw", 3), false);
  const threwSpan = sink.getAllSpans().find(
    (span) => span.name === "server.app_source.transport" && span.attrs?.reason === "send_threw",
  );
  assert.equal(threwSpan?.status, "error");
  assert.equal(threwSpan?.attrs?.outcome, "send_failed");
  assert.equal(threwSpan?.attrs?.error_class, "TypeError");

  // ws@8.20 sync-throws a plain not-open Error while the socket is still
  // CONNECTING; it classifies as machine_unreachable (connection unready),
  // not as an exception, and carries no error_class.
  (orchestrator as any).sendToMachine = async () => {
    throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
  };
  assert.equal(await orchestrator.pushReminderCancel(machineAgent.id, "reminder-connecting", 4), false);
  const connectingSpan = sink.getAllSpans().find(
    (span) => span.name === "server.app_source.transport" && span.attrs?.outcome === "send_failed"
      && (span.attrs?.app_correlation_id as string | undefined)?.includes("reminder-connecting"),
  );
  assert.equal(connectingSpan?.status, "error");
  assert.equal(connectingSpan?.attrs?.reason, "machine_unreachable");
  assert.equal(Object.hasOwn(connectingSpan?.attrs ?? {}, "error_class"), false);

  // A non-Error throw lands on the typeof branch of error_class.
  (orchestrator as any).sendToMachine = async () => {
    throw "plain string failure";
  };
  assert.equal(await orchestrator.pushReminderCancel(machineAgent.id, "reminder-string-throw", 5), false);
  const stringThrowSpan = sink.getAllSpans().find(
    (span) => span.name === "server.app_source.transport" && span.attrs?.reason === "send_threw"
      && (span.attrs?.app_correlation_id as string | undefined)?.includes("reminder-string-throw"),
  );
  assert.equal(stringThrowSpan?.attrs?.error_class, "string");
});
