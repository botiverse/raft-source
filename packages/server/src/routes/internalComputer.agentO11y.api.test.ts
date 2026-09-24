import { fixturePasswordHash } from "../test/integration/credentials.js";
import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";


import { getDb } from "../db/index.js";
import { computers, users } from "../db/schema.js";
import { createAgent, assignMachine } from "../services/agentService.js";
import { registerMachine } from "../services/machineService.js";
import { generateComputerApiKeyMaterial } from "../services/computerCredentialService.js";
import { createServer } from "../services/serverService.js";
import {
  AGENT_O11Y_WRITER_APP_KEY,
  AgentO11yWriterUnavailableError,
  mapAgentO11yPayloadTierToPayloadMode,
  type AgentO11yScopeDbWriter,
  type AgentO11yTenancy,
} from "../services/agentO11yScopeDbWriter.js";
import type { AgentO11yAcceptedEvent } from "../services/agentO11yValidation.js";
import { openTestApp } from "../test/integration/app.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

function jsonHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
}

function validEvent(agentId: string): Record<string, unknown> {
  return {
    event_kind: "turn",
    agent_id: agentId,
    turn_id: "turn-test-1",
    occurred_at: "2026-05-24T10:00:00.000Z",
    payload_tier: "T0",
    turn_trigger_hash: "sha256:turn-trigger",
    fields: { wake_trigger: "task_event" },
  };
}

async function seedFixture(): Promise<{
  computerApiKey: string;
  serverId: string;
  computerId: string;
  agentId: string;
  otherServerAgentId: string;
}> {
  const db = getDb();
  const suffix = randomUUID();
  const [owner] = await db
    .insert(users)
    .values({
      email: `agent-o11y-${suffix}@slock.test`,
      name: `agent-o11y-${suffix}`,
      displayName: "Agent O11y Owner",
      passwordHash: await fixturePasswordHash("password123"),
      emailVerified: true,
    })
    .returning();

  const server = await createServer("Agent O11y Test", `agent-o11y-${suffix}`, owner.id);
  const otherServer = await createServer("Agent O11y Other", `agent-o11y-other-${suffix}`, owner.id);
  const agent = await createAgent(server.id, "O11yBot", { runtime: "claude", model: "sonnet" });
  const otherAgent = await createAgent(otherServer.id, "OtherO11yBot", { runtime: "claude", model: "sonnet" });
  // Computer credentials only authorize agents bound to the Computer's own machine.
  const { machine } = await registerMachine(server.id, owner.id, "agent-o11y-machine");
  await assignMachine(agent.id, machine.id);

  const material = await generateComputerApiKeyMaterial();
  const [computer] = await db
    .insert(computers)
    .values({
      serverId: server.id,
      name: "agent-o11y-computer",
      apiKeyHash: material.apiKeyHash,
      apiKeyPrefix: material.apiKeyPrefix,
      attachedByUserId: owner.id,
      machineId: machine.id,
    })
    .returning();

  return {
    computerApiKey: material.apiKey,
    serverId: server.id,
    computerId: computer.id,
    agentId: agent.id,
    otherServerAgentId: otherAgent.id,
  };
}

test("agent-o11y: accepts validated events and derives tenancy from Computer auth", async ({ app }) => {
  const fixture = await seedFixture();
  const calls: Array<{ events: readonly AgentO11yAcceptedEvent[]; tenancy: AgentO11yTenancy }> = [];
  const writer: AgentO11yScopeDbWriter = {
    async writeEvents(events, tenancy) {
      calls.push({ events, tenancy });
      return { accepted: events.length };
    },
  };
  app.app.set(AGENT_O11Y_WRITER_APP_KEY, writer);

  const res = await fetch(`${app.baseUrl}/internal/computer/agent-o11y/events`, {
    method: "POST",
    headers: jsonHeaders(fixture.computerApiKey),
    body: JSON.stringify({ events: [validEvent(fixture.agentId)] }),
  });

  assert.equal(res.status, 202);
  assert.deepEqual(await res.json(), { ok: true, accepted: 1 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.tenancy.server_id, fixture.serverId);
  assert.equal(calls[0]?.tenancy.computer_id, fixture.computerId);
  assert.equal(calls[0]?.tenancy.machine_id, null);
  assert.equal(calls[0]?.events[0]?.payload_tier, "T0");
});

test("agent-o11y: rejects stale payload_mode wire field before writer", async ({ app }) => {
  const fixture = await seedFixture();
  let writes = 0;
  app.app.set(AGENT_O11Y_WRITER_APP_KEY, {
    async writeEvents() {
      writes += 1;
      return { accepted: 1 };
    },
  } satisfies AgentO11yScopeDbWriter);

  const event = validEvent(fixture.agentId);
  event.payload_mode = "T0";
  const res = await fetch(`${app.baseUrl}/internal/computer/agent-o11y/events`, {
    method: "POST",
    headers: jsonHeaders(fixture.computerApiKey),
    body: JSON.stringify({ events: [event] }),
  });

  assert.equal(res.status, 400);
  const body = (await res.json()) as { ok: boolean; code: string; message: string };
  assert.equal(body.ok, false);
  assert.equal(body.code, "agent_o11y_invalid_event");
  assert.match(body.message, /payload_mode/);
  assert.equal(writes, 0);
});

test("agent-o11y: rejects non-canonical turn_id carrier shapes", async ({ app }) => {
  const fixture = await seedFixture();
  const event = validEvent(fixture.agentId);
  event.turnId = "camel-case-not-allowed";

  const res = await fetch(`${app.baseUrl}/internal/computer/agent-o11y/events`, {
    method: "POST",
    headers: jsonHeaders(fixture.computerApiKey),
    body: JSON.stringify({ events: [event] }),
  });

  assert.equal(res.status, 400);
  const body = (await res.json()) as { code: string; message: string };
  assert.equal(body.code, "agent_o11y_invalid_event");
  assert.match(body.message, /turnId/);
});

test("agent-o11y: rejects body-supplied tenant identity", async ({ app }) => {
  const fixture = await seedFixture();
  const event = validEvent(fixture.agentId);
  event.server_id = randomUUID();

  const res = await fetch(`${app.baseUrl}/internal/computer/agent-o11y/events`, {
    method: "POST",
    headers: jsonHeaders(fixture.computerApiKey),
    body: JSON.stringify({ events: [event] }),
  });

  assert.equal(res.status, 400);
  const body = (await res.json()) as { code: string; message: string };
  assert.equal(body.code, "agent_o11y_invalid_event");
  assert.match(body.message, /server_id/);
});

test("agent-o11y: rejects agent ids outside the authenticated server", async ({ app }) => {
  const fixture = await seedFixture();
  let writes = 0;
  app.app.set(AGENT_O11Y_WRITER_APP_KEY, {
    async writeEvents() {
      writes += 1;
      return { accepted: 1 };
    },
  } satisfies AgentO11yScopeDbWriter);

  const res = await fetch(`${app.baseUrl}/internal/computer/agent-o11y/events`, {
    method: "POST",
    headers: jsonHeaders(fixture.computerApiKey),
    body: JSON.stringify({ events: [validEvent(fixture.otherServerAgentId)] }),
  });

  assert.equal(res.status, 403);
  assert.equal((await res.json() as { code: string }).code, "agent_o11y_agent_not_in_server");
  assert.equal(writes, 0);
});

test("agent-o11y: rejects batches over the configured event limit", async () => {
  const prior = process.env.AGENT_O11Y_MAX_EVENTS_PER_BATCH;
  process.env.AGENT_O11Y_MAX_EVENTS_PER_BATCH = "1";
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    const fixture = await seedFixture();
    const res = await fetch(`${app.baseUrl}/internal/computer/agent-o11y/events`, {
      method: "POST",
      headers: jsonHeaders(fixture.computerApiKey),
      body: JSON.stringify({ events: [validEvent(fixture.agentId), validEvent(fixture.agentId)] }),
    });

    assert.equal(res.status, 413);
    assert.equal((await res.json() as { code: string }).code, "agent_o11y_batch_too_large");
  } finally {
    if (prior === undefined) {
      delete process.env.AGENT_O11Y_MAX_EVENTS_PER_BATCH;
    } else {
      process.env.AGENT_O11Y_MAX_EVENTS_PER_BATCH = prior;
    }
    await app.close();
  }
});

test("agent-o11y: reports writer outages as retryable server failures", async ({ app }) => {
  const fixture = await seedFixture();
  app.app.set(AGENT_O11Y_WRITER_APP_KEY, {
    async writeEvents() {
      throw new AgentO11yWriterUnavailableError(
        "agent_o11y_writer_unavailable",
        "agent o11y writer unavailable in test",
      );
    },
  } satisfies AgentO11yScopeDbWriter);

  const res = await fetch(`${app.baseUrl}/internal/computer/agent-o11y/events`, {
    method: "POST",
    headers: jsonHeaders(fixture.computerApiKey),
    body: JSON.stringify({ events: [validEvent(fixture.agentId)] }),
  });

  assert.equal(res.status, 503);
  const body = (await res.json()) as { ok: boolean; code: string; message: string };
  assert.equal(body.ok, false);
  assert.equal(body.code, "agent_o11y_writer_unavailable");
  assert.match(body.message, /unavailable/);
});

test("agent-o11y writer: maps transport payload_tier to canonical ScopeDB payload_mode", () => {
  assert.equal(mapAgentO11yPayloadTierToPayloadMode("T0"), "hash");
  assert.equal(mapAgentO11yPayloadTierToPayloadMode("T1"), "summary");
  assert.equal(mapAgentO11yPayloadTierToPayloadMode("T2"), "full");
});
