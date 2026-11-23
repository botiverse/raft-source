import { create } from "zustand";
import api from "../api/client";
import { channelDetailRequestConfig } from "./channelDetailReason";
import type { ChannelDetailReason } from "./channelDetailReason";
import { useServerStore } from "./serverStore";
import { registerServerReset } from "./serverResetRegistry";
import {
  mergePeerReadAdvance,
  mergeReadReceiptHydrate,
  normalizeReadReceiptHydrate,
  normalizeScopeReadUpdated,
} from "./readReceiptDomain";
import type { ReadReceiptScope } from "./readReceiptDomain";

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
    const next = mergeReadReceiptHydrate(state.scopes[scopeId], hydrate);
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
    });
    hydrateInFlight.set(scopeId, request);
    return request;
  },
  clearScope: (scopeId) => set((state) => {
    hydratedAt.delete(scopeId);
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
}));

registerServerReset(() => {
  hydrateInFlight.clear();
  hydratedAt.clear();
  offeredDetail.clear();
  useReadReceiptStore.setState({ scopes: {} });
});
