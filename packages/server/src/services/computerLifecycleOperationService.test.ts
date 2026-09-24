import assert from "node:assert/strict";
import { dbTest as test } from "../test/integration/dbTest.js";
import { eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { closeTestDatabase, openTestDatabase } from "../test/integration/database.js";
import {
  agentActivityEvents,
  agents,
  computerLifecycleDispatches,
  computerLifecycleOperationTargets,
  computerLifecycleOperations,
  computers,
  machines,
  servers,
  users,
} from "../db/schema.js";
import {
  createUserComputerLifecycleOperation,
  expirePendingComputerLifecycleOperations,
  claimPendingComputerLifecycleDispatches,
  observeComputerLifecycleAck,
  observeComputerLifecycleDisconnect,
  releaseComputerLifecycleDispatchLease,
  projectTerminalComputerLifecycleActivity,
  reduceComputerLifecycleTerminal,
  resolveComputerLifecycleOperationId,
} from "./computerLifecycleOperationService.js";

const now = new Date("2026-07-10T00:00:00Z");

function isUniqueConstraintFailure(error: unknown): boolean {
  const cause = error instanceof Error && "cause" in error ? String(error.cause) : "";
  return /unique constraint/i.test(`${String(error)} ${cause}`);
}

function operation(overrides: Partial<Parameters<typeof reduceComputerLifecycleTerminal>[0]>) {
  return {
    action: "restart" as const,
    dispatchMode: "local" as const,
    shutdownAckAt: null,
    disconnectedAt: null,
    readyAckAt: null,
    connectionEpochBefore: "epoch-old",
    readyConnectionEpoch: null,
    targetVersion: null,
    loadedComputerVersion: null,
    broadcastPolicyDecision: null,
    ...overrides,
  };
}

test("mixed-version acknowledgement aliases resolve to one canonical operation", () => {
  assert.equal(resolveComputerLifecycleOperationId({ operationId: "op-1" }), "op-1");
  assert.equal(resolveComputerLifecycleOperationId({ requestId: "op-1" }), "op-1");
  assert.equal(resolveComputerLifecycleOperationId({ operationId: "op-1", requestId: "op-1" }), "op-1");
  assert.equal(resolveComputerLifecycleOperationId({ operationId: "op-1", requestId: "op-2" }), null);
});

test("restart closes only after shutdown ack, old close, and ready on a new epoch", () => {
  assert.equal(reduceComputerLifecycleTerminal(operation({ shutdownAckAt: now, disconnectedAt: now })), null);
  assert.equal(reduceComputerLifecycleTerminal(operation({
    shutdownAckAt: now,
    disconnectedAt: now,
    readyAckAt: now,
    readyConnectionEpoch: "epoch-old",
  })), null);
  assert.deepEqual(reduceComputerLifecycleTerminal(operation({
    shutdownAckAt: now,
    disconnectedAt: now,
    readyAckAt: now,
    readyConnectionEpoch: "epoch-new",
  })), { terminal: "completed", reason: null });
});

test("upgrade refuses completed action copy when loaded version misses the intent target", () => {
  assert.equal(reduceComputerLifecycleTerminal(operation({
    action: "upgrade",
    shutdownAckAt: now,
    disconnectedAt: now,
    readyAckAt: now,
    readyConnectionEpoch: "epoch-new",
    targetVersion: "0.72.6",
    loadedComputerVersion: "0.0.0-dev",
  })), null);

  const projection = projectTerminalComputerLifecycleActivity({
    operationId: "op-1",
    serverId: "server-1",
    machineId: "machine-1",
    action: "upgrade",
    actorUserId: "user-1",
    terminal: "failed",
    terminalReason: "loaded_version_mismatch",
  }, "agent-1");
  assert.equal(projection.activity, "error");
  assert.equal(projection.detailKind, "computer_operation_failed");
});

test("legacy K completion closes only from exact shutdown+ready on its accepted live generation", () => {
  const completion = {
    completionMode: "legacy_k_promoted",
    connectionEpoch: "epoch-current",
    sourceVersion: "0.72.5",
    sourceObservedAt: now.toISOString(),
    sourceProvenance: "owner_connection",
  };
  assert.equal(reduceComputerLifecycleTerminal(operation({
    action: "upgrade",
    shutdownAckAt: now,
    readyAckAt: now,
    readyConnectionEpoch: "epoch-replaced",
    targetVersion: "0.72.5",
    loadedComputerVersion: "0.72.5",
    broadcastPolicyDecision: completion,
  })), null);
  assert.deepEqual(reduceComputerLifecycleTerminal(operation({
    action: "upgrade",
    shutdownAckAt: now,
    readyAckAt: now,
    readyConnectionEpoch: "epoch-current",
    targetVersion: "0.72.5",
    loadedComputerVersion: "0.72.5",
    broadcastPolicyDecision: completion,
  })), { terminal: "completed", reason: null });
});

test("schema serializes pending U by Server machine and binds exactly one D child", async () => {
  await openTestDatabase("pglite://:memory:");
  try {
    const db = getDb();
    const [user] = await db.insert(users).values({
      email: "computer-dispatch-schema@example.com",
      name: "dispatch-schema-operator",
      passwordHash: "test",
    }).returning();
    const [server] = await db.insert(servers).values({
      name: "dispatch-schema",
      slug: "dispatch-schema",
      ownerId: user!.id,
    }).returning();
    const machineId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const computerId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const firstOperationId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const secondOperationId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const operation = (id: string, action: "restart" | "upgrade") => ({
      id,
      serverId: server!.id,
      computerId,
      machineId,
      action,
      cause: "user_action" as const,
      actorUserId: user!.id,
      dispatchMode: "server" as const,
    });

    await db.insert(computerLifecycleOperations).values(operation(firstOperationId, "restart"));
    await assert.rejects(
      db.insert(computerLifecycleOperations).values(operation(secondOperationId, "upgrade")),
      isUniqueConstraintFailure,
      "the DB, not a route pre-check, must reject a second pending U of another action",
    );

    await db.insert(computerLifecycleDispatches).values({
      id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      parentOperationId: firstOperationId,
      dispatchAction: "upgrade",
      targetVersion: "0.72.9",
      adapter: "upgrade_to_0729",
      originServerId: server!.id,
      machineId,
      phaseDeadlineAt: new Date("2026-07-13T00:15:00.000Z"),
    });
    await assert.rejects(
      db.insert(computerLifecycleDispatches).values({
        id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        parentOperationId: firstOperationId,
        dispatchAction: "restart",
        targetVersion: "0.72.9",
        adapter: "supervisor_native",
        originServerId: server!.id,
        machineId,
        phaseDeadlineAt: new Date("2026-07-13T00:15:00.000Z"),
      }),
      isUniqueConstraintFailure,
      "one U must have exactly one immutable D child",
    );

    await db.update(computerLifecycleOperations).set({
      status: "completed",
      terminalAt: new Date("2026-07-13T00:01:00.000Z"),
    }).where(eq(computerLifecycleOperations.id, firstOperationId));
    await db.insert(computerLifecycleOperations).values(operation(secondOperationId, "upgrade"));
  } finally {
    await closeTestDatabase();
  }
});

test("legacy ready replay cannot satisfy a backfilled dispatch's machine-attestation contract", async () => {
  await openTestDatabase("pglite://:memory:");
  try {
    const db = getDb();
    const [user] = await db.insert(users).values({
      email: "legacy-ready-replay@example.com",
      name: "legacy-ready-replay",
      passwordHash: "test",
    }).returning();
    const [server] = await db.insert(servers).values({
      name: "legacy-ready-replay",
      slug: "legacy-ready-replay",
      ownerId: user!.id,
    }).returning();
    const operationId = "17171717-1717-4717-8717-171717171717";
    const machineId = "18181818-1818-4818-8818-181818181818";
    await db.insert(computerLifecycleOperations).values({
      id: operationId,
      serverId: server!.id,
      computerId: "19191919-1919-4919-8919-191919191919",
      machineId,
      action: "upgrade",
      cause: "user_action",
      actorUserId: user!.id,
      status: "pending",
      dispatchMode: "server",
      dispatchStatus: "sent",
      targetVersion: "0.72.9",
    });
    await db.insert(computerLifecycleDispatches).values({
      id: operationId,
      parentOperationId: operationId,
      dispatchAction: "upgrade",
      targetVersion: "0.72.9",
      adapter: "legacy_pending_server_operation_v1",
      originServerId: server!.id,
      machineId,
      phaseDeadlineAt: new Date("2026-07-13T00:15:00.000Z"),
    });

    const replay = await observeComputerLifecycleAck({
      serverId: server!.id,
      machineId,
      connectionEpoch: "legacy-ready-epoch",
      acknowledgement: {
        requestId: operationId,
        action: "upgrade",
        phase: "ready",
        loadedComputerVersion: "0.72.9",
      },
    });
    assert.deepEqual(replay, { status: "rejected" });

    const [operationAfterReplay] = await db.select().from(computerLifecycleOperations)
      .where(eq(computerLifecycleOperations.id, operationId));
    const [dispatchAfterReplay] = await db.select().from(computerLifecycleDispatches)
      .where(eq(computerLifecycleDispatches.id, operationId));
    assert.equal(operationAfterReplay?.status, "pending");
    assert.equal(operationAfterReplay?.terminalAt, null);
    assert.equal(dispatchAfterReplay?.phase, "accepted");
    assert.equal(dispatchAfterReplay?.terminalAt, null);
  } finally {
    await closeTestDatabase();
  }
});

test("terminal projection uses the intent snapshot, skips moved targets, and dedupes replay", async () => {
  await openTestDatabase("pglite://:memory:");
  try {
    const db = getDb();
    const [user] = await db.insert(users).values({
      email: "computer-operation@example.com",
      name: "operator",
      passwordHash: "test",
    }).returning();
    const [server] = await db.insert(servers).values({
      name: "operation-test",
      slug: "operation-test",
      ownerId: user!.id,
    }).returning();
    const [machine, movedMachine] = await db.insert(machines).values([
      { serverId: server!.id, userId: user!.id, name: "source", apiKeyHash: "hash-a" },
      { serverId: server!.id, userId: user!.id, name: "target", apiKeyHash: "hash-b" },
    ]).returning();
    await db.insert(computers).values({
      serverId: server!.id,
      name: "Computer",
      apiKeyHash: "computer-hash",
      apiKeyPrefix: "sk_computer_test",
      machineId: machine!.id,
      attachedByUserId: user!.id,
    });
    const [stableAgent, movedAgent, deletedAgent] = await db.insert(agents).values([
      { serverId: server!.id, name: "kimi", runtime: "kimi", machineId: machine!.id },
      { serverId: server!.id, name: "moved", machineId: machine!.id },
      { serverId: server!.id, name: "deleted", machineId: machine!.id },
    ]).returning();
    const operationId = "33333333-3333-4333-8333-333333333333";
    const created = await createUserComputerLifecycleOperation({
      operationId,
      serverId: server!.id,
      machineId: machine!.id,
      actorUserId: user!.id,
      action: "restart",
      dispatchMode: "server",
      connectionEpochBefore: "epoch-old",
      broadcastPolicyDecision: {
        policyRevision: "policy-v1",
        decision: "eligible",
      },
      dispatch: {
        action: "restart",
        targetVersion: "0.72.9",
        adapter: "supervisor_native",
      },
    });
    assert.equal(created?.operationId, operationId);
    assert.ok(created?.dispatch);
    const dispatchOperationId = created.dispatch.operationId;

    const concurrentClaims = await Promise.all([
      claimPendingComputerLifecycleDispatches([machine!.id], 1),
      claimPendingComputerLifecycleDispatches([machine!.id], 1),
    ]);
    assert.deepEqual(concurrentClaims.flat(), [{
      operationId: dispatchOperationId,
      parentOperationId: operationId,
      serverId: server!.id,
      machineId: machine!.id,
      action: "restart",
      targetVersion: "0.72.9",
      broadcastPolicyDecision: {
        policyRevision: "policy-v1",
        decision: "eligible",
      },
    }]);
    await releaseComputerLifecycleDispatchLease(dispatchOperationId);
    assert.deepEqual(
      (await claimPendingComputerLifecycleDispatches([machine!.id], 1)).map((claim) => claim.operationId),
      [dispatchOperationId],
    );

    await db.update(agents).set({ machineId: movedMachine!.id }).where(eq(agents.id, movedAgent!.id));
    await db.update(agents).set({ deletedAt: now }).where(eq(agents.id, deletedAgent!.id));
    await observeComputerLifecycleAck({
      serverId: server!.id,
      machineId: machine!.id,
      connectionEpoch: "epoch-old",
      acknowledgement: { requestId: dispatchOperationId, action: "restart", phase: "shutdown" },
    });
    await observeComputerLifecycleDisconnect({
      serverId: server!.id,
      machineId: machine!.id,
      connectionEpoch: "epoch-old",
    });
    const readyInput = {
      serverId: server!.id,
      machineId: machine!.id,
      connectionEpoch: "epoch-new",
      acknowledgement: {
        operationId: dispatchOperationId,
        requestId: dispatchOperationId,
        action: "restart" as const,
        phase: "ready" as const,
        loadedComputerVersion: "0.72.9",
        serviceGeneration: "generation-new",
        managedSetRevision: "revision-new",
        oldProcessIdentitiesDead: true,
        deadProcessIdentities: ["service:old"],
      },
    };
    const concurrentReady = await Promise.all([
      observeComputerLifecycleAck(readyInput),
      observeComputerLifecycleAck(readyInput),
    ]);
    assert.equal(concurrentReady.filter((result) => result.status === "terminal").length, 1);
    assert.equal(concurrentReady.filter((result) => result.status === "late_after_terminal").length, 1);
    const terminal = concurrentReady.find((result) => result.status === "terminal");
    assert.ok(terminal && terminal.status === "terminal");
    assert.deepEqual(terminal.projections.map((projection) => projection.agentId), [stableAgent!.id]);
    const history = await db.select().from(agentActivityEvents).where(eq(agentActivityEvents.dedupeKey,
      `computer-operation:${server!.id}:${machine!.id}:${operationId}:completed`));
    assert.equal(history.length, 1);
    assert.equal(history[0]?.agentId, stableAgent!.id);
    const targets = await db.select().from(computerLifecycleOperationTargets).where(eq(
      computerLifecycleOperationTargets.operationId,
      operationId,
    ));
    assert.deepEqual(new Map(targets.map((target) => [target.agentId, target.projectionStatus])), new Map([
      [stableAgent!.id, "projected"],
      [movedAgent!.id, "skipped"],
      [deletedAgent!.id, "skipped"],
    ]));
    assert.equal(targets.find((target) => target.agentId === movedAgent!.id)?.projectionSkipReason, "no_longer_member");
    assert.equal(targets.find((target) => target.agentId === deletedAgent!.id)?.projectionSkipReason, "target_missing");

    const timeoutOperationId = "44444444-4444-4444-8444-444444444444";
    await createUserComputerLifecycleOperation({
      operationId: timeoutOperationId,
      serverId: server!.id,
      machineId: machine!.id,
      actorUserId: user!.id,
      action: "start",
      dispatchMode: "local",
    });
    await db.update(computerLifecycleOperations).set({ readyDeadlineAt: new Date(0) }).where(eq(
      computerLifecycleOperations.id,
      timeoutOperationId,
    ));
    const [readyRace, expired] = await Promise.all([
      observeComputerLifecycleAck({
        serverId: server!.id,
        machineId: machine!.id,
        connectionEpoch: "epoch-start",
        acknowledgement: { operationId: timeoutOperationId, action: "start", phase: "ready" },
      }),
      expirePendingComputerLifecycleOperations(),
    ]);
    const raceResults = [readyRace, ...expired].filter((result) =>
      result.status === "terminal"
        ? result.fact.operationId === timeoutOperationId
        : result.status !== "rejected" && result.operationId === timeoutOperationId
    );
    assert.equal(raceResults.filter((result) => result.status === "terminal").length, 1);
    assert.ok(raceResults.every((result) => result.status === "terminal" || result.status === "late_after_terminal"));
    const allHistory = await db.select().from(agentActivityEvents).where(eq(agentActivityEvents.agentId, stableAgent!.id));
    assert.equal(allHistory.length, 2, "ack+sweep competition must project the timeout operation once");
  } finally {
    await closeTestDatabase();
  }
});
