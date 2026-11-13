// Opened offline (#proj-frontend:#9): the stored session is kept while
// /auth/me can't be reached, but without an answer there is no user, and the
// app sat on "Restoring session…" for as long as the network was gone. When
// the restore fails without reaching the server and the device keeps the
// person's own row (store/localTables `me`, the same person as the stored
// token by construction), the app shows the last session's workspace from the
// local tables instead, marked Offline (OfflineServerLayout).
//
// The person is NOT the auth store's user: every "signed in" side effect
// (loadServers, presence, unread reads, auto-join, the `me` writer putting the
// row back as if the server had sent it) keys on that user, so none of them
// run from here. /auth/me keeps retrying as before; its answer replaces this
// state, and a sign-out or the end of the session ends it.

import { create } from "zustand";
import type { AuthRestoreState } from "../utils/authRestoreMachine";
import type { User } from "./authStore";
import { meTable } from "./localTables";
import { localTableSession } from "./localTables/storeWriters";

/**
 * The person as the device keeps them: a few of the display fields
 * (persistence.ts ME_FIELDS_KEPT), never a full User, so nothing that expects
 * a User can be handed it. The offline frame reads only `id` (the tables' scope).
 */
export type OfflineUser = Pick<User, "id" | "name" | "displayName" | "avatarUrl">;

interface OfflineSessionState {
  user: OfflineUser | null;
}

export const useOfflineSessionStore = create<OfflineSessionState>(() => ({ user: null }));

interface AuthSnapshot {
  user: unknown;
  initialized: boolean;
  restoreState: AuthRestoreState;
  restoreUnreachable: boolean;
}

function waitsUnreachable(state: AuthSnapshot): boolean {
  return state.user === null && state.initialized && state.restoreState === "restoring_auth" && state.restoreUnreachable;
}

function offlineUserOf(row: Partial<User> | undefined, userId: string): OfflineUser | null {
  if (!row || row.id !== userId) return null;
  return {
    id: userId,
    name: typeof row.name === "string" ? row.name : "",
    displayName: row.displayName ?? null,
    avatarUrl: row.avatarUrl ?? null,
  };
}

/**
 * Follows the auth store: enters the offline session once a restore failed
 * unreachable and the device's tables are back (`hydrated`), leaves it on a
 * user, the end of the restore, an answer from the server, or a stored token
 * that names another person.
 * Returns the unsubscribe.
 */
export function startOfflineSession(
  subscribe: (listener: (state: AuthSnapshot) => void) => () => void,
  getState: () => AuthSnapshot,
  hydrated: Promise<void>,
): () => void {
  let stopped = false;
  const enter = () => {
    const userId = localTableSession();
    if (!userId) return;
    const user = offlineUserOf(meTable.list({ userId })[0], userId);
    if (user) useOfflineSessionStore.setState({ user });
  };
  const follow = (state: AuthSnapshot) => {
    const shown = useOfflineSessionStore.getState().user;
    // Left as soon as the restore is no longer waiting on an unreachable
    // server: a user, the end of the session, or an answer (a 5xx: online,
    // so "Offline" would be wrong; "Restoring session…" as before). Also when
    // the stored token now names someone else (setTokens from another tab).
    if (shown && (!waitsUnreachable(state) || shown.id !== localTableSession())) {
      useOfflineSessionStore.setState({ user: null });
    }
    if (!waitsUnreachable(state) || useOfflineSessionStore.getState().user) return;
    void hydrated.then(() => {
      if (stopped || !waitsUnreachable(getState()) || useOfflineSessionStore.getState().user) return;
      enter();
    });
  };
  const unsubscribe = subscribe(follow);
  follow(getState());
  return () => {
    stopped = true;
    unsubscribe();
  };
}
