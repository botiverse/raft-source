/**
 * Inbox read persistence: the coalesced `read-all` write the inbox and thread
 * stores share. (The rest of the RFC 037 inbox exemplar that lived here, the
 * hydrate/reconcile/patch adapters, was never wired and was removed; the
 * inbox follows RFC 081.)
 */

import type { AxiosResponse } from "axios";
import api from "../../api/client";
import { clearMarkedUnreadForRead } from "../markedUnreadStore";

const readAllInFlight = new Map<string, Promise<AxiosResponse>>();

/** The write identity a `read-all` persists under. The coalesce key MUST carry
 *  this, not just the channel: a module-global map keyed by channel alone
 *  would merge writes across an account/server switch — and across the human vs
 *  agent receiver scopes Gate A introduces — letting a later identity ride the
 *  previous identity's in-flight request/ACK (a cross-principal false success).
 *  `receiver` is optional until the server delegation contract lands; it is
 *  already part of the key so human-self and agent-receiver writes never
 *  coalesce once A2 starts sending it. */
export interface ReadAllWriteIdentity {
  serverId: string | null;
  serverEpoch: number;
  principalId: string | null;
  receiver?: { kind: "human" | "agent"; id: string };
}

/** Persist a channel/thread `read-all`, coalescing concurrent posts that share
 *  the SAME write identity + scope into ONE in-flight network request.
 *
 *  A thread read intent otherwise reaches the server twice: the thread store's
 *  `clearThreadUnread` posts `/channels/:id/read-all`, and the Activity
 *  `markRead` intent posts the same scope again for its ack handling. Both are
 *  the same idempotent write under the same identity, so the second is pure
 *  duplicate traffic (the production HAR showed two concurrent POSTs per
 *  intent). The first caller owns the request; concurrent callers with an
 *  identical identity+scope share its promise — same response on success, same
 *  rejection on failure — and the slot clears on settle so the next intent
 *  posts again. A different principal/server/epoch/receiver gets its own slot. */
export function postReadAllCoalesced(
  channelId: string,
  identity: ReadAllWriteIdentity,
): Promise<AxiosResponse> {
  const key = [
    identity.serverId ?? "",
    identity.serverEpoch,
    identity.principalId ?? "",
    identity.receiver ? `${identity.receiver.kind}:${identity.receiver.id}` : "self",
    channelId,
  ].join("|");
  const existing = readAllInFlight.get(key);
  if (existing) return existing;
  // The person's own read (not an agent receiver's): their mark is read.
  if (!identity.receiver || identity.receiver.kind === "human") clearMarkedUnreadForRead(channelId);
  const promise = api.post(
    `/channels/${channelId}/read-all`,
    identity.receiver ? { receiver: identity.receiver } : undefined,
  );
  readAllInFlight.set(key, promise);
  // Clear the slot when the request settles, via a DETACHED handler rather than
  // `.finally`: wrapping the returned promise would add a microtask and shift
  // callers' `.then` timing relative to the pre-coalescing direct `api.post`
  // (e.g. the persisted-read notification that drives Activity reconcile must
  // fire at the same point it always did). Concurrent same-key callers share
  // this exact promise, so one network request serves them all.
  promise.then(
    () => {
      readAllInFlight.delete(key);
    },
    () => {
      readAllInFlight.delete(key);
    },
  );
  return promise;
}
