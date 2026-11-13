import { createApiTest } from "../test/integration/apiTest";
// raft-agent-status.v1 over `POST /internal/agent-api/activity`: an activity
// event may carry the agent's status (derived by the runtime's compat layer)
// with or without a hook. The live dot follows reported status with
// latest-occurredAt-wins; once an agent has reported any status, hook-derived
// status no longer drives its dot (hook events are still logged), durably.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { and, asc, eq } from "drizzle-orm";
import { EXTERNAL_AGENT_ACTIVITY_INGEST_SCHEMA, type TrajectoryEntry } from "@botiverse/raft-shared";

import { getDb } from "../db/index";
import { agentActivityEvents, agents, users } from "../db/schema";
import { fixturePasswordHash } from "../test/integration/credentials";
import { createServer } from "../services/serverService";
import { createAgent } from "../services/agentService";
import { mintAgentCredential } from "../services/agentCredentialService";
import { AgentOrchestrator } from "../services/agentOrchestrator";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

type TestApp = { baseUrl: string; app: { set: (key: string, value: unknown) => void } };

async function seedExternalAgent(name = "StatusExt") {
  const db = getDb();
  const suffix = randomUUID();
  const [owner] = await db.insert(users).values({
    email: `agent-status-${suffix}@slock.test`,
    name: `agent-status-${suffix}`,
    displayName: "Agent Status Owner",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
  }).returning();
  const server = await createServer("Agent Status Test", `agent-status-${suffix}`, owner!.id);
  const agent = await createAgent(server.id, name, { runtime: "external", model: "external" });
  const minted = await mintAgentCredential({
    agentId: agent.id,
    scopes: ["read"],
    name: "agent-status-test",
    issuedVia: "computer",
    createdByUserId: null,
  });
  return { agentId: agent.id, serverId: server.id, apiKey: minted.apiKey };
}

/** A fresh orchestrator (a new server process / another replica). */
function freshProcess(app: TestApp): AgentOrchestrator {
  const orchestrator = new AgentOrchestrator();
  app.app.set("agentOrchestrator", orchestrator);
  return orchestrator;
}

async function postActivity(app: TestApp, apiKey: string, events: unknown[]) {
  const res = await fetch(`${app.baseUrl}/internal/agent-api/activity`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ schema: EXTERNAL_AGENT_ACTIVITY_INGEST_SCHEMA, events }),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

function live(orchestrator: AgentOrchestrator, agentId: string) {
  const snapshot = (orchestrator as unknown as { agentActivity: Map<string, { activity: string; detail: string; detailKind: string }> })
    .agentActivity.get(agentId);
  return snapshot ? { activity: snapshot.activity, detail: snapshot.detail, detailKind: snapshot.detailKind } : undefined;
}

async function loggedEntries(agentId: string): Promise<Array<{ dedupeKey: string | null; entries: TrajectoryEntry[] }>> {
  const rows = await getDb()
    .select({ dedupeKey: agentActivityEvents.dedupeKey, entries: agentActivityEvents.entries })
    .from(agentActivityEvents)
    .where(eq(agentActivityEvents.agentId, agentId))
    .orderBy(asc(agentActivityEvents.createdAt));
  return rows.map((row) => ({ dedupeKey: row.dedupeKey, entries: (row.entries ?? []) as TrajectoryEntry[] }));
}

async function adoptedAt(agentId: string): Promise<Date | null> {
  const [row] = await getDb()
    .select({ adoptedAt: agents.statusProtocolAdoptedAt })
    .from(agents)
    .where(and(eq(agents.id, agentId)));
  return row?.adoptedAt ?? null;
}

const iso = (ms: number) => new Date(ms).toISOString();

test("status-only and hook+status events drive the live status with detail", async ({ app }) => {
  const orchestrator = freshProcess(app);
  const f = await seedExternalAgent();
  const t0 = Date.now() - 60_000;

  const statusOnly = await postActivity(app, f.apiKey, [
    { eventId: "st-1", status: "working", detail: "Running the test suite", occurredAt: iso(t0) },
  ]);
  assert.equal(statusOnly.status, 200);
  assert.deepEqual(statusOnly.body, { ok: true, acceptedCount: 1, rejectedCount: 0, droppedCount: 0 });
  assert.deepEqual(live(orchestrator, f.agentId), { activity: "working", detail: "Running the test suite", detailKind: "external_activity" });
  assert.ok(await adoptedAt(f.agentId), "the first accepted status marks the agent as a status.v1 reporter");

  // A hook event carrying status: the dot follows the status, the hook keeps
  // its usual log entry.
  const hookWithStatus = await postActivity(app, f.apiKey, [
    { eventId: "st-2", hookEventName: "PreToolUse", toolName: "Bash", toolInput: "ls", status: "thinking", occurredAt: iso(t0 + 1_000) },
  ]);
  assert.equal(hookWithStatus.status, 200);
  assert.equal(hookWithStatus.body.acceptedCount, 1);
  assert.deepEqual(live(orchestrator, f.agentId), { activity: "thinking", detail: "", detailKind: "external_activity" });

  const rows = await loggedEntries(f.agentId);
  const hookRow = rows.find((row) => row.dedupeKey === "external-agent-activity:st-2");
  assert.ok(hookRow, "the hook+status event is logged");
  assert.deepEqual(hookRow.entries.map((entry) => entry.kind), ["tool_start", "status"]);
  const statusEntry = hookRow.entries[1] as Extract<TrajectoryEntry, { kind: "status" }>;
  assert.equal(statusEntry.activity, "thinking");
  assert.equal(statusEntry.producerFactId, "external/status-reported:st-2");
});

test("status fields are validated with stable 400 codes; legacy hook-outcome status is still accepted", async ({ app }) => {
  freshProcess(app);
  const f = await seedExternalAgent();
  const now = iso(Date.now());

  const invalidStatus = await postActivity(app, f.apiKey, [{ eventId: "bad-1", status: "busy", occurredAt: now }]);
  assert.equal(invalidStatus.status, 400);
  assert.equal(invalidStatus.body.code, "status_invalid");

  const longDetail = await postActivity(app, f.apiKey, [{ eventId: "bad-2", status: "working", detail: "x".repeat(201), occurredAt: now }]);
  assert.equal(longDetail.status, 400);
  assert.equal(longDetail.body.code, "detail_too_long");

  const nonStringDetail = await postActivity(app, f.apiKey, [{ eventId: "bad-3", status: "working", detail: 7, occurredAt: now }]);
  assert.equal(nonStringDetail.status, 400);
  assert.equal(nonStringDetail.body.code, "detail_invalid");

  const exactLimit = await postActivity(app, f.apiKey, [{ eventId: "ok-200", status: "error", detail: "y".repeat(200), occurredAt: now }]);
  assert.equal(exactLimit.status, 200);
  assert.equal(exactLimit.body.acceptedCount, 1);

  // Pre-standard bridges send hook-outcome values in `status` (BridgeFatal
  // sends "failed"); those stay accepted and do not count as a status report.
  const g = await seedExternalAgent("LegacyExt");
  const legacy = await postActivity(app, g.apiKey, [
    { eventId: "legacy-1", hookEventName: "PostToolUseFailure", toolName: "Bash", status: "failed", occurredAt: now },
  ]);
  assert.equal(legacy.status, 200);
  assert.equal(legacy.body.acceptedCount, 1);
  assert.equal(await adoptedAt(g.agentId), null);

  // A status event without eventId or occurredAt cannot be ordered or deduped.
  const unorderable = await postActivity(app, g.apiKey, [
    { status: "working", occurredAt: now },
    { eventId: "no-time", status: "working" },
  ]);
  assert.equal(unorderable.status, 200);
  assert.deepEqual(unorderable.body, { ok: true, acceptedCount: 0, rejectedCount: 2, droppedCount: 0 });
  assert.equal(await adoptedAt(g.agentId), null);
});

test("latest occurredAt wins, replays are deduped by eventId, and a future occurredAt is clamped", async ({ app }) => {
  const orchestrator = freshProcess(app);
  const f = await seedExternalAgent();
  const t0 = Date.now() - 60_000;

  await postActivity(app, f.apiKey, [{ eventId: "newer", status: "working", detail: "Editing files", occurredAt: iso(t0 + 5_000) }]);
  assert.equal(live(orchestrator, f.agentId)?.activity, "working");

  // An older status arriving late does not override the newer one; it and the
  // hook it rides on are still logged as history (task #17: the hook's
  // Tool finished outcome row and the reported status itself).
  const older = await postActivity(app, f.apiKey, [
    { eventId: "older", hookEventName: "PostToolUse", toolName: "Bash", toolOutput: "ok", status: "online", occurredAt: iso(t0) },
  ]);
  assert.equal(older.body.acceptedCount, 1);
  assert.deepEqual(live(orchestrator, f.agentId), { activity: "working", detail: "Editing files", detailKind: "external_activity" });
  const olderRow = (await loggedEntries(f.agentId)).find((row) => row.dedupeKey === "external-agent-activity:older");
  assert.deepEqual(olderRow?.entries.map((entry) => entry.kind === "status" ? `status:${entry.detailKind}` : entry.kind), ["system", "status:tool_end", "status:external_activity"]);

  // Replaying an accepted eventId (even with a newer time) is skipped.
  const replay = await postActivity(app, f.apiKey, [
    { eventId: "newer", status: "offline", occurredAt: iso(t0 + 9_000) },
    { eventId: "dup-in-batch", status: "working", detail: "first", occurredAt: iso(t0 + 6_000) },
    { eventId: "dup-in-batch", status: "error", detail: "second", occurredAt: iso(t0 + 7_000) },
  ]);
  assert.deepEqual(replay.body, { ok: true, acceptedCount: 1, rejectedCount: 2, droppedCount: 0 });
  assert.deepEqual(live(orchestrator, f.agentId), { activity: "working", detail: "first", detailKind: "external_activity" });

  // Client clock an hour ahead: clamped to receive time, so a genuinely later
  // event still wins.
  await postActivity(app, f.apiKey, [{ eventId: "future", status: "error", detail: "Clock skew", occurredAt: iso(Date.now() + 3_600_000) }]);
  assert.equal(live(orchestrator, f.agentId)?.activity, "error");
  await new Promise((resolve) => setTimeout(resolve, 5));
  await postActivity(app, f.apiKey, [{ eventId: "after-future", status: "online", occurredAt: iso(Date.now()) }]);
  assert.deepEqual(live(orchestrator, f.agentId), { activity: "online", detail: "", detailKind: "external_activity" });
});

test("once an agent reports status, hook events are logged but no longer drive its dot, durably", async ({ app }) => {
  let orchestrator = freshProcess(app);
  const reporter = await seedExternalAgent("ReporterExt");
  const hooksOnly = await seedExternalAgent("HooksOnlyExt");
  const t0 = Date.now() - 60_000;

  // Before adoption: hook events drive the dot as before (and keep doing so
  // for an agent that never reports status).
  await postActivity(app, reporter.apiKey, [{ eventId: "h-1", hookEventName: "PreToolUse", toolName: "Bash", occurredAt: iso(t0) }]);
  assert.equal(live(orchestrator, reporter.agentId)?.activity, "working");
  await postActivity(app, hooksOnly.apiKey, [{ eventId: "o-1", hookEventName: "PreToolUse", toolName: "Bash", occurredAt: iso(t0) }]);
  assert.equal(live(orchestrator, hooksOnly.agentId)?.activity, "working");
  await postActivity(app, hooksOnly.apiKey, [{ eventId: "o-2", hookEventName: "Stop", occurredAt: iso(t0 + 1_000) }]);
  assert.equal(live(orchestrator, hooksOnly.agentId)?.activity, "online");
  assert.equal(await adoptedAt(hooksOnly.agentId), null);

  // Adoption: one status report.
  await postActivity(app, reporter.apiKey, [{ eventId: "s-1", status: "online", occurredAt: iso(t0 + 2_000) }]);
  assert.equal(live(orchestrator, reporter.agentId)?.activity, "online");
  const firstAdoptedAt = await adoptedAt(reporter.agentId);
  assert.ok(firstAdoptedAt);

  // A later hook event is logged but leaves the dot alone.
  const later = await postActivity(app, reporter.apiKey, [
    { eventId: "h-2", hookEventName: "PreToolUse", toolName: "Bash", toolInput: "make", occurredAt: iso(t0 + 3_000) },
  ]);
  assert.equal(later.body.acceptedCount, 1);
  assert.equal(live(orchestrator, reporter.agentId)?.activity, "online");
  const h2 = (await loggedEntries(reporter.agentId)).find((row) => row.dedupeKey === "external-agent-activity:h-2");
  assert.deepEqual(h2?.entries.map((entry) => entry.kind), ["tool_start"]);

  // The flag is durable: a new process (another replica / restart) reads it
  // from the agents row, and a second status report does not move it.
  orchestrator = freshProcess(app);
  await postActivity(app, reporter.apiKey, [{ eventId: "s-2", status: "thinking", occurredAt: iso(t0 + 4_000) }]);
  assert.equal(live(orchestrator, reporter.agentId)?.activity, "thinking");
  assert.deepEqual(await adoptedAt(reporter.agentId), firstAdoptedAt);
  orchestrator = freshProcess(app);
  await postActivity(app, reporter.apiKey, [{ eventId: "h-3", hookEventName: "SessionEnd", occurredAt: iso(t0 + 5_000) }]);
  assert.equal(live(orchestrator, reporter.agentId), undefined, "a hook event after adoption does not project live status");
  assert.equal(await orchestrator.isExternalStatusProtocolAdopted(reporter.agentId), true);
  assert.equal(await orchestrator.isExternalStatusProtocolAdopted(hooksOnly.agentId), false);

  // The hooks-only agent is unaffected in the new process as well.
  await postActivity(app, hooksOnly.apiKey, [{ eventId: "o-3", hookEventName: "PreToolUse", toolName: "Bash", occurredAt: iso(t0 + 6_000) }]);
  assert.equal(live(orchestrator, hooksOnly.agentId)?.activity, "working");
});
