// RFC 081 step 1, server (#wg-ax:#17): `inbox check` rows (`items=true`),
// `POST /inbox/read` and `POST /inbox/dismiss`. Each test names the D rows of
// the RFC it covers. The conversation list reads the RisingWave agent inbox
// view, stubbed through its test seam as internalAgentApi.inboxList.test.ts
// does; everything else (events, reminders, messages, read positions) is
// real Postgres.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, vi } from "vitest";
import {
  AGENT_INBOX_DISMISS_BEFORE_NEXT_ACTION,
  INBOX_ITEMS_CAPABILITY,
  MANUAL_CONTEXT_CAPABILITY,
  RAFT_CLIENT_CAPABILITIES_HEADER,
  REMINDER_SERVER_ACK_CAPABILITY,
} from "@botiverse/raft-shared";

import { createApiTest } from "../test/integration/apiTest";
import { fixturePasswordHash } from "../test/integration/credentials";
import { getDb } from "../db/index";
import { agents, messages, reminderEvents, reminders, thirdPartyAgentEvents, users } from "../db/schema";
import { reminderSourceAcknowledgements } from "../apps/reminder/sourceAckSchema";
import { createServer } from "../services/serverService";
import { createAgent } from "../services/agentService";
import { __testRisingWaveInbox, addAgent, addHuman, createChannel, getAgentLegacyReadCursor, type AgentInboxChainRow } from "../services/channelService";
import { createMessage } from "../services/messageService";
import * as messageService from "../services/messageService";
import * as agentInboxItems from "../services/agentInboxItems";
import { mintAgentCredential } from "../services/agentCredentialService";
import { buildThirdPartyAgentMessage, createOAuthClient } from "../services/oauthService";
import { renderPushedMessages } from "../services/agentFacingContent";
import { AGENT_INBOX_ITEMS_FEATURE_FLAG_KEY, createFeatureFlag } from "../services/featureFlagService";
import { __setAgentApiWriteBudgetsForTests } from "../services/agentApiWriteLimits";
import { listAgentAppEventsDeliveredBetween } from "../services/agentAppEventsService";
import { INBOX_ITEMS_APP_EVENTS_FROM_ENV, INBOX_ITEMS_LAUNCH_AT_ENV } from "../services/agentInboxItems";
import { __resetInboxItemsLaunchWarningsForTests } from "../services/inboxItemsLaunch";
import * as tracing from "../tracing/semanticTrace";

const test = createApiTest();
const LAUNCH_AT = "2026-01-01T00:00:00.000Z";
const HOUR = 60 * 60 * 1000;

beforeEach(() => {
  __resetInboxItemsLaunchWarningsForTests();
  vi.stubEnv(INBOX_ITEMS_LAUNCH_AT_ENV, LAUNCH_AT);
});

afterEach(() => {
  __testRisingWaveInbox.reset();
  __setAgentApiWriteBudgetsForTests(null);
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// Fixtures

async function seed(label: string, opts: { flag?: boolean } = {}) {
  const db = getDb();
  const suffix = randomUUID().slice(0, 8);
  const [owner] = await db.insert(users).values({
    email: `inbox-items-${label}-${suffix}@slock.test`,
    name: `inbox-items-${label}-${suffix}`,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  const server = await createServer("Inbox Items", `inbox-items-${suffix}`, owner!.id);
  const agent = await createAgent(server.id, `ItemsBot${suffix.slice(0, 4)}`, { runtime: "claude", model: "sonnet" });
  const other = await createAgent(server.id, `OtherBot${suffix.slice(0, 4)}`, { runtime: "claude", model: "sonnet" });
  const general = await createChannel(server.id, `general-${suffix}`);
  await addHuman(general.id, owner!.id);
  await addAgent(general.id, agent.id);
  // Private, without the agent: it can't open it.
  const hidden = await createChannel(server.id, `hidden-${suffix}`, undefined, "private");
  await addHuman(hidden.id, owner!.id);
  const { client } = await createOAuthClient({
    serverId: server.id,
    createdByUserId: owner!.id,
    clientId: `stamp-${suffix}`,
    name: "Stamp",
    allowedScopes: ["openid", "agent:notification:write"],
  });
  if (opts.flag !== false) await createFeatureFlag({ key: AGENT_INBOX_ITEMS_FEATURE_FLAG_KEY, randomizationUnit: "server", defaultEnabled: true });
  const key = async (agentId: string) => (await mintAgentCredential({ agentId, scopes: ["send", "read"], name: "inbox-items", issuedVia: "computer", createdByUserId: null })).apiKey;
  return { owner: owner!, server, agent, other, general, hidden, client, appKey: client.clientId, apiKey: await key(agent.id), otherKey: await key(other.id) };
}

type Fixture = Awaited<ReturnType<typeof seed>>;

async function insertEvent(f: Fixture, input: {
  agentId?: string;
  objectRef?: string | null;
  summary?: string;
  createdAt?: Date;
  expiresAt?: Date;
  status?: "queued" | "delivering" | "delivered" | "expired";
  systemApp?: `system.${string}`;
  relatedChannelId?: string | null;
  payload?: Record<string, unknown>;
}) {
  const createdAt = input.createdAt ?? new Date();
  const [row] = await getDb().insert(thirdPartyAgentEvents).values({
    serverId: f.server.id,
    agentId: input.agentId ?? f.agent.id,
    clientId: input.systemApp ? null : f.client.id,
    systemApp: input.systemApp ?? null,
    kind: "notification",
    summary: input.summary ?? "checks failed",
    payload: input.payload ?? {},
    payloadHash: "0".repeat(64),
    resource: `urn:raft:server:${f.server.id}:agent-inbound`,
    status: input.status ?? "queued",
    createdAt,
    updatedAt: createdAt,
    expiresAt: input.expiresAt ?? new Date(Date.now() + 24 * HOUR),
    objectRef: input.objectRef ?? null,
    relatedChannelId: input.relatedChannelId ?? null,
  }).returning();
  return row!;
}

async function eventRow(id: string) {
  const [row] = await getDb().select().from(thirdPartyAgentEvents).where(eq(thirdPartyAgentEvents.id, id));
  return row!;
}

/** A reminder of the agent with fired revisions; `acked` revisions have their ack row. */
async function seedReminder(f: Fixture, title: string, revisions: number[], acked: number[] = []) {
  const db = getDb();
  const [reminder] = await db.insert(reminders).values({
    serverId: f.server.id,
    ownerAgentId: f.agent.id,
    title,
    fireAt: new Date(),
    status: "fired",
    createdByType: "agent",
    createdById: f.agent.id,
  }).returning();
  for (const [index, revision] of revisions.entries()) {
    const [event] = await db.insert(reminderEvents).values({
      reminderId: reminder!.id,
      serverId: f.server.id,
      ownerAgentId: f.agent.id,
      actorType: "system",
      eventType: "fired",
      occurredAt: new Date(Date.now() - (revisions.length - index) * 60_000),
      metadata: { fired: true, sourceVersion: revision },
    }).returning();
    if (acked.includes(revision)) {
      await db.insert(reminderSourceAcknowledgements).values({
        serverId: f.server.id,
        ownerAgentId: f.agent.id,
        reminderId: reminder!.id,
        sourceVersion: revision,
        sourceEventId: event!.id,
        acknowledgedByAgentId: f.agent.id,
        ackAttemptId: randomUUID(),
      });
    }
  }
  return reminder!;
}

const joinedAt = new Date("2026-09-01T00:00:00.000Z");

function chainRow(input: Pick<AgentInboxChainRow, "targetId" | "serverId" | "channelName" | "latestSeq"> & Partial<AgentInboxChainRow>): AgentInboxChainRow {
  const row = {
    storageChannelId: input.targetId,
    kind: "channel" as const,
    channelType: "channel" as const,
    parentMessageId: null,
    parentChannelId: null,
    parentChannelName: null,
    parentChannelType: null,
    lastReadSeq: 0,
    unreadCount: 1,
    firstUnreadSeq: input.latestSeq,
    mentionUnread: 0,
    maxMentionSeq: null,
    subscribed: true,
    joinedAt,
    ...input,
  };
  return { ...row, offeredUnread: row.unreadCount, activitySeq: input.activitySeq ?? Math.max(row.latestSeq ?? 0, row.maxMentionSeq ?? 0) };
}

/** The agent inbox view over `rows`, answering the totals, pre-launch count and page queries. */
function stubChain(rows: AgentInboxChainRow[]): void {
  __testRisingWaveInbox.set({
    getPool: () => ({} as never),
    query: (async (_pool: unknown, text: string, values: unknown[] = []) => {
      const param = (pattern: RegExp) => {
        const match = text.match(pattern);
        return match ? values[Number(match[1]) - 1] : undefined;
      };
      if (/before_count/.test(text)) {
        return { result: { rows: [{ before_count: String(rows.filter((row) => row.activitySeq < Number(values[1])).length) }] } };
      }
      if (/count\(\*\)/.test(text)) {
        return { result: { rows: [{ conversations: String(rows.length), dms: String(rows.filter((row) => row.kind === "dm").length), mentions: "0" }] } };
      }
      let selected = rows;
      const kind = param(/kind = \$(\d+)/);
      if (kind !== undefined) selected = selected.filter((row) => row.kind === kind);
      const beforeSeq = param(/activity_seq < \$(\d+)/);
      if (beforeSeq !== undefined) selected = selected.filter((row) => row.activitySeq < Number(beforeSeq));
      const limit = text.match(/LIMIT (\d+)/)?.[1];
      if (limit !== undefined) selected = [...selected].sort((a, b) => b.activitySeq - a.activitySeq).slice(0, Number(limit));
      return {
        result: {
          rows: selected.map((row) => ({
            target_id: row.targetId, storage_channel_id: row.storageChannelId, kind: row.kind, server_id: row.serverId,
            channel_name: row.channelName, channel_type: row.channelType, parent_message_id: row.parentMessageId,
            parent_channel_id: row.parentChannelId, parent_channel_name: row.parentChannelName, parent_channel_type: row.parentChannelType,
            last_read_seq: String(row.lastReadSeq), unread_count: String(row.unreadCount),
            first_unread_seq: row.firstUnreadSeq === null ? null : String(row.firstUnreadSeq),
            latest_seq: row.latestSeq === null ? null : String(row.latestSeq), mention_unread: String(row.mentionUnread),
            max_mention_seq: row.maxMentionSeq === null ? null : String(row.maxMentionSeq), subscribed: row.subscribed,
            offered_unread: String(row.offeredUnread), activity_seq: String(row.activitySeq), joined_at: row.joinedAt,
          })),
        },
      };
    }) as never,
  });
}

/** What the CLI declares on its own, and what a daemon before D17 forwards unchanged. */
const CLI_ONLY = `${MANUAL_CONTEXT_CAPABILITY},${INBOX_ITEMS_CAPABILITY}`;
/** What a daemon that acks reminders through the Server forwards (D17): the CLI's tokens plus its own. */
const RUNNER = `${CLI_ONLY},${REMINDER_SERVER_ACK_CAPABILITY}`;

async function call(baseUrl: string, apiKey: string, method: "GET" | "POST", path: string, body?: unknown, capabilities = CLI_ONLY) {
  const res = await fetch(`${baseUrl}/internal/agent-api${path}`, {
    method,
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "X-Raft-Client": "cli", [RAFT_CLIENT_CAPABILITIES_HEADER]: capabilities },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, text, body: json };
}

const read = (baseUrl: string, apiKey: string, body: Record<string, unknown>, capabilities?: string) => call(baseUrl, apiKey, "POST", "/inbox/read", body, capabilities);
const dismiss = (baseUrl: string, apiKey: string, body: Record<string, unknown>, capabilities?: string) => call(baseUrl, apiKey, "POST", "/inbox/dismiss", body, capabilities);
const check = (baseUrl: string, apiKey: string, query = "?items=true", capabilities?: string) => call(baseUrl, apiKey, "GET", `/inbox/conversations${query}`, undefined, capabilities);

// ---------------------------------------------------------------------------
// Switch and compatibility

test("D15 / old CLIs: without items=true, or with the flag off, the list is the conversation list as before; read and dismiss refuse INBOX_ITEMS_DISABLED", async ({ app }) => {
  const f = await seed("off", { flag: false });
  const msg = await createMessage(f.general.id, "user", f.owner.id, "hello");
  stubChain([chainRow({ targetId: f.general.id, serverId: f.server.id, channelName: f.general.name, latestSeq: msg.seq })]);
  await insertEvent(f, { objectRef: "pr-1" });

  const plain = await check(app.baseUrl, f.apiKey, "");
  const ignored = await check(app.baseUrl, f.apiKey);
  assert.equal(plain.status, 200, plain.text);
  assert.deepEqual(Object.keys(plain.body).sort(), ["hasMore", "items", "nextBeforeSeq", "totals", "view"]);
  assert.deepEqual(ignored.body, plain.body, "flag off: items=true is ignored");
  for (const answer of [await read(app.baseUrl, f.apiKey, { target: `app:${f.appKey}/pr-1` }), await dismiss(app.baseUrl, f.apiKey, { target: `app:${f.appKey}/pr-1` })]) {
    assert.equal(answer.status, 404, answer.text);
    assert.equal(answer.body.code, "INBOX_ITEMS_DISABLED");
    assert.equal(answer.body.suggestedNextAction, "raft inbox check");
  }

  // D15: /events answers what it answered before, nothing added.
  const events = await call(app.baseUrl, f.apiKey, "GET", "/events");
  assert.equal(events.status, 200, events.text);
  assert.deepEqual(Object.keys(events.body).sort(), ["ack_mode", "events", "has_more", "inbox_hint", "last_seen_msgId", "last_seen_seq", "pending_notice_ids", "reply_target", "wake_reason"]);
});

test("the flag on without RAFT_INBOX_ITEMS_LAUNCH_AT is off: items=true ignored, read and dismiss INBOX_ITEMS_DISABLED, one warning per process", async ({ app, onTestFinished }) => {
  vi.stubEnv(INBOX_ITEMS_LAUNCH_AT_ENV, "");
  const warn = vi.spyOn(console, "warn");
  onTestFinished(() => warn.mockRestore());
  const f = await seed("no-launch");
  stubChain([]);
  await insertEvent(f, { objectRef: "pr-1" });
  const listed = await check(app.baseUrl, f.apiKey);
  assert.equal(listed.status, 200, listed.text);
  assert.equal("rows" in listed.body, false, "items=true ignored");
  for (const answer of [await read(app.baseUrl, f.apiKey, { target: `app:${f.appKey}/pr-1` }), await dismiss(app.baseUrl, f.apiKey, { target: `app:${f.appKey}/pr-1` })]) {
    assert.equal(answer.status, 404, answer.text);
    assert.equal(answer.body.code, "INBOX_ITEMS_DISABLED");
  }
  const said = warn.mock.calls.filter(([line]) => typeof line === "string" && line.includes("RAFT_INBOX_ITEMS_LAUNCH_AT is not set"));
  assert.equal(said.length, 1, "once per process, at the first evaluation");
});

// ---------------------------------------------------------------------------
// inbox check rows

test("D6 D7 D8 D12 D13: items=true lists reminders first, one app row per object, a fallback row, the related conversation it may open; never another agent's, pre-launch, expired, consumed or RaftBench events", async ({ app }) => {
  const f = await seed("rows");
  const long = `${"word ".repeat(40)}end`;
  const msg = await createMessage(f.general.id, "user", f.owner.id, `${long}\nsecond line`);
  await getDb().update(messages).set({ createdAt: new Date(Date.now() - 60_000) }).where(eq(messages.id, msg.id));
  const now = Date.now();
  stubChain([
    chainRow({ targetId: f.general.id, serverId: f.server.id, channelName: f.general.name, latestSeq: msg.seq }),
  ]);
  for (let i = 0; i < 3; i += 1) await insertEvent(f, { objectRef: "PR-13754", summary: `checks failed ${i}`, relatedChannelId: f.general.id, createdAt: new Date(now - (5 - i) * 1000) });
  await insertEvent(f, { objectRef: null, summary: "weekly digest", createdAt: new Date(now - 1000) });
  await insertEvent(f, { objectRef: "pr-2", relatedChannelId: f.hidden.id, createdAt: new Date(now - 500) });
  await insertEvent(f, { agentId: f.other.id, objectRef: "PR-13754", summary: "not yours" });
  await insertEvent(f, { objectRef: "pr-old", createdAt: new Date("2025-12-31T00:00:00Z") });
  await insertEvent(f, { objectRef: "pr-gone", expiresAt: new Date(Date.now() - HOUR) });
  await insertEvent(f, { objectRef: "pr-read", status: "delivered" });
  await insertEvent(f, { systemApp: "system.raftbench", objectRef: "run-1", summary: "bench run" });
  const reminder = await seedReminder(f, "Check the deploy", [1, 2, 3], [1]);

  const res = await check(app.baseUrl, f.apiKey, "?items=true", RUNNER);
  assert.equal(res.status, 200, res.text);
  const rows = res.body.rows as any[];
  // Reminders first; then app rows and conversations by latest activity, conversations in the list's order.
  assert.deepEqual(rows.map((row) => row.target), [
    `reminder:${reminder.id.slice(0, 8)}`,
    `app:${f.appKey}/pr-2`,
    `app:${f.appKey}`,
    `app:${f.appKey}/PR-13754`,
    `#${f.general.name}`,
  ]);
  const byTarget = new Map(rows.map((row) => [row.target, row]));
  assert.equal(rows[0].kind, "reminder", "reminders first: they need an ack");
  assert.deepEqual(rows[0].ack, [
    { app: "system.reminder", id: reminder.id, revision: "2" },
    { app: "system.reminder", id: reminder.id, revision: "3" },
  ]);
  assert.equal(rows[0].unread, 2);
  assert.equal(rows[0].preLaunch, false);

  const item = byTarget.get(`app:${f.appKey}/PR-13754`);
  assert.ok(item, "case kept in the ref");
  assert.equal(item.kind, "app");
  assert.equal(item.unread, 3, "three notices about one object are one item");
  assert.equal(item.objectRef, "PR-13754");
  assert.deepEqual(item.related, { target: `#${f.general.name}` });
  assert.equal(item.preview, "checks failed 2");
  assert.equal(item.latestSender.type, "app");
  assert.equal(byTarget.get(`app:${f.appKey}`)?.kind, "app_fallback");
  assert.equal(byTarget.get(`app:${f.appKey}/pr-2`)?.related, null, "a conversation the agent can't open is not named");
  for (const absent of ["pr-old", "pr-gone", "pr-read"]) assert.equal(byTarget.has(`app:${f.appKey}/${absent}`), false, absent);
  assert.equal(rows.some((row) => row.app?.key === "system.raftbench"), false, "RaftBench keeps its own path");
  assert.equal(res.text.includes("not yours"), false);

  const conversation = byTarget.get(`#${f.general.name}`);
  assert.equal(conversation.kind, "conversation");
  assert.equal(conversation.conversationKind, "channel");
  assert.equal(conversation.preview.length, 120);
  assert.equal(conversation.previewTruncated, true);
  assert.equal(conversation.latestSender.name, f.owner.name);
  assert.equal(conversation.preLaunch, false);
  assert.equal(res.body.preLaunch, null, "nothing predates the launch day here");
  assert.equal(res.body.omitted, null);
  // The old fields are the conversation list, untouched.
  assert.deepEqual(res.body.items.map((row: any) => row.target), [`#${f.general.name}`]);
  assert.equal(res.text.includes("raft "), false, "no commands on the wire");

  // Page 2 carries conversations only.
  const page2 = await check(app.baseUrl, f.apiKey, `?items=true&before_seq=${msg.seq}`);
  assert.equal(page2.status, 200, page2.text);
  assert.ok(page2.body.rows.every((row: any) => row.kind === "conversation"), page2.text);
});

// ---------------------------------------------------------------------------
// inbox read

test("D4 D1: inbox read gives one page (20 entries), consumes exactly it, says what is left, and the item leaves the list once everything is given out", async ({ app }) => {
  const f = await seed("read");
  stubChain([]);
  const ids: string[] = [];
  for (let i = 0; i < 25; i += 1) ids.push((await insertEvent(f, { objectRef: "pr-1", summary: `notice ${i}`, createdAt: new Date(Date.now() - (25 - i) * 1000) })).id);
  const orchestrator = app.app.get("agentOrchestrator");
  const acked = vi.spyOn(orchestrator, "acknowledgeDeliveredMessages");

  const first = await read(app.baseUrl, f.apiKey, { target: `app:${f.appKey}/pr-1` });
  assert.equal(first.status, 200, first.text);
  assert.equal(first.body.entries.length, 20);
  assert.match(first.body.entries[0].content, /notice 0/, "oldest first");
  // An app entry is the event's envelope with its summary, and no raw data (Tenny; shape Sage's).
  const entry = first.body.entries[0];
  assert.equal(entry.content, "Third-party notification: notice 0");
  assert.equal(entry.message_id, ids[0]);
  assert.equal(entry.sender_type, "third_party_app");
  assert.ok(entry.timestamp);
  assert.deepEqual(
    { id: entry.third_party_event.id, client_id: entry.third_party_event.client_id, client_name: entry.third_party_event.client_name, kind: entry.third_party_event.kind },
    { id: ids[0], client_id: f.appKey, client_name: "Stamp", kind: "notification" },
  );
  for (const key of ["payload", "payload_hash"]) assert.equal(key in entry.third_party_event, false, key);
  assert.equal("resource" in (entry.third_party_event.source ?? {}), false, "resource");
  assert.deepEqual([first.body.unreadBefore, first.body.remaining, first.body.remainingCapped, first.body.consumed, first.body.nextCursor], [25, 5, false, false, null]);
  assert.equal((await eventRow(ids[19]!)).consumedVia, "read");
  assert.equal((await eventRow(ids[19]!)).status, "delivered");
  assert.equal((await eventRow(ids[20]!)).status, "queued", "what was not returned is not consumed");
  assert.ok(acked.mock.calls.some(([agentId, , messageIds]) => agentId === f.agent.id && (messageIds as string[]).includes(ids[0]!)), "the pending queue is cleared");
  assert.equal((await check(app.baseUrl, f.apiKey)).body.rows.find((row: any) => row.target === `app:${f.appKey}/pr-1`)?.unread, 5);

  const second = await read(app.baseUrl, f.apiKey, { target: `app:${f.appKey}/pr-1` });
  assert.deepEqual([second.body.entries.length, second.body.remaining, second.body.consumed], [5, 0, true]);
  assert.equal((await check(app.baseUrl, f.apiKey)).body.rows.some((row: any) => row.target === `app:${f.appKey}/pr-1`), false, "consumed: no longer listed");

  // A consumed item read again: 200, nothing (message read is the re-read path, D5).
  const again = await read(app.baseUrl, f.apiKey, { target: `app:${f.appKey}/pr-1` });
  assert.equal(again.status, 200, again.text);
  assert.deepEqual([again.body.entries.length, again.body.remaining, again.body.consumed], [0, 0, true]);
});

test("D4: the page budget is 8,000 chars of content, always at least one entry, an entry over it given whole", async ({ app }) => {
  const f = await seed("budget");
  for (let i = 0; i < 6; i += 1) await insertEvent(f, { objectRef: "big", summary: `${i}${"x".repeat(1990)}`, createdAt: new Date(Date.now() - (6 - i) * 1000) });
  const page = await read(app.baseUrl, f.apiKey, { target: `app:${f.appKey}/big` });
  assert.equal(page.status, 200, page.text);
  const total = page.body.entries.reduce((sum: number, entry: any) => sum + entry.content.length, 0);
  assert.equal(page.body.entries.length, 3, `3 entries of ~2,020 chars fit, a 4th would pass 8,000 (got ${total})`);
  assert.ok(total <= 8_000);
  assert.equal(page.body.remaining, 3);

  // An app event's payload is not in an inbox read at all (message read of agent-event:<id> shows it).
  const withPayload = await insertEvent(f, { objectRef: "data", summary: "has data", payload: { blob: "y".repeat(20_000) } });
  const data = await read(app.baseUrl, f.apiKey, { target: `app:${f.appKey}/data` });
  assert.equal(data.body.entries.length, 1);
  assert.equal(data.text.includes("y".repeat(100)), false, "no payload anywhere in the page");
  const full = await call(app.baseUrl, f.apiKey, "GET", `/history?channel=${encodeURIComponent(`agent-event:${withPayload.id}`)}`);
  assert.ok(full.text.includes("y".repeat(100)), "message read still shows the event in full");

  // One message far over the budget still goes out, whole.
  await createMessage(f.general.id, "user", f.owner.id, "z".repeat(9_000));
  await createMessage(f.general.id, "user", f.owner.id, "after");
  const huge = await read(app.baseUrl, f.apiKey, { target: `#${f.general.name}` });
  assert.equal(huge.body.entries.length, 1);
  assert.equal(huge.body.entries[0].content.length, 9_000, "not cut");
  assert.deepEqual([huge.body.remaining, huge.body.consumed], [1, false]);
});

test("D6: another agent's item and an unknown one answer the same bytes; an expired item 410 EXPIRED; malformed targets and cursors 400", async ({ app }) => {
  const f = await seed("neutral");
  await insertEvent(f, { agentId: f.other.id, objectRef: "theirs", summary: "secret" });
  await insertEvent(f, { objectRef: "stale", expiresAt: new Date(Date.now() - HOUR) });
  await insertEvent(f, { objectRef: "mine" });

  const theirs = await read(app.baseUrl, f.apiKey, { target: `app:${f.appKey}/theirs` });
  const unknown = await read(app.baseUrl, f.apiKey, { target: `app:${f.appKey}/nothing-here` });
  const unknownApp = await read(app.baseUrl, f.apiKey, { target: "app:no-such-app/x" });
  const theirsDismiss = await dismiss(app.baseUrl, f.apiKey, { target: `app:${f.appKey}/theirs` });
  assert.equal(theirs.status, 404);
  assert.equal(theirs.body.code, "NOT_FOUND");
  assert.equal(theirs.text, unknown.text, "not yours and unknown are the same bytes");
  assert.equal(theirs.text, unknownApp.text);
  assert.equal(theirsDismiss.text, theirs.text);
  assert.equal(theirs.text.includes("secret"), false);
  assert.equal((await read(app.baseUrl, f.otherKey, { target: `app:${f.appKey}/theirs` })).status, 200, "control: it is the other agent's");

  const expired = await read(app.baseUrl, f.apiKey, { target: `app:${f.appKey}/stale` });
  assert.equal(expired.status, 410, expired.text);
  assert.equal(expired.body.code, "EXPIRED");

  for (const target of ["app:Bad Key", `app:${f.appKey}/-bad`, "reminder:xyz", "agent-event:nothex"]) {
    const bad = await read(app.baseUrl, f.apiKey, { target });
    assert.equal(bad.status, 400, `${target}: ${bad.text}`);
    assert.equal(bad.body.code, "INVALID_TARGET");
  }
  const cursor = await read(app.baseUrl, f.apiKey, { target: `app:${f.appKey}/mine`, cursor: "1" });
  assert.equal(cursor.status, 400);
  assert.equal(cursor.body.code, "INVALID_CURSOR");
});

test("D13: a reminder is shown with an ack per revision, pages with nextCursor, and reading writes nothing", async ({ app }) => {
  const f = await seed("reminder");
  stubChain([]);
  const reminder = await seedReminder(f, "Check the deploy", [1, 2, 3], [1]);
  const target = `reminder:${reminder.id.slice(0, 8)}`;
  // Fired before launch and never acked: not an item; it stays on the old path (D9).
  const prelaunch = await seedReminder(f, "From before launch", [4]);
  await getDb().update(reminderEvents).set({ occurredAt: new Date("2025-06-01T00:00:00Z") }).where(eq(reminderEvents.reminderId, prelaunch.id));
  const prelaunchTarget = `reminder:${prelaunch.id.slice(0, 8)}`;
  assert.equal((await check(app.baseUrl, f.apiKey, "?items=true", RUNNER)).body.rows.some((row: any) => row.target === prelaunchTarget), false);
  const prelaunchRead = await read(app.baseUrl, f.apiKey, { target: prelaunchTarget }, RUNNER);
  const unknownReminder = await read(app.baseUrl, f.apiKey, { target: "reminder:00000000" }, RUNNER);
  assert.equal(prelaunchRead.status, 404, prelaunchRead.text);
  assert.equal(prelaunchRead.text, unknownReminder.text, "a pre-launch reminder reads as an unknown one");
  const prelaunchDismiss = await dismiss(app.baseUrl, f.apiKey, { target: prelaunchTarget }, RUNNER);
  assert.equal(prelaunchDismiss.text, unknownReminder.text);

  const first = await read(app.baseUrl, f.apiKey, { target, limit: 1 }, RUNNER);
  assert.equal(first.status, 200, first.text);
  assert.equal(first.body.kind, "reminder");
  assert.equal(first.body.consumed, false);
  assert.deepEqual(first.body.entries.map((entry: any) => entry.ack), [{ app: "system.reminder", id: reminder.id, revision: "2" }]);
  assert.match(first.body.entries[0].content, /Check the deploy/);
  // The fields the shared message line reads, as an app event entry has them.
  const fired = first.body.entries[0];
  assert.deepEqual(
    { sender_type: fired.sender_type, sender_name: fired.sender_name, target: fired.target },
    { sender_type: "system", sender_name: "Reminder", target },
  );
  assert.ok(fired.timestamp && fired.message_id);
  for (const key of ["senderType", "senderName", "createdAt"]) assert.equal(key in fired, false, key);
  assert.deepEqual(first.body.ack.map((ack: any) => ack.revision), ["2", "3"]);
  assert.equal(first.body.remaining, 1);
  assert.equal(first.body.nextCursor, "1");
  const next = await read(app.baseUrl, f.apiKey, { target, cursor: first.body.nextCursor }, RUNNER);
  assert.deepEqual(next.body.entries.map((entry: any) => entry.ack.revision), ["3"]);
  assert.equal(next.body.nextCursor, null);
  const bad = await read(app.baseUrl, f.apiKey, { target, cursor: "9" }, RUNNER);
  assert.equal(bad.body.code, "INVALID_CURSOR");

  // Nothing was written: the reminder is still listed with both revisions.
  const listed = (await check(app.baseUrl, f.apiKey, "?items=true", RUNNER)).body.rows.find((row: any) => row.target === target);
  assert.equal(listed?.unread, 2);
  const acks = await getDb().select().from(reminderSourceAcknowledgements).where(eq(reminderSourceAcknowledgements.reminderId, reminder.id));
  assert.equal(acks.length, 1);

  // Another agent's reminder is not found, like an unknown id.
  const theirs = await read(app.baseUrl, f.otherKey, { target }, RUNNER);
  const unknown = await read(app.baseUrl, f.otherKey, { target: "reminder:00000000" }, RUNNER);
  assert.equal(theirs.status, 404);
  assert.equal(theirs.text, unknown.text);
});

test("D17: without the reminder server-ack token a fired, unacked reminder is no item: not listed or counted, read and dismiss --target answer as an unknown target, dismiss --before skips none", async ({ app }) => {
  const f = await seed("reminder-no-token");
  stubChain([]);
  const reminder = await seedReminder(f, "Ack me on the server", [1]);
  await getDb().update(reminderEvents).set({ occurredAt: new Date(Date.now() - 72 * HOUR) }).where(eq(reminderEvents.reminderId, reminder.id));
  const target = `reminder:${reminder.id.slice(0, 8)}`;

  const listed = await check(app.baseUrl, f.apiKey);
  assert.equal(listed.status, 200, listed.text);
  assert.deepEqual(listed.body.rows, [], "no reminder row");
  assert.equal(listed.body.omitted, null, "and none counted");

  // Exactly what an unknown reminder answers today, with or without the token.
  const unknownRead = await read(app.baseUrl, f.apiKey, { target: "reminder:00000000" }, RUNNER);
  assert.equal(unknownRead.status, 404, unknownRead.text);
  for (const ref of [target, `reminder:${reminder.id}`]) {
    const res = await read(app.baseUrl, f.apiKey, { target: ref });
    assert.equal(res.status, 404, `${ref}: ${res.text}`);
    assert.equal(res.text, unknownRead.text, ref);
  }
  const unknownDismiss = await dismiss(app.baseUrl, f.apiKey, { target: "reminder:00000000" }, RUNNER);
  const targetDismiss = await dismiss(app.baseUrl, f.apiKey, { target });
  assert.equal(targetDismiss.status, 404, targetDismiss.text);
  assert.equal(targetDismiss.body.code, "NOT_FOUND", "not NEEDS_ACK: it can't be acked from here");
  assert.equal(targetDismiss.text, unknownDismiss.text);

  const before = new Date(Date.now() - 48 * HOUR).toISOString();
  const skipped = await dismiss(app.baseUrl, f.apiKey, { before });
  assert.equal(skipped.status, 200, skipped.text);
  assert.equal(skipped.body.skippedNeedsAck, 0);

  // Control: the same reminder is an item for a runner that declares the token.
  assert.deepEqual((await check(app.baseUrl, f.apiKey, "?items=true", RUNNER)).body.rows.map((row: any) => row.target), [target]);
  assert.equal((await read(app.baseUrl, f.apiKey, { target }, RUNNER)).status, 200);
  assert.equal((await dismiss(app.baseUrl, f.apiKey, { target }, RUNNER)).body.code, "NEEDS_ACK");
  assert.equal((await dismiss(app.baseUrl, f.apiKey, { before }, RUNNER)).body.skippedNeedsAck, 1);
  const acks = await getDb().select().from(reminderSourceAcknowledgements).where(eq(reminderSourceAcknowledgements.reminderId, reminder.id));
  assert.equal(acks.length, 0, "nothing above acked it");
});

test("D17: with the token a fired reminder is listed once with its ack; acked through the server's ack route, the next inbox check no longer lists it", async ({ app }) => {
  const f = await seed("reminder-server-ack");
  stubChain([]);
  const reminder = await seedReminder(f, "Ack me on the server", [1]);
  const target = `reminder:${reminder.id.slice(0, 8)}`;

  const before = await check(app.baseUrl, f.apiKey, "?items=true", RUNNER);
  assert.equal(before.status, 200, before.text);
  const rows = (before.body.rows as any[]).filter((row) => row.kind === "reminder");
  assert.deepEqual(rows.map((row) => row.target), [target], "listed once");
  assert.deepEqual(rows[0].ack, [{ app: "system.reminder", id: reminder.id, revision: "1" }]);

  // The ack the fixed daemon sends (`raft reminder ack --id <id> --revision 1`): the Server's own route writes the ack row.
  const ackKey = (await mintAgentCredential({ agentId: f.agent.id, scopes: ["send", "read", "tasks"], name: "inbox-items-ack", issuedVia: "computer", createdByUserId: null })).apiKey;
  const ack = await call(app.baseUrl, ackKey, "POST", "/app-sources/ack", {
    itemId: `reminder:${reminder.id}:1`,
    appId: rows[0].ack[0].app,
    notificationClass: "due",
    sourceRef: { kind: "reminder", id: rows[0].ack[0].id, revision: rows[0].ack[0].revision },
    ackAttemptId: randomUUID(),
  }, RUNNER);
  assert.equal(ack.status, 200, ack.text);
  assert.equal(ack.body.ok, true);
  const acks = await getDb().select().from(reminderSourceAcknowledgements).where(eq(reminderSourceAcknowledgements.reminderId, reminder.id));
  assert.deepEqual(acks.map((row) => row.sourceVersion), [1], "the server ack row exists");

  const after = await check(app.baseUrl, f.apiKey, "?items=true", RUNNER);
  assert.equal(after.status, 200, after.text);
  assert.equal((after.body.rows as any[]).some((row) => row.target === target), false, after.text);
  assert.equal(after.body.omitted, null);
});

test("D21: a canceled reminder's fires and a deleted owner's are no rows: not listed, nothing to ack on a read; the records stay and the fire can still be acked", async ({ app }) => {
  const f = await seed("reminder-d21");
  stubChain([]);
  const kept = await seedReminder(f, "Still wanted", [1]);
  const canceled = await seedReminder(f, "Canceled after it fired", [1, 2]);
  await getDb().update(reminders).set({ status: "canceled", canceledAt: new Date() }).where(eq(reminders.id, canceled.id));
  const target = `reminder:${canceled.id.slice(0, 8)}`;

  const listed = await check(app.baseUrl, f.apiKey, "?items=true", RUNNER);
  assert.equal(listed.status, 200, listed.text);
  assert.deepEqual(
    (listed.body.rows as any[]).filter((row) => row.kind === "reminder").map((row) => row.target),
    [`reminder:${kept.id.slice(0, 8)}`],
    "the canceled reminder has no row; the other keeps its own",
  );
  assert.equal(listed.body.omitted, null);

  const shown = await read(app.baseUrl, f.apiKey, { target }, RUNNER);
  assert.equal(shown.status, 200, shown.text);
  assert.deepEqual([shown.body.entries, shown.body.ack, shown.body.unreadBefore], [[], [], 0], "nothing of it is left to ack");

  // The fire itself is still there and can be acked (a daemon's local copy of it).
  const fires = await getDb().select().from(reminderEvents).where(eq(reminderEvents.reminderId, canceled.id));
  assert.equal(fires.length, 2, "no row was deleted");
  const ackKey = (await mintAgentCredential({ agentId: f.agent.id, scopes: ["send", "read", "tasks"], name: "inbox-items-d21", issuedVia: "computer", createdByUserId: null })).apiKey;
  const ack = await call(app.baseUrl, ackKey, "POST", "/app-sources/ack", {
    itemId: `reminder:${canceled.id}:1`,
    appId: "system.reminder",
    notificationClass: "due",
    sourceRef: { kind: "reminder", id: canceled.id, revision: "1" },
    ackAttemptId: randomUUID(),
  }, RUNNER);
  assert.equal(ack.status, 200, ack.text);

  // A reminder that is scheduled again (a recurring one) or fired is listed as before: only `canceled` hides.
  await getDb().update(reminders).set({ status: "scheduled", canceledAt: null }).where(eq(reminders.id, canceled.id));
  const again = await check(app.baseUrl, f.apiKey, "?items=true", RUNNER);
  assert.deepEqual(
    (again.body.rows as any[]).find((row) => row.target === target)?.ack,
    [{ app: "system.reminder", id: canceled.id, revision: "2" }],
    "not canceled: its one unacked fire is a row again",
  );

  // A deleted owner's fires are nobody's rows.
  assert.equal((await agentInboxItems.unackedReminderFires({ serverId: f.server.id, agentId: f.agent.id, since: new Date(0) })).length, 2);
  await getDb().update(agents).set({ deletedAt: new Date() }).where(eq(agents.id, f.agent.id));
  assert.deepEqual(await agentInboxItems.unackedReminderFires({ serverId: f.server.id, agentId: f.agent.id, since: new Date(0) }), []);
});

test("D22: a recurring reminder lists only its latest fire: earlier un-acked fires are not listed and need no ack; one that doesn't recur keeps an ack per revision", async ({ app }) => {
  const f = await seed("reminder-d22");
  stubChain([]);
  const recurring = await seedReminder(f, "Every hour", [1, 2, 3]);
  await getDb().update(reminders).set({ status: "scheduled", recurrence: { kind: "interval", everyMs: 3_600_000 } }).where(eq(reminders.id, recurring.id));
  const once = await seedReminder(f, "Snoozed twice", [1, 2]);
  const target = `reminder:${recurring.id.slice(0, 8)}`;
  const rowsOf = async () => {
    const listed = await check(app.baseUrl, f.apiKey, "?items=true", RUNNER);
    assert.equal(listed.status, 200, listed.text);
    return new Map((listed.body.rows as any[]).filter((row) => row.kind === "reminder").map((row) => [row.target as string, row]));
  };

  const rows = await rowsOf();
  assert.deepEqual(rows.get(target)?.ack, [{ app: "system.reminder", id: recurring.id, revision: "3" }], "the latest fire only");
  assert.equal(rows.get(target)?.unread, 1);
  assert.deepEqual(
    rows.get(`reminder:${once.id.slice(0, 8)}`)?.ack.map((ack: any) => ack.revision),
    ["1", "2"],
    "a reminder that doesn't recur: every un-acked revision, as before",
  );
  const shown = await read(app.baseUrl, f.apiKey, { target }, RUNNER);
  assert.deepEqual(shown.body.entries.map((entry: any) => entry.ack.revision), ["3"]);

  // Acking the latest clears the row, though fires 1 and 2 have no ack row.
  const ackKey = (await mintAgentCredential({ agentId: f.agent.id, scopes: ["send", "read", "tasks"], name: "inbox-items-d22", issuedVia: "computer", createdByUserId: null })).apiKey;
  const ack = await call(app.baseUrl, ackKey, "POST", "/app-sources/ack", {
    itemId: `reminder:${recurring.id}:3`,
    appId: "system.reminder",
    notificationClass: "due",
    sourceRef: { kind: "reminder", id: recurring.id, revision: "3" },
    ackAttemptId: randomUUID(),
  }, RUNNER);
  assert.equal(ack.status, 200, ack.text);
  assert.equal((await rowsOf()).has(target), false, "nothing of it is listed");
  assert.equal((await getDb().select().from(reminderSourceAcknowledgements).where(eq(reminderSourceAcknowledgements.reminderId, recurring.id))).length, 1, "no ack was written for the earlier fires");

  // It fires again: that fire is the row.
  await getDb().insert(reminderEvents).values({
    reminderId: recurring.id, serverId: f.server.id, ownerAgentId: f.agent.id, actorType: "system", eventType: "fired",
    occurredAt: new Date(), metadata: { fired: true, sourceVersion: 4 },
  });
  assert.deepEqual((await rowsOf()).get(target)?.ack, [{ app: "system.reminder", id: recurring.id, revision: "4" }]);
});

test("D1 D5 D6: message read of agent-event:<id> consumes that event on the server, so its item counts one fewer; message read still re-reads it", async ({ app }) => {
  const f = await seed("event-read");
  stubChain([]);
  const a = await insertEvent(f, { objectRef: "pr-9", summary: "first", createdAt: new Date(Date.now() - 2000) });
  await insertEvent(f, { objectRef: "pr-9", summary: "second" });
  const history = (target: string) => call(app.baseUrl, f.apiKey, "GET", `/history?channel=${encodeURIComponent(target)}`);

  const shown = await history(`agent-event:${a.id.slice(0, 8)}`);
  assert.equal(shown.status, 200, shown.text);
  const row = await eventRow(a.id);
  assert.deepEqual([row.status, row.consumedVia], ["delivered", "read"]);
  const item = (await check(app.baseUrl, f.apiKey)).body.rows.find((r: any) => r.target === `app:${f.appKey}/pr-9`);
  assert.equal(item?.unread, 1);
  assert.equal((await history(`agent-event:${a.id.slice(0, 8)}`)).status, 200, "still re-readable (D5)");

  // inbox read of one event: the same, kind event.
  const one = await read(app.baseUrl, f.apiKey, { target: `agent-event:${a.id}` });
  assert.equal(one.status, 200, one.text);
  assert.deepEqual([one.body.kind, one.body.entries.length, one.body.consumed], ["event", 1, true]);
});

test("D1 D4: a conversation reads as message read --unread does: its unread page, cut to the budget, consumed, with what is left", async ({ app }) => {
  const f = await seed("conversation");
  for (let i = 0; i < 5; i += 1) await createMessage(f.general.id, "user", f.owner.id, `${i} ${"m".repeat(3000)}`);
  const page = await read(app.baseUrl, f.apiKey, { target: `#${f.general.name}` });
  assert.equal(page.status, 200, page.text);
  assert.equal(page.body.kind, "conversation");
  assert.equal(page.body.entries.length, 2, "two 3,000-char messages fit 8,000; a third would not");
  assert.deepEqual([page.body.remaining, page.body.consumed, page.body.unreadBefore], [3, false, 5]);
  const cursor = await getAgentLegacyReadCursor(f.agent.id, f.general.id);
  assert.equal(Number(cursor), page.body.entries[1].seq, "the read position moved through exactly the page");

  const rest = await read(app.baseUrl, f.apiKey, { target: `#${f.general.name}`, limit: 20 });
  assert.deepEqual([rest.body.entries.length, rest.body.remaining], [2, 1]);
  const last = await read(app.baseUrl, f.apiKey, { target: `#${f.general.name}` });
  assert.deepEqual([last.body.entries.length, last.body.remaining, last.body.consumed], [1, 0, true]);

  // A conversation the agent can't see keeps message read's own answer.
  const hidden = await read(app.baseUrl, f.apiKey, { target: `#${f.hidden.name}` });
  assert.ok([403, 404].includes(hidden.status), hidden.text);
});

test("a body with blanks at either end reads: inbox read gives it trimmed at both ends (as CLIs up to 1.0.69 need), message read keeps its leading blanks", async ({ app }) => {
  const f = await seed("blanks");
  // What a heredoc send stores (a trailing line break), and a first line of indented code.
  const heredoc = await createMessage(f.general.id, "user", f.owner.id, "sent from a heredoc\n");
  const indented = await createMessage(f.general.id, "user", f.owner.id, "    indented first line\nsecond line\n\n");
  await insertEvent(f, { objectRef: "pr-5", summary: "  checks failed \n" });

  const page = await read(app.baseUrl, f.apiKey, { target: `#${f.general.name}` });
  assert.equal(page.status, 200, page.text);
  assert.deepEqual(page.body.entries.map((entry: any) => entry.content), ["sent from a heredoc", "indented first line\nsecond line"]);
  assert.equal(Number(await getAgentLegacyReadCursor(f.agent.id, f.general.id)), Number(indented.seq), "read, so marked read");

  const history = await call(app.baseUrl, f.apiKey, "GET", `/history?channel=${encodeURIComponent(`#${f.general.name}`)}&limit=10`);
  assert.equal(history.status, 200, history.text);
  const bodies = new Map(history.body.messages.map((message: any) => [message.id, message.content]));
  assert.equal(bodies.get(heredoc.id), "sent from a heredoc");
  assert.equal(bodies.get(indented.id), "    indented first line\nsecond line");

  const item = await read(app.baseUrl, f.apiKey, { target: `app:${f.appKey}/pr-5` });
  assert.equal(item.status, 200, item.text);
  assert.equal(item.body.entries.length, 1);
});

test("a read whose response breaks the contract answers 500 and consumes nothing: the read position and the app events stay, and the next read gives them", async ({ app, onTestFinished }) => {
  const f = await seed("unsendable");
  stubChain([]);
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  onTestFinished(() => errors.mockRestore());
  const message = await createMessage(f.general.id, "user", f.owner.id, "still unread after a failed read");
  const conversation = `#${f.general.name}`;
  const historyUnread = () => call(app.baseUrl, f.apiKey, "GET", `/history?channel=${encodeURIComponent(conversation)}&unread=true`);
  const cursor = async () => Number(await getAgentLegacyReadCursor(f.agent.id, f.general.id)) || 0;

  // A conversation: the body is not a string, so the page fails its contract.
  const brokenBody = vi.spyOn(messageService, "appendAgentFacingForwardedSnapshot").mockReturnValue(42 as never);
  const failedInbox = await read(app.baseUrl, f.apiKey, { target: conversation });
  assert.equal(failedInbox.status, 500, failedInbox.text);
  assert.equal(await cursor(), 0, "inbox read: the read position did not move");
  const failedHistory = await historyUnread();
  assert.equal(failedHistory.status, 500, failedHistory.text);
  assert.equal(await cursor(), 0, "message read --unread: the read position did not move");
  brokenBody.mockRestore();
  const given = await read(app.baseUrl, f.apiKey, { target: conversation });
  assert.equal(given.status, 200, given.text);
  assert.deepEqual(given.body.entries.map((entry: any) => entry.id), [message.id]);
  assert.equal(await cursor(), Number(message.seq));

  // An app item and a single event: an entry that fails the contract.
  const first = await insertEvent(f, { objectRef: "pr-7", summary: "first", createdAt: new Date(Date.now() - 2000) });
  const second = await insertEvent(f, { objectRef: "pr-7", summary: "second" });
  const statuses = async () => Promise.all([first.id, second.id].map(async (id) => {
    const row = await eventRow(id);
    return `${row.status}/${row.consumedVia ?? "-"}`;
  }));
  const brokenEntry = vi.spyOn(agentInboxItems, "inboxReadAppEntry").mockReturnValue({ seq: "not a number" });
  const failedItem = await read(app.baseUrl, f.apiKey, { target: `app:${f.appKey}/pr-7` });
  assert.equal(failedItem.status, 500, failedItem.text);
  const failedEvent = await read(app.baseUrl, f.apiKey, { target: `agent-event:${first.id}` });
  assert.equal(failedEvent.status, 500, failedEvent.text);
  assert.deepEqual(await statuses(), ["queued/-", "queued/-"], "nothing consumed");
  brokenEntry.mockRestore();
  const item = await read(app.baseUrl, f.apiKey, { target: `app:${f.appKey}/pr-7` });
  assert.equal(item.status, 200, item.text);
  assert.deepEqual([item.body.entries.length, item.body.consumed], [2, true]);
  assert.deepEqual(await statuses(), ["delivered/read", "delivered/read"]);
});

// ---------------------------------------------------------------------------
// inbox dismiss

test("D12: dismiss --target marks an item read without showing it, idempotently; a reminder refuses NEEDS_ACK; every use is traced", async ({ app, onTestFinished }) => {
  const trace = vi.spyOn(tracing, "recordTraceEvent");
  onTestFinished(() => trace.mockRestore());
  const f = await seed("dismiss");
  const msg = await createMessage(f.general.id, "user", f.owner.id, "old news");
  stubChain([chainRow({ targetId: f.general.id, serverId: f.server.id, channelName: f.general.name, latestSeq: msg.seq })]);
  const e1 = await insertEvent(f, { objectRef: "pr-5", summary: "a", createdAt: new Date(Date.now() - 5000) });
  const e2 = await insertEvent(f, { objectRef: "pr-5", summary: "b" });
  const reminder = await seedReminder(f, "Ack me", [1]);

  const first = await dismiss(app.baseUrl, f.apiKey, { target: `app:${f.appKey}/pr-5` });
  assert.equal(first.status, 200, first.text);
  assert.deepEqual([first.body.dismissed, first.body.appItems, first.body.conversations, first.body.skippedNeedsAck], [1, 1, 0, 0]);
  assert.equal(first.body.earliestActivityAt, e1.createdAt.toISOString());
  assert.equal(first.text.includes("\"a\""), false, "no content");
  for (const id of [e1.id, e2.id]) assert.deepEqual([(await eventRow(id)).status, (await eventRow(id)).consumedVia], ["delivered", "dismissed"]);
  const again = await dismiss(app.baseUrl, f.apiKey, { target: `app:${f.appKey}/pr-5` });
  assert.deepEqual([again.status, again.body.dismissed], [200, 0], "idempotent");

  const conversation = await dismiss(app.baseUrl, f.apiKey, { target: `#${f.general.name}` });
  assert.deepEqual([conversation.status, conversation.body.conversations], [200, 1], conversation.text);
  assert.equal(Number(await getAgentLegacyReadCursor(f.agent.id, f.general.id)), msg.seq);

  const needsAck = await dismiss(app.baseUrl, f.apiKey, { target: `reminder:${reminder.id.slice(0, 8)}` }, RUNNER);
  assert.equal(needsAck.status, 409, needsAck.text);
  assert.equal(needsAck.body.code, "NEEDS_ACK");
  // The full id, as every other ack line gives it: a short one can be ambiguous.
  assert.equal(needsAck.body.suggestedNextAction, `raft reminder ack --id ${reminder.id} --revision 1`);

  const traced = trace.mock.calls.filter(([name]) => name === "server.agent_api.inbox_dismiss").map(([, attrs]) => attrs as Record<string, unknown>);
  assert.equal(traced.length, 3);
  assert.deepEqual(
    { mode: traced[0]!.mode, target_kind: traced[0]!.target_kind, dismissed_count: traced[0]!.dismissed_count, agent_id: traced[0]!.agent_id, earliest_activity_at: traced[0]!.earliest_activity_at, client_kind: traced[0]!.client_kind },
    { mode: "target", target_kind: "app", dismissed_count: 1, agent_id: f.agent.id, earliest_activity_at: e1.createdAt.toISOString(), client_kind: "cli" },
  );
});

test("D12 D13: dismiss --before takes items with no activity since then, skips reminders, and refuses INVALID_ARG, INVALID_BEFORE and BEFORE_TOO_RECENT", async ({ app }) => {
  const f = await seed("before");
  stubChain([]);
  const old = await insertEvent(f, { objectRef: "pr-old", createdAt: new Date(Date.now() - 72 * HOUR) });
  const recent = await insertEvent(f, { objectRef: "pr-new" });
  const reminder = await seedReminder(f, "Old reminder", [1]);
  await getDb().update(reminderEvents).set({ occurredAt: new Date(Date.now() - 72 * HOUR) }).where(eq(reminderEvents.reminderId, reminder.id));
  // Fired before launch, never acked: not an item, so not counted as skipped either.
  const prelaunch = await seedReminder(f, "Pre-launch reminder", [1]);
  await getDb().update(reminderEvents).set({ occurredAt: new Date("2025-06-01T00:00:00Z") }).where(eq(reminderEvents.reminderId, prelaunch.id));

  for (const body of [{}, { target: `app:${f.appKey}`, before: "2026-01-01" }]) {
    const res = await dismiss(app.baseUrl, f.apiKey, body);
    assert.equal(res.status, 400, res.text);
    assert.equal(res.body.code, "INVALID_ARG");
  }
  for (const before of ["yesterday", "2026-02-31", "2026-11-01T09:00:00"]) {
    const res = await dismiss(app.baseUrl, f.apiKey, { before });
    assert.equal(res.body.code, "INVALID_BEFORE", `${before}: ${res.text}`);
  }
  for (const before of [new Date(Date.now() - HOUR).toISOString(), new Date(Date.now() + HOUR).toISOString()]) {
    const res = await dismiss(app.baseUrl, f.apiKey, { before });
    assert.equal(res.body.code, "BEFORE_TOO_RECENT", `${before}: ${res.text}`);
    // The next step names the launch-day exception, as the sentence does.
    assert.equal(res.body.suggestedNextAction, AGENT_INBOX_DISMISS_BEFORE_NEXT_ACTION);
    assert.match(res.body.suggestedNextAction, /at least 24 hours ago, or the launch date that raft inbox check's pre-launch line names/);
  }

  const res = await dismiss(app.baseUrl, f.apiKey, { before: new Date(Date.now() - 48 * HOUR).toISOString() }, RUNNER);
  assert.equal(res.status, 200, res.text);
  assert.deepEqual([res.body.dismissed, res.body.appItems, res.body.skippedNeedsAck, res.body.remaining], [1, 1, 1, 0]);
  assert.equal((await eventRow(old.id)).consumedVia, "dismissed");
  assert.equal((await eventRow(recent.id)).status, "queued", "activity since then: kept");
  const acks = await getDb().select().from(reminderSourceAcknowledgements).where(and(eq(reminderSourceAcknowledgements.reminderId, reminder.id)));
  assert.equal(acks.length, 0, "a reminder is never dismissed");
});

test("D12: dismiss --before the launch day itself is taken even within 24 h of it; any other time that recent is not", async ({ app }) => {
  const today = new Date().toISOString().slice(0, 10);
  vi.stubEnv(INBOX_ITEMS_LAUNCH_AT_ENV, `${today}T00:00:00Z`);
  const f = await seed("launch-day");
  stubChain([]);
  for (const before of [today, `${today}T00:00:00Z`, `${today}T00:00:00.000+00:00`]) {
    const res = await dismiss(app.baseUrl, f.apiKey, { before });
    assert.equal(res.status, 200, `${before}: ${res.text}`);
  }
  const notLaunchDay = await dismiss(app.baseUrl, f.apiKey, { before: new Date(Date.now() - 60_000).toISOString() });
  assert.equal(notLaunchDay.body.code, "BEFORE_TOO_RECENT", notLaunchDay.text);
  // A launch day that has not begun is not the exception.
  const tomorrow = new Date(Date.now() + 24 * HOUR).toISOString().slice(0, 10);
  vi.stubEnv(INBOX_ITEMS_LAUNCH_AT_ENV, `${tomorrow}T00:00:00Z`);
  const future = await dismiss(app.baseUrl, f.apiKey, { before: tomorrow });
  assert.equal(future.body.code, "BEFORE_TOO_RECENT", future.text);
});

test("D12: the pre-launch line counts exactly what dismiss --before <launch day> takes, and is gone after it", async ({ app }) => {
  const today = new Date().toISOString().slice(0, 10);
  vi.stubEnv(INBOX_ITEMS_LAUNCH_AT_ENV, `${today}T00:00:00Z`);
  const f = await seed("prelaunch-line");
  const [a, b, c] = await Promise.all([1, 2, 3].map((n) => createChannel(f.server.id, `room-${n}-${randomUUID().slice(0, 6)}`)));
  for (const room of [a!, b!, c!]) await addAgent(room.id, f.agent.id);
  const oldA = await createMessage(a!.id, "user", f.owner.id, "old a");
  const oldB = await createMessage(b!.id, "user", f.owner.id, "old b");
  // Everything so far happened yesterday: before the launch day, seq and time alike.
  await getDb().execute(sql`update messages set created_at = now() - interval '30 hours' where seq <= ${oldB.seq}`);
  const fresh = await createMessage(c!.id, "user", f.owner.id, "new c");
  const readRow = (room: { id: string; name: string }, seq: number) => chainRow({ targetId: room.id, serverId: f.server.id, channelName: room.name, latestSeq: seq });
  stubChain([readRow(a!, oldA.seq), readRow(b!, oldB.seq), readRow(c!, fresh.seq)]);

  const before = await check(app.baseUrl, f.apiKey);
  assert.deepEqual(before.body.preLaunch, { count: 2, before: today });
  assert.deepEqual(before.body.rows.filter((row: any) => row.preLaunch).map((row: any) => row.target).sort(), [`#${a!.name}`, `#${b!.name}`].sort());

  const dismissed = await dismiss(app.baseUrl, f.apiKey, { before: today });
  assert.equal(dismissed.status, 200, dismissed.text);
  assert.deepEqual([dismissed.body.dismissed, dismissed.body.conversations], [2, 2], "exactly the line's count");
  assert.equal(Number(await getAgentLegacyReadCursor(f.agent.id, c!.id)), 0, "the new conversation is kept");

  const after = await check(app.baseUrl, f.apiKey);
  assert.equal(after.body.preLaunch, null, "the line is gone");
  assert.deepEqual(after.body.rows.map((row: any) => row.target), [`#${c!.name}`]);
});

test("D12: dismiss counts against the otherWrites budget and is refused past it", async ({ app }) => {
  const f = await seed("budgeted");
  __setAgentApiWriteBudgetsForTests({ otherWrites: { perAgent: 2, perServer: 100 } });
  for (let i = 0; i < 2; i += 1) assert.equal((await dismiss(app.baseUrl, f.apiKey, { target: `app:${f.appKey}/nothing` })).status, 404);
  const limited = await dismiss(app.baseUrl, f.apiKey, { target: `app:${f.appKey}/nothing` });
  assert.equal(limited.status, 429, limited.text);
  assert.equal(limited.body.details.operation, "inboxDismiss");
  // inbox read is a read: no budget.
  for (let i = 0; i < 3; i += 1) assert.equal((await read(app.baseUrl, f.apiKey, { target: `app:${f.appKey}/nothing` })).status, 404);
});

test("Activity overview: a dismissed event is not counted as delivered; a read one is", async ({ app }) => {
  const f = await seed("activity");
  const dismissed = await insertEvent(f, { objectRef: "pr-d", summary: "dismissed one" });
  const readOne = await insertEvent(f, { objectRef: "pr-r", summary: "read one" });
  const fromMs = Date.now() - HOUR;
  assert.equal((await dismiss(app.baseUrl, f.apiKey, { target: `app:${f.appKey}/pr-d` })).status, 200);
  assert.equal((await read(app.baseUrl, f.apiKey, { target: `app:${f.appKey}/pr-r` })).status, 200);
  const delivered = await listAgentAppEventsDeliveredBetween({ agentId: f.agent.id, fromMs, toMs: Date.now() + HOUR, limit: 50 });
  assert.deepEqual(delivered.map((event) => event.id), [readOne.id]);
  assert.equal(delivered.some((event) => event.id === dismissed.id), false);
});

test("system.assistant events are app items like any app's: one row per object (app:system.assistant/<ref>), read and consumed, dismissed; RaftBench's are not items", async ({ app }) => {
  const f = await seed("assistant-items");
  stubChain([]);
  const now = Date.now();
  const cardA = randomUUID();
  const cardB = randomUUID();
  const a1 = await insertEvent(f, { systemApp: "system.assistant", objectRef: `card/${cardA}`, summary: "Declined: nothing changed.", relatedChannelId: f.general.id, createdAt: new Date(now - 3000) });
  const a2 = await insertEvent(f, { systemApp: "system.assistant", objectRef: `card/${cardA}`, summary: "A second word on card A.", createdAt: new Date(now - 2000) });
  const b1 = await insertEvent(f, { systemApp: "system.assistant", objectRef: `card/${cardB}`, summary: "Done.", createdAt: new Date(now - 1000) });
  await insertEvent(f, { systemApp: "system.raftbench", objectRef: "run-1", summary: "bench run" });

  const listed = await check(app.baseUrl, f.apiKey);
  assert.equal(listed.status, 200, listed.text);
  const rows = listed.body.rows as any[];
  assert.deepEqual(rows.map((row) => row.target), [`app:system.assistant/card/${cardB}`, `app:system.assistant/card/${cardA}`]);
  const rowA = rows[1];
  assert.equal(rowA.kind, "app");
  assert.deepEqual(rowA.app, { key: "system.assistant", name: "system.assistant" });
  assert.equal(rowA.objectRef, `card/${cardA}`);
  assert.equal(rowA.unread, 2);
  assert.deepEqual(rowA.related, { target: `#${f.general.name}` });

  const readA = await read(app.baseUrl, f.apiKey, { target: `app:system.assistant/card/${cardA}` });
  assert.equal(readA.status, 200, readA.text);
  assert.equal(readA.body.kind, "app");
  assert.deepEqual(readA.body.entries.map((entry: any) => entry.content), ["System notification: Declined: nothing changed.", "System notification: A second word on card A."]);
  assert.equal(readA.body.consumed, true);
  for (const id of [a1.id, a2.id]) assert.deepEqual([(await eventRow(id)).status, (await eventRow(id)).consumedVia], ["delivered", "read"]);

  const dismissedB = await dismiss(app.baseUrl, f.apiKey, { target: `app:system.assistant/card/${cardB}` });
  assert.equal(dismissedB.status, 200, dismissedB.text);
  assert.equal(dismissedB.body.appItems, 1);
  assert.equal((await eventRow(b1.id)).consumedVia, "dismissed");
  assert.deepEqual((await check(app.baseUrl, f.apiKey)).body.rows, []);

  for (const answer of [await read(app.baseUrl, f.apiKey, { target: "app:system.raftbench/run-1" }), await dismiss(app.baseUrl, f.apiKey, { target: "app:system.raftbench/run-1" })]) {
    assert.equal(answer.status, 404, answer.text);
    assert.equal(answer.body.code, "NOT_FOUND");
  }
});

// ---------------------------------------------------------------------------
// The push to the daemon: third_party_event.inbox_item_target

/** Each event as the server pushes it to a managed daemon (renderPushedMessages: agent:deliver, wake and resume). */
async function pushed(f: Fixture, events: Array<typeof thirdPartyAgentEvents.$inferSelect>) {
  const messages = events.map((event) => buildThirdPartyAgentMessage({
    event,
    clientKey: event.systemApp ?? f.appKey,
    clientName: event.systemApp ?? "Stamp",
  }));
  const out = await renderPushedMessages(messages, f.agent.id, f.server.id);
  return new Map(out.map((message) => [message.third_party_event!.id, message.third_party_event!.inbox_item_target]));
}

test("inbox_item_target: the push names exactly the app items inbox check lists, by the same rule", async ({ app }) => {
  const f = await seed("push-target");
  stubChain([]);
  const preLaunch = await insertEvent(f, { objectRef: "pr-1", createdAt: new Date("2025-12-31T00:00:00Z") });
  const withRef = await insertEvent(f, { objectRef: "pr-1" });
  const withoutRef = await insertEvent(f, { objectRef: null, summary: "digest" });
  const assistant = await insertEvent(f, { systemApp: "system.assistant", objectRef: `card/${randomUUID()}`, summary: "declined" });
  const bench = await insertEvent(f, { systemApp: "system.raftbench", objectRef: null, summary: "bench run" });

  const targets = await pushed(f, [preLaunch, withRef, withoutRef, assistant, bench]);
  assert.equal(targets.get(withRef.id), `app:${f.appKey}/pr-1`, "with a ref");
  assert.equal(targets.get(withoutRef.id), `app:${f.appKey}`, "without one: the app's fallback item");
  assert.equal(targets.get(preLaunch.id), undefined, "a pre-launch event stays on the old path");
  assert.equal(targets.get(assistant.id), `app:system.assistant/${assistant.objectRef}`, "the assistant's events are items");
  assert.equal(targets.get(bench.id), undefined, "RaftBench's are not");

  // Consistency (Tenny): what carries a target is what inbox check lists as app items, with the same targets.
  const listed = (await check(app.baseUrl, f.apiKey)).body.rows.filter((row: any) => row.kind === "app" || row.kind === "app_fallback");
  const pushedTargets = [...new Set([...targets.values()].filter((target): target is string => Boolean(target)))].sort();
  assert.deepEqual(listed.map((row: any) => row.target).sort(), pushedTargets);
});

test("inbox_item_unread (#wg-ax:#24): the push carries its item's unread count, merged events included", async ({ db: _db }) => {
  const f = await seed("push-unread");
  const first = await insertEvent(f, { objectRef: "pr-1" });
  await insertEvent(f, { objectRef: "pr-1", summary: "joined without a wake" });
  const third = await insertEvent(f, { objectRef: "pr-1", summary: "joined without a wake" });
  const other = await insertEvent(f, { objectRef: "pr-2" });
  const fallback = await insertEvent(f, { objectRef: null, summary: "digest" });
  const consumed = await insertEvent(f, { objectRef: "pr-2" });
  await getDb().update(thirdPartyAgentEvents).set({ status: "delivered", deliveredAt: new Date() }).where(eq(thirdPartyAgentEvents.id, consumed.id));
  const messages = [first, third, other, fallback].map((event) => buildThirdPartyAgentMessage({ event, clientKey: f.appKey, clientName: "Stamp" }));
  const out = await renderPushedMessages(messages, f.agent.id, f.server.id);
  const unread = new Map(out.map((message) => [message.third_party_event!.id, message.third_party_event!.inbox_item_unread]));
  assert.equal(unread.get(first.id), 3, "every unread event of app:<app>/pr-1");
  assert.equal(unread.get(third.id), 3);
  assert.equal(unread.get(other.id), 1, "a read event does not count");
  assert.equal(unread.get(fallback.id), 1, "the fallback item counts its own");
});

test("RAFT_INBOX_ITEMS_APP_EVENTS_FROM before the launch: app events from then on are items (listed, pushed with a target, read, merged); reminder fires still go by the launch", async ({ app }) => {
  // Launch today; app events from 7 days back (an event lives 7 days).
  const launchAt = new Date(Date.now() - 2 * HOUR);
  vi.stubEnv(INBOX_ITEMS_LAUNCH_AT_ENV, launchAt.toISOString());
  vi.stubEnv(INBOX_ITEMS_APP_EVENTS_FROM_ENV, new Date(launchAt.getTime() - 7 * 24 * HOUR).toISOString());
  const f = await seed("app-events-from");
  stubChain([]);
  const early = await insertEvent(f, { objectRef: "pr-early", summary: "from before the launch", createdAt: new Date(launchAt.getTime() - 3 * 24 * HOUR) });
  const tooOld = await insertEvent(f, { objectRef: "pr-ancient", createdAt: new Date(launchAt.getTime() - 8 * 24 * HOUR) });
  const reminder = await seedReminder(f, "Fired before the launch", [1]);
  await getDb().update(reminderEvents).set({ occurredAt: new Date(launchAt.getTime() - 24 * HOUR) }).where(eq(reminderEvents.reminderId, reminder.id));

  const listed = await check(app.baseUrl, f.apiKey, "?items=true", RUNNER);
  assert.equal(listed.status, 200, listed.text);
  assert.deepEqual(listed.body.rows.map((row: any) => row.target), [`app:${f.appKey}/pr-early`], "the early app event is listed; neither the older one nor the pre-launch reminder fire");
  const targets = await pushed(f, [early, tooOld]);
  assert.equal(targets.get(early.id), `app:${f.appKey}/pr-early`);
  assert.equal(targets.get(tooOld.id), undefined);

  // A new event on it while unread merges, as on any item.
  const later = await insertEvent(f, { objectRef: "pr-early", summary: "after the launch" });
  const { coalesceWakeIntoUnreadItem } = await import("../services/appItemWakeCoalescing");
  assert.equal(await coalesceWakeIntoUnreadItem(later, f.appKey), true);

  const read1 = await read(app.baseUrl, f.apiKey, { target: `app:${f.appKey}/pr-early` });
  assert.equal(read1.status, 200, read1.text);
  assert.equal(read1.body.entries.length, 2);
  assert.match(read1.body.entries[0].content, /from before the launch$/);
  assert.match(read1.body.entries[1].content, /after the launch$/);
  assert.equal(read1.body.consumed, true);
  assert.equal((await eventRow(early.id)).consumedVia, "read");
});

test("RAFT_INBOX_ITEMS_APP_EVENTS_FROM unset, unparseable or after the launch: app events are items from the launch, said once per value", async ({ app, onTestFinished }) => {
  const warn = vi.spyOn(console, "warn");
  onTestFinished(() => warn.mockRestore());
  const f = await seed("app-events-from-ignored");
  stubChain([]);
  await insertEvent(f, { objectRef: "pr-old", createdAt: new Date("2025-12-31T00:00:00Z") });
  for (const value of ["", "next tuesday", "2026-06-01T00:00:00Z"]) {
    vi.stubEnv(INBOX_ITEMS_APP_EVENTS_FROM_ENV, value);
    const listed = await check(app.baseUrl, f.apiKey);
    assert.equal(listed.status, 200, listed.text);
    assert.deepEqual(listed.body.rows, [], JSON.stringify(value));
    await check(app.baseUrl, f.apiKey);
  }
  const said = warn.mock.calls.filter(([line]) => typeof line === "string" && line.includes(INBOX_ITEMS_APP_EVENTS_FROM_ENV));
  assert.equal(said.length, 2, "once for each value that is not used");
});

test("inbox_item_target: absent when the flag is off, and when RAFT_INBOX_ITEMS_LAUNCH_AT is unset", async ({ db: _db }) => {
  const off = await seed("push-flag-off", { flag: false });
  const event = await insertEvent(off, { objectRef: "pr-1" });
  assert.equal((await pushed(off, [event])).get(event.id), undefined, "flag off");

  const on = await seed("push-no-launch");
  const another = await insertEvent(on, { objectRef: "pr-1" });
  assert.equal((await pushed(on, [another])).get(another.id), `app:${on.appKey}/pr-1`, "control: both set");
  vi.stubEnv(INBOX_ITEMS_LAUNCH_AT_ENV, "");
  assert.equal((await pushed(on, [another])).get(another.id), undefined, "no launch time");
});
