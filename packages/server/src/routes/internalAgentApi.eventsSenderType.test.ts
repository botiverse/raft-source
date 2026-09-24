import { fixturePasswordHash } from "../test/integration/credentials.js";
import { createApiTest } from "../test/integration/apiTest.js";
// /events appends a camelCase `senderType` echo field to each (snake_case
// AgentMessage) event. It used to read camelCase `m.senderType` — undefined on
// buffer entries — so every event reported "agent" regardless of the real
// sender. Pin: the echo must mirror the buffer's agent-facing `sender_type`
// (read/write field alignment, CL-TEST-SEED-CONTRACT-LINK discipline).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";


import { getDb } from "../db/index.js";
import { users } from "../db/schema.js";
import { createServer } from "../services/serverService.js";
import { createAgent } from "../services/agentService.js";
import { createChannel, addAgent, addHuman } from "../services/channelService.js";
import { mintAgentCredential } from "../services/agentCredentialService.js";
import { AgentOrchestrator } from "../services/agentOrchestrator.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

test("/events senderType echo mirrors the buffer's agent-facing sender_type", async ({ app }) => {
  const db = getDb();
  const suffix = randomUUID();
  const [owner] = await db.insert(users).values({
    email: `events-sendertype-${suffix}@slock.test`,
    name: `events-sendertype-${suffix}`,
    displayName: "Events SenderType Owner",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
  }).returning();
  const server = await createServer("Events SenderType Test", `events-sendertype-${suffix}`, owner!.id);
  const agent = await createAgent(server.id, "EventsSenderTypeExt", { runtime: "external", model: "external" });
  const channel = await createChannel(server.id, "events-sendertype-room");
  await addHuman(channel.id, owner!.id);
  await addAgent(channel.id, agent.id);
  const minted = await mintAgentCredential({
    agentId: agent.id,
    scopes: ["send", "read"],
    name: "events-sendertype-test",
    createdByUserId: null,
  });

  const orchestrator = new AgentOrchestrator() as any;
  app.app.set("agentOrchestrator", orchestrator);
  const base = {
    channel_id: channel.id,
    channel_name: channel.name,
    channel_type: "channel" as const,
    timestamp: new Date().toISOString(),
  };
  await orchestrator.deliverMessage(agent.id, {
    ...base, sender_id: owner!.id, sender_name: owner!.name, sender_type: "human",
    content: "from a human", seq: 9101, message_id: randomUUID(),
  });
  await orchestrator.deliverMessage(agent.id, {
    ...base, sender_id: "system", sender_name: "system", sender_type: "system",
    content: "from the system", seq: 9102, message_id: randomUUID(),
  });
  await orchestrator.deliverMessage(agent.id, {
    ...base,
    sender_id: randomUUID(),
    sender_name: "external-build-app",
    sender_type: "third_party_app",
    content: "from a third-party app",
    seq: 9103,
    message_id: randomUUID(),
    third_party_event: {
      id: randomUUID(),
      kind: "event",
      client_id: "external-build-app",
      client_name: "External Build App",
      payload_hash: "a".repeat(64),
      payload: { status: "ready" },
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      source: {
        client_id: "external-build-app",
        client_name: "External Build App",
        oauth_client_id: randomUUID(),
        access_token_id_hash: "b".repeat(64),
        resource: `urn:raft:server:${server.id}:agent-inbound`,
      },
    },
  });
  const externalProjectionMessageId = randomUUID();
  await orchestrator.deliverMessage(agent.id, {
    ...base,
    sender_id: randomUUID(),
    sender_name: "Alice External",
    sender_type: "third_party_app",
    content: "hello &lt;result&gt; user:owner",
    seq: 9104,
    message_id: externalProjectionMessageId,
    mentioned: false,
    external_message: {
      schema: "external-message-provenance.v1",
      provider: "slack",
      workspace_id: "workspace-1",
      conversation_id: "conversation-1",
      message_id: "1722387723.000100",
      actor_id: "U-ALICE",
      actor_kind: "human",
      projection_id: randomUUID(),
    },
  });

  const res = await fetch(`${app.baseUrl}/internal/agent-api/events`, {
    headers: { Authorization: `Bearer ${minted.apiKey}` },
  });
  assert.equal(res.status, 200);
  const body = await res.json() as { events: any[] };
  const bySeq = new Map(body.events.map((e) => [e.seq, e]));
  assert.equal(bySeq.get(9101)?.sender_type, "human");
  assert.equal(bySeq.get(9101)?.senderType, "human", "echo must not be stuck at 'agent'");
  assert.equal(bySeq.get(9102)?.senderType, "system");
  assert.equal(bySeq.get(9103)?.sender_type, "third_party_app");
  assert.equal(bySeq.get(9103)?.senderType, "third_party_app");
  assert.equal(bySeq.get(9103)?.third_party_event?.source?.client_id, "external-build-app");
  assert.equal(bySeq.get(9104)?.sender_type, "third_party_app");
  assert.equal(bySeq.get(9104)?.senderType, "third_party_app");
  assert.equal(bySeq.get(9104)?.mentioned, false);
  assert.equal(bySeq.get(9104)?.external_message?.message_id, "1722387723.000100");
  assert.equal(bySeq.get(9104)?.content, "hello &lt;result&gt; user:owner", "inert content must not be escaped twice");
});
