import { createApiTest } from "../test/integration/apiTest";
// Product decision (Slack bridge owner): a message bridged from Slack reaches
// Agents exactly like an ordinary Raft message — ordinary content rendering and
// `mentioned` true for the reading Agent when the server minted a notifiable
// message_mentions row for it — on every Agent read path. Any other external
// provider keeps the inert treatment (neutralized refs, never mentioned).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { getDb } from "../db/index";
import { externalActorProjections, externalMessageAuthorFacts, messageMentions, users } from "../db/schema";
import { insertCanonicalExternalMessage } from "../services/externalProjectionService";
import { createServer } from "../services/serverService";
import { createAgent } from "../services/agentService";
import { addAgent, addHuman, createChannel } from "../services/channelService";
import { mintAgentCredential } from "../services/agentCredentialService";
import { AgentOrchestrator } from "../services/agentOrchestrator";
import { referenceAgentInboxChain } from "../test/agentInboxChainReference";
import {
  __setExternalAgentInboxChainSelectorForTests,
  deliverMessageToAgent,
  deliverMessagesToAgents,
} from "../services/messageService";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

// CI has no RisingWave: the external agent inbox pull reads the test-only
// reference derivation of the agent inbox chain.
__setExternalAgentInboxChainSelectorForTests(async (agentId: string) => ({ source: "chain", rows: await referenceAgentInboxChain(agentId) }));

async function seedFixture() {
  const db = getDb();
  const suffix = randomUUID();
  const [owner] = await db.insert(users).values({
    email: `slack-mention-${suffix}@slock.test`,
    name: `slack-mention-${suffix}`,
    displayName: "Slack Mention Owner",
    passwordHash: "x",
    emailVerified: true,
  }).returning();
  const server = await createServer("Slack Mention Test", `slack-mention-${suffix}`, owner!.id);
  const agentA = await createAgent(server.id, "SlackMentionAlpha", { runtime: "external", model: "external" });
  const agentB = await createAgent(server.id, "SlackMentionBravo", { runtime: "external", model: "external" });
  const channel = await createChannel(server.id, "slack-mention-room");
  await addHuman(channel.id, owner!.id);
  await addAgent(channel.id, agentA.id);
  await addAgent(channel.id, agentB.id);
  const credential = async (agentId: string) => (await mintAgentCredential({
    agentId,
    scopes: ["send", "read"],
    name: `slack-mention-${agentId}`,
    issuedVia: "computer",
    createdByUserId: null,
  })).apiKey;

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

  const content = `hi @${agentA.name} see #${channel.name} <result>`;
  const project = async (externalMessageId: string) => {
    const created = await db.transaction((executor) => insertCanonicalExternalMessage({
      executor,
      channelId: channel.id,
      content,
      createdAt: new Date(),
      projectionId: actor!.id,
      provider: "slack",
      appRegistrationId: `registration-${suffix}`,
      installId: `install-${suffix}`,
      workspaceId: "workspace-1",
      externalActorId: "U-ALICE",
      externalConversationId: "conversation-1",
      externalMessageId,
      actorProjectionRevision: 1,
    }));
    // The server-minted personal mention fact targeting Agent A.
    await db.insert(messageMentions).values({
      messageId: created.message.id,
      messageSeq: created.message.seq,
      serverId: server.id,
      channelId: channel.id,
      targetType: "agent",
      targetId: agentA.id,
      handleAtSendTime: agentA.name,
      source: "send_path",
      confidence: "exact",
      notifiableAtSend: true,
    });
    return created.message;
  };
  const slack = await project("1722387723.000100");
  // A non-Slack provider: same shape, but its frozen author fact names another
  // provider. It must stay inert and non-mentioned everywhere.
  const other = await project("1722387723.000200");
  await db.update(externalMessageAuthorFacts)
    .set({ provider: "other-chat" })
    .where(and(eq(externalMessageAuthorFacts.messageId, other.id)));

  return {
    server,
    channel,
    agentA,
    agentB,
    keyA: await credential(agentA.id),
    keyB: await credential(agentB.id),
    slack,
    other,
  };
}

type Fixture = Awaited<ReturnType<typeof seedFixture>>;

function assertSlackOrdinary(message: any, fx: Fixture, mentioned: boolean, label: string) {
  assert.ok(message, `${label}: Slack message missing`);
  assert.equal(message.mentioned, mentioned, `${label}: mentioned`);
  assert.match(message.content, new RegExp(`@${fx.agentA.name}`), `${label}: @mention rendered ordinarily`);
  assert.match(message.content, new RegExp(`#${fx.channel.name}`), `${label}: #channel rendered ordinarily`);
  assert.match(message.content, /<result>/, `${label}: ordinary content is not inert-escaped`);
  assert.doesNotMatch(message.content, /user:|channel:/, `${label}: refs are not neutralized`);
  assert.equal(message.external_message?.provider, "slack", `${label}: provenance kept`);
  assert.equal(message.mentions, undefined, `${label}: raw mention facts stay stripped`);
}

function assertOtherInert(message: any, label: string) {
  assert.ok(message, `${label}: non-Slack message missing`);
  assert.equal(message.mentioned, false, `${label}: non-Slack stays non-mentioned`);
  assert.match(message.content, /user:/, `${label}: non-Slack refs stay neutralized`);
  assert.match(message.content, /&lt;result&gt;/, `${label}: non-Slack stays inert-escaped`);
  assert.equal(message.external_message?.provider, "other-chat", `${label}: provenance kept`);
}

test("Slack-bridged messages reach agents as ordinary mentions on history, events catch-up, live and single delivery", async ({ app }) => {
  const fx = await seedFixture();
  app.app.set("agentOrchestrator", new AgentOrchestrator() as any);

  // Durable inbox pull (resume catch-up batch) served on /events, read
  // before history so the history read cannot advance the read position first.
  const events = async (apiKey: string) => {
    const res = await fetch(`${app.baseUrl}/internal/agent-api/events`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { events: any[] };
    return new Map(body.events.map((e) => [e.message_id, e]));
  };
  const eventsA = await events(fx.keyA);
  assertSlackOrdinary(eventsA.get(fx.slack.id), fx, true, "events A");
  assertOtherInert(eventsA.get(fx.other.id), "events A");
  const eventsB = await events(fx.keyB);
  assertSlackOrdinary(eventsB.get(fx.slack.id), fx, false, "events B");

  // Agent API history read envelope.
  const history = async (apiKey: string) => {
    const res = await fetch(`${app.baseUrl}/internal/agent-api/history?channel=${encodeURIComponent(`#${fx.channel.name}`)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { messages: any[] };
    return new Map(body.messages.map((m) => [m.id, m]));
  };
  const historyA = await history(fx.keyA);
  assertSlackOrdinary(historyA.get(fx.slack.id), fx, true, "history A");
  assertOtherInert(historyA.get(fx.other.id), "history A");
  const historyB = await history(fx.keyB);
  assertSlackOrdinary(historyB.get(fx.slack.id), fx, false, "history B");
  assertOtherInert(historyB.get(fx.other.id), "history B");

  // Exact message resolve.
  const resolve = async (apiKey: string, messageId: string) => {
    const res = await fetch(`${app.baseUrl}/internal/agent-api/messages/${messageId}/resolve`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    assert.equal(res.status, 200);
    return (await res.json() as { message: any }).message;
  };
  assertSlackOrdinary(await resolve(fx.keyA, fx.slack.id), fx, true, "resolve A");
  assertSlackOrdinary(await resolve(fx.keyB, fx.slack.id), fx, false, "resolve B");
  assertOtherInert(await resolve(fx.keyA, fx.other.id), "resolve A");

  // Live batch delivery with the commit hook's personal attention targets.
  const delivered = new Map<string, any[]>();
  const orchestrator = {
    deliverMessage: async (agentId: string, payload: unknown) => {
      delivered.set(agentId, [...(delivered.get(agentId) ?? []), payload]);
      return { status: "queued" };
    },
    loadDeliveryGates: async () => null,
  } as any;
  await deliverMessagesToAgents(orchestrator, [fx.slack], "external user", {
    personalAttentionTargets: [{ type: "agent", id: fx.agentA.id, name: fx.agentA.name }],
    recipientAgentIds: [fx.agentA.id, fx.agentB.id],
  });
  assertSlackOrdinary(delivered.get(fx.agentA.id)?.[0], fx, true, "live A");
  assertSlackOrdinary(delivered.get(fx.agentB.id)?.[0], fx, false, "live B");

  // Single-message delivery.
  delivered.clear();
  await deliverMessageToAgent(orchestrator, fx.slack.id, fx.agentA.id);
  await deliverMessageToAgent(orchestrator, fx.slack.id, fx.agentB.id);
  await deliverMessageToAgent(orchestrator, fx.other.id, fx.agentA.id);
  assertSlackOrdinary(delivered.get(fx.agentA.id)?.[0], fx, true, "single A");
  assertSlackOrdinary(delivered.get(fx.agentB.id)?.[0], fx, false, "single B");
  const otherSingle = delivered.get(fx.agentA.id)?.[1];
  assert.match(otherSingle?.content ?? "", /user:/, "single: non-Slack stays inert");
});
