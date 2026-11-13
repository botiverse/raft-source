import type { SlackReconciliationUnconfirmableReason } from "./slackReconciliationScan";

export const CONFIRMED_THREAD_ROOT_MISSING = "confirmed_thread_root_missing" as const;

/** A confirmed unattempted orphan can be discarded without provider I/O. */
export type ExternalProviderPreparation<Outcome> =
  | { ready: false; reason: string; disposition?: never; retryAfterMs?: number; pairBlockedReason?: SlackReconciliationUnconfirmableReason | "slack_workspace_admin_required" }
  | { ready: false; reason: typeof CONFIRMED_THREAD_ROOT_MISSING; disposition: "discard"; retryAfterMs?: never }
  | { ready: true; dispatch(): Promise<Outcome>; receipt?: Extract<Outcome, { kind: "accepted" }>; dispose?(): Promise<void> };

export function reconciledProviderReceipt<Outcome extends { kind: "accepted" }>(receipt: Outcome) {
  return { ready: true as const, receipt, dispatch: async () => receipt };
}
