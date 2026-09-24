import { MAX_AUTH_RESTORE_MS } from "./authRestoreMachine";
import type { AuthRestoreState } from "./authRestoreMachine";

// Auth Session Contract (rfcs/016-auth-session-contract.md, #2494) —
// Restore Timeout Policy as a pure, testable oracle.
//
// A restore timeout is TRANSIENT evidence, never terminal. The restore taking
// longer than MAX_AUTH_RESTORE_MS (weak network / slow boot / a slow but valid
// /auth/me) does NOT mean the stored credential was rejected — so with a stored
// session present it must NOT clear it. The current App.tsx restore effect
// bypasses this policy and calls authStore.logout() directly on timeout (the
// 30s timeout-logout root-cause candidate); App.tsx should route through this
// oracle instead (follow-up wiring) so a timer alone can never sign a user out.
//
// The timeout comparison is computed inline here (rather than via
// hasAuthRestoreTimedOut, which folds in shouldRetryAuthRestore's hasStoredSession
// gate) so the policy can branch on hasStoredSession independently and keep all
// three closed-set outcomes reachable + unit-testable.

export type RestoreTimeoutAction =
  | "continue_restore"
  | "degraded_retry"
  | "logout";

export function getRestoreTimeoutAction(params: {
  initialized: boolean;
  restoreState: AuthRestoreState;
  hasStoredSession: boolean;
  elapsedMs: number;
  maxElapsedMs?: number;
}): RestoreTimeoutAction {
  const inRestore = params.initialized && params.restoreState === "restoring_auth";
  const timedOut = params.elapsedMs >= (params.maxElapsedMs ?? MAX_AUTH_RESTORE_MS);

  if (!inRestore || !timedOut) {
    return "continue_restore";
  }
  // Timed out mid-restore. With a stored session present the credential has NOT
  // been rejected — only the restore was slow. Contract forbids clearing it:
  // degrade and keep it retryable instead of ending the session.
  if (params.hasStoredSession) {
    return "degraded_retry";
  }
  // No stored session to preserve — there is no valid credential to lose, so a
  // logged-out terminal state is correct here.
  return "logout";
}
