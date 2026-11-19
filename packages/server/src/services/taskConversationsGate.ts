import { eq } from "drizzle-orm";
import { compareComputerVersions, isComputerSemver, RAFT_HINTS, TASK_V2_CONVERSATIONS_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";

import { getDb, type DatabaseExecutor } from "../db";
import { channels } from "../db/schema";
import { evaluateFeatureFlag } from "./featureFlagService";
import { agentComputerVersionAtLeast } from "./machineService";

/**
 * Task v2 conversations gate (`task_v2_conversations_v0`, server-scoped,
 * default off). Evaluated for the INITIATING server: the server whose local
 * channel / surface the request came through. For a joint channel the task's
 * storage channel lives on the shared joint storage server, whose flag says
 * nothing about the requester, so callers must pass the local server
 * (`isTaskV2ConversationsEnabledForRequest`). Reads / rendering decide by the
 * reader's server.
 *
 *  - On: creating a task writes no message and gives the task its own
 *    conversation (channels.type = 'task', taskConversationService); a
 *    `sourceMessageId` is accepted and, for agents, required (a task always
 *    has a source, #wg-task-v2:#23: `task_source_required`; the web's create
 *    without one posts the creator's message first, routes/tasks.ts, and so
 *    does an agent's from a CLI too old to send one, isPreTaskSourceCli); a reply
 *    in one of the channel's threads resolves to its root message
 *    (taskService.resolveTaskSourceMessage); a pre-v2 task gets its
 *    conversation on the first write; `task convert` / `task claim --message-id` / the web convert
 *    route refuse with `task_v2_use_create` (./taskV2UseCreate).
 *  - Off: creation writes the visible task-title chat message (broadcast,
 *    delivered to agents, inbox fact `task.body`) whose thread is the
 *    discussion, exactly as before task v2, and a requested `sourceMessageId`
 *    is refused with `task_v2_not_enabled`.
 * Per-task mode (./taskV2Mode): a task created the v2 way, or one that already
 * has its conversation, keeps working the v2 way whatever this flag says for
 * the server reading or writing it (rollback, the flag-off side of a joint
 * channel); the flag decides only how NEW tasks are created, the new entry
 * points, and whether a pre-v2 task gets a conversation lazily.
 * A missing flag or any evaluation failure reads as off.
 */
export async function isTaskV2ConversationsEnabled(
  serverId: string,
  executor?: DatabaseExecutor,
): Promise<boolean> {
  try {
    return await readTaskV2ConversationsEnabled(serverId, executor);
  } catch {
    return false;
  }
}

/** For responses that must fail rather than project an unknown flag as off. */
export async function readTaskV2ConversationsEnabled(
  serverId: string,
  executor?: DatabaseExecutor,
): Promise<boolean> {
  return (await evaluateFeatureFlag({ key: TASK_V2_CONVERSATIONS_FEATURE_FLAG_KEY, serverId }, executor)).enabled;
}

/**
 * The gate for a request: the initiating server when known, else the server
 * that owns `storageChannelId` (correct for every non-joint channel).
 */
export async function isTaskV2ConversationsEnabledForRequest(input: {
  initiatingServerId?: string | null;
  storageChannelId: string;
}, executor: DatabaseExecutor = getDb()): Promise<boolean> {
  if (input.initiatingServerId) return isTaskV2ConversationsEnabled(input.initiatingServerId, executor);
  return isTaskV2ConversationsEnabledForChannel(input.storageChannelId, executor);
}

/** The gate for the server that owns `channelId` (false when the channel is unknown). */
export async function isTaskV2ConversationsEnabledForChannel(
  channelId: string,
  executor: DatabaseExecutor = getDb(),
): Promise<boolean> {
  const [channel] = await executor
    .select({ serverId: channels.serverId })
    .from(channels)
    .where(eq(channels.id, channelId))
    .limit(1);
  if (!channel) return false;
  return isTaskV2ConversationsEnabled(channel.serverId, executor);
}

/** A create request named a source message on a server without task v2 conversations. */
export class TaskV2NotEnabledError extends Error {
  readonly code = "task_v2_not_enabled" as const;
  readonly status = 403;

  constructor(
    message = "Linking a task to a source message (source_message_id / --message-id) is not available on this server: "
      + "task v2 conversations are not enabled here. Create the task without it.",
  ) {
    super(message);
    this.name = "TaskV2NotEnabledError";
  }
}

export function hasTaskSourceMessage(items: readonly { sourceMessageId?: string | null }[]): boolean {
  return items.some((item) => typeof item.sourceMessageId === "string" && item.sourceMessageId.length > 0);
}

/**
 * What to do when a task's source is not a message of the channel (or one of
 * its threads): the request most often came in a DM or another channel.
 */
export const INVALID_TASK_SOURCE_STEP = "a task's source is a message in the conversation the task goes on. If the request came in a DM or another channel, make the task there, from that message. Only if it must live in this channel, post a message here saying what is needed in your own words (do not copy a DM or private channel, and do not name who asked unless they agreed), then create the task from it.";

/**
 * The refusal of an agent's task create without a source on a server with task
 * v2 conversations (#wg-task-v2:#23: "A task must always have a source"). The
 * sentence carries the rule for clients that print only `error` (CLIs from
 * before it); the create with its source left to fill is `next`. A CLI too old
 * to send a source never gets it (isPreTaskSourceCli): its create gets a
 * posted source instead.
 */
export function taskSourceRequiredRefusal(target: string) {
  return {
    code: "task_source_required",
    error: "A task needs a source: the id of the message that asked for it, in the conversation the task goes on; a reply in one of its threads works too (the task goes under that thread's first message). If the request came in a DM or another channel, make the task there. If it is your own idea, or must live here, post a message here saying what is needed in your own words (not copied from a private conversation), then create the task from it.",
    next: RAFT_HINTS.taskCreateWithSource({ target }),
  };
}

/**
 * The oldest `raft` CLI that sends a task's source: computer-v1.0.53 (its
 * bundled CLI 0.0.41) added `raft task create --message-id`. Since 1.0.55 the
 * CLI shares the Computer's version.
 */
export const TASK_SOURCE_MIN_CLI_VERSION = "1.0.53";

/**
 * Whether an agent's task create came from a `raft` CLI too old to send a
 * source (before TASK_SOURCE_MIN_CLI_VERSION). Such a create without one is
 * not refused with `task_source_required`: the agent could not do what the
 * refusal asks until its Computer is upgraded, so the Server posts the agent's
 * own message as the source, as the web's New task does (#wg-task-v2:#25).
 *
 * `client` is what the request says it is (internalAgentApi agentApiClientOf).
 * Only a request that says it is the CLI (`X-Raft-Client: cli`, or the older
 * `X-Slock-Client: cli`; a Computer's agent proxy sets it on all it forwards)
 * can be old: the SDK and any other client knows the source and is refused as
 * before. A CLI is current when its own `X-Raft-Client-Version` (sent since
 * 1.0.55) is at or above the floor, else when the agent's Computer last
 * reported such a version (agentComputerVersionAtLeast, the check the
 * upgrade-card hint uses: 1.0.53 and 1.0.54 send a source but no version).
 * Neither known (no Computer, a daemon that reports none, an external agent's
 * npm CLI from before 1.0.55) counts as old, as an unknown version does for
 * the Artifacts CLI floor and the upgrade card: each such CLI predates the
 * source, and a create that is let through still gets one.
 *
 * Not a security boundary: `client` is headers any caller can send, so any
 * agent client can claim to be an old CLI. That only picks between refusing
 * a sourceless create and posting the agent's own message as its source; the
 * post gets nothing a message send would not: the route checks the agent's
 * posting rights first and charges its message budget, and the message is
 * the task titles, mentioning no one (internalAgentApi taskCreate).
 */
export async function isPreTaskSourceCli(
  client: { kind: string | null; version: string | null },
  agentId: string,
  executor: DatabaseExecutor = getDb(),
): Promise<boolean> {
  if (client.kind?.toLowerCase() !== "cli") return false;
  if (client.version !== null && isComputerSemver(client.version)
    && compareComputerVersions(client.version, TASK_SOURCE_MIN_CLI_VERSION) >= 0) return false;
  return !await agentComputerVersionAtLeast(agentId, TASK_SOURCE_MIN_CLI_VERSION, executor);
}
