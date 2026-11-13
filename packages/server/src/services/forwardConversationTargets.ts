import { sql } from "drizzle-orm";
import { formatRaftChannelTaskRef, formatRaftDmTaskRef } from "@botiverse/raft-shared";

import { getDb } from "../db/index";
import { channels, jointChannels, jointChannelServers, messages, tasks, threadFollows } from "../db/schema";
import { historyLimitedPreview } from "./historyPreview";

/**
 * Forward picker rows for threads and task conversations (the "Threads &
 * tasks" group and the thread / task hits of target search).
 *
 * Candidates are the sub-conversations the person takes part in: their
 * active follows. Replying follows a thread or task conversation (reason
 * `replied`, re-activating an unfollow), creating a task follows its
 * conversation (`authored`) and being handed it does too (`assigned`), so
 * "follows, replied, created, assigned" is one indexed read of
 * thread_follows (idx_thread_follows_follower). This module only finds and
 * labels candidates; the caller admits each one (visibility and post rights)
 * before any label leaves the server.
 */

/** Rows read per request before admission; bounds the per-row checks. */
export const FORWARD_CONVERSATION_SCAN_LIMIT = 40;
const TITLE_TEXT_MAX = 80;
const PREVIEW_MAX = 200;

export type ForwardConversationCandidate = {
  channelId: string;
  type: "thread" | "task";
  /**
   * Thread: the parent message's content, or only its glimpse when the parent
   * is behind the reader's history window (forwardParentContent).
   */
  parentMessageContent: string | null;
  taskNumber: number | null;
  taskTitle: string | null;
};

export type ForwardConversationQuery = {
  /** Lower-cased search text. */
  text: string;
  /** `7` / `#7`: a task number. */
  taskNumber: number | null;
};

export function parseForwardConversationQuery(q: string): ForwardConversationQuery {
  const number = /^#?(\d{1,9})$/.exec(q);
  return { text: q, taskNumber: number ? Number(number[1]) : null };
}

/**
 * A thread's parent message as the picker may show and search it: the whole
 * content, or the 40-character glimpse every other list gives a message
 * behind the plan's history window (historyLimitedPreview), so neither the
 * row's title and preview nor search ranking reach older text.
 */
export function forwardParentContent(content: string, createdAt: Date | string, historyCutoff: Date | undefined): string {
  return historyCutoff !== undefined && new Date(createdAt).getTime() <= historyCutoff.getTime()
    ? historyLimitedPreview(content) ?? ""
    : content;
}

function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/**
 * The person's followed threads and task conversations in this server, live
 * (not deleted, not archived), newest activity first: the latest message of
 * the conversation's storage (a joint face's canonical channel), else its
 * parent message, else when the follow began. With `query`, only those whose
 * parent message or task title contains the text, or whose task number it is.
 * A parent behind `historyCutoff` (the reader's plan window) is returned as
 * its glimpse only (forwardParentContent).
 *
 * Cost: one statement. The follow rows come from idx_thread_follows_follower;
 * the activity key is one backward probe of idx_messages_channel_seq per
 * followed conversation (the sort needs every follow's key), then at most
 * FORWARD_CONVERSATION_SCAN_LIMIT rows are returned.
 */
export async function listForwardConversationCandidates(opts: {
  serverId: string;
  userId: string;
  query?: ForwardConversationQuery;
  excludeChannelId?: string | null;
  historyCutoff: Date | undefined;
}): Promise<ForwardConversationCandidate[]> {
  const { serverId, userId, query, historyCutoff } = opts;
  const pattern = query ? likePattern(query.text) : null;
  const result = await getDb().execute(sql`
    SELECT
      c.id::text AS "channelId",
      c.type AS "type",
      parent_msg.content AS "parentMessageContent",
      parent_msg.created_at AS "parentMessageCreatedAt",
      task.task_number AS "taskNumber",
      task.title AS "taskTitle"
    FROM ${threadFollows} tf
    INNER JOIN ${channels} c
      ON c.id = tf.thread_channel_id
     AND c.type IN ('thread', 'task')
     AND c.server_id = ${serverId}
     AND c.deleted_at IS NULL
     AND c.archived_at IS NULL
    LEFT JOIN ${jointChannelServers} projection
      ON projection.local_channel_id = c.id
     AND projection.server_id = ${serverId}
     AND projection.status = 'active'
    LEFT JOIN ${jointChannels} joint
      ON joint.id = projection.joint_channel_id
     AND joint.status = 'active'
    LEFT JOIN ${tasks} task
      ON c.type = 'task'
     AND task.id = c.task_id
    LEFT JOIN ${channels} storage
      ON storage.id = COALESCE(joint.canonical_channel_id, task.conversation_channel_id, c.id)
    LEFT JOIN ${messages} parent_msg
      ON c.type = 'thread'
     AND parent_msg.id = storage.parent_message_id
     AND parent_msg.deleted_at IS NULL
    WHERE tf.follower_type = 'user'
      AND tf.follower_id = ${userId}
      AND tf.unfollowed_at IS NULL
      AND (c.type = 'task' OR parent_msg.id IS NOT NULL)
      AND (c.type = 'thread' OR task.id IS NOT NULL)
      ${opts.excludeChannelId ? sql`AND c.id <> ${opts.excludeChannelId}::uuid` : sql``}
      ${query
        ? sql`AND (
          parent_msg.content ILIKE ${pattern}
          OR task.title ILIKE ${pattern}
          ${query.taskNumber !== null ? sql`OR task.task_number = ${query.taskNumber}` : sql``}
        )`
        : sql``}
    ORDER BY
      COALESCE(
        (SELECT latest.seq FROM ${messages} latest WHERE latest.channel_id = storage.id ORDER BY latest.seq DESC LIMIT 1),
        parent_msg.seq
      ) DESC NULLS LAST,
      tf.created_at DESC,
      c.id DESC
    LIMIT ${FORWARD_CONVERSATION_SCAN_LIMIT}
  `);
  return (result.rows as Array<Record<string, unknown>>).map((row) => ({
    channelId: String(row.channelId),
    type: row.type === "task" ? "task" : "thread",
    parentMessageContent: typeof row.parentMessageContent === "string"
      ? forwardParentContent(row.parentMessageContent, row.parentMessageCreatedAt as Date | string, historyCutoff)
      : null,
    taskNumber: row.taskNumber == null ? null : Number(row.taskNumber),
    taskTitle: typeof row.taskTitle === "string" ? row.taskTitle : null,
  }));
}

export type ForwardConversationParentType = "channel" | "private" | "joint" | "dm";

export type ForwardConversationTarget = {
  type: "thread" | "task";
  channelType: "thread" | "task";
  id: string;
  channelId: string;
  title: string;
  subtitle: string;
  avatarUrl: null;
  parentChannelId: string;
  parentChannelName: string;
  parentChannelType: ForwardConversationParentType;
  taskNumber?: number;
  taskTitle?: string;
  parentMessagePreview?: string;
  current?: true;
  joined: true;
  dmExists: null;
  canForwardNow: true;
  requiredAction: null;
};

export function firstLine(content: string): string {
  return content.split("\n").map((line) => line.trim()).find((line) => line.length > 0) ?? "";
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * The row of an admitted candidate. `parent` is the person's local face of the
 * channel holding it; `dmPeerName` names the DM peer when that is a DM.
 */
export function formatForwardConversationTarget(
  candidate: ForwardConversationCandidate,
  parent: { id: string; name: string; type: ForwardConversationParentType },
  dmPeerName: string | null,
): ForwardConversationTarget {
  const parentLabel = parent.type === "dm" ? `dm:@${dmPeerName ?? parent.name}` : `#${parent.name}`;
  const base = {
    channelType: candidate.type,
    id: candidate.channelId,
    channelId: candidate.channelId,
    subtitle: "",
    avatarUrl: null,
    parentChannelId: parent.id,
    parentChannelName: parent.type === "dm" ? dmPeerName ?? parent.name : parent.name,
    parentChannelType: parent.type,
    joined: true,
    dmExists: null,
    canForwardNow: true,
    requiredAction: null,
  } as const;
  if (candidate.type === "task") {
    const taskNumber = candidate.taskNumber ?? 0;
    const taskTitle = candidate.taskTitle ?? "";
    const ref = parent.type === "dm"
      ? formatRaftDmTaskRef(dmPeerName ?? parent.name, taskNumber)
      : formatRaftChannelTaskRef(parent.name, taskNumber);
    return { ...base, type: "task", title: `${ref} ${truncate(taskTitle, TITLE_TEXT_MAX)}`, taskNumber, taskTitle };
  }
  const line = firstLine(candidate.parentMessageContent ?? "");
  return {
    ...base,
    type: "thread",
    title: `${parentLabel} › ${truncate(line, TITLE_TEXT_MAX)}`,
    parentMessagePreview: truncate(line, PREVIEW_MAX),
  };
}
