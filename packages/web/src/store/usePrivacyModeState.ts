import { useSyncExternalStore } from "react";

import { privacyModeState, subscribePrivacyMode } from "./privacyMode";
import type { PrivacyModeState } from "./privacyMode";

/**
 * The page's RAFT_PRIVACY_MODE state for a component: `unknown` until the
 * client config answers, then `on` or `off` (store/privacyMode.ts). Kept out of
 * privacyMode.ts, which must stay import-free for the telemetry modules.
 */
export function usePrivacyModeState(): PrivacyModeState {
  return useSyncExternalStore(subscribePrivacyMode, privacyModeState, privacyModeState);
}
