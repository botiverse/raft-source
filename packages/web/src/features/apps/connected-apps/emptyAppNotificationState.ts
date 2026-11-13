import type { AppNotificationsDeveloperState } from "../../../components/settings/AppNotificationsControls";

export function emptyAppNotificationState(): AppNotificationsDeveloperState {
  return {
    request_revision: 0,
    current_revision_id: null,
    current_groups: [],
    current_events: [],
    pending_revision: null,
    webhook: null,
  };
}
