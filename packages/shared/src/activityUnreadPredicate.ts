/**
 * #244 (inbox redesign, step 1): does a live message count as unread on its
 * Activity row, for this viewer? One pure rule for web, the app and the
 * server's tests, pinned by the contract cases in
 * `contract-cases/activity-row/` (README there). Nothing calls it yet: web
 * adopts it in step 2.
 *
 * Derived from the rules that serve the count today:
 * - RisingWave `unread_count` (infra/risingwave/sql/075-inbox-cursor-decouple.sql,
 *   rw_inbox_normal_v5 and the muted arms; 070 for followed threads):
 *     NOT (sender = viewer)
 *     AND NOT COALESCE(message_type = 'system' AND causal actor = viewer, FALSE)
 *     AND (system_subtype IS NULL OR system_subtype NOT IN <noise subtypes>)
 *   and a muted conversation counts only messages before the mute
 *   (rw_inbox_muted_prefix_v2: `seq < mute_from_seq`).
 * - Task conversations count chat messages only (rw_task_conversation_unread_v1,
 *   countsTowardTaskConversationUnread on the server).
 * - Web's live patch (packages/web/src/store/inboxInPlaceUnread.ts,
 *   liveActivityUnread / liveUnreadFields): own message, read on arrival, an
 *   unfollowed thread, and the system rule above on thread rows.
 *
 * Where web's live patch differs today (a channel or DM row: a system message
 * the viewer caused, a noise subtype, a muted conversation) this follows the
 * server (Tenny, #14988 review); the cases carry a web `knownGaps` entry until
 * step 2 switches web to this predicate.
 */

/** System subtypes never unread for anyone (the born-read registry's `skip` producers; the chain SQL's literal list). */
export const ACTIVITY_UNCOUNTED_SYSTEM_SUBTYPES: readonly string[] = ["channel.self_unfollow_thread", "task.deleted_summary"];

export type ActivityUnreadViewer = { type: "user" | "agent"; id: string };

/** The message fields the rule reads, as `message:new` carries them. */
export type ActivityUnreadMessage = {
  senderType: string;
  senderId: string;
  messageType?: "chat" | "system" | null;
  causalActorType?: string | null;
  causalActorId?: string | null;
  /**
   * `null`: a message without a subtype. Absent (`undefined`): the event did
   * not carry the system provenance, so a system message cannot be judged.
   */
  systemSubtype?: string | null;
  mentions?: readonly { type: string; id: string }[] | null;
};

/** What the client knows about the row's conversation when the message arrives. */
export type ActivityUnreadScope = {
  rowKind: "channel" | "dm" | "thread" | "task";
  /** Thread and task rows: the viewer follows it. An unfollowed thread row counts nothing. Default true. */
  threadFollowed?: boolean;
  /**
   * Channel and DM rows: the viewer muted the conversation's Activity. A live
   * message is past the mute boundary, so it does not count; a mention of the
   * viewer still lights the row's @.
   */
  activityMuted?: boolean;
  /**
   * The client reads the message as it arrives (the open conversation at its
   * bottom with its read saved, a read already queued past it, or a read hold).
   */
  readOnArrival?: boolean;
};

export type ActivityUnreadVerdict = {
  /** One more unread on the row. `null`: cannot be judged from the event (a system message without its provenance); leave it to a re-read. */
  counts: boolean | null;
  /** It @-mentions the viewer, so the row's @ lights (also when it does not count). */
  mention: boolean;
};

export function activityLiveUnread(
  message: ActivityUnreadMessage,
  viewer: ActivityUnreadViewer,
  scope: ActivityUnreadScope,
): ActivityUnreadVerdict {
  const own = message.senderType === viewer.type && message.senderId === viewer.id;
  if (own || scope.readOnArrival) return { counts: false, mention: false };
  const isThreadRow = scope.rowKind === "thread" || scope.rowKind === "task";
  // An unfollowed thread row: no count and no @, even for a mention of the
  // viewer. Correct only because a mention makes the server follow the thread
  // for them and send the change that makes the client re-read the row; it
  // does not mean mentions in unfollowed threads are dropped.
  if (isThreadRow && scope.threadFollowed === false) return { counts: false, mention: false };
  const mention = (message.mentions ?? []).some((target) => target.type === viewer.type && target.id === viewer.id);
  return { counts: countsForViewer(message, viewer, scope), mention };
}

function countsForViewer(message: ActivityUnreadMessage, viewer: ActivityUnreadViewer, scope: ActivityUnreadScope): boolean | null {
  if (scope.rowKind === "task") return message.messageType == null || message.messageType === "chat";
  if (scope.activityMuted && scope.rowKind !== "thread") return false;
  if (message.messageType !== "system") return true;
  if (message.systemSubtype === undefined) return null;
  if (message.causalActorType === viewer.type && message.causalActorId === viewer.id) return false;
  return message.systemSubtype === null || !ACTIVITY_UNCOUNTED_SYSTEM_SUBTYPES.includes(message.systemSubtype);
}
