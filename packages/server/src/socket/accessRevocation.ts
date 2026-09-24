/** A committed authorization change invalidates the user's live subscriptions.
 * The Socket composition root supplies local eviction and acknowledged fanout. */
export type SocketAccessRevocation =
  | { userId: string; familyId?: string }
  /** Every connection attached to the server (scope omitted or "all"), or only
   * its guest connections. */
  | { serverId: string; scope?: "all" | "guests" }
  /** Connections of users who are not members of `channelId`; members keep
   * their subscriptions. `memberUserIds` travels with the revocation so every
   * replica applies the same membership snapshot. */
  | { serverId: string; scope: "non-members"; channelId: string; memberUserIds: readonly string[] };
type RevocationListener = (revocation: SocketAccessRevocation) => Promise<void>;
const listeners = new Set<RevocationListener>();

export function onSocketAccessRevoked(listener: RevocationListener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export async function revokeSocketAccess(revocation: SocketAccessRevocation): Promise<void> {
  await Promise.all([...listeners].map((listener) => listener(revocation)));
}
