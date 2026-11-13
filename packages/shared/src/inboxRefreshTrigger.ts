/**
 * Which realtime event made the web re-read its whole Activity list
 * (`GET /api/channels/inbox` with `X-Raft-Fetch-Reason: realtime_fallback`),
 * so the server span can say which event to apply in place next
 * (#triage:#229). The web sends one of these as `X-Raft-Fetch-Trigger`; the
 * server records exactly these values, anything else as `other`, no header as
 * `unknown`. Enum values only. Sent only when the read's final reason is
 * `realtime_fallback`.
 *
 * The web throttles these reads to one per window: the read that is sent
 * carries the trigger of the FIRST request folded into it, and
 * `X-Raft-Fetch-Coalesced` the number of requests it stands for (1 = itself).
 */
export const INBOX_REFRESH_TRIGGERS = [
  /** A new live message (`message:new`) moved a channel, DM or thread row. */
  "message_new",
  /** `message:new` for any message the store already had (e.g. my own send, landed from its HTTP answer first; a repeat delivery). */
  "message_echo",
  /** A thread reply (`thread:updated`) moved a followed-thread row. */
  "thread_reply",
  /** `thread:updated` applied after a thread-replies rebaseline snapshot. */
  "thread_reply_rebaseline",
  /** `activity:changed`: first-party objects changed for this person. */
  "activity_changed",
  /** `dm:new`: a new DM was opened with this person. */
  "dm_new",
  /** Not a socket event: this tab's thread read-all was persisted (threadStore `clearThreadUnread`) while Activity is loaded. */
  "read_persisted",
  /** The list answered still behind the newest live message; re-read (task #86/#92). */
  "catch_up_retry",
  /** Not a socket event: `sync:resume` brought missed messages for a scope with a listed Activity row (#244). */
  "resume_gap",
  /** `thread:updated` whose `replyCount` is more than one past the listed thread row's: replies it never saw (#244). */
  "reply_gap",
  /** Not a socket event: a row's set of live messages counted since its last served answer is full (#244). */
  "counted_cap",
] as const;

export type InboxRefreshTrigger = (typeof INBOX_REFRESH_TRIGGERS)[number];

export const INBOX_REFRESH_TRIGGER_HEADER = "X-Raft-Fetch-Trigger";
export const INBOX_REFRESH_COALESCED_HEADER = "X-Raft-Fetch-Coalesced";
