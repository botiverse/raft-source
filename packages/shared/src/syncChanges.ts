// GET /api/sync/changes: what changed for one viewer (a human in one server)
// since their cursor, read from the server's change_log (migration
// 0450_change_log.sql). The log records only which entity changed; each
// upsert carries the entity rebuilt now for this viewer, the same JSON the
// list endpoint of its snapshot returns (SYNC_SNAPSHOT_ENDPOINTS).
//
// Client loop:
//   1. No cursor yet: GET /api/sync/changes (no `since`) returns the current
//      cursor and no changes. Take the snapshots, then pull from that cursor.
//      Changes that the snapshots already contain may come again; apply every
//      change as an upsert/delete by (entity, id), so a duplicate is harmless.
//   2. GET /api/sync/changes?since=<cursor>: apply `changes` in order, store
//      `cursor`; while `hasMore`, call again at once with the new cursor.
//   3. `reset` set: drop the cursor's state, take `reset.snapshots`, continue
//      from the returned cursor (`changes` is empty).
//
// Pull failures (web syncChangesClient.ts and the mobile app follow this, so a
// deploy rollout does not send every open client into a full reload at once):
//   - Transient: no response (network error, the client's own timeout), 5xx,
//     408, 429. The cursor may still be good: keep it, reload nothing.
//   - Anything else drops the cursor at once: 400 `invalid_cursor` (and other
//     400s), 401, 403, any other 4xx, a malformed response (no `cursor`).
//   - The second transient failure in a row on the same cursor drops it. The
//     count lives with the cursor and resets on a success or a new cursor.
//   - After a kept failure, pull once more 30–60 s later (random jitter),
//     unless another pull starts first. Never retry at once, never loop: that
//     pull either succeeds or is the second failure.
//   - A dropped cursor means: take a new cursor and every snapshot (step 1),
//     spread over time as for a reconnect.
//   - Store the cursor only once the whole pull (every `hasMore` page)
//     succeeded; a failure on a later page pulls again from the first cursor.
//
// Compatibility: an unknown `entity` is skipped; a known entity with an
// unknown `op` means "resnapshot that entity" (its SyncSnapshotName). New
// entities and ops are added, never renamed.

/** Opaque position in the change log. Echo it back unchanged; never parse or compare it. */
export type SyncChangesCursor = string & { readonly __brand: "SyncChangesCursor" };

/**
 * A snapshot the client (re)takes, and the existing endpoint that serves it.
 * `channels` is both lists: a channel change can be a DM (type "dm"). A
 * snapshot whose endpoint refuses this viewer (machines without the
 * `viewMachines` capability, server_members for a guest) is left out of their
 * reset and scope snapshot lists, and that entity's changes (upserts and
 * deletes) are never delivered to them.
 */
export const SYNC_SNAPSHOT_ENDPOINTS = {
  channels: ["GET /api/channels", "GET /api/channels/dm"],
  channel_members: ["GET /api/channels/:id/members"],
  server_members: ["GET /api/servers/:id/members"],
  agents: ["GET /api/agents"],
  inbox: ["GET /api/channels/inbox"],
  unread: ["GET /api/channels/unread"],
  followed_threads: ["GET /api/channels/threads/followed"],
  machines: ["GET /api/servers/:id/machines"],
  sidebar_order: ["GET /api/servers/:id/sidebar-order"],
  server_order: ["GET /api/servers/order"],
} as const satisfies Record<string, readonly string[]>;

export type SyncSnapshotName = keyof typeof SYNC_SNAPSHOT_ENDPOINTS;

export const SYNC_SNAPSHOT_NAMES = Object.keys(SYNC_SNAPSHOT_ENDPOINTS) as SyncSnapshotName[];

/** What a channel scope added or removed invalidates (that channel's rows). */
export const SYNC_CHANNEL_SCOPE_SNAPSHOTS = ["channels", "channel_members", "inbox", "unread"] as const satisfies readonly SyncSnapshotName[];

/**
 * Entities whose upsert carries a row:
 * - channel: a GET /api/channels item, or a GET /api/channels/dm item for a
 *   DM. `delete` = the channel is no longer in either list for this viewer
 *   (deleted, archived, or no longer visible).
 * - channel_member: id `<channelId>:user:<userId>` or `<channelId>:agent:<agentId>`;
 *   the row is that member's item in `humans` / `agents` of
 *   GET /api/channels/:channelId/members. `delete` = not in that roster for
 *   this viewer.
 * - server_member: id = user id; a GET /api/servers/:id/members item.
 * - agent: id = agent id; a GET /api/agents item.
 * - machine: id = machine id; an item of `machines` in
 *   GET /api/servers/:id/machines. Only for viewers holding `viewMachines`.
 * - sidebar_order: id = server id; the GET /api/servers/:id/sidebar-order body.
 * - server_order: id = the viewer's user id; the GET /api/servers/order body.
 * - message (RFC 082 §4.4): id = message id; the message as the viewer's
 *   message list of its conversation (GET /api/messages/channel/:channelId)
 *   holds it, its `channelId` the viewer's own conversation. Sent when a
 *   message the client may already hold changed in place (a card message's
 *   update, a Slack-bridged edit): replace that message in the store by id;
 *   a message the store does not hold needs nothing. Upserts only, and only
 *   to viewers who can read the message; it has no snapshot (a known op this
 *   client doesn't handle: refresh the open conversation's messages).
 *
 * server_member, agent and machine are server-wide: a change to a row this
 * viewer's list does not show them is not sent at all (no delete either), and
 * a `delete` only names an entity they could be shown.
 */
export type SyncRowEntity = "channel" | "channel_member" | "server_member" | "agent" | "machine" | "sidebar_order" | "server_order" | "message";

export type SyncEntity = SyncRowEntity | "conversation" | "scope";

/**
 * The row type per entity. The rows are the list endpoints' items, which
 * have no shared type yet: a client passes its own item types,
 * e.g. `SyncChange<{ channel: Channel | DMChannel; ... }>`.
 */
export type SyncRowTypes = Record<SyncRowEntity, object>;

export type SyncRowChange<Rows extends SyncRowTypes = SyncRowTypes> = {
  [E in SyncRowEntity]:
    | { seq: number; entity: E; id: string; op: "upsert"; row: Rows[E] }
    | { seq: number; entity: E; id: string; op: "delete" };
}[SyncRowEntity];

/**
 * The viewer's own state of a conversation (read position, inbox done,
 * thread follow / done) changed: refresh it from the inbox, unread and
 * followed-thread snapshots. `refSeq` = the read position it moved to, when
 * the change was one (a larger refSeq is the newer read state); null otherwise.
 *
 * Per-kind current state (additive): one sub-object for each kind of change
 * this page saw for the conversation (several kinds in one page: all of them),
 * holding that state as it is when the page is built, not as of the change.
 * A kind whose state row no longer exists is left out: refresh the row (e.g.
 * GET /api/channels/inbox?ids=<id>) instead.
 * - read: the read cursor; readSeq / readStateVersion as an inbox row's
 *   maxReadSeq / readStateVersion, markedUnread as its readState's.
 * - done: the channel / DM inbox state; doneFrontierSeq as the inbox row's
 *   (see SyncConversationDoneState for how to apply it to a list row).
 * - follow: the viewer's follow of a thread or task conversation; `threadDone`
 *   = that thread marked done.
 */
export type SyncConversationChange = {
  seq: number;
  entity: "conversation";
  id: string;
  op: "stale";
  refSeq: number | null;
  read?: SyncConversationReadState;
  done?: SyncConversationDoneState;
  follow?: SyncConversationFollowState;
};

export type SyncConversationReadState = {
  readSeq: number;
  readStateVersion: number;
  /** Manually marked unread with nothing countable (see InboxScopeReadFrontier); present only when true. */
  markedUnread?: true;
};
/**
 * The viewer's channel / DM inbox Done state. `doneFrontierSeq` (a decimal
 * string, or null) is the conversation's latest message seq in its storage
 * channel, read when the page is built.
 *
 * Do not compare against a list row's doneFrontierSeq: the serving paths
 * fill it differently (PG from the read-state authority query, RisingWave by
 * copying the row's latestActivitySeq). To decide whether a done applies to a
 * row, compare
 * done.doneFrontierSeq with the row's latestActivitySeq (as numbers):
 * row.latestActivitySeq <= doneFrontierSeq → done covers the row; greater →
 * newer activity, keep it; either missing → refresh the row with ?ids=.
 */
export type SyncConversationDoneState = { done: boolean; doneFrontierSeq: string | null };
export type SyncConversationFollowState = { followed: boolean; threadDone: boolean };

/**
 * The viewer gained (`added`) or lost (`removed`) a channel or a server: take
 * `snapshots` for it (added), or drop everything held under it (removed).
 * `id` = the channel id (scopeKind channel) or the server id (scopeKind server).
 */
export type SyncScopeChange = {
  seq: number;
  entity: "scope";
  id: string;
  op: "added" | "removed";
  scopeKind: "channel" | "server";
  snapshots: SyncSnapshotName[];
};

export type SyncChange<Rows extends SyncRowTypes = SyncRowTypes> = SyncRowChange<Rows> | SyncConversationChange | SyncScopeChange;

/**
 * - too_old: the cursor is older than the change log keeps (7 days).
 * - too_many: more changes than one catch-up should page through.
 * - forced: the server asked every client to resnapshot.
 */
export type SyncResetReason = "too_old" | "too_many" | "forced";

export type SyncChangesResponse<Rows extends SyncRowTypes = SyncRowTypes> = {
  cursor: SyncChangesCursor;
  /** true: call again immediately with `cursor`. */
  hasMore: boolean;
  changes: SyncChange<Rows>[];
  reset: null | { reason: SyncResetReason; snapshots: SyncSnapshotName[] };
};
