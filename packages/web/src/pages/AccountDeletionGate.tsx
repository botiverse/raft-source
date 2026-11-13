/**
 * The app, or what stands in for it while an account deletion is in play
 * (store/accountDeletionPending.ts): the confirmation right after this tab
 * requested it, or the pending page once any request was refused with 403
 * `account_deletion_pending`. App mounts it around the whole shell, so
 * nothing in the shell keeps asking.
 */
import type { ReactNode } from "react";

import { useAccountDeletionPendingStore } from "../store/accountDeletionPending";
import { AccountDeletionPendingPage } from "./AccountDeletionPendingPage";
import { AccountDeletionRequestedPage } from "./AccountDeletionRequestedPage";

export function AccountDeletionGate({ children }: { children: ReactNode }) {
  const requested = useAccountDeletionPendingStore((state) => state.requested);
  const pending = useAccountDeletionPendingStore((state) => state.pending);
  if (requested) return <AccountDeletionRequestedPage scheduledFor={requested.scheduledFor} />;
  return pending ? <AccountDeletionPendingPage /> : <>{children}</>;
}
