// Reaction notices (#wg-ax:#26), over HTTP with real credentials and a real
// database: a person reacts through the web API, an agent through the agent
// API, and the author agent's notices are read back from the agent event
// queue and the inbox listing. Who is told, the one item per message and its
// one wake, a removal taking its notice back, re-adding, the two switches,
// and the delivery guard.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, vi } from "vitest";
import {
  AGENT_REACTION_NOTICES_FEATURE_FLAG_KEY,
  REACTION_NOTICE_READD_WINDOW_MS,
  REACTION_NOTICE_TTL_MS,
  reactionAgentNoticeSchema,
  reactionNoticeInboxTarget,
  reactionNoticeObjectRef,
  type AgentMessage,
  type ReactionAgentAppEvent,
} from "@botiverse/raft-shared";
import { getDb } from "../../db/index";
import { messageReactions, messages, thirdPartyAgentEvents } from "../../db/schema";
import { INBOX_ITEMS_LAUNCH_AT_ENV, listAgentAppItems, readAgentAppItemPage } from "../../services/agentInboxItems";
import { mintAgentCredential } from "../../services/agentCredentialService";
import { createAgent } from "../../services/agentService";
import { addAgent, getOrCreateThreadForChannel, removeAgent } from "../../services/channelService";
import { AGENT_INBOX_ITEMS_FEATURE_FLAG_KEY, createFeatureFlag } from "../../services/featureFlagService";
import { __resetInboxItemsLaunchWarningsForTests, inboxItemsLaunch } from "../../services/inboxItemsLaunch";
import { createMessage } from "../../services/messageService";
import { consumeThirdPartyAgentEvents } from "../../services/oauthService";
import type { AppMessageReactionRequest } from "../../platform/apps";
import { appNoticeOutbox } from "../../services/firstPartyAppHost";
import { createApiTest } from "../../test/integration/apiTest";
import { tokenForHuman } from "../../test/integration/credentials";
import { seedJointChannel } from "../../test/integration/jointFixture";
import type { createSeed } from "../../test/integration/seed";
import { prepareReactionNotice } from "./notices";
import { reactionNoticesApp } from "./register";

const test = createApiTest();
const SYSTEM_APP = "system.reaction-notices";
const TEXT = "Deploy plan for v1.21.63 is ready for review: the migration runs first, then the workers restart one at a time.";

beforeEach(() => {
  __resetInboxItemsLaunchWarningsForTests();
  vi.stubEnv(INBOX_ITEMS_LAUNCH_AT_ENV, "2026-01-01T00:00:00.000Z");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

type Delivered = { agentId: string; message: AgentMessage };
type TestApp = { baseUrl: string; app: { get(key: string): unknown } };

/**
 * A server with a person (tygg) and two agents (the author and another) in
 * one channel, and a message the author sent. `notices` / `items`: the two
 * flags (both on unless false). Pushes through the test app's orchestrator
 * land in `delivered`.
 */
async function seedWorld(seed: ReturnType<typeof createSeed>, app: TestApp, opts: { notices?: boolean; items?: boolean; visibility?: "channel" | "private" } = {}) {
  const suffix = randomUUID().slice(0, 8);
  const owner = await seed.human({ name: `tygg-${suffix}`, displayName: "Tygg Display" });
  const server = await seed.server({ owner });
  const channel = await seed.channel({ server, members: [owner], name: `proj-${suffix}`, visibility: opts.visibility });
  const author = await createAgent(server.id, `Author${suffix}`, { runtime: "claude", model: "sonnet" });
  const other = await createAgent(server.id, `Other${suffix}`, { runtime: "claude", model: "sonnet" });
  await addAgent(channel.id, author.id);
  await addAgent(channel.id, other.id);
  if (opts.items !== false) await createFeatureFlag({ key: AGENT_INBOX_ITEMS_FEATURE_FLAG_KEY, randomizationUnit: "server", defaultEnabled: true });
  if (opts.notices !== false) await createFeatureFlag({ key: AGENT_REACTION_NOTICES_FEATURE_FLAG_KEY, randomizationUnit: "server", defaultEnabled: true });
  const key = async (agentId: string) => (await mintAgentCredential({ agentId, scopes: ["read", "send", "reactions"], name: `rn-${suffix}`, issuedVia: "computer", createdByUserId: null })).apiKey;
  const message = await createMessage(channel.id, "agent", author.id, TEXT);
  const delivered: Delivered[] = [];
  const orchestrator = app.app.get("agentOrchestrator") as { deliverMessage: (agentId: string, message: AgentMessage) => Promise<unknown> };
  orchestrator.deliverMessage = async (agentId, delivery) => {
    delivered.push({ agentId, message: delivery });
    return { status: "delivered" };
  };
  const token = await tokenForHuman(owner.email);
  /** tygg reacts (or takes the reaction off) through the web API. */
  const person = async (method: "POST" | "DELETE", messageId: string, emoji: string) => {
    const res = await fetch(`${app.baseUrl}/api/messages/${messageId}/reactions`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "X-Server-Id": server.id, "Content-Type": "application/json" },
      body: JSON.stringify({ emoji }),
    });
    assert.equal(res.status, 200, await res.clone().text());
  };
  /** An agent reacts (or takes the reaction off) through the agent API. */
  const agent = async (apiKey: string, method: "POST" | "DELETE", messageId: string, emoji: string) => {
    const res = await fetch(`${app.baseUrl}/internal/agent-api/messages/${messageId}/reactions`, {
      method,
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ emoji }),
    });
    assert.equal(res.status, 200, await res.clone().text());
  };
  return { owner, server, channel, author, other, message, delivered, orchestrator, person, agent, keys: { author: await key(author.id), other: await key(other.id) } };
}
type World = Awaited<ReturnType<typeof seedWorld>>;

/** The author's reaction notices, oldest first. */
async function notices(w: World, agentId = w.author.id) {
  return getDb().select().from(thirdPartyAgentEvents)
    .where(and(eq(thirdPartyAgentEvents.agentId, agentId), eq(thirdPartyAgentEvents.systemApp, SYSTEM_APP)))
    .orderBy(asc(thirdPartyAgentEvents.createdAt), asc(thirdPartyAgentEvents.id));
}

/** The author's inbox rows of the app, as `raft inbox check` lists them. */
async function rows(w: World) {
  const listing = await listAgentAppItems({ serverId: w.server.id, agentId: w.author.id, launch: inboxItemsLaunch()! });
  return listing.rows.filter((row) => row.app?.key === SYSTEM_APP);
}

const appEventOf = (message: AgentMessage) => message.app_event as ReactionAgentAppEvent | undefined;

test("a person's reaction to an agent's message: one notice for the author, about the message and its conversation, pushed once", async ({ app, seed }) => {
  const w = await seedWorld(seed, app);
  await w.person("POST", w.message.id, "✅");

  const [event, ...rest] = await notices(w);
  assert.equal(rest.length, 0);
  assert.equal(event!.objectRef, `msg/${w.message.id}`);
  assert.equal(event!.objectRef, reactionNoticeObjectRef(w.message.id));
  assert.equal(event!.relatedChannelId, w.channel.id);
  assert.equal(event!.serverId, w.server.id);
  assert.equal(event!.kind, "notification");
  // One line; the reactor by handle, without @.
  assert.equal(event!.summary, `${w.owner.name} reacted ✅ to your message in #${w.channel.name}: "Deploy plan for v1.21.63 is ready for…"`);
  assert.equal(event!.expiresAt.getTime() - event!.createdAt.getTime(), REACTION_NOTICE_TTL_MS, "7 days, as other app events");
  assert.equal(event!.status, "delivering", "pushed: it woke the author");

  const { app: appId, kind, ...notice } = event!.payload.app_event as Record<string, unknown>;
  assert.deepEqual([appId, kind], ["reaction-notices", "message"]);
  assert.deepEqual(reactionAgentNoticeSchema.parse(notice), {
    message: {
      id: w.message.id,
      channelId: w.channel.id,
      conversation: `#${w.channel.name}`,
      replyTarget: `#${w.channel.name}:${w.message.id.slice(0, 8)}`,
      excerpt: TEXT,
      excerptTruncated: false,
    },
    reactor: { id: w.owner.id, kind: "human", name: w.owner.name },
    emoji: "✅",
    reactedAt: event!.createdAt.toISOString(),
  });

  // The push carries the notice as app_event, for a client that writes it itself.
  assert.deepEqual(w.delivered.map((delivery) => delivery.agentId), [w.author.id]);
  assert.equal(w.delivered[0]!.message.third_party_event?.client_id, SYSTEM_APP);
  assert.equal(appEventOf(w.delivered[0]!.message)?.reactor.name, w.owner.name);
  assert.equal(appEventOf(w.delivered[0]!.message)?.message.id, w.message.id);

  // One inbox row per reacted message, naming where the message is.
  const [row, ...others] = await rows(w);
  assert.equal(others.length, 0);
  assert.equal(row!.target, `app:system.reaction-notices/msg/${w.message.id}`);
  assert.equal(row!.target, reactionNoticeInboxTarget(w.message.id));
  assert.equal(row!.kind, "app");
  assert.equal(row!.unread, 1);
  assert.deepEqual(row!.related, { target: `#${w.channel.name}` });
});

test("who is told: not the author for its own reaction, nobody for a person's message, another agent's reaction like a person's", async ({ app, seed }) => {
  const w = await seedWorld(seed, app);
  // The author reacts to its own message.
  await w.agent(w.keys.author, "POST", w.message.id, "👍");
  assert.deepEqual(await notices(w), []);

  // A person's message: no agent is told, whoever reacts.
  const human = await createMessage(w.channel.id, "user", w.owner.id, "lunch?");
  await w.agent(w.keys.author, "POST", human.id, "👍");
  await w.agent(w.keys.other, "POST", human.id, "👍");
  assert.deepEqual(await notices(w), []);
  assert.deepEqual(await notices(w, w.other.id), []);
  // An assistant sending as its owner: the sender is the owner, a person.
  const delegated = await createMessage(w.channel.id, "user", w.owner.id, "sent for me");
  await getDb().update(messages).set({ delegatedByAgentId: w.author.id }).where(eq(messages.id, delegated.id));
  await w.agent(w.keys.other, "POST", delegated.id, "👍");
  assert.deepEqual(await notices(w), []);
  assert.equal(w.delivered.length, 0);

  // Another agent's reaction wakes the author as a person's does.
  await w.agent(w.keys.other, "POST", w.message.id, "👀");
  const [event] = await notices(w);
  assert.equal(event!.summary, `${w.other.name} reacted 👀 to your message in #${w.channel.name}: "Deploy plan for v1.21.63 is ready for…"`);
  assert.deepEqual((event!.payload.app_event as ReactionAgentAppEvent).reactor, { id: w.other.id, kind: "agent", name: w.other.name });
  assert.deepEqual(w.delivered.map((delivery) => delivery.agentId), [w.author.id]);
});

test("a second reaction while the row is unread joins it without a second wake; a reaction to another message is another row", async ({ app, seed }) => {
  const w = await seedWorld(seed, app);
  await w.person("POST", w.message.id, "✅");
  await w.agent(w.keys.other, "POST", w.message.id, "👍");
  await w.person("POST", w.message.id, "👍");

  const [first, second, third] = await notices(w);
  assert.equal(first!.status, "delivering");
  assert.equal(first!.wakeCoalescedAt, null);
  for (const merged of [second!, third!]) {
    assert.equal(merged.status, "queued", "not pushed, and not consumed either");
    assert.ok(merged.wakeCoalescedAt instanceof Date);
    assert.equal(merged.objectRef, first!.objectRef);
  }
  assert.equal(w.delivered.length, 1, "one wake for the message, however many reactions");

  const [row, ...others] = await rows(w);
  assert.equal(others.length, 0);
  assert.equal(row!.unread, 3);
  assert.equal(row!.preview, `${w.owner.name} reacted 👍 to your message in #${w.channel.name}: "Deploy plan for v1.21.63 is ready for…"`);

  // Another message of the author's: its own row, its own wake.
  const next = await createMessage(w.channel.id, "agent", w.author.id, "second message");
  await w.person("POST", next.id, "✅");
  assert.equal(w.delivered.length, 2);
  assert.deepEqual((await rows(w)).map((entry) => entry.target).sort(), [reactionNoticeInboxTarget(w.message.id), reactionNoticeInboxTarget(next.id)].sort());
});

test("a reaction removed before the author reads: its notice is taken back and the row goes with its last one", async ({ app, seed }) => {
  const w = await seedWorld(seed, app);
  await w.person("POST", w.message.id, "✅");
  await w.agent(w.keys.other, "POST", w.message.id, "👍");
  assert.equal((await rows(w))[0]!.unread, 2);

  // One of two removed: the row stays with the other.
  await w.person("DELETE", w.message.id, "✅");
  const [row] = await rows(w);
  assert.equal(row!.unread, 1);
  assert.equal(row!.preview, `${w.other.name} reacted 👍 to your message in #${w.channel.name}: "Deploy plan for v1.21.63 is ready for…"`);
  assert.deepEqual((await notices(w)).map((event) => event.status), ["expired", "queued"]);

  // The last one removed: no row, and reading the target finds nothing to read.
  await w.agent(w.keys.other, "DELETE", w.message.id, "👍");
  assert.deepEqual(await rows(w), []);
  assert.deepEqual((await notices(w)).map((event) => event.status), ["expired", "expired"]);
  const page = await readAgentAppItemPage({ agentId: w.author.id, appKey: SYSTEM_APP, objectRef: reactionNoticeObjectRef(w.message.id), launch: inboxItemsLaunch()!, limit: 20 });
  assert.equal(page.kind, "expired");
  assert.equal(w.delivered.length, 1, "a removal wakes nobody");

  // Removing again, or removing what was never there, changes nothing.
  await w.person("DELETE", w.message.id, "✅");
  assert.deepEqual((await notices(w)).map((event) => event.status), ["expired", "expired"]);

  // With the row gone, the next reaction is a new row and wakes again.
  await w.person("POST", w.message.id, "🎉");
  assert.equal(w.delivered.length, 2);
  assert.equal((await rows(w))[0]!.unread, 1);
});

test("a removal leaves a notice the author already read alone", async ({ app, seed }) => {
  const w = await seedWorld(seed, app);
  await w.person("POST", w.message.id, "✅");
  const [event] = await notices(w);
  await consumeThirdPartyAgentEvents([event!.id], { agentId: w.author.id, via: "read" });
  await w.person("DELETE", w.message.id, "✅");
  const [after] = await notices(w);
  assert.equal(after!.status, "delivered");
  assert.equal(after!.consumedVia, "read");
});

test("the same reaction added again within 10 minutes adds no notice; one taken back is unread again without a second wake", async ({ app, seed }) => {
  const w = await seedWorld(seed, app);
  await w.person("POST", w.message.id, "✅");
  await w.person("DELETE", w.message.id, "✅");
  assert.deepEqual(await rows(w), []);
  await w.person("POST", w.message.id, "✅");

  const again = await notices(w);
  assert.equal(again.length, 1, "no second notice");
  assert.equal(again[0]!.status, "queued", "unread again: the reaction is on the message");
  assert.ok(again[0]!.wakeCoalescedAt instanceof Date, "its wake was spent by the first push");
  assert.equal(w.delivered.length, 1, "toggling wakes the author once");
  assert.equal((await rows(w))[0]!.unread, 1);

  // Toggling a notice the author read adds nothing either.
  await consumeThirdPartyAgentEvents([again[0]!.id], { agentId: w.author.id, via: "read" });
  await w.person("DELETE", w.message.id, "✅");
  await w.person("POST", w.message.id, "✅");
  const read = await notices(w);
  assert.deepEqual(read.map((event) => event.status), ["delivered"]);
  assert.deepEqual(await rows(w), []);
  assert.equal(w.delivered.length, 1);

  // Another emoji, or another reactor, is another reaction.
  await w.person("POST", w.message.id, "👍");
  await w.agent(w.keys.other, "POST", w.message.id, "✅");
  assert.equal((await notices(w)).length, 3);

  // After the window, adding it again is told again.
  const old = new Date(Date.now() - REACTION_NOTICE_READD_WINDOW_MS - 60_000);
  await getDb().update(thirdPartyAgentEvents).set({ createdAt: old }).where(eq(thirdPartyAgentEvents.id, read[0]!.id));
  await w.person("DELETE", w.message.id, "✅");
  await w.person("POST", w.message.id, "✅");
  const later = await notices(w);
  assert.equal(later.length, 4);
  assert.equal(later.filter((event) => (event.payload.app_event as ReactionAgentAppEvent).emoji === "✅" && (event.payload.app_event as ReactionAgentAppEvent).reactor.id === w.owner.id).length, 2);
});

test("a notice taken back before it was pushed hands the row's wake to the next unread one", async ({ app, seed }) => {
  const w = await seedWorld(seed, app);
  // The first push fails: the notice stays queued, never pushed.
  let fail = true;
  const deliver = w.orchestrator.deliverMessage;
  w.orchestrator.deliverMessage = async (agentId, message) => {
    if (fail) throw new Error("computer offline");
    return deliver(agentId, message);
  };
  await w.person("POST", w.message.id, "✅");
  await w.agent(w.keys.other, "POST", w.message.id, "👍");
  const [first, merged] = await notices(w);
  assert.equal(first!.status, "queued");
  assert.equal(first!.wakeCoalescedAt, null);
  assert.ok(merged!.wakeCoalescedAt instanceof Date);
  assert.equal(w.delivered.length, 0);

  fail = false;
  await w.person("DELETE", w.message.id, "✅");
  const [taken, woken] = await notices(w);
  assert.equal(taken!.status, "expired");
  assert.equal(woken!.status, "delivering", "the row's remaining notice wakes the author");
  assert.equal(woken!.wakeCoalescedAt, null);
  assert.deepEqual(w.delivered.map((delivery) => appEventOf(delivery.message)?.emoji), ["👍"]);
});

test("off: without agent_reaction_notices_v0, or without inbox items, a reaction queues nothing", async ({ app, seed }) => {
  const noFlag = await seedWorld(seed, app, { notices: false });
  await noFlag.person("POST", noFlag.message.id, "✅");
  await noFlag.agent(noFlag.keys.other, "POST", noFlag.message.id, "👍");
  await noFlag.person("DELETE", noFlag.message.id, "✅");
  assert.deepEqual(await notices(noFlag), []);
  assert.equal(noFlag.delivered.length, 0);
  // The reaction itself is unaffected.
  assert.equal((await getDb().select().from(messageReactions).where(eq(messageReactions.messageId, noFlag.message.id))).length, 1);
});

test("off: the reaction flag alone does nothing where inbox items are off (no flag, or no launch time)", async ({ app, seed }) => {
  const noItems = await seedWorld(seed, app, { items: false });
  await noItems.person("POST", noItems.message.id, "✅");
  assert.deepEqual(await notices(noItems), []);
  assert.equal(noItems.delivered.length, 0);
});

test("off: both flags on but no launch time is inbox items off, so nothing is queued", async ({ app, seed }) => {
  vi.stubEnv(INBOX_ITEMS_LAUNCH_AT_ENV, "");
  const w = await seedWorld(seed, app);
  await w.person("POST", w.message.id, "✅");
  assert.deepEqual(await notices(w), []);
});

test("a thread reply: the notice is about the thread, and a reply about it goes there", async ({ app, seed }) => {
  const w = await seedWorld(seed, app);
  const thread = await getOrCreateThreadForChannel(w.channel.id, w.message.id, w.owner.id, "user");
  const reply = await createMessage(thread.canonicalThreadChannelId, "agent", w.author.id, "On it");
  await w.person("POST", reply.id, "👍");
  const [event] = await notices(w);
  const threadTarget = `#${w.channel.name}:${w.message.id.slice(0, 8)}`;
  assert.equal(event!.relatedChannelId, thread.id);
  assert.equal(event!.summary, `${w.owner.name} reacted 👍 to your message in ${threadTarget}: "On it"`);
  const notice = event!.payload.app_event as ReactionAgentAppEvent;
  assert.deepEqual([notice.message.channelId, notice.message.conversation, notice.message.replyTarget], [thread.id, threadTarget, threadTarget]);
  assert.deepEqual((await rows(w))[0]!.related, { target: threadTarget });
});

test("a Joint Channel: the author is told through its own server's copy, whichever server the reactor is on", async ({ app, seed }) => {
  // The author's server hosts; the other agent is on the server that joined.
  const w = await seedWorld(seed, app);
  const guestOwner = await seed.human();
  const guestServer = await seed.server({ owner: guestOwner });
  const guestAgent = await createAgent(guestServer.id, `Guest${randomUUID().slice(0, 8)}`, { runtime: "claude", model: "sonnet" });
  const joint = await seedJointChannel({ name: `joint-${randomUUID().slice(0, 8)}`, serverIds: [w.server.id, guestServer.id], createdByUserId: w.owner.id });
  const [hostCopy, guestCopy] = joint.projections as [typeof joint.projections[number], typeof joint.projections[number]];
  await addAgent(hostCopy.id, w.author.id);
  await addAgent(guestCopy.id, guestAgent.id);
  const guestKey = (await mintAgentCredential({ agentId: guestAgent.id, scopes: ["read", "send", "reactions"], name: "rn-guest", issuedVia: "computer", createdByUserId: null })).apiKey;
  // Stored once, in the joint's own storage, outside both servers.
  const message = await createMessage(joint.canonical.id, "agent", w.author.id, TEXT);

  await w.agent(guestKey, "POST", message.id, "🚀");
  const [event] = await notices(w);
  assert.equal(event!.serverId, w.server.id);
  assert.equal(event!.relatedChannelId, hostCopy.id, "the author's own server's copy, never the storage channel");
  assert.equal(event!.summary, `${guestAgent.name} reacted 🚀 to your message in #${hostCopy.name}: "Deploy plan for v1.21.63 is ready for…"`);
  const notice = event!.payload.app_event as ReactionAgentAppEvent;
  assert.deepEqual([notice.message.channelId, notice.message.conversation, notice.message.replyTarget], [hostCopy.id, `#${hostCopy.name}`, `#${hostCopy.name}:${message.id.slice(0, 8)}`]);
  assert.deepEqual((await rows(w)).map((row) => [row.target, row.related]), [[reactionNoticeInboxTarget(message.id), { target: `#${hostCopy.name}` }]]);
  assert.equal(w.delivered.length, 1);

  // Removed from the other server: taken back all the same.
  await w.agent(guestKey, "DELETE", message.id, "🚀");
  assert.deepEqual(await rows(w), []);
});

const prepareOutbox = () => ({ noticeOutbox: appNoticeOutbox(reactionNoticesApp, undefined) });
/** A person's ✅ on the author's message, as core asks the app about it before the reaction's transaction. */
const asked = (w: World, over: Partial<AppMessageReactionRequest> = {}, author: AppMessageReactionRequest["message"]["author"] = { type: "agent", id: w.author.id }): AppMessageReactionRequest => ({
  operation: "add",
  message: { id: w.message.id, channelId: w.channel.id, author, content: TEXT },
  reactor: { type: "user", id: w.owner.id },
  emoji: "✅",
  ...over,
});

test("prepare, asked before every reaction's transaction: a write for someone else's reaction to an agent's message, nothing for a person's message or the author's own", async ({ app, seed }) => {
  const w = await seedWorld(seed, app);
  assert.equal(typeof await prepareReactionNotice(asked(w), prepareOutbox()), "function");
  assert.equal(typeof await prepareReactionNotice(asked(w, { operation: "remove" }), prepareOutbox()), "function");
  // Nothing to write, so nothing of the app runs in the reaction's transaction.
  assert.equal(await prepareReactionNotice(asked(w, {}, { type: "user", id: w.owner.id }), prepareOutbox()), undefined, "a person's message");
  assert.equal(await prepareReactionNotice(asked(w, {}, null), prepareOutbox()), undefined, "a system or mirrored message");
  assert.equal(await prepareReactionNotice(asked(w, { reactor: { type: "agent", id: w.author.id } }), prepareOutbox()), undefined, "the author's own reaction");
});

test("prepare with agent_reaction_notices_v0 off: nothing to write, for an add or a removal", async ({ app, seed }) => {
  const w = await seedWorld(seed, app, { notices: false });
  assert.equal(await prepareReactionNotice(asked(w), prepareOutbox()), undefined);
  assert.equal(await prepareReactionNotice(asked(w, { operation: "remove" }), prepareOutbox()), undefined);
});

test("prepare with inbox items off: nothing to write", async ({ app, seed }) => {
  const w = await seedWorld(seed, app, { items: false });
  assert.equal(await prepareReactionNotice(asked(w), prepareOutbox()), undefined);
});

test("delivery guard: an author that can no longer open the conversation is not shown the notice, and is told of no new reaction", async ({ app, seed }) => {
  const w = await seedWorld(seed, app, { visibility: "private" });
  await w.person("POST", w.message.id, "✅");
  assert.equal((await rows(w)).length, 1);

  await removeAgent(w.channel.id, w.author.id);
  assert.deepEqual(await rows(w), [], "listed only while the author can open the conversation");
  await w.agent(w.keys.other, "POST", w.message.id, "👍");
  assert.equal((await notices(w)).length, 1, "nothing queued for a conversation the author left");
  assert.equal(w.delivered.length, 1);
});
