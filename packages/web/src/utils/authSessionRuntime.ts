import type { AuthRestoreState } from "./authRestoreMachine";

type AuthRuntimeSnapshot = {
  initialized: boolean;
  restoreState: AuthRestoreState;
};

let authRuntimeSnapshot: AuthRuntimeSnapshot = {
  initialized: false,
  restoreState: "booting",
};

export function getAuthRuntimeSnapshot(): AuthRuntimeSnapshot {
  return authRuntimeSnapshot;
}

export function updateAuthRuntimeSnapshot(next: AuthRuntimeSnapshot): void {
  authRuntimeSnapshot = next;
}

