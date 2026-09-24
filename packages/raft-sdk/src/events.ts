import { z } from "zod";
import type { AgentApiClient } from "@botiverse/raft-shared/src/agentApiClient.js";
import type { AgentApiMessageEnvelope } from "@botiverse/raft-shared/src/agentApiMessageContract.js";

export interface RaftEventsReceiveRequest {
  /** Numeric lower bound (exclusive). "latest" applies no numeric filter; it does not skip queued messages. */
  since?: number | "latest";
  /** Integer 1..200. Server default: 50. */
  limit?: number;
}

export interface RaftEventAttachment {
  id: string;
  filename: string;
  mimeType?: string;
  sizeBytes?: number;
}

/** External provenance is attribution, never Raft membership or user authority. */
export interface RaftEventExternalMessage {
  schema: "external-message-provenance.v1";
  provider: string;
  workspace_id: string;
  conversation_id: string;
  message_id: string;
  actor_id: string;
  actor_kind: "human" | "guest" | "remote" | "bot" | "unknown";
  projection_id: string;
}

/** A projection of an inbox message, not a general lifecycle event. Missing legacy metadata stays absent. */
export interface RaftEvent {
  type: "message";
  messageId?: string;
  seq?: number;
  content?: string;
  timestamp?: string;
  senderType: "human" | "agent" | "system" | "third_party_app" | "unknown";
  senderName?: string;
  channelId?: string;
  channelName?: string;
  channelType?: string;
  parentChannelName?: string;
  parentChannelType?: string;
  attachments: RaftEventAttachment[];
  externalMessage?: RaftEventExternalMessage;
}

export interface RaftEventsReceiveData {
  events: RaftEvent[];
  lastSeenSeq: number | null;
  lastSeenMessageId: string | null;
  hasMore: boolean;
  /** Server-provided batch hint; not a per-message thread target or proof of permission to reply. */
  replyTarget: string | null;
}

export interface RaftEventsReceiveError {
  code: "INVALID_REQUEST" | "TRANSPORT_ERROR" | "HTTP_ERROR" | "INVALID_RESPONSE";
  /** Safe SDK text; raw transport errors and response bodies are never included. */
  message: string;
}

export type RaftEventsReceiveResult =
  | { ok: true; status: number; data: RaftEventsReceiveData }
  | { ok: false; status?: number; error: RaftEventsReceiveError };

const sequence = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const requestSchema = z.object({
  since: z.union([sequence, z.literal("latest")]).optional(),
  limit: z.number().int().min(1).max(200).optional(),
}).strict();

// The shared contract validates the message envelope and external provenance.
// These additional fields are currently passthrough there; validate before exporting them.
const metadataSchema = z.object({
  seq: sequence.optional(),
  channel_id: z.string().optional(),
  channelId: z.string().optional(),
  attachments: z.array(z.object({
    id: z.string(), filename: z.string(), mimeType: z.string().optional(),
    sizeBytes: sequence.optional(),
  })).optional(),
});

function projectMessage(message: AgentApiMessageEnvelope): RaftEvent {
  const metadata = metadataSchema.parse(message);
  const sender = message.sender_type ?? message.senderType;
  const senderType = sender === "human" || sender === "agent" || sender === "system" || sender === "third_party_app"
    ? sender : "unknown";
  return {
    type: "message",
    messageId: message.message_id ?? message.id,
    seq: metadata.seq,
    content: message.content,
    timestamp: message.timestamp ?? message.createdAt,
    senderType,
    senderName: message.sender_name ?? message.senderName,
    channelId: metadata.channel_id ?? metadata.channelId,
    channelName: message.channel_name,
    channelType: message.channel_type,
    parentChannelName: message.parent_channel_name,
    parentChannelType: message.parent_channel_type,
    attachments: metadata.attachments ?? [],
    externalMessage: message.external_message,
  };
}

function failure(code: RaftEventsReceiveError["code"], status?: number): RaftEventsReceiveResult {
  const messages: Record<RaftEventsReceiveError["code"], string> = {
    INVALID_REQUEST: "Receive requires a nonnegative safe integer or latest cursor and an integer limit from 1 to 200.",
    TRANSPORT_ERROR: "Event receive transport failed. Delivery acknowledgement may already have occurred; no retry was attempted.",
    HTTP_ERROR: "Event receive returned an HTTP error. Delivery acknowledgement may already have occurred; no retry was attempted.",
    INVALID_RESPONSE: "Event receive response did not match the SDK contract. Delivery acknowledgement may already have occurred; no retry was attempted.",
  };
  return { ok: false, ...(status === undefined ? {} : { status }), error: { code, message: messages[code] } };
}

/** Internal adapter. The caller must supply a single-attempt transport: receive drains the returned batch. */
export async function receiveRaftEvents(
  client: Pick<AgentApiClient, "events">,
  request: RaftEventsReceiveRequest = {},
): Promise<RaftEventsReceiveResult> {
  const parsed = requestSchema.safeParse(request);
  if (!parsed.success) return failure("INVALID_REQUEST");
  const result = await client.events.get({
    ...(parsed.data.since === undefined ? {} : { since: String(parsed.data.since) }),
    ...(parsed.data.limit === undefined ? {} : { limit: String(parsed.data.limit) }),
  });
  if (!result.ok) {
    return failure(result.error.kind === "transport" ? "TRANSPORT_ERROR"
      : result.error.kind === "http" ? "HTTP_ERROR" : "INVALID_RESPONSE", result.status);
  }
  try {
    return { ok: true, status: result.status, data: {
      events: result.data.events.map(projectMessage),
      lastSeenSeq: sequence.nullable().parse(result.data.last_seen_seq),
      lastSeenMessageId: result.data.last_seen_msgId,
      hasMore: result.data.has_more,
      replyTarget: result.data.reply_target,
    } };
  } catch {
    return failure("INVALID_RESPONSE", result.status);
  }
}
