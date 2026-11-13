// A thread reply that @mentions (by id) a follower who is not a member of the
// public parent channel (contract §1.2 `mention`): the mention is not a
// send-time mention target (the sender gets a mention action), but the reply is
// addressed to her and she can see the thread. Activity counts it as a mention,
// the same as the push ("mentioned you").
import { apiTest as test } from "../../test/integration/apiTest";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { getDb } from "../../db/index";
import { inboxNotificationFacts, messageMentions, notificationOutbox } from "../../db/schema";
import { followThread, getOrCreateThread, getUnreadSummary } from "../channelService";
import { broadcastAndDeliver, drainSenderReadReceiptsForTests } from "../messageService";
import { executeMentionActionId } from "../mentionActionService";
import { withChannelDelivery } from "../../test/orchestratorStub";
import {
  __resetNotificationDispatchRuntimeForTests,
  __setNotificationDispatchRuntimeForTests,
  registerNotificationSocketServer,
} from "./dispatcher";

type Human = { id: string; name: string };

const io = {
  to() { return { emit() {} }; },
  in() { return { in() { return { socketsJoin() {} }; }, socketsJoin() {}, emit() {} }; },
  emit() {},
} as any;
const orchestrator = withChannelDelivery({ deliverMessage: async () => ({ status: "queued" }) }) as any;

beforeEach(() => {
  registerNotificationSocketServer(null);
  __setNotificationDispatchRuntimeForTests({ schedule: () => {} });
});

afterEach(async () => {
  __resetNotificationDispatchRuntimeForTests();
  await drainSenderReadReceiptsForTests();
});

async function send(channelId: string, sender: Human, content: string, mentions: Human[] = []) {
  return broadcastAndDeliver(io, orchestrator, {
    channelId,
    senderType: "user",
    senderId: sender.id,
    senderName: sender.name,
    content,
    mentions: mentions.map((person) => ({ type: "user" as const, id: person.id, name: person.name })),
  });
}

async function factOf(messageId: string, receiverId: string) {
  const rows = await getDb().select().from(inboxNotificationFacts)
    .where(and(eq(inboxNotificationFacts.messageId, messageId), eq(inboxNotificationFacts.receiverId, receiverId)));
  assert.equal(rows.length, 1, "one fact for the receiver");
  return rows[0]!;
}

type InboxItem = { kind: string; threadChannelId?: string; hasMention: boolean; firstMentionMessageId: string | null; unreadCount: number };

async function inbox(http: any, human: Human, server: { id: string }, filter: string): Promise<InboxItem[]> {
  const response = await http.as(human, server).get(`/api/channels/inbox?filter=${filter}&limit=50`);
  assert.equal(response.status, 200);
  return (await response.json() as { items: InboxItem[] }).items;
}

test("a follower outside the public parent @mentioned in a reply: a personal-mention fact, an Activity mention, a mention outbox row", async ({ seed, http }) => {
  const ann = await seed.human({ name: "ann" }); // replier
  const pat = await seed.human({ name: "pat" }); // parent author
  const fay = await seed.human({ name: "fay" }); // manual follower outside the channel
  const server = await seed.server({ owner: ann, members: [pat, fay] });
  const channel = await seed.channel({ server, members: [ann, pat], name: "eng" });
  const parent = await send(channel.id, pat, "parent");
  const thread = await getOrCreateThread(parent.id, pat.id, "user");
  await followThread(fay.id, thread.id, parent.id);

  // Witness: an ordinary reply is an ordinary followed-thread fact.
  const ordinary = await send(thread.id, ann, "a reply");
  assert.equal((await factOf(ordinary.id, fay.id)).personalMention, false);
  assert.equal((await inbox(http, fay, server, "mentions")).some((item) => item.threadChannelId === thread.id), false,
    "no mention in Activity before the @mention");

  const mentioned = await send(thread.id, ann, `@${fay.name} look`, [fay]);
  const [mentionRow] = await getDb().select().from(messageMentions)
    .where(and(eq(messageMentions.messageId, mentioned.id), eq(messageMentions.targetId, fay.id)));
  assert.ok(mentionRow);
  assert.equal(mentionRow.notifiableAtSend, false, "not a send-time mention target (she is outside the parent channel)");
  assert.ok(mentionRow.notifiedAt, "notified at send, as the notify action would have");
  assert.equal(mentionRow.notifiedAction, "notify_only");

  const fact = await factOf(mentioned.id, fay.id);
  assert.equal(fact.personalMention, true, "the inbox fact itself is a personal mention");
  assert.equal(fact.kind, "thread");

  const [outbox] = await getDb().select().from(notificationOutbox)
    .where(and(eq(notificationOutbox.eventKey, `message:${mentioned.id}`), eq(notificationOutbox.receiverId, fay.id)));
  assert.equal(outbox?.category, "mention");
  assert.equal(outbox?.personalMention, true);

  // Activity (the real read path): the thread is in the mentions filter and flags the mention.
  const mentionItems = await inbox(http, fay, server, "mentions");
  const item = mentionItems.find((row) => row.kind === "thread" && row.threadChannelId === thread.id);
  assert.ok(item, "the thread is listed under Activity's mentions filter");
  assert.equal(item.hasMention, true);
  assert.equal(item.firstMentionMessageId, mentioned.id);
  const allItems = await inbox(http, fay, server, "all");
  assert.equal(allItems.filter((row) => row.threadChannelId === thread.id).length, 1, "one Activity row for the thread");

  // Sidebar unread: an unread mention for the thread.
  const summary = await getUnreadSummary(server.id, fay.id);
  assert.equal(summary[thread.id]?.hasMention, true);
  assert.equal(summary[thread.id]?.hasAnyMention, true);

  // Witness: the parent author's fact is unchanged (not mentioned).
  assert.equal((await factOf(mentioned.id, pat.id)).personalMention, false);

  // The sender's mention action: notify is already done (add stays available).
  const notify = await executeMentionActionId(mentionRow.id, server.id, "user", ann.id, "notify");
  assert.equal(notify.reason, "already_queued");
});
