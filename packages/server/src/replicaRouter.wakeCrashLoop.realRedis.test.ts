// Real-Redis teeth for the wake crash-loop breaker store (RFC 071 F1).
// The Redis store wrote the whole episode as JSON, but the decoder rebuilt it
// without the task #1221 fields, so the catch-up obligation and the
// needs-action reason read back as absent after any write. Only the in-memory
// store round-tripped them, and that is the store every other test uses.
// Gated like the probe-relay real-Redis suite: CI runs it in the
// probe-concurrency job with a Redis service; local runs need
// WAKE_CRASH_LOOP_REAL_REDIS_URL.
import assert from "node:assert/strict";
import { getRedis, getRedisPub, getRedisReplicaSub, getRedisSub, initRedis } from "./redis";
import {
  compareAndSetWakeCrashLoopState,
  getAgentActivities,
  getAgentActivity,
  getAgentRuntimeError,
  getAgentRuntimeErrors,
  getMachineDuplicateHold,
  getMachineReplicaLease,
  setMachineDuplicateHold,
  setMachineReplicaInstance,
  touchMachineDuplicateHold,
  getMachineReplicaOwner,
  getMachineReplicaOwners,
  getWakeCrashLoopState,
  refreshMachineReplica,
  registerMachineReplica,
  setAgentActivity,
  setAgentRuntimeError,
  unregisterMachineReplica,
} from "./replicaRouter";
import { redisAgentContextViewRequestStore, redisReplicaStateStore, type AgentContextViewRequestRecord } from "./services/replicaStateStore";
import { asMachineId, mintAgentContextViewRequestId } from "@botiverse/raft-shared";
import { WakeCrashLoopBreaker, type WakeCrashLoopEpisodeState } from "./services/wakeCrashLoopBreaker";

const REAL_REDIS_URL = process.env.WAKE_CRASH_LOOP_REAL_REDIS_URL;
const REAL_REDIS_REQUIRED = process.env.WAKE_CRASH_LOOP_REAL_REDIS_REQUIRED === "1";

function skipUnlessRealRedis(): boolean {
  if (REAL_REDIS_URL) return false;
  if (REAL_REDIS_REQUIRED) throw new Error("WAKE_CRASH_LOOP_REAL_REDIS_REQUIRED=1 but WAKE_CRASH_LOOP_REAL_REDIS_URL is unset");
  return true;
}

const agentIds: string[] = [];
function freshAgentId(): string {
  const id = `f1-wake-crash-loop-${Math.random().toString(36).slice(2)}`;
  agentIds.push(id);
  return id;
}

beforeAll(() => {
  if (REAL_REDIS_URL) initRedis(REAL_REDIS_URL);
});

afterAll(async () => {
  if (!REAL_REDIS_URL) return;
  for (const id of agentIds) {
    await getRedis().del(`slock:agent:${id}:wake_crash_loop`, `slock:agent:${id}:activity`, `slock:agent:${id}:runtime_error`);
  }
  for (const client of [getRedis(), getRedisPub(), getRedisSub(), getRedisReplicaSub()]) client.disconnect();
});

test("real Redis: every episode field written through the store reads back equal", async () => {
  if (skipUnlessRealRedis()) return;
  const agentId = freshAgentId();
  const state: Required<WakeCrashLoopEpisodeState> = {
    episode: 4,
    earlyExitCount: 2,
    blocked: true,
    blockedAtMs: 1_700_000_003_000,
    lastStartAtMs: 1_700_000_000_000,
    lastStartLaunchId: "launch-2",
    lastStartCounted: true,
    firstExitAtMs: 1_700_000_001_000,
    lastExitAtMs: 1_700_000_002_000,
    lastExitKind: "machine_disconnected",
    lastSignal: "SIGKILL",
    lastLaunchId: "launch-2",
    needsActionReason: "model_not_configured",
    catchupOwed: true,
    catchupCarriedLaunchId: "launch-3",
    startFailureCount: 3,
    lastStartFailureReason: "model_not_found",
    lastStartFailureLaunchId: "launch-2",
    retryAfterMs: 1_700_000_004_000,
    startFailureOwnedLaunchId: "launch-owned",
    blockedByLaunchId: "launch-blocker",
    actionRequiredNotifiedFingerprint: "0123456789abcdef",
    pauseRetryAtMs: 1_700_001_800_000,
    pauseRetryCooldownMs: 1_800_000,
    pauseRetryLaunchId: "launch-try",
    pauseRetryReadyLaunchId: "launch-ready-try",
    pauseRetryReadyCooldownMs: 3_600_000,
    pauseRetryCapNotified: true,
  };
  assert.equal(await compareAndSetWakeCrashLoopState(agentId, 0, state), true);
  assert.deepEqual(await getWakeCrashLoopState(agentId), { state, version: 1 });
});

test("real Redis: the task #1221 catch-up obligation survives the store and clears only on the carrying start", async () => {
  if (skipUnlessRealRedis()) return;
  const agentId = freshAgentId();
  const breaker = new WakeCrashLoopBreaker(redisReplicaStateStore);
  await breaker.recordStart(agentId, "launch-1", 1_000);
  assert.equal((await breaker.recordStartFailure(agentId, { launchId: "launch-1", reason: "model_not_configured", nowMs: 1_100 })).outcome === "blocked", true);
  assert.equal(await breaker.isBlocked(agentId), true);
  assert.equal(await breaker.isCatchupOwed(agentId), true, "the owed catch-up must be read back from Redis");
  assert.equal((await getWakeCrashLoopState(agentId))?.state.needsActionReason, "model_not_configured");

  // A person restarts: the block lifts, the catch-up stays owed and is carried by this start.
  await breaker.recordStart(agentId, "launch-2", 2_000, { human: true });
  assert.equal(await breaker.isCatchupOwed(agentId), true);
  await breaker.markCatchupCarried(agentId, "launch-2");
  assert.equal((await getWakeCrashLoopState(agentId))?.state.catchupCarriedLaunchId, "launch-2");
  assert.equal(await breaker.confirmCatchupDelivered(agentId, "launch-other"), false);
  assert.equal(await breaker.confirmCatchupDelivered(agentId, "launch-2"), true, "the carrying start's active report clears the obligation");
  assert.equal(await breaker.isCatchupOwed(agentId), false);
});

test("real Redis: the agent-list batch reads equal the one-key reads (activity, runtime error, machine owner)", async () => {
  if (skipUnlessRealRedis()) return;
  const withActivity = freshAgentId();
  const withError = freshAgentId();
  const empty = freshAgentId();
  await setAgentActivity(withActivity, "working", "Running tests", "other" as never, 1_700_000_000_000);
  await setAgentRuntimeError(withError, { message: "usage limit", at: new Date(0).toISOString(), actionRequired: true });
  const machine = `f1-batch-machine-${Math.random().toString(36).slice(2)}`;
  const generation = await registerMachineReplica(machine);
  try {
    const ids = [withActivity, withError, empty];
    const activities = await getAgentActivities(ids);
    const errors = await getAgentRuntimeErrors(ids);
    const owners = await getMachineReplicaOwners([machine, `${machine}-absent`]);
    for (const id of ids) {
      assert.deepEqual(activities.get(id), await getAgentActivity(id), `activity ${id}`);
      assert.deepEqual(errors.get(id), await getAgentRuntimeError(id), `runtime error ${id}`);
    }
    assert.ok(activities.get(withActivity), "the written activity is read back");
    assert.ok(errors.get(withError)?.error, "the written runtime error is read back");
    assert.equal(owners.get(machine), await getMachineReplicaOwner(machine));
    assert.ok(owners.get(machine));
    assert.equal(owners.get(`${machine}-absent`), null);
  } finally {
    await unregisterMachineReplica(machine, generation);
  }
});

test("real Redis: task #440 the owner lease refresh reports what it did instead of returning nothing", async () => {
  if (skipUnlessRealRedis()) return;
  const machine = `f1-refresh-machine-${Math.random().toString(36).slice(2)}`;
  const generation = await registerMachineReplica(machine);
  try {
    assert.equal(await refreshMachineReplica(machine, undefined, generation), "refreshed");
    assert.equal(await refreshMachineReplica(machine, undefined, "older-generation"), "rejected_other_lease");
    assert.equal(await refreshMachineReplica(machine, undefined, undefined), "skipped_no_generation");

    // Owner gone but the generation left behind: refused until it expires.
    await getRedis().del(`slock:machine:${machine}:replica`);
    assert.equal(await refreshMachineReplica(machine, undefined, generation), "rejected_residual_generation");
    assert.equal(await getMachineReplicaOwner(machine), null);

    // Owner and generation both gone (an exact-snapshot clear): the live
    // holder's next refresh writes the lease back.
    await getRedis().del(`slock:machine:${machine}:replica_generation`);
    assert.equal(await refreshMachineReplica(machine, undefined, generation), "refreshed");
    assert.ok(await getMachineReplicaOwner(machine));
  } finally {
    await unregisterMachineReplica(machine, generation);
  }
});

test("real Redis: task #374 the owner lease read returns the holder and its renewal time, and null fields once gone", async () => {
  if (skipUnlessRealRedis()) return;
  const machine = `f1-lease-machine-${Math.random().toString(36).slice(2)}`;
  const before = Date.now();
  const generation = await registerMachineReplica(machine);
  try {
    const lease = await getMachineReplicaLease(machine);
    assert.equal(lease?.replicaId, await getMachineReplicaOwner(machine));
    assert.ok(lease?.replicaId, "the holder is the replica that registered");
    assert.equal(lease?.generation, generation, "the generation is the registered one");
    assert.ok(lease?.updatedAtMs !== null && lease!.updatedAtMs! >= before, "updated_at is the registration time");

    // A refresh renews the lease, so updated_at must move forward.
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(await refreshMachineReplica(machine, undefined, generation), "refreshed");
    const renewed = await getMachineReplicaLease(machine);
    assert.ok(renewed!.updatedAtMs! > lease!.updatedAtMs!, "a refresh advances updated_at");

    await getRedis().del(
      `slock:machine:${machine}:replica`,
      `slock:machine:${machine}:replica_generation`,
      `slock:machine:${machine}:replica_updated_at`,
    );
    assert.deepEqual(await getMachineReplicaLease(machine), { replicaId: null, generation: null, updatedAtMs: null, instance: null });
  } finally {
    await unregisterMachineReplica(machine, generation);
  }
});

test("real Redis: task #374 the duplicate hold round-trips, expires on its TTL and is extended by touch", async () => {
  if (skipUnlessRealRedis()) return;
  const machine = `f1-hold-machine-${Math.random().toString(36).slice(2)}`;
  const key = `slock:machine:${machine}:duplicate_hold`;
  try {
    assert.equal(await getMachineDuplicateHold(machine), null, "no hold before a decision");
    await setMachineDuplicateHold(machine, { replicaId: "replica-a", generation: "gen-1", closedDaemonVersion: "1.0.25" }, 600);
    assert.deepEqual(await getMachineDuplicateHold(machine), { replicaId: "replica-a", generation: "gen-1", closedDaemonVersion: "1.0.25" });
    const ttl = await getRedis().ttl(key);
    assert.ok(ttl > 590 && ttl <= 600, `TTL is the hold window (${ttl})`);
    await getRedis().expire(key, 5);
    await touchMachineDuplicateHold(machine, 600);
    assert.ok((await getRedis().ttl(key)) > 590, "touch extends the hold");
    await getRedis().set(key, "not json", "EX", 60);
    assert.equal(await getMachineDuplicateHold(machine), null, "a corrupt record does not block anyone");
  } finally {
    await getRedis().del(key);
  }
});

test("real Redis: task #374 the holder's daemon identity is returned only for the lease's current generation", async () => {
  if (skipUnlessRealRedis()) return;
  const machine = `f1-instance-machine-${Math.random().toString(36).slice(2)}`;
  const generation = await registerMachineReplica(machine);
  try {
    assert.equal((await getMachineReplicaLease(machine))?.instance, null, "nothing published yet");
    await setMachineReplicaInstance(machine, { generation, daemonInstanceId: "inst-1", daemonVersion: "1.0.45", reportedHostnameHash: "0123456789ab" });
    assert.deepEqual((await getMachineReplicaLease(machine))?.instance, {
      generation,
      daemonInstanceId: "inst-1",
      daemonVersion: "1.0.45",
      reportedHostnameHash: "0123456789ab",
    });
    await setMachineReplicaInstance(machine, { generation: "older-generation", daemonInstanceId: "inst-0", daemonVersion: "1.0.4" });
    assert.equal((await getMachineReplicaLease(machine))?.instance, null, "a record from another generation does not describe this lease");
  } finally {
    await getRedis().del(`slock:machine:${machine}:replica_instance`);
    await unregisterMachineReplica(machine, generation);
  }
});

test("real Redis: a View Context request record round-trips branded, is claimed once and only by its Computer", async () => {
  if (skipUnlessRealRedis()) return;
  const store = redisAgentContextViewRequestStore;
  const record: AgentContextViewRequestRecord = {
    requestId: mintAgentContextViewRequestId(),
    viewerUserId: "viewer-1",
    agentId: "agent-1",
    serverId: "server-1",
    messageId: "message-1",
    machineId: asMachineId(`machine-${Math.random().toString(36).slice(2)}`),
    viewerReplicaId: "replica-a",
    viewerEndpoint: null,
    createdAt: new Date().toISOString(),
  };
  const keys = [`slock:context-view:${record.requestId}`, `slock:context-view:${record.requestId}:claimed`];
  try {
    await store.create(record, 5_000);
    assert.deepEqual(await store.get(record.requestId), { record, claimed: false });
    assert.deepEqual(await store.claim(record.requestId, asMachineId("another-machine"), 5_000), { kind: "wrong_computer" });
    assert.deepEqual(await store.claim(record.requestId, record.machineId, 5_000), { kind: "claimed", record });
    assert.deepEqual(await store.claim(record.requestId, record.machineId, 5_000), { kind: "already_claimed" });
    assert.deepEqual(await store.get(record.requestId), { record, claimed: true });
    assert.deepEqual(await store.claim(mintAgentContextViewRequestId(), record.machineId, 5_000), { kind: "unknown" });
    // A stored record whose id is not a request id reads as unknown.
    await getRedis().set(keys[0]!, JSON.stringify({ ...record, requestId: "not-a-request-id" }), "PX", 5_000);
    assert.equal(await store.get(record.requestId), null);
  } finally {
    await getRedis().del(...keys);
  }
});
