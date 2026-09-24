import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";

import type {
  MachineToServerMessage,
  ReminderJob,
} from "@botiverse/raft-shared";

import { createAgentAppInboxStore, type AgentAppInboxStore } from "../../agentAppInbox.js";
import { createScopedAppStorageFactory } from "../../scopedAppStorage.js";
import { FakeClock } from "../../testing/fakeClock.js";
import { REMINDER_AGENT_INBOX_REGISTRY } from "./inboxDefinition.js";
import {
  createReminderPhaseTruth,
  REMINDER_BOUNDED_ALERT_PHASES,
} from "./reminderCache.js";
import {
  createReminderRuntime,
  reminderBoundedAlertPhaseAttrs,
  REMINDER_OWNER_FENCE_KINDS,
} from "./runtime.js";

const AGENT_A = "agent-a";
const AGENT_B = "agent-b";

test("bounded delivery-alert projection is a closed three-phase inventory", () => {
  assert.deepEqual(REMINDER_BOUNDED_ALERT_PHASES, [
    "fired",
    "app_item_materialized",
    "wake_request_accepted",
  ]);
  const attrs = reminderBoundedAlertPhaseAttrs(createReminderPhaseTruth({
    occurrenceId: "occurrence-1",
    firedAtClient: new Date(5).toISOString(),
  }));
  assert.deepEqual(Object.keys(attrs).sort(), [
    "app_item_materialized",
    "app_item_materialized_transition_at",
    "app_item_materialized_transition_evidence",
    "app_item_materialized_transition_source",
    "fired",
    "fired_transition_at",
    "fired_transition_evidence",
    "fired_transition_source",
    "wake_request_accepted",
    "wake_request_accepted_transition_at",
    "wake_request_accepted_transition_evidence",
    "wake_request_accepted_transition_source",
  ]);
});

function makeJob(overrides: Partial<ReminderJob> = {}): ReminderJob {
  return {
    reminderId: overrides.reminderId ?? "11111111-1111-4111-8111-111111111111",
    ownerAgentId: overrides.ownerAgentId ?? AGENT_B,
    msgId: overrides.msgId ?? null,
    title: overrides.title ?? "owner-envelope fence",
    fireAt: overrides.fireAt ?? new Date(100).toISOString(),
    version: overrides.version ?? 8,
    recurrence: overrides.recurrence ?? null,
  };
}

function findLatestRequest(messages: readonly MachineToServerMessage[], agentId?: string) {
  return [...messages].reverse().find((message): message is Extract<MachineToServerMessage, { type: "reminder.fire_request" }> =>
    message.type === "reminder.fire_request" && (agentId === undefined || message.agentId === agentId)
  );
}

function createHarness(options: {
  synchronize?: boolean;
  notifyInbox?: (agentId: string) => Promise<boolean>;
} = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "reminder-owner-envelope-"));
  const clock = new FakeClock();
  const sent: MachineToServerMessage[] = [];
  const wakes: string[] = [];
  const traces: Array<{
    name: string;
    attrs: Record<string, unknown>;
    status?: "ok" | "error";
  }> = [];
  const inboxes = new Map<string, AgentAppInboxStore>();
  const getInbox = (agentId: string) => {
    let inbox = inboxes.get(agentId);
    if (!inbox) {
      inbox = createAgentAppInboxStore({ registry: REMINDER_AGENT_INBOX_REGISTRY });
      inboxes.set(agentId, inbox);
    }
    return inbox;
  };
  const runtime = createReminderRuntime({
    clock,
    getInbox,
    notifyInbox: async (agentId) => {
      wakes.push(agentId);
      return options.notifyInbox ? options.notifyInbox(agentId) : true;
    },
    send: (message) => sent.push(message),
    trace: (name, attrs, status) => traces.push({ name, attrs, status }),
  });
  const storageFactory = createScopedAppStorageFactory({
    slockHome: root,
    owner: { machineId: "machine-test", serverId: "server-test" },
  });
  runtime.bindStorageProvider((agentId) =>
    storageFactory.open({ appId: "system.reminder", agentId })
  );
  runtime.start();
  if (options.synchronize !== false) {
    for (const agentId of [AGENT_A, AGENT_B]) {
      runtime.handleServerMessage({
        type: "reminder.snapshot",
        agentId,
        reminders: [],
      });
    }
  }
  sent.length = 0;
  traces.length = 0;
  return {
    clock,
    getInbox,
    runtime,
    sent,
    traces,
    wakes,
    cleanup: () => {
      runtime.stop();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("one occurrence exposes fired, materialized, wake-request, and ack faces independently", async () => {
  const harness = createHarness();
  try {
    const job = makeJob({ fireAt: new Date(5).toISOString() });
    harness.runtime.handleServerMessage({
      type: "reminder.upsert",
      agentId: AGENT_B,
      reminder: job,
    });
    harness.clock.advanceBy(5);
    await new Promise((resolve) => setImmediate(resolve));

    const firedOnly = harness.traces.filter((trace) =>
      trace.name === "daemon.app_schedule.occurrence"
    );
    assert.deepEqual(
      firedOnly.map(({ attrs }) => ({
        phase: attrs.phase,
        observedAt: attrs.observed_at,
        scheduledDue: attrs.scheduled_due,
        fireDelayMs: attrs.fire_delay_ms,
      })),
      [{
        phase: "fired",
        observedAt: new Date(5).toISOString(),
        scheduledDue: new Date(5).toISOString(),
        fireDelayMs: 0,
      }],
      "the local due transition is observable before any Server response",
    );

    await acceptLatestRequest(harness, AGENT_B);

    const [item] = harness.getInbox(AGENT_B).list();
    assert.ok(item);
    assert.equal(harness.runtime.beforeAck(AGENT_B, item), true);

    const lifecycle = harness.traces.filter((trace) =>
      trace.name === "daemon.app_schedule.occurrence"
    );
    assert.deepEqual(
      lifecycle.map(({ attrs, status }) => ({
        phase: attrs.phase,
        outcome: attrs.outcome,
        status,
      })),
      [
        { phase: "fired", outcome: "observed", status: "ok" },
        { phase: "app_item_materialized", outcome: "observed", status: "ok" },
        { phase: "wake_request_accepted", outcome: "observed", status: "ok" },
        { phase: "acknowledged", outcome: "observed", status: "ok" },
      ],
    );
    assert.equal(new Set(lifecycle.map(({ attrs }) => attrs.occurrence)).size, 1);
    assert.equal(
      lifecycle.every(({ attrs }) => typeof attrs.observed_at === "string"),
      true,
    );
  } finally {
    harness.cleanup();
  }
});

test("materialized-but-not-woken occurrence fails loud after the bounded ack age", async () => {
  const harness = createHarness({ notifyInbox: async () => false });
  try {
    const job = makeJob({ fireAt: new Date(5).toISOString() });
    harness.runtime.handleServerMessage({
      type: "reminder.upsert",
      agentId: AGENT_B,
      reminder: job,
    });
    harness.clock.advanceBy(5);
    await new Promise((resolve) => setImmediate(resolve));
    await acceptLatestRequest(harness, AGENT_B);

    assert.equal(harness.getInbox(AGENT_B).list().length, 1);
    assert.equal(
      harness.traces.some((trace) =>
        trace.name === "daemon.app_schedule.occurrence"
        && trace.attrs.phase === "wake_request_accepted"
        && trace.attrs.outcome === "observed"
      ),
      false,
      "an App item alone must not be upgraded to wake-request acceptance",
    );

    harness.clock.advanceBy(15 * 60 * 1_000);
    const [alert] = harness.traces.filter((trace) =>
      trace.name === "daemon.app_schedule.delivery_alert"
    );
    assert.deepEqual(alert && {
      reason: alert.attrs.reason,
      fired: alert.attrs.fired,
      appItemMaterialized: alert.attrs.app_item_materialized,
      wakeRequestAccepted: alert.attrs.wake_request_accepted,
      turnOutcome: alert.attrs.turn_outcome,
      acknowledged: alert.attrs.acknowledged,
      firedEvidence: alert.attrs.fired_transition_evidence,
      firedAt: alert.attrs.fired_transition_at,
      materializedEvidence: alert.attrs.app_item_materialized_transition_evidence,
      materializedAt: alert.attrs.app_item_materialized_transition_at,
      wakeEvidence: alert.attrs.wake_request_accepted_transition_evidence,
      wakeAt: alert.attrs.wake_request_accepted_transition_at,
      alertAt: alert.attrs.observed_at,
      status: alert.status,
    }, {
      reason: "fired_but_unacknowledged",
      fired: true,
      appItemMaterialized: true,
      wakeRequestAccepted: false,
      turnOutcome: "unknown",
      acknowledged: false,
      firedEvidence: "observed",
      firedAt: new Date(5).toISOString(),
      materializedEvidence: "observed",
      materializedAt: new Date(5).toISOString(),
      wakeEvidence: "not_reached",
      wakeAt: null,
      alertAt: new Date(15 * 60 * 1_000 + 5).toISOString(),
      status: "error",
    });
    assert.notEqual(
      alert?.attrs.app_item_materialized_transition_at,
      alert?.attrs.observed_at,
      "alert time cannot masquerade as a phase transition time",
    );
  } finally {
    harness.cleanup();
  }
});

test("pre-snapshot upsert stays silent until the matching authoritative snapshot arms it", async () => {
  const harness = createHarness({ synchronize: false });
  try {
    const job = makeJob({
      ownerAgentId: AGENT_B,
      fireAt: new Date(5).toISOString(),
    });

    harness.runtime.handleServerMessage({
      type: "reminder.upsert",
      agentId: AGENT_B,
      reminder: job,
    });
    assert.equal(
      harness.sent.filter((message) =>
        message.type === "reminder.snapshot.request" && message.agentId === AGENT_B
      ).length,
      1,
      "pre-snapshot upsert asks for authoritative convergence",
    );
    assert.equal(
      harness.sent.some((message) =>
        message.type === "reminder.armed"
        || message.type === "reminder.arm_rejected"
        || message.type === "reminder.fire_request"
      ),
      false,
    );

    harness.clock.advanceBy(10);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      harness.sent.some((message) => message.type === "reminder.fire_request"),
      false,
    );

    harness.runtime.handleServerMessage({
      type: "reminder.snapshot",
      agentId: AGENT_B,
      reminders: [job],
    });
    assert.equal(
      harness.sent.filter((message) => message.type === "reminder.armed").length,
      1,
    );
    assert.equal(
      harness.sent.some((message) => message.type === "reminder.arm_rejected"),
      false,
    );

    harness.clock.advanceBy(0);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      harness.sent.filter((message) => message.type === "reminder.fire_request").length,
      1,
    );
  } finally {
    harness.cleanup();
  }
});

test("unsynchronized upsert requests one owner snapshot and reconnect allows retry without arming from push", async () => {
  const harness = createHarness({ synchronize: false });
  try {
    const job = makeJob({
      ownerAgentId: AGENT_B,
      fireAt: new Date(5).toISOString(),
    });

    harness.runtime.handleServerMessage({
      type: "reminder.upsert",
      agentId: AGENT_B,
      reminder: job,
    });
    harness.runtime.handleServerMessage({
      type: "reminder.upsert",
      agentId: AGENT_B,
      reminder: job,
    });

    assert.equal(
      harness.sent.filter((message) =>
        message.type === "reminder.snapshot.request" && message.agentId === AGENT_B
      ).length,
      1,
      "same-connection stale replay must not request-storm",
    );
    assert.equal(
      harness.sent.some((message) =>
        message.type === "reminder.armed" || message.type === "reminder.fire_request"
      ),
      false,
      "snapshot request is not permission to arm before authority arrives",
    );

    harness.clock.advanceBy(10);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      harness.sent.some((message) => message.type === "reminder.fire_request"),
      false,
      "due pre-snapshot push remains inert",
    );

    harness.runtime.onConnect();
    harness.runtime.handleServerMessage({
      type: "reminder.upsert",
      agentId: AGENT_B,
      reminder: job,
    });
    assert.equal(
      harness.sent.filter((message) =>
        message.type === "reminder.snapshot.request" && message.agentId === AGENT_B
      ).length,
      2,
      "reconnect reopens convergence if the prior snapshot response was lost",
    );

    harness.runtime.handleServerMessage({
      type: "reminder.snapshot",
      agentId: AGENT_B,
      reminders: [job],
    });
    assert.equal(
      harness.sent.filter((message) => message.type === "reminder.armed").length,
      1,
    );

    harness.clock.advanceBy(0);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      harness.sent.filter((message) => message.type === "reminder.fire_request").length,
      1,
      "authoritative snapshot arms the overdue row exactly once",
    );

    harness.runtime.handleServerMessage({
      type: "reminder.upsert",
      agentId: AGENT_B,
      reminder: job,
    });
    harness.runtime.handleServerMessage({
      type: "reminder.snapshot",
      agentId: AGENT_B,
      reminders: [job],
    });
    assert.equal(
      harness.sent.filter((message) => message.type === "reminder.fire_request").length,
      1,
      "duplicate push/snapshot must not double-fire the same revision",
    );
  } finally {
    harness.cleanup();
  }
});

test("authoritative empty snapshot after unsynchronized upsert remains a no-fire fence", async () => {
  const harness = createHarness({ synchronize: false });
  try {
    const job = makeJob({
      ownerAgentId: AGENT_B,
      fireAt: new Date(5).toISOString(),
    });

    harness.runtime.handleServerMessage({
      type: "reminder.upsert",
      agentId: AGENT_B,
      reminder: job,
    });
    assert.equal(
      harness.sent.filter((message) =>
        message.type === "reminder.snapshot.request" && message.agentId === AGENT_B
      ).length,
      1,
    );

    harness.runtime.handleServerMessage({
      type: "reminder.snapshot",
      agentId: AGENT_B,
      reminders: [],
    });
    assert.equal(
      harness.sent.some((message) =>
        message.type === "reminder.armed" || message.type === "reminder.fire_request"
      ),
      false,
      "empty authoritative snapshot must not arm an omitted pre-sync upsert",
    );

    harness.clock.advanceBy(10);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      harness.sent.some((message) => message.type === "reminder.fire_request"),
      false,
      "omission fence remains silent after due",
    );

    harness.runtime.handleServerMessage({
      type: "reminder.upsert",
      agentId: AGENT_B,
      reminder: job,
    });
    assert.equal(
      harness.sent.filter((message) =>
        message.type === "reminder.snapshot.request" && message.agentId === AGENT_B
      ).length,
      1,
      "synchronized omission fence does not reopen snapshot convergence on stale replay",
    );
    assert.equal(
      harness.sent.some((message) =>
        message.type === "reminder.armed" || message.type === "reminder.fire_request"
      ),
      false,
    );
  } finally {
    harness.cleanup();
  }
});

async function acceptLatestRequest(
  harness: ReturnType<typeof createHarness>,
  agentId: string,
  fired = true,
) {
  const request = findLatestRequest(harness.sent, agentId);
  assert.ok(request, "timer must emit a Server-authorized fire request");
  harness.runtime.handleServerMessage({
    type: "reminder.fire_request.result",
    agentId,
    reminderId: request.reminderId,
    version: request.version,
    requestId: request.requestId,
    outcome: "accepted",
    fired,
    catchup: false,
  });
  await new Promise((resolve) => setImmediate(resolve));
  return request;
}

test("Reminder waits for Server acceptance before item/wake and keeps one content-free source identity", async () => {
  const harness = createHarness();
  try {
    const job = makeJob({
      ownerAgentId: AGENT_B,
      fireAt: new Date(5).toISOString(),
    });
    harness.runtime.handleServerMessage({
      type: "reminder.upsert",
      agentId: AGENT_B,
      reminder: job,
    });
    harness.clock.advanceBy(5);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(harness.getInbox(AGENT_B).list(), [], "due request alone cannot mint an item");
    assert.deepEqual(harness.wakes, [], "due request alone cannot wake the owner");
    await acceptLatestRequest(harness, AGENT_B);

    const stages = harness.traces.filter((trace) =>
      [
        "daemon.app_source.receive",
        "daemon.app_source.arm",
        "daemon.app_source.fire",
        "daemon.app_source.receipt",
      ].includes(trace.name),
    );
    assert.deepEqual(
      stages.map((trace) => trace.name),
      [
        "daemon.app_source.receive",
        "daemon.app_source.arm",
        "daemon.app_source.receipt",
        "daemon.app_source.receipt",
        "daemon.app_source.fire",
      ],
    );
    assert.equal(
      new Set(stages.map((trace) => trace.attrs.app_correlation_id)).size,
      1,
    );
    assert.equal(stages.at(-1)!.attrs.outcome, "presented");
    assert.equal(harness.getInbox(AGENT_B).list().length, 1);
    assert.deepEqual(harness.wakes, [AGENT_B]);
    for (const trace of stages) {
      assert.equal(Object.hasOwn(trace.attrs, "title"), false);
      assert.equal(Object.hasOwn(trace.attrs, "summary"), false);
      assert.equal(Object.hasOwn(trace.attrs, "action_cli"), false);
    }
  } finally {
    harness.cleanup();
  }
});

test("unanswered fire request exhausts with one privacy-safe typed retry trace", async () => {
  const harness = createHarness();
  try {
    const job = makeJob({
      ownerAgentId: AGENT_B,
      fireAt: new Date(5).toISOString(),
    });
    harness.runtime.handleServerMessage({
      type: "reminder.upsert",
      agentId: AGENT_B,
      reminder: job,
    });
    for (const delay of [5, 1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000]) {
      harness.clock.advanceBy(delay);
      await new Promise((resolve) => setImmediate(resolve));
    }

    const retryTraces = harness.traces.filter((trace) => trace.name === "daemon.app_source.retry");
    assert.equal(
      harness.sent.filter((message) => message.type === "reminder.fire_request").length,
      8,
    );
    assert.deepEqual(retryTraces, [{
      name: "daemon.app_source.retry",
      attrs: {
        app_id: "system.reminder",
        owner_agent_id: AGENT_B,
        notification_class: "due",
        source_kind: "reminder",
        source_id: job.reminderId,
        source_revision: String(job.version),
        app_correlation_id: `source:${AGENT_B}:reminder:${job.reminderId}:${job.version}`,
        outcome: "exhausted",
        code: "REMINDER_DELIVERY_RETRY_EXHAUSTED",
        stage: "fire_request",
        attempts: 8,
        deadline_at: new Date(900_005).toISOString(),
      },
      status: "error",
    }]);
    for (const key of ["title", "summary", "action_cli", "payload", "value"]) {
      assert.equal(Object.hasOwn(retryTraces[0]!.attrs, key), false);
    }

    harness.clock.advanceBy(900_005 - harness.clock.now());
    const lifecycle = harness.traces.filter((trace) =>
      trace.name === "daemon.app_schedule.occurrence"
    );
    assert.deepEqual(
      lifecycle.map(({ attrs }) => attrs.phase),
      ["fired", "error"],
      "an unanswered occurrence records its real fire and terminal retry error only",
    );
    assert.equal(lifecycle[0]!.attrs.observed_at, new Date(5).toISOString());

    const alerts = harness.traces.filter((trace) =>
      trace.name === "daemon.app_schedule.delivery_alert"
    );
    assert.deepEqual(alerts.map(({ attrs, status }) => ({
      reason: attrs.reason,
      fired: attrs.fired,
      appItemMaterialized: attrs.app_item_materialized,
      wakeRequestAccepted: attrs.wake_request_accepted,
      turnOutcome: attrs.turn_outcome,
      acknowledged: attrs.acknowledged,
      status,
    })), [{
      reason: "fired_but_unacknowledged",
      fired: true,
      appItemMaterialized: false,
      wakeRequestAccepted: false,
      turnOutcome: "unknown",
      acknowledged: false,
      status: "error",
    }]);
  } finally {
    harness.cleanup();
  }
});

test("premature result re-arms by bounded duration and stale results cannot surface an item", async () => {
  const harness = createHarness();
  try {
    const job = makeJob({ ownerAgentId: AGENT_B, fireAt: new Date(5).toISOString() });
    harness.runtime.handleServerMessage({ type: "reminder.upsert", agentId: AGENT_B, reminder: job });
    harness.clock.advanceBy(5);
    await new Promise((resolve) => setImmediate(resolve));
    const first = findLatestRequest(harness.sent);
    assert.ok(first);
    assert.deepEqual(harness.getInbox(AGENT_B).list(), []);
    assert.deepEqual(harness.wakes, []);

    harness.runtime.handleServerMessage({
      type: "reminder.fire_request.result",
      agentId: AGENT_B,
      reminderId: first.reminderId,
      version: first.version,
      requestId: first.requestId,
      outcome: "premature",
      reason: "premature_fire",
      serverNow: new Date(0).toISOString(),
      dueAt: new Date(3_200).toISOString(),
      retryAfterMs: Number.NaN,
    });
    harness.clock.advanceBy(1);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(harness.sent.filter((message) => message.type === "reminder.fire_request").length, 1);
    assert.deepEqual(harness.wakes, [], "an invalid retry duration cannot create a busy loop");

    harness.runtime.handleServerMessage({
      type: "reminder.fire_request.result",
      agentId: AGENT_B,
      reminderId: first.reminderId,
      version: first.version,
      requestId: first.requestId,
      outcome: "premature",
      reason: "premature_fire",
      serverNow: new Date(0).toISOString(),
      dueAt: new Date(3_200).toISOString(),
      retryAfterMs: 3_200,
    });
    harness.clock.advanceBy(3_199);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(harness.sent.filter((message) => message.type === "reminder.fire_request").length, 1);
    assert.deepEqual(harness.wakes, []);

    harness.clock.advanceBy(1);
    await new Promise((resolve) => setImmediate(resolve));
    const requests = harness.sent.filter((message): message is Extract<MachineToServerMessage, { type: "reminder.fire_request" }> =>
      message.type === "reminder.fire_request"
    );
    assert.equal(requests.length, 2);
    const second = requests[1]!;
    assert.notEqual(second.requestId, first.requestId);

    harness.runtime.handleServerMessage({
      type: "reminder.fire_request.result",
      agentId: AGENT_B,
      reminderId: first.reminderId,
      version: first.version,
      requestId: first.requestId,
      outcome: "accepted",
      fired: true,
      catchup: false,
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(harness.getInbox(AGENT_B).list(), [], "late predecessor result is inert");
    assert.deepEqual(harness.wakes, []);

    const accepted = {
      type: "reminder.fire_request.result" as const,
      agentId: AGENT_B,
      reminderId: second.reminderId,
      version: second.version,
      requestId: second.requestId,
      outcome: "accepted" as const,
      fired: true,
      catchup: false,
    };
    harness.runtime.handleServerMessage(accepted);
    await new Promise((resolve) => setImmediate(resolve));
    harness.runtime.handleServerMessage(accepted);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(harness.getInbox(AGENT_B).list().length, 1);
    assert.deepEqual(harness.wakes, [AGENT_B], "duplicate accepted result cannot wake twice");
  } finally {
    harness.cleanup();
  }
});

test("stale cancel, missing receipt ACK, and filtered snapshot are error terminals", () => {
  const harness = createHarness();
  try {
    const job = makeJob({ ownerAgentId: AGENT_B });
    harness.runtime.handleServerMessage({
      type: "reminder.upsert",
      agentId: AGENT_B,
      reminder: job,
    });
    harness.traces.length = 0;

    harness.runtime.handleServerMessage({
      type: "reminder.cancel",
      agentId: AGENT_A,
      reminderId: job.reminderId,
      version: job.version,
    });
    harness.runtime.handleServerMessage({
      type: "reminder.fire_receipt.ack",
      agentId: AGENT_A,
      reminderId: "22222222-2222-4222-8222-222222222222",
      version: 1,
    });
    harness.runtime.handleServerMessage({
      type: "reminder.snapshot",
      agentId: AGENT_B,
      reminders: [job],
    });
    harness.runtime.handleServerMessage({
      type: "reminder.snapshot",
      agentId: AGENT_A,
      reminders: [makeJob({ ownerAgentId: AGENT_A })],
    });
    harness.runtime.handleServerMessage({
      type: "reminder.snapshot",
      agentId: AGENT_A,
      reminders: [job],
    });

    assert.deepEqual(
      harness.traces.map(({ name, attrs, status }) => ({
        name,
        outcome: attrs.outcome,
        status,
      })),
      [
        { name: "daemon.app_source.receive", outcome: "stale", status: "error" },
        { name: "daemon.app_source.receipt", outcome: "missing", status: "error" },
        { name: "daemon.app_source.receive", outcome: "stale", status: "error" },
        { name: "daemon.app_source.arm", outcome: "armed", status: undefined },
        { name: "daemon.app_source.receive", outcome: "rejected", status: "error" },
        { name: "daemon.app_source.receive", outcome: "owner_mismatch", status: "error" },
        { name: "daemon.app_source.receive", outcome: "applied_empty", status: undefined },
      ],
    );
  } finally {
    harness.cleanup();
  }
});

test("local source ACK rejects another owner without reopening Server request replay", async () => {
  const harness = createHarness();
  try {
    const job = makeJob({
      ownerAgentId: AGENT_B,
      fireAt: new Date(5).toISOString(),
    });
    harness.runtime.handleServerMessage({
      type: "reminder.upsert",
      agentId: AGENT_B,
      reminder: job,
    });
    harness.clock.advanceBy(5);
    await new Promise((resolve) => setImmediate(resolve));
    await acceptLatestRequest(harness, AGENT_B);
    const [item] = harness.getInbox(AGENT_B).list();
    assert.ok(item);

    assert.equal(harness.runtime.beforeAck(AGENT_A, item), false);
    harness.sent.length = 0;
    harness.runtime.replayPendingReceipts();
    assert.equal(
      harness.sent.some((message) =>
        message.type === "reminder.fire_request" && message.agentId === AGENT_B
      ),
      false,
    );
    assert.equal(harness.runtime.beforeAck(AGENT_B, item), true);
  } finally {
    harness.cleanup();
  }
});

test("local source ACK retires a same-owner stale Inbox item after its receipt is gone", async () => {
  const harness = createHarness();
  try {
    const job = makeJob({
      ownerAgentId: AGENT_B,
      fireAt: new Date(50).toISOString(),
      version: 8,
    });
    harness.runtime.handleServerMessage({
      type: "reminder.upsert",
      agentId: AGENT_B,
      reminder: job,
    });
    const mint = harness.getInbox(AGENT_B).mint({
      appId: "system.reminder",
      notificationClass: "due",
      sourceRef: { kind: "reminder", id: job.reminderId, revision: String(job.version) },
    });
    assert.equal(mint.ok, true);
    if (!mint.ok) assert.fail("expected reminder Inbox item to mint");

    assert.equal(harness.runtime.beforeAck(AGENT_A, mint.item), false);
    assert.equal(harness.getInbox(AGENT_B).list().length, 1);

    assert.equal(
      harness.runtime.beforeAck(AGENT_B, mint.item),
      true,
      "successful source read should retire stale same-owner items even when the local receipt is absent",
    );
    assert.equal(harness.getInbox(AGENT_B).ack(mint.item.itemId), true);
    assert.deepEqual(harness.getInbox(AGENT_B).list(), []);
  } finally {
    harness.cleanup();
  }
});

test("local source ACK rejects a stale item after the same reminder has an active newer revision", async () => {
  const harness = createHarness();
  try {
    const oldJob = makeJob({
      ownerAgentId: AGENT_B,
      fireAt: new Date(50).toISOString(),
      version: 8,
    });
    const newJob = { ...oldJob, version: 9, fireAt: new Date(100).toISOString() };
    harness.runtime.handleServerMessage({
      type: "reminder.upsert",
      agentId: AGENT_B,
      reminder: oldJob,
    });
    const stale = harness.getInbox(AGENT_B).mint({
      appId: "system.reminder",
      notificationClass: "due",
      sourceRef: { kind: "reminder", id: oldJob.reminderId, revision: String(oldJob.version) },
    });
    assert.equal(stale.ok, true);
    if (!stale.ok) assert.fail("expected stale reminder Inbox item to mint");

    harness.runtime.handleServerMessage({
      type: "reminder.upsert",
      agentId: AGENT_B,
      reminder: newJob,
    });

    assert.equal(
      harness.runtime.beforeAck(AGENT_B, stale.item),
      false,
      "old revision must not be accepted once a newer active fire item exists",
    );
    assert.equal(harness.getInbox(AGENT_B).list().length, 1);
  } finally {
    harness.cleanup();
  }
});

const ownerEnvelopeCases: Array<{
  type: keyof typeof REMINDER_OWNER_FENCE_KINDS;
  name: string;
  run(harness: ReturnType<typeof createHarness>): Promise<void>;
}> = [
  {
    type: "reminder.upsert",
    name: "upsert cannot install another owner's payload",
    async run({ clock, getInbox, runtime, sent, wakes }) {
      runtime.handleServerMessage({
        type: "reminder.upsert",
        agentId: AGENT_A,
        reminder: makeJob({ fireAt: new Date(5).toISOString() }),
      });
      clock.advanceBy(5);
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(sent, [], "mismatched upsert emits neither armed nor rejected");
      assert.deepEqual(getInbox(AGENT_B).list(), []);
      assert.deepEqual(wakes, []);
    },
  },
  {
    type: "reminder.cancel",
    name: "cancel cannot apply to another owner's installed timer",
    async run({ clock, getInbox, runtime, sent, wakes }) {
      const job = makeJob({ fireAt: new Date(5).toISOString() });
      runtime.handleServerMessage({ type: "reminder.upsert", agentId: AGENT_B, reminder: job });
      sent.length = 0;
      runtime.handleServerMessage({
        type: "reminder.cancel",
        agentId: AGENT_A,
        reminderId: job.reminderId,
        version: job.version,
      });
      clock.advanceBy(5);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(getInbox(AGENT_B).list().length, 0, "request cannot surface before Server acceptance");
      assert.deepEqual(wakes, []);
      assert.ok(sent.some((message) =>
        message.type === "reminder.fire_request" && message.agentId === AGENT_B
      ));
    },
  },
  {
    type: "reminder.snapshot",
    name: "snapshot cannot emit an outcome for another owner's entry",
    async run({ runtime, sent }) {
      const job = makeJob();
      runtime.handleServerMessage({ type: "reminder.upsert", agentId: AGENT_B, reminder: job });
      sent.length = 0;
      runtime.handleServerMessage({
        type: "reminder.snapshot",
        agentId: AGENT_A,
        reminders: [job],
      });
      assert.deepEqual(sent, [], "mismatched snapshot entries emit no arm outcome");
    },
  },
  {
    type: "reminder.fire_receipt.ack",
    name: "fire receipt acknowledgement cannot retire another owner's receipt",
    async run({ clock, runtime, sent }) {
      const job = makeJob({ fireAt: new Date(5).toISOString() });
      runtime.handleServerMessage({ type: "reminder.upsert", agentId: AGENT_B, reminder: job });
      clock.advanceBy(5);
      await new Promise((resolve) => setImmediate(resolve));
      sent.length = 0;
      runtime.handleServerMessage({
        type: "reminder.fire_receipt.ack",
        agentId: AGENT_A,
        reminderId: job.reminderId,
        version: job.version,
      });
      runtime.replayPendingReceipts();
      clock.advanceBy(1_000);
      assert.ok(sent.some((message) =>
        message.type === "reminder.fire_request" && message.agentId === AGENT_B
      ), "misrouted acknowledgement leaves the owner's receipt pending");
    },
  },
  {
    type: "reminder.fire_request.result",
    name: "fire request result cannot authorize another owner's pending attempt",
    async run({ clock, runtime, sent, wakes }) {
      const job = makeJob({ fireAt: new Date(5).toISOString() });
      runtime.handleServerMessage({ type: "reminder.upsert", agentId: AGENT_B, reminder: job });
      clock.advanceBy(5);
      await new Promise((resolve) => setImmediate(resolve));
      const request = sent.find((message): message is Extract<MachineToServerMessage, { type: "reminder.fire_request" }> =>
        message.type === "reminder.fire_request"
      );
      assert.ok(request);
      runtime.handleServerMessage({
        type: "reminder.fire_request.result",
        agentId: AGENT_A,
        reminderId: request.reminderId,
        version: request.version,
        requestId: request.requestId,
        outcome: "accepted",
        fired: true,
        catchup: false,
      });
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(wakes, []);
      assert.equal(sent.filter((message) => message.type === "reminder.fire_request").length, 1);
    },
  },
];

test("owner envelope scenario matrix exhausts the closed stateful Reminder ingress inventory", () => {
  assert.deepEqual(
    ownerEnvelopeCases.map((scenario) => scenario.type).sort(),
    Object.keys(REMINDER_OWNER_FENCE_KINDS).sort(),
  );
});

for (const scenario of ownerEnvelopeCases) {
  test(`owner envelope fence: ${scenario.name}`, async () => {
    const harness = createHarness();
    try {
      await scenario.run(harness);
    } finally {
      harness.cleanup();
    }
  });
}

test("equal-version owner transfer waits for the old cancel before acknowledging a new-owner upsert", () => {
  const harness = createHarness();
  try {
    const oldOwnerJob = makeJob({ ownerAgentId: AGENT_A });
    const newOwnerJob = makeJob({ ownerAgentId: AGENT_B });
    harness.runtime.handleServerMessage({
      type: "reminder.upsert",
      agentId: AGENT_A,
      reminder: oldOwnerJob,
    });
    harness.sent.length = 0;

    harness.runtime.handleServerMessage({
      type: "reminder.upsert",
      agentId: AGENT_B,
      reminder: newOwnerJob,
    });
    assert.deepEqual(harness.sent, [], "the old owner's live timer is not arm evidence for the new owner");

    harness.runtime.handleServerMessage({
      type: "reminder.cancel",
      agentId: AGENT_A,
      reminderId: oldOwnerJob.reminderId,
      version: oldOwnerJob.version,
    });
    harness.runtime.handleServerMessage({
      type: "reminder.upsert",
      agentId: AGENT_B,
      reminder: newOwnerJob,
    });
    assert.deepEqual(harness.sent.map(({ type, agentId }) => ({ type, agentId })), [
      { type: "reminder.armed", agentId: AGENT_B },
    ]);
  } finally {
    harness.cleanup();
  }
});

test("equal-version owner transfer waits for the old cancel before acknowledging a new-owner snapshot", () => {
  const harness = createHarness();
  try {
    const oldOwnerJob = makeJob({ ownerAgentId: AGENT_A });
    const newOwnerJob = makeJob({ ownerAgentId: AGENT_B });
    harness.runtime.handleServerMessage({
      type: "reminder.upsert",
      agentId: AGENT_A,
      reminder: oldOwnerJob,
    });
    harness.sent.length = 0;

    harness.runtime.handleServerMessage({
      type: "reminder.snapshot",
      agentId: AGENT_B,
      reminders: [newOwnerJob],
    });
    assert.deepEqual(harness.sent, [], "an owner-conflicted snapshot is stale, not invalid-fire rejection");

    harness.runtime.handleServerMessage({
      type: "reminder.cancel",
      agentId: AGENT_A,
      reminderId: oldOwnerJob.reminderId,
      version: oldOwnerJob.version,
    });
    harness.runtime.handleServerMessage({
      type: "reminder.snapshot",
      agentId: AGENT_B,
      reminders: [newOwnerJob],
    });
    assert.deepEqual(harness.sent.map(({ type, agentId }) => ({ type, agentId })), [
      { type: "reminder.armed", agentId: AGENT_B },
    ]);
  } finally {
    harness.cleanup();
  }
});

test("production beforeAck forwards the per-agent owner into local receipt consumption", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "reminder-runtime-before-ack-"));
  const reminderId = "77777777-7777-4777-8777-777777777777";
  const clock = new FakeClock();
  const sent: MachineToServerMessage[] = [];
  const traces: Array<{ name: string; attrs: Record<string, unknown> }> = [];
  const inboxes = new Map<string, AgentAppInboxStore>();
  const getInbox = (agentId: string) => {
    let inbox = inboxes.get(agentId);
    if (!inbox) {
      inbox = createAgentAppInboxStore({ registry: REMINDER_AGENT_INBOX_REGISTRY });
      inboxes.set(agentId, inbox);
    }
    return inbox;
  };
  const storageFactory = createScopedAppStorageFactory({
    slockHome: root,
    owner: { machineId: "machine-test", serverId: "server-test" },
  });
  const makeRuntime = () => {
    const runtime = createReminderRuntime({
      clock,
      getInbox,
      notifyInbox: async () => true,
      send: (message) => sent.push(message),
      trace: (name, attrs) => traces.push({ name, attrs }),
    });
    runtime.bindStorageProvider((agentId) =>
      storageFactory.open({ appId: "system.reminder", agentId })
    );
    return runtime;
  };
  let runtime = makeRuntime();
  try {
    runtime.start();
    for (const agentId of [AGENT_A, AGENT_B]) {
      runtime.handleServerMessage({ type: "reminder.snapshot", agentId, reminders: [] });
    }
    sent.length = 0;
    runtime.handleServerMessage({
      type: "reminder.upsert",
      agentId: AGENT_A,
      reminder: makeJob({
        reminderId,
        ownerAgentId: AGENT_A,
        fireAt: new Date(5).toISOString(),
      }),
    });
    clock.advanceBy(5);
    await new Promise((resolve) => setImmediate(resolve));
    const oldRequest = findLatestRequest(sent, AGENT_A);
    assert.ok(oldRequest);
    runtime.handleServerMessage({
      type: "reminder.fire_request.result",
      agentId: AGENT_A,
      reminderId,
      version: oldRequest.version,
      requestId: oldRequest.requestId,
      outcome: "accepted",
      fired: true,
      catchup: false,
    });
    await new Promise((resolve) => setImmediate(resolve));

    runtime.handleServerMessage({
      type: "reminder.upsert",
      agentId: AGENT_B,
      reminder: makeJob({
        reminderId,
        ownerAgentId: AGENT_B,
        fireAt: new Date(10).toISOString(),
      }),
    });
    clock.advanceBy(5);
    await new Promise((resolve) => setImmediate(resolve));
    const newRequest = findLatestRequest(sent, AGENT_B);
    assert.ok(newRequest);
    runtime.handleServerMessage({
      type: "reminder.fire_request.result",
      agentId: AGENT_B,
      reminderId,
      version: newRequest.version,
      requestId: newRequest.requestId,
      outcome: "accepted",
      fired: true,
      catchup: false,
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(
      [AGENT_A, AGENT_B].map((agentId) => getInbox(agentId).list().length),
      [1, 1],
      "both owners materialize the same wire item identity in separate stores",
    );
    const [newOwnerItem] = getInbox(AGENT_B).list();
    assert.ok(newOwnerItem);

    // This is the production seam Core calls before its per-agent store ACK.
    runtime.beforeAck(AGENT_B, newOwnerItem);
    assert.equal(getInbox(AGENT_B).ack(newOwnerItem.itemId), true);
    runtime.stop();

    traces.length = 0;
    runtime = makeRuntime();
    runtime.start();
    for (const agentId of [AGENT_A, AGENT_B]) {
      runtime.handleServerMessage({ type: "reminder.snapshot", agentId, reminders: [] });
    }
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
      [AGENT_A, AGENT_B].map((agentId) => getInbox(agentId).list().length),
      [1, 0],
      "restart rematerializes only the unconsumed old-owner receipt",
    );
    assert.equal(
      traces.some((trace) => trace.name === "daemon.app_schedule.occurrence"),
      false,
      "recovery may use durable phase state but must not backfill phase timestamps",
    );
  } finally {
    runtime.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("agent-start fallback requests a snapshot only for unsynchronized owners", () => {
  const harness = createHarness({ synchronize: false });
  try {
    const countRequests = (agentId: string) =>
      harness.sent.filter((message) =>
        message.type === "reminder.snapshot.request" && message.agentId === agentId
      ).length;

    // Unsynchronized owner: the fallback fires exactly once.
    assert.equal(harness.runtime.requestSnapshotIfUnsynchronized(AGENT_B), true);
    assert.equal(countRequests(AGENT_B), 1);

    // In-flight guard: a second start before the snapshot arrives is a no-op.
    assert.equal(harness.runtime.requestSnapshotIfUnsynchronized(AGENT_B), false);
    assert.equal(countRequests(AGENT_B), 1);

    // Once the authoritative snapshot lands, the owner is synchronized and
    // later starts must not re-request.
    harness.runtime.handleServerMessage({
      type: "reminder.snapshot",
      agentId: AGENT_B,
      reminders: [],
    });
    assert.equal(harness.runtime.requestSnapshotIfUnsynchronized(AGENT_B), false);
    assert.equal(countRequests(AGENT_B), 1);

    // Independent owners do not share the guard.
    assert.equal(harness.runtime.requestSnapshotIfUnsynchronized(AGENT_A), true);
    assert.equal(countRequests(AGENT_A), 1);
  } finally {
    harness.cleanup();
  }
});
