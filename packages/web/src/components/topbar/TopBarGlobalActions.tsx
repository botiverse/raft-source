import NotificationTrigger, { PendingNotificationTrigger } from "../layout/NotificationTrigger";
import { useShellPending } from "../layout/shellPending";
import { WorkingNowSummary } from "../layout/WorkingNowSummary";
import { WebUpdateButton } from "./WebUpdateButton";

/**
 * The web top bar's right region: the Update button while a newer release
 * waits, who is working right now, then the Bell. Help stays on the rail,
 * above Settings; the rail keeps navigation, Help and Settings.
 *
 * Raft Design System › AgentActivity: with the top bar the sidebar drops its
 * head, so the "who is working" summary (faces and a count) moves up here,
 * on the frame. It takes no space while nobody is working.
 *
 * Raft Design System › Page structure › Top bar: the update goes before who is
 * working, where the desktop app puts its own (TopBarUpdateButton).
 */
export function TopBarGlobalActions() {
  // A server still being resolved: the Bell in its place, nothing to show in it yet.
  if (useShellPending()) {
    return (
      <>
        <WebUpdateButton slotOnly />
        <PendingNotificationTrigger flavor="top-bar" />
      </>
    );
  }
  return (
    <>
      <WebUpdateButton />
      <WorkingNowSummary variant="count" onFrame className="h-(--frame-item-height)" />
      <NotificationTrigger flavor="top-bar" />
    </>
  );
}
