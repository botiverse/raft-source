import { create } from "zustand";
import api from "../api/client";
import { useServerStore } from "./serverStore";
import { registerServerReset } from "./serverResetRegistry";
import {
  mergePeerReadAdvance,
  mergeReadReceiptHydrate,
  normalizeReadReceiptHydrate,
  normalizeScopeReadUpdated,
} from "./readReceiptDomain";
import type {
  ReadReceiptScope,
} from "./readReceiptDomain";

interface ReadReceiptState {
  scopes: Record<string, ReadReceiptScope>;
  hydrateScope: (scopeId: string) => Promise<void>;
  clearScope: (scopeId: string) => void;
  clearAll: () => void;
  consumeScopeUpdated: (payload: unknown) => void;
}

const hydrateInFlight = new Map<string, Promise<void>>();

async function fetchScope(scopeId: string): Promise<void> {
  const serverId = useServerStore.getState().current?.id ?? null;
  const epoch = useServerStore.getState().serverEpoch;
  if (!serverId) return;
  try {
    const { data } = await api.get(`/channels/${scopeId}`);
    if (
      useServerStore.getState().serverEpoch !== epoch
      || useServerStore.getState().current?.id !== serverId
    ) return;
    const hydrate = normalizeReadReceiptHydrate(data);
    useReadReceiptStore.setState((state) => {
      if (!hydrate) {
        if (!(scopeId in state.scopes)) return state;
        const { [scopeId]: _removed, ...scopes } = state.scopes;
        void _removed;
        return { scopes };
      }
      const next = mergeReadReceiptHydrate(state.scopes[scopeId], hydrate);
      return { scopes: { ...state.scopes, [scopeId]: next } };
    });
  } catch {
    // Detail failure leaves the scope disabled. The message surface remains
    // unchanged and a later mount/summaryChanged event can retry canonical IO.
  }
}

export const useReadReceiptStore = create<ReadReceiptState>((set, get) => ({
  scopes: {},
  hydrateScope: (scopeId) => {
    const existing = hydrateInFlight.get(scopeId);
    if (existing) return existing;
    let request: Promise<void>;
    request = fetchScope(scopeId).finally(() => {
      if (hydrateInFlight.get(scopeId) === request) hydrateInFlight.delete(scopeId);
    });
    hydrateInFlight.set(scopeId, request);
    return request;
  },
  clearScope: (scopeId) => set((state) => {
    if (!(scopeId in state.scopes)) return state;
    const { [scopeId]: _removed, ...scopes } = state.scopes;
    void _removed;
    return { scopes };
  }),
  clearAll: () => set((state) => (
    Object.keys(state.scopes).length === 0 ? state : { scopes: {} }
  )),
  consumeScopeUpdated: (payload) => {
    const update = normalizeScopeReadUpdated(payload);
    if (!update) return;
    const scope = get().scopes[update.scopeId];
    // Hydrate presence is the client-side read_receipts_v0 gate. Never infer
    // identities or enable UI from a socket frame before canonical detail has
    // authorized this scope.
    if (!scope) return;
    if ("summaryChanged" in update) {
      if (scope.kind === "summary") {
        const inFlight = hydrateInFlight.get(update.scopeId);
        if (inFlight) {
          void inFlight.then(() => get().hydrateScope(update.scopeId));
        } else {
          void get().hydrateScope(update.scopeId);
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
  useReadReceiptStore.setState({ scopes: {} });
});
