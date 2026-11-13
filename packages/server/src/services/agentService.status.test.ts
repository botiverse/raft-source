import { fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";

import { eq } from "drizzle-orm";
import { getDb } from "../db/index";
import { agents, channelAgents, machines, notificationEvents, serverAgentMembers, users } from "../db/schema";
import { countActiveAgentsMissingServerMembership, createServer, getAgentMemberRole } from "./serverService";
import { clearAgentBillingErrorOnRecovery, clearAgentLastRuntimeErrorUnlessBilling, createAgent, getAgentLastRuntimeError, stampAgentRuntimeErrorRecoveryLaunch, deleteAgent, setAgentLastRuntimeError, getAgent, invalidateAgentSessionFromSignal, resetAgentSession, updateAgent, updateAgentStatus, updateAgentStatusFromSignal } from "./agentService";
import { addAgent, createChannel, findOrCreateAgentDM } from "./channelService";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

async function seedAgent(name: string) {
  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: `${name}@slock.test`,
    name,
    displayName: "Owner",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
  }).returning();

  const server = await createServer(`${name} server`, `${name}-server`, owner.id);
  const agent = await createAgent(server.id, `${name}-agent`, { runtime: "codex" });
  return agent;
}

test("updateAgentStatus keeps manually stopped status sticky against inactive updates", async ({ app }) => {
  const agent = await seedAgent("status-sticky");

  await updateAgentStatus(agent.id, "stopped");
  await updateAgentStatus(agent.id, "inactive");

  const updated = await getAgent(agent.id);
  assert.equal(updated?.status, "stopped");
});

test("updateAgentStatus still allows active updates after a stopped state", async ({ app }) => {
  const agent = await seedAgent("status-active-after-stop");

  await updateAgentStatus(agent.id, "stopped");
  await updateAgentStatus(agent.id, "active");

  const updated = await getAgent(agent.id);
  assert.equal(updated?.status, "active");
});

test("resetAgentSession can clear a session while preserving stopped status", async ({ app }) => {
  const agent = await seedAgent("status-reset-stopped");

  await updateAgentStatus(agent.id, "stopped", "session-old");
  await resetAgentSession(agent.id, "stopped");

  const updated = await getAgent(agent.id);
  assert.equal(updated?.status, "stopped");
  assert.equal(updated?.sessionId, null);
});

/** An agent placed on Computer `a`, plus a second Computer `b` of the same owner. */
async function seedAgentOnMachines(name: string) {
  const agent = await seedAgent(name);
  const db = getDb();
  const [owner] = await db.select().from(users).where(eq(users.email, `${name}@slock.test`)).limit(1);
  const [a, b] = await db.insert(machines).values([
    { serverId: agent.serverId, userId: owner.id, name: `${name}-a`, apiKeyHash: `${name}-a-hash` },
    { serverId: agent.serverId, userId: owner.id, name: `${name}-b`, apiKeyHash: `${name}-b-hash` },
  ]).returning();
  await db.update(agents).set({ machineId: a.id }).where(eq(agents.id, agent.id));
  return { agent, a, b };
}

async function statusChangedEventCount(agentId: string) {
  const events = await getDb().select().from(notificationEvents).where(eq(notificationEvents.subjectId, agentId));
  return events.filter((event) => event.eventType === "agent.status_changed").length;
}

test("updateAgentStatusFromSignal keeps stopped sticky against active signals", async ({ app }) => {
  const { agent, a } = await seedAgentOnMachines("status-signal-active");

  await updateAgentStatus(agent.id, "stopped");
  const outcome = await updateAgentStatusFromSignal(agent.id, "active", { machineId: a.id, sessionId: "session-late" });

  const updated = await getAgent(agent.id);
  assert.equal(outcome, "rejected");
  assert.equal(updated?.status, "stopped");
  // sessionId must not leak through either — late session bound to stopped is stale.
  assert.equal(updated?.sessionId, null);
});

test("updateAgentStatusFromSignal keeps stopped sticky against inactive signals", async ({ app }) => {
  const { agent, a } = await seedAgentOnMachines("status-signal-inactive");

  await updateAgentStatus(agent.id, "stopped");
  const outcome = await updateAgentStatusFromSignal(agent.id, "inactive", { machineId: a.id });

  const updated = await getAgent(agent.id);
  assert.equal(outcome, "rejected");
  assert.equal(updated?.status, "stopped");
});

test("updateAgentStatusFromSignal still applies when the agent is not stopped", async ({ app }) => {
  const { agent, a } = await seedAgentOnMachines("status-signal-applies");

  const activeOutcome = await updateAgentStatusFromSignal(agent.id, "active", { machineId: a.id, sessionId: "session-fresh" });
  const afterActive = await getAgent(agent.id);
  assert.equal(activeOutcome, "applied");
  assert.equal(afterActive?.status, "active");
  assert.equal(afterActive?.sessionId, "session-fresh");

  const inactiveOutcome = await updateAgentStatusFromSignal(agent.id, "inactive", { machineId: a.id });
  const afterInactive = await getAgent(agent.id);
  assert.equal(inactiveOutcome, "applied");
  assert.equal(afterInactive?.status, "inactive");
});

test("step 14: a status signal from a Computer the agent left changes nothing", async ({ app }) => {
  const { agent, a, b } = await seedAgentOnMachines("status-signal-fenced");
  await updateAgentStatus(agent.id, "active", "session-on-a");
  // Moved to B (by another replica: nothing here knows).
  await getDb().update(agents).set({ machineId: b.id }).where(eq(agents.id, agent.id));
  const eventsBefore = await statusChangedEventCount(agent.id);

  // The old process on A exits.
  const outcome = await updateAgentStatusFromSignal(agent.id, "inactive", { machineId: a.id });

  const row = await getAgent(agent.id);
  assert.equal(outcome, "machine_fenced");
  assert.equal(row?.status, "active");
  assert.equal(row?.machineId, b.id);
  assert.equal(await statusChangedEventCount(agent.id), eventsBefore, "a fenced write emits no status notification");

  // B's own signal still lands.
  assert.equal(await updateAgentStatusFromSignal(agent.id, "inactive", { machineId: b.id }), "applied");
  assert.equal((await getAgent(agent.id))?.status, "inactive");
  assert.equal(await statusChangedEventCount(agent.id), eventsBefore + 1);
});

test("step 14: a session signal from a Computer the agent left keeps sessionId", async ({ app }) => {
  const { agent, a, b } = await seedAgentOnMachines("session-signal-fenced");
  await updateAgentStatus(agent.id, "inactive", "session-on-a");
  await getDb().update(agents).set({ machineId: b.id, sessionId: "session-on-b" }).where(eq(agents.id, agent.id));

  const outcome = await updateAgentStatusFromSignal(agent.id, "active", { machineId: a.id, sessionId: "session-late-a" });

  const row = await getAgent(agent.id);
  assert.equal(outcome, "machine_fenced");
  assert.equal(row?.sessionId, "session-on-b");
  assert.equal(row?.status, "inactive");

  // An agent on no Computer takes no daemon signal at all.
  await getDb().update(agents).set({ machineId: null }).where(eq(agents.id, agent.id));
  assert.equal(await updateAgentStatusFromSignal(agent.id, "active", { machineId: b.id, sessionId: "session-x" }), "machine_fenced");
  assert.equal((await getAgent(agent.id))?.sessionId, "session-on-b");
});

test("clearAgentLastRuntimeErrorUnlessBilling writes only when a non-billing error is set", async ({ app }) => {
  const agent = await seedAgent("runtime-error-clear-noop");
  const db = getDb();
  const readRow = async () => (await db.select({ lastRuntimeError: agents.lastRuntimeError, updatedAt: agents.updatedAt })
    .from(agents).where(eq(agents.id, agent.id)).limit(1))[0];

  const before = await readRow();
  assert.equal(before.lastRuntimeError, null);
  assert.deepEqual(await clearAgentLastRuntimeErrorUnlessBilling(agent.id), { cleared: false, current: null });
  assert.equal((await readRow()).updatedAt.getTime(), before.updatedAt.getTime());

  assert.equal((await setAgentLastRuntimeError(agent.id, { message: "boom", at: new Date().toISOString(), actionRequired: true }))?.message, "boom");
  assert.equal((await readRow()).lastRuntimeError?.message, "boom");
  assert.deepEqual(await clearAgentLastRuntimeErrorUnlessBilling(agent.id), { cleared: true, current: null });
  assert.equal((await readRow()).lastRuntimeError, null);

  // task #1351: a BillingError is never cleared this way (a stale cache that
  // thinks the error is generic, a session report, a manual Stop).
  const billing = { message: "402", at: new Date().toISOString(), actionRequired: true, errorClass: "BillingError" as const, errorReason: "billing_exhausted" as const, occurrenceId: "11111111-1111-4111-8111-111111111111" };
  await setAgentLastRuntimeError(agent.id, billing);
  assert.deepEqual(await clearAgentLastRuntimeErrorUnlessBilling(agent.id), { cleared: false, current: billing });
  assert.deepEqual((await readRow()).lastRuntimeError, billing);
  assert.deepEqual(await getAgentLastRuntimeError(agent.id), billing);

  await deleteAgent(agent.id);
  assert.equal(await clearAgentLastRuntimeErrorUnlessBilling(agent.id), null);
  assert.equal(await clearAgentLastRuntimeErrorUnlessBilling("00000000-0000-4000-8000-000000000000"), null);
  assert.equal(await getAgentLastRuntimeError(agent.id), undefined);
});

test("task #1351: proof-and-clear removes a BillingError only on R1 or R2, in one statement, and writes nothing otherwise", async ({ app }) => {
  const agent = await seedAgent("rt-proof");
  const db = getDb();
  const readRow = async () => (await db.select({ lastRuntimeError: agents.lastRuntimeError, updatedAt: agents.updatedAt })
    .from(agents).where(eq(agents.id, agent.id)).limit(1))[0];
  const a = { message: "402 Insufficient Balance", at: "2026-11-06T10:00:00.000Z", actionRequired: true, errorClass: "BillingError" as const, errorReason: "billing_exhausted" as const, occurrenceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", launchId: "launch-1", daemonInstanceId: "daemon-a", clientSeq: 10 };

  // Nothing stored: no match, no write.
  const empty = await readRow();
  assert.equal(await clearAgentBillingErrorOnRecovery(agent.id, { launchId: "launch-1", daemonInstanceId: "daemon-a", clientSeq: 11 }), null);
  assert.equal((await readRow()).updatedAt.getTime(), empty.updatedAt.getTime(), "no row write when no error is stored");

  await setAgentLastRuntimeError(agent.id, a);
  const before = await readRow();
  for (const [label, frame] of [
    ["the setting frame itself", { launchId: "launch-1", daemonInstanceId: "daemon-a", clientSeq: 10 }],
    ["a lower seq", { launchId: "launch-1", daemonInstanceId: "daemon-a", clientSeq: 9 }],
    ["seq from another launch", { launchId: "launch-0", daemonInstanceId: "daemon-a", clientSeq: 99 }],
    ["seq from another daemon process", { launchId: "launch-1", daemonInstanceId: "daemon-b", clientSeq: 99 }],
    ["no launch", { daemonInstanceId: "daemon-a", clientSeq: 99 }],
    ["no daemon process", { launchId: "launch-1", clientSeq: 99 }],
    ["no seq", { launchId: "launch-1", daemonInstanceId: "daemon-a" }],
    ["nothing", {}],
  ] as const) {
    assert.equal(await clearAgentBillingErrorOnRecovery(agent.id, frame), null, label);
  }
  const after = await readRow();
  assert.deepEqual(after.lastRuntimeError, a);
  assert.equal(after.updatedAt.getTime(), before.updatedAt.getTime(), "no row write for an unproven frame");

  // Only a BillingError: a generic error is never cleared this way.
  const generic = { message: "Request timed out.", at: "2026-11-06T10:00:00.000Z", actionRequired: true, errorClass: "TimeoutError" as const, launchId: "launch-1", daemonInstanceId: "daemon-a", clientSeq: 10 };
  await setAgentLastRuntimeError(agent.id, generic);
  assert.equal(await clearAgentBillingErrorOnRecovery(agent.id, { launchId: "launch-1", daemonInstanceId: "daemon-a", clientSeq: 11 }), null);
  assert.deepEqual((await readRow()).lastRuntimeError, generic);

  // R1: returns the record it removed.
  await setAgentLastRuntimeError(agent.id, a);
  assert.deepEqual(await clearAgentBillingErrorOnRecovery(agent.id, { launchId: "launch-1", daemonInstanceId: "daemon-a", clientSeq: 11 }), a);
  assert.equal((await readRow()).lastRuntimeError, null);

  // R2: the stamped launch, not the 402's own launch.
  await setAgentLastRuntimeError(agent.id, a);
  assert.equal(await clearAgentBillingErrorOnRecovery(agent.id, { launchId: "launch-2" }), null, "not stamped yet");
  await stampAgentRuntimeErrorRecoveryLaunch(agent.id, "launch-2");
  assert.equal(await clearAgentBillingErrorOnRecovery(agent.id, { launchId: "launch-3" }), null, "another launch");
  assert.deepEqual(await clearAgentBillingErrorOnRecovery(agent.id, { launchId: "launch-2" }), { ...a, recoveryLaunchId: "launch-2" });
  assert.equal((await readRow()).lastRuntimeError, null);
});

test("task #1351: a missing launch is not the same launch, for clears and for 402 replacement", async ({ app }) => {
  const agent = await seedAgent("rt-nolaunch");
  // Same daemon process, seq 10 -> 11, both launchIds missing.
  const noLaunch = { message: "402 Insufficient Balance", at: "2026-11-06T10:00:00.000Z", actionRequired: true, errorClass: "BillingError" as const, errorReason: "billing_exhausted" as const, occurrenceId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", daemonInstanceId: "daemon-a", clientSeq: 10 };
  await setAgentLastRuntimeError(agent.id, noLaunch);
  assert.equal(await clearAgentBillingErrorOnRecovery(agent.id, { daemonInstanceId: "daemon-a", clientSeq: 11 }), null, "no clear");
  assert.equal(await clearAgentBillingErrorOnRecovery(agent.id, { launchId: null, daemonInstanceId: "daemon-a", clientSeq: 11 }), null, "no clear");
  const next = { ...noLaunch, occurrenceId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", clientSeq: 11, at: "2026-11-06T10:00:01.000Z" };
  assert.deepEqual(await setAgentLastRuntimeError(agent.id, next), noLaunch, "no replacement");
  assert.deepEqual(await getAgentLastRuntimeError(agent.id), noLaunch);

  // A stored record without a daemon process is not null-equal to one either.
  const { daemonInstanceId: _daemon, ...withoutDaemon } = noLaunch;
  const noDaemon = { ...withoutDaemon, occurrenceId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", launchId: "launch-1" };
  await clearAgentLastRuntimeErrorUnlessBilling(agent.id);
  await getDb().update(agents).set({ lastRuntimeError: noDaemon }).where(eq(agents.id, agent.id));
  assert.equal(await clearAgentBillingErrorOnRecovery(agent.id, { launchId: "launch-1", clientSeq: 11 }), null);
  assert.deepEqual(await setAgentLastRuntimeError(agent.id, { ...noDaemon, occurrenceId: "ffffffff-ffff-4fff-8fff-ffffffffffff", clientSeq: 11 }), noDaemon);
});

test("task #1351: a BillingError is rewritten as a new occurrence only when it provably came after the stored one", async ({ app }) => {
  const agent = await seedAgent("rt-billing");
  const stored = async () => getAgentLastRuntimeError(agent.id);
  let n = 0;
  const billing = (evidence: { launchId?: string; daemonInstanceId?: string; clientSeq?: number }) => ({
    message: "402 Insufficient Balance",
    at: new Date(Date.parse("2026-11-06T10:00:00.000Z") + (n++) * 1000).toISOString(),
    actionRequired: true,
    errorClass: "BillingError" as const,
    errorReason: "billing_exhausted" as const,
    occurrenceId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    ...evidence,
  });

  const a = billing({ launchId: "launch-1", daemonInstanceId: "daemon-a", clientSeq: 10 });
  assert.deepEqual(await setAgentLastRuntimeError(agent.id, a), a);
  // Same domain, higher seq, seconds later: no 5-minute merge, a new occurrence.
  const b = billing({ launchId: "launch-1", daemonInstanceId: "daemon-a", clientSeq: 11 });
  assert.deepEqual(await setAgentLastRuntimeError(agent.id, b), b);
  // A replay (same seq) or an older seq of that domain: B keeps its evidence.
  assert.deepEqual(await setAgentLastRuntimeError(agent.id, billing({ launchId: "launch-1", daemonInstanceId: "daemon-a", clientSeq: 11 })), b);
  assert.deepEqual(await setAgentLastRuntimeError(agent.id, billing({ launchId: "launch-1", daemonInstanceId: "daemon-a", clientSeq: 9 })), b);
  // Another launch (no stamp), another daemon process, or no evidence: not provably newer.
  assert.deepEqual(await setAgentLastRuntimeError(agent.id, billing({ launchId: "launch-0", daemonInstanceId: "daemon-a", clientSeq: 99 })), b);
  assert.deepEqual(await setAgentLastRuntimeError(agent.id, billing({ launchId: "launch-1", daemonInstanceId: "daemon-b", clientSeq: 99 })), b);
  assert.deepEqual(await setAgentLastRuntimeError(agent.id, billing({})), b);
  assert.deepEqual(await stored(), b);

  // A start armed launch-2 while B was stored: a 402 from launch-2 replaces B
  // with a fresh record that does not inherit the stamp.
  assert.equal((await stampAgentRuntimeErrorRecoveryLaunch(agent.id, "launch-2"))?.recoveryLaunchId, "launch-2");
  const c = billing({ launchId: "launch-2", daemonInstanceId: "daemon-a", clientSeq: 30 });
  assert.deepEqual(await setAgentLastRuntimeError(agent.id, c), c);
  assert.equal((await stored())?.recoveryLaunchId, undefined);

  // Other classes are unchanged: they replace a BillingError, and a BillingError replaces them.
  const generic = { message: "Request timed out.", at: "2026-11-06T11:00:00.000Z", actionRequired: true, errorClass: "TimeoutError" as const };
  assert.deepEqual(await setAgentLastRuntimeError(agent.id, generic), generic);
  const d = billing({ launchId: "launch-9" });
  assert.deepEqual(await setAgentLastRuntimeError(agent.id, d), d);

  // An old untyped record (no errorClass): a typed 402 replaces it. The
  // "stored is a BillingError" test must be NULL-safe, or the UPDATE never runs.
  const untyped = { message: "Something failed", at: "2026-11-06T12:00:00.000Z", actionRequired: true };
  assert.deepEqual(await setAgentLastRuntimeError(agent.id, untyped), untyped);
  assert.equal((await stored())?.errorClass, undefined);
  const e = billing({ launchId: "launch-10" });
  assert.deepEqual(await setAgentLastRuntimeError(agent.id, e), e, "a typed 402 replaces an untyped record");
  assert.deepEqual(await stored(), e);
});

test("task #1351: arming a launch stamps it on the stored BillingError, old records included, unless the 402 came from it", async ({ app }) => {
  const agent = await seedAgent("rt-stamp");
  const db = getDb();
  const readRow = async () => (await db.select({ lastRuntimeError: agents.lastRuntimeError, updatedAt: agents.updatedAt })
    .from(agents).where(eq(agents.id, agent.id)).limit(1))[0];
  assert.equal(await stampAgentRuntimeErrorRecoveryLaunch(agent.id, "launch-2"), null, "nothing stored");

  await setAgentLastRuntimeError(agent.id, { message: "boom", at: "2026-11-06T10:00:00.000Z", actionRequired: true, errorClass: "TimeoutError" });
  assert.equal(await stampAgentRuntimeErrorRecoveryLaunch(agent.id, "launch-2"), null, "only a BillingError");

  // A record stored before occurrenceIds and evidence: stamped as it is, never cleared or re-keyed.
  const old = { message: "402 Insufficient Balance", at: "2026-11-01T09:00:00.000Z", launchId: "launch-1", actionRequired: true, errorClass: "BillingError" as const, errorReason: "billing_exhausted" as const };
  await setAgentLastRuntimeError(agent.id, old);
  const beforeStamp = await readRow();
  assert.equal(await stampAgentRuntimeErrorRecoveryLaunch(agent.id, "launch-1"), null, "the 402 came from that launch");
  assert.deepEqual(await stampAgentRuntimeErrorRecoveryLaunch(agent.id, "launch-2"), { ...old, recoveryLaunchId: "launch-2" });
  assert.deepEqual(await stampAgentRuntimeErrorRecoveryLaunch(agent.id, "launch-3"), { ...old, recoveryLaunchId: "launch-3" }, "the next start's launch replaces it");
  const afterStamp = await readRow();
  assert.deepEqual(afterStamp.lastRuntimeError, { ...old, recoveryLaunchId: "launch-3" });
  assert.equal(afterStamp.updatedAt.getTime(), beforeStamp.updatedAt.getTime());
});

test("setAgentLastRuntimeError keeps a repeated error for 5 minutes instead of rewriting it", async ({ app }) => {
  const agent = await seedAgent("runtime-error-dedupe");
  const db = getDb();
  const readRow = async () => (await db.select({ lastRuntimeError: agents.lastRuntimeError, updatedAt: agents.updatedAt })
    .from(agents).where(eq(agents.id, agent.id)).limit(1))[0];
  const t0 = Date.parse("2026-10-05T12:00:00.000Z");
  const at = (minutes: number) => new Date(t0 + minutes * 60_000).toISOString();
  const limit = { message: "You've hit your usage limit", actionRequired: true, errorClass: "RuntimeError" as const };

  const first = { ...limit, at: at(0), launchId: "launch-1" };
  assert.deepEqual(await setAgentLastRuntimeError(agent.id, first), first);
  const afterFirst = await readRow();

  // Same error from the next launch, 4 minutes later: the row is not rewritten,
  // and the caller gets the stored state back (to publish exactly the row).
  const repeat = { ...limit, at: at(4), launchId: "launch-2" };
  assert.deepEqual(await setAgentLastRuntimeError(agent.id, repeat), first);
  const afterRepeat = await readRow();
  assert.deepEqual(afterRepeat.lastRuntimeError, first);
  assert.equal(afterRepeat.updatedAt.getTime(), afterFirst.updatedAt.getTime(), "no write for a repeat inside the window");

  // A different error is written at once.
  const other = { ...limit, message: "Request timed out.", errorClass: "TimeoutError" as const, at: at(4.5) };
  assert.deepEqual(await setAgentLastRuntimeError(agent.id, other), other);
  assert.deepEqual((await readRow()).lastRuntimeError, other);

  // Same message but a different actionRequired is a different error.
  const otherAction = { ...other, actionRequired: false, at: at(4.6) };
  assert.deepEqual(await setAgentLastRuntimeError(agent.id, otherAction), otherAction);

  // The same error again after the window (6th minute from the stored one) is rewritten.
  const later = { ...otherAction, at: at(10.7) };
  assert.deepEqual(await setAgentLastRuntimeError(agent.id, later), later);
  assert.deepEqual((await readRow()).lastRuntimeError, later);

  // A cleared error does not count as stored.
  assert.equal((await clearAgentLastRuntimeErrorUnlessBilling(agent.id))?.cleared, true);
  const afterClear = { ...later, at: at(11) };
  assert.deepEqual(await setAgentLastRuntimeError(agent.id, afterClear), afterClear);

  await deleteAgent(agent.id);
  assert.equal(await setAgentLastRuntimeError(agent.id, { ...limit, at: at(20) }), null);
  assert.equal(await setAgentLastRuntimeError("00000000-0000-4000-8000-000000000000", { ...limit, at: at(20) }), null);
});

test("invalidateAgentSessionFromSignal clears only the exact current non-stopped session", async ({ app }) => {
  const agent = await seedAgent("session-invalidation-cas");
  const db = getDb();
  const [owner] = await db.select().from(users)
    .where(eq(users.email, "session-invalidation-cas@slock.test"))
    .limit(1);
  const [sourceMachine, targetMachine] = await db.insert(machines).values([
    { serverId: agent.serverId, userId: owner.id, name: "source", apiKeyHash: "source-hash" },
    { serverId: agent.serverId, userId: owner.id, name: "target", apiKeyHash: "target-hash" },
  ]).returning();
  await db.update(agents).set({ machineId: sourceMachine.id }).where(eq(agents.id, agent.id));
  await updateAgentStatus(agent.id, "active", "session-newer");

  assert.equal(await invalidateAgentSessionFromSignal(agent.id, "session-stale", sourceMachine.id), false);
  assert.equal((await getAgent(agent.id))?.sessionId, "session-newer");

  assert.equal(await invalidateAgentSessionFromSignal(agent.id, "session-newer", sourceMachine.id), true);
  const cleared = await getAgent(agent.id);
  assert.equal(cleared?.status, "active");
  assert.equal(cleared?.sessionId, null);

  await updateAgentStatus(agent.id, "stopped", "session-stopped");
  assert.equal(await invalidateAgentSessionFromSignal(agent.id, "session-stopped", sourceMachine.id), false);
  const stopped = await getAgent(agent.id);
  assert.equal(stopped?.status, "stopped");
  assert.equal(stopped?.sessionId, "session-stopped");

  await db.update(agents).set({
    status: "active",
    sessionId: "session-shared",
    machineId: targetMachine.id,
  }).where(eq(agents.id, agent.id));
  assert.equal(await invalidateAgentSessionFromSignal(agent.id, "session-shared", sourceMachine.id), false);
  const migrated = await getAgent(agent.id);
  assert.equal(migrated?.machineId, targetMachine.id);
  assert.equal(migrated?.sessionId, "session-shared");
});

test("real agent status, profile, runtime, and model mutations emit exact app notification events", async ({ app }) => {
  const db = getDb();
  const agent = await seedAgent("status-app-notifications");

  await updateAgentStatus(agent.id, "active");
  await updateAgentStatus(agent.id, "active");
  await updateAgent(agent.id, {
    displayName: "Notification Agent",
    runtime: "claude",
    model: "sonnet",
  });
  await updateAgent(agent.id, {
    displayName: "Notification Agent",
    runtime: "claude",
    model: "sonnet",
  });

  const events = await db.select().from(notificationEvents)
    .where(eq(notificationEvents.subjectId, agent.id));
  assert.deepEqual(events.map((event) => event.eventType).sort(), [
    "agent.model_changed",
    "agent.profile_updated",
    "agent.runtime_changed",
    "agent.status_changed",
  ]);
  assert.deepEqual(
    Object.fromEntries(events.map((event) => [event.eventType, event.provenance.changed_fields])),
    {
      "agent.status_changed": ["status"],
      "agent.profile_updated": ["display_name"],
      "agent.runtime_changed": ["runtime"],
      "agent.model_changed": ["model"],
    },
  );
});

test("deleteAgent removes channel membership rows for the soft-deleted agent", async ({ app }) => {
  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: "delete-membership-owner@slock.test",
    name: "delete-membership-owner",
    displayName: "Owner",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
  }).returning();

  const server = await createServer("Delete Membership", "delete-membership", owner.id);
  const agentA = await createAgent(server.id, "delete-membership-a", { runtime: "codex" });
  const agentB = await createAgent(server.id, "delete-membership-b", { runtime: "codex" });
  const channel = await createChannel(server.id, "delete-membership-channel");
  await addAgent(channel.id, agentA.id);
  const dm = await findOrCreateAgentDM(server.id, agentA.id, agentB.id);
  assert.ok(dm, "expected an agent-to-agent DM");

  const beforeDelete = await db
    .select({ channelId: channelAgents.channelId })
    .from(channelAgents)
    .where(eq(channelAgents.agentId, agentA.id));
  assert.ok(beforeDelete.length >= 2, "agent should be in the explicit channel and its DM before deletion");
  assert.equal(await getAgentMemberRole(server.id, agentA.id), "member");

  await deleteAgent(agentA.id);

  const afterDelete = await db
    .select({ channelId: channelAgents.channelId })
    .from(channelAgents)
    .where(eq(channelAgents.agentId, agentA.id));
  assert.deepEqual(afterDelete, []);
  const serverMembershipAfterDelete = await db
    .select({ agentId: serverAgentMembers.agentId })
    .from(serverAgentMembers)
    .where(eq(serverAgentMembers.agentId, agentA.id));
  assert.deepEqual(serverMembershipAfterDelete, []);
  assert.equal(await getAgentMemberRole(server.id, agentA.id), null);
});

test("active agent membership completeness counts only active agents missing server rows", async ({ app }) => {
  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: "agent-membership-completeness-owner@slock.test",
    name: "agent-membership-completeness-owner",
    displayName: "Owner",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
  }).returning();

  const server = await createServer("Agent Membership Completeness", "agent-membership-completeness", owner.id);
  await createAgent(server.id, "complete-new-agent", { runtime: "codex" });

  const [legacyAgent] = await db.insert(agents).values({
    serverId: server.id,
    name: "legacy-agent-without-membership",
    displayName: "Legacy Agent",
    runtime: "codex",
  }).returning();
  await db.insert(agents).values({
    serverId: server.id,
    name: "deleted-legacy-agent-without-membership",
    displayName: "Deleted Legacy Agent",
    runtime: "codex",
    deletedAt: new Date(),
  });

  assert.equal(await countActiveAgentsMissingServerMembership(), 1);

  await db.insert(serverAgentMembers).values({
    serverId: server.id,
    agentId: legacyAgent.id,
    role: "member",
  });

  assert.equal(await countActiveAgentsMissingServerMembership(), 0);
});
