/**
 * "This account is scheduled for deletion" (design §6, middleware/auth.ts on
 * the server): while a deletion is scheduled, every API but GET/DELETE
 * /api/me/account/deletion and POST /api/auth/logout answers 403
 * `account_deletion_pending` with `scheduledFor`. The API client
 * (api/client.ts) notes the first such answer here; App then shows
 * AccountDeletionPendingPage in place of the whole app shell, so nothing in
 * the shell keeps asking. Cancelling reloads the page; signing out clears it.
 *
 * Kept free of the API client (the client imports it).
 */
import { create } from "zustand";

import { getApiErrorResponse } from "../utils/apiErrorResponse";

export const ACCOUNT_DELETION_PENDING_CODE = "account_deletion_pending";

export const useAccountDeletionPendingStore = create<{
  pending: boolean;
  /** ISO time the account is deleted, from the 403; null when it didn't say. */
  scheduledFor: string | null;
  /**
   * This tab just requested the deletion: every sign-in, this one too, is
   * gone. App shows the confirmation in place of the shell (so nothing in it
   * keeps asking and gets 401s) until OK signs out.
   */
  requested: { scheduledFor: string | null } | null;
}>(() => ({ pending: false, scheduledFor: null, requested: null }));

export function isAccountDeletionPendingError(err: unknown): boolean {
  const response = getApiErrorResponse(err);
  return response?.status === 403 && response.code === ACCOUNT_DELETION_PENDING_CODE;
}

/** Known to be scheduled: boot loads (the timezone report, notification settings) don't ask. */
export function isAccountDeletionPending(): boolean {
  return useAccountDeletionPendingStore.getState().pending;
}

/** A sign-in that read the deletion (GET /me/account/deletion answers "scheduled") before anything else asked. */
export function markAccountDeletionPending(scheduledFor: unknown): void {
  useAccountDeletionPendingStore.setState({
    pending: true,
    scheduledFor: typeof scheduledFor === "string" && scheduledFor ? scheduledFor : null,
  });
}

/** From the API client's response interceptor: any request's error. */
export function noteAccountDeletionPendingFrom(err: unknown): void {
  if (!isAccountDeletionPendingError(err)) return;
  const scheduledFor = (err as { response?: { data?: { scheduledFor?: unknown } } }).response?.data?.scheduledFor;
  const state = useAccountDeletionPendingStore.getState();
  const next = typeof scheduledFor === "string" && scheduledFor ? scheduledFor : state.scheduledFor;
  if (state.pending && state.scheduledFor === next) return;
  useAccountDeletionPendingStore.setState({ pending: true, scheduledFor: next });
}

/** The request went through (DeleteAccountPage): the confirmation stands in for the shell. */
export function markAccountDeletionRequested(scheduledFor: string | null): void {
  useAccountDeletionPendingStore.setState({ requested: { scheduledFor } });
}

/** Signed out, or the deletion was cancelled. */
export function clearAccountDeletionPending(): void {
  useAccountDeletionPendingStore.setState({ pending: false, scheduledFor: null, requested: null });
}
