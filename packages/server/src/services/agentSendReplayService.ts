import { and, eq } from "drizzle-orm";
import { getDb, type Database, type DatabaseExecutor } from "../db/index.js";
import { attachments, messages } from "../db/schema.js";
import { buildSearchText } from "./searchService.js";
import { getThumbnailUrl, normalizeAttachmentFilename, resolveAttachmentMimeType } from "../routes/attachments.js";
import { linkAttachmentsToMessageWithExecutor } from "./attachmentLinkingService.js";

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

let dbOverride: (() => Database) | null = null;

function resolveDb(): Database {
  return dbOverride ? dbOverride() : getDb();
}

function toLinkedAttachment(
  attachment: typeof attachments.$inferSelect,
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
}): Promise<Omit<ReplayableAgentSendResult<TInserted>, "insertedTransactionResult"> & {
  insertedTransactionResult: TInserted | null;
}> {
  const { channelId, senderId, content, agentSendKey, attachmentIds = [] } = opts;
  const db = resolveDb();

  return db.transaction(async (tx) => {
    if (opts.beforeInsert) await opts.beforeInsert(tx);
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

    const linkedAttachments = await linkAttachmentsToMessageWithExecutor(
      tx,
      attachmentIds,
      replayedMessage.id,
      senderId,
      "replay",
    );
    const transactionData = await opts.onReplay?.(tx, replayedMessage);
    return {
      replayed: true,
      message: replayedMessage,
      attachments: linkedAttachments.map(toLinkedAttachment),
      transactionData,
      insertedTransactionResult: null,
    };
  });
}

export function __setAgentSendReplayDbForTests(factory: () => Database) {
  dbOverride = factory;
}

export function __resetAgentSendReplayDbForTests() {
  dbOverride = null;
}
