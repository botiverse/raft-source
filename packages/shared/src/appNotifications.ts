export const APP_NOTIFICATION_GROUPS = ["server", "agent", "channel", "computer"] as const;
export type AppNotificationGroup = (typeof APP_NOTIFICATION_GROUPS)[number];

export const APP_NOTIFICATION_EVENT_GROUPS = {
  "server.member_added": ["server"],
  "server.member_removed": ["server"],
  "server.member_role_changed": ["server"],
  "server.config_updated": ["server"],
  "server.public_channel_created": ["server", "channel"],
  "server.public_channel_archived": ["server", "channel"],
  "server.plan_changed": ["server"],
  "agent.status_changed": ["agent"],
  "agent.profile_updated": ["agent"],
  "agent.runtime_changed": ["agent"],
  "agent.model_changed": ["agent"],
  "channel.member_added": ["channel"],
  "channel.member_removed": ["channel"],
  "channel.config_updated": ["channel"],
  "channel.archived": ["channel"],
  "thread.created": ["channel"],
  "thread.resolved": ["channel"],
  "computer.online": ["computer"],
  "computer.offline": ["computer"],
  "computer.version_changed": ["computer"],
  "computer.agent_started": ["computer", "agent"],
  "computer.agent_stopped": ["computer", "agent"],
} as const satisfies Record<string, readonly AppNotificationGroup[]>;

export type AppNotificationEvent = keyof typeof APP_NOTIFICATION_EVENT_GROUPS;

export function appNotificationEventRequiredGroups(event: AppNotificationEvent): AppNotificationGroup[] {
  return [...APP_NOTIFICATION_EVENT_GROUPS[event]];
}
