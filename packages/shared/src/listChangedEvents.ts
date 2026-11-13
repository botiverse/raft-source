/**
 * Socket "changed" pings for lists the web otherwise polls. Each carries only
 * `{ serverId }`: the list of that server changed, read it again if you read
 * it at all (the GET keeps its own authorization). Sent after the change has
 * committed. Additive: a client that doesn't know an event ignores it.
 *
 * - `permission-updates:changed`, to the server's room (`server:<id>`): the
 *   App permission updates waiting there (GET /integrations/permission-updates,
 *   read by App managers) may have changed.
 * - `joint-invites:changed`, to the invitee's sockets on the invited server
 *   (`user:<id>:server:<id>`): their pending joint channel invites there
 *   (GET /channels/joint-invites) may have changed.
 * - `seat-join-blocks:changed`, to the server's room: who a full link turned
 *   away (GET /servers/:id/seat-join-blocks) may have changed.
 */
export const PERMISSION_UPDATES_CHANGED_EVENT = "permission-updates:changed" as const;
export const JOINT_INVITES_CHANGED_EVENT = "joint-invites:changed" as const;
export const SEAT_JOIN_BLOCKS_CHANGED_EVENT = "seat-join-blocks:changed" as const;

export const LIST_CHANGED_EVENTS = [
  PERMISSION_UPDATES_CHANGED_EVENT,
  JOINT_INVITES_CHANGED_EVENT,
  SEAT_JOIN_BLOCKS_CHANGED_EVENT,
] as const;

export type ListChangedEventName = typeof LIST_CHANGED_EVENTS[number];

/** The whole payload of every list-changed event: no list data. */
export interface ListChangedEvent {
  serverId: string;
}
