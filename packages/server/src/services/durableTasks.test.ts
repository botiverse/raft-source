import { dbTest as test } from "../test/integration/dbTest";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { getDb } from "../db/index";
import { durableTasks } from "../db/schema";
import {
  DurableTaskDeferral,
  DurableTaskPermanentError,
  DurableTaskRegistry,
  claimExpiredDurableTasks,
  createDurableTask,
  durableTaskBackoffMs,
  durableTaskKind,
  finishDurableTask,
  pruneDurableTasks,
  runDurableTask,
  type DurableTaskDefinition,
} from "./durableTasks";

type EchoPayload = { value: string };

function echo(
  handle: DurableTaskDefinition<EchoPayload>["handle"] = async () => undefined,
  overrides: Partial<DurableTaskDefinition<EchoPayload>> = {},
): DurableTaskDefinition<EchoPayload> {
  return {
    kind: durableTaskKind("test.echo"),
    payloadVersion: 1,
    decode(payload, version) {
      if (version !== 1) throw new DurableTaskPermanentError("PAYLOAD_VERSION_UNSUPPORTED");
      return payload as EchoPayload;
    },
    handle,
    leaseMs: 30_000,
    maxAttempts: 3,
    ...overrides,
  };
}

async function row(id: number) {
  const [task] = await getDb().select().from(durableTasks).where(eq(durableTasks.id, id));
  return task!;
}

const t0 = new Date("2026-10-01T00:00:00.000Z");

test("a task exists iff its transaction commits, and the inline run completes it", async ({ db }) => {
  const seen: string[] = [];
  const definition = echo(async (payload) => { seen.push(payload.value); });
  const registry = new DurableTaskRegistry().register(definition);

  await assert.rejects(getDb().transaction(async (tx) => {
    await createDurableTask(tx, { definition, payload: { value: "rolled back" }, now: t0 });
    throw new Error("caller rolled back");
  }), /caller rolled back/);
  assert.equal((await getDb().select().from(durableTasks)).length, 0);

  const claim = await getDb().transaction((tx) => createDurableTask(tx, { definition, payload: { value: "a" }, now: t0 }));
  assert.equal(claim.attempt, 1);
  // Recovery leaves an inline-claimed task alone while its lease holds.
  assert.deepEqual(await claimExpiredDurableTasks({ workerId: "r", registry, now: new Date(t0.getTime() + 1_000) }), []);
  assert.equal(await runDurableTask(claim, registry, { clock: () => t0 }), "succeeded");
  assert.deepEqual(seen, ["a"]);
  assert.equal((await row(claim.task.id)).state, "succeeded");
});

test("a lost inline run is recovered after its lease expires, and the late inline writer is fenced", async ({ db }) => {
  const seen: string[] = [];
  const definition = echo(async (payload) => { seen.push(payload.value); });
  const registry = new DurableTaskRegistry().register(definition);
  const inline = await getDb().transaction((tx) => createDurableTask(tx, { definition, payload: { value: "x" }, now: t0 }));

  const expired = new Date(t0.getTime() + definition.leaseMs + 1_000);
  const [recovered] = await claimExpiredDurableTasks({ workerId: "r", registry, now: expired });
  assert.ok(recovered);
  assert.equal(recovered.attempt, 2);
  assert.deepEqual(await claimExpiredDurableTasks({ workerId: "r2", registry, now: expired }), [], "one claimer only");

  assert.equal(await finishDurableTask(inline, { ok: true }, expired), "fenced", "the slow inline run cannot overwrite");
  assert.equal(await runDurableTask(recovered, registry, { clock: () => expired }), "succeeded");
  assert.deepEqual(seen, ["x"]);
});

test("failures back off, then need attention; permanent errors skip the retries", async ({ db }) => {
  const definition = echo(async (payload) => {
    if (payload.value === "permanent") throw new DurableTaskPermanentError("NOT_RECOVERABLE");
    throw new Error("transient");
  });
  const registry = new DurableTaskRegistry().register(definition);
  let now = t0;
  let claim = await getDb().transaction((tx) => createDurableTask(tx, { definition, payload: { value: "t" }, now }));

  assert.equal(await runDurableTask(claim, registry, { clock: () => now }), "retry");
  let task = await row(claim.task.id);
  assert.equal(task.state, "open");
  assert.equal(task.claimedBy, null);
  assert.equal(task.lastError, "ERROR_Error");
  assert.equal(task.leaseUntil.getTime(), now.getTime() + durableTaskBackoffMs(1));
  assert.deepEqual(await claimExpiredDurableTasks({ workerId: "r", registry, now }), [], "not due during backoff");

  now = new Date(task.leaseUntil.getTime() + 1);
  [claim] = await claimExpiredDurableTasks({ workerId: "r", registry, now });
  assert.equal(claim!.attempt, 2);
  assert.equal(await runDurableTask(claim!, registry, { clock: () => now }), "retry");
  now = new Date((await row(claim!.task.id)).leaseUntil.getTime() + 1);
  [claim] = await claimExpiredDurableTasks({ workerId: "r", registry, now });
  assert.equal(claim!.attempt, 3);
  assert.equal(await runDurableTask(claim!, registry, { clock: () => now }), "needs_attention");
  task = await row(claim!.task.id);
  assert.equal(task.state, "needs_attention");
  assert.deepEqual(await claimExpiredDurableTasks({ workerId: "r", registry, now: new Date(now.getTime() + 86_400_000) }), []);

  const permanent = await getDb().transaction((tx) => createDurableTask(tx, { definition, payload: { value: "permanent" }, now }));
  assert.equal(await runDurableTask(permanent, registry, { clock: () => now }), "needs_attention");
  assert.equal((await row(permanent.task.id)).lastError, "NOT_RECOVERABLE");
});

test("a deferral hands the task back after its delay without spending an attempt, however often it happens", async ({ db }) => {
  let busy = true;
  const definition = echo(async () => { if (busy) throw new DurableTaskDeferral(5_000, "BUSY"); }, { maxAttempts: 2 });
  const registry = new DurableTaskRegistry().register(definition);
  let now = t0;
  let claim = await getDb().transaction((tx) => createDurableTask(tx, { definition, payload: { value: "d" }, now }));
  // Many more deferrals than the attempt budget: still open, never needs_attention.
  for (let i = 0; i < 5; i += 1) {
    assert.equal(await runDurableTask(claim, registry, { clock: () => now }), "deferred");
    const task = await row(claim.task.id);
    assert.deepEqual([task.state, task.claimedBy, task.lastError], ["open", null, "BUSY"]);
    assert.equal(task.maxAttempts - task.attempts, 2, "the whole budget is still left");
    assert.equal(task.leaseUntil.getTime(), now.getTime() + 5_000);
    assert.deepEqual(await claimExpiredDurableTasks({ workerId: "r", registry, now }), [], "not due before the delay");
    now = new Date(now.getTime() + 5_001);
    [claim] = (await claimExpiredDurableTasks({ workerId: "r", registry, now })) as [typeof claim];
    assert.equal(claim.attempt, i + 2);
  }
  busy = false;
  assert.equal(await runDurableTask(claim, registry, { clock: () => now }), "succeeded");
});

test("an attempt that crashed on its last try is moved to needs_attention, not retried", async ({ db }) => {
  const definition = echo(async () => undefined, { maxAttempts: 1 });
  const registry = new DurableTaskRegistry().register(definition);
  const claim = await getDb().transaction((tx) => createDurableTask(tx, { definition, payload: { value: "x" }, now: t0 }));
  const expired = new Date(t0.getTime() + definition.leaseMs + 1_000);
  assert.deepEqual(await claimExpiredDurableTasks({ workerId: "r", registry, now: expired }), []);
  const task = await row(claim.task.id);
  assert.equal(task.state, "needs_attention");
  assert.equal(task.lastError, "LEASE_EXPIRED");
});

test("tasks of kinds this replica does not know are left for one that does", async ({ db }) => {
  const known = echo();
  const unknown = echo(async () => undefined, { kind: durableTaskKind("test.other") });
  await getDb().transaction((tx) => createDurableTask(tx, { definition: unknown, payload: { value: "x" }, now: t0 }));
  const registry = new DurableTaskRegistry().register(known);
  const expired = new Date(t0.getTime() + 60_000);
  assert.deepEqual(await claimExpiredDurableTasks({ workerId: "r", registry, now: expired }), []);
});

test("succeeded tasks are pruned after retention; tasks needing attention are kept", async ({ db }) => {
  const definition = echo(async (payload) => {
    if (payload.value === "bad") throw new DurableTaskPermanentError("BAD");
  });
  const registry = new DurableTaskRegistry().register(definition);
  for (const value of ["good", "bad"]) {
    const claim = await getDb().transaction((tx) => createDurableTask(tx, { definition, payload: { value }, now: t0 }));
    await runDurableTask(claim, registry, { clock: () => t0 });
  }
  assert.equal(await pruneDurableTasks(new Date(t0.getTime() + 8 * 86_400_000)), 1);
  const remaining = await getDb().select().from(durableTasks);
  assert.deepEqual(remaining.map((task) => task.state), ["needs_attention"]);
});
