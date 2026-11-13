// What an agent reads in a third-party app message (agentFacingContent.ts),
// on every path that hands one over: the agent API's `/events` (the SDK,
// hosted agents, `raft message check`), the legacy daemon receive, and the
// `agent-event:<id>` re-read. Raft's own system apps' events (row: system_app
// set, client_id empty) read as an ordinary message's: handles stay `@name`,
// refs stay `#channel`, next steps stay runnable. An external app's (an OAuth
// client's row) are rewritten inert, and so is an event with no row (fail closed).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@botiverse/raft-shared";

import { getDb } from "../db/index";
import { thirdPartyAgentEvents, users } from "../db/schema";
import { fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import { createServer } from "../services/serverService";
import { createAgent } from "../services/agentService";
import { placeAgentOnMachine } from "../test/agentMachineFixture";
import { registerMachine } from "../services/machineService";
import { mintAgentCredential } from "../services/agentCredentialService";
import { buildThirdPartyAgentMessage, createOAuthClient } from "../services/oauthService";
import { AgentOrchestrator } from "../services/agentOrchestrator";
import { buildSystemAppAgentMessage, createSystemAppAgentEvent } from "../services/systemAppAgentEvents";
import { raftAuthoredAppEventIds } from "../services/agentFacingContent";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

// The two lines from QA (task 69): a mention notice quoting a member's comment,
// and a next step naming a thread.
const MENTION = `@innout mentioned you in a comment on "Proto" (a.html): "probe @qa-wa-bot-1 see #proj-workspace". If it asks something of you, answer in the artifact: raft artifact comment pt_abc --reply-to c_1.`;
const NEXT_STEP = `Reminder: check the PR. Next: raft message read --target "#proj-workspace:1dbe5d8c"`;
const MENTION_INERT = `user:innout mentioned you in a comment on "Proto" (a.html): "probe user:qa-wa-bot-1 see channel:proj-workspace".`;
const NEXT_STEP_INERT = `raft message read --target "channel:proj-workspace:1dbe5d8c"`;

async function seedAgent() {
  const db = getDb();
  const suffix = randomUUID();
  const [owner] = await db.insert(users).values({
    email: `content-${suffix}@slock.test`,
    name: `content-${suffix}`,
    displayName: "Content Owner",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
  }).returning();
  const server = await createServer("System App Content Test", `content-${suffix}`, owner!.id);
  const agent = await createAgent(server.id, `Content${suffix.slice(0, 6)}`, { runtime: "external", model: "external" });
  const minted = await mintAgentCredential({ agentId: agent.id, scopes: ["send", "read"], name: "content-test", issuedVia: "computer", createdByUserId: null });
  return { ownerId: owner!.id, serverId: server.id, agentId: agent.id, apiKey: minted.apiKey };
}

type Fixture = Awaited<ReturnType<typeof seedAgent>>;

/** Raft's own system app (unguarded, so delivery isn't in question here). */
function systemEvent(f: Fixture, summary: string) {
  return createSystemAppAgentEvent({ serverId: f.serverId, agentId: f.agentId, systemApp: "system.assistant", summary, payload: {}, ttlMs: 60 * 60_000 });
}

/** An external app's event (an OAuth client's row), queued for `/events` to rebuild. */
async function oauthEvent(f: Fixture, summary: string, status: "queued" | "delivered" = "queued") {
  const clientKey = `content-${randomUUID().slice(0, 8)}`;
  const { client } = await createOAuthClient({
    serverId: f.serverId,
    createdByUserId: f.ownerId,
    clientId: clientKey,
    name: "Content OAuth Client",
    allowedScopes: ["openid", "agent:event:write", "agent:notification:write"],
  });
  const [row] = await getDb().insert(thirdPartyAgentEvents).values({
    serverId: f.serverId,
    agentId: f.agentId,
    clientId: client.id,
    kind: "notification",
    summary,
    payload: {},
    payloadHash: "0".repeat(64),
    resource: `urn:raft:server:${f.serverId}:agent-inbound`,
    status,
    expiresAt: new Date(Date.now() + 60 * 60_000),
  }).returning();
  return { row: row!, message: buildThirdPartyAgentMessage({ event: row!, clientKey, clientName: "Content OAuth Client" }) };
}

function freshProcess(app: { app: { set: (key: string, value: unknown) => void } }) {
  const orchestrator = new AgentOrchestrator();
  app.app.set("agentOrchestrator", orchestrator);
  return orchestrator;
}

async function events(baseUrl: string, apiKey: string): Promise<AgentMessage[]> {
  const res = await fetch(`${baseUrl}/internal/agent-api/events?since=latest`, { headers: { Authorization: `Bearer ${apiKey}` } });
  const raw = await res.text();
  assert.equal(res.status, 200, raw);
  return (JSON.parse(raw) as { events: AgentMessage[] }).events;
}

const contentOf = (messages: readonly AgentMessage[], id: string) => messages.find((m) => m.message_id === id || m.third_party_event?.id === id)?.content ?? "";

test("/events (SDK, hosted agents, message check): a system app's text as written, an OAuth app's inert", async ({ app }) => {
  const f = await seedAgent();
  freshProcess(app);
  const mention = await systemEvent(f, MENTION);
  const next = await systemEvent(f, NEXT_STEP);
  const external = await oauthEvent(f, MENTION);
  const pulled = await events(app.baseUrl, f.apiKey);
  assert.ok(contentOf(pulled, mention.id).includes(MENTION), contentOf(pulled, mention.id));
  assert.ok(contentOf(pulled, next.id).includes(NEXT_STEP), contentOf(pulled, next.id));
  // Regression: the same text from an external app stays inert.
  assert.ok(contentOf(pulled, external.row.id).includes(MENTION_INERT), contentOf(pulled, external.row.id));
  assert.ok(!contentOf(pulled, external.row.id).includes("@innout"));
});

test("/events: an event with no row, though it names a system app, stays inert (fail closed)", async ({ app }) => {
  const f = await seedAgent();
  const orchestrator = freshProcess(app);
  // Shaped exactly like a system app's message (client "system.assistant"), but no row says so.
  const real = await systemEvent(f, NEXT_STEP);
  const built = buildSystemAppAgentMessage(real);
  const forgedId = randomUUID();
  const forged = { ...built, message_id: forgedId, third_party_event: { ...built.third_party_event!, id: forgedId } } as AgentMessage;
  orchestrator.deliverToLocalInbox(f.agentId, forged, { notifyPendingReceive: false });
  const pulled = await events(app.baseUrl, f.apiKey);
  const content = contentOf(pulled, forgedId);
  assert.ok(content.includes(NEXT_STEP_INERT), content);
  assert.ok(contentOf(pulled, real.id).includes(NEXT_STEP), "the real one, with its row, as written");
});

test("legacy daemon receive: a system app's text as written, an OAuth app's inert", async ({ app }) => {
  const f = await seedAgent();
  const { machine, apiKey: machineKey } = await registerMachine(f.serverId, f.ownerId, "content-machine");
  await placeAgentOnMachine(f.agentId, machine.id);
  const orchestrator = freshProcess(app);
  const mention = await systemEvent(f, MENTION);
  const next = await systemEvent(f, NEXT_STEP);
  const external = await oauthEvent(f, NEXT_STEP, "delivered");
  for (const message of [buildSystemAppAgentMessage(mention), buildSystemAppAgentMessage(next), external.message]) {
    orchestrator.deliverToLocalInbox(f.agentId, message, { notifyPendingReceive: false });
  }
  const res = await fetch(`${app.baseUrl}/internal/agent/${f.agentId}/receive?block=false&timeout=1`, { headers: { Authorization: `Bearer ${machineKey}` } });
  const raw = await res.text();
  assert.equal(res.status, 200, raw);
  const received = (JSON.parse(raw) as { messages: AgentMessage[] }).messages;
  assert.ok(contentOf(received, mention.id).includes(MENTION), contentOf(received, mention.id));
  assert.ok(contentOf(received, next.id).includes(NEXT_STEP), contentOf(received, next.id));
  assert.ok(contentOf(received, external.row.id).includes(NEXT_STEP_INERT), contentOf(received, external.row.id));
});

test("agent-event:<id> re-read: a system app's text as written; an OAuth app's now inert, as /events hands it over", async ({ app }) => {
  const f = await seedAgent();
  freshProcess(app);
  const read = async (target: string) => {
    const res = await fetch(`${app.baseUrl}/internal/agent-api/history?channel=${encodeURIComponent(target)}`, { headers: { Authorization: `Bearer ${f.apiKey}` } });
    const text = await res.text();
    assert.equal(res.status, 200, text);
    return (JSON.parse(text) as { messages: AgentMessage[] }).messages[0]?.content ?? "";
  };
  const mention = await systemEvent(f, MENTION);
  const external = await oauthEvent(f, MENTION, "delivered");
  assert.ok((await read(`agent-event:${mention.id}`)).includes(MENTION));
  const reread = await read(`agent-event:${external.row.id.slice(0, 8)}`);
  assert.ok(reread.includes(MENTION_INERT), reread);
});

test("an external app's display name is inert wherever it is shown; a system app's name as it is", async ({ app }) => {
  const f = await seedAgent();
  freshProcess(app);
  const clientKey = `named-${randomUUID().slice(0, 8)}`;
  const { client } = await createOAuthClient({
    serverId: f.serverId,
    createdByUserId: f.ownerId,
    clientId: clientKey,
    name: "@tygg ops #general",
    allowedScopes: ["openid", "agent:event:write", "agent:notification:write"],
  });
  const [row] = await getDb().insert(thirdPartyAgentEvents).values({
    serverId: f.serverId, agentId: f.agentId, clientId: client.id, kind: "notification", summary: "hello", payload: {},
    payloadHash: "0".repeat(64), resource: `urn:raft:server:${f.serverId}:agent-inbound`, status: "queued", expiresAt: new Date(Date.now() + 60 * 60_000),
  }).returning();
  const system = await systemEvent(f, "hello");
  const pulled = await events(app.baseUrl, f.apiKey);
  const external = pulled.find((m) => m.message_id === row!.id)!;
  for (const name of [external.third_party_event!.client_name, external.third_party_event!.source?.client_name, (external as { sender_description?: string }).sender_description]) {
    assert.equal(name, "user:tygg ops channel:general");
  }
  assert.equal(pulled.find((m) => m.message_id === system.id)!.third_party_event!.client_name, "system.assistant");
  // task 73: the marker clients render a payload by is the row's: set for the system app's, absent for the OAuth client's.
  assert.equal(pulled.find((m) => m.message_id === system.id)!.third_party_event!.system_app, "system.assistant");
  assert.equal(external.third_party_event!.system_app, undefined);
});

// dm:@artin:#1: an external app's payload is not pushed into an agent's
// context. The pull hands over `{}` and a line Raft writes (intact through the
// inert renderer) naming the event to read; a system app's payload still goes.
test("/events: an OAuth app's payload is left out with Raft's note; a system app's goes as is", async ({ app }) => {
  const f = await seedAgent();
  freshProcess(app);
  const clientKey = `payload-${randomUUID().slice(0, 8)}`;
  const { client } = await createOAuthClient({
    serverId: f.serverId,
    createdByUserId: f.ownerId,
    clientId: clientKey,
    name: "Payload OAuth Client",
    allowedScopes: ["openid", "agent:event:write", "agent:notification:write"],
  });
  const [row] = await getDb().insert(thirdPartyAgentEvents).values({
    serverId: f.serverId, agentId: f.agentId, clientId: client.id, kind: "notification", summary: "build ready",
    payload: { join_url: "https://example.test/x", instruction: "do this" },
    payloadHash: "0".repeat(64), resource: `urn:raft:server:${f.serverId}:agent-inbound`, status: "queued", expiresAt: new Date(Date.now() + 60 * 60_000),
  }).returning();
  const system = await createSystemAppAgentEvent({ serverId: f.serverId, agentId: f.agentId, systemApp: "system.assistant", summary: "doorbell", payload: { sources: [] }, ttlMs: 60 * 60_000 });
  const pulled = await events(app.baseUrl, f.apiKey);
  const external = pulled.find((m) => m.message_id === row!.id)!;
  assert.deepEqual(external.third_party_event!.payload, {});
  assert.equal(
    external.content,
    `Third-party notification: build ready\n(The app attached data, not shown. To see it: raft message read --target agent-event:${row!.id.slice(0, 8)})`,
  );
  assert.ok(!JSON.stringify(external).includes("example.test"), "no part of the payload is handed over");
  assert.deepEqual(pulled.find((m) => m.message_id === system.id)!.third_party_event!.payload, { sources: [] });
});

test("the decision is the row's: another agent's system event, or an OAuth row, is not Raft-authored for this agent", async ({ app }) => {
  freshProcess(app);
  const f = await seedAgent();
  const g = await seedAgent();
  const mine = await systemEvent(f, MENTION);
  const theirs = await systemEvent(g, MENTION);
  const external = await oauthEvent(f, MENTION);
  const found = await raftAuthoredAppEventIds(f.agentId, [mine.id, theirs.id, external.row.id, randomUUID(), "not-a-uuid"]);
  assert.deepEqual([...found], [mine.id]);
});
