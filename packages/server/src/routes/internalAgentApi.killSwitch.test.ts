import { fixturePasswordHash } from "../test/integration/credentials.js";
import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";


import { getDb } from "../db/index.js";
import { users } from "../db/schema.js";
import { openTestApp } from "../test/integration/app.js";
import { createServer } from "../services/serverService.js";
import { createAgent } from "../services/agentService.js";
import { createChannel, addAgent, addHuman } from "../services/channelService.js";
import { registerMachine } from "../services/machineService.js";
import { mintAgentCredential } from "../services/agentCredentialService.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

type KillSwitchFixture = {
  agentId: string;
  machineApiKey: string;
  agentApiKey: string;
};

function jsonHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

async function seedKillSwitchFixture(): Promise<KillSwitchFixture> {
  const db = getDb();
  const suffix = randomUUID();
  const [owner] = await db.insert(users).values({
    email: `agent-api-kill-switch-${suffix}@slock.test`,
    name: `agent-api-kill-switch-${suffix}`,
    displayName: "Agent API Kill Switch Owner",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
  }).returning();

  const server = await createServer("Agent API Kill Switch Test", `agent-api-kill-switch-${suffix}`, owner.id);
  const agent = await createAgent(server.id, "AgentApiKillSwitchBot", { runtime: "claude", model: "sonnet" });
  const channel = await createChannel(server.id, "agent-api-kill-switch-room");
  await addHuman(channel.id, owner.id);
  await addAgent(channel.id, agent.id);

  const { apiKey: machineApiKey } = await registerMachine(server.id, owner.id, "agent-api-kill-switch-machine");
  const { apiKey: agentApiKey } = await mintAgentCredential({
    agentId: agent.id,
    scopes: ["read"],
    name: "kill-switch-agent",
    createdByUserId: null,
  });

  return {
    agentId: agent.id,
    machineApiKey,
    agentApiKey,
  };
}

test("experimental internal surfaces have a stable operator kill switch", async () => {
  const original = process.env.SLOCK_EXPERIMENTAL_SURFACES_DISABLED;
  process.env.SLOCK_EXPERIMENTAL_SURFACES_DISABLED = "true";
  const originalWarn = console.warn;
  const warnings: unknown[][] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };

  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    const fixture = await seedKillSwitchFixture();

    const agentApi = await fetch(`${app.baseUrl}/internal/agent-api`, {
      headers: jsonHeaders(fixture.agentApiKey),
    });
    assert.equal(agentApi.status, 503);
    assert.equal(agentApi.headers.get("Sec-Slock-Api-Version"), "1");
    assert.deepEqual(await agentApi.json(), {
      error: "Experimental internal surface is disabled",
      code: "experimental_surface_disabled",
      retry_after: null,
    });

    const computer = await fetch(`${app.baseUrl}/internal/computer/runners/${fixture.agentId}/credentials`, {
      method: "POST",
      headers: jsonHeaders(fixture.machineApiKey),
      body: JSON.stringify({ scopes: ["read"] }),
    });
    assert.equal(computer.status, 503);
    assert.equal(computer.headers.get("Sec-Slock-Api-Version"), "1");
    assert.deepEqual(await computer.json(), {
      error: "Experimental internal surface is disabled",
      code: "experimental_surface_disabled",
      retry_after: null,
    });
    assert.ok(warnings.some((args) => args[0] === "[experimental-surface-disabled]"));
  } finally {
    await app.close();
    console.warn = originalWarn;
    if (original === undefined) {
      delete process.env.SLOCK_EXPERIMENTAL_SURFACES_DISABLED;
    } else {
      process.env.SLOCK_EXPERIMENTAL_SURFACES_DISABLED = original;
    }
  }
});
