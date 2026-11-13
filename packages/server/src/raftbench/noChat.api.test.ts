import { expect } from "vitest";
import { eq } from "drizzle-orm";
import { createApiTest } from "../test/integration/apiTest";
import { tokenForHuman } from "../test/integration/credentials";
import { agents, raftbenchConfigs, raftbenchServiceAgents } from "../db/schema";
import { createAgent, invalidateRaftBenchServiceAgentBindings } from "../services/agentService";
import { createChannel, addAgent, addHuman } from "../services/channelService";
import { mintAgentCredential } from "../services/agentCredentialService";
import { AgentOrchestrator } from "../services/agentOrchestrator";
import { getAgentResumeCatchupMessages } from "../services/messageService";
import type { AgentMessage } from "@botiverse/raft-shared";

const test = createApiTest();

test("bound service identity never receives chat, mentions or DMs, even disabled; assignments survive", async ({ app, db, seed }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const service = await createAgent(server.id, "raftbench-service", { runtime: "external" });
  const sender = await createAgent(server.id, "synthetic-sender", { runtime: "external" });
  const room = await createChannel(server.id, "synthetic-qa");
  await addHuman(room.id, owner.id);
  await addAgent(room.id, service.id);
  await addAgent(room.id, sender.id);
  await db.insert(raftbenchConfigs).values({ serverId: server.id, agentId: service.id, configuredByUserId: owner.id, enabled: true, channelIds: [room.id] });
  await db.insert(raftbenchServiceAgents).values({ serverId: server.id, agentId: service.id });
  invalidateRaftBenchServiceAgentBindings();
  const ownerToken = await tokenForHuman(owner.email);
  const ownerHeaders = { Authorization: `Bearer ${ownerToken}`, "X-Server-Id": server.id };
  const listResponse = await fetch(`${app.baseUrl}/api/agents`, { headers: ownerHeaders });
  expect(listResponse.status).toBe(200);
  const list = await listResponse.json() as Array<{ id: string; raftbenchService?: boolean }>;
  expect(list.find(agent => agent.id === service.id)?.raftbenchService).toBe(true);
  expect(list.find(agent => agent.id === sender.id)?.raftbenchService).toBe(false);
  const profileResponse = await fetch(`${app.baseUrl}/api/agents/${service.id}`, { headers: ownerHeaders });
  expect(profileResponse.status).toBe(200);
  expect((await profileResponse.json()).raftbenchService).toBe(true);
  const orchestrator = new AgentOrchestrator();
  app.app.set("agentOrchestrator", orchestrator);
  const pushed: AgentMessage[] = [];
  orchestrator.on("external-inbox-delivered", (id, message) => { if (id === service.id) pushed.push(message); });
  const payload: AgentMessage = { channel_id: room.id, channel_name: room.name, channel_type: "channel", sender_id: sender.id, sender_name: sender.name, sender_type: "agent", content: "Synthetic ordinary chat", timestamp: new Date().toISOString() };
  for (const enabled of [true, false]) {
    await db.update(raftbenchConfigs).set({ enabled }).where(eq(raftbenchConfigs.serverId, server.id));
    for (const chat of [payload, { ...payload, mentioned: true }, { ...payload, channel_type: "dm" as const }]) {
      expect(await orchestrator.deliverMessage(service.id, chat, { intrinsic: true, adminAuthority: true })).toEqual({ status: "dropped", reason: "raftbench_service_no_chat" });
    }
    expect(await orchestrator.filterExternalInboxDeliveries(service.id, [{ message: payload, options: { intrinsic: true } }])).toEqual([false]);
    expect((await getAgentResumeCatchupMessages(service.id, undefined, { chain: [] })).messages).toEqual([]);
  }
  expect(pushed).toEqual([]);
  expect(orchestrator.peekPendingMessages(service.id)).toEqual([]);
  // Purge a pre-deploy buffer rather than replaying old chat on reconnect.
  orchestrator.deliverToLocalInbox(service.id, payload);
  expect(await orchestrator.receiveMessages(service.id, false, 0)).toEqual([]);
  const event: AgentMessage = { ...payload, sender_type: "third_party_app", third_party_event: { id: crypto.randomUUID(), kind: "event", client_id: "system.raftbench", client_name: "RaftBench", external_event_id: null, payload_hash: "synthetic", source: { client_id: "system.raftbench", client_name: "RaftBench", oauth_client_id: "system.raftbench", access_token_id_hash: "synthetic", resource: "synthetic" }, payload: { kind: "raftbench_run_assigned" }, expires_at: new Date(Date.now() + 60_000).toISOString() } };
  expect((await orchestrator.deliverMessage(service.id, event, { intrinsic: true })).status).toBe("queued");
  expect(pushed).toEqual([event]);
  expect((await orchestrator.deliverMessage(service.id, { ...event, third_party_event: { ...event.third_party_event!, client_id: "other-app" } }, { intrinsic: true })).status).toBe("dropped");
  const credential = await mintAgentCredential({ agentId: sender.id, scopes: ["read", "send", "mentions"], name: "Synthetic sender", issuedVia: "human", createdByUserId: owner.id });
  const headers = { Authorization: `Bearer ${credential.apiKey}`, "Content-Type": "application/json" };
  for (const [target, content] of [["#synthetic-qa", "Synthetic @raftbench-service"], ["dm:@raftbench-service", "Synthetic @raftbench-service"], ["dm:@raftbench-service", "Synthetic direct message"]]) {
    const response = await fetch(`${app.baseUrl}/internal/agent-api/send`, { method: "POST", headers, body: JSON.stringify({ target, content }) });
    expect(response.status, await response.clone().text()).toBe(200);
    const sent = await response.json();
    const view = await fetch(`${app.baseUrl}/internal/agent-api/messages/${sent.messageId}/mention-deliveries`, { headers });
    expect(view.status, await view.clone().text()).toBe(200);
    expect((await view.json()).deliveries).toEqual([{ targetHandle: "raftbench-service", outcome: "lost", reasonCategory: "unclassified" }]);
  }
  expect(pushed).toEqual([event]);
  // Binding, rather than a mutable name or runtime label, owns the rule.
  await db.update(agents).set({ name: "renamed-service" }).where(eq(agents.id, service.id));
  expect((await orchestrator.deliverMessage(service.id, payload)).status).toBe("dropped");
  await db.update(raftbenchConfigs).set({ agentId: null, enabled: false }).where(eq(raftbenchConfigs.serverId, server.id));
  expect(await orchestrator.deliverMessage(service.id, payload, { intrinsic: true, adminAuthority: true })).toEqual({ status: "dropped", reason: "raftbench_service_no_chat" });
});
