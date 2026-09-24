import { create } from "zustand";
import api from "../api/client";

/**
 * Server-scoped gate for the unified attachment preview surfaces.
 *
 * Kept separate from the forwarding flag: forwarding gates a feature, this
 * gates behaviour the chat body shares. When off, attachment clicks fall back
 * to downloading — the behaviour that shipped before unification — so the flag
 * is a real rollback and not a cosmetic switch.
 */
interface AttachmentPreviewGateState {
  /** Defaults to on: this is a kill switch over already-shipped behaviour. */
  enabled: boolean;
  loaded: boolean;
  load: () => Promise<void>;
  setEnabled: (enabled: boolean) => void;
}

export const useAttachmentPreviewGate = create<AttachmentPreviewGateState>((set, get) => ({
  enabled: true,
  loaded: false,
  setEnabled: (enabled) => set({ enabled, loaded: true }),
  load: async () => {
    if (get().loaded) return;
    try {
      const res = await api.get<{ enabled?: unknown }>("/messages/attachment-preview/enabled");
      set({ enabled: res.data.enabled === true, loaded: true });
    } catch {
      // Leave the current value: this gates behaviour the chat body already
      // had, so an unreadable flag must not silently remove it. Turning it off
      // is an explicit decision, and only the server can make it.
      set({ loaded: true });
    }
  },
}));

export function isAttachmentPreviewUnifiedEnabled(): boolean {
  return useAttachmentPreviewGate.getState().enabled;
}
