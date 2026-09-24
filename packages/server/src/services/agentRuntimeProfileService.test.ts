import { dbTest as test } from "../test/integration/dbTest.js";
import { closeTestDatabase } from "../test/integration/database.js";
import assert from "node:assert/strict";
import { afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { BasicTracer, MemoryTraceSink } from "@botiverse/raft-shared";
import { getDb } from "../db/index.js";
import { agentRuntimeProfiles, agents, machines, servers, users } from "../db/schema.js";
import {
  getAgentRuntimeProfileSummary,
  getPendingRuntimeProfileNotice,
  getPendingRuntimeProfileControl,
  getRuntimeProfileMigrationNudgeCandidate,
  isRuntimeProfileMigrationGated,
  markRuntimeProfileMigrationDelivered,
  markRuntimeProfileMigrationHandled,
  queueRuntimeProfileMigrationForAgentSettings,
  recordAgentRuntimeProfile,
  renderRuntimeProfileMigrationMessage,
  disableRuntimeProfileWriteCooldownForTests,
} from "./agentRuntimeProfileService.js";
import { runWithTraceSpan } from "../tracing/semanticTrace.js";


// The production write-cooldown (#2566) silently no-ops the second
// `recordAgentRuntimeProfile` call on the same agentId within 5s — fine
// for production lock-storm prevention, but breaks within-test sequences
// like "first report" → "release-notice queued on follow-up". Disable it
// for the duration of this suite so all per-test sequences are
// deterministic. Surfaced as 10+ RED staging runs starting 2026-06-03
// 13:00Z, mis-attributed to #2570 before root cause was found in #2566.
disableRuntimeProfileWriteCooldownForTests();

afterEach(async () => {
  await closeTestDatabase();
});

async function seedRuntimeProfileAgent() {
  const db = getDb();
  const [user] = await db.insert(users).values({
    id: "11111111-1111-1111-1111-111111111111",
    email: "runtime-profile-owner@example.com",
    name: "runtime-profile-owner",
    passwordHash: "hash",
    emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({
    id: "22222222-2222-2222-2222-222222222222",
    name: "Runtime Profile Server",
    slug: "runtime-profile-server",
    ownerId: user.id,
  }).returning();
  const [machine] = await db.insert(machines).values({
    id: "33333333-3333-3333-3333-333333333333",
    serverId: server.id,
    userId: user.id,
    name: "dev-mac",
    apiKeyHash: "hash",
    daemonVersion: "0.40.2",
  }).returning();
  const [agent] = await db.insert(agents).values({
    id: "44444444-4444-4444-4444-444444444444",
    serverId: server.id,
    name: "runtime-profile-agent",
    status: "active",
    runtime: "codex",
    model: "gpt-5.3-codex",
    reasoningEffort: "high",
    executionMode: "byoc",
    machineId: machine.id,
  }).returning();
  return { server, machine, agent };
}

test("runtime profile stores current facts and only queues catalog-backed daemon release notices", async ({ db }) => {

  const { server, machine, agent } = await seedRuntimeProfileAgent();

  await recordAgentRuntimeProfile({
    serverId: server.id,
    agentId: agent.id,
    machineId: machine.id,
    daemonVersion: "0.40.1",
    facts: {
      runtime: "codex",
      model: "gpt-5.3-codex",
      reasoningEffort: "high",
      executionMode: "byoc",
      workspacePathRef: { label: "workspace", path: "/work/one", reachable: true },
      sessionRef: { label: "session-a", runtime: "codex", path: "/sessions/a.jsonl", reachable: true },
    },
  });

  const releaseOnly = await recordAgentRuntimeProfile({
    serverId: server.id,
    agentId: agent.id,
    machineId: machine.id,
    daemonVersion: "0.40.2",
    facts: {
      runtime: "codex",
      model: "gpt-5.3-codex",
      reasoningEffort: "high",
      executionMode: "byoc",
      workspacePathRef: { label: "workspace", path: "/work/two", reachable: true },
      sessionRef: { label: "session-b", runtime: "codex", path: "/sessions/b.jsonl", reachable: true },
    },
  });

  assert.equal(releaseOnly.pending?.pendingKind, "daemon_release_notice");
  assert.equal(releaseOnly.pending?.migrationStatus, "pending");
  assert.equal(releaseOnly.pending?.pendingReleaseNotesUrl, null);

  const summary = await getAgentRuntimeProfileSummary(agent.id);
  assert.equal(summary?.current?.daemonVersion, "0.40.2");
  assert.equal(summary?.current?.machineName, "dev-mac");
  assert.equal(summary?.pending?.kind, "daemon_release_notice");
  assert.equal(summary?.migrationStatus, "pending");

  const message = renderRuntimeProfileMigrationMessage(releaseOnly.pending!);
  assert.match(message, /Agent-facing daemon changes:/);
  assert.match(message, /Runtime Profile migration, nudge, and daemon release notices are now mirrored into Activity Log after delivery/);
  assert.match(message, /Why it matters: You can inspect the exact private notice later/);
});

test("daemon release-note arbitration emits closed decision events for compute, suppress, and delivery", async ({ db }) => {

  const { server, machine, agent } = await seedRuntimeProfileAgent();
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({ sink });
  const span = tracer.startSpan("server.runtime_profile.report.ingest", { surface: "server", kind: "consumer" });
  const facts = {
    runtime: "codex",
    model: "gpt-5.3-codex",
    reasoningEffort: "high" as const,
    executionMode: "byoc",
  };

  await runWithTraceSpan(span, async () => {
    await recordAgentRuntimeProfile({
      serverId: server.id,
      agentId: agent.id,
      machineId: machine.id,
      daemonVersion: "0.40.1",
      facts,
    });
    const computed = await recordAgentRuntimeProfile({
      serverId: server.id,
      agentId: agent.id,
      machineId: machine.id,
      daemonVersion: "0.40.2",
      facts,
    });
    assert.ok(computed.pending?.pendingKey);
    await recordAgentRuntimeProfile({
      serverId: server.id,
      agentId: agent.id,
      machineId: machine.id,
      daemonVersion: "0.40.2",
      facts,
    });
    assert.equal(await markRuntimeProfileMigrationDelivered(agent.id, computed.pending.pendingKey, "launch-1"), true);
    await recordAgentRuntimeProfile({
      serverId: server.id,
      agentId: agent.id,
      machineId: machine.id,
      daemonVersion: "0.40.3",
      facts,
    });
    await recordAgentRuntimeProfile({
      serverId: server.id,
      agentId: agent.id,
      machineId: machine.id,
      daemonVersion: "0.40.3",
      facts: { ...facts, model: "gpt-5.4-codex" },
    });
  }, tracer);
  span.end("ok");

  const completed = sink.getAllSpans().find((candidate) => candidate.name === "server.runtime_profile.report.ingest");
  assert.ok(completed);
  const decisions = completed.events.filter((event) => event.name === "server.daemon_notes.decision");
  assert.deepEqual(decisions.map((event) => event.attrs?.action), [
    "baseline_advanced",
    "computed",
    "suppressed_version_gate",
    "delivered",
    "suppressed_no_entries",
    "cleared",
  ]);
  assert.deepEqual(decisions.map((event) => event.attrs?.reason), [
    "initial_baseline",
    "catalog_entries_found",
    "version_not_newer",
    "notice_acknowledged",
    "no_catalog_entries",
    "runtime_identity_changed",
  ]);
  assert.ok(Number(decisions[1]?.attrs?.entries_n) > 0);
  assert.ok(Number(decisions[3]?.attrs?.entries_n) > 0);
  for (const decision of decisions) {
    assert.deepEqual(Object.keys(decision.attrs ?? {}).sort(), [
      "action",
      "baseline_after",
      "baseline_before",
      "entries_n",
      "event_kind",
      "outcome",
      "reason",
    ]);
  }
  const serialized = JSON.stringify(decisions);
  assert.doesNotMatch(serialized, /workspace|session|model|\/Users|secret|message/);
});

test("runtime profile first report insert is idempotent under duplicate delivery", async ({ db }) => {

  const { server, machine, agent } = await seedRuntimeProfileAgent();
  const facts = {
    runtime: "codex",
    model: "gpt-5.3-codex",
    reasoningEffort: "high" as const,
    executionMode: "byoc",
  };

  const reports = await Promise.all([
    recordAgentRuntimeProfile({
      serverId: server.id,
      agentId: agent.id,
      machineId: machine.id,
      daemonVersion: "0.40.2",
      facts,
    }),
    recordAgentRuntimeProfile({
      serverId: server.id,
      agentId: agent.id,
      machineId: machine.id,
      daemonVersion: "0.40.2",
      facts,
    }),
  ]);

  assert.equal(reports[0].profile.agentId, agent.id);
  assert.equal(reports[1].profile.agentId, agent.id);
  const rows = await getDb().select()
    .from(agentRuntimeProfiles)
    .where(eq(agentRuntimeProfiles.agentId, agent.id));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].pendingKind, null);
});

test("runtime profile daemon upgrades without agent-facing notes silently advance baseline", async ({ db }) => {

  const { server, machine, agent } = await seedRuntimeProfileAgent();

  const facts = {
    runtime: "codex",
    model: "gpt-5.3-codex",
    reasoningEffort: "high" as const,
    executionMode: "byoc",
  };

  await recordAgentRuntimeProfile({
    serverId: server.id,
    agentId: agent.id,
    machineId: machine.id,
    daemonVersion: "0.40.2",
    facts,
  });

  const noNotice = await recordAgentRuntimeProfile({
    serverId: server.id,
    agentId: agent.id,
    machineId: machine.id,
    daemonVersion: "0.40.3",
    facts,
  });

  assert.equal(noNotice.pending, null);
  const [row] = await getDb().select()
    .from(agentRuntimeProfiles)
    .where(eq(agentRuntimeProfiles.agentId, agent.id))
    .limit(1);
  assert.equal(row.daemonVersion, "0.40.3");
  assert.equal(row.baselineDaemonVersion, "0.40.3");
  assert.equal(row.pendingKind, null);
});

test("runtime profile changes reset the session without gating inbox delivery", async ({ db }) => {

  const { server, machine, agent } = await seedRuntimeProfileAgent();

  await recordAgentRuntimeProfile({
    serverId: server.id,
    agentId: agent.id,
    machineId: machine.id,
    daemonVersion: "0.40.2",
    facts: {
      runtime: "codex",
      model: "gpt-5.3-codex",
      reasoningEffort: "high",
      executionMode: "byoc",
      sessionRef: { label: "session-a", runtime: "codex", path: "/sessions/a.jsonl", reachable: true },
    },
  });

  const changed = await recordAgentRuntimeProfile({
    serverId: server.id,
    agentId: agent.id,
    machineId: machine.id,
    daemonVersion: "0.40.2",
    facts: {
      runtime: "codex",
      model: "gpt-5.4-codex",
      reasoningEffort: "high",
      executionMode: "byoc",
      sessionRef: { label: "session-b", runtime: "codex", path: "/sessions/b.jsonl", reachable: true },
    },
  });

  assert.equal(changed.pending, null);
  assert.equal(await isRuntimeProfileMigrationGated(agent.id), false);

  const summary = await getAgentRuntimeProfileSummary(agent.id);
  assert.equal(summary?.migrationStatus, "stable");
  assert.equal(summary?.pending, null);
  assert.equal(summary?.current?.model, "gpt-5.4-codex");
  assert.equal(summary?.current?.sessionRef && typeof summary.current.sessionRef !== "string"
    ? summary.current.sessionRef.path
    : null, "/sessions/b.jsonl");
  assert.equal(await isRuntimeProfileMigrationGated(agent.id), false);
});

test("legacy runtime profile migration handled ack is a no-op in reset-session mode", async ({ db }) => {

  const { server, machine, agent } = await seedRuntimeProfileAgent();

  await recordAgentRuntimeProfile({
    serverId: server.id,
    agentId: agent.id,
    machineId: machine.id,
    daemonVersion: "0.40.2",
    facts: {
      runtime: "codex",
      model: "gpt-5.3-codex",
      reasoningEffort: "high",
      executionMode: "byoc",
    },
  });

  const changed = await recordAgentRuntimeProfile({
    serverId: server.id,
    agentId: agent.id,
    machineId: machine.id,
    daemonVersion: "0.40.2",
    facts: {
      runtime: "codex",
      model: "gpt-5.4-codex",
      reasoningEffort: "high",
      executionMode: "byoc",
    },
  });
  assert.equal(changed.pending, null);
  assert.equal(await markRuntimeProfileMigrationHandled(agent.id, "", "launch-1"), true);
  assert.equal(await markRuntimeProfileMigrationHandled(agent.id, "wrong-key", "launch-1"), true);
  assert.equal(await isRuntimeProfileMigrationGated(agent.id), false);
});

test("agent settings changes update the runtime profile baseline without prequeueing migration", async ({ db }) => {

  const { server, machine, agent } = await seedRuntimeProfileAgent();

  await recordAgentRuntimeProfile({
    serverId: server.id,
    agentId: agent.id,
    machineId: machine.id,
    daemonVersion: "0.40.2",
    facts: {
      runtime: "codex",
      model: "gpt-5.3-codex",
      reasoningEffort: "high",
      executionMode: "byoc",
      sessionRef: {
        label: "codex-session-1",
        runtime: "codex",
        path: "/sessions/codex-session-1.jsonl",
        reachable: true,
      },
    },
  });

  await getDb().update(agents)
    .set({ runtime: "claude", model: "sonnet", reasoningEffort: null })
    .where(eq(agents.id, agent.id));

  const queued = await queueRuntimeProfileMigrationForAgentSettings(agent.id);
  assert.equal(queued, null);
  assert.equal(await isRuntimeProfileMigrationGated(agent.id), false);

  const control = await getPendingRuntimeProfileControl(agent.id);
  assert.equal(control, null);

  const summary = await getAgentRuntimeProfileSummary(agent.id);
  assert.equal(summary?.migrationStatus, "stable");
  assert.equal(summary?.pending, null);
  assert.equal(summary?.current?.runtime, "claude");
  assert.equal(summary?.current?.model, "sonnet");
});

test("runtime profile daemon release notice folds pending upgrades to the latest version", async ({ db }) => {

  const { server, machine, agent } = await seedRuntimeProfileAgent();

  const facts = {
    runtime: "codex",
    model: "gpt-5.3-codex",
    reasoningEffort: "high" as const,
    executionMode: "byoc",
  };

  await recordAgentRuntimeProfile({
    serverId: server.id,
    agentId: agent.id,
    machineId: machine.id,
    daemonVersion: "0.40.1",
    facts,
  });

  const firstNotice = await recordAgentRuntimeProfile({
    serverId: server.id,
    agentId: agent.id,
    machineId: machine.id,
    daemonVersion: "0.40.2",
    facts,
  });
  assert.equal(firstNotice.pending?.pendingKind, "daemon_release_notice");
  const firstKey = firstNotice.pending?.pendingKey;
  assert.ok(firstKey);

  const foldedNotice = await recordAgentRuntimeProfile({
    serverId: server.id,
    agentId: agent.id,
    machineId: machine.id,
    daemonVersion: "0.40.3",
    facts,
  });
  assert.equal(foldedNotice.pending?.pendingKind, "daemon_release_notice");
  assert.notEqual(foldedNotice.pending?.pendingKey, firstKey);
  assert.equal(foldedNotice.pending?.pendingBeforeDaemonVersion, "0.40.1");
  assert.equal(foldedNotice.pending?.pendingAfterDaemonVersion, "0.40.3");
  assert.equal(await markRuntimeProfileMigrationDelivered(agent.id, firstKey, "launch-1"), false);
  assert.equal(await markRuntimeProfileMigrationDelivered(agent.id, foldedNotice.pending!.pendingKey!, "launch-1"), true);

  const [row] = await getDb().select()
    .from(agentRuntimeProfiles)
    .where(eq(agentRuntimeProfiles.agentId, agent.id))
    .limit(1);
  assert.equal(row.baselineDaemonVersion, "0.40.3");
  assert.equal(row.pendingKind, null);
});

test("runtime profile migration nudges are disabled in reset-session mode", async ({ db }) => {

  const { server, machine, agent } = await seedRuntimeProfileAgent();

  await recordAgentRuntimeProfile({
    serverId: server.id,
    agentId: agent.id,
    machineId: machine.id,
    daemonVersion: "0.40.2",
    facts: {
      runtime: "codex",
      model: "gpt-5.3-codex",
      reasoningEffort: "high",
      executionMode: "byoc",
    },
  });

  const changed = await recordAgentRuntimeProfile({
    serverId: server.id,
    agentId: agent.id,
    machineId: machine.id,
    daemonVersion: "0.40.2",
    facts: {
      runtime: "codex",
      model: "gpt-5.4-codex",
      reasoningEffort: "high",
      executionMode: "byoc",
    },
  });
  assert.equal(changed.pending, null);

  const deliveredAt = new Date();
  assert.equal(await getRuntimeProfileMigrationNudgeCandidate(
    agent.id,
    new Date(deliveredAt.getTime() + 4 * 60_000),
    5 * 60_000,
    15 * 60_000,
    3,
  ), null);

  assert.equal(await getRuntimeProfileMigrationNudgeCandidate(
    agent.id,
    new Date(deliveredAt.getTime() + 5 * 60_000 + 1),
    5 * 60_000,
    15 * 60_000,
    3,
  ), null);

  assert.equal(await getRuntimeProfileMigrationNudgeCandidate(
    agent.id,
    new Date(deliveredAt.getTime() + 10 * 60_000),
    5 * 60_000,
    15 * 60_000,
    3,
  ), null);

  await getDb().update(agentRuntimeProfiles)
    .set({ migrationNudgeCount: 3 })
    .where(eq(agentRuntimeProfiles.agentId, agent.id));
  assert.equal(await getRuntimeProfileMigrationNudgeCandidate(
    agent.id,
    new Date(deliveredAt.getTime() + 60 * 60_000),
    5 * 60_000,
    15 * 60_000,
    3,
  ), null);
});

test("runtime profile reset folds same-report daemon release notice into one ack", async ({ db }) => {

  const { server, machine, agent } = await seedRuntimeProfileAgent();

  await recordAgentRuntimeProfile({
    serverId: server.id,
    agentId: agent.id,
    machineId: machine.id,
    daemonVersion: "0.40.1",
    facts: {
      runtime: "codex",
      model: "gpt-5.3-codex",
      reasoningEffort: "high",
      executionMode: "byoc",
    },
  });

  const changed = await recordAgentRuntimeProfile({
    serverId: server.id,
    agentId: agent.id,
    machineId: machine.id,
    daemonVersion: "0.40.2",
    facts: {
      runtime: "codex",
      model: "gpt-5.4-codex",
      reasoningEffort: "high",
      executionMode: "byoc",
    },
  });
  assert.equal(changed.pending?.pendingKind, "daemon_release_notice");
  assert.ok(changed.pending?.pendingKey);
  assert.equal(changed.pending?.pendingReleaseNotesUrl, null);

  const migrationMessage = renderRuntimeProfileMigrationMessage(changed.pending!);
  assert.match(migrationMessage, /Runtime Profile notice: daemon upgraded 0.40.1 -> 0.40.2/);
  assert.match(migrationMessage, /Agent-facing daemon changes:/);
  assert.match(migrationMessage, /Runtime Profile migration, nudge, and daemon release notices are now mirrored into Activity Log after delivery/);

  assert.equal(await markRuntimeProfileMigrationDelivered(agent.id, changed.pending!.pendingKey!, "launch-1"), true);

  const summary = await getAgentRuntimeProfileSummary(agent.id);
  assert.equal(summary?.migrationStatus, "stable");
  assert.equal(summary?.pending, null);
  assert.equal(summary?.current?.daemonVersion, "0.40.2");

  const notice = await getPendingRuntimeProfileNotice(agent.id);
  assert.equal(notice, null);

  const [row] = await getDb().select()
    .from(agentRuntimeProfiles)
    .where(eq(agentRuntimeProfiles.agentId, agent.id))
    .limit(1);
  assert.equal(row.baselineDaemonVersion, "0.40.2");
  assert.equal(row.baselineModel, "gpt-5.4-codex");
});

test("runtime profile change with daemon upgrade but no agent-facing notes becomes stable immediately", async ({ db }) => {

  const { server, machine, agent } = await seedRuntimeProfileAgent();

  await recordAgentRuntimeProfile({
    serverId: server.id,
    agentId: agent.id,
    machineId: machine.id,
    daemonVersion: "0.40.2",
    facts: {
      runtime: "codex",
      model: "gpt-5.3-codex",
      reasoningEffort: "high",
      executionMode: "byoc",
    },
  });

  const changed = await recordAgentRuntimeProfile({
    serverId: server.id,
    agentId: agent.id,
    machineId: machine.id,
    daemonVersion: "0.40.3",
    facts: {
      runtime: "codex",
      model: "gpt-5.4-codex",
      reasoningEffort: "high",
      executionMode: "byoc",
    },
  });
  assert.equal(changed.pending, null);

  const summary = await getAgentRuntimeProfileSummary(agent.id);
  assert.equal(summary?.migrationStatus, "stable");
  assert.equal(summary?.pending, null);

  const [row] = await getDb().select()
    .from(agentRuntimeProfiles)
    .where(eq(agentRuntimeProfiles.agentId, agent.id))
    .limit(1);
  assert.equal(row.baselineDaemonVersion, "0.40.3");
  assert.equal(row.baselineModel, "gpt-5.4-codex");
});
