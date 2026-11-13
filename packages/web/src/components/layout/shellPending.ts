import { createContext, useContext } from "react";
import type { Server } from "../../store/serverStore";

/**
 * True inside the frame of a server that is still being resolved
 * (PendingServerLayout): the frame's own pieces (top bar, rail) draw
 * themselves but ask for no data and change no state, since there is no
 * server to ask about yet, or the current one is the previous server.
 */
export const ShellPendingContext = createContext(false);

export function useShellPending(): boolean {
  return useContext(ShellPendingContext);
}


/**
 * Inside the frame shown offline from the device's tables (OfflineServerLayout,
 * store/offlineSession.ts): the server it shows, which the top bar and the
 * phone's Home bar name instead of a skeleton. Null everywhere else.
 */
export interface ShellOffline {
  server: Server | null;
}

export const ShellOfflineContext = createContext<ShellOffline | null>(null);

export function useShellOffline(): ShellOffline | null {
  return useContext(ShellOfflineContext);
}
