import type { IntlShape } from "react-intl";
import {
  APP_NOTIFICATION_EVENT_GROUPS,
  APP_NOTIFICATION_GROUPS,
} from "@botiverse/raft-shared";
import type {
  AppNotificationEvent,
  AppNotificationGroup,
} from "@botiverse/raft-shared";
import type { MessageId } from "../../i18n/messages";

/**
 * App notification groups and a selection of them, apart from the settings
 * controls (AppNotificationsControls.tsx, in the lazy settings page): the
 * sign-in setup page lists an app's permissions with these labels.
 */

// Holds catalog IDS, not display text: module scope cannot call formatMessage.
// Call sites format. Same shape as the sub-batch F distribution helpers.
const GROUP_META: Record<AppNotificationGroup, { labelId: MessageId; summaryId: MessageId }> = {
  server: { labelId: "settings.connectedApps.appNotifications.group.server.label", summaryId: "settings.connectedApps.appNotifications.group.server.summary" },
  agent: { labelId: "settings.connectedApps.appNotifications.group.agent.label", summaryId: "settings.connectedApps.appNotifications.group.agent.summary" },
  channel: { labelId: "settings.connectedApps.appNotifications.group.channel.label", summaryId: "settings.connectedApps.appNotifications.group.channel.summary" },
  computer: { labelId: "settings.connectedApps.appNotifications.group.computer.label", summaryId: "settings.connectedApps.appNotifications.group.computer.summary" },
  agent_reminder_write: { labelId: "settings.connectedApps.appNotifications.group.agent_reminder_write.label", summaryId: "settings.connectedApps.appNotifications.group.agent_reminder_write.summary" },
};

export { GROUP_META as APP_NOTIFICATION_GROUP_META };

export function permissionGroupLabel(group: AppNotificationGroup, formatMessage: IntlShape["formatMessage"]): string {
  const resource = formatMessage({ id: GROUP_META[group].labelId });
  return group === "agent_reminder_write" ? resource : formatMessage({ id: "settings.connectedApps.appPermissions.readLabel" }, { resource });
}

export type AppNotificationSelection = {
  groups: AppNotificationGroup[];
  events: AppNotificationEvent[];
};

const ALL_EVENTS = Object.keys(APP_NOTIFICATION_EVENT_GROUPS) as AppNotificationEvent[];
export { ALL_EVENTS as ALL_APP_NOTIFICATION_EVENTS };

function sortedSelection(selection: AppNotificationSelection): AppNotificationSelection {
  return {
    groups: APP_NOTIFICATION_GROUPS.filter((group) => selection.groups.includes(group)),
    events: ALL_EVENTS.filter((event) => selection.events.includes(event)),
  };
}

export function toggleAppNotificationGroup(
  selection: AppNotificationSelection,
  group: AppNotificationGroup,
  checked: boolean,
): AppNotificationSelection {
  const groups = checked
    ? [...selection.groups, group]
    : selection.groups.filter((item) => item !== group);
  const events = checked
    ? selection.events
    : selection.events.filter((event) => !(APP_NOTIFICATION_EVENT_GROUPS[event] as readonly AppNotificationGroup[]).includes(group));
  return sortedSelection({ groups, events });
}

export function toggleAppNotificationEvent(
  selection: AppNotificationSelection,
  event: AppNotificationEvent,
  checked: boolean,
): AppNotificationSelection {
  const events = checked
    ? [...selection.events, event]
    : selection.events.filter((item) => item !== event);
  return sortedSelection({ groups: selection.groups, events });
}
