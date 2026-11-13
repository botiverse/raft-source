// Which notification_outbox rows a send produces (design §3.1, contract §1.2).
// Every case drives the real fact recording (the send path, system notices,
// mention actions, reminders, account notices) and reads the outbox; the
// post-commit drain is captured so the rows stay pending.
import { dbTest as test } from "../../test/integration/dbTest";
import assert from "node:assert/strict";
import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "../../db/index";
import {
  agentMigrations,
  channels,
  inboxNotificationFacts,
  messageMentions,
  messages,
  notificationOutbox,
  reminders,
  tasks,
} from "../../db/schema";
import {
  findOrCreateUserDM,
  followThread,
  followThreadChannelForUser,
  getOrCreateThread,
  setInboxTargetActivityMuteState,
  unfollowThread,
  addHuman,
  removeHuman,
} from "../channelService";
import {
  addHumanWithMembershipSystemMessage,
  broadcastAndDeliver,
  broadcastSystemMessage,
  drainSenderReadReceiptsForTests,
  recordInboxFactsForPersistedMessages,
} from "../messageService";
import { executeMentionActionId } from "../mentionActionService";
import { createAgent } from "../agentService";
import * as taskService from "../taskService";
import { ensureTaskConversation } from "../taskConversationService";
import { postTaskConversationNotice } from "../taskConversationNotice";
import { postAgentActionRequiredNotice } from "../agentActionRequiredNoticeService";
import { notifyReminderFired } from "../../apps/reminder/firedNotification";
import { notifyHostedMigrationReviewReady } from "../hostedAgentMigrationImporter";
import { seedJointChannel } from "../../test/integration/jointFixture";
import { enableTaskV2ConversationsForServer } from "../../test/integration/taskV2Flag";
import { withChannelDelivery } from "../../test/orchestratorStub";
import { setLevel } from "./settings";
import { DESKTOP_NOTIFICATION_EVENT, type DesktopNotificationV1 } from "@botiverse/raft-shared";
import type { Server as SocketServer } from "socket.io";
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

let scheduled: Array<() => Promise<void>> = [];

beforeEach(() => {
  scheduled = [];
  registerNotificationSocketServer(null);
  __setNotificationDispatchRuntimeForTests({ schedule: (work) => { scheduled.push(work); } });
});

afterEach(async () => {
  __resetNotificationDispatchRuntimeForTests();
  await drainSenderReadReceiptsForTests();
});

type OutboxRow = typeof notificationOutbox.$inferSelect;

async function outboxFor(eventKey: string): Promise<OutboxRow[]> {
  return getDb().select().from(notificationOutbox).where(eq(notificationOutbox.eventKey, eventKey));
}

/** `<name>:<category>:<personal>` per row, sorted, for one message. */
async function rowsOf(messageId: string, people: readonly Human[]): Promise<string[]> {
  const rows = await outboxFor(`message:${messageId}`);
  for (const row of rows) {
    assert.equal(row.status, "pending", "the drain is captured, rows stay pending");
    assert.equal(row.messageId, messageId);
  }
  const name = (id: string) => people.find((person) => person.id === id)?.name ?? id;
  return rows.map((row) => `${name(row.receiverId)}:${row.category}:${row.personalMention}`).sort();
}

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

async function latestMessage(channelId: string) {
  const [row] = await getDb().select().from(messages).where(eq(messages.channelId, channelId)).orderBy(desc(messages.seq)).limit(1);
  assert.ok(row, "a message was posted");
  return row;
}

test("DM: the other human, category dm; an @mention in a DM stays dm with personal_mention", async ({ seed }) => {
  const ann = await seed.human({ name: "ann" });
  const bob = await seed.human({ name: "bob" });
  const server = await seed.server({ owner: ann, members: [bob] });
  const dm = await findOrCreateUserDM(server.id, ann.id, bob.id);
  assert.ok(dm);
  const people = [ann, bob];

  const plain = await send(dm.id, ann, "hi");
  assert.deepEqual(await rowsOf(plain.id, people), ["bob:dm:false"]);
  const [row] = await outboxFor(`message:${plain.id}`);
  assert.equal(row!.kind, "dm");
  assert.equal(row!.sourceChannelId, dm.id);
  assert.equal(row!.serverId, server.id);

  const mention = await send(dm.id, ann, `@${bob.name} look`, [bob]);
  assert.deepEqual(await rowsOf(mention.id, people), ["bob:dm:true"]);
  assert.equal(scheduled.length, 2, "one drain per send");
});

test("channel: members get channel rows, an @mention is a mention, the sender gets none", async ({ seed }) => {
  const ann = await seed.human({ name: "ann" });
  const bob = await seed.human({ name: "bob" });
  const cat = await seed.human({ name: "cat" });
  const server = await seed.server({ owner: ann, members: [bob, cat] });
  const channel = await seed.channel({ server, members: [ann, bob, cat], name: "general" });
  const people = [ann, bob, cat];

  const plain = await send(channel.id, ann, "ship it");
  assert.deepEqual(await rowsOf(plain.id, people), ["bob:channel:false", "cat:channel:false"]);
  const [row] = await outboxFor(`message:${plain.id}`);
  assert.equal(row!.kind, "channel");
  assert.equal(row!.sourceChannelId, channel.id);

  const mention = await send(channel.id, ann, `@${bob.name} ship it`, [bob]);
  assert.deepEqual(await rowsOf(mention.id, people), ["bob:mention:true", "cat:channel:false"]);
});

test("a public channel @mention of a server member outside the channel: not notifiable at send, a mention row after the notify action", async ({ seed }) => {
  const ann = await seed.human({ name: "ann" });
  const bob = await seed.human({ name: "bob" });
  const out = await seed.human({ name: "out" });
  const server = await seed.server({ owner: ann, members: [bob, out] });
  const channel = await seed.channel({ server, members: [ann, bob], name: "general" });
  const people = [ann, bob, out];

  const sent = await send(channel.id, ann, `@${out.name} please look`, [out]);
  assert.deepEqual(await rowsOf(sent.id, people), ["bob:channel:false"], "the outsider gets nothing at send");
  const [pending] = await getDb().select().from(messageMentions)
    .where(and(eq(messageMentions.messageId, sent.id), eq(messageMentions.targetId, out.id)));
  assert.ok(pending, "the mention is stored");
  assert.equal(pending.notifiableAtSend, false, "the sender gets a mention action instead");
  assert.equal(pending.notifiedAt, null);

  const result = await executeMentionActionId(pending.id, server.id, "user", ann.id, "notify");
  assert.equal(result.status, "queued", JSON.stringify(result));
  assert.deepEqual(await rowsOf(sent.id, people), ["bob:channel:false", "out:mention:true"]);
});

test("explicit target-visible mentions name an outsider of a public channel: one mention row, no inbox fact", async ({ seed }) => {
  const ann = await seed.human({ name: "ann" });
  const bob = await seed.human({ name: "bob" });
  const out = await seed.human({ name: "out" });
  const server = await seed.server({ owner: ann, members: [bob, out] });
  const channel = await seed.channel({ server, members: [ann, bob], name: "general" });
  const [message] = await getDb().insert(messages).values({
    channelId: channel.id, senderType: "user", senderId: ann.id, content: `@${out.name} hi`, seq: 1,
  }).returning();

  await recordInboxFactsForPersistedMessages([message!], {
    inboxFactPolicy: { mode: "record", producer: "test.enqueue", reason: "enqueue test" },
    targetVisibleMentionsByMessageId: new Map([[message!.id, [{ type: "user" as const, id: out.id, name: out.name }]]]),
  });

  assert.deepEqual(await rowsOf(message!.id, [ann, bob, out]), ["bob:channel:false", "out:mention:true"]);
  const [row] = (await outboxFor(`message:${message!.id}`)).filter((entry) => entry.receiverId === out.id);
  assert.equal(row!.kind, "channel");
  assert.equal(row!.sourceChannelId, channel.id);
  const outFacts = await getDb().select().from(inboxNotificationFacts)
    .where(and(eq(inboxNotificationFacts.messageId, message!.id), eq(inboxNotificationFacts.receiverId, out.id)));
  assert.deepEqual(outFacts, [], "Activity shows the outsider through public_channel_mention, not a fact");
});

test("thread: followers and same-send candidates get thread rows, an unfollowed follower only an @mention, a mentioned follower a mention", async ({ seed }) => {
  const ann = await seed.human({ name: "ann" }); // replier
  const pat = await seed.human({ name: "pat" }); // parent author
  const mel = await seed.human({ name: "mel" }); // parent-channel member, not following
  const fay = await seed.human({ name: "fay" }); // manual follower outside the channel
  const una = await seed.human({ name: "una" }); // explicitly unfollowed
  const server = await seed.server({ owner: ann, members: [pat, mel, fay, una] });
  const channel = await seed.channel({ server, members: [ann, pat, mel, una], name: "eng" });
  const people = [ann, pat, mel, fay, una];
  const parent = await send(channel.id, pat, "parent");
  const thread = await getOrCreateThread(parent.id, pat.id, "user");
  await followThread(fay.id, thread.id, parent.id);
  await followThread(una.id, thread.id, parent.id);
  await unfollowThread(una.id, thread.id);

  const ordinary = await send(thread.id, ann, "a reply");
  assert.deepEqual(await rowsOf(ordinary.id, people), ["fay:thread:false", "pat:thread:false"]);
  const [threadRow] = await outboxFor(`message:${ordinary.id}`);
  assert.equal(threadRow!.kind, "thread");
  assert.equal(threadRow!.sourceChannelId, thread.id);

  const mentioned = await send(thread.id, ann, `@${mel.name} @${una.name} @${fay.name} look`, [mel, una, fay]);
  assert.deepEqual(await rowsOf(mentioned.id, people), [
    // A follower outside the parent channel is not a send-time mention
    // target (the sender gets a mention action), but the reply is addressed
    // to her and she can see the thread: a mention.
    "fay:mention:true",
    "mel:mention:true",
    "pat:thread:false",
    "una:mention:true",
  ]);
  const fayMention = (await getDb().select().from(messageMentions).where(eq(messageMentions.messageId, mentioned.id)))
    .find((row) => row.targetId === fay.id);
  assert.equal(fayMention?.notifiableAtSend, false);
});

test("task conversation (task v2): its followers get thread rows", async ({ seed }) => {
  const ann = await seed.human({ name: "ann" });
  const cre = await seed.human({ name: "cre" });
  const fol = await seed.human({ name: "fol" });
  const bys = await seed.human({ name: "bys" });
  const server = await seed.server({ owner: ann, members: [cre, fol, bys] });
  const channel = await seed.channel({ server, members: [ann, cre, fol, bys], name: "work" });
  await enableTaskV2ConversationsForServer(server.id);
  const { tasks: [task] } = await taskService.createTasks(channel.id, "user", cre.id, [{ title: "ship" }]);
  const ensured = await ensureTaskConversation(task!.id);
  assert.ok(ensured);
  const [taskRow] = await getDb().select().from(tasks).where(eq(tasks.id, task!.id));
  const conversationId = taskRow!.conversationChannelId!;
  assert.ok(await followThreadChannelForUser(fol.id, conversationId));

  const reply = await send(conversationId, ann, "progress");
  assert.deepEqual(await rowsOf(reply.id, [ann, cre, fol, bys]), ["cre:thread:false", "fol:thread:false"]);
  for (const row of await outboxFor(`message:${reply.id}`)) {
    assert.equal(row.kind, "task");
    assert.equal(row.sourceChannelId, conversationId);
  }
});

test("muted channel: an ordinary message produces no row, an @mention does", async ({ seed }) => {
  const ann = await seed.human({ name: "ann" });
  const bob = await seed.human({ name: "bob" });
  const cat = await seed.human({ name: "cat" });
  const server = await seed.server({ owner: ann, members: [bob, cat] });
  const channel = await seed.channel({ server, members: [ann, bob, cat], name: "noisy" });
  await setInboxTargetActivityMuteState({ receiverType: "user", receiverId: bob.id, serverId: server.id, sourceChannelId: channel.id, activityMuted: true });

  const plain = await send(channel.id, ann, "chatter");
  assert.deepEqual(await rowsOf(plain.id, [ann, bob, cat]), ["cat:channel:false"]);
  const mention = await send(channel.id, ann, `@${bob.name} you`, [bob]);
  assert.deepEqual(await rowsOf(mention.id, [ann, bob, cat]), ["bob:mention:true", "cat:channel:false"]);
});

test("muted DM: an ordinary message produces no row, only an actual @mention notifies (an explicit mute of a DM is the user's intent)", async ({ seed }) => {
  const ann = await seed.human({ name: "ann" });
  const bob = await seed.human({ name: "bob" });
  const server = await seed.server({ owner: ann, members: [bob] });
  const dm = await findOrCreateUserDM(server.id, ann.id, bob.id);
  assert.ok(dm);
  await setInboxTargetActivityMuteState({ receiverType: "user", receiverId: bob.id, serverId: server.id, sourceChannelId: dm.id, activityMuted: true });

  const plain = await send(dm.id, ann, "hi");
  assert.deepEqual(await rowsOf(plain.id, [ann, bob]), [], "a muted DM's ordinary message stays silent");
  const mention = await send(dm.id, ann, `@${bob.name} look`, [bob]);
  assert.deepEqual(await rowsOf(mention.id, [ann, bob]), ["bob:dm:true"], "an @mention still notifies");
});

test("D10: a rename and a member join record facts but no outbox row; a silent notice still notifies whom it @mentions", async ({ seed }) => {
  const ann = await seed.human({ name: "ann" });
  const bob = await seed.human({ name: "bob" });
  const cat = await seed.human({ name: "cat" });
  const dan = await seed.human({ name: "dan" });
  const server = await seed.server({ owner: ann, members: [bob, cat, dan] });
  const channel = await seed.channel({ server, members: [ann, bob, cat], name: "eng" });

  const rename = await broadcastSystemMessage(io, orchestrator, channel.id, "ann renamed the channel to #eng", {
    inboxFactPolicy: { mode: "record", producer: "channel.rename", reason: "test", causalActor: { type: "user", id: ann.id } },
    targetAgentIds: [],
  });
  const renameFacts = await getDb().select().from(inboxNotificationFacts).where(eq(inboxNotificationFacts.messageId, rename.id));
  assert.deepEqual(renameFacts.filter((fact) => fact.unreadEligible).map((fact) => fact.receiverId).sort(), [bob.id, cat.id].sort(), "Activity counts it");
  assert.deepEqual(await outboxFor(`message:${rename.id}`), []);

  const [current] = await getDb().select().from(channels).where(eq(channels.id, channel.id));
  const joined = await addHumanWithMembershipSystemMessage({ channel: current!, userId: dan.id, userName: dan.name, causalActor: { type: "user", id: ann.id } });
  assert.ok(joined.added);
  const joinMessage = joined.message ?? await latestMessage(channel.id);
  assert.equal(joinMessage.messageType, "system");
  const joinFacts = await getDb().select().from(inboxNotificationFacts).where(eq(inboxNotificationFacts.messageId, joinMessage.id));
  assert.ok(joinFacts.some((fact) => fact.unreadEligible), "the join counts in Activity");
  assert.deepEqual(await outboxFor(`message:${joinMessage.id}`), []);

  const mentioning = await broadcastSystemMessage(io, orchestrator, channel.id, `@${bob.name} the channel was renamed`, {
    inboxFactPolicy: { mode: "record", producer: "channel.rename", reason: "test", causalActor: { type: "user", id: ann.id } },
    personalAttentionTargets: [{ type: "user", id: bob.id, name: bob.name }],
    targetAgentIds: [],
  });
  assert.deepEqual(await rowsOf(mentioning.id, [ann, bob, cat, dan]), ["bob:mention:true"]);
});

test("D10: a task status change notifies followers (task_status) and the creator / assignee personally by status, never the actor", async ({ seed }) => {
  const own = await seed.human({ name: "own" });
  const cre = await seed.human({ name: "cre" });
  const asg = await seed.human({ name: "asg" });
  const fol = await seed.human({ name: "fol" });
  const act = await seed.human({ name: "act" });
  const server = await seed.server({ owner: own, members: [cre, asg, fol, act] });
  const channel = await seed.channel({ server, members: [own, cre, asg, fol, act], name: "work" });
  const people = [own, cre, asg, fol, act];
  await enableTaskV2ConversationsForServer(server.id);
  const { tasks: [task] } = await taskService.createTasks(channel.id, "user", cre.id, [{ title: "ship" }]);
  await ensureTaskConversation(task!.id);
  const [taskRow] = await getDb().select().from(tasks).where(eq(tasks.id, task!.id));
  const conversationId = taskRow!.conversationChannelId!;
  assert.ok(await followThreadChannelForUser(fol.id, conversationId));
  // Claimed without the claim path, so the assignee does not follow.
  await getDb().update(tasks).set({ claimedByType: "user", claimedById: asg.id }).where(eq(tasks.id, task!.id));

  const statusNotice = async (status: string, actor: Human) => {
    await getDb().update(tasks).set({ status: status as never }).where(eq(tasks.id, task!.id));
    await postTaskConversationNotice(io, orchestrator, {
      taskId: task!.id,
      localChannel: { id: channel.id, serverId: server.id, deletedAt: null },
      actor: { type: "user", id: actor.id },
      content: `${actor.name} moved #${task!.taskNumber} to ${status}`,
    });
    const notice = await latestMessage(conversationId);
    assert.equal(notice.systemSubtype, "task.lifecycle_thread");
    return rowsOf(notice.id, people);
  };

  assert.deepEqual(await statusNotice("in_review", act), ["asg:task_status:true", "cre:task_status:true", "fol:task_status:false"]);
  assert.deepEqual(await statusNotice("done", act), ["asg:task_status:true", "cre:task_status:true", "fol:task_status:false"]);
  assert.deepEqual(await statusNotice("closed", act), ["asg:task_status:true", "cre:task_status:true", "fol:task_status:false"]);
  assert.deepEqual(await statusNotice("in_progress", act), ["cre:task_status:true", "fol:task_status:false"]);
  assert.deepEqual(await statusNotice("todo", act), ["cre:task_status:false", "fol:task_status:false"]);
  assert.deepEqual(await statusNotice("done", cre), ["asg:task_status:true", "fol:task_status:false"], "the actor (here the creator) is never notified");
  const rows = await outboxFor(`message:${(await latestMessage(conversationId)).id}`);
  for (const row of rows) {
    assert.equal(row.kind, "task");
    assert.equal(row.sourceChannelId, conversationId);
  }

  // The assignee explicitly unfollows the conversation: no personal row any more.
  assert.ok(await followThreadChannelForUser(asg.id, conversationId));
  await unfollowThread(asg.id, conversationId);
  assert.deepEqual(await statusNotice("in_review", act), ["cre:task_status:true", "fol:task_status:false"]);
});

test("D10: a task status personal recipient who lost access to the private parent channel gets no row", async ({ seed }) => {
  const cre = await seed.human({ name: "cre" });
  const asg = await seed.human({ name: "asg" });
  const act = await seed.human({ name: "act" });
  const server = await seed.server({ owner: cre, members: [asg, act] });
  const secret = await seed.channel({ server, members: [cre, asg, act], name: "secret", visibility: "private" });
  // The assignee leaves the private channel through the real membership path.
  await removeHuman(secret.id, asg.id, { self: true });
  await enableTaskV2ConversationsForServer(server.id);
  const { tasks: [task] } = await taskService.createTasks(secret.id, "user", cre.id, [{ title: "hidden" }]);
  await ensureTaskConversation(task!.id);
  const [taskRow] = await getDb().select().from(tasks).where(eq(tasks.id, task!.id));
  await getDb().update(tasks).set({ claimedByType: "user", claimedById: asg.id, status: "done" }).where(eq(tasks.id, task!.id));

  await postTaskConversationNotice(io, orchestrator, {
    taskId: task!.id,
    localChannel: { id: secret.id, serverId: server.id, deletedAt: null },
    actor: { type: "user", id: act.id },
    content: "act moved it to done",
  });
  const notice = await latestMessage(taskRow!.conversationChannelId!);
  assert.deepEqual(await rowsOf(notice.id, [cre, asg, act]), ["cre:task_status:true"]);
});

test("D10: task status (pre-v2 host thread) reaches the creator and assignee, with the task's title, subtitle and link on desktop; an explicit unfollow excludes the creator", async ({ seed }) => {
  const creator = await seed.human({ name: "creator" });
  const assignee = await seed.human({ name: "assignee" });
  const follower = await seed.human({ name: "follower" });
  const server = await seed.server({ owner: creator, members: [assignee, follower], name: "Acme", slug: "acme-desk" });
  const channel = await seed.channel({ server, members: [creator, assignee, follower], name: "eng" });
  const agent = await createAgent(server.id, "ferris", { runtime: "claude", creatorType: "user", creatorId: creator.id });
  const { tasks: [task], hostMessages: [host] } = await taskService.createTasks(channel.id, "user", creator.id, [{ title: "Fix login" }]);
  assert.ok(host);
  await getDb().update(tasks).set({ status: "in_review", claimedByType: "user", claimedById: assignee.id }).where(eq(tasks.id, task!.id));
  const thread = await getOrCreateThread(host.id, creator.id, "user");
  await followThread(follower.id, thread.id, host.id);
  const people = [creator, assignee, follower];
  const notice = async () => {
    await postTaskConversationNotice(io, orchestrator, {
      taskId: task!.id,
      localChannel: { id: channel.id, serverId: server.id, deletedAt: null },
      actor: { type: "agent", id: agent.id },
      content: `ferris moved #${task!.taskNumber} "Fix login" to In Review`,
    });
    return latestMessage(thread.id);
  };

  const first = await notice();
  assert.equal(first.systemSubtype, "task.lifecycle_thread");
  assert.deepEqual(await rowsOf(first.id, people), ["assignee:task_status:true", "creator:task_status:true", "follower:task_status:false"]);
  for (const row of await outboxFor(`message:${first.id}`)) assert.equal(row.kind, "thread");

  // Dispatch the captured drain to a desktop recorder.
  const emits: Array<{ room: string; event: string; payload: unknown }> = [];
  registerNotificationSocketServer({ to: (room: string) => ({ emit: (event: string, payload: unknown) => { emits.push({ room, event, payload }); } }) } as unknown as SocketServer);
  try {
    await Promise.all(scheduled.splice(0).map((work) => work()));
  } finally {
    registerNotificationSocketServer(null);
  }
  const desktopFor = (userId: string) => emits
    .filter((emit) => emit.event === DESKTOP_NOTIFICATION_EVENT && emit.room === `user:${userId}:clientKind:desktop`)
    .map((emit) => emit.payload as DesktopNotificationV1)
    .filter((payload) => payload.id === `message:${first.id}`);
  const [forCreator] = desktopFor(creator.id);
  assert.ok(forCreator, "the creator's desktop is notified");
  assert.equal(forCreator.kind, "task");
  assert.equal(forCreator.title, `#${task!.taskNumber} Fix login`);
  // The creator is in one server: the parent label alone (no server label).
  assert.equal(forCreator.subtitle, "#eng");
  assert.equal(forCreator.url, `/s/acme-desk/channel/${channel.id}?thread=${encodeURIComponent(`${channel.id}:${host.id}`)}&msg=${first.id}`);
  assert.equal(desktopFor(assignee.id).length, 1);
  assert.equal(desktopFor(follower.id).length, 1);

  // The creator explicitly unfollows the task thread: only the follower and the assignee remain.
  await followThread(creator.id, thread.id, host.id);
  await unfollowThread(creator.id, thread.id);
  const second = await notice();
  assert.deepEqual(await rowsOf(second.id, people), ["assignee:task_status:true", "follower:task_status:false"]);
});

test("D10: an assignment receipt notifies only the assignee, as task_assigned", async ({ seed }) => {
  const cre = await seed.human({ name: "cre" });
  const asg = await seed.human({ name: "asg" });
  const fol = await seed.human({ name: "fol" });
  const server = await seed.server({ owner: cre, members: [asg, fol] });
  const channel = await seed.channel({ server, members: [cre, asg, fol], name: "work" });
  await enableTaskV2ConversationsForServer(server.id);
  const { tasks: [task] } = await taskService.createTasks(channel.id, "user", cre.id, [{ title: "ship" }]);
  await ensureTaskConversation(task!.id);
  const [taskRow] = await getDb().select().from(tasks).where(eq(tasks.id, task!.id));
  assert.ok(await followThreadChannelForUser(fol.id, taskRow!.conversationChannelId!));

  await postTaskConversationNotice(io, orchestrator, {
    taskId: task!.id,
    localChannel: { id: channel.id, serverId: server.id, deletedAt: null },
    actor: { type: "user", id: cre.id },
    content: `cre assigned #${task!.taskNumber} "ship" to @${asg.name}`,
    attention: { type: "user", id: asg.id, name: asg.name },
  });
  const notice = await latestMessage(taskRow!.conversationChannelId!);
  assert.equal(notice.systemSubtype, "task.assignment_receipt");
  assert.deepEqual(await rowsOf(notice.id, [cre, asg, fol]), ["asg:task_assigned:true"]);
});

test("D10: an agent asking for help notifies the human of its DM as agent_attention", async ({ seed }) => {
  const own = await seed.human({ name: "own" });
  const bob = await seed.human({ name: "bob" });
  const server = await seed.server({ owner: own, members: [bob] });
  const agent = await createAgent(server.id, "ferris", { runtime: "claude", creatorType: "user", creatorId: own.id });

  assert.equal(await postAgentActionRequiredNotice(io, orchestrator, { agentId: agent.id, notice: { kind: "runtime_error", requiredAction: "user_model_access" } }), true);
  const [dm] = await getDb().select().from(channels).where(and(eq(channels.serverId, server.id), eq(channels.type, "dm")));
  assert.ok(dm);
  const actionRequired = await latestMessage(dm.id);
  assert.equal(actionRequired.systemSubtype, "agent.runtime_action_required");
  assert.deepEqual(await rowsOf(actionRequired.id, [own, bob]), ["own:agent_attention:true"]);
  const [row] = await outboxFor(`message:${actionRequired.id}`);
  assert.equal(row!.kind, "dm");
  assert.equal(row!.sourceChannelId, dm.id);
});

test("D10: a real-sender producer (pre-v2 task body message) notifies like an ordinary message", async ({ seed }) => {
  const cre = await seed.human({ name: "cre" });
  const bob = await seed.human({ name: "bob" });
  const server = await seed.server({ owner: cre, members: [bob] });
  const channel = await seed.channel({ server, members: [cre, bob], name: "work" });
  const { hostMessages: [host] } = await taskService.createTasks(channel.id, "user", cre.id, [{ title: "pre-v2 task" }]);
  assert.ok(host, "flag off: the task has a visible host message");
  assert.deepEqual(await rowsOf(host.id, [cre, bob]), ["bob:channel:false"]);
});

test("joint channel: one person on both servers gets one row, on the copy whose server level lets it through", async ({ seed }) => {
  const ann = await seed.human({ name: "ann" });
  const two = await seed.human({ name: "two" });
  const serverA = await seed.server({ owner: ann, members: [two] });
  const serverB = await seed.server({ owner: ann, members: [two] });
  const joint = await seedJointChannel({ name: "shared", serverIds: [serverA.id, serverB.id], createdByUserId: ann.id });
  const [copyA, copyB] = joint.projections;
  await addHuman(copyA!.id, ann.id);
  await addHuman(copyA!.id, two.id);
  await addHuman(copyB!.id, two.id);

  await setLevel({ userId: two.id, scope: "server", id: serverA.id, level: "none" });
  const first = await send(copyA!.id, ann, "hello both");
  const firstRows = (await outboxFor(`message:${first.id}`)).filter((row) => row.receiverId === two.id);
  assert.equal(firstRows.length, 1, "one row for the person");
  assert.equal(firstRows[0]!.sourceChannelId, copyB!.id, "the copy on the server that is not at none");
  assert.equal(firstRows[0]!.serverId, serverB.id);

  await setLevel({ userId: two.id, scope: "server", id: serverA.id, level: "all" });
  await setLevel({ userId: two.id, scope: "server", id: serverB.id, level: "none" });
  const second = await send(copyA!.id, ann, "hello again");
  const secondRows = (await outboxFor(`message:${second.id}`)).filter((row) => row.receiverId === two.id);
  assert.equal(secondRows.length, 1);
  assert.equal(secondRows[0]!.sourceChannelId, copyA!.id);
  assert.equal(secondRows[0]!.serverId, serverA.id);
});

test("retry: recording the same facts again inserts no second row and schedules no drain", async ({ seed }) => {
  const ann = await seed.human({ name: "ann" });
  const bob = await seed.human({ name: "bob" });
  const server = await seed.server({ owner: ann, members: [bob] });
  const channel = await seed.channel({ server, members: [ann, bob], name: "general" });
  const [message] = await getDb().insert(messages).values({
    channelId: channel.id, senderType: "user", senderId: ann.id, content: "once", seq: 1,
  }).returning();
  const record = () => recordInboxFactsForPersistedMessages([message!], {
    inboxFactPolicy: { mode: "record", producer: "test.enqueue", reason: "enqueue test" },
  });

  await record();
  const rows = await outboxFor(`message:${message!.id}`);
  assert.equal(rows.length, 1);
  assert.equal(scheduled.length, 1);
  await record();
  assert.deepEqual((await outboxFor(`message:${message!.id}`)).map((row) => row.id), rows.map((row) => row.id));
  assert.equal(scheduled.length, 1, "nothing inserted, nothing scheduled");
  // The one scheduled drain claims exactly the inserted row.
  await scheduled[0]!();
  const [after] = await getDb().select().from(notificationOutbox).where(inArray(notificationOutbox.id, rows.map((row) => row.id)));
  assert.notEqual(after!.status, "pending");
});

test("a fired reminder and an agent migration review notice enqueue their own events", async ({ seed }) => {
  const own = await seed.human({ name: "own" });
  const server = await seed.server({ owner: own });
  const agent = await createAgent(server.id, "ferris", { runtime: "claude", creatorType: "user", creatorId: own.id });
  const [reminder] = await getDb().insert(reminders).values({
    serverId: server.id, ownerAgentId: agent.id, title: "Check the deploy", fireAt: new Date(), createdByType: "human", createdById: own.id,
  }).returning();
  const firedAt = new Date().toISOString();

  await notifyReminderFired({ reminderId: reminder!.id, firedAt });
  await notifyReminderFired({ reminderId: reminder!.id, firedAt });
  const reminderRows = await outboxFor(`reminder:${reminder!.id}:${firedAt}`);
  assert.equal(reminderRows.length, 1, "a repeated fire report enqueues nothing new");
  const [reminderRow] = reminderRows;
  assert.equal(reminderRow!.receiverId, own.id);
  assert.equal(reminderRow!.category, "reminder");
  assert.equal(reminderRow!.personalMention, true);
  assert.equal(reminderRow!.serverId, server.id);
  assert.equal(reminderRow!.messageId, null);
  assert.equal(reminderRow!.status, "pending");
  assert.equal((reminderRow!.payload as { title: string }).title, "Reminder");
  assert.match((reminderRow!.payload as { body: string }).body, /Check the deploy/);
  assert.equal(scheduled.length, 1);

  const migration = { id: "6f0d3a3c-6a4b-4c49-9b38-0d9a8b0c1a11", agentId: agent.id, initiatedByUserId: own.id } as typeof agentMigrations.$inferSelect;
  await notifyHostedMigrationReviewReady(migration);
  const [migrationRow, ...extra] = await outboxFor(`migration:${migration.id}`);
  assert.deepEqual(extra, []);
  assert.equal(migrationRow!.receiverId, own.id);
  assert.equal(migrationRow!.category, "system_notice");
  assert.equal(migrationRow!.personalMention, true);
  assert.equal(migrationRow!.status, "pending");
  assert.equal((migrationRow!.payload as { title: string }).title, "Confirm moving ferris to the cloud");
  assert.match((migrationRow!.payload as { body: string }).body, /ferris is paused until you confirm/);
  // The English is rendered from the keys it is sent with (contract §1.5).
  assert.deepEqual(
    [(migrationRow!.payload as { titleKey?: string }).titleKey, (migrationRow!.payload as { titleArgs?: string[] }).titleArgs],
    ["push.title.agent_migration_review", ["ferris"]],
  );
  assert.deepEqual(
    [(migrationRow!.payload as { bodyKey?: string }).bodyKey, (migrationRow!.payload as { bodyArgs?: string[] }).bodyArgs],
    ["push.body.agent_migration_review", ["ferris"]],
  );
});
