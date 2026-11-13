// RFC 081 inbox items for the personal assistant's own events (#wg-ax:#17;
// Tenny, #wg-ax thread 4ee99a1f): `raft message check` goes when the inbox
// flag goes on, so every `system.assistant` event must be readable through
// `raft inbox check` / `raft inbox read`. Each event names its object, so
// unrelated ones are separate rows that each wake: an owner-action card's
// outcome is `app:system.assistant/card/<card message id>` (its DM as the
// related conversation). A second event on an unread row merges without a
// wake (#13995). RaftBench's events stay off the inbox. A personal
// assistant's own credential has app rows only (Tenny, #wg-ax:#17): `inbox
// check` lists no conversation row, a conversation (or reminder, or single
// event) target is refused for read and dismiss, `dismiss --before` takes app
// rows only; its owner DM stays on GET /events. Other agents are unchanged.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, vi } from "vitest";

import { createApiTest } from "../test/integration/apiTest";
import { tokenForHuman } from "../test/integration/credentials";
import { getDb } from "../db/index";
import { agents, featureFlags, machines, thirdPartyAgentEvents } from "../db/schema";
import { createAgent } from "../services/agentService";
import { mintAgentCredential } from "../services/agentCredentialService";
import { AGENT_INBOX_ITEMS_FEATURE_FLAG_KEY, PERSONAL_ASSISTANT_FEATURE_FLAG_KEY, createFeatureFlag } from "../services/featureFlagService";
import { RAFT_CLIENT_CAPABILITIES_HEADER, INBOX_ITEMS_CAPABILITY, MANUAL_CONTEXT_CAPABILITY, REMINDER_SERVER_ACK_CAPABILITY } from "@botiverse/raft-shared";
import { __testRisingWaveInbox, addAgent, addHuman, createChannel, findOrCreateDM, type AgentInboxChainRow } from "../services/channelService";
import { createMessage } from "../services/messageService";
import { addMember } from "../services/serverService";
import { INBOX_ITEMS_LAUNCH_AT_ENV, isItemAppKey, listAgentAppItems } from "../services/agentInboxItems";
import { __resetInboxItemsLaunchWarningsForTests, inboxItemsLaunch } from "../services/inboxItemsLaunch";
import { ownerActionCardObjectRef } from "../services/assistantOwnerActionCards";
import { deliverAssistantSystemEvent, startAssistantDoorbellWorker } from "../services/assistantService";
import { createSystemAppAgentEvent } from "../services/systemAppAgentEvents";
import { createServer, headers, seedUser } from "./channels.api.fixtures";

const test = createApiTest();

beforeEach(() => {
  __resetInboxItemsLaunchWarningsForTests();
  vi.stubEnv(INBOX_ITEMS_LAUNCH_AT_ENV, "2026-01-01T00:00:00.000Z");
});

afterEach(() => {
  __testRisingWaveInbox.reset();
  vi.unstubAllEnvs();
});

/** The agent inbox view (RisingWave in production) answering with these conversation rows for anyone who asks. */
function stubConversations(rows: AgentInboxChainRow[]): void {
  __testRisingWaveInbox.set({
    getPool: () => ({} as never),
    query: (async (_pool: unknown, text: string) => {
      if (/before_count/.test(text)) return { result: { rows: [{ before_count: "0" }] } };
      if (/count\(\*\)/.test(text)) return { result: { rows: [{ conversations: String(rows.length), dms: String(rows.filter((row) => row.kind === "dm").length), mentions: "0" }] } };
      if (!/LIMIT \d+/.test(text)) return { result: { rows: [] } };
      return {
        result: {
          rows: rows.map((row) => ({
            target_id: row.targetId, storage_channel_id: row.storageChannelId, kind: row.kind, server_id: row.serverId,
            channel_name: row.channelName, channel_type: row.channelType, parent_message_id: null, parent_channel_id: null,
            parent_channel_name: null, parent_channel_type: null, last_read_seq: "0", unread_count: "1",
            first_unread_seq: String(row.latestSeq), latest_seq: String(row.latestSeq), mention_unread: "0", max_mention_seq: null,
            subscribed: true, offered_unread: "1", activity_seq: String(row.latestSeq), joined_at: new Date("2026-09-01T00:00:00Z"),
          })),
        },
      };
    }) as never,
  });
}

function conversationRow(input: { targetId: string; serverId: string; channelName: string; latestSeq: number; kind?: "channel" | "dm" }): AgentInboxChainRow {
  return {
    targetId: input.targetId, storageChannelId: input.targetId, serverId: input.serverId, channelName: input.channelName,
    kind: input.kind ?? "channel", channelType: input.kind ?? "channel", latestSeq: input.latestSeq,
  } as AgentInboxChainRow;
}

const CAPABILITIES = `${MANUAL_CONTEXT_CAPABILITY},${INBOX_ITEMS_CAPABILITY},${REMINDER_SERVER_ACK_CAPABILITY}`;
const inbox = (baseUrl: string, apiKey: string, method: "GET" | "POST", path: string, body?: unknown) =>
  call(baseUrl, apiKey, method, `/internal/agent-api/inbox/${path}`, body, { "X-Raft-Client": "cli", [RAFT_CLIENT_CAPABILITIES_HEADER]: CAPABILITIES });
const APP_ONLY_SENTENCE = "Your owner's messages reach you by themselves; inbox read and dismiss here cover app notices only.";

async function seed() {
  const [existing] = await getDb().select().from(featureFlags).where(eq(featureFlags.key, PERSONAL_ASSISTANT_FEATURE_FLAG_KEY));
  if (existing) await getDb().update(featureFlags).set({ defaultEnabled: true }).where(eq(featureFlags.key, PERSONAL_ASSISTANT_FEATURE_FLAG_KEY));
  else await createFeatureFlag({ key: PERSONAL_ASSISTANT_FEATURE_FLAG_KEY, randomizationUnit: "server", enabled: true, defaultEnabled: true });
  await createFeatureFlag({ key: AGENT_INBOX_ITEMS_FEATURE_FLAG_KEY, randomizationUnit: "server", defaultEnabled: true });
  const suffix = randomUUID().slice(0, 8);
  const owner = await seedUser(`ai-owner-${suffix}@slock.test`, `ai-owner-${suffix}`);
  const other = await seedUser(`ai-other-${suffix}@slock.test`, `ai-other-${suffix}`);
  const server = await createServer("Assistant Items", `ai-${suffix}`, owner.id);
  await addMember(server.id, other.id, "member");
  const assistant = await createAgent(server.id, `ai-ottie-${suffix}`, { runtime: "codex", creatorType: "user", creatorId: owner.id });
  await getDb().update(agents).set({ assistantOwnerUserId: owner.id, displayName: "Ottie" }).where(eq(agents.id, assistant.id));
  const { apiKey } = await mintAgentCredential({ agentId: assistant.id, scopes: ["read", "send"], name: "ai-test", issuedVia: "computer", createdByUserId: null });
  const dm = await findOrCreateDM(server.id, owner.id, assistant.id);
  assert.ok(dm);
  const [boxA] = await getDb().insert(machines).values({ serverId: server.id, userId: owner.id, name: `box-a-${suffix}`, apiKeyHash: `hash-${randomUUID()}`, lastHeartbeat: new Date() }).returning();
  const [boxB] = await getDb().insert(machines).values({ serverId: server.id, userId: owner.id, name: `box-b-${suffix}`, apiKeyHash: `hash-${randomUUID()}`, lastHeartbeat: new Date() }).returning();
  const workers = [];
  for (const name of ["sage", "remy"]) {
    const worker = await createAgent(server.id, `ai-${name}-${suffix}`, { runtime: "codex", creatorType: "user", creatorId: owner.id });
    await getDb().update(agents).set({ machineId: boxA!.id }).where(eq(agents.id, worker.id));
    workers.push(worker);
  }
  // The owner's message in the DM: a conversation the assistant has unread, never one of its inbox rows.
  const ownerMessage = await createMessage(dm.id, "user", owner.id, "Can you move Sage for me?");
  return { owner, server, assistant, apiKey, dmId: dm.id, ownerMessage, boxB: boxB!, workers, ownerToken: await tokenForHuman(owner.email) };
}

type Fixture = Awaited<ReturnType<typeof seed>>;

async function call(baseUrl: string, apiKey: string, method: "GET" | "POST", path: string, body?: unknown, extra: Record<string, string> = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, text, body: json };
}

/** The assistant asks to move a worker (a confirm-tier owner action): Raft posts a card in the owner's DM. */
async function askForCard(baseUrl: string, f: Fixture, workerId: string): Promise<string> {
  const asked = await call(baseUrl, f.apiKey, "POST", `/api/agents/${workerId}/migrate`, { targetComputer: f.boxB.name });
  assert.equal(asked.status, 202, asked.text);
  return asked.body.assistant.cardMessageId as string;
}

async function decline(baseUrl: string, f: Fixture, messageId: string) {
  const res = await fetch(`${baseUrl}/api/actions/${messageId}/execute`, {
    method: "POST",
    headers: headers(f.ownerToken, f.server.id),
    body: JSON.stringify({ form: { id: "decision", values: { decision: "decline" } } }),
  });
  assert.equal(res.status, 200, await res.text());
}

async function assistantEvents(agentId: string) {
  return getDb().select().from(thirdPartyAgentEvents)
    .where(and(eq(thirdPartyAgentEvents.agentId, agentId), eq(thirdPartyAgentEvents.systemApp, "system.assistant")))
    .orderBy(asc(thirdPartyAgentEvents.createdAt));
}

test("owner-action results for two different cards are two rows and both wake; a second event on a card while its row is unread merges without a wake", async ({ app }) => {
  const f = await seed();
  const pushes: string[] = [];
  const worker = startAssistantDoorbellWorker({
    agentOrchestrator: { deliverMessage: async (_agentId: string, message: { third_party_event?: { id: string } | null }) => { pushes.push(message.third_party_event!.id); } } as never,
  });
  try {
    const cardA = await askForCard(app.baseUrl, f, f.workers[0]!.id);
    const cardB = await askForCard(app.baseUrl, f, f.workers[1]!.id);
    assert.notEqual(cardA, cardB);
    await decline(app.baseUrl, f, cardA);
    await vi.waitFor(() => assert.equal(pushes.length, 1), { timeout: 5_000 });
    await decline(app.baseUrl, f, cardB);
    await vi.waitFor(() => assert.equal(pushes.length, 2), { timeout: 5_000 });

    // Each outcome names its card, and the card's DM as the related conversation.
    const [eventA, eventB] = await assistantEvents(f.assistant.id);
    assert.deepEqual([eventA!.objectRef, eventB!.objectRef], [`card/${cardA}`, `card/${cardB}`]);
    assert.deepEqual([eventA!.relatedChannelId, eventB!.relatedChannelId], [f.dmId, f.dmId]);
    assert.deepEqual(pushes, [eventA!.id, eventB!.id], "a different card is a different row: both woke");
    assert.deepEqual([eventA!.wakeCoalescedAt, eventB!.wakeCoalescedAt], [null, null]);

    // Card A's row is unread (its push is still in the Computer): another event on it merges.
    const again = await createSystemAppAgentEvent({
      serverId: f.server.id,
      agentId: f.assistant.id,
      systemApp: "system.assistant",
      summary: "Another word about card A.",
      payload: { type: "owner_action", card_message_id: cardA },
      ttlMs: 60 * 60_000,
      objectRef: ownerActionCardObjectRef(cardA),
    });
    assert.equal(await deliverAssistantSystemEvent(again), false, "merged: no wake");
    assert.equal(pushes.length, 2);
    const [merged] = await getDb().select().from(thirdPartyAgentEvents).where(eq(thirdPartyAgentEvents.id, again.id));
    assert.ok(merged!.wakeCoalescedAt instanceof Date);
    assert.equal(merged!.status, "queued", "readable in the row, not consumed");

    // The assistant's own `inbox check`: one app row per card, no conversation row,
    // although the view would offer its owner DM.
    stubConversations([conversationRow({ targetId: f.dmId, serverId: f.server.id, channelName: "dm", latestSeq: f.ownerMessage.seq, kind: "dm" })]);
    const listed = await inbox(app.baseUrl, f.apiKey, "GET", "conversations?items=true");
    assert.equal(listed.status, 200, listed.text);
    assert.deepEqual(listed.body.items, [], "no conversation in the list");
    assert.deepEqual(listed.body.totals, { conversations: 0, dms: 0, mentions: 0 });
    assert.equal(listed.body.preLaunch, null);
    assert.equal(listed.body.appRowsOnly, true, "says so, for the CLI (message check keeps reading its DM through /events)");
    const rows = listed.body.rows as any[];
    assert.deepEqual(rows.map((row) => row.kind), ["app", "app"], "app rows only");
    const byTarget = new Map(rows.map((row) => [row.target, row]));
    assert.deepEqual([...byTarget.keys()].sort(), [`app:system.assistant/card/${cardA}`, `app:system.assistant/card/${cardB}`].sort());
    const rowA = byTarget.get(`app:system.assistant/card/${cardA}`)!;
    assert.equal(rowA.objectRef, `card/${cardA}`);
    assert.equal(rowA.unread, 2);
    assert.equal(rowA.latestSender?.type, "system");
    assert.equal(byTarget.get(`app:system.assistant/card/${cardB}`)!.unread, 1);

    // It reads card A's row: both events, oldest first, consumed.
    const readA = await inbox(app.baseUrl, f.apiKey, "POST", "read", { target: `app:system.assistant/card/${cardA}` });
    assert.equal(readA.status, 200, readA.text);
    assert.equal(readA.body.kind, "app");
    assert.equal(readA.body.entries.length, 2);
    assert.match(readA.body.entries[1].content, /Another word about card A\.$/);
    assert.equal(readA.body.consumed, true);
    for (const id of [eventA!.id, again.id]) {
      const [row] = await getDb().select().from(thirdPartyAgentEvents).where(eq(thirdPartyAgentEvents.id, id));
      assert.deepEqual([row!.status, row!.consumedVia], ["delivered", "read"]);
    }

    // It dismisses card B's row.
    const dismissedB = await inbox(app.baseUrl, f.apiKey, "POST", "dismiss", { target: `app:system.assistant/card/${cardB}` });
    assert.equal(dismissedB.status, 200, dismissedB.text);
    assert.deepEqual([dismissedB.body.appItems, dismissedB.body.conversations], [1, 0]);
    const after = await inbox(app.baseUrl, f.apiKey, "GET", "conversations?items=true");
    assert.deepEqual(after.body.rows, []);
  } finally {
    worker.stop();
  }
});

test("RaftBench's events are still not inbox items; the assistant's are", async ({ db: _db }) => {
  const f = await seed();
  await createSystemAppAgentEvent({ serverId: f.server.id, agentId: f.assistant.id, systemApp: "system.raftbench", summary: "bench run", payload: {}, ttlMs: 60 * 60_000, objectRef: "run-1" });
  await createSystemAppAgentEvent({ serverId: f.server.id, agentId: f.assistant.id, systemApp: "system.assistant", summary: "Morning brief", payload: {}, ttlMs: 60 * 60_000, objectRef: "brief/2026-11-10" });
  const listing = await listAgentAppItems({ serverId: f.server.id, agentId: f.assistant.id, launch: inboxItemsLaunch()! });
  assert.deepEqual(listing.rows.map((row) => row.target), ["app:system.assistant/brief/2026-11-10"]);
  assert.equal(isItemAppKey("system.raftbench"), false);
  assert.equal(isItemAppKey("system.assistant"), true);
});

test("an assistant's conversation, reminder and single-event targets are refused for read and dismiss with one sentence; dismiss --before takes app rows only, never the owner DM", async ({ app }) => {
  const f = await seed();
  stubConversations([conversationRow({ targetId: f.dmId, serverId: f.server.id, channelName: "dm", latestSeq: f.ownerMessage.seq, kind: "dm" })]);
  const event = await createSystemAppAgentEvent({ serverId: f.server.id, agentId: f.assistant.id, systemApp: "system.assistant", summary: "Card ended", payload: {}, ttlMs: 7 * 24 * 60 * 60_000, objectRef: `card/${randomUUID()}`, now: new Date(Date.now() - 3 * 24 * 60 * 60_000) });
  for (const target of [`dm:@${f.owner.name}`, "#general", "reminder:00000000", `agent-event:${event.id}`]) {
    const res = await inbox(app.baseUrl, f.apiKey, "POST", "read", { target });
    assert.equal(res.status, 403, `${target}: ${res.text}`);
    assert.equal(res.body.code, "ASSISTANT_APP_ITEMS_ONLY", target);
    assert.equal(res.body.error, APP_ONLY_SENTENCE);
    assert.equal(res.body.suggestedNextAction, "raft inbox check lists your app notices (app:… rows); read one with raft inbox read --target app:<app>/<ref>.");
    if (target.startsWith("agent-event:")) continue; // one event is never a dismiss target, for anyone
    const dismissed = await inbox(app.baseUrl, f.apiKey, "POST", "dismiss", { target });
    assert.equal(dismissed.status, 403, `${target}: ${dismissed.text}`);
    assert.equal(dismissed.body.code, "ASSISTANT_APP_ITEMS_ONLY", target);
    assert.equal(dismissed.body.error, APP_ONLY_SENTENCE);
  }
  // Nothing moved the owner DM's read position or consumed the event.
  const [stillQueued] = await getDb().select().from(thirdPartyAgentEvents).where(eq(thirdPartyAgentEvents.id, event.id));
  assert.equal(stillQueued!.status, "queued");

  // `before` takes the app row (3 days old) and no conversation.
  const before = await inbox(app.baseUrl, f.apiKey, "POST", "dismiss", { before: new Date(Date.now() - 48 * 60 * 60_000).toISOString() });
  assert.equal(before.status, 200, before.text);
  assert.deepEqual([before.body.appItems, before.body.conversations, before.body.skippedNeedsAck], [1, 0, 0]);
});

test("a non-assistant agent is unchanged: its inbox check lists conversation rows beside app rows, and it reads a conversation target", async ({ app }) => {
  const f = await seed();
  const worker = f.workers[0]!;
  const { apiKey } = await mintAgentCredential({ agentId: worker.id, scopes: ["read", "send"], name: "ai-worker", issuedVia: "computer", createdByUserId: null });
  const room = await createChannel(f.server.id, `room-${randomUUID().slice(0, 6)}`);
  await addHuman(room.id, f.owner.id);
  await addAgent(room.id, worker.id);
  const msg = await createMessage(room.id, "user", f.owner.id, "hello room");
  stubConversations([conversationRow({ targetId: room.id, serverId: f.server.id, channelName: room.name, latestSeq: msg.seq })]);
  await createSystemAppAgentEvent({ serverId: f.server.id, agentId: worker.id, systemApp: "system.assistant", summary: "A notice", payload: {}, ttlMs: 60 * 60_000, objectRef: "brief/2026-11-10" });

  const listed = await inbox(app.baseUrl, apiKey, "GET", "conversations?items=true");
  assert.equal(listed.status, 200, listed.text);
  assert.deepEqual((listed.body.rows as any[]).map((row) => row.target).sort(), [`#${room.name}`, "app:system.assistant/brief/2026-11-10"].sort());
  assert.deepEqual(listed.body.items.map((item: any) => item.target), [`#${room.name}`]);
  assert.equal("appRowsOnly" in listed.body, false, "never on a non-assistant's list");
  const read = await inbox(app.baseUrl, apiKey, "POST", "read", { target: `#${room.name}` });
  assert.equal(read.status, 200, read.text);
  assert.equal(read.body.kind, "conversation");
  assert.deepEqual(read.body.entries.map((entry: any) => entry.content), ["hello room"]);
});
