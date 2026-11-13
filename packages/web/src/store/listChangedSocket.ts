// The server's list-changed pings (shared listChangedEvents.ts): `{ serverId }`
// only. Each becomes the window event its list's hook already listens to, so
// the hook reads its list again, behind its own gate (an App manager, an
// owner or admin, the pro_seat_add flag): a member who can't read a list asks
// nothing. A burst for one list and server is coalesced into one read. A
// reconnect asks each list once, since pings sent while away are lost. While
// the page is hidden a hook reads nothing: it reads once when the page shows
// (visiblePoll.ts createVisiblePoll).
//
// A flag that gates what the server lists (pro_seat_add for seat notices,
// app_prompt_text_consent for the Apps review) is changed by Feature Flag
// Admin straight in Postgres, so no server writer pings; its
// `server:features-changed` notice (keys as a hint) asks the gated list once.
//
// These, the mount read and the hooks' 5-minute safety poll while visible are
// all the reads: there is no minute timer.
import {
  APP_PROMPT_TEXT_CONSENT_FEATURE_FLAG_KEY,
  JOINT_INVITES_CHANGED_EVENT,
  LIST_CHANGED_EVENTS,
  PERMISSION_UPDATES_CHANGED_EVENT,
  PRO_SEAT_ADD_FEATURE_FLAG_KEY,
  SEAT_JOIN_BLOCKS_CHANGED_EVENT,
  SERVER_FEATURES_CHANGED_SOCKET_EVENT,
} from "@botiverse/raft-shared";
import type { ListChangedEvent, ListChangedEventName, ServerFeaturesChangedEvent } from "@botiverse/raft-shared";
import { notifyAppPermissionUpdatesChanged } from "../components/layout/useAppPermissionUpdates";
import { notifyPendingJointInvitesChanged } from "../components/layout/usePendingJointInvites";
import { notifySeatJoinBlocksChanged } from "../components/layout/useSeatJoinBlocks";
import { createCoalescedRefresh } from "../utils/coalescedRefresh";
import type { CoalescedRefresh } from "../utils/coalescedRefresh";
import type { SocketBinding } from "./socketBridge";

/** Pings for one list and server inside this window make one read. */
export const LIST_CHANGED_COALESCE_MS = 100;

const NOTIFY: Record<ListChangedEventName, (serverId: string) => void> = {
  [PERMISSION_UPDATES_CHANGED_EVENT]: notifyAppPermissionUpdatesChanged,
  [JOINT_INVITES_CHANGED_EVENT]: notifyPendingJointInvitesChanged,
  [SEAT_JOIN_BLOCKS_CHANGED_EVENT]: notifySeatJoinBlocksChanged,
};

/** Flags whose value changes what a list's server read returns. */
const LIST_GATING_FLAGS: ReadonlyArray<readonly [flagKey: string, event: ListChangedEventName]> = [
  [PRO_SEAT_ADD_FEATURE_FLAG_KEY, SEAT_JOIN_BLOCKS_CHANGED_EVENT],
  [APP_PROMPT_TEXT_CONSENT_FEATURE_FLAG_KEY, PERMISSION_UPDATES_CHANGED_EVENT],
];

const refreshes = new Map<string, CoalescedRefresh>();

function requestListRead(event: ListChangedEventName, serverId: string): void {
  const key = `${event}|${serverId}`;
  let refresh = refreshes.get(key);
  if (!refresh) {
    refresh = createCoalescedRefresh({
      run: () => NOTIFY[event](serverId),
      delayMs: LIST_CHANGED_COALESCE_MS,
      // Not deferred here: each hook decides when it reads.
      isVisible: () => true,
    });
    refreshes.set(key, refresh);
  }
  refresh.request();
}

/**
 * The socket bindings: each ping asks its list's hook to read again, and a
 * flag change naming a gating flag asks the list it gates.
 */
export function listChangedSocketBindings(): Array<SocketBinding & { event: ListChangedEventName | typeof SERVER_FEATURES_CHANGED_SOCKET_EVENT }> {
  return [
    ...LIST_CHANGED_EVENTS.map((event) => ({
      event,
      handler: (payload: Partial<ListChangedEvent> | undefined) => {
        if (typeof payload?.serverId === "string" && payload.serverId) requestListRead(event, payload.serverId);
      },
    })),
    {
      event: SERVER_FEATURES_CHANGED_SOCKET_EVENT,
      handler: (payload: Partial<ServerFeaturesChangedEvent> | undefined) => {
        const serverId = payload?.serverId;
        const keys = Array.isArray(payload?.keys) ? payload.keys : [];
        if (typeof serverId !== "string" || !serverId) return;
        for (const [flagKey, event] of LIST_GATING_FLAGS) {
          if (keys.includes(flagKey)) requestListRead(event, serverId);
        }
      },
    },
  ];
}

/** After a reconnect's rooms:joined: each list of this server, once. */
export function requestListsAfterReconnect(serverId: string | null | undefined): void {
  if (!serverId) return;
  for (const event of LIST_CHANGED_EVENTS) requestListRead(event, serverId);
}

/** Test seam: drop scheduled reads. */
export function __cancelListChangedReadsForTests(): void {
  for (const refresh of refreshes.values()) refresh.cancel();
  refreshes.clear();
}
