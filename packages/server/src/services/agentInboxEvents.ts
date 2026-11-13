// The per-event projection of an agent's inbox for `GET
// /internal/agent-api/events`, and its acknowledgement (immediate or cursor).
import {
  currentDate,
  type AgentMessage,
} from "@botiverse/raft-shared";
import { eq } from "drizzle-orm";
import { getDb, type DatabaseExecutor } from "../db/index";
import { agentInboxEventsPendingAcks } from "../db/schema";
import type { AgentOrchestrator } from "./agentOrchestrator";
import { renderAgentFacingContents } from "./agentFacingContent";
import * as channelService from "./channelService";
import { refreshQueuedAgentTaskProjections } from "./messageTaskProjection";
import { partitionDeliverableSystemAppEventMessages } from "./systemAppDeliveryGuards";

// Agent API response contracts describe the JSON wire payload. Server handlers
// may still hand us DB/domain objects containing Date instances, which Express
// would stringify only after this contract check. Normalize that boundary here
// so shared schemas stay wire-only instead of accepting server-domain values.
export function normalizeAgentApiWireValue(value: unknown): unknown {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map(normalizeAgentApiWireValue);
  }
  if (value && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return value;
    }
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([key, nested]) => [key, normalizeAgentApiWireValue(nested)]),
    );
  }
  return value;
}

export function queuedMessageChannelId(message: AgentMessage): string {
  const loose = message as { channel_id?: string; channelId?: string };
  return loose.channel_id ?? loose.channelId ?? "";
}

export async function canAgentAccessQueuedMessageTarget(
  channelId: string,
  agentId: string,
  serverId: string,
  message?: AgentMessage,
): Promise<boolean> {
  if (message?.third_party_event) return true;
  if (!channelId) return false;
  try {
    const channel = await channelService.getChannel(channelId);
    if (!channel || channel.serverId !== serverId) return false;
    return channelService.canAgentReceiveChannelDelivery(channelId, agentId, {
      personalMention: message?.mentioned === true,
    });
  } catch {
    return false;
  }
}

/**
 * Splits queued items into those the agent may receive now and those it may
 * not (to drop from the buffer), including system-app events their app's
 * delivery guard vetoes. A system-app event the guard withholds (fail closed)
 * is in neither: not handed over, but left in the buffer. `guardedEventIds`:
 * events the caller just guarded, not guarded again.
 */
export async function partitionDeliverableInboxMessages(
  messages: readonly AgentMessage[],
  agentId: string,
  serverId: string,
  options: { guardedEventIds?: ReadonlySet<string> } = {},
): Promise<{ deliverable: AgentMessage[]; undeliverable: AgentMessage[] }> {
  const guarded = await partitionDeliverableSystemAppEventMessages(messages, agentId, { guardedEventIds: options.guardedEventIds });
  const deliverable: AgentMessage[] = [];
  const undeliverable: AgentMessage[] = [...guarded.vetoed];
  for (const message of guarded.deliverable) {
    const canAccess = await canAgentAccessQueuedMessageTarget(queuedMessageChannelId(message), agentId, serverId, message);
    if (canAccess) deliverable.push(message);
    else undeliverable.push(message);
  }
  return { deliverable, undeliverable };
}

function toAgentFacingActorType(type: "user" | "agent" | "external_projection"): "human" | "agent" | "third_party_app" {
  return type === "external_projection" ? "third_party_app" : type === "user" ? "human" : "agent";
}

export type AgentInboxQueuedEvent = AgentMessage & {
  channelId?: string;
  channel_id?: string;
  id?: string;
  message_id?: string;
  messageType?: string;
  senderType?: string;
  sender_type?: string;
  seq?: number;
} & Record<string, unknown>;

/**
 * Renders queued inbox items into agent-facing events. Queue payloads are
 * enqueue-time snapshots: a task may be amended (or a message converted into a
 * task) before the handover, so every persisted message id is refreshed first.
 * The refresh throws on canonical/provenance failure; callers must then hand
 * over (and acknowledge) nothing, so the batch is retried.
 */
export async function projectAgentInboxEvents(
  messages: readonly AgentMessage[],
  serverId: string,
  agentId: string,
): Promise<AgentInboxQueuedEvent[]> {
  const refreshed = await refreshQueuedAgentTaskProjections(messages);
  // Raft's own system apps' events read as ordinary messages; an external app's inert (agentFacingContent.ts).
  const contents = await renderAgentFacingContents(refreshed, agentId, serverId);
  return (refreshed as AgentInboxQueuedEvent[]).map((m, index) => {
    const fallbackSenderType = m.messageType === "system"
      ? "system"
      : m.senderType === "user" || m.senderType === "agent" || m.senderType === "external_projection"
        ? toAgentFacingActorType(m.senderType)
        : "agent";
    return {
      ...m,
      // Buffer entries are snake_case AgentMessage: `sender_type` is already
      // agent-facing ("human" | "agent" | "system" | "third_party_app"). The previous mapping read
      // camelCase `m.senderType` (always undefined here), so this echo field
      // was stuck at "agent" for every event regardless of the real sender.
      senderType: m.sender_type ?? fallbackSenderType,
      content: contents[index]!,
    };
  });
}

/**
 * Acknowledge durable inbox rows handed to an external agent: the read position
 * of each conversation advances to the highest acknowledged seq in it. This is
 * the one inbox cursor per agent, whichever transport (`/events`, push) handed
 * the rows over.
 */
export async function acknowledgeExternalAgentInboxSeqs(
  agentOrchestrator: Pick<AgentOrchestrator, "acknowledgeDeliveredMessages">,
  agentId: string,
  seqs: readonly number[],
): Promise<channelService.AgentReadPositionAdvance[]> {
  const normalized = [...new Set(seqs.filter((seq) => Number.isInteger(seq) && seq > 0))];
  if (normalized.length === 0) return [];
  agentOrchestrator.acknowledgeDeliveredMessages(agentId, normalized);
  return channelService.markAgentLegacyAckCheckpoint(agentId, normalized);
}

/**
 * `/events?ack=cursor`: acknowledge the rows the agent's previous cursor-mode
 * response handed over with seq <= `sinceSeq`. The pending set is trimmed in the
 * same transaction that reads it, so two requests cannot both acknowledge the
 * same rows; the read-position write follows the commit (if it fails the rows
 * are simply delivered again). Returns the acknowledged seqs and the read
 * positions they moved.
 */
export async function acknowledgeAgentInboxEventsCursor(
  agentOrchestrator: Pick<AgentOrchestrator, "acknowledgeDeliveredMessages">,
  agentId: string,
  sinceSeq: number,
  executor: DatabaseExecutor = getDb(),
): Promise<{ acked: number[]; advances: channelService.AgentReadPositionAdvance[] }> {
  const ackable = await executor.transaction(async (tx) => {
    const [row] = await tx.select({ seqs: agentInboxEventsPendingAcks.seqs })
      .from(agentInboxEventsPendingAcks)
      .where(eq(agentInboxEventsPendingAcks.agentId, agentId))
      .for("update")
      .limit(1);
    const pending = Array.isArray(row?.seqs) ? row.seqs.filter((seq) => Number.isInteger(seq) && seq > 0) : [];
    const acked = pending.filter((seq) => seq <= sinceSeq);
    if (acked.length === 0) return [];
    await tx.update(agentInboxEventsPendingAcks).set({
      seqs: pending.filter((seq) => seq > sinceSeq),
      updatedAt: currentDate(),
    }).where(eq(agentInboxEventsPendingAcks.agentId, agentId));
    return acked;
  });
  const advances = await acknowledgeExternalAgentInboxSeqs(agentOrchestrator, agentId, ackable);
  return { acked: ackable, advances };
}

/** Record the durable rows a cursor-mode `/events` response hands over, unacknowledged. */
export async function recordAgentInboxEventsPendingAck(
  agentId: string,
  seqs: readonly number[],
  executor: DatabaseExecutor = getDb(),
): Promise<void> {
  const normalized = [...new Set(seqs.filter((seq) => Number.isInteger(seq) && seq > 0))].sort((a, b) => a - b);
  const now = currentDate();
  await executor.insert(agentInboxEventsPendingAcks)
    .values({ agentId, seqs: normalized, updatedAt: now })
    .onConflictDoUpdate({ target: agentInboxEventsPendingAcks.agentId, set: { seqs: normalized, updatedAt: now } });
}
