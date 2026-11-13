import { INBOX_REFRESH_COALESCED_HEADER, INBOX_REFRESH_TRIGGER_HEADER, INBOX_REFRESH_TRIGGERS } from "@botiverse/raft-shared";
import type { TraceAttributes } from "@botiverse/raft-shared";

/**
 * Observability for `GET /api/channels/:id` (#11312 follow-up): which kind of
 * target was read and why the web asked, so the next optimisation goes where
 * the volume is. Enum values only; never the channel id, name or user.
 */

// Set by the web client on each GET /api/channels/:id (the reason it fetched).
// app.ts cors() sets no allowedHeaders, so it reflects the preflight's
// requested headers (as for X-Raft-Client-Platform); no CORS change needed.
export const CHANNEL_FETCH_REASON_HEADER = "x-raft-fetch-reason";

// Values agreed with the web client (Noel, #proj-deploy:ee85db9e):
// receipts = read state on opening a conversation; summary_changed = forced
// refetch after the read summary changed; ensure = not in the local channel
// list yet (first open, notification, thread window); preload = route
// preload; refresh = a realtime event said the channel changed. Coalesced
// requests carry the reason of the one that started them.
export const CHANNEL_FETCH_REASONS = [
  "receipts",
  "summary_changed",
  "ensure",
  "preload",
  "refresh",
] as const;
export type ChannelFetchReason = (typeof CHANNEL_FETCH_REASONS)[number];

const CHANNEL_TYPES = new Set(["channel", "private", "dm", "thread", "joint", "task"]);

/** `unknown` when the header is absent (older web bundles), `other` when it is not a known reason. */
export function channelFetchReasonAttr(raw: string | string[] | undefined): ChannelFetchReason | "unknown" | "other" {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value === "") return "unknown";
  return (CHANNEL_FETCH_REASONS as readonly string[]).includes(value) ? value as ChannelFetchReason : "other";
}

export function channelGetTargetTraceAttrs(
  channelType: string,
  fetchReasonHeader: string | string[] | undefined,
): TraceAttributes {
  return {
    channel_type: CHANNEL_TYPES.has(channelType) ? channelType : "other",
    fetch_reason: channelFetchReasonAttr(fetchReasonHeader),
  };
}

/**
 * Activity list loads (multi-device sync spec §6, #proj-mobile:e65dc7a2): which list was
 * fetched and why, so whole-list reloads can be told apart from the single-row `?ids=`
 * refreshes that replace them. Values agreed with the web client (Scout); enum only.
 * `inplace_reconcile` is the mobile client's (#triage:#245, behind
 * `mobile_inbox_inplace_v0`): the read that reconciles rows it updated in place.
 */
export const ACTIVITY_LIST_FETCH_REASONS = [
  "initial",
  "reconnect",
  "visibility",
  "sync_reset",
  "realtime_fallback",
  "manual",
  "legacy_no_fields",
  "sync_unpatchable",
  "rw_overload_retry",
  "sync_scope_change",
  "inplace_reconcile",
] as const;
export const ACTIVITY_ROW_FETCH_REASONS = ["follow_change", "read_partial", "rw_lag_retry"] as const;
export type ActivityList = "inbox" | "done" | "unfollowed" | "followed_threads";

function enumReasonAttr(raw: string | string[] | undefined, allowed: readonly string[]): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value === "") return "unknown";
  return allowed.includes(value) ? value : "other";
}

// The route accepts at most 50 ids; anything above is recorded as 51 ("over the limit")
// so a malformed request can't put an arbitrary number on the span.
const IDS_COUNT_CAP = 51;

/** `?ids=` is a comma list; only its size (capped) is recorded, never the ids. */
function idsCount(raw: unknown): number {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string" || value === "") return 0;
  return Math.min(value.split(",").filter((id) => id !== "").length, IDS_COUNT_CAP);
}

export function activityListFetchTraceAttrs(
  list: ActivityList,
  fetchReasonHeader: string | string[] | undefined,
  idsParam?: unknown,
): TraceAttributes {
  const ids = idsCount(idsParam);
  return {
    list,
    fetch_kind: ids > 0 ? "rows" : "list",
    fetch_reason: enumReasonAttr(fetchReasonHeader, ids > 0 ? ACTIVITY_ROW_FETCH_REASONS : ACTIVITY_LIST_FETCH_REASONS),
    ids_count: ids,
  };
}

/**
 * #triage:#229: which realtime event made the web re-read its whole Activity
 * list (`X-Raft-Fetch-Trigger`, values in shared `INBOX_REFRESH_TRIGGERS`) and
 * how many requests its throttle folded into this read
 * (`X-Raft-Fetch-Coalesced`). Same rule as the reason: no header `unknown`,
 * an unlisted value `other`. Enum and a capped count only.
 */
export const INBOX_FETCH_TRIGGER_HEADER = INBOX_REFRESH_TRIGGER_HEADER.toLowerCase();
export const INBOX_FETCH_COALESCED_HEADER = INBOX_REFRESH_COALESCED_HEADER.toLowerCase();

// A window is 2.5 s; anything above this is recorded as the cap, so a
// malformed header can't put an arbitrary number on the span.
export const INBOX_FETCH_COALESCED_CAP = 1000;

/** `0` when absent or not a positive integer (older web bundles, a read no event asked for). */
function coalescedCount(raw: string | string[] | undefined): number {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || !/^[0-9]{1,9}$/.test(value)) return 0;
  return Math.min(Number(value), INBOX_FETCH_COALESCED_CAP);
}

export function inboxFetchTriggerTraceAttrs(
  triggerHeader: string | string[] | undefined,
  coalescedHeader: string | string[] | undefined,
): TraceAttributes {
  return {
    fetch_trigger: enumReasonAttr(triggerHeader, INBOX_REFRESH_TRIGGERS),
    fetch_coalesced: coalescedCount(coalescedHeader),
  };
}
