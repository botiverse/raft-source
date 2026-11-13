// Reactions and the first-party apps that hear of them
// (services/messageReactionService.ts, platform/apps
// FirstPartyApp.messageReactions): an app's steps can't fail a reaction, and
// its write inside the reaction's transaction reaches the database only
// through the executor it is handed. Real database; the apps are stand-ins
// (the real one is apps/reaction-notices/notices.api.test.ts).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterEach, vi } from "vitest";
import { asServerId } from "@botiverse/raft-shared";
import { ExecutorOnlyDatabaseAccessError, isInTransaction } from "../db/ambientTransaction";
import { getDb, getRootDb, type Database } from "../db/index";
import { agents, messageReactions, thirdPartyAgentEvents } from "../db/schema";
import { agentServers } from "../platform/actors";
import type { AppMessageReactionRequest, AppMessageReactionWrite, AppNoticeOutbox, FirstPartyApp } from "../platform/apps";
import { dbTest as test } from "../test/integration/dbTest";
import type { createSeed } from "../test/integration/seed";
import { createMessage } from "./messageService";
import { __setMessageReactionAppsForTests, mutateMessageReaction, type ReactionMessageFacts } from "./messageReactionService";

const SECRET = "the launch code is 4471";
const restores: Array<() => void> = [];
afterEach(() => {
  for (const restore of restores.splice(0)) restore();
  vi.restoreAllMocks();
});

type Prepare = (request: AppMessageReactionRequest, outbox: AppNoticeOutbox) => Promise<AppMessageReactionWrite | void>;

/** A stand-in app that hears of reactions; its notices are about a `message`. */
const app = (id: string, prepare: Prepare): FirstPartyApp => ({
  id,
  flag: `${id}_v0`,
  objectKinds: [],
  systemApp: `system.${id}`,
  agentNotice: { schema: { safeParse: () => ({ success: false }) }, deliverable: async () => new Map(), kinds: ["message"] },
  messageReactions: { prepare: (request, { noticeOutbox }) => prepare(request, noticeOutbox) },
});

async function seedWorld(db: Database, seed: ReturnType<typeof createSeed>, apps: FirstPartyApp[]) {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const channel = await seed.channel({ server, members: [owner] });
  const [author] = await db.insert(agents).values({ serverId: server.id, name: `a-${randomUUID().slice(0, 8)}` }).returning();
  const message = await createMessage(channel.id, "agent", author!.id, SECRET);
  restores.push(__setMessageReactionAppsForTests(apps));
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const react = (operation: "add" | "remove" = "add", emoji = "👍") =>
    mutateMessageReaction({ channelId: channel.id, messageId: message.id, emoji, actor: { kind: "user", id: owner.id }, operation });
  const reactions = () => db.select().from(messageReactions).where(eq(messageReactions.messageId, message.id));
  const events = (systemApp: `system.${string}`) => db.select().from(thirdPartyAgentEvents)
    .where(and(eq(thirdPartyAgentEvents.agentId, author!.id), eq(thirdPartyAgentEvents.systemApp, systemApp)));
  /** A notice queued through the outbox, as a real app's write does. */
  const queue = (outbox: AppNoticeOutbox, executor: Parameters<AppNoticeOutbox["queue"]>[0], at: Date) => outbox.queue(executor, {
    serverId: asServerId(server.id), agentId: author!.id, summary: "reacted", kind: "message", event: {}, ttlMs: 60_000, now: at, objectRef: `msg/${message.id}`,
  });
  /** The app step failures core logged: what it names, never the message. */
  const failures = () => errors.mock.calls
    .filter((call) => typeof call[0] === "string" && call[0].includes("first-party app step failed"))
    .map((call) => call[1] as { event: string; app: string; step: string; operation: string; messageId: string; error: { name: string; message: string } });
  return { owner, server, channel, author: author!, message, react, reactions, events, queue, failures, errors };
}

test("a write that throws is rolled back alone: the reaction commits, nothing of that write remains, another app's write and push go through", async ({ db, seed }) => {
  const pushed: string[] = [];
  const w = await seedWorld(db, seed, [
    app("boom", async (_request, outbox) => async ({ executor, at }) => {
      await w.queue(outbox, executor, at);
      // A failing statement too: the savepoint, not the transaction, takes it.
      await executor.insert(thirdPartyAgentEvents).values({ agentId: w.author.id } as never);
      return async () => { pushed.push("boom"); };
    }),
    app("calm", async (_request, outbox) => async ({ executor, at }) => {
      const { eventId } = await w.queue(outbox, executor, at);
      return async () => { pushed.push(eventId); };
    }),
  ]);

  const result = await w.react();
  assert.equal(result.changed, true);
  assert.equal((await w.reactions()).length, 1, "the reaction stuck");
  assert.deepEqual(await w.events("system.boom"), [], "the failed write's notice went with its savepoint");
  const [kept] = await w.events("system.calm");
  assert.ok(kept, "the other app's write committed");
  assert.deepEqual(pushed, [kept.id], "and only its push ran");

  const [failure, ...more] = w.failures();
  assert.equal(more.length, 0);
  assert.deepEqual(
    { event: failure!.event, app: failure!.app, step: failure!.step, operation: failure!.operation, messageId: failure!.messageId, errorName: failure!.error.name },
    { event: "message_reaction.app_step_failed", app: "boom", step: "write", operation: "add", messageId: w.message.id, errorName: "DatabaseError" },
  );
  assert.equal(JSON.stringify(w.errors.mock.calls).includes(SECRET), false, "the log names the app and the message's id, never its text");
});

test("a write that throws of its own (no statement failed) is rolled back the same way", async ({ db, seed }) => {
  const w = await seedWorld(db, seed, [
    app("boom", async (_request, outbox) => async ({ executor, at }) => {
      await w.queue(outbox, executor, at);
      throw new TypeError("not a function");
    }),
  ]);
  assert.equal((await w.react()).changed, true);
  assert.equal((await w.reactions()).length, 1);
  assert.deepEqual(await w.events("system.boom"), []);
  assert.deepEqual(w.failures().map((failure) => [failure.app, failure.step]), [["boom", "write"]]);
  // A removal is as safe.
  assert.equal((await w.react("remove")).changed, true);
  assert.deepEqual(await w.reactions(), []);
  assert.equal(w.failures().length, 2);
});

test("prepare and the push can't fail a reaction either: a throw before the transaction or after the commit is logged", async ({ db, seed }) => {
  const w = await seedWorld(db, seed, [
    app("early", async () => { throw new Error("prepare failed"); }),
    app("late", async () => async () => async () => { throw new Error("push failed"); }),
  ]);
  assert.equal((await w.react()).changed, true);
  assert.equal((await w.reactions()).length, 1);
  assert.deepEqual(w.failures().map((failure) => [failure.app, failure.step]), [["early", "prepare"], ["late", "after_commit"]]);
});

test("the write reaches the database only through the executor it is handed: getDb(), a platform read without it and getRootDb() are refused", async ({ db, seed }) => {
  const seen: Record<string, unknown> = {};
  const viaAmbient = (name: string, read: () => Promise<unknown>) => app(name, async (_request, outbox) => async ({ executor, at }) => {
    await w.queue(outbox, executor, at);
    await read();
  });
  const w = await seedWorld(db, seed, [
    // What an app might call without thinking: each would have run on the reaction's transaction unseen.
    viaAmbient("ambient", () => getDb().select().from(messageReactions)),
    viaAmbient("platform", () => agentServers([w.author.id])),
    viaAmbient("root", async () => getRootDb().select().from(messageReactions)),
    // The same reads through the executor: allowed, and they see the reaction's own uncommitted row.
    app("handed", async (_request, outbox) => async ({ executor, at }) => {
      seen.inTransaction = isInTransaction();
      seen.reactionRows = (await executor.select().from(messageReactions).where(eq(messageReactions.messageId, w.message.id))).length;
      seen.server = (await agentServers([w.author.id], { executor })).get(w.author.id);
      await w.queue(outbox, executor, at);
    }),
  ]);

  assert.equal((await w.react()).changed, true);
  assert.equal((await w.reactions()).length, 1);
  for (const refused of ["system.ambient", "system.platform", "system.root"] as const) assert.deepEqual(await w.events(refused), [], refused);
  assert.equal((await w.events("system.handed")).length, 1);
  assert.deepEqual(seen, { inTransaction: true, reactionRows: 1, server: w.server.id });
  assert.deepEqual(w.failures().map((failure) => [failure.app, failure.step]), [["ambient", "write"], ["platform", "write"], ["root", "write"]]);
  for (const failure of w.failures()) {
    assert.match(failure.error.message, /write in a reaction's transaction may use the database only through the executor it is handed, not getDb\(\)\.select|not getRootDb\(\)/);
  }
  assert.equal(new ExecutorOnlyDatabaseAccessError("s", "getDb().select").name, "ExecutorOnlyDatabaseAccessError");
});

test("prepare runs before the transaction opens, for every reaction asked; the write only when the reaction changed", async ({ db, seed }) => {
  const calls: Array<[string, boolean]> = [];
  let request: AppMessageReactionRequest | undefined;
  const w = await seedWorld(db, seed, [
    app("watch", async (asked) => {
      request = asked;
      calls.push(["prepare", isInTransaction()]);
      // No transaction is open: the app reads freely here.
      await getDb().select().from(messageReactions).limit(1);
      return async () => {
        calls.push(["write", isInTransaction()]);
        return async () => { calls.push(["after", isInTransaction()]); };
      };
    }),
  ]);
  assert.equal((await w.react()).changed, true);
  assert.deepEqual(calls, [["prepare", false], ["write", true], ["after", false]]);
  // What core read for it, before the transaction: the message.
  assert.deepEqual(request, {
    operation: "add",
    message: { id: w.message.id, channelId: w.channel.id, author: { type: "agent", id: w.author.id }, content: SECRET },
    reactor: { type: "user", id: w.owner.id },
    emoji: "👍",
  });

  // The same reaction again changes nothing: asked, never written.
  calls.length = 0;
  assert.equal((await w.react()).changed, false);
  assert.deepEqual(calls, [["prepare", false]]);

  // The message the caller already read is handed on as it is: core reads nothing for the apps.
  const human = await createMessage(w.channel.id, "user", w.owner.id, "lunch?");
  const handed: ReactionMessageFacts = { id: human.id, channelId: human.channelId, senderType: "user", senderId: w.owner.id, messageType: "chat", content: "as the route read it" };
  const react = (message: ReactionMessageFacts, messageId = human.id) =>
    mutateMessageReaction({ channelId: w.channel.id, messageId, emoji: "🎉", actor: { kind: "user", id: w.owner.id }, operation: "add", message });
  await react(handed);
  assert.deepEqual(request!.message, { id: human.id, channelId: w.channel.id, author: { type: "user", id: w.owner.id }, content: "as the route read it" });
  // Never another message's row: then core reads the one reacted to.
  await react(handed, w.message.id);
  assert.deepEqual([request!.message.id, request!.message.content], [w.message.id, SECRET]);
  // A system message, or one mirrored from outside Raft, has no author an app is told of.
  await react({ ...handed, messageType: "system" });
  assert.equal(request!.message.author, null);
  assert.deepEqual(w.failures(), []);
});

test("an app that answers nothing in prepare runs nothing in the transaction", async ({ db, seed }) => {
  let prepared = 0;
  const w = await seedWorld(db, seed, [app("quiet", async () => { prepared += 1; })]);
  assert.equal((await w.react()).changed, true);
  assert.equal(prepared, 1);
  assert.equal((await w.reactions()).length, 1);
  assert.deepEqual(w.failures(), []);
});
