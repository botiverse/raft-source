// Shared fixtures for the internalAgentApi.auth.*.test.ts files (one suite
// split by topic so CI shards can run the parts in parallel).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import argon2 from "argon2";
import { and, eq } from "drizzle-orm";
import { getDb } from "../db/index";
import { computers, serverAgentMembers, users } from "../db/schema";
import { createServer } from "../services/serverService";
import { createAgent } from "../services/agentService";
import { placeAgentOnMachine } from "../test/agentMachineFixture";
import { createChannel, addAgent, addHuman, getAgentLegacyReadCursor } from "../services/channelService";
import { createMessage } from "../services/messageService";
import { registerMachine } from "../services/machineService";
import { mintAgentCredential, type AgentCapability } from "../services/agentCredentialService";
import { generateComputerApiKeyMaterial } from "../services/computerCredentialService";
import { recordInboxNotificationFacts } from "../services/inboxNotificationService";

export type AuthFixture = {
  ownerId: string;
  ownerName: string;
  ownerEmail: string;
  serverId: string;
  serverSlug: string;
  agentId: string;
  channelId: string;
  channelName: string;
  joinOnlyChannelId: string;
  machineId: string;
  machineApiKey: string;
  computerApiKey: string;
  agentApiKey: string;
  readOnlyApiKey: string;
};

export function jsonHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

export async function login(baseUrl: string, email: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "password123" }),
  });
  assert.equal(res.status, 200, `login failed for ${email}`);
  const data = await res.json() as { accessToken: string };
  return data.accessToken;
}

export type EmittedEvent = { room: string; event: string; payload: unknown };

export function installFakeIo(app: { set: (key: string, value: unknown) => void }): EmittedEvent[] {
  const events: EmittedEvent[] = [];
  const makeRoomChain = (rooms: string[]) => ({
    in(room: string) {
      return makeRoomChain([...rooms, room]);
    },
    socketsJoin(room: string) {
      events.push({ room: rooms.join(" "), event: "socketsJoin", payload: { room } });
    },
  });
  app.set("io", {
    to(room: string) {
      return {
        emit(event: string, payload: unknown) {
          events.push({ room, event, payload });
        },
      };
    },
    in(room: string) {
      return makeRoomChain([room]);
    },
  });
  return events;
}

export function humanJsonHeaders(token: string, serverId: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "X-Server-Id": serverId,
  };
}

export async function assertCapabilityDenied(res: Response, expectedError: string, label: string): Promise<void> {
  assert.equal(res.status, 403, `${label}: expected 403, got ${res.status}`);
  const body = (await res.json()) as Record<string, unknown> & { error?: string; code?: string; suggestedNextAction?: string };
  assert.equal(body.error, expectedError, label);
  // The SDK forwards only `code` and `suggestedNextAction` to the model.
  assert.equal(body.code, "server_role_required", label);
  // The roles are in the step's words; the old role fields are not on the wire.
  assert.equal("currentRole" in body || "requiredRole" in body || "requiredCapabilities" in body, false, label);
  assert.match(body.suggestedNextAction ?? "", /your role is member/, label);
}

export function containsOAuthSecret(value: unknown): boolean {
  return /(?:slock|raft)_secret_/.test(JSON.stringify(value ?? {}));
}

export async function waitForLegacyReadCursor(agentId: string, channelId: string, seq: number): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if ((await getAgentLegacyReadCursor(agentId, channelId)) === seq) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(await getAgentLegacyReadCursor(agentId, channelId), seq);
}

export async function assertLegacyReadCursorStays(agentId: string, channelId: string, seq: number, label: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    assert.equal(await getAgentLegacyReadCursor(agentId, channelId), seq, label);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export async function createAgentAttentionMessage(fixture: AuthFixture, content: string) {
  const message = await createMessage(fixture.channelId, "user", fixture.ownerId, content);
  await recordInboxNotificationFacts([{
    receiverType: "agent",
    receiverId: fixture.agentId,
    serverId: fixture.serverId,
    kind: "channel",
    sourceChannelId: fixture.channelId,
    messageId: message.id,
    messageSeq: message.seq,
    activityAt: message.createdAt,
    personalMention: false,
    unreadEligible: true,
  }]);
  return message;
}

export async function mintAgentKey(agentId: string, scopes: readonly AgentCapability[]): Promise<string> {
  const minted = await mintAgentCredential({
    agentId,
    scopes,
    name: `test-${scopes.join("-")}`,
    issuedVia: "computer",
    createdByUserId: null,
  });
  return minted.apiKey;
}

export async function seedAuthFixture(): Promise<AuthFixture> {
  const db = getDb();
  const suffix = randomUUID();
  const [owner] = await db.insert(users).values({
    email: `agent-api-auth-${suffix}@slock.test`,
    name: `agent-api-auth-${suffix}`,
    displayName: "Agent API Auth Owner",
    passwordHash: await argon2.hash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();

  const server = await createServer("Agent API Auth Test", `agent-api-auth-${suffix}`, owner.id);
  const agent = await createAgent(server.id, "AgentApiAuthBot", { runtime: "claude", model: "sonnet" });
  const channel = await createChannel(server.id, "agent-api-auth-room");
  const joinOnlyChannel = await createChannel(server.id, "agent-api-auth-join-room");
  await addHuman(channel.id, owner.id);
  await addAgent(channel.id, agent.id);

  const { machine, apiKey: machineApiKey } = await registerMachine(server.id, owner.id, "agent-api-auth-machine");
  await placeAgentOnMachine(agent.id, machine.id);
  const computerMaterial = await generateComputerApiKeyMaterial();
  await db.insert(computers).values({
    serverId: server.id,
    name: "agent-api-auth-computer",
    apiKeyHash: computerMaterial.apiKeyHash,
    apiKeyPrefix: computerMaterial.apiKeyPrefix,
    attachedByUserId: owner.id,
    machineId: machine.id,
  });
  const agentApiKey = await mintAgentKey(agent.id, ["send", "read", "mentions", "tasks", "reactions", "server", "channels"]);
  const readOnlyApiKey = await mintAgentKey(agent.id, ["read"]);

  return {
    ownerId: owner.id,
    ownerName: owner.name,
    ownerEmail: owner.email,
    serverId: server.id,
    serverSlug: server.slug,
    agentId: agent.id,
    channelId: channel.id,
    channelName: channel.name,
    joinOnlyChannelId: joinOnlyChannel.id,
    machineId: machine.id,
    machineApiKey,
    computerApiKey: computerMaterial.apiKey,
    agentApiKey,
    readOnlyApiKey,
  };
}

export async function setAgentServerRole(serverId: string, agentId: string, role: "member" | "admin") {
  const updated = await getDb().update(serverAgentMembers).set({ role }).where(and(
    eq(serverAgentMembers.serverId, serverId),
    eq(serverAgentMembers.agentId, agentId),
  )).returning();
  assert.equal(updated.length, 1, "precondition: agent has a server membership row");
}

/** A response with the probed handle masked, so two probes compare whole. */
export async function maskedResponse(res: Response, handle: string) {
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text.split(handle).join("<handle>")) as unknown };
}

export function fetchAgentProfile(baseUrl: string, apiKey: string, handle: string) {
  return fetch(
    `${baseUrl}/internal/agent-api/profile?target=${encodeURIComponent(`@${handle}`)}`,
    { headers: jsonHeaders(apiKey) },
  );
}
