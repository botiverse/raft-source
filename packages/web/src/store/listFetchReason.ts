import { INBOX_REFRESH_COALESCED_HEADER, INBOX_REFRESH_TRIGGER_HEADER } from "@botiverse/raft-shared";
import type { InboxRefreshTrigger } from "@botiverse/raft-shared";
import { CHANNEL_DETAIL_REASON_HEADER } from "./channelDetailReason";

/**
 * Why the web read a whole Activity list (`GET /api/channels/inbox`, the
 * followed-thread list), sent as `X-Raft-Fetch-Reason` so the server span can
 * count which whole-list reads incremental sync has replaced (AndyLok, Activity
 * multi-device spec §6, #proj-mobile:e65dc7a2). The server records exactly
 * these values; anything else becomes `other`, no header `unknown`.
 */
export type ListFetchReason =
  /** First load: app start, opening Activity, switching server. */
  | "initial"
  /** After the socket reconnected, without a sync cursor. */
  | "reconnect"
  /** The tab became visible or focused again. */
  | "visibility"
  /** The sync stream asked for a full snapshot (reset, new cursor). */
  | "sync_reset"
  /** A realtime event could not be applied in place (throttled re-read). */
  | "realtime_fallback"
  /** The person asked for it: an action, a filter, a double click. */
  | "manual"
  /** A sync change without the row's state (older server). */
  | "legacy_no_fields"
  /** A sync change with the row's state that the web could not patch in place. */
  | "sync_unpatchable";

/**
 * The realtime event behind a throttled background re-read (#triage:#229): the
 * FIRST trigger folded into it and how many requests it stands for (>= 1).
 */
export type InboxRefreshTriggerCount = { trigger: InboxRefreshTrigger; coalesced: number };

/** Fold `next` into `first`: the first trigger stays, the counts add up. Never mutates either. */
export function foldInboxRefreshTrigger(
  first: InboxRefreshTriggerCount | undefined,
  next: InboxRefreshTriggerCount | undefined,
): InboxRefreshTriggerCount | undefined {
  if (!first || !next) return first ?? next;
  return { trigger: first.trigger, coalesced: first.coalesced + next.coalesced };
}

export function listFetchReasonHeaders(
  reason: ListFetchReason | undefined,
  trigger?: InboxRefreshTriggerCount,
): Record<string, string> | undefined {
  const headers: Record<string, string> = {};
  if (reason) headers[CHANNEL_DETAIL_REASON_HEADER] = reason;
  // The trigger names what asked for a realtime_fallback read; a read whose
  // final reason is another (a folded sync reset came last) carries none.
  if (trigger && reason === "realtime_fallback") {
    headers[INBOX_REFRESH_TRIGGER_HEADER] = trigger.trigger;
    headers[INBOX_REFRESH_COALESCED_HEADER] = String(trigger.coalesced);
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}
