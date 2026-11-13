// Platform entry point: attachments, for an app that keeps its own copy of
// one or names where one was posted.
// An app never references core's attachment storage (first-party app
// mechanism §八): it copies the bytes into its own store, so core deletes an
// attachment without asking any app.
//
// Both reads ask core's own attachment authority
// (attachmentAuthorityService.resolveReadableAttachmentAuthorityContext, what
// the attachment routes use): a live, bound attachment (not revoked, in a
// message, its object not deleted by GC) whose message's conversation the
// viewer can see, as the viewer's server shows it (a joint message by the
// viewer's local projection), then the plan's history window of the
// viewer's server (services/historyWindow.ts, as the attachment routes check
// it after the authority): a file posted in a message behind the window is
// behind it too, so a Free server's member can't copy a file older than its
// 30 days into something kept. Anything else is null, one answer for "no
// such attachment", "not yours to see" and "behind the window" (the
// attachment routes' 404 for a person).
import type { Readable } from "node:stream";
import { isSubConversationType } from "@botiverse/raft-shared";
import { mapWithConcurrency } from "../lib/mapWithConcurrency";
import { UUID_RE } from "../lib/messageId";
import { resolveThreadParent } from "../services/channelService";
import { resolveReadableAttachmentAuthorityContext, type AttachmentAuthorityContext } from "../services/attachmentAuthorityService";
import { getServerHistoryWindowForRead, isAttachmentBehindWindow, type HistoryWindow } from "../services/historyWindow";
import { getStorage, isStorageNotFoundError } from "../services/storageService";
import { assertNeverViewActor, type ViewActor } from "../services/visibilityService";

/** Where an attachment the viewer can see was posted: its message and that message's conversation, as the viewer's server names it. */
export interface AttachmentSource {
  attachmentId: string;
  messageId: string;
  /** The conversation (a thread's own id for a thread) in the viewer's server. */
  channelId: string;
  /**
   * The top-level conversation it is in, in the viewer's server: `channelId`,
   * or a thread's (or task conversation's) own conversation. Null when that
   * can't be resolved (a thread whose root message is gone).
   */
  conversationId: string | null;
  /** The file name it was posted with. */
  name: string;
  mime: string;
  /** Its size in bytes. */
  size: number;
}

/** An attachment's bytes, to copy into the app's own storage, and what it is. */
export interface AttachmentForSave extends AttachmentSource {
  /** The bytes (`size` of them); the caller reads it to the end or destroys it. */
  stream: Readable;
}

/** Core's attachment storage isn't configured on this Server: the bytes can't be read at all. */
export class AttachmentStorageUnavailableError extends Error {
  constructor() {
    super("attachment storage is not configured");
    this.name = "AttachmentStorageUnavailableError";
  }
}

async function readableContext(viewer: ViewActor, attachmentId: string, window?: HistoryWindow): Promise<AttachmentAuthorityContext | null> {
  // attachments.id is a uuid: anything else names no attachment (and must not reach the query).
  if (!UUID_RE.test(attachmentId)) return null;
  // An assistant acting for its owner (RFC 080 `delegated`) has no attachment principal of its own yet: it reads none.
  let principal: { type: "user" | "agent"; id: string };
  switch (viewer.type) {
    case "user":
    case "agent":
      principal = { type: viewer.type, id: viewer.id };
      break;
    case "delegated":
      return null;
    default:
      return assertNeverViewActor(viewer);
  }
  const context = await resolveReadableAttachmentAuthorityContext({
    projectionId: attachmentId,
    requestServerId: viewer.serverId,
    principal,
  });
  if (!context) return null;
  // After the authority, as the attachment routes: nothing is said about a file the viewer may not see.
  const behind = await isAttachmentBehindWindow(
    { messageId: context.projection.messageId, messageCreatedAt: context.canonicalMessage.createdAt },
    window ?? await getServerHistoryWindowForRead(viewer.serverId),
  );
  return behind ? null : context;
}

/** The top-level conversation of the attachment's host channel (channelService resolveThreadParent for a thread). */
async function topLevelConversationOf(channel: AttachmentAuthorityContext["localHostChannel"]): Promise<string | null> {
  if (channel.type === "task") return channel.parentChannelId ?? null;
  if (!isSubConversationType(channel.type)) return channel.id;
  return (await resolveThreadParent(channel))?.parentChannelId ?? null;
}

const sourceOf = async (context: AttachmentAuthorityContext): Promise<AttachmentSource> => ({
  attachmentId: context.projection.id,
  messageId: context.projection.messageId,
  channelId: context.localHostChannel.id,
  conversationId: await topLevelConversationOf(context.localHostChannel),
  name: context.projection.filename,
  mime: context.object.mimeType,
  size: context.object.sizeBytes,
});

/**
 * Where an attachment was posted and what it is, when the viewer can see that
 * message's conversation (null otherwise, or when there is no such live
 * attachment). Reads no bytes.
 */
export async function attachmentSource(viewer: ViewActor, attachmentId: string): Promise<AttachmentSource | null> {
  const context = await readableContext(viewer, attachmentId);
  return context ? await sourceOf(context) : null;
}

/** How many attachments attachmentSources resolves at once (each is several queries). */
const ATTACHMENT_SOURCES_CONCURRENCY = 4;

/**
 * attachmentSource for each of `attachmentIds`, in order (the history window
 * read once for all of them).
 */
export async function attachmentSources(viewer: ViewActor, attachmentIds: readonly string[]): Promise<Array<AttachmentSource | null>> {
  if (attachmentIds.length === 0) return [];
  const window = await getServerHistoryWindowForRead(viewer.serverId);
  return mapWithConcurrency(attachmentIds, ATTACHMENT_SOURCES_CONCURRENCY, async (attachmentId) => {
    const context = await readableContext(viewer, attachmentId, window);
    return context ? await sourceOf(context) : null;
  });
}

/**
 * An attachment's bytes for the viewer to save a copy of, after the same
 * check as attachmentSource: null when the viewer can't see the message's
 * conversation, there is no such live attachment, or its bytes are gone from
 * storage. Throws AttachmentStorageUnavailableError when core's attachment
 * storage isn't configured.
 */
export async function readAttachmentForSave(viewer: ViewActor, attachmentId: string): Promise<AttachmentForSave | null> {
  const context = await readableContext(viewer, attachmentId);
  if (!context) return null;
  const storage = getStorage();
  if (!storage) throw new AttachmentStorageUnavailableError();
  let stream: Readable;
  try {
    stream = await storage.get(context.object.storageKey);
  } catch (error) {
    if (isStorageNotFoundError(error)) return null;
    throw error;
  }
  return {
    ...(await sourceOf(context)),
    stream,
  };
}
