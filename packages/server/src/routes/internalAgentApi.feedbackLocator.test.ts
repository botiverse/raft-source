import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { getDb } from "../db/index.js";
import { users } from "../db/schema.js";
import { createAgent } from "../services/agentService.js";
import { mintAgentCredential } from "../services/agentCredentialService.js";
import { createChannel } from "../services/channelService.js";
import { createServer } from "../services/serverService.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

function headers(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
}

function payload(serverId: string, agentId: string, reportId = randomUUID()) {
  return {
    schema_version: "raft.feedback.locator.v0",
    report_id: reportId,
    captured_at: "2026-08-09T02:30:00.000Z",
    producer: { surface: "raft_cli", server_id: serverId, agent_id: agentId },
    capture_invocation: {
      invocation_id: randomUUID(),
      command_family: "feedback",
      arguments: [],
      canonical_shape_sha256: "a".repeat(64),
    },
    locators: {
      l0: {
        runtime: "codex",
        identity: { status: "unavailable", reason_code: "session_identity_unavailable" },
        native: { status: "not_attempted", reason_code: "session_identity_unavailable" },
        handoff: { status: "not_attempted", reason_code: "session_identity_unavailable" },
      },
      l1: {
        turn: { status: "unsupported", reason_code: "runtime_turn_contract_unavailable" },
        trace: { status: "unsupported", reason_code: "runtime_trace_contract_unavailable" },
      },
      l2: { subject_call: { status: "unavailable", reason_code: "subject_call_anchor_missing" } },
    },
    exacts: [],
    route: {
      resolution: {
        status: "resolved",
        target: { kind: "public_channel", ref: "#proj-feedback" },
        basis: "configured_project_channel",
      },
      delivery: { status: "dispatched_unconfirmed", reason_code: "fire_and_forget_no_receipt" },
    },
    transport: {
      artifact_kind: "raft-feedback-locator-v0",
      event_kind: "feedback-locator:created",
    },
  };
}

async function seed() {
  const suffix = randomUUID();
  const [owner] = await getDb().insert(users).values({
    email: `feedback-locator-${suffix}@example.test`,
    name: `feedback_locator_${suffix}`,
    passwordHash: "test",
  }).returning();
  const server = await createServer("Feedback Locator API", `feedback-locator-${suffix}`, owner.id);
  const agent = await createAgent(server.id, "FeedbackLocatorApiAgent", { runtime: "codex", model: "gpt-5" });
  await createChannel(server.id, "proj-feedback");
  const credential = await mintAgentCredential({
    agentId: agent.id,
    scopes: ["send", "read"],
    name: "feedback-locator-api-test",
    createdByUserId: null,
  });
  return { server, agent, apiKey: credential.apiKey };
}

test("real agent-api seam returns only the transaction-backed receipt and replays it for duplicates", async ({ app }) => {
  const fixture = await seed();
  const reportId = randomUUID();
  const body = {
    artifact_kind: "raft-feedback-locator-v0",
    event_kind: "feedback-locator:created",
    payload: payload(fixture.server.id, fixture.agent.id, reportId),
  };
  const first = await fetch(`${app.baseUrl}/internal/agent-api/feedback-locators`, {
    method: "POST",
    headers: headers(fixture.apiKey),
    body: JSON.stringify(body),
  });
  assert.equal(first.status, 200);
  const accepted = await first.json() as {
    status: string;
    receipt_id: string;
    report_id: string;
    duplicate: boolean;
  };
  assert.equal(accepted.status, "accepted");
  assert.equal(accepted.report_id, reportId);
  assert.equal(accepted.duplicate, false);
  assert.match(accepted.receipt_id, /^[0-9a-f-]{36}$/);

  const retry = await fetch(`${app.baseUrl}/internal/agent-api/feedback-locators`, {
    method: "POST",
    headers: headers(fixture.apiKey),
    body: JSON.stringify(body),
  });
  assert.equal(retry.status, 200);
  const duplicate = await retry.json() as typeof accepted;
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.receipt_id, accepted.receipt_id);

  const listed = await fetch(
    `${app.baseUrl}/internal/agent-api/feedback-locators?report_id=${reportId}&runtime=codex&native_status=not_attempted&route_basis=configured_project_channel`,
    { headers: headers(fixture.apiKey) },
  );
  assert.equal(listed.status, 200);
  const index = await listed.json() as { locators: Array<Record<string, unknown>> };
  assert.equal(index.locators.length, 1);
  assert.equal(index.locators[0]?.report_id, reportId);
  assert.equal(index.locators[0]?.receipt_id, accepted.receipt_id);
  assert.equal("payload" in (index.locators[0] ?? {}), false);
  assert.equal("session_id" in (index.locators[0] ?? {}), false);
});

test("agent-api seam preserves typed unknown-version and private-route failures without a receipt", async ({ app }) => {
  const fixture = await seed();
  const unknown = payload(fixture.server.id, fixture.agent.id);
  unknown.schema_version = "raft.feedback.locator.v999";
  const unknownResponse = await fetch(`${app.baseUrl}/internal/agent-api/feedback-locators`, {
    method: "POST",
    headers: headers(fixture.apiKey),
    body: JSON.stringify({
      artifact_kind: "raft-feedback-locator-v0",
      event_kind: "feedback-locator:created",
      payload: unknown,
    }),
  });
  assert.equal(unknownResponse.status, 400);
  assert.deepEqual(await unknownResponse.json(), { status: "failed", reason_code: "unknown_schema_version" });

  const privateRoute = payload(fixture.server.id, fixture.agent.id) as any;
  privateRoute.route.resolution.target = { kind: "private_channel", ref: "#secret" };
  const privateResponse = await fetch(`${app.baseUrl}/internal/agent-api/feedback-locators`, {
    method: "POST",
    headers: headers(fixture.apiKey),
    body: JSON.stringify({
      artifact_kind: "raft-feedback-locator-v0",
      event_kind: "feedback-locator:created",
      payload: privateRoute,
    }),
  });
  assert.equal(privateResponse.status, 400);
  assert.deepEqual(await privateResponse.json(), { status: "failed", reason_code: "invalid_route_ref" });
});
