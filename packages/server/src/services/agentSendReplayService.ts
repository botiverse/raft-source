import { and, eq } from "drizzle-orm";
import { getDb, type Database, type DatabaseExecutor } from "../db/index";
import { attachments, messages } from "../db/schema";
import { buildSearchText } from "./searchTokenizer";
import { getThumbnailUrl, normalizeAttachmentFilename, resolveAttachmentMimeType } from "../routes/attachments";
import { AttachmentLinkError, linkAttachmentsToMessageWithExecutor } from "./attachmentLinkingService";
import type { ResolvedAttachment } from "./attachmentRecord";
import { sameMessageCard } from "./messageCardService";

type LinkedAttachment = {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  thumbnailUrl: string | null;
};

type ReplayableAgentSendResult<TransactionData = unknown> = {
  replayed: boolean;
  message: typeof messages.$inferSelect;
  attachments: LinkedAttachment[];
  insertedTransactionResult: TransactionData | null;
  transactionData?: TransactionData;
};

export type AgentSendInsertedTransactionInput = {
  executor: DatabaseExecutor;
  message: typeof messages.$inferSelect;
  attachments: LinkedAttachment[];
};

type AgentSendInsertedCallback<T> =
  | ((input: AgentSendInsertedTransactionInput) => Promise<T>)
  | ((executor: DatabaseExecutor, message: typeof messages.$inferSelect) => Promise<T>);

/**
 * An agent send reused an idempotency key for a different payload: the key is
 * already bound to a message with another target or content. Replaying the
 * original would report a message the caller did not ask for as "sent", so
 * the send is refused instead.
 */
export class AgentSendIdempotencyConflictError extends Error {
  readonly status = 409 as const;
  readonly code = "idempotency_key_reused" as const;
  readonly suggestedNextAction = "use a new idempotencyKey for different content";
  readonly mismatch: "target" | "content" | "attachments" | "card";

  constructor(mismatch: "target" | "content" | "attachments" | "card") {
    super(`idempotencyKey was already used for a message with a different ${mismatch}; use a new idempotencyKey for different content`);
    this.name = "AgentSendIdempotencyConflictError";
    this.mismatch = mismatch;
  }
}

let dbOverride: (() => Database) | null = null;

/** The keyed send a race hook sees: who, under which key, and what it would store (a card's metadata, or null). */
type AgentSendRaceScope = { senderId: string; agentSendKey: string; actionMetadata: unknown };
type AgentSendRaceHooks = {
  /** In the send's transaction, before its insert: every check before it passed. */
  beforeInsert?: (send: AgentSendRaceScope) => Promise<void>;
  /** In the transaction of a send whose insert won the key, before it commits. */
  afterInsert?: (send: AgentSendRaceScope) => Promise<void>;
};
let raceHooksForTests: AgentSendRaceHooks = {};

/** Real-PG race tests: hold keyed sends before and after the insert the unique index decides. */
export function __setAgentSendRaceHooksForTests(hooks: AgentSendRaceHooks): void {
  raceHooksForTests = hooks;
}

function resolveDb(): Database {
  return dbOverride ? dbOverride() : getDb();
}

function toLinkedAttachment(
  attachment: ResolvedAttachment,
): LinkedAttachment {
  return {
    id: attachment.id,
    filename: normalizeAttachmentFilename(attachment.filename),
    mimeType: resolveAttachmentMimeType(attachment.filename, attachment.mimeType),
    sizeBytes: attachment.sizeBytes,
    width: attachment.width,
    height: attachment.height,
    thumbnailUrl: getThumbnailUrl(attachment.thumbnailKey),
  };
}

export async function createOrReplayAgentSend<TInserted = never>(opts: {
  channelId: string;
  senderId: string;
  content: string;
  agentSendKey: string;
  attachmentIds?: string[];
  /** Stored on a new message as `action_metadata` (RFC 082: a message card's). */
  actionMetadata?: unknown | null;
  /**
   * Agent-facing sends (`idempotencyKey`): a replay whose target, content,
   * card (RFC 082) or ordered attachment set differs from the committed message is refused with
   * AgentSendIdempotencyConflictError instead of reporting the original as
   * sent. Server-internal producers that key re-runs of mutable templates
   * (e.g. onboarding openers) leave this off and keep replaying the original.
   */
  rejectMismatchedReplay?: boolean;
  /**
   * False when `content` is not the sender's: the fallback Raft derived from
   * a message card (RFC 082 §4.1). A replay then compares the card alone, as
   * the derived content follows from it and a Server deployed between the two
   * attempts may derive it differently. Default true.
   */
  senderWroteContent?: boolean;
  /**
   * Runs at the start of the transaction, before the source insert attempts to
   * allocate messages.seq. Outbound admission uses it to serialize eligible
   * canonical conversations without moving replay lookup outside the same
   * transaction.
   */
  beforeInsert?: (executor: DatabaseExecutor) => Promise<void>;
  /**
   * Runs only for the winning insert and before its transaction commits.
   * Callers use this to persist message-derived facts/outbox work on the same
   * executor. A rejection rolls the message and attachment links back too.
   */
  onInserted?: AgentSendInsertedCallback<TInserted>;
  onReplay?: (executor: DatabaseExecutor, message: typeof messages.$inferSelect) => Promise<TInserted>;
}, executor?: DatabaseExecutor): Promise<Omit<ReplayableAgentSendResult<TInserted>, "insertedTransactionResult"> & {
  insertedTransactionResult: TInserted | null;
}> {
  const { channelId, senderId, content, agentSendKey, attachmentIds = [] } = opts;
  const run = async (tx: DatabaseExecutor): Promise<ReplayableAgentSendResult<TInserted>> => {

    if (opts.beforeInsert) await opts.beforeInsert(tx);
    const raceScope = { senderId, agentSendKey, actionMetadata: opts.actionMetadata ?? null };
    await raceHooksForTests.beforeInsert?.(raceScope);
    const [insertedMessage] = await tx
      .insert(messages)
      .values({
        channelId,
        senderType: "agent",
        senderId,
        agentSendKey,
        content,
        messageType: "chat",
        searchText: buildSearchText(content),
        actionMetadata: opts.actionMetadata ?? null,
      })
      .onConflictDoNothing()
      .returning();

    if (insertedMessage) {
      const linkedAttachments = await linkAttachmentsToMessageWithExecutor(
        tx,
        attachmentIds,
        insertedMessage.id,
        senderId,
      );
      const projectedAttachments = linkedAttachments.map(toLinkedAttachment);
      const insertedTransactionResult = opts.onInserted
        ? await (opts.onInserted.length >= 2
          ? (opts.onInserted as (executor: DatabaseExecutor, message: typeof messages.$inferSelect) => Promise<TInserted>)(tx, insertedMessage)
          : (opts.onInserted as (input: AgentSendInsertedTransactionInput) => Promise<TInserted>)({ executor: tx, message: insertedMessage, attachments: projectedAttachments }))
        : null;
      await raceHooksForTests.afterInsert?.(raceScope);

      return {
        replayed: false,
        message: insertedMessage,
        attachments: projectedAttachments,
        insertedTransactionResult,
        transactionData: insertedTransactionResult ?? undefined,
      };
    }

    const [replayedMessage] = await tx
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.senderType, "agent"),
          eq(messages.senderId, senderId),
          eq(messages.agentSendKey, agentSendKey),
        ),
      )
      .limit(1);

    if (!replayedMessage) {
      throw new Error("Agent send replay lookup failed after idempotency conflict");
    }
    // A replay must be the same send: same target, content and (below) the
    // same ordered attachment set. Compared on what the sender sent, never on
    // what Raft generated: a card's derived fallback is not compared (RFC 082 §4.1).
    if (opts.rejectMismatchedReplay) {
      if (replayedMessage.channelId !== channelId) {
        throw new AgentSendIdempotencyConflictError("target");
      }
      if (opts.senderWroteContent !== false && replayedMessage.content !== content) {
        throw new AgentSendIdempotencyConflictError("content");
      }
      // RFC 082: the same key with another card (or a card where there was none) is another send.
      if (!sameMessageCard(replayedMessage.actionMetadata, opts.actionMetadata)) {
        throw new AgentSendIdempotencyConflictError("card");
      }
    }

    const linkedAttachments = await linkAttachmentsToMessageWithExecutor(
      tx,
      attachmentIds,
      replayedMessage.id,
      senderId,
      "replay",
    ).catch((error: unknown) => {
      if (opts.rejectMismatchedReplay && error instanceof AttachmentLinkError && error.code === "attachment_replay_conflict") {
        throw new AgentSendIdempotencyConflictError("attachments");
      }
      throw error;
    });
    const transactionData = await opts.onReplay?.(tx, replayedMessage);
    return {
      replayed: true,
      message: replayedMessage,
      attachments: linkedAttachments.map(toLinkedAttachment),
      transactionData,
      insertedTransactionResult: null,
    };
  };
  if (executor) return run(executor);
  return resolveDb().transaction(run);
}

export function __setAgentSendReplayDbForTests(factory: () => Database) {
  dbOverride = factory;
}

export function __resetAgentSendReplayDbForTests() {
  dbOverride = null;
}

export function __hasAgentSendReplayDbOverrideForTests(): boolean {
  return dbOverride !== null;
}
