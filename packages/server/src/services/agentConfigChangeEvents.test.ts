import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { asc, eq } from "drizzle-orm";
import { getDb } from "../db/index";
import { agentConfigChangeEvents, agents, oauthClientInstalls, users } from "../db/schema";
import { createAgent, updateAgent } from "./agentService";
import { createServer } from "./serverService";
import { agentConfigChanged } from "./agentConfigChangeEvents";
import { createManagedAppBot } from "./appBotIdentityService";
import { createOAuthClient } from "./oauthService";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

async function seedServer(label: string) {
  const [owner] = await getDb().insert(users).values({
    email: `${label}-${randomUUID()}@slock.test`,
    name: `${label}-${randomUUID().slice(0, 8)}`,
    displayName: label,
    passwordHash: "test-hash",
    emailVerified: true,
  }).returning();
  const server = await createServer(label, `${label}-${randomUUID()}`, owner.id);
  return { owner, server };
}

async function eventsFor(agentId: string) {
  return getDb().select().from(agentConfigChangeEvents)
    .where(eq(agentConfigChangeEvents.agentId, agentId))
    .orderBy(asc(agentConfigChangeEvents.changedAt));
}

test("creating an agent records its initial configuration with no before values", async ({ app }) => {
  const { owner, server } = await seedServer("cfg-create");
  const agent = await createAgent(server.id, "cfg-create-agent", {
    runtime: "codex",
    model: "gpt-5.5",
    reasoningEffort: "high",
    envVars: { SECRET_TOKEN: "do-not-copy" },
    creatorType: "user",
    creatorId: owner.id,
  });

  const events = await eventsFor(agent.id);
  assert.equal(events.length, 1);
  const [event] = events;
  assert.equal(event.serverId, server.id);
  assert.equal(event.source, "agent_create");
  assert.equal(event.actorKind, "user");
  assert.equal(event.actorId, owner.id);
  assert.equal(event.beforeRuntime, null);
  assert.equal(event.beforeModel, null);
  assert.equal(event.beforeReasoningEffort, null);
  assert.equal(event.afterRuntime, "codex");
  assert.equal(event.afterModel, "gpt-5.5");
  assert.equal(event.afterReasoningEffort, "high");
  assert.equal(event.changedAt.toISOString(), agent.createdAt.toISOString());
  assert.ok(!JSON.stringify(event).includes("do-not-copy"));
});

test("a model change writes one event with the exact before and after values", async ({ app }) => {
  const { owner, server } = await seedServer("cfg-change");
  const agent = await createAgent(server.id, "cfg-change-agent", { runtime: "codex", model: "gpt-5.5" });

  await updateAgent(agent.id, { runtime: "codex", model: "gpt-5.6-sol", reasoningEffort: "medium" }, {
    configChange: { source: "agents_route_update", actor: { kind: "user", id: owner.id } },
  });

  const events = await eventsFor(agent.id);
  assert.equal(events.length, 2);
  const change = events.find((event) => event.beforeRuntime !== null)!;
  assert.equal(change.source, "agents_route_update");
  assert.equal(change.actorKind, "user");
  assert.equal(change.actorId, owner.id);
  assert.equal(change.beforeRuntime, "codex");
  assert.equal(change.afterRuntime, "codex");
  assert.equal(change.beforeModel, "gpt-5.5");
  assert.equal(change.afterModel, "gpt-5.6-sol");
  assert.equal(change.beforeReasoningEffort, null);
  assert.equal(change.afterReasoningEffort, "medium");
  const [row] = await getDb().select({ updatedAt: agents.updatedAt }).from(agents).where(eq(agents.id, agent.id));
  assert.equal(change.changedAt.toISOString(), row.updatedAt.toISOString(), "same write, same timestamp");
});

test("a runtime-only or effort-only change is recorded; the default source and actor are explicit unknowns", async ({ app }) => {
  const { server } = await seedServer("cfg-runtime");
  const agent = await createAgent(server.id, "cfg-runtime-agent", { runtime: "codex", model: "gpt-5.5" });

  await updateAgent(agent.id, { reasoningEffort: "low" });
  await updateAgent(agent.id, { runtime: "claude", model: "gpt-5.5" });

  const events = await eventsFor(agent.id);
  assert.equal(events.length, 3);
  const changes = events.filter((event) => event.beforeRuntime !== null);
  assert.deepEqual(changes.map((event) => [event.source, event.actorKind, event.actorId]), [
    ["agent_update", null, null],
    ["agent_update", null, null],
  ]);
  const effort = changes.find((event) => event.afterReasoningEffort === "low")!;
  assert.deepEqual([effort.beforeRuntime, effort.afterRuntime, effort.beforeReasoningEffort], ["codex", "codex", null]);
  const runtime = changes.find((event) => event.afterRuntime === "claude")!;
  assert.deepEqual([runtime.beforeRuntime, runtime.beforeModel, runtime.afterModel], ["codex", "gpt-5.5", "gpt-5.5"]);
  assert.deepEqual([runtime.beforeReasoningEffort, runtime.afterReasoningEffort], ["low", "low"]);
});

test("an update that writes the same runtime, model and effort records nothing", async ({ app }) => {
  const { server } = await seedServer("cfg-noop");
  const agent = await createAgent(server.id, "cfg-noop-agent", { runtime: "codex", model: "gpt-5.5", reasoningEffort: "high" });

  await updateAgent(agent.id, { runtime: "codex", model: "gpt-5.5", reasoningEffort: "high" });

  assert.equal((await eventsFor(agent.id)).length, 1, "only the creation event");
});

test("updates of unrelated columns record nothing", async ({ app }) => {
  const { server } = await seedServer("cfg-unrelated");
  const agent = await createAgent(server.id, "cfg-unrelated-agent", { runtime: "codex", model: "gpt-5.5" });

  await updateAgent(agent.id, { displayName: "Renamed", description: "new description", avatarUrl: "pixel:x" });
  await updateAgent(agent.id, { envVars: { A: "b" }, sessionId: null });
  await updateAgent(agent.id, {
    runtimeConfig: {
      version: 1,
      runtime: "codex",
      model: { kind: "preset", id: "gpt-5.5" },
      mode: { kind: "default" },
      reasoningEffort: null,
      envVars: null,
    },
  });

  assert.equal((await eventsFor(agent.id)).length, 1, "only the creation event");
});

test("the event commits with the agents row: a rolled-back update leaves neither", async ({ app }) => {
  const { server } = await seedServer("cfg-rollback");
  const agent = await createAgent(server.id, "cfg-rollback-agent", { runtime: "codex", model: "gpt-5.5" });

  await assert.rejects(getDb().transaction(async (tx) => {
    await updateAgent(agent.id, { model: "gpt-5.6-sol" }, { executor: tx });
    throw new Error("abort");
  }), /abort/);

  const [row] = await getDb().select({ model: agents.model }).from(agents).where(eq(agents.id, agent.id));
  assert.equal(row.model, "gpt-5.5");
  assert.equal((await eventsFor(agent.id)).length, 1);
});

test("an App bot's creation records its initial configuration with no actor", async ({ app }) => {
  const { owner, server } = await seedServer("cfg-app-bot");
  const { client } = await createOAuthClient({
    serverId: server.id,
    createdByUserId: owner.id,
    clientId: `cfg-bot-${randomUUID().slice(0, 8)}`,
    name: "Cfg Bot",
    enableBot: true,
  });
  const [install] = await getDb().insert(oauthClientInstalls).values({
    serverId: server.id,
    clientId: client.id,
    installedByUserId: owner.id,
    status: "active",
    botGrant: "granted",
  }).returning();
  const bot = await getDb().transaction((tx) => createManagedAppBot(tx, { installId: install!.id, serverId: server.id }));

  const events = await eventsFor(bot.agentId);
  assert.equal(events.length, 1);
  assert.equal(events[0].source, "app_bot_create");
  assert.equal(events[0].actorKind, null);
  assert.equal(events[0].beforeRuntime, null);
  assert.equal(events[0].afterRuntime, "external");
});

test("agentConfigChanged treats null and missing effort alike", () => {
  const base = { runtime: "codex", model: "m", reasoningEffort: null };
  assert.equal(agentConfigChanged(null, base), true);
  assert.equal(agentConfigChanged(base, { ...base }), false);
  assert.equal(agentConfigChanged(base, { ...base, model: "n" }), true);
  assert.equal(agentConfigChanged(base, { ...base, runtime: "claude" }), true);
  assert.equal(agentConfigChanged(base, { ...base, reasoningEffort: "low" }), true);
});
