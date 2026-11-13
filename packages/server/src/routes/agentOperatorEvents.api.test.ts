// #proj-runtime:#51: a person's start, stop, restart, reset and Stop Current
// Turn are recorded once, after the action was accepted and never when it was
// refused; Raft's own restarts fold into one row a minute; the overview reads
// them, with model changes, through GET /api/agents/:id/operator-events.
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import type { AgentOperatorEventsPage } from "@botiverse/raft-shared";
import { tokenForHuman, fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import { getDb } from "../db/index";
import { agentOperatorEvents, machines, serverMembers, users } from "../db/schema";
import { createServer } from "../services/serverService";
import { createAgent } from "../services/agentService";
import { placeAgentOnMachine } from "../test/agentMachineFixture";
import { recordAgentConfigChange } from "../services/agentConfigChangeEvents";
import { recordAgentOperatorEvent, recordAgentSystemRestart, SYSTEM_RESTART_DEDUPE_MS } from "../services/agentOperatorEvents";

const test = createApiTest();

async function seedUser(email: string, name: string) {
  const [user] = await getDb().insert(users).values({
    email,
    name,
    displayName: name,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user;
}

const authHeaders = (token: string, serverId: string) => ({ Authorization: `Bearer ${token}`, "X-Server-Id": serverId, "Content-Type": "application/json" });

async function rowsFor(agentId: string) {
  return getDb().select().from(agentOperatorEvents).where(eq(agentOperatorEvents.agentId, agentId)).orderBy(agentOperatorEvents.occurredAt);
}

async function seedAgent(slug: string) {
  const owner = await seedUser(`${slug}-owner@slock.test`, `${slug}-owner`);
  const server = await createServer(`${slug} server`, `${slug}-server`, owner.id);
  const agent = await createAgent(server.id, `${slug}-agent`, { runtime: "codex", creatorType: "user", creatorId: owner.id });
  return { owner, server, agent, token: await tokenForHuman(owner.email) };
}

test("restart, Reset Session and stop are recorded once with the person who did them; a refused reset records nothing", async ({ app }) => {
  const { owner, server, agent, token } = await seedAgent("opev-reset");
  const member = await seedUser("opev-reset-member@slock.test", "opev-reset-member");
  await getDb().insert(serverMembers).values({ serverId: server.id, userId: member.id, role: "member" });
  const original = app.app.get("agentOrchestrator");
  app.app.set("agentOrchestrator", { ...original, resetAgent: async () => undefined, stopAgent: async () => ({ delivered: true }) });
  onTestFinished(() => {
    app.app.set("agentOrchestrator", original);
  });

  for (const mode of ["restart", "session"] as const) {
    const res = await fetch(`${app.baseUrl}/api/agents/${agent.id}/reset`, { method: "POST", headers: authHeaders(token, server.id), body: JSON.stringify({ mode }) });
    assert.equal(res.status, 202);
  }
  // A member may not fully reset someone else's agent: refused, nothing recorded.
  const memberToken = await tokenForHuman(member.email);
  const refused = await fetch(`${app.baseUrl}/api/agents/${agent.id}/reset`, { method: "POST", headers: authHeaders(memberToken, server.id), body: JSON.stringify({ mode: "full" }) });
  assert.equal(refused.status, 403);
  const stop = await fetch(`${app.baseUrl}/api/agents/${agent.id}/stop`, { method: "POST", headers: authHeaders(token, server.id) });
  assert.equal(stop.status, 200);

  const rows = await rowsFor(agent.id);
  assert.deepEqual(rows.map((row) => row.kind), ["restart", "reset_session", "stop"]);
  assert.ok(rows.every((row) => row.actorKind === "user" && row.actorUserId === owner.id && row.serverId === server.id));
});

test("Start is recorded only once the start was dispatched; a start refused for a missing Computer records nothing", async ({ app }) => {
  const { owner, server, agent, token } = await seedAgent("opev-start");
  const unplaced = await fetch(`${app.baseUrl}/api/agents/${agent.id}/start`, { method: "POST", headers: authHeaders(token, server.id) });
  assert.equal(unplaced.status, 409);
  assert.equal((await rowsFor(agent.id)).length, 0);

  const [machine] = await getDb().insert(machines).values({ serverId: server.id, userId: owner.id, name: "opev-machine", apiKeyHash: "opev-machine-hash", runtimes: ["codex"] }).returning();
  await placeAgentOnMachine(agent.id, machine.id);
  const original = app.app.get("agentOrchestrator");
  app.app.set("agentOrchestrator", {
    ...original,
    isMachineAccessRevoked: async () => false,
    hasMachineLocally: () => true,
    startAgent: async () => ({ outcome: "dispatched" }),
  });
  onTestFinished(() => {
    app.app.set("agentOrchestrator", original);
  });
  const started = await fetch(`${app.baseUrl}/api/agents/${agent.id}/start`, { method: "POST", headers: authHeaders(token, server.id) });
  assert.equal(started.status, 200);
  const rows = await rowsFor(agent.id);
  assert.deepEqual(rows.map((row) => [row.kind, row.actorUserId]), [["start", owner.id]]);
});

test("Stop Current Turn is recorded when a turn was stopped, not when none was running or the Computer could not", async ({ app }) => {
  const { owner, server, agent, token } = await seedAgent("opev-turn");
  const original = app.app.get("agentOrchestrator");
  let outcome: Record<string, unknown> = { outcome: "not_running" };
  app.app.set("agentOrchestrator", { ...original, interruptAgentTurn: async () => outcome });
  onTestFinished(() => {
    app.app.set("agentOrchestrator", original);
  });
  const post = () => fetch(`${app.baseUrl}/api/agents/${agent.id}/interrupt-turn`, { method: "POST", headers: authHeaders(token, server.id) });

  assert.equal((await post()).status, 200);
  outcome = { outcome: "computer_offline" };
  assert.equal((await post()).status, 409);
  assert.equal((await rowsFor(agent.id)).length, 0, "nothing stopped, nothing recorded");
  outcome = { outcome: "interrupted" };
  assert.equal((await post()).status, 200);
  outcome = { outcome: "restarted", toolName: "bash", stuckForMs: 700_000 };
  assert.equal((await post()).status, 200);
  const rows = await rowsFor(agent.id);
  assert.deepEqual(rows.map((row) => [row.kind, row.actorUserId]), [["turn_stopped", owner.id], ["turn_stopped", owner.id]]);
});

test("Raft's own restarts write at most one row per agent a minute, with no person", async ({ db: _db }) => {
  const { agent } = await seedAgent("opev-system");
  const t0 = new Date("2026-11-10T10:00:00Z");
  assert.equal(await recordAgentSystemRestart(agent.id, t0), true);
  assert.equal(await recordAgentSystemRestart(agent.id, new Date(t0.getTime() + 5_000)), false, "a crash loop folds");
  assert.equal(await recordAgentSystemRestart(agent.id, new Date(t0.getTime() + SYSTEM_RESTART_DEDUPE_MS + 1_000)), true);
  assert.equal(await recordAgentSystemRestart("00000000-0000-4000-8000-000000000000"), false, "an unknown agent is not an error");
  const rows = await rowsFor(agent.id);
  assert.deepEqual(rows.map((row) => [row.kind, row.actorKind, row.actorUserId]), [["system_restart", "system", null], ["system_restart", "system", null]]);
});

test("GET operator-events: newest first in the window, with model changes, names only for members, and the overview's access", async ({ app }) => {
  const { owner, server, agent, token } = await seedAgent("opev-list");
  const departed = await seedUser("opev-list-departed@slock.test", "opev-list-departed");
  const member = await seedUser("opev-list-member@slock.test", "opev-list-member");
  await getDb().insert(serverMembers).values({ serverId: server.id, userId: member.id, role: "member" });
  const [source] = await getDb().insert(machines).values({ serverId: server.id, userId: owner.id, name: "laptop", apiKeyHash: "opev-src", runtimes: ["codex"] }).returning();
  const [target] = await getDb().insert(machines).values({ serverId: server.id, userId: owner.id, name: "hetzner-1", apiKeyHash: "opev-dst", runtimes: ["codex"] }).returning();
  const at = (minute: number) => new Date(Date.UTC(2026, 10, 10, 10, minute));
  await recordAgentOperatorEvent({ serverId: server.id, agentId: agent.id, kind: "restart", actorUserId: owner.id, occurredAt: at(1) });
  await recordAgentOperatorEvent({ serverId: server.id, agentId: agent.id, kind: "stop", actorUserId: departed.id, occurredAt: at(2) });
  await recordAgentOperatorEvent({ serverId: server.id, agentId: agent.id, kind: "migration_started", actorUserId: owner.id, occurredAt: at(3), details: { fromMachineId: source.id, toMachineId: target.id } });
  await recordAgentSystemRestart(agent.id, at(4));
  await recordAgentConfigChange(getDb(), {
    serverId: server.id,
    agentId: agent.id,
    source: "agents_route_update",
    actor: { kind: "user", id: owner.id },
    before: { runtime: "codex", model: "gpt-5", reasoningEffort: null },
    after: { runtime: "codex", model: "gpt-5.6", reasoningEffort: null },
    changedAt: at(5),
  });
  await recordAgentOperatorEvent({ serverId: server.id, agentId: agent.id, kind: "start", actorUserId: owner.id, occurredAt: at(30) });

  const get = async (query: string, bearer = token) => {
    const res = await fetch(`${app.baseUrl}/api/agents/${agent.id}/operator-events${query}`, { headers: authHeaders(bearer, server.id) });
    return { status: res.status, body: await res.json() as AgentOperatorEventsPage };
  };
  const { status, body } = await get(`?since=${at(0).getTime()}&until=${at(10).getTime()}`);
  assert.equal(status, 200);
  assert.equal(body.truncated, false);
  assert.deepEqual(body.events.map((event) => event.kind), ["config_changed", "system_restart", "migration_started", "stop", "restart"], "newest first; the start at :30 is outside the window; the creation is not listed");
  const ownerName = "opev-list-owner";
  assert.deepEqual(body.events[0]!.actor, { kind: "user", name: ownerName });
  assert.deepEqual(body.events[0]!.details, { beforeModel: "gpt-5", afterModel: "gpt-5.6" });
  assert.deepEqual(body.events[1]!.actor, { kind: "system" });
  assert.deepEqual(body.events[2]!.details, { fromComputer: "laptop", toComputer: "hetzner-1" });
  assert.deepEqual(body.events[3]!.actor, { kind: "user", name: null }, "a person no longer on the server is not named");

  const limited = await get(`?since=${at(0).getTime()}&limit=2`);
  assert.deepEqual(limited.body.events.map((event) => event.kind), ["start", "config_changed"]);
  assert.equal(limited.body.truncated, true);

  // A member who can't inspect someone else's agent can't read its actions either.
  const forbidden = await get("", await tokenForHuman(member.email));
  assert.equal(forbidden.status, 403);
  const rows = await getDb().select().from(agentOperatorEvents).where(and(eq(agentOperatorEvents.agentId, agent.id), eq(agentOperatorEvents.kind, "stop")));
  assert.equal(rows.length, 1);
});
