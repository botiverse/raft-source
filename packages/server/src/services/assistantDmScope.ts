/**
 * Which of a person's conversations their assistant may read, as far as DMs
 * go (RFC 077 §3.1). Kept apart from assistantService so the visibility entry
 * (visibilityService, RFC 080 `delegated` actor) can apply the same rule
 * without importing the whole assistant service.
 */
import { eq } from "drizzle-orm";
import { getDb, type DatabaseExecutor } from "../db/index";
import { agents, messages } from "../db/schema";
import * as channelService from "./channelService";

/**
 * The DM a conversation belongs to: the DM itself, the DM a thread (or task v2
 * conversation) hangs off, or null when it is not under a DM. A thread whose
 * parent cannot be resolved is `{ dm: true, rootChannelId: null }`, so an
 * unknown shape fails closed. A joint thread's local projection has no parent
 * fields by design; its parent is the projection's local parent channel.
 */
export async function dmScopeOf(
  channel: { id: string; serverId: string; type: string; parentMessageId: string | null; parentChannelId?: string | null },
): Promise<{ dm: false } | { dm: true; rootChannelId: string | null }> {
  if (channel.type === "dm") return { dm: true, rootChannelId: channel.id };
  if (channel.type === "task") {
    // Task v2: a task conversation under a DM is DM-scoped like a thread
    // under it; its parent channel is on the row (unknown parent fails closed).
    if (!channel.parentChannelId) return { dm: true, rootChannelId: null };
    const parentChannel = await channelService.getChannel(channel.parentChannelId);
    if (!parentChannel) return { dm: true, rootChannelId: null };
    return parentChannel.type === "dm" ? { dm: true, rootChannelId: parentChannel.id } : { dm: false };
  }
  if (channel.type !== "thread") return { dm: false };
  if (!channel.parentMessageId) {
    const projection = await channelService.getJointThreadProjectionByLocalThread(channel.id, channel.serverId);
    if (!projection) return { dm: true, rootChannelId: null };
    const localParent = await channelService.getChannel(projection.localParentChannelId);
    if (!localParent) return { dm: true, rootChannelId: null };
    return localParent.type === "dm" ? { dm: true, rootChannelId: localParent.id } : { dm: false };
  }
  const [parent] = await getDb()
    .select({ channelId: messages.channelId })
    .from(messages)
    .where(eq(messages.id, channel.parentMessageId))
    .limit(1);
  if (!parent) return { dm: true, rootChannelId: null };
  const parentChannel = await channelService.getChannel(parent.channelId);
  if (!parentChannel) return { dm: true, rootChannelId: null };
  return parentChannel.type === "dm" ? { dm: true, rootChannelId: parentChannel.id } : { dm: false };
}

/** True for a DM or a thread (or task v2 conversation) under a DM (an unresolvable one counts as one). */
export async function isDmScopedChannel(channel: { id: string; serverId: string; type: string; parentMessageId: string | null; parentChannelId?: string | null }): Promise<boolean> {
  return (await dmScopeOf(channel)).dm;
}

/**
 * RFC 077: whether the assistant reads its owner's DMs. The owner's own switch
 * (`agents.assistant_reads_dms`, default on); it follows `personal_assistant`,
 * with no server flag of its own.
 */
export async function assistantReadsOwnerDms(agentId: string): Promise<boolean> {
  const [row] = await getDb().select({ readsDms: agents.assistantReadsDms }).from(agents).where(eq(agents.id, agentId)).limit(1);
  return row?.readsDms === true;
}

/** The owner's DM-reading switch (RFC 077). */
export async function setAssistantReadsDms(agentId: string, readsDms: boolean, executor: DatabaseExecutor = getDb()): Promise<void> {
  await executor.update(agents).set({ assistantReadsDms: readsDms }).where(eq(agents.id, agentId));
}

/**
 * Which of the owner's DM-scoped conversations the assistant may read: none
 * when the owner turned DM reading off; otherwise every DM except the
 * assistant's own DM with the owner (it already takes part there, and reading
 * its own replies back would only loop). Null = no DM may be read.
 */
export async function readableOwnerDmPolicy(input: { agentId: string; serverId: string; ownerUserId: string }): Promise<{ excludedRootChannelId: string | null } | null> {
  if (!await assistantReadsOwnerDms(input.agentId)) return null;
  return { excludedRootChannelId: await channelService.findHumanAgentDmChannelId(input.serverId, input.ownerUserId, input.agentId) };
}

/** May the assistant read this conversation of its owner's, as far as DMs go? Non-DM conversations pass. */
export async function mayAssistantReadOwnerConversation(
  policy: { excludedRootChannelId: string | null } | null,
  channel: { id: string; serverId: string; type: string; parentMessageId: string | null; parentChannelId?: string | null },
): Promise<boolean> {
  const scope = await dmScopeOf(channel);
  if (!scope.dm) return true;
  return policy !== null && scope.rootChannelId !== null && scope.rootChannelId !== policy.excludedRootChannelId;
}
