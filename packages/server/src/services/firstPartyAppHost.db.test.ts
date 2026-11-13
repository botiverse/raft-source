// An app's notice outbox (services/firstPartyAppHost.ts): the payload's `app`
// and `kind` are core's, from the registration and the checked object kind.
// An event naming either itself is refused rather than let through to stand
// in for them.
//
// And what an app that takes notices back uses (platform/apps
// AppNoticeOutbox): a notice's `key`, `onceWithinMs` (no second notice in the
// window, one taken back unread again) and `withdrawUnread` (unread notices
// leave the item, read ones stay, scoped to the agent, the object and the
// key). What reaction notices do with them is
// apps/reaction-notices/notices.api.test.ts.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { asServerId } from "@botiverse/raft-shared";
import type { Database } from "../db/index";
import { agents, thirdPartyAgentEvents } from "../db/schema";
import type { FirstPartyApp } from "../platform/apps";
import { dbTest as test } from "../test/integration/dbTest";
import type { createSeed } from "../test/integration/seed";
import { appNoticeOutbox } from "./firstPartyAppHost";
import { consumeThirdPartyAgentEvents } from "./oauthService";

const docsApp: FirstPartyApp = {
  id: "docs",
  flag: "docs_v0",
  objectKinds: [{ kind: "doc", events: ["edited"], objectTables: [], homes: async () => new Map(), parseRef: (ref) => ref, summarize: async () => [] }],
  systemApp: "system.docs",
  agentNotice: { schema: { safeParse: (value: unknown) => ({ success: true, data: value }) } as never, deliverable: async (events) => new Map(events.map((event) => [event.id, true])) },
};

test("a notice's app and kind are core's: an event naming either is refused; the payload puts them last", async ({ db, seed }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const [agent] = await db.insert(agents).values({ serverId: server.id, name: `a-${randomUUID().slice(0, 8)}` }).returning();
  const outbox = appNoticeOutbox(docsApp, undefined);
  const queue = (event: Record<string, unknown>) => outbox.queue(db, { serverId: asServerId(server.id), agentId: agent!.id, summary: "Edited", kind: "doc", event, ttlMs: 60_000, now: new Date() });

  const { eventId } = await queue({ doc: { id: "d_1" }, reason: "edited" });
  const [row] = await db.select().from(thirdPartyAgentEvents).where(eq(thirdPartyAgentEvents.id, eventId));
  assert.deepEqual((row!.payload as { app_event: unknown }).app_event, { doc: { id: "d_1" }, reason: "edited", app: "docs", kind: "doc" });

  for (const event of [{ app: "artifacts", reason: "x" }, { kind: "artifact", reason: "x" }, { app: "docs", kind: "doc" }]) {
    await assert.rejects(queue(event), /docs's notice event may not set (app|kind)/, JSON.stringify(event));
  }
  // An inherited key is not the event's own: nothing to refuse, and core's values still win.
  const inherited = Object.create({ app: "artifacts" }) as Record<string, unknown>;
  inherited.reason = "y";
  const ok = await queue(inherited);
  const [kept] = await db.select().from(thirdPartyAgentEvents).where(eq(thirdPartyAgentEvents.id, ok.eventId));
  assert.deepEqual((kept!.payload as { app_event: unknown }).app_event, { reason: "y", app: "docs", kind: "doc" });
  assert.equal((await db.select().from(thirdPartyAgentEvents).where(eq(thirdPartyAgentEvents.agentId, agent!.id))).length, 2, "the refused ones wrote nothing");
});

/** An app with notices about a kind it only names; not in the registry, so no delivery guard runs. */
const pagesApp: FirstPartyApp = {
  id: "docs",
  flag: "docs_v0",
  objectKinds: [],
  systemApp: "system.docs",
  agentNotice: { schema: { safeParse: () => ({ success: false }) }, deliverable: async () => new Map(), kinds: ["page"] },
};

async function seedAgents(db: Database, seed: ReturnType<typeof createSeed>) {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const make = async () => (await db.insert(agents).values({ serverId: server.id, name: `a-${randomUUID().slice(0, 8)}` }).returning())[0]!;
  return { serverId: asServerId(server.id), agent: await make(), other: await make() };
}

const HOUR = 60 * 60 * 1000;

test("queue: the kind is one of the app's object kinds or notice kinds; a key and onceWithinMs are checked", async ({ db, seed }) => {
  const { serverId, agent } = await seedAgents(db, seed);
  const outbox = appNoticeOutbox(pagesApp, undefined);
  const base = { serverId, agentId: agent.id, summary: "s", event: {}, ttlMs: HOUR, now: new Date(), objectRef: "page/1" };
  await assert.rejects(outbox.queue(db, { ...base, kind: "artifact" }), /artifact is not an object kind or a notice kind of docs/);
  await assert.rejects(outbox.queue(db, { ...base, kind: "page", key: "" }), /notice key must be 1-200 characters/);
  await assert.rejects(outbox.queue(db, { ...base, kind: "page", key: "k".repeat(201) }), /notice key must be 1-200 characters/);
  await assert.rejects(outbox.queue(db, { ...base, kind: "page", onceWithinMs: 1000 }), /onceWithinMs needs the notice's key and objectRef/);
  const queued = await outbox.queue(db, { ...base, kind: "page", key: "edit:1" });
  assert.equal(queued.created, true);
  const [row] = await db.select().from(thirdPartyAgentEvents).where(eq(thirdPartyAgentEvents.id, queued.eventId));
  assert.deepEqual([row!.systemApp, row!.objectRef, row!.externalEventId, row!.status], ["system.docs", "page/1", "edit:1", "queued"]);
  assert.deepEqual(row!.payload, { app_event: { app: "docs", kind: "page" } });
});

test("withdrawUnread: the agent's unread notices about the object, all or by key; read ones, other objects and other agents stay", async ({ db, seed }) => {
  const { serverId, agent, other } = await seedAgents(db, seed);
  const outbox = appNoticeOutbox(pagesApp, undefined);
  const now = new Date();
  const queue = async (agentId: string, objectRef: string, key: string) =>
    (await outbox.queue(db, { serverId, agentId, summary: key, kind: "page", event: {}, ttlMs: HOUR, now, objectRef, key })).eventId;
  const [a1, a2, read, elsewhere, theirs] = [
    await queue(agent.id, "page/1", "a"),
    await queue(agent.id, "page/1", "b"),
    await queue(agent.id, "page/1", "a"),
    await queue(agent.id, "page/2", "a"),
    await queue(other.id, "page/1", "a"),
  ];
  await consumeThirdPartyAgentEvents([read], { agentId: agent.id, via: "read" });
  const status = async (id: string) => (await db.select({ status: thirdPartyAgentEvents.status }).from(thirdPartyAgentEvents).where(eq(thirdPartyAgentEvents.id, id)))[0]!.status;

  // By key: only that notice of this agent and object.
  assert.deepEqual(await db.transaction((tx) => outbox.withdrawUnread(tx, { agentId: agent.id, objectRef: "page/1", key: "a", now })), { withdrawn: 1, pushEventId: null });
  assert.deepEqual([await status(a1), await status(a2), await status(read), await status(elsewhere), await status(theirs)], ["expired", "queued", "delivered", "queued", "queued"]);
  // Again: nothing left to take back.
  assert.deepEqual(await outbox.withdrawUnread(db, { agentId: agent.id, objectRef: "page/1", key: "a", now }), { withdrawn: 0, pushEventId: null });
  // Without a key: every unread notice of the item.
  assert.deepEqual(await outbox.withdrawUnread(db, { agentId: agent.id, objectRef: "page/1", now }), { withdrawn: 1, pushEventId: null });
  assert.deepEqual([await status(a2), await status(read), await status(elsewhere), await status(theirs)], ["expired", "delivered", "queued", "queued"]);
  // Rolled back with the caller's transaction.
  await assert.rejects(db.transaction(async (tx) => {
    await outbox.withdrawUnread(tx, { agentId: agent.id, objectRef: "page/2", now });
    throw new Error("rollback");
  }), /rollback/);
  assert.equal(await status(elsewhere), "queued");
});

test("onceWithinMs: no second notice for the key in the window; one taken back is unread again; after the window a new one", async ({ db, seed }) => {
  const { serverId, agent } = await seedAgents(db, seed);
  const outbox = appNoticeOutbox(pagesApp, undefined);
  const start = new Date();
  const queue = (now: Date, key = "a") => outbox.queue(db, { serverId, agentId: agent.id, summary: key, kind: "page", event: {}, ttlMs: HOUR, now, objectRef: "page/1", key, onceWithinMs: 10 * 60 * 1000 });
  const first = await queue(start);
  assert.equal(first.created, true);
  assert.deepEqual(await queue(new Date(start.getTime() + 60_000)), { eventId: first.eventId, created: false });
  assert.equal((await queue(start, "b")).created, true, "another key is another notice");

  await outbox.withdrawUnread(db, { agentId: agent.id, objectRef: "page/1", key: "a", now: start });
  const rowOf = async (id: string) => (await db.select().from(thirdPartyAgentEvents).where(eq(thirdPartyAgentEvents.id, id)))[0]!;
  assert.equal((await rowOf(first.eventId)).status, "expired");
  assert.deepEqual(await queue(new Date(start.getTime() + 2 * 60_000)), { eventId: first.eventId, created: false });
  const back = await rowOf(first.eventId);
  assert.equal(back.status, "queued", "unread again");
  assert.equal(back.wakeCoalescedAt, null, "never pushed: it may still wake");

  const later = await queue(new Date(start.getTime() + 11 * 60_000));
  assert.equal(later.created, true);
  assert.notEqual(later.eventId, first.eventId);
  const keyed = await db.select({ id: thirdPartyAgentEvents.id }).from(thirdPartyAgentEvents)
    .where(eq(thirdPartyAgentEvents.externalEventId, "a")).orderBy(asc(thirdPartyAgentEvents.createdAt));
  assert.deepEqual(keyed.map((row) => row.id), [first.eventId, later.eventId], "two notices may share a key");
});
