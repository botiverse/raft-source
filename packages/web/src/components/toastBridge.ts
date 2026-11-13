import type { LocalizedToastData } from "./LocalizedToastProvider";

/**
 * A module-scoped handle on the app's toast manager.
 *
 * Surfaces that must report a failure but are also rendered without a provider
 * (tests, and the odd non-app mount) cannot call `useToastManager()` — the hook
 * throws outside `<Toast.Provider>`. `LocalizedToastProvider` registers the
 * live manager here once, and everyone else reports through `showToast`, which
 * simply does nothing when no provider is mounted.
 */
type BridgedToast = {
  title: string;
  description?: string;
  type?: string;
  /** One button on the toast, e.g. "Retry". */
  actionProps?: { children: string; onClick: () => void };
  /** LocalizedToastProvider's extras, e.g. the person a toast is about. */
  data?: LocalizedToastData;
  /** Milliseconds before it closes; see `toastTimeout` for the default. */
  timeout?: number;
};
type ToastManager = { add: (toast: BridgedToast) => string | void; close?: (id: string) => void };

/**
 * Raft DS › Toast (raft-ui 0.28): a toast closes after 5 seconds, or after 8
 * when it has an action or reports an error, so there is time to read it and
 * act. raft-ui's `toast.*` applies the 8 itself; a toast added to the manager
 * directly (as `showToast` does) gets only the provider's 5, so the longer
 * time is set here.
 */
export const TOAST_ACTION_TIMEOUT_MS = 8_000;

export function toastTimeout({ hasAction, type }: { hasAction: boolean; type?: string }): number | undefined {
  return hasAction || type === "error" ? TOAST_ACTION_TIMEOUT_MS : undefined;
}

let manager: ToastManager | null = null;

export function setToastManager(next: ToastManager | null): void {
  manager = next;
}

/** Shows `toast`; its id (for `closeToast`), or null with no provider mounted. */
export function showToast(toast: BridgedToast): string | null {
  if (!manager) return null;
  const timeout = toast.timeout ?? toastTimeout({ hasAction: Boolean(toast.actionProps), type: toast.type });
  // An error toast's trace id is added where every toast renders (LocalizedToastProvider).
  return manager.add(timeout === undefined ? toast : { ...toast, timeout }) ?? null;
}

/** Closes a toast `showToast` showed, before its time (its action no longer means anything); null does nothing. */
export function closeToast(id: string | null | undefined): void {
  if (id) manager?.close?.(id);
}

/** True while the app's toast viewport is mounted, so a toast shown now is seen. */
export function hasToastManager(): boolean {
  return manager !== null;
}
