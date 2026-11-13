// Messages a first-party app posts as the signed-in person of a web request
// (platform/apps AppMessagePoster): ordinary messages through core's message
// pipeline (messageService.broadcastAndDeliver: stored, broadcast, delivered
// to agents), after the checks core's own `POST /api/messages` makes for that
// person (routes/messages.ts createHumanMessage), and, for a thread, those of
// a first thread reply (routes/channels.ts `POST /:id/threads`): the thread is
// created only once every check passed (and the app's `beforeWrite` step, when
// it has one, let it go on). Nothing on the message names the app.
import type { Server as SocketServer } from "socket.io";
import { UUID_RE } from "../lib/messageId";
import type { AppMessagePoster, AppWebReader } from "../platform/apps";
import { postableConversation } from "../platform/conversations";
import type { AgentOrchestrator } from "./agentOrchestrator";
import * as channelService from "./channelService";
import { assertChannelConversionWritable, resolveChannelConversionLockTarget } from "./channelConversionFenceService";
import { and, eq } from "drizzle-orm";
import { getDb } from "../db/index";
import { messages } from "../db/schema";
import { DmPeerNotMemberError } from "./dmSendPolicy";
import * as messageService from "./messageService";
import * as userService from "./userService";

/** Core's longest message (routes/messages.ts MAX_MESSAGE_LENGTH), held here too. */
const MAX_MESSAGE_LENGTH = 32_000;

const refused = { kind: "refused" } as const;

/** An app's idempotency key: at most this long, so core's randomId (`app:<id>:<key>`) stays within routes/messages.ts MAX_RANDOM_ID_LENGTH (128). */
const MAX_APP_IDEMPOTENCY_KEY_LENGTH = 100;

/**
 * Post `content` as `reader.userId` into a top-level conversation of the
 * reader's server, or into the thread under `threadRootId` in it. Refused
 * (nothing written) where the person couldn't send it themselves. A channel
 * being converted throws (ChannelConversionInProgressError), as core's send
 * does: it is temporary, not a refusal. With `idempotencyKey`, core's
 * idempotent send (`randomId`, unique per sender): `app:<appId>:<key>`, so no
 * app's key meets another's or the composer's.
 */
export async function postMessageAsReader(input: {
  io: SocketServer;
  orchestrator: AgentOrchestrator;
  appId: string;
  reader: AppWebReader;
  conversationId: string;
  threadRootId: string | null;
  content: string;
  idempotencyKey?: string;
  beforeWrite?: () => Promise<boolean>;
}): ReturnType<AppMessagePoster["postAsReader"]> {
  const { reader, conversationId, threadRootId, content, idempotencyKey } = input;
  if (idempotencyKey !== undefined && (idempotencyKey === "" || idempotencyKey.length > MAX_APP_IDEMPOTENCY_KEY_LENGTH)) {
    throw new Error(`an app's idempotency key is 1 to ${MAX_APP_IDEMPOTENCY_KEY_LENGTH} characters`);
  }
  if (!UUID_RE.test(conversationId) || (threadRootId !== null && !UUID_RE.test(threadRootId))) return refused;
  if (content.trim().length === 0 || content.length > MAX_MESSAGE_LENGTH) return refused;
  // A top-level conversation of the reader's server the person may post in (a
  // thread is named by its root; post authority on it resolves to its
  // conversation, checked there): platform/conversations' one rule.
  const channel = await postableConversation({ userId: reader.userId, serverId: reader.serverId }, conversationId);
  if (!channel) return refused;
  const conversionTarget = await resolveChannelConversionLockTarget(getDb(), channel.conversationId);
  if (conversionTarget) await assertChannelConversionWritable(conversionTarget.sourceChannelId);

  let targetChannelId = channel.conversationId;
  if (threadRootId !== null) {
    // The root is a message of this conversation (a joint one's: of its
    // canonical channel, which getOrCreateThreadForChannel checks).
    const root = await messageService.getMessage(threadRootId);
    if (!root) return refused;
    if (channel.type !== "joint" && root.channelId !== channel.conversationId) return refused;
  }
  // The app's own step, once the checks passed and before any write; never
  // for a key that already made a message: a retry (replayed below) or the
  // key used for another conversation (keyReused below).
  const randomId = idempotencyKey !== undefined ? `app:${input.appId}:${idempotencyKey}` : undefined;
  const keyUsed = randomId !== undefined && await hasMessageWithRandomId(reader.userId, randomId);
  if (input.beforeWrite && !keyUsed && !(await input.beforeWrite())) return { kind: "stopped" };
  if (threadRootId !== null) {
    try {
      targetChannelId = (await channelService.getOrCreateThreadForChannel(channel.conversationId, threadRootId, reader.userId, "user")).id;
    } catch (error) {
      if (error instanceof Error && error.message === "Parent message not found") return refused;
      throw error;
    }
  }

  const user = await userService.getUser(reader.userId);
  try {
    // slack-bridge-ordinary-message-producer: first_party_app.post_as_reader
    const message = await messageService.broadcastAndDeliver(input.io, input.orchestrator, {
      channelId: targetChannelId,
      senderType: "user",
      senderId: reader.userId,
      senderName: user?.displayName || user?.name || "User",
      content,
      ...(randomId !== undefined ? { randomId } : {}),
    });
    return { kind: "posted", messageId: message.id, ...(keyUsed ? { replayed: true as const } : {}) };
  } catch (error) {
    if (error instanceof messageService.UserRandomIdConflictError) return { kind: "keyReused" };
    if (error instanceof DmPeerNotMemberError || error instanceof channelService.ChannelArchivedError) return refused;
    throw error;
  }
}

/** Whether the person already sent a message with this `randomId` (core's idempotent send: its key, per sender). */
async function hasMessageWithRandomId(userId: string, randomId: string): Promise<boolean> {
  const [row] = await getDb().select({ id: messages.id }).from(messages)
    .where(and(eq(messages.senderType, "user"), eq(messages.senderId, userId), eq(messages.randomId, randomId))).limit(1);
  return row !== undefined;
}

/** The poster core hands one web request of an app (routes/firstPartyAppRoutes.ts). */
export function appMessagePoster(appId: string, reader: AppWebReader, io: SocketServer | undefined, orchestrator: AgentOrchestrator | undefined): AppMessagePoster {
  return {
    postAsReader(input) {
      if (!io || !orchestrator) throw new Error("posting a message needs the app's socket server and agent orchestrator");
      return postMessageAsReader({ ...input, io, orchestrator, appId, reader });
    },
  };
}
