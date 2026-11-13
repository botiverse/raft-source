import { useServerStore } from "./serverStore";

const READ_SUMMARY_REFRESH_DELAY_MS = 300;
let pending: ReturnType<typeof setTimeout> | null = null;

/**
 * A read the server has saved (on this device or another one): the tab
 * title's "(N)", the app badge and the rail count come from the server's
 * unread summary, so read it again now rather than at the next 2-minute
 * sweep; the rail dot beside them already changed (#triage:#157). It runs
 * after the read is saved, so it can't read the count from before it. A burst
 * of reads is one request.
 */
export function refreshServerUnreadSummaryAfterRead(): void {
  if (pending !== null) return;
  pending = setTimeout(() => {
    pending = null;
    void useServerStore.getState().loadServerUnreadSummary();
  }, READ_SUMMARY_REFRESH_DELAY_MS);
}
