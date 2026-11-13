import { fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
// /events appends a camelCase `senderType` echo field to each (snake_case
// AgentMessage) event. It used to read camelCase `m.senderType` — undefined on
// buffer entries — so every event reported "agent" regardless of the real
// sender. Pin: the echo must mirror the buffer's agent-facing `sender_type`
// (read/write field alignment, CL-TEST-SEED-CONTRACT-LINK discipline).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";


import { getDb } from "../db/index";
import { externalActorProjections, users } from "../db/schema";
import { insertCanonicalExternalMessage } from "../services/externalProjectionService";
import { createServer } from "../services/serverService";
import { createAgent } from "../services/agentService";
import { createChannel, addAgent, addHuman } from "../services/channelService";
import { mintAgentCredential } from "../services/agentCredentialService";
import { AgentOrchestrator } from "../services/agentOrchestrator";
import { referenceAgentInboxChain } from "../test/agentInboxChainReference";
import { createMessage, __setExternalAgentInboxChainSelectorForTests } from "../services/messageService";


const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

// CI has no RisingWave: the external agent inbox pull reads the test-only
// reference derivation of the agent inbox chain.
__setExternalAgentInboxChainSelectorForTests(async (agentId: string) => ({ source: "chain", rows: await referenceAgentInboxChain(agentId) }));

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
    issuedVia: "computer",
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
  // Persisted messages reach an external agent from its durable inbox.
  const human = await createMessage(channel.id, "user", owner!.id, "from a human");
  const system = await createMessage(channel.id, "user", "system", "from the system", "system");
  await orchestrator.deliverMessage(agent.id, {
    ...base,
    sender_id: randomUUID(),
    sender_name: "external-build-app",
    sender_type: "third_party_app",
    content: "from a third-party app @owner",
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
  // A provider message projected into the channel (e.g. from Slack): a real
  // external-projection row, served from the durable inbox pull.
  const [actor] = await db.insert(externalActorProjections).values({
    provider: "slack",
    appRegistrationId: `registration-${suffix}`,
    installId: `install-${suffix}`,
    workspaceId: "workspace-1",
    externalActorId: "U-ALICE",
    displayName: "Alice External",
    handles: ["alice"],
    actorKind: "human",
    state: "active",
    deactivated: false,
    projectionRevision: 1,
    observedAt: new Date(),
  }).returning();
  const projected = await db.transaction((executor) => insertCanonicalExternalMessage({
    executor,
    channelId: channel.id,
    content: "hello <result> @owner",
    createdAt: new Date(),
    projectionId: actor!.id,
    provider: "slack",
    appRegistrationId: `registration-${suffix}`,
    installId: `install-${suffix}`,
    workspaceId: "workspace-1",
    externalActorId: "U-ALICE",
    externalConversationId: "conversation-1",
    externalMessageId: "1722387723.000100",
    actorProjectionRevision: 1,
  }));

  const res = await fetch(`${app.baseUrl}/internal/agent-api/events`, {
    headers: { Authorization: `Bearer ${minted.apiKey}` },
  });
  assert.equal(res.status, 200);
  const body = await res.json() as { events: any[] };
  const bySeq = new Map(body.events.map((e) => [e.seq, e]));
  assert.equal(bySeq.get(human.seq)?.sender_type, "human");
  assert.equal(bySeq.get(human.seq)?.senderType, "human", "echo must not be stuck at 'agent'");
  assert.equal(bySeq.get(system.seq)?.senderType, "system");
  assert.equal(bySeq.get(9103)?.sender_type, "third_party_app");
  assert.equal(bySeq.get(9103)?.senderType, "third_party_app");
  assert.equal(bySeq.get(9103)?.third_party_event?.source?.client_id, "external-build-app");
  // Third-party app event content stays inert.
  assert.equal(bySeq.get(9103)?.content, "from a third-party app user:owner");
  const external = bySeq.get(projected.message.seq);
  assert.equal(external?.sender_type, "third_party_app");
  assert.equal(external?.senderType, "third_party_app");
  assert.equal(external?.mentioned, false);
  assert.equal(external?.external_message?.message_id, "1722387723.000100");
  // Slack-bridged content reads like an ordinary Raft message.
  assert.equal(external?.content, "hello <result> @owner");
});
