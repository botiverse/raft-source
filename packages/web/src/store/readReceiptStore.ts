import { create } from "zustand";
import api from "../api/client";
import { channelDetailRequestConfig } from "./channelDetailReason";
import type { ChannelDetailReason } from "./channelDetailReason";
import { useServerStore } from "./serverStore";
import { registerServerReset } from "./serverResetRegistry";
import {
  mergePeerReadAdvance,
  mergeReadProgressPeers,
  mergeReadReceiptHydrate,
  normalizeReadProgressUpdated,
  normalizeReadReceiptHydrate,
  normalizeScopeReadUpdated,
} from "./readReceiptDomain";
import type {
  ReadProgressUpdated,
  ReadReceiptScope,
} from "./readReceiptDomain";

interface ReadReceiptState {
  scopes: Record<string, ReadReceiptScope>;
  /**
   * Load a scope's read state (`GET /channels/:id`). A scope loaded within
   * HYDRATE_FRESH_MS is kept current by scope events and is not fetched again
   * on a re-open; `force` (a summaryChanged event) always fetches. `reason`
   * names a forced load that is not a summary change (the trace header).
   */
  hydrateScope: (scopeId: string, opts?: { force?: boolean; reason?: ChannelDetailReason }) => Promise<void>;
  clearScope: (scopeId: string) => void;
  clearAll: () => void;
  consumeScopeUpdated: (payload: unknown) => void;
  /**
   * `read_progress:updated` (agent_read_progress_v0): agents that read on in
   * a watched conversation. Same rule as consumeScopeUpdated: only a scope the
   * detail hydrated, only its agents, only forward.
   */
  consumeReadProgressUpdated: (payload: unknown) => void;
  /**
   * `thread:followers-updated` or `read_progress:detail_changed` for a scope
   * whose agents' positions are shown: who stopped following or muted it comes
   * with the detail, so load it again. A load still in flight may have read
   * before the change: this one waits for it.
   */
  refreshFollowState: (scopeId: string) => void;
  /**
   * `ensureChannel` just loaded this conversation's detail (the same
   * `GET /channels/:id`): the next read-receipt load takes that answer
   * instead of asking again, if it comes within SHARED_DETAIL_MS.
   */
  offerChannelDetail: (scopeId: string, data: unknown) => void;
  /** After a reconnect scope events may have been missed: the next open loads again. */
  forgetFreshness: () => void;
  /** A scope whose room was left (a closed thread) gets no events: its next open loads again. */
  forgetScopeFreshness: (scopeId: string) => void;
}

const hydrateInFlight = new Map<string, Promise<void>>();
/** When each scope's detail last loaded (successfully, with receipt state). */
const hydratedAt = new Map<string, number>();
/**
 * Re-opening a channel inside this window reuses its loaded state: peer read
 * advances arrive as scope events meanwhile (the client stays in its room). A
 * thread leaves its room when it closes, so it forgets its freshness then. A scope that is gone
 * from the store (cleared, server switch) loads again regardless.
 */
export const HYDRATE_FRESH_MS = 60_000;
/**
 * Opening a conversation the list did not hold loads its row first
 * (`ensureChannel`) and its read receipts right after, from the same endpoint.
 * The receipt load reuses that answer for this long (#proj-deploy:ee85db9e).
 */
export const SHARED_DETAIL_MS = 10_000;
const offeredDetail = new Map<string, { data: unknown; at: number }>();
/**
 * Read-progress frames for a scope whose detail is loading and not in the
 * store yet: the highest position per agent, applied when the detail lands
 * (a frame cannot add a peer, so the detail decides who counts) and dropped
 * if it fails or carries no receipts. A scope already in the store takes
 * frames directly; its reload keeps the higher of both (mergeReadReceiptHydrate).
 */
const pendingProgress = new Map<string, Map<string, number>>();

function bufferProgress(update: ReadProgressUpdated): void {
  const pending = pendingProgress.get(update.scopeId) ?? new Map<string, number>();
  for (const peer of update.peers) {
    pending.set(peer.peerId, Math.max(pending.get(peer.peerId) ?? 0, peer.maxReadSeq));
  }
  pendingProgress.set(update.scopeId, pending);
}

function takePendingProgress(scopeId: string): ReadProgressUpdated | null {
  const pending = pendingProgress.get(scopeId);
  pendingProgress.delete(scopeId);
  if (!pending || pending.size === 0) return null;
  return { scopeId, peers: [...pending].map(([peerId, maxReadSeq]) => ({ peerId, maxReadSeq })) };
}

async function fetchScope(scopeId: string, force: boolean, reason: ChannelDetailReason | undefined, isCurrent: () => boolean): Promise<void> {
  const serverId = useServerStore.getState().current?.id ?? null;
  const epoch = useServerStore.getState().serverEpoch;
  if (!serverId) return;
  const offered = offeredDetail.get(scopeId);
  offeredDetail.delete(scopeId);
  if (!force && offered && Date.now() - offered.at < SHARED_DETAIL_MS) {
    applyScopeDetail(scopeId, offered.data);
    return;
  }
  try {
    const { data } = await api.get(`/channels/${scopeId}`, channelDetailRequestConfig(reason ?? (force ? "summary_changed" : "receipts")));
    if (
      useServerStore.getState().serverEpoch !== epoch
      || useServerStore.getState().current?.id !== serverId
      // Cleared while it loaded (server reset or clearAll): drop the answer.
      || !isCurrent()
    ) return;
    applyScopeDetail(scopeId, data);
  } catch {
    // Detail failure leaves the scope disabled. The message surface remains
    // unchanged and a later mount/summaryChanged event can retry canonical IO.
  }
}

function applyScopeDetail(scopeId: string, data: unknown): void {
  const hydrate = normalizeReadReceiptHydrate(data);
  useReadReceiptStore.setState((state) => {
    if (!hydrate) {
      // No receipts here (a thread under #all): that
      // answer is fresh too, or every re-open would ask again.
      hydratedAt.set(scopeId, Date.now());
      if (!(scopeId in state.scopes)) return state;
      const { [scopeId]: _removed, ...scopes } = state.scopes;
      void _removed;
      return { scopes };
    }
    const merged = mergeReadReceiptHydrate(state.scopes[scopeId], hydrate);
    const pending = takePendingProgress(scopeId);
    const next = pending ? mergeReadProgressPeers(merged, pending) ?? merged : merged;
    hydratedAt.set(scopeId, Date.now());
    return { scopes: { ...state.scopes, [scopeId]: next } };
  });
}

export const useReadReceiptStore = create<ReadReceiptState>((set, get) => ({
  scopes: {},
  hydrateScope: (scopeId, opts) => {
    const existing = hydrateInFlight.get(scopeId);
    if (existing) return existing;
    const loadedAt = hydratedAt.get(scopeId);
    if (!opts?.force && loadedAt !== undefined && Date.now() - loadedAt < HYDRATE_FRESH_MS) {
      return Promise.resolve();
    }
    let request: Promise<void>;
    request = fetchScope(scopeId, !!opts?.force, opts?.reason, () => hydrateInFlight.get(scopeId) === request).finally(() => {
      if (hydrateInFlight.get(scopeId) === request) hydrateInFlight.delete(scopeId);
      // Applied with the detail if it landed; otherwise nothing to apply it to.
      pendingProgress.delete(scopeId);
    });
    hydrateInFlight.set(scopeId, request);
    return request;
  },
  clearScope: (scopeId) => set((state) => {
    hydratedAt.delete(scopeId);
    pendingProgress.delete(scopeId);
    offeredDetail.delete(scopeId);
    if (!(scopeId in state.scopes)) return state;
    const { [scopeId]: _removed, ...scopes } = state.scopes;
    void _removed;
    return { scopes };
  }),
  offerChannelDetail: (scopeId, data) => {
    offeredDetail.set(scopeId, { data, at: Date.now() });
  },
  forgetFreshness: () => {
    hydratedAt.clear();
    offeredDetail.clear();
  },
  forgetScopeFreshness: (scopeId) => {
    hydratedAt.delete(scopeId);
    offeredDetail.delete(scopeId);
  },
  clearAll: () => set((state) => {
    // A load still in flight belongs to the state being cleared: a later
    // hydrate must start its own instead of joining it.
    hydrateInFlight.clear();
    hydratedAt.clear();
    pendingProgress.clear();
    offeredDetail.clear();
    return Object.keys(state.scopes).length === 0 ? state : { scopes: {} };
  }),
  consumeScopeUpdated: (payload) => {
    const update = normalizeScopeReadUpdated(payload);
    if (!update) return;
    const scope = get().scopes[update.scopeId];
    // Hydrate presence is the client-side gate. Never infer identities or
    // enable UI from a socket frame before canonical detail has authorized
    // this scope.
    if (!scope) return;
    if ("summaryChanged" in update) {
      if (scope.kind === "summary") {
        const inFlight = hydrateInFlight.get(update.scopeId);
        if (inFlight) {
          void inFlight.then(() => get().hydrateScope(update.scopeId, { force: true }));
        } else {
          void get().hydrateScope(update.scopeId, { force: true });
        }
      }
      return;
    }
    const next = mergePeerReadAdvance(scope, update);
    if (next === scope) return;
    set((state) => ({ scopes: { ...state.scopes, [update.scopeId]: next! } }));
  },
  consumeReadProgressUpdated: (payload) => {
    const update = normalizeReadProgressUpdated(payload);
    if (!update) return;
    const scope = get().scopes[update.scopeId];
    if (!scope) {
      // Loading its detail now (first open, or the reload after a reconnect):
      // keep the frame for when it lands instead of losing the move.
      if (hydrateInFlight.has(update.scopeId)) bufferProgress(update);
      return;
    }
    const next = mergeReadProgressPeers(scope, update);
    if (next === scope) return;
    set((state) => ({ scopes: { ...state.scopes, [update.scopeId]: next! } }));
  },
  refreshFollowState: (scopeId) => {
    const reload = () => get().hydrateScope(scopeId, { force: true, reason: "refresh" });
    const inFlight = hydrateInFlight.get(scopeId);
    if (inFlight) void inFlight.then(reload);
    else if (get().scopes[scopeId]?.kind === "peers") void reload();
  },
}));

registerServerReset(() => {
  hydrateInFlight.clear();
  pendingProgress.clear();
  hydratedAt.clear();
  offeredDetail.clear();
  useReadReceiptStore.setState({ scopes: {} });
});
