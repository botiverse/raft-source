// The server lists the app already loads, written into the local tables
// (#triage:458d78f1) so they reach the device (persistence.ts) before any
// screen reads them. Only complete lists that came from the server:
//
// - `me`: the signed-in person, whenever /auth/me or a profile update sets it
//   (startLocalTableWriters).
// - `servers`: GET /servers, from serverStore.loadServers on success
//   (writeServerList); a failed load writes nothing.
// - `channels`: the current server's GET /channels, from
//   channelStore.loadChannels after its server-epoch check (writeChannelList),
//   so a list never lands in another server's scope. DMs are a separate full
//   list and stay out.
// Rows are the stores' domain types: `readState` and other wire-only fields
// are gone by then (channelDomain.toChannel).

import { accessTokenSubject } from "../../utils/hostAccessTokenSync";
import type { User } from "../authStore";
import type { Channel } from "../channelStore";
import type { Server } from "../serverStore";
import { channelsTable, meTable, serversTable } from "./index";

/**
 * The person the stored session belongs to. A load takes it when its request
 * starts and writes only if it is still the same person when the answer
 * comes, so a list loaded for someone who has since signed out, or been
 * replaced on another tab, never lands in the next person's tables.
 */
export function localTableSession(): string | null {
  try {
    return accessTokenSubject(localStorage.getItem("slock_access_token"));
  } catch {
    return null;
  }
}

export function writeServerList(session: string | null, servers: readonly Server[]): void {
  if (session && session === localTableSession()) serversTable.replaceFromFullList({ userId: session }, servers);
}

export function writeChannelList(session: string | null, serverId: string, channels: readonly Channel[]): void {
  if (session && session === localTableSession()) channelsTable.replaceFromFullList({ userId: session, serverId }, channels);
}

/** `me` follows the auth store; returns the unsubscribe. */
export function startMeWriter(subscribe: (listener: (state: { user: User | null }, previous: { user: User | null }) => void) => () => void): () => void {
  return subscribe((state, previous) => {
    if (state.user && state.user !== previous.user) meTable.replaceFromFullList({ userId: state.user.id }, [state.user]);
  });
}
