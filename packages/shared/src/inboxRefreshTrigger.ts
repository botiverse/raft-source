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
  /**
   * The rows below re-read one row, never the list (`GET /api/channels/inbox?ids=`,
   * `X-Raft-Fetch-Reason: position_reread`): the per-row position rule
   * (shared activityRowPosition.ts, inbox redesign step 2, web flag
   * `inbox_row_position_v1`). A batched read carries its first row's trigger.
   */
  /** A live message at or below its row's delivered position that this client had not applied: it may have committed after a higher seq. */
  "ambiguous_seq",
  /** An answer arrived after a commit-order inversion on the row (a live seq lower than one already applied). */
  "row_inversion",
  /** An event for a row without a position (the server could not pair its seq with its latest message). */
  "row_null_position",
  /** A live message the unread predicate cannot judge (a system message without its provenance, no seq). */
  "row_unjudged",
  /** A read below the row's shown position, or of a mention-only row: the read cannot be split here. */
  "row_partial_read",
  /** `thread:updated` said the listed thread row missed replies: that row only. */
  "row_reply_gap",
  /**
   * Not a row read: a row re-read's answer left out a row it asked for (the
   * route lists only rows that still qualify: access lost, archived, Done,
   * unfollowed elsewhere), so the list is re-read (`realtime_fallback`).
   */
  "row_missing",
  /**
   * One live message in 20 applied in place with no re-read: its row is read
   * once after the usual delay (`X-Raft-Fetch-Reason: position_audit`) and the
   * answer judges it (the drift check, scope=row). Tenny's acceptance number.
   */
  "position_audit",
  /**
   * Not an Activity read: a reply came into a followed thread the sidebar's
   * followed-threads list does not hold (`/channels/threads/followed`,
   * `realtime_fallback`). That list holds only threads with unread replies,
   * so a thread read here and dropped from it reloads it (#triage:#389).
   */
  "followed_not_listed",
] as const;

export type InboxRefreshTrigger = (typeof INBOX_REFRESH_TRIGGERS)[number];

export const INBOX_REFRESH_TRIGGER_HEADER = "X-Raft-Fetch-Trigger";
export const INBOX_REFRESH_COALESCED_HEADER = "X-Raft-Fetch-Coalesced";

/**
 * Which read source answered `GET /api/channels/inbox`: `risingwave` (the
 * serving views) or `postgres` (the canonical read: search, guest access,
 * forced). A stale answer from the overload cache says the source of the read
 * it kept. Absent for an answer no conversation read made (an app's object
 * scope, an empty Pinned or Saved). The web copies it unchanged into its drift
 * check (`inbox.inplace.backend`).
 */
export const INBOX_BACKEND_HEADER = "X-Raft-Inbox-Backend";
export const INBOX_BACKENDS = ["risingwave", "postgres"] as const;
export type InboxBackend = (typeof INBOX_BACKENDS)[number];
