import { fixturePasswordHash } from "../test/integration/credentials.js";
import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";


import { getDb } from "../db/index.js";
import { users } from "../db/schema.js";
import { createAgent, assignMachine } from "../services/agentService.js";
import { registerMachine } from "../services/machineService.js";
import { createServer } from "../services/serverService.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

async function seedRuntimeProfileRouteFixture() {
  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: "runtime-profile-route-owner@slock.test",
    name: "runtime-profile-route-owner",
    displayName: "Runtime Profile Route Owner",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
  }).returning();
  const server = await createServer("Runtime Profile Route", "runtime-profile-route", owner.id);
  const agent = await createAgent(server.id, "runtime-profile-route-agent", {
    runtime: "codex",
    model: "gpt-5.4-codex",
  });
  const { machine, apiKey } = await registerMachine(server.id, owner.id, "runtime-profile-route-machine");
  await assignMachine(agent.id, machine.id);
  return { agent, apiKey };
}

function machineHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

test("legacy runtime-profile migration-done returns deprecated noop when no pending migration exists", async ({ app }) => {
  const { agent, apiKey } = await seedRuntimeProfileRouteFixture();
  let call: { agentId: string; migrationKey: string; launchId?: string | null } | null = null;
  app.app.set("agentOrchestrator", {
    completeRuntimeProfileMigrationFromAgent: async (
      agentId: string,
      migrationKey: string,
      launchId?: string | null,
    ) => {
      call = { agentId, migrationKey, launchId };
      return false;
    },
  });

  const res = await fetch(`${app.baseUrl}/internal/agent/${agent.id}/runtime-profile/migration-done`, {
    method: "POST",
    headers: {
      ...machineHeaders(apiKey),
      "X-Agent-Launch-Id": "legacy-launch",
    },
    body: JSON.stringify({ migrationKey: "" }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    ok: true,
    deprecated: true,
    noop: "no pending migration",
    message: "Runtime Profile migration acknowledgments are deprecated; runtime changes reset the session automatically.",
  });
  assert.deepEqual(call, {
    agentId: agent.id,
    migrationKey: "",
    launchId: "legacy-launch",
  });
});

test("legacy runtime-profile migration-done keeps handled acknowledgment response", async ({ app }) => {
  const { agent, apiKey } = await seedRuntimeProfileRouteFixture();
  app.app.set("agentOrchestrator", {
    completeRuntimeProfileMigrationFromAgent: async () => true,
  });

  const res = await fetch(`${app.baseUrl}/internal/agent/${agent.id}/runtime-profile/migration-done`, {
    method: "POST",
    headers: machineHeaders(apiKey),
    body: JSON.stringify({ migrationKey: "legacy-key" }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    ok: true,
    deprecated: true,
    message: "Runtime Profile migration acknowledgments are deprecated; runtime changes reset the session automatically.",
  });
});
