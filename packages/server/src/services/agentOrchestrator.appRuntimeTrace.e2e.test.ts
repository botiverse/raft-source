import { dbTest as test } from "../test/integration/dbTest.js";
import { closeTestDatabase } from "../test/integration/database.js";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach } from "vitest";

import {
  BasicTracer,
  MemoryTraceSink,
  type ServerToMachineMessage,
} from "@botiverse/raft-shared";
import { appInboxItemTraceAttrs } from "@botiverse/raft-shared/src/appRuntimeTrace.js";
import { REMINDER_FIRE_REQUEST_CAPABILITY } from "@botiverse/raft-shared/src/apps/reminder/protocol.js";

import { createAgentAppInboxStore } from "../../../daemon/src/agentAppInbox.js";
import { REMINDER_AGENT_INBOX_REGISTRY } from "../../../daemon/src/apps/reminder/inboxDefinition.js";
import { createReminderRuntime } from "../../../daemon/src/apps/reminder/runtime.js";
import { createScopedAppStorageFactory } from "../../../daemon/src/scopedAppStorage.js";
import { FakeClock } from "../../../daemon/src/testing/fakeClock.js";
import {
  createReminder,
  getReminderById,
} from "../apps/reminder/service.js";
import { getDb } from "../db/index.js";
import { users } from "../db/schema.js";
import { AgentOrchestrator } from "./agentOrchestrator.js";
import { createAgent } from "./agentService.js";
import { registerMachine } from "./machineService.js";
import { createServer } from "./serverService.js";


afterEach(async () => {
  await closeTestDatabase();
});

test("real Server authority refuses an early Computer request, then commits before one mint/wake", async ({ db }) => {

  const [user] = await getDb().insert(users).values({
    email: "app-runtime-e2e@slock.test",
    name: "app-runtime-e2e",
    passwordHash: "hash",
    emailVerified: true,
  }).returning();
  const server = await createServer("App runtime e2e", "app-runtime-e2e", user!.id);
  const { machine } = await registerMachine(server.id, user!.id, "trace-e2e-machine");
  const agent = await createAgent(server.id, "trace-e2e-agent", { machineId: machine.id });

  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({ sink });
  let serverNowMs = 0;
  const serverClock = {
    now: () => serverNowMs,
    scheduleRepeated: () => 0,
    cancelRepeated: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
  };
  const orchestrator = new AgentOrchestrator(undefined, serverClock, tracer);

  const root = mkdtempSync(path.join(os.tmpdir(), "app-runtime-trace-e2e-"));
  const clock = new FakeClock();
  const recordDaemonTrace = (
    name: string,
    attrs: Record<string, unknown>,
    status: "ok" | "error" = "ok",
  ) => {
    tracer.startSpan(name, {
      surface: "daemon",
      kind: "internal",
      attrs,
    }).end(status);
  };
  let inbox: ReturnType<typeof createAgentAppInboxStore>;
  let reminder: ReturnType<typeof createReminderRuntime>;
  const pendingIngress: Promise<void>[] = [];
  const machineMessages: ServerToMachineMessage[] = [];
  const wakes: string[] = [];
  reminder = createReminderRuntime({
    clock,
    getInbox: () => inbox,
    notifyInbox: async (ownerAgentId, item) => {
      wakes.push(ownerAgentId);
      recordDaemonTrace("daemon.agent.app_inbox_notice", {
        ...appInboxItemTraceAttrs(ownerAgentId, item),
        outcome: "written",
        pending_app_items: inbox.list().length,
        message_identity_created: false,
      });
      return true;
    },
    send: (message) => {
      pendingIngress.push(orchestrator.handleMachineMessage(machine.id, message));
    },
    trace: recordDaemonTrace,
  });
  const storageFactory = createScopedAppStorageFactory({
    slockHome: root,
    owner: { machineId: machine.id, serverId: server.id },
  });
  reminder.bindStorageProvider((agentId) =>
    storageFactory.open({ appId: "system.reminder", agentId })
  );
  inbox = createAgentAppInboxStore({
    registry: REMINDER_AGENT_INBOX_REGISTRY,
    ownerAgentId: agent.id,
    beforeAck: (item) => reminder.beforeAck(agent.id, item),
    trace: recordDaemonTrace,
  });
  (orchestrator as any).machineConnections.set(machine.id, {
    ws: {},
    machineId: machine.id,
    serverId: server.id,
    principalKind: "computer",
    connectionEpochId: "reminder-authority-e2e",
    heartbeatTimer: null,
    runtimeAccountUsageTimer: null,
    lastPong: 0,
    lastIngressAt: 0,
    daemonVersion: "1.0.16",
    capabilities: new Set([REMINDER_FIRE_REQUEST_CAPABILITY]),
    runtimes: [],
    migrationTransport: null,
    shutdownIntent: null,
    computerVersion: "99.0.0",
  });
  (orchestrator as any).sendToMachine = async (
    _machineId: string,
    message: ServerToMachineMessage,
  ) => {
    machineMessages.push(message);
    reminder.handleServerMessage(message);
    return true;
  };
  const drainIngress = async () => {
    while (pendingIngress.length > 0) {
      await Promise.all(pendingIngress.splice(0));
      await new Promise((resolve) => setImmediate(resolve));
    }
  };

  const row = await createReminder({
    id: "11111111-1111-4111-8111-111111111111",
    serverId: server.id,
    ownerAgentId: agent.id,
    targetChannelId: null,
    msgId: null,
    title: "must not enter trace attrs",
    fireAt: new Date(9_000),
    payload: null,
    createdBy: { type: "human", id: user!.id },
  }, { clock: { now: () => new Date(serverNowMs) } });

  try {
    reminder.start();
    reminder.handleServerMessage({
      type: "reminder.snapshot",
      agentId: agent.id,
      reminders: [],
    });
    assert.equal(await orchestrator.pushReminderUpsert(agent.id, row), true);
    await drainIngress();

    // The Computer clock is 9s fast. Its due callback is only a request: the
    // Server clock remains authoritative and refuses without surfacing work.
    clock.advanceBy(9_000);
    await drainIngress();
    assert.deepEqual(inbox.list(), []);
    assert.deepEqual(wakes, []);
    assert.equal((await getReminderById(row.id))?.version, row.version);
    const premature = machineMessages.find((message) =>
      message.type === "reminder.fire_request.result" && message.outcome === "premature"
    );
    assert.ok(premature);
    assert.equal(premature.retryAfterMs, 8_000);

    clock.advanceBy(7_999);
    await drainIngress();
    assert.deepEqual(inbox.list(), []);
    assert.deepEqual(wakes, []);

    // Once the independent Server clock reaches the tolerance boundary, the
    // retry commits durable state before the result can mint/wake locally.
    serverNowMs += 8_000;
    clock.advanceBy(1);
    await drainIngress();
    const [item] = inbox.list();
    assert.ok(item);
    assert.deepEqual(wakes, [agent.id]);
    const converged = await getReminderById(row.id);
    assert.equal(converged?.status, "fired");
    assert.equal(converged?.version, row.version + 1);

    const requests = sink.getAllSpans().filter((span) =>
      span.name === "server.app_source.receipt"
      && span.attrs?.receipt_type === "reminder.fire_request"
    );
    assert.equal(requests.filter((span) => span.attrs?.outcome === "premature").length, 1);
    assert.equal(requests.filter((span) => span.attrs?.outcome === "accepted").length, 1);
    assert.equal(inbox.ack(item.itemId), true);

    const expectedCorrelation =
      `source:${agent.id}:reminder:${row.id}:${row.version}`;
    const stageNames = [
      "server.app_source.transport",
      "daemon.app_source.receive",
      "daemon.app_source.arm",
      "daemon.app_inbox.mint",
      "daemon.agent.app_inbox_notice",
      "daemon.app_source.receipt",
      "daemon.app_source.fire",
      "daemon.app_inbox.ack",
    ];
    const stages = sink.getAllSpans().filter((span) =>
      stageNames.includes(span.name)
      && span.attrs?.app_correlation_id === expectedCorrelation
    );
    assert.deepEqual(new Set(stages.map((span) => span.name)), new Set(stageNames));
    assert.deepEqual(
      new Set(stages.map((span) => span.attrs?.app_correlation_id)),
      new Set([expectedCorrelation]),
    );
    assert.equal(
      stages.every((span) =>
        !Object.hasOwn(span.attrs ?? {}, "title")
        && !Object.hasOwn(span.attrs ?? {}, "summary")
        && !Object.hasOwn(span.attrs ?? {}, "action_cli")
        && !Object.hasOwn(span.attrs ?? {}, "payload")
      ),
      true,
    );
  } finally {
    reminder.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
