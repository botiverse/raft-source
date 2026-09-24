import {
  shouldRetryAuthRestore,
} from "./authRestoreMachine";
import type {
  AuthRestoreState,
} from "./authRestoreMachine";

export function shouldRecoverAuthOnBrowserSignal(params: {
  visible: boolean;
  online: boolean;
  initialized: boolean;
  restoreState: AuthRestoreState;
  hasStoredSession: boolean;
}): boolean {
  if (!params.visible || !params.online) return false;
  return shouldRetryAuthRestore({
    initialized: params.initialized,
    restoreState: params.restoreState,
    hasStoredSession: params.hasStoredSession,
  });
}

export function getLiveSessionRecoveryPlan(params: {
  visible: boolean;
  online: boolean;
  hasStoredSession: boolean;
  socketConnected: boolean;
}): {
  reconnectSocket: boolean;
  reloadLiveData: boolean;
} {
  if (!params.visible || !params.online || !params.hasStoredSession) {
    return {
      reconnectSocket: false,
      reloadLiveData: false,
    };
  }

  return {
    reconnectSocket: !params.socketConnected,
    reloadLiveData: true,
  };
}

/**
 * Defense-in-depth periodic status reconcile (cache-coherence contract CC-006,
 * client side: realtime push is best-effort; a periodic pull converges a status
 * that latched because no edge event repaired it).
 *
 * This is the narrow gap that the other two repair paths do NOT cover:
 *   - `getLiveSessionRecoveryPlan` (visibilitychange / focus / online) repairs
 *     when the user leaves and returns to the tab — but never fires on a tab
 *     that stays focused;
 *   - the heartbeat circuit breaker forces a socket reconnect only on prolonged
 *     silence — but not when the socket is alive and still delivering OTHER
 *     events while a single status sits latched.
 * So this reconcile fires only when the tab is visible, online, has a session,
 * AND the socket is connected (the socket-down case is already owned by the
 * reconnect + recoverLiveSession path). It is intentionally low-frequency; the
 * caller drives the cadence (a long interval) — this function only gates it.
 */
export function planStatusReconcile(params: {
  visible: boolean;
  online: boolean;
  hasStoredSession: boolean;
  socketConnected: boolean;
}): { reconcile: boolean } {
  if (!params.visible || !params.online || !params.hasStoredSession) {
    return { reconcile: false };
  }
  if (!params.socketConnected) {
    // Socket-down recovery (reconnect + reload) is owned by the heartbeat
    // breaker and recoverLiveSession; don't double-pull here.
    return { reconcile: false };
  }
  return { reconcile: true };
}
