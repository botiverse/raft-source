// The confirm tier of a personal assistant's owner actions (#proj-assistant:#19
// PR 2; services/assistantOwnerActionCards.ts). Pins: a confirm entry runs
// nothing when the assistant calls it; Raft posts one card in the owner's DM
// (the same card again while it waits); only the owner decides; Confirm runs
// the stored route on the owner's own session through the real app (a
// failing route reaches the assistant with its own error), Decline runs
// nothing and blocks the same request until the owner writes; an expired card
// ends and the assistant hears it; admission is checked again at Confirm.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { createApiTest } from "../test/integration/apiTest";
import { tokenForHuman } from "../test/integration/credentials";
import { getDb } from "../db/index";
import { actionCards, agents, featureFlags, machines, messages, thirdPartyAgentEvents } from "../db/schema";
import { createAgent } from "../services/agentService";
import { mintAgentCredential } from "../services/agentCredentialService";
import { createFeatureFlag, PERSONAL_ASSISTANT_FEATURE_FLAG_KEY } from "../services/featureFlagService";
import { findOrCreateDM } from "../services/channelService";
import { addMember } from "../services/serverService";
import {
  dispatchOwnerRoute,
  setOwnerDispatchBoundsForTest,
  setOwnerRouteDispatcherForTest,
  sweepExpiredAssistantOwnerActionCards,
  type OwnerRouteDispatcher,
} from "../services/assistantOwnerActionCards";
import { createServer, headers, seedUser } from "./channels.api.fixtures";

const test = createApiTest();

async function enableAssistants() {
  const [existing] = await getDb().select().from(featureFlags).where(eq(featureFlags.key, PERSONAL_ASSISTANT_FEATURE_FLAG_KEY));
  if (existing) {
    await getDb().update(featureFlags).set({ defaultEnabled: true }).where(eq(featureFlags.key, PERSONAL_ASSISTANT_FEATURE_FLAG_KEY));
    return;
  }
  await createFeatureFlag({ key: PERSONAL_ASSISTANT_FEATURE_FLAG_KEY, randomizationUnit: "server", enabled: true, defaultEnabled: true });
}

async function json(res: Response) {
  return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, any> };
}

async function seed() {
  await enableAssistants();
  const suffix = randomUUID().slice(0, 8);
  const owner = await seedUser(`oc-owner-${suffix}@slock.test`, `oc-owner-${suffix}`);
  const other = await seedUser(`oc-other-${suffix}@slock.test`, `oc-other-${suffix}`);
  const server = await createServer("Owner Confirm", `oc-${suffix}`, owner.id);
  await addMember(server.id, other.id, "member");
  const assistant = await createAgent(server.id, `oc-ottie-${suffix}`, { runtime: "codex", creatorType: "user", creatorId: owner.id });
  await getDb().update(agents).set({ assistantOwnerUserId: owner.id, displayName: "Ottie" }).where(eq(agents.id, assistant.id));
  const { apiKey } = await mintAgentCredential({ agentId: assistant.id, scopes: ["read", "send"], name: "oc-test", issuedVia: "computer", createdByUserId: null });
  const dm = await findOrCreateDM(server.id, owner.id, assistant.id);
  assert.ok(dm);
  const [boxA] = await getDb().insert(machines).values({ serverId: server.id, userId: owner.id, name: `box-a-${suffix}`, apiKeyHash: `hash-${randomUUID()}`, lastHeartbeat: new Date() }).returning();
  const [boxB] = await getDb().insert(machines).values({ serverId: server.id, userId: owner.id, name: `box-b-${suffix}`, apiKeyHash: `hash-${randomUUID()}`, lastHeartbeat: new Date() }).returning();
  const worker = await createAgent(server.id, `oc-sage-${suffix}`, { runtime: "codex", creatorType: "user", creatorId: owner.id });
  await getDb().update(agents).set({ machineId: boxA!.id, displayName: "Sage" }).where(eq(agents.id, worker.id));
  const ownerToken = await tokenForHuman(owner.email);
  const otherToken = await tokenForHuman(other.email);
  return { owner, other, server, assistant, apiKey, dmId: dm.id, boxA: boxA!, boxB: boxB!, worker, ownerToken, otherToken };
}

function asAssistant(baseUrl: string, apiKey: string, method: string, path: string, body?: unknown) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then(json);
}

function decide(baseUrl: string, token: string, serverId: string, messageId: string, decision: "confirm" | "decline") {
  return fetch(`${baseUrl}/api/actions/${messageId}/execute`, {
    method: "POST",
    headers: headers(token, serverId),
    body: JSON.stringify({ form: { id: "decision", values: { decision } } }),
  }).then(json);
}

async function cardState(messageId: string) {
  const [row] = await getDb().select({ state: actionCards.state, payload: actionCards.payload }).from(actionCards).where(eq(actionCards.messageId, messageId)).limit(1);
  const [msg] = await getDb().select({ actionMetadata: messages.actionMetadata, channelId: messages.channelId, senderId: messages.senderId }).from(messages).where(eq(messages.id, messageId)).limit(1);
  return { state: row?.state, payload: row?.payload as Record<string, any>, metadata: msg?.actionMetadata as Record<string, any>, channelId: msg?.channelId, senderId: msg?.senderId };
}

async function assistantEvents(agentId: string) {
  return getDb().select({ summary: thirdPartyAgentEvents.summary, payload: thirdPartyAgentEvents.payload, systemApp: thirdPartyAgentEvents.systemApp })
    .from(thirdPartyAgentEvents)
    .where(and(eq(thirdPartyAgentEvents.agentId, agentId), eq(thirdPartyAgentEvents.systemApp, "system.assistant")))
    .orderBy(desc(thirdPartyAgentEvents.createdAt));
}

const migratePath = (agentId: string) => `/api/agents/${agentId}/migrate`;

test("asking posts one card in the owner's DM and runs nothing; asking again answers with the same card", async ({ app }) => {
  const f = await seed();
  let ran = 0;
  setOwnerRouteDispatcherForTest(async () => { ran += 1; return { status: 200, body: {} }; });
  try {
    const first = await asAssistant(app.baseUrl, f.apiKey, "POST", migratePath(f.worker.id), { targetComputer: f.boxB.name });
    assert.equal(first.status, 202, JSON.stringify(first.body));
    assert.equal(first.body.assistant.state, "pending_owner_confirm");
    assert.match(first.body.assistant.text, /^Not done yet\. Raft posted a card in your DM asking .+ to confirm: "Ottie wants to move @oc-sage-\w+ to box-b-\w+ as you"\./);
    const messageId = first.body.assistant.cardMessageId as string;
    const card = await cardState(messageId);
    assert.equal(card.state, "prepared");
    assert.equal(card.channelId, f.dmId, "the card is in the owner's DM with the assistant");
    assert.equal(card.senderId, f.assistant.id);
    assert.equal(card.payload.type, "assistant:owner_action");
    assert.deepEqual(card.payload.request, { method: "POST", path: migratePath(f.worker.id), body: { targetComputer: f.boxB.name } });
    assert.match(card.payload.description, new RegExp(`^Moves @oc-sage-\\w+ from ${f.boxA.name} to ${f.boxB.name}\\..* Files outside its workspace folder stay on ${f.boxA.name}\\.$`));
    // The web shows the card in the viewer's language from this (actionCardMessages moveAgent): the agent
    // by display name, without an @. The assistant's own arguments keep the handle it uses.
    assert.deepEqual(card.payload.view, { kind: "moveAgent", agent: "Sage", from: f.boxA.name, to: f.boxB.name });
    assert.equal(card.payload.args.agent, `@${f.worker.name}`);
    assert.match(first.body.assistant.text, /the card expires at \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}Z\./);
    assert.equal(ran, 0, "nothing ran");

    const again = await asAssistant(app.baseUrl, f.apiKey, "POST", migratePath(f.worker.id), { targetComputer: f.boxB.name });
    assert.equal(again.status, 202);
    assert.equal(again.body.assistant.cardMessageId, messageId, "the same card");
    assert.match(again.body.assistant.text, /^Already waiting for .+ to confirm this/);
    const cards = await getDb().select().from(actionCards).where(eq(actionCards.requesterAgentId, f.assistant.id));
    assert.equal(cards.length, 1);

    // Naming what the owner can't move or a computer that isn't here: refused, no card.
    const noComputer = await asAssistant(app.baseUrl, f.apiKey, "POST", migratePath(f.worker.id), { targetComputer: "nowhere" });
    assert.equal(noComputer.status, 404);
    assert.equal(noComputer.body.error, `No computer named "nowhere" in this server. Computers here: ${[f.boxA.name, f.boxB.name].sort().join(", ")}.`);
    // Offline: refused before any card, so the owner is never asked to confirm a move bound to fail.
    await getDb().update(machines).set({ lastHeartbeat: new Date(Date.now() - 10 * 60_000) }).where(eq(machines.id, f.boxB.id));
    const offline = await asAssistant(app.baseUrl, f.apiKey, "POST", migratePath(f.worker.id), { targetComputer: f.boxB.name });
    assert.equal(offline.status, 409);
    assert.equal(offline.body.code, "assistant_owner_action_target_offline");
    assert.match(offline.body.error, new RegExp(`^${f.boxB.name} is offline \\(last seen \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}Z\\), so moving @oc-sage-\\w+ there would fail\\.`));
    // A runtime the target doesn't have.
    await getDb().update(machines).set({ lastHeartbeat: new Date(), runtimes: ["claude"] }).where(eq(machines.id, f.boxB.id));
    const noRuntime = await asAssistant(app.baseUrl, f.apiKey, "POST", migratePath(f.worker.id), { targetComputer: f.boxB.name });
    assert.equal(noRuntime.status, 409);
    assert.equal(noRuntime.body.code, "assistant_owner_action_runtime_missing");
    const already = await asAssistant(app.baseUrl, f.apiKey, "POST", migratePath(f.worker.id), { targetComputer: f.boxA.name });
    assert.equal(already.status, 409);
    assert.equal(already.body.code, "assistant_owner_action_already_there");
    const extra = await asAssistant(app.baseUrl, f.apiKey, "POST", migratePath(f.worker.id), { targetComputer: f.boxB.name, target: { kind: "hosted" } });
    assert.equal(extra.status, 403);
  } finally {
    setOwnerRouteDispatcherForTest(null);
  }
});

test("Confirm: only the owner; it runs the stored route with the owner's own Authorization and the assistant hears it's done", async ({ app }) => {
  const f = await seed();
  const calls: Parameters<OwnerRouteDispatcher>[0][] = [];
  setOwnerRouteDispatcherForTest(async (input) => { calls.push(input); return { status: 200, body: { state: "preparing", arrivalDeadlineAt: "2026-11-05T15:51:00.000Z" } }; });
  try {
    const asked = await asAssistant(app.baseUrl, f.apiKey, "POST", migratePath(f.worker.id), { targetComputer: f.boxB.name });
    const messageId = asked.body.assistant.cardMessageId as string;

    const notOwner = await decide(app.baseUrl, f.otherToken, f.server.id, messageId, "confirm");
    assert.ok(notOwner.status >= 400 && notOwner.status < 500, JSON.stringify(notOwner.body));
    assert.equal(calls.length, 0);
    assert.equal((await cardState(messageId)).state, "prepared");

    const confirmed = await decide(app.baseUrl, f.ownerToken, f.server.id, messageId, "confirm");
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.ownerRequest.headers.authorization, `Bearer ${f.ownerToken}`, "the owner's own session");
    // Only the live request's Authorization, Cookie, Origin and X-Server-Id; never a forwarding header.
    for (const key of Object.keys(calls[0]!.ownerRequest.headers)) assert.ok(["authorization", "cookie", "origin"].includes(key), key);
    assert.equal(typeof calls[0]!.ownerRequest.clientIp, "string");
    // Nothing of the credential is stored with the card.
    assert.ok(!JSON.stringify((await cardState(messageId)).payload).includes(f.ownerToken));
    assert.ok(!JSON.stringify((await cardState(messageId)).metadata).includes(f.ownerToken));
    assert.deepEqual(calls[0]!.request, { method: "POST", path: migratePath(f.worker.id), body: { targetComputer: f.boxB.name } });
    const card = await cardState(messageId);
    assert.equal(card.state, "executed");
    assert.equal(card.metadata.result.kind, "assistant-owner-action");
    assert.equal(card.metadata.result.ok, true);
    // The card's line as names (the web shows it in the owner's language); the event below stays English.
    assert.deepEqual(card.metadata.result.line, { kind: "moveStarted", agent: "Sage", to: f.boxB.name, arrivalAt: "2026-11-05T15:51:00.000Z" });
    const [event] = await assistantEvents(f.assistant.id);
    assert.ok(event);
    assert.match(event.summary, /^.+ confirmed\. Started moving @oc-sage-\w+ to box-b-\w+; it should arrive by 2026-11-05 15:51:00Z, and @oc-sage-\w+ starts again there\.$/);
    assert.equal((event.payload as Record<string, unknown>).state, "confirmed_done");
    // No reply in the DM: the assistant hears through its event only.
    const replies = await getDb().select().from(messages).where(and(eq(messages.senderType, "agent"), eq(messages.channelId, f.dmId)));
    assert.equal(replies.length, 1, "only the card itself");
    // The owner sees it under "Changed by your assistant": the agent, where it went, that they confirmed.
    const listed = await fetch(`${app.baseUrl}/api/servers/${f.server.id}/assistant/setting-changes`, { headers: { Authorization: `Bearer ${f.ownerToken}`, "X-Server-Id": f.server.id } });
    const changes = ((await listed.json()) as { changes: Array<Record<string, unknown>> }).changes;
    const moved = changes.find((change) => change.setting === "agentMove");
    assert.ok(moved, JSON.stringify(changes));
    assert.equal(moved.targetRef, `@${f.worker.name}`);
    assert.equal(moved.nextValue, f.boxB.name);
    assert.equal(moved.previousValue, f.boxA.name);
    assert.equal(moved.confirmed, true);
    assert.equal(moved.agentId, f.assistant.id, "the assistant that asked, not the owner who confirmed");
  } finally {
    setOwnerRouteDispatcherForTest(null);
  }
});

test("Confirm through the real app: the owner's route answers with its own refusal, and the assistant hears it failed", async ({ app }) => {
  const f = await seed();
  // No stub: the stored route runs in-process through the app on the owner's session. The seeded computers
  // report no runtimes, so the route's own handler refuses; that refusal is what the assistant hears.
  const asked = await asAssistant(app.baseUrl, f.apiKey, "POST", migratePath(f.worker.id), { targetComputer: f.boxB.name });
  const messageId = asked.body.assistant.cardMessageId as string;
  const confirmed = await decide(app.baseUrl, f.ownerToken, f.server.id, messageId, "confirm");
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  const card = await cardState(messageId);
  assert.equal(card.metadata.result.ok, false);
  assert.equal(card.metadata.result.status, 422);
  assert.equal(card.metadata.result.line.kind, "failed");
  assert.match(card.metadata.result.line.error, /Both source and target computers must support the agent's runtime/);
  const [event] = await assistantEvents(f.assistant.id);
  assert.match(event!.summary, /confirmed, but it failed: Both source and target computers must support the agent's runtime \(COMPUTER_CAPABILITY_INSUFFICIENT\)\. Tell .+ what failed\. To try again, call move_agent again: it posts a new card\.$/);
  assert.equal((event!.payload as Record<string, unknown>).state, "confirmed_failed");
});

test("Decline runs nothing; the same request is refused until the owner writes in the DM", async ({ app }) => {
  const f = await seed();
  let ran = 0;
  setOwnerRouteDispatcherForTest(async () => { ran += 1; return { status: 200, body: {} }; });
  try {
    const asked = await asAssistant(app.baseUrl, f.apiKey, "POST", migratePath(f.worker.id), { targetComputer: f.boxB.name });
    const messageId = asked.body.assistant.cardMessageId as string;
    const declined = await decide(app.baseUrl, f.ownerToken, f.server.id, messageId, "decline");
    assert.equal(declined.status, 200, JSON.stringify(declined.body));
    assert.equal(ran, 0);
    assert.deepEqual((await cardState(messageId)).metadata.result.line, { kind: "declined" });
    const [event] = await assistantEvents(f.assistant.id);
    assert.match(event!.summary, /^.+ declined: move @oc-sage-\w+ to box-b-\w+\. Nothing changed\. Don't ask again unless .+ brings it up\.$/);

    const again = await asAssistant(app.baseUrl, f.apiKey, "POST", migratePath(f.worker.id), { targetComputer: f.boxB.name });
    assert.equal(again.status, 409);
    assert.equal(again.body.code, "owner_declined");
    assert.match(again.body.assistant.text, /declined this at .+\. Raft won't post the same card again until .+ writes to you after that\./);

    await getDb().insert(messages).values({ channelId: f.dmId, senderType: "user", senderId: f.owner.id, content: "actually, go ahead", messageType: "chat", createdAt: new Date(Date.now() + 1000) });
    const afterWrite = await asAssistant(app.baseUrl, f.apiKey, "POST", migratePath(f.worker.id), { targetComputer: f.boxB.name });
    assert.equal(afterWrite.status, 202, JSON.stringify(afterWrite.body));
    assert.notEqual(afterWrite.body.assistant.cardMessageId, messageId, "a new card");
  } finally {
    setOwnerRouteDispatcherForTest(null);
  }
});

test("a card nobody answered in time expires and the assistant hears it; a late Confirm runs nothing", async ({ app }) => {
  const f = await seed();
  let ran = 0;
  setOwnerRouteDispatcherForTest(async () => { ran += 1; return { status: 200, body: {} }; });
  try {
    const asked = await asAssistant(app.baseUrl, f.apiKey, "POST", migratePath(f.worker.id), { targetComputer: f.boxB.name });
    const messageId = asked.body.assistant.cardMessageId as string;
    const card = await cardState(messageId);
    const past = new Date(Date.now() - 60_000).toISOString();
    await getDb().update(actionCards).set({ payload: { ...card.payload, expiresAt: past } }).where(eq(actionCards.messageId, messageId));
    await getDb().update(messages).set({ actionMetadata: { ...card.metadata, action: { ...card.metadata.action, expiresAt: past } } }).where(eq(messages.id, messageId));

    assert.equal(await sweepExpiredAssistantOwnerActionCards(null), 1);
    assert.equal((await cardState(messageId)).state, "expired");
    const [event] = await assistantEvents(f.assistant.id);
    assert.match(event!.summary, /^The card to move @oc-sage-\w+ to box-b-\w+ expired without an answer\. Nothing changed\./);

    const late = await decide(app.baseUrl, f.ownerToken, f.server.id, messageId, "confirm");
    assert.ok(late.status >= 400, JSON.stringify(late.body));
    assert.equal(ran, 0);
  } finally {
    setOwnerRouteDispatcherForTest(null);
  }
});

test("admission is checked again at Confirm: a computer gone since the card was posted fails without running the route", async ({ app }) => {
  const f = await seed();
  let ran = 0;
  setOwnerRouteDispatcherForTest(async () => { ran += 1; return { status: 200, body: {} }; });
  try {
    const asked = await asAssistant(app.baseUrl, f.apiKey, "POST", migratePath(f.worker.id), { targetComputer: f.boxB.name });
    const messageId = asked.body.assistant.cardMessageId as string;
    await getDb().update(machines).set({ name: `renamed-${randomUUID().slice(0, 6)}` }).where(eq(machines.id, f.boxB.id));
    const confirmed = await decide(app.baseUrl, f.ownerToken, f.server.id, messageId, "confirm");
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    assert.equal(ran, 0);
    const card = await cardState(messageId);
    assert.equal(card.metadata.result.ok, false);
    const [event] = await assistantEvents(f.assistant.id);
    assert.match(event!.summary, /confirmed, but it failed: No computer named "box-b-\w+" in this server/);
  } finally {
    setOwnerRouteDispatcherForTest(null);
  }
});

test("the context lists the confirm action with Sage's confirm description", async ({ app }) => {
  const f = await seed();
  const context = await asAssistant(app.baseUrl, f.apiKey, "GET", "/internal/agent-api/context");
  assert.equal(context.status, 200, JSON.stringify(context.body));
  const actions = context.body.agent.assistantOf.ownerActions as Array<{ tool: string; tier: string; description: string }>;
  const move = actions.find((action) => action.tool === "move_agent");
  assert.ok(move);
  assert.equal(move.tier, "confirm");
  assert.match(move.description, /^Move an agent to another computer as .+\. Doesn't run until .+ confirms it on a card Raft posts in your DM\.$/);
});

test("a tampered card (its stored route no longer the confirm entry's) runs nothing at Confirm", async ({ app }) => {
  const f = await seed();
  let ran = 0;
  setOwnerRouteDispatcherForTest(async () => { ran += 1; return { status: 200, body: {} }; });
  try {
    const asked = await asAssistant(app.baseUrl, f.apiKey, "POST", migratePath(f.worker.id), { targetComputer: f.boxB.name });
    const messageId = asked.body.assistant.cardMessageId as string;
    for (const tampered of [
      { method: "POST", path: `/api/agents/${f.worker.id}/stop`, body: { targetComputer: f.boxB.name } },
      { method: "DELETE", path: migratePath(f.worker.id), body: { targetComputer: f.boxB.name } },
    ]) {
      const card = await cardState(messageId);
      const action = { ...card.payload, request: tampered };
      await getDb().update(actionCards).set({ payload: action, state: "prepared", result: null, executedAt: null, executedByUserId: null }).where(eq(actionCards.messageId, messageId));
      await getDb().update(messages).set({ actionMetadata: { ...card.metadata, action, state: "prepared", result: null, executedAt: null, executedByUserId: null } }).where(eq(messages.id, messageId));
      const confirmed = await decide(app.baseUrl, f.ownerToken, f.server.id, messageId, "confirm");
      assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
      const after = await cardState(messageId);
      assert.equal(after.metadata.result.ok, false);
      assert.match(after.metadata.result.summary, /no longer something an assistant can ask for/);
    }
    assert.equal(ran, 0, "nothing dispatched");
  } finally {
    setOwnerRouteDispatcherForTest(null);
  }
});

test("no dispatch from inside a dispatch: a dispatched request can't confirm a card, nor come back in as the assistant", async ({ app }) => {
  const f = await seed();
  setOwnerRouteDispatcherForTest(async () => ({ status: 200, body: {} }));
  const asked = await asAssistant(app.baseUrl, f.apiKey, "POST", migratePath(f.worker.id), { targetComputer: f.boxB.name });
  setOwnerRouteDispatcherForTest(null);
  const messageId = asked.body.assistant.cardMessageId as string;
  const expressApp = app.app as unknown as Parameters<typeof dispatchOwnerRoute>[0]["ownerRequest"]["app"];
  // The owner's own session, but from inside a dispatch: the confirm endpoint refuses it.
  const nestedConfirm = await dispatchOwnerRoute({
    ownerRequest: { app: expressApp, headers: { authorization: `Bearer ${f.ownerToken}`}, clientIp: "203.0.113.7" },
    serverId: f.server.id,
    request: { method: "POST", path: `/api/actions/${messageId}/execute`, body: { form: { id: "decision", values: { decision: "confirm" } } } },
    cardMessageId: messageId,
  });
  assert.equal(nestedConfirm.status, 403, JSON.stringify(nestedConfirm.body));
  assert.equal(nestedConfirm.body.errorCode, "OWNER_ACTION_NESTED_DISPATCH");
  assert.equal((await cardState(messageId)).state, "prepared");
  // The assistant's own key, from inside a dispatch: assistantAsOwner refuses it.
  const nestedAssistant = await dispatchOwnerRoute({
    ownerRequest: { app: expressApp, headers: { authorization: `Bearer ${f.apiKey}`}, clientIp: "203.0.113.7" },
    serverId: f.server.id,
    request: { method: "POST", path: migratePath(f.worker.id), body: { targetComputer: f.boxB.name } },
    cardMessageId: messageId,
  });
  assert.equal(nestedAssistant.status, 403, JSON.stringify(nestedAssistant.body));
  assert.equal(nestedAssistant.body.code, "assistant_owner_action_not_allowed");
  const cards = await getDb().select().from(actionCards).where(eq(actionCards.requesterAgentId, f.assistant.id));
  assert.equal(cards.length, 1, "no second card");
});

test("the dispatch is bounded: no answer in time is a 504 that says it may still finish; a large answer is cut and marked; the owner's address is the socket's", async () => {
  setOwnerDispatchBoundsForTest({ timeoutMs: 50, maxBytes: 100 });
  try {
    const silent = await dispatchOwnerRoute({
      ownerRequest: { app: () => { /* never answers */ }, headers: {}, clientIp: "203.0.113.7" },
      serverId: "s", request: { method: "POST", path: "/x", body: {} }, cardMessageId: "m",
    });
    assert.equal(silent.status, 504);
    assert.equal(silent.body.code, "assistant_owner_action_timeout");
    assert.match(String(silent.body.error), /may still finish/);

    let seenAddress: string | undefined;
    let seenForwarded: unknown = "unset";
    const big = await dispatchOwnerRoute({
      ownerRequest: {
        app: (req, res) => {
          seenAddress = req.socket.remoteAddress;
          seenForwarded = req.headers["x-forwarded-for"];
          res.statusCode = 200;
          res.end(JSON.stringify({ blob: "x".repeat(1000) }));
        },
        headers: { authorization: "Bearer t" },
        clientIp: "203.0.113.7",
      },
      serverId: "s", request: { method: "POST", path: "/x", body: {} }, cardMessageId: "m",
    });
    assert.equal(big.status, 200);
    assert.equal(big.body.truncated, true);
    assert.equal(seenAddress, "203.0.113.7");
    assert.equal(seenForwarded, undefined);
  } finally {
    setOwnerDispatchBoundsForTest(null);
  }
});

test("two Confirms at once (phone and desktop): exactly one dispatches, the other is told it's already being confirmed", async ({ app }) => {
  const f = await seed();
  let ran = 0;
  setOwnerRouteDispatcherForTest(async () => {
    ran += 1;
    await new Promise((resolve) => setTimeout(resolve, 300));
    return { status: 200, body: {} };
  });
  try {
    const asked = await asAssistant(app.baseUrl, f.apiKey, "POST", migratePath(f.worker.id), { targetComputer: f.boxB.name });
    const messageId = asked.body.assistant.cardMessageId as string;
    const [a, b] = await Promise.all([
      decide(app.baseUrl, f.ownerToken, f.server.id, messageId, "confirm"),
      decide(app.baseUrl, f.ownerToken, f.server.id, messageId, "confirm"),
    ]);
    assert.equal(ran, 1, "the route ran once");
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [200, 409], JSON.stringify([a.body, b.body]));
    const lost = a.status === 409 ? a : b;
    assert.equal(lost.body.errorCode ?? lost.body.code, "OWNER_ACTION_ALREADY_CONFIRMING");
    assert.equal(lost.body.error, "Already being confirmed.");
    const card = await cardState(messageId);
    assert.equal(card.state, "executed");
    assert.equal(card.metadata.result.ok, true);
    assert.equal((await assistantEvents(f.assistant.id)).length, 1, "one event");
  } finally {
    setOwnerRouteDispatcherForTest(null);
  }
});

test("once the dispatch has started the claim is kept: a throw after it is 'unknown', and a second Confirm runs nothing", async ({ app }) => {
  const f = await seed();
  let ran = 0;
  // 1. The dispatcher itself rejects after it was called: the card ends as unknown, not failed.
  setOwnerRouteDispatcherForTest(async () => { ran += 1; throw new Error("socket hang up after the route ran"); });
  try {
    const asked = await asAssistant(app.baseUrl, f.apiKey, "POST", migratePath(f.worker.id), { targetComputer: f.boxB.name });
    const messageId = asked.body.assistant.cardMessageId as string;
    await decide(app.baseUrl, f.ownerToken, f.server.id, messageId, "confirm");
    assert.equal(ran, 1);
    const card = await cardState(messageId);
    assert.equal(card.metadata.result.unknown, true, JSON.stringify(card.metadata.result));
    const again = await decide(app.baseUrl, f.ownerToken, f.server.id, messageId, "confirm");
    assert.ok(again.status === 200 || again.status === 409, JSON.stringify(again.body)); // an executed card answers with its stored result
    assert.equal(ran, 1, "a second Confirm does not run the route again");
  } finally {
    setOwnerRouteDispatcherForTest(null);
  }

  // 2. Something throws after the dispatcher answered (here: reading its answer): the claim stays.
  ran = 0;
  setOwnerRouteDispatcherForTest(async () => {
    ran += 1;
    return { status: 200, body: Object.defineProperty({}, "code", { get() { throw new Error("broken answer"); } }) as Record<string, unknown> };
  });
  try {
    const asked = await asAssistant(app.baseUrl, f.apiKey, "POST", migratePath(f.worker.id), { targetComputer: f.boxB.name });
    const messageId = asked.body.assistant.cardMessageId as string;
    const first = await decide(app.baseUrl, f.ownerToken, f.server.id, messageId, "confirm");
    assert.notEqual(first.status, 200);
    assert.equal(ran, 1);
    const second = await decide(app.baseUrl, f.ownerToken, f.server.id, messageId, "confirm");
    assert.equal(second.status, 409, JSON.stringify(second.body));
    assert.equal(second.body.errorCode ?? second.body.code, "OWNER_ACTION_ALREADY_CONFIRMING");
    assert.equal(ran, 1, "the claim was kept, so nothing ran twice");
  } finally {
    setOwnerRouteDispatcherForTest(null);
  }
});

test("the route runs in the card's own server, whatever X-Server-Id the Confirm request carries", async ({ app }) => {
  const f = await seed();
  const otherServer = await createServer("Elsewhere", `oc-else-${randomUUID().slice(0, 8)}`, f.owner.id);
  const seen: string[] = [];
  setOwnerRouteDispatcherForTest(async (input) => { seen.push(input.serverId); return { status: 200, body: {} }; });
  try {
    const asked = await asAssistant(app.baseUrl, f.apiKey, "POST", migratePath(f.worker.id), { targetComputer: f.boxB.name });
    const messageId = asked.body.assistant.cardMessageId as string;
    const elsewhere = await decide(app.baseUrl, f.ownerToken, otherServer.id, messageId, "confirm");
    // Either refused before anything ran, or run in the card's server: never in the header's.
    assert.ok(seen.every((serverId) => serverId === f.server.id), JSON.stringify({ seen, elsewhere }));
  } finally {
    setOwnerRouteDispatcherForTest(null);
  }
  // The dispatcher itself: the synthetic request's X-Server-Id is the card's server, never a header passed in.
  let header: unknown;
  await dispatchOwnerRoute({
    ownerRequest: {
      app: (req, res) => { header = req.headers["x-server-id"]; res.statusCode = 200; res.end("{}"); },
      headers: { authorization: "Bearer t", "x-server-id": otherServer.id } as never,
      clientIp: "203.0.113.7",
    },
    serverId: f.server.id, request: { method: "POST", path: "/x", body: {} }, cardMessageId: "m",
  });
  assert.equal(header, f.server.id);
});

test("a claim that outlived its dispatch is failed by the sweep ('it may have run') and the assistant hears it; a fresh claim is left alone", async ({ app }) => {
  const f = await seed();
  setOwnerRouteDispatcherForTest(async () => ({ status: 200, body: {} }));
  try {
    const [boxC] = await getDb().insert(machines).values({ serverId: f.server.id, userId: f.owner.id, name: `box-c-${randomUUID().slice(0, 6)}`, apiKeyHash: `hash-${randomUUID()}`, lastHeartbeat: new Date() }).returning();
    const staleAsk = await asAssistant(app.baseUrl, f.apiKey, "POST", migratePath(f.worker.id), { targetComputer: f.boxB.name });
    const freshAsk = await asAssistant(app.baseUrl, f.apiKey, "POST", migratePath(f.worker.id), { targetComputer: boxC!.name });
    const staleId = staleAsk.body.assistant.cardMessageId as string;
    const freshId = freshAsk.body.assistant.cardMessageId as string;
    await getDb().update(actionCards)
      .set({ result: { kind: "assistant-owner-action-claim", claimedAt: new Date(Date.now() - 2 * 60_000).toISOString(), userId: f.owner.id, decision: "confirm" } })
      .where(eq(actionCards.messageId, staleId));
    await getDb().update(actionCards)
      .set({ result: { kind: "assistant-owner-action-claim", claimedAt: new Date().toISOString(), userId: f.owner.id, decision: "confirm" } })
      .where(eq(actionCards.messageId, freshId));

    assert.equal(await sweepExpiredAssistantOwnerActionCards(null), 1);
    const stale = await cardState(staleId);
    assert.equal(stale.state, "executed");
    assert.equal(stale.metadata.result.ok, false);
    assert.equal(stale.metadata.result.unknown, true);
    const [event] = await assistantEvents(f.assistant.id);
    assert.match(event!.summary, /^.+ confirmed, but Raft didn't hear back in time, so it may have run\. Don't post a new card: check with .+ first\.$/);
    assert.doesNotMatch(event!.summary, /call move_agent again/);
    assert.equal((event!.payload as Record<string, unknown>).state, "confirmed_unknown");
    assert.equal((await cardState(freshId)).state, "prepared", "a fresh claim is left alone");
    // Asking again while the fresh one is being decided: the same card.
    const again = await asAssistant(app.baseUrl, f.apiKey, "POST", migratePath(f.worker.id), { targetComputer: boxC!.name });
    assert.equal(again.body.assistant.cardMessageId, freshId);
  } finally {
    setOwnerRouteDispatcherForTest(null);
  }
});

test("no answer in time is 'unknown', not 'failed': the assistant is told it may have run and not to post a new card", async ({ app }) => {
  const f = await seed();
  setOwnerRouteDispatcherForTest(async () => ({ status: 504, body: { error: "no answer", code: "assistant_owner_action_timeout" } }));
  try {
    const asked = await asAssistant(app.baseUrl, f.apiKey, "POST", migratePath(f.worker.id), { targetComputer: f.boxB.name });
    const messageId = asked.body.assistant.cardMessageId as string;
    const confirmed = await decide(app.baseUrl, f.ownerToken, f.server.id, messageId, "confirm");
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    const card = await cardState(messageId);
    assert.equal(card.metadata.result.ok, false);
    assert.equal(card.metadata.result.unknown, true);
    const [event] = await assistantEvents(f.assistant.id);
    assert.match(event!.summary, /^.+ confirmed, but Raft didn't hear back in time, so it may have run\. Don't post a new card: check with .+ first\.$/);
    assert.doesNotMatch(event!.summary, /call move_agent again/);
    assert.equal((event!.payload as Record<string, unknown>).state, "confirmed_unknown");
  } finally {
    setOwnerRouteDispatcherForTest(null);
  }
});
