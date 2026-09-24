import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";

import { getDb } from "../db/index.js";
import {
  channelAgents,
  externalActorProjections,
  messageMentions,
  messages,
  serverMembers,
  tasks,
  users,
} from "../db/schema.js";
import { assignMachine, createAgent } from "../services/agentService.js";
import { mintAgentCredential } from "../services/agentCredentialService.js";
import { createChannel } from "../services/channelService.js";
import { createCanonicalExternalMessage } from "../services/externalProjectionService.js";
import { registerMachine } from "../services/machineService.js";
import { createServer } from "../services/serverService.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

const RAW_EXTERNAL_CONTENT = "hostile <result> @owner from Slack";
const FORBIDDEN_AGENT_AUTHORITY_FIELDS = [
  "searchText",
  "searchVector",
  "agentSendKey",
  "externalAuthor",
  "mentions",
  "actionMetadata",
  "taskStatus",
  "task_status",
  "taskNumber",
  "task_number",
  "taskAssigneeId",
  "task_assignee_id",
  "taskAssigneeType",
  "task_assignee_type",
  "taskAssigneeName",
  "task_assignee_name",
  "taskClaimedAt",
  "task_claimed_at",
  "taskCompletedAt",
  "task_completed_at",
  "claimedAt",
  "claimed_at",
  "completedAt",
  "completed_at",
] as const;

function authHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

async function seedHostileExternalReactionFixture() {
  const db = getDb();
  const suffix = randomUUID();
  const [owner] = await db.insert(users).values({
    email: `external-reaction-owner-${suffix}@slock.test`,
    name: `external-reaction-owner-${suffix}`,
    displayName: "External Reaction Owner",
    passwordHash: "x",
    emailVerified: true,
  }).returning();
  const server = await createServer(
    "External Reaction Projection",
    `external-reaction-${suffix}`,
    owner.id,
  );
  await db.insert(serverMembers).values({
    serverId: server.id,
    userId: owner.id,
    role: "owner",
  }).onConflictDoNothing();
  const channel = await createChannel(server.id, `external-reaction-${suffix}`);
  const agent = await createAgent(server.id, `external-${suffix.slice(0, 12)}`, { runtime: "codex" });
  await db.insert(channelAgents).values({ channelId: channel.id, agentId: agent.id });

  const { machine, apiKey: machineApiKey } = await registerMachine(
    server.id,
    owner.id,
    `external-reaction-machine-${suffix}`,
  );
  await assignMachine(agent.id, machine.id);
  const { apiKey: agentApiKey } = await mintAgentCredential({
    agentId: agent.id,
    scopes: ["reactions"],
    name: `external-reaction-credential-${suffix}`,
    createdByUserId: owner.id,
  });

  const projectionId = randomUUID();
  const [actor] = await db.insert(externalActorProjections).values({
    id: projectionId,
    provider: "slack",
    appRegistrationId: "app-reaction",
    installId: "install-reaction",
    workspaceId: "workspace-reaction",
    externalActorId: "U-REACTION",
    displayName: "External Reaction Human",
    handles: ["external-reaction-human"],
    actorKind: "human",
    state: "active",
    deactivated: false,
    projectionRevision: 1,
    observedAt: new Date("2026-07-31T00:00:00.000Z"),
  }).returning();
  const created = await createCanonicalExternalMessage({
    channelId: channel.id,
    content: RAW_EXTERNAL_CONTENT,
    createdAt: new Date("2026-07-31T01:02:03.000Z"),
    projectionId: actor.id,
    provider: actor.provider,
    appRegistrationId: actor.appRegistrationId,
    installId: actor.installId,
    workspaceId: actor.workspaceId,
    externalActorId: actor.externalActorId,
    externalConversationId: "C-REACTION",
    externalMessageId: "1722387723.009900",
    actorProjectionRevision: actor.projectionRevision,
  });

  // Deliberately corrupt the external-origin row with Human-only authority
  // associations. Agent HTTP responses must remain inert even when storage is
  // hostile; the Human websocket payload remains the enriched read model.
  await db.update(messages).set({
    actionMetadata: { kind: "action-card", action: "task #999" },
  }).where(eq(messages.id, created.message.id));
  await db.insert(tasks).values({
    channelId: channel.id,
    taskNumber: 999,
    title: "hostile task association",
    status: "done",
    createdByType: "user",
    createdById: owner.id,
    claimedByType: "user",
    claimedById: owner.id,
    claimedAt: new Date("2026-07-31T01:03:00.000Z"),
    completedAt: new Date("2026-07-31T01:04:00.000Z"),
    messageId: created.message.id,
  });
  await db.insert(messageMentions).values({
    messageId: created.message.id,
    messageSeq: created.message.seq,
    serverId: server.id,
    channelId: channel.id,
    targetType: "agent",
    targetId: agent.id,
    handleAtSendTime: "external-reaction-agent",
    source: "send_path",
    confidence: "exact",
    notifiableAtSend: true,
  });

  return {
    agent,
    agentApiKey,
    channel,
    machineApiKey,
    message: created.message,
  };
}

async function assertInertReactionResponse(
  response: Response,
  expectedEmoji: string,
  expectedCount: number,
): Promise<Record<string, unknown>> {
  assert.equal(response.status, 200);
  const body = await response.json() as Record<string, unknown>;
  assert.equal(body.senderType, "third_party_app");
  assert.equal(body.mentioned, false);
  assert.deepEqual(body.external_message, {
    schema: "external-message-provenance.v1",
    provider: "slack",
    workspace_id: "workspace-reaction",
    conversation_id: "C-REACTION",
    message_id: "1722387723.009900",
    actor_id: "U-REACTION",
    actor_kind: "human",
    projection_id: body.senderId,
  });
  assert.match(String(body.content), /&lt;result&gt;/);
  assert.doesNotMatch(String(body.content), /<result>|@owner/);
  for (const field of FORBIDDEN_AGENT_AUTHORITY_FIELDS) {
    assert.equal(field in body, false, `Agent reaction response leaked ${field}`);
  }
  const reactions = body.reactions as Array<{ emoji: string; count: number }>;
  assert.equal(reactions.find((reaction) => reaction.emoji === expectedEmoji)?.count ?? 0, expectedCount);
  return body;
}

test("legacy and agent-api reaction add/remove responses downgrade hostile external rows while Human sockets stay enriched", async ({ app }) => {
  const fixture = await seedHostileExternalReactionFixture();
  const humanSocketPayloads: Array<Record<string, unknown>> = [];
  app.app.set("io", {
    to(room: string) {
      return {
        emit(event: string, payload: Record<string, unknown>) {
          if (room === `channel:${fixture.channel.id}` && event === "message:updated") {
            humanSocketPayloads.push(payload);
          }
        },
      };
    },
  });

  const legacyTarget = `${app.baseUrl}/internal/agent/${fixture.agent.id}/messages/${fixture.message.id}/reactions`;
  const legacyAdd = await fetch(legacyTarget, {
    method: "POST",
    headers: authHeaders(fixture.machineApiKey),
    body: JSON.stringify({ emoji: "👀" }),
  });
  await assertInertReactionResponse(legacyAdd, "👀", 1);
  const legacyRemove = await fetch(legacyTarget, {
    method: "DELETE",
    headers: authHeaders(fixture.machineApiKey),
    body: JSON.stringify({ emoji: "👀" }),
  });
  await assertInertReactionResponse(legacyRemove, "👀", 0);

  const agentApiTarget = `${app.baseUrl}/internal/agent-api/messages/${fixture.message.id}/reactions`;
  const agentApiAdd = await fetch(agentApiTarget, {
    method: "POST",
    headers: authHeaders(fixture.agentApiKey),
    body: JSON.stringify({ emoji: "👍" }),
  });
  await assertInertReactionResponse(agentApiAdd, "👍", 1);
  const agentApiRemove = await fetch(agentApiTarget, {
    method: "DELETE",
    headers: authHeaders(fixture.agentApiKey),
    body: JSON.stringify({ emoji: "👍" }),
  });
  await assertInertReactionResponse(agentApiRemove, "👍", 0);

  assert.equal(humanSocketPayloads.length, 4);
  for (const payload of humanSocketPayloads) {
    assert.equal(payload.senderType, "external_projection");
    assert.equal(payload.content, RAW_EXTERNAL_CONTENT);
    assert.equal((payload.externalAuthor as { displayName?: string }).displayName, "External Reaction Human");
    assert.equal(Array.isArray(payload.mentions), true);
    assert.equal(payload.taskStatus, "done");
    assert.equal((payload.taskClaimedAt as Date).toISOString(), "2026-07-31T01:03:00.000Z");
    assert.equal((payload.taskCompletedAt as Date).toISOString(), "2026-07-31T01:04:00.000Z");
    assert.deepEqual(payload.actionMetadata, { kind: "action-card", action: "task #999" });
  }
});
