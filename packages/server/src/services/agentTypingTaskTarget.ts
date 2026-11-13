/**
 * Agent typing line, task v2 half: where a `raft task reply <ref>` is about to
 * land. The daemon reports the reply's task ref (`#channel:#7`, `dm:@peer:#7`;
 * also the interim `#channel:task-<task short id>`) as the send intent's
 * target; this resolves it READ-ONLY to the task's existing conversation on
 * the agent's server, which is also the room the line is emitted to.
 *
 * Same rules as the message-target preview (routes/agentWritableTarget
 * previewAgentPostTarget): channel / private / DM parents only (joint
 * refused: its room fan-out runs through projections), the private reminders
 * DM and migration receipts refused, archived refused, and the agent must be
 * allowed to post to the parent now. A task without a conversation yet (a
 * pre-v2 task, whose conversation the first reply creates) shows no line.
 */
import { parseRaftRefTarget } from "@botiverse/raft-shared";
import { and, eq, gte, lt } from "drizzle-orm";

import { getDb } from "../db/index";
import { tasks } from "../db/schema";
import { uuidShortIdRange } from "../lib/messageId";
import { AGENT_REMINDERS_DM_PEER } from "./agentPrivateSurfaces";
import type { AgentTypingTargetPreview } from "./agentTypingService";
import * as channelService from "./channelService";
import { DmTargetResolutionError } from "./dmTargetResolutionError";
import { resolveLocalTaskConversationId } from "./taskConversationService";

const INTERIM_CHANNEL_TASK_RE = /^#(.+):task-([0-9a-f]{8})$/i;
const INTERIM_DM_TASK_RE = /^dm:@(.+):task-([0-9a-f]{8})$/i;

type ParsedTaskTarget = {
  parent: { kind: "channel" | "dm"; name: string };
  task: { taskNumber: number } | { taskShortId: string };
};

/** A task target string, or null for anything else (message targets fall through). */
export function parseAgentTypingTaskTarget(target: string): ParsedTaskTarget | null {
  const ref = parseRaftRefTarget(target);
  if (ref?.kind === "task") {
    if (ref.channelName) return { parent: { kind: "channel", name: ref.channelName }, task: { taskNumber: ref.taskNumber } };
    if (ref.peerName) return { parent: { kind: "dm", name: ref.peerName }, task: { taskNumber: ref.taskNumber } };
    return null; // legacy `task #N` names no board
  }
  const channel = INTERIM_CHANNEL_TASK_RE.exec(target);
  if (channel) return { parent: { kind: "channel", name: channel[1]! }, task: { taskShortId: channel[2]! } };
  const dm = INTERIM_DM_TASK_RE.exec(target);
  if (dm) return { parent: { kind: "dm", name: dm[1]! }, task: { taskShortId: dm[2]! } };
  return null;
}

/**
 * The task conversation a typing target names, or null (not a task target,
 * or nothing the agent may post to now). Never creates anything.
 */
export async function previewAgentTaskReplyTarget(
  serverId: string,
  agentId: string,
  target: string,
): Promise<AgentTypingTargetPreview | null> {
  const parsed = parseAgentTypingTaskTarget(target.trim());
  if (!parsed) return null;
  if (parsed.parent.kind === "dm"
    && parsed.parent.name.replace(/~(agent|human)$/i, "").toLowerCase() === AGENT_REMINDERS_DM_PEER) {
    return null;
  }
  let parent: Awaited<ReturnType<typeof channelService.resolveChannelByName>>;
  try {
    parent = await channelService.resolveChannelByName(
      serverId,
      agentId,
      parsed.parent.kind === "channel" ? `#${parsed.parent.name}` : `dm:@${parsed.parent.name}`,
    );
  } catch (err) {
    if (err instanceof DmTargetResolutionError) return null;
    throw err;
  }
  if (!parent) return null;
  const parentType = parent.type;
  if (parsed.parent.kind === "channel" ? parentType !== "channel" && parentType !== "private" : parentType !== "dm") {
    return null;
  }

  const db = getDb();
  let taskId: string | null = null;
  if ("taskNumber" in parsed.task) {
    const [row] = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.channelId, parent.channelId), eq(tasks.taskNumber, parsed.task.taskNumber)))
      .limit(1);
    taskId = row?.id ?? null;
  } else {
    const bounds = uuidShortIdRange(parsed.task.taskShortId);
    const rows = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(
        eq(tasks.channelId, parent.channelId),
        gte(tasks.id, bounds.lower),
        ...(bounds.upper ? [lt(tasks.id, bounds.upper)] : []),
      ))
      .limit(2);
    taskId = rows.length === 1 ? rows[0]!.id : null;
  }
  if (!taskId) return null;
  const conversationId = await resolveLocalTaskConversationId(taskId, parent.channelId);
  if (!conversationId) return null;

  if (parentType === "dm" && await channelService.isAgentMigrationReceiptChannel(parent.channelId)) return null;
  if (!await channelService.canAgentPostToChannel(parent.channelId, agentId)) return null;
  if (await channelService.isChannelArchived(parent.channelId)) return null;
  return { channelId: conversationId, parentMessageId: null, taskId };
}
