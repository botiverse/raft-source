import type { IntlShape } from "react-intl";

// RFC 077: a message a person's assistant sent for them ("sent by Friday").
//
// The server puts `delegatedBy: { id, name, displayName, avatarUrl, deleted } | null`
// and `deletedAt` (ISO time the owner retracted it, else null) on every message
// row. `delegatedBy` / `delegatedByAgentId` are still outside the canonical
// message manifest (shared `CANONICAL_MESSAGE_EXCLUSIONS.emittedUnconsumed`), so
// they are not part of the web `Message` surface: this module is the one
// projection-layer reader for them. `deletedAt` is a canonical optionalAggregate
// field since manifest v7 and is typed on `Message`. All three are one-way in
// the store: `mergeIncomingMessage` / `keepDelegationFacts` never let a later
// null or absent value clear a known one.
//
// Search results and Activity rows carry the same object, optional, on their
// own payloads; `delegatedByOf` reads any of them.

/** The wire shape (server `DelegatedByLabel`), as message rows, search hits and Activity rows carry it. */
export type DelegatedByWire = {
  id: string;
  name: string;
  displayName?: string | null;
  avatarUrl: string | null;
  deleted: boolean;
};

export type DelegatedBy = {
  /** The assistant's agent id. */
  id: string;
  /** The assistant's display name (falls back to its handle). */
  name: string;
  avatarUrl: string | null;
  /** The assistant has been deleted: "sent by a deleted assistant". */
  deleted: boolean;
};

function readDelegatedBy(value: unknown): DelegatedBy | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as { id?: unknown; name?: unknown; displayName?: unknown; avatarUrl?: unknown; deleted?: unknown };
  if (typeof raw.id !== "string" || raw.id.length === 0) return null;
  const displayName = typeof raw.displayName === "string" && raw.displayName.trim() ? raw.displayName : null;
  const name = displayName ?? (typeof raw.name === "string" ? raw.name : "");
  return {
    id: raw.id,
    name,
    avatarUrl: typeof raw.avatarUrl === "string" ? raw.avatarUrl : null,
    // No name left to show reads as deleted too, so the words never go blank.
    deleted: raw.deleted === true || name.length === 0,
  };
}

/** The assistant that sent this message (or search hit) for its sender, or null. */
export function delegatedByOf(source: object | null | undefined): DelegatedBy | null {
  if (!source) return null;
  return readDelegatedBy((source as { delegatedBy?: unknown }).delegatedBy);
}

/**
 * The owner retracted this message their assistant sent: the server keeps the
 * row with a fixed English placeholder as its content and sets `deletedAt`.
 * Only delegated messages can be retracted today, so `deletedAt` alone is the
 * signal; the row's own content is not shown.
 */
export function isRetractedMessage(source: { deletedAt?: string | null } | null | undefined): boolean {
  if (!source) return false;
  // The server sends null when the message is not retracted.
  const deletedAt = source.deletedAt;
  return typeof deletedAt === "string" && deletedAt.length > 0;
}

/** Grouping key: a delegated message never continues the sender's own run. */
export function delegatedGroupKey(source: object | null | undefined): string {
  return delegatedByOf(source)?.id ?? "";
}

type FormatMessage = IntlShape["formatMessage"];

/**
 * A one-line preview's sender (an Activity row, a search hit): "Alice (sent
 * by Friday)". No face there; the words sit next to the name (DS Identity and
 * presence › Sent by an assistant).
 */
export function formatDelegatedSender(formatMessage: FormatMessage, sender: string, delegatedBy: DelegatedBy | null): string {
  if (!delegatedBy) return sender;
  return delegatedBy.deleted
    ? formatMessage({ id: "message.delegated.previewSenderDeleted" }, { sender })
    : formatMessage({ id: "message.delegated.previewSender" }, { sender, name: delegatedBy.name });
}

/**
 * The content the server stores in place of a retracted message
 * (`RETRACTED_DELEGATED_MESSAGE_CONTENT`, packages/server
 * assistantSendAsOwnerService). Only a fallback now: Activity rows carry
 * `latestRetracted` and search hits `retracted` (#10747), thread rows
 * `parentRetracted` (#10749); a server older than those sends none, and then
 * this text is the only sign. Remove this fallback (and its contract test)
 * once no supported server predates #10749.
 */
const SERVER_RETRACTED_CONTENT = "This message was retracted by its sender.";

/** The server's placeholder text, for previews from servers without the flags. */
export function isRetractedPreview(text: string | null | undefined): boolean {
  return typeof text === "string" && text.trim() === SERVER_RETRACTED_CONTENT;
}

/**
 * Whether a one-line preview is of a retracted message: the server's flag
 * when it sent one, else (an older server) its placeholder text.
 */
export function isRetractedPreviewOf(flag: boolean | null | undefined, text: string | null | undefined): boolean {
  return typeof flag === "boolean" ? flag : isRetractedPreview(text);
}
