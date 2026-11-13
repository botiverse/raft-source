import type { Server as SocketServer } from "socket.io";

import type { AgentOrchestrator } from "./agentOrchestrator";
import * as agentService from "./agentService";
import * as channelService from "./channelService";
import * as messageService from "./messageService";
import * as taskService from "./taskService";
import * as userService from "./userService";
import { ensureTaskConversationAndBroadcast } from "./taskMutationBroadcast";
import { insertTaskConversationFollow, resolveFollowerLocalTaskConversation, type CreatedTaskConversation } from "./taskConversationService";
import { formatRaftChannelTaskRef, TASK_ASSIGNMENT_NOTICE_KIND, type TaskAssignmentNoticeMetadata, type TaskAssignmentNoticeParty } from "@botiverse/raft-shared";
import { sql } from "drizzle-orm";
import { getDb } from "../db/index";

/**
 * Task v2 lifecycle lines ("📌 Cody assigned #12 … to @RC", "✅ … moved to
 * Done") live in the TASK CONVERSATION (channels.type = 'task'). They never go
 * to the parent channel and never to the source message's thread. On a server
 * with task v2 conversations on (read for the initiating server), a task
 * created before task v2 gets its own conversation the first time a line is
 * written (taskConversationService.ensureTaskConversation), so its events
 * never land in its old host message's thread.
 *
 * Without a conversation (flag off, the task never had one) the line keeps
 * the pre-v2 behaviour exactly: the caller's legacy text in the host message's
 * thread (or nothing, where staging posted nothing).
 *
 * Assignment by someone else (spec §4, decided 2026-10-21): the assignee
 * FOLLOWS the conversation (reason `assigned`) and gets one personal
 * notification — the line carries the assignee as a personal-attention target,
 * which records a `message_mentions` row + a personal-mention inbox fact (a
 * person gets an Activity/Mentions entry) and wakes an agent with
 * `mentioned: true`, piercing its mute. Self-claim / unassign: a line, no
 * notification.
 *
 * Self-claim (decided 2026-10-21): whoever takes a task (claim, assign to
 * self) follows its conversation too (reason `assigned`, no notification).
 *
 * Assignment and claim reactivate an explicit unfollow (decided 2026-10-21),
 * like a direct @mention or one's own reply: being handed a task (which
 * notifies) or taking it is personal attention.
 */

export type TaskNoticeActor = { type: "user" | "agent"; id: string };

/** Display name of an actor for a lifecycle line. */
export async function describeTaskNoticeActor(actor: TaskNoticeActor): Promise<string> {
  if (actor.type === "agent") {
    const agent = await agentService.getAgent(actor.id);
    return agent?.displayName || agent?.name || "an agent";
  }
  const user = await userService.getUser(actor.id);
  return user?.displayName || user?.name || "someone";
}

/**
 * The assignee as a mention target (`@handle` + id). Null when the handle
 * cannot be resolved (deleted actor) — the notice then names nobody.
 */
export async function resolveTaskAssigneeAttention(
  assignee: TaskNoticeActor,
): Promise<messageService.ResolvedMentionFact | null> {
  if (assignee.type === "agent") {
    const agent = await agentService.getAgent(assignee.id);
    return agent ? { type: "agent", id: agent.id, name: agent.name } : null;
  }
  const user = await userService.getUser(assignee.id);
  return user ? { type: "user", id: user.id, name: user.name } : null;
}

/** An actor as the assignment line's structure names it (handle and display name, when known). */
async function describeTaskNoticeParty(party: TaskNoticeActor): Promise<TaskAssignmentNoticeParty> {
  if (party.type === "agent") {
    const agent = await agentService.getAgent(party.id);
    return { type: "agent", id: party.id, name: agent?.name ?? null, displayName: agent?.displayName || agent?.name || null };
  }
  const user = await userService.getUser(party.id);
  return { type: "user", id: party.id, name: user?.name ?? null, displayName: user?.displayName || user?.name || null };
}

/**
 * Lifecycle line + attention target for an assignee change. Assigning to
 * yourself (or unassigning) notifies nobody; assigning to someone else
 * mentions exactly that person or agent. A hand-off's reason (what the task
 * waits on them for) ends the line ("📌 Otter assigned #51 "…" to @xxchan:
 * <reason>"), so the assignee's notification carries it too. `actionMetadata`
 * is the line's structure (`TaskAssignmentNoticeMetadata`): web draws a
 * hand-off with a reason as a card from it.
 */
export async function buildTaskAssignmentNotice(input: {
  actor: TaskNoticeActor;
  assignee: TaskNoticeActor | null;
  taskNumber: number;
  title: string;
  /** Handing it to someone else: what it waits on them for, already normalized (`checkTaskAssignReason`). */
  reason?: string;
}): Promise<{
  content: string;
  attention: messageService.ResolvedMentionFact | null;
  /** The new assignee (self or someone else): follows the conversation. Null on unassign. */
  follower: TaskNoticeActor | null;
  actionMetadata: TaskAssignmentNoticeMetadata;
}> {
  const actorParty = await describeTaskNoticeParty(input.actor);
  const actorName = actorParty.type === "agent" ? actorParty.displayName ?? "an agent" : actorParty.displayName ?? "someone";
  const summary = messageService.summarizeForSystemMessage(input.title);
  const label = `#${input.taskNumber} "${summary}"`;
  const metadata = (assignee: TaskAssignmentNoticeParty | null, reason?: string): TaskAssignmentNoticeMetadata => ({
    kind: TASK_ASSIGNMENT_NOTICE_KIND,
    taskNumber: input.taskNumber,
    actor: actorParty,
    assignee,
    ...(reason && { reason }),
  });
  if (!input.assignee) {
    return { content: `🔓 ${actorName} unassigned ${label}`, attention: null, follower: null, actionMetadata: metadata(null) };
  }
  const follower = { type: input.assignee.type, id: input.assignee.id };
  if (input.assignee.type === input.actor.type && input.assignee.id === input.actor.id) {
    return { content: `📌 ${actorName} took ${label}`, attention: null, follower, actionMetadata: metadata(actorParty) };
  }
  const reasonTail = input.reason ? `: ${input.reason}` : "";
  const assigneeParty = await describeTaskNoticeParty(input.assignee);
  const attention = await resolveTaskAssigneeAttention(input.assignee);
  if (!attention) {
    return { content: `📌 ${actorName} assigned ${label}${reasonTail}`, attention: null, follower, actionMetadata: metadata(assigneeParty, input.reason) };
  }
  return {
    content: `📌 ${actorName} assigned ${label} to @${attention.name}${reasonTail}`,
    attention,
    follower,
    actionMetadata: metadata(assigneeParty, input.reason),
  };
}

/**
 * The status line ("🔄 Cody moved #7 "…" to In Progress"). One wording for
 * every path that changes a status (web, `raft task update`, claim): the actor
 * by display name, as every task lifecycle line names its actor.
 */
export async function buildTaskStatusNotice(input: {
  actor: TaskNoticeActor;
  taskNumber: number;
  title: string;
  status: string;
  /** A move into backlog: what would bring it back. */
  backlogReason?: string;
}): Promise<string> {
  const actorName = await describeTaskNoticeActor(input.actor);
  return messageService.buildTaskStatusChangeNotice(actorName, input.taskNumber, input.title, input.status, input.backlogReason);
}

/**
 * The line an edit of a task's wording writes in its conversation ("✏️ Cody
 * changed the title of #7 "…""), one wording for the web edit and `raft task
 * amend`. It names the task by its number and its title after the edit, as
 * every lifecycle line does; the old and new text live in History (the
 * `amended` event), not in the line. A change of wording notifies nobody:
 * the line is the ordinary lifecycle line, no mention, no follow.
 */
export async function buildTaskAmendNotice(input: {
  actor: TaskNoticeActor;
  taskNumber: number;
  /** The title after the edit. */
  title: string;
  changed: { title: boolean; description: boolean };
}): Promise<string | null> {
  const what = input.changed.title && input.changed.description
    ? "the title and description"
    : input.changed.title
      ? "the title"
      : input.changed.description
        ? "the description"
        : null;
  if (!what) return null;
  const actorName = await describeTaskNoticeActor(input.actor);
  return `✏️ ${actorName} changed ${what} of #${input.taskNumber} "${messageService.summarizeForSystemMessage(input.title)}"`;
}

/**
 * The lines a committed claim writes in the task conversation: one line per
 * change, worded as the other paths word that change — taking the task is the
 * self-assignment line ("📌 Cody took #7 …"), Todo → In Progress the status
 * line ("🔄 Cody moved #7 … to In Progress"). A task the claimer already held
 * gets only the status line; a claim that changed nothing, none.
 */
export async function buildTaskClaimNotices(input: {
  actor: TaskNoticeActor;
  taskNumber: number;
  title: string;
  before: { status: string; claimedByType: string | null; claimedById: string | null };
  afterStatus: string;
}): Promise<string[]> {
  return (await buildTaskClaimNoticeLines(input)).map((line) => line.content);
}

/** buildTaskClaimNotices with each line's structure (the "took" line's `TaskAssignmentNoticeMetadata`). */
async function buildTaskClaimNoticeLines(input: {
  actor: TaskNoticeActor;
  taskNumber: number;
  title: string;
  before: { status: string; claimedByType: string | null; claimedById: string | null };
  afterStatus: string;
}): Promise<{ content: string; actionMetadata?: TaskAssignmentNoticeMetadata }[]> {
  const lines: { content: string; actionMetadata?: TaskAssignmentNoticeMetadata }[] = [];
  const alreadyHeld = input.before.claimedByType === input.actor.type && input.before.claimedById === input.actor.id;
  if (!alreadyHeld) {
    const took = await buildTaskAssignmentNotice({
      actor: input.actor,
      assignee: input.actor,
      taskNumber: input.taskNumber,
      title: input.title,
    });
    lines.push({ content: took.content, actionMetadata: took.actionMetadata });
  }
  if (input.before.status !== input.afterStatus) {
    lines.push({
      content: await buildTaskStatusNotice({
        actor: input.actor,
        taskNumber: input.taskNumber,
        title: input.title,
        status: input.afterStatus,
      }),
    });
  }
  return lines;
}

/**
 * A committed claim, announced: the claimer follows the task conversation
 * (reason `assigned`, an explicit unfollow reactivated) and the conversation
 * gets the claim's lines (buildTaskClaimNotices), in order. Without a
 * conversation (flag off) `legacyContent` goes to the host message's thread
 * as before task v2 (null = staging posted nothing). Never throws: the claim
 * already committed.
 */
export async function announceTaskClaim(
  io: SocketServer,
  agentOrchestrator: AgentOrchestrator,
  input: {
    taskId: string;
    taskNumber: number;
    title: string;
    localChannel: { id: string; serverId?: string; deletedAt: Date | null };
    actor: TaskNoticeActor;
    before: { status: string; claimedByType: string | null; claimedById: string | null };
    afterStatus: string;
    legacyContent: string | null;
  },
): Promise<void> {
  try {
    const lines = await buildTaskClaimNoticeLines(input);
    const [first = null, ...rest] = lines;
    await postTaskConversationNotice(io, agentOrchestrator, {
      taskId: input.taskId,
      localChannel: input.localChannel,
      actor: input.actor,
      content: first?.content ?? null,
      actionMetadata: first?.actionMetadata,
      follower: input.actor,
      legacyContent: input.legacyContent,
    });
    for (const line of rest) {
      await postTaskConversationNotice(io, agentOrchestrator, {
        taskId: input.taskId,
        localChannel: input.localChannel,
        actor: input.actor,
        content: line.content,
        actionMetadata: line.actionMetadata,
        legacyContent: null,
      });
    }
  } catch (err) {
    console.error(`[taskConversationNotice] task ${input.taskId}: failed to announce its claim:`, err);
  }
}

/**
 * The new assignee follows the task conversation (reason `assigned`) on their
 * own local conversation; an explicit unfollow is reactivated (assignment and
 * claim are personal attention, like a direct @mention).
 */
async function followTaskConversationAsAssignee(
  conversation: CreatedTaskConversation,
  follower: TaskNoticeActor,
  preferredServerId: string | undefined,
): Promise<void> {
  const local = await resolveFollowerLocalTaskConversation(conversation, follower, { preferredServerId });
  if (!local) return;
  await insertTaskConversationFollow(getDb(), {
    conversationChannelId: local,
    taskId: conversation.taskId,
    follower,
    reason: "assigned",
    reactivateUnfollowed: true,
  });
}

/** The local conversation a surface (local channel) sees; canonical as a fallback. */
function localConversationFor(conversation: CreatedTaskConversation, localChannelId: string): string {
  for (const local of conversation.localByServer.values()) {
    if (local.localParentChannelId === localChannelId) return local.localChannelId;
  }
  return conversation.canonicalChannelId;
}

/**
 * Post a lifecycle line into the task's conversation, creating it first for a
 * pre-v2 task on a flag-on server. `attention` (assignment by someone else)
 * makes the assignee follow and notifies them once. Without a conversation
 * (flag off): `legacyContent` goes to the host message's thread as before task
 * v2 (`null` = staging posted nothing here). Returns the persisted notice, or
 * null when nothing was posted. Throws on failure — route callers that must
 * not fail the already-committed mutation catch and log.
 */
export async function postTaskConversationNotice(
  io: SocketServer,
  agentOrchestrator: AgentOrchestrator,
  input: {
    taskId: string;
    localChannel: { id: string; serverId?: string; deletedAt: Date | null };
    actor: TaskNoticeActor;
    /** The line; null = post no line in the conversation (the follow still happens). */
    content: string | null;
    /** The new assignee, when someone else handed them the task. */
    attention?: messageService.ResolvedMentionFact | null;
    /**
     * The new assignee who follows without being notified (self-claim / took
     * it). `attention` implies its own follow.
     */
    follower?: TaskNoticeActor | null;
    /** Flag-off text for the host message's thread; null = post nothing; undefined = `content`. */
    legacyContent?: string | null;
    /** The line's structure (an assignment line's `TaskAssignmentNoticeMetadata`); conversation line only. */
    actionMetadata?: TaskAssignmentNoticeMetadata;
  },
) {
  const conversation = await ensureTaskConversationAndBroadcast(io, input.taskId, {
    initiatingServerId: input.localChannel.serverId ?? null,
    createdByUserId: input.actor.type === "user" ? input.actor.id : null,
  });
  if (!conversation) return postLegacyHostThreadNotice(io, agentOrchestrator, input);

  const attention = input.attention && input.attention.type !== "external" ? input.attention : null;
  const follower: TaskNoticeActor | null = attention
    ? { type: attention.type as "user" | "agent", id: attention.id }
    : input.follower ?? null;
  if (follower) {
    await followTaskConversationAsAssignee(conversation, follower, input.localChannel.serverId);
  }
  if (input.content === null) return null;
  const localConversationId = localConversationFor(conversation, input.localChannel.id);
  return messageService.broadcastSystemMessageToLocalSurfaces(io, agentOrchestrator, localConversationId, input.content, {
    inboxFactPolicy: attention
      ? {
        mode: "record",
        // Its own subtype: the notification pipeline treats an assignment as
        // `task_assigned` (reaches the assignee), not a `task_status` change.
        producer: "task.assignment_receipt",
        reason: "a task assignment is durable directed attention for its assignee",
        causalActor: input.actor,
      }
      : {
        mode: "record",
        producer: "task.lifecycle_thread",
        reason: "task status transitions are a collaboration signal for the task conversation audience",
        causalActor: input.actor,
      },
    ...(attention && { personalAttentionTargets: [attention] }),
    ...(input.actionMetadata && { actionMetadata: input.actionMetadata }),
  });
}

/** Pre-v2 (flag off): the lifecycle line in the host message's thread, exactly as staging. */
async function postLegacyHostThreadNotice(
  io: SocketServer,
  agentOrchestrator: AgentOrchestrator,
  input: {
    taskId: string;
    localChannel: { id: string; deletedAt: Date | null };
    actor: TaskNoticeActor;
    content: string | null;
    legacyContent?: string | null;
  },
) {
  const content = input.legacyContent === undefined ? input.content : input.legacyContent;
  if (content === null) return null;
  const task = await taskService.getLegacyTask(input.taskId);
  if (!task?.messageId) return null;
  // Soft-deleted ordinary channels cannot act as a live projection surface;
  // keep the pre-joint orphan path for those historical tasks.
  const thread = input.localChannel.deletedAt
    ? await channelService.getOrCreateThread(task.messageId, input.actor.id, input.actor.type)
    : await channelService.getOrCreateThreadForChannel(input.localChannel.id, task.messageId, input.actor.id, input.actor.type);
  return messageService.broadcastSystemMessageToLocalSurfaces(io, agentOrchestrator, thread.id, content, {
    inboxFactPolicy: {
      mode: "record",
      producer: "task.lifecycle_thread",
      reason: "task status transitions are a collaboration signal for the thread audience",
      causalActor: input.actor,
    },
  });
}

/** Pre-v2 assignment line wording (no mention), for the flag-off host thread. */
export async function buildLegacyTaskAssignmentLine(input: {
  actor: TaskNoticeActor;
  assignee: TaskNoticeActor | null;
  taskNumber: number;
  title: string;
  /** A hand-off's reason: ends the line, as in the conversation line. */
  reason?: string;
}): Promise<string> {
  const actorName = await describeTaskNoticeActor(input.actor);
  const summary = messageService.summarizeForSystemMessage(input.title);
  if (!input.assignee) return `🔓 ${actorName} unassigned #${input.taskNumber} "${summary}"`;
  const assigneeName = input.assignee.type === "agent"
    ? (await agentService.getAgent(input.assignee.id))?.displayName || (await agentService.getAgent(input.assignee.id))?.name || "an agent"
    : (await userService.getUser(input.assignee.id))?.displayName || (await userService.getUser(input.assignee.id))?.name || "someone";
  return `📌 ${actorName} assigned #${input.taskNumber} "${summary}" to ${assigneeName}${input.reason ? `: ${input.reason}` : ""}`;
}

/**
 * Task v2 (flag on) assigned creation: creating a task posts nothing in the
 * channel, so instead of the channel assignment receipt each new task's
 * conversation gets the same assignment line a later assign writes — it
 * mentions the assignee (inbox entry / agent wake, once) when someone else was
 * handed the task, and notifies nobody when the creator took it. Best-effort
 * per task: the creation already committed.
 */
export async function announceTaskCreationAssignment(
  io: SocketServer,
  agentOrchestrator: AgentOrchestrator,
  input: {
    tasks: readonly { id: string; taskNumber: number; title: string }[];
    localChannel: { id: string; serverId?: string; deletedAt: Date | null };
    actor: TaskNoticeActor;
    assignee: TaskNoticeActor;
  },
): Promise<void> {
  for (const task of input.tasks) {
    try {
      const notice = await buildTaskAssignmentNotice({
        actor: input.actor,
        assignee: input.assignee,
        taskNumber: task.taskNumber,
        title: task.title,
      });
      await postTaskConversationNotice(io, agentOrchestrator, {
        taskId: task.id,
        localChannel: input.localChannel,
        actor: input.actor,
        content: notice.content,
        attention: notice.attention,
        actionMetadata: notice.actionMetadata,
      });
    } catch (err) {
      console.error(`[taskConversationNotice] task ${task.id}: failed to announce its assignment:`, err);
    }
  }
}

/**
 * Task v2: fan out the "resource receipt recorded" line that
 * taskService.recordTaskResourceReceipt committed in the task conversation as
 * the expiry follow-up's anchor (a v2 task without a source message). Realtime
 * only: the line is an audit/anchor line, so it records no inbox facts and
 * wakes nobody (the follow-up itself is the owner's later wake). Never
 * throws: the receipt is already committed.
 */
export async function publishTaskResourceReceiptLine(
  io: SocketServer,
  agentOrchestrator: AgentOrchestrator,
  line: NonNullable<taskService.TaskResourceReceiptResult["receiptLine"]>,
  actor: TaskNoticeActor,
): Promise<void> {
  try {
    await messageService.broadcastSystemMessageToLocalSurfaces(io, agentOrchestrator, line.localConversationId, line.content, {
      inboxFactPolicy: {
        mode: "skip",
        producer: "task.lifecycle_thread",
        reason: "a resource receipt line anchors the expiry follow-up; the follow-up is the attention signal",
        causalActor: actor,
      },
      persistedMessage: line.message,
    });
  } catch (err) {
    console.error("[taskConversationNotice] resource receipt line fan-out failed:", err);
  }
}

/**
 * Task v2: tasks created from a message leave one line in that message's
 * thread ("📌 @bob created #proj:#7 "…" from this message"), so its sender
 * sees the request was taken where they asked, and an agent about to answer
 * the same request sees it first (#wg-task-v2:98488173). The same whoever
 * creates it and whoever wrote the message, the creator's own included
 * (stdrc: a person's create and an agent's do not differ). The sender follows
 * the thread (as when a reply lands under their message). Never throws: the
 * creation already committed.
 */
export async function announceTasksCreatedFromSourceMessages(
  io: SocketServer,
  agentOrchestrator: AgentOrchestrator,
  input: {
    tasks: readonly { taskNumber: number; title: string; sourceMessageId?: string | null }[];
    localChannel: { id: string; name: string; type: string; deletedAt: Date | null };
    actor: TaskNoticeActor;
  },
): Promise<void> {
  const bySource = new Map<string, { taskNumber: number; title: string }[]>();
  for (const task of input.tasks) {
    if (!task.sourceMessageId) continue;
    bySource.set(task.sourceMessageId, [...(bySource.get(task.sourceMessageId) ?? []), task]);
  }
  if (bySource.size === 0) return;
  const actorName = await describeTaskNoticeActor(input.actor).catch(() => "Someone");
  const ref = (taskNumber: number) => (input.localChannel.type === "dm"
    ? `#${taskNumber}`
    : formatRaftChannelTaskRef(input.localChannel.name, taskNumber));
  for (const [sourceMessageId, created] of bySource) {
    try {
      const source = await messageService.getMessage(sourceMessageId);
      if (!source || (source.senderType !== "user" && source.senderType !== "agent")) continue;
      const list = created
        .map((task) => `${ref(task.taskNumber)} "${messageService.summarizeForSystemMessage(task.title)}"`)
        .join(", ");
      const content = `📌 ${actorName} created ${list} from this message`;
      const thread = input.localChannel.deletedAt
        ? await channelService.getOrCreateThread(sourceMessageId, input.actor.id, input.actor.type)
        : await channelService.getOrCreateThreadForChannel(input.localChannel.id, sourceMessageId, input.actor.id, input.actor.type);
      if (input.localChannel.type !== "joint") {
        // Joined through the thread's latest seq, as the "authored" follow on
        // a reply is: the line below (and anything after) reads as new.
        try {
          const latest = await getDb().execute(sql`SELECT COALESCE(MAX(seq), 0) AS seq FROM messages WHERE channel_id = ${thread.id}`);
          const joinedThroughSeq = Number((latest.rows[0] as { seq?: number | string } | undefined)?.seq ?? 0);
          await channelService.recordThreadFollow(source.senderType, source.senderId, thread.id, sourceMessageId, "authored", { joinedThroughSeq });
        } catch (err) {
          console.error(`[taskConversationNotice] source ${sourceMessageId}: failed to follow its sender:`, err);
        }
      }
      await messageService.broadcastSystemMessageToLocalSurfaces(io, agentOrchestrator, thread.id, content, {
        inboxFactPolicy: {
          mode: "record",
          producer: "task.lifecycle_thread",
          reason: "a request taken as a task is a collaboration signal for its message's thread",
          causalActor: input.actor,
        },
      });
    } catch (err) {
      console.error(`[taskConversationNotice] source ${sourceMessageId}: failed to announce its tasks:`, err);
    }
  }
}
