// `agent_reminder_write` is a write grant, not a notification group: it lets an
// official app's installation write reminder messages into an agent's private
// `dm:@reminders` conversation. It has no events and is only grantable to apps
// in the official app registry (enforced server-side).
export const APP_NOTIFICATION_GROUPS = ["server", "agent", "channel", "computer", "agent_reminder_write"] as const;
export const APP_AGENT_REMINDER_WRITE_GROUP = "agent_reminder_write" satisfies AppNotificationGroup;
export type AppNotificationGroup = (typeof APP_NOTIFICATION_GROUPS)[number];

/**
 * What an App Notification is about (its `subject.type`). `installation` is
 * the receiving App's own installation and nothing else.
 */
export const APP_NOTIFICATION_SUBJECT_TYPES = ["server", "member", "agent", "channel", "computer", "installation"] as const;
export type AppNotificationSubjectType = (typeof APP_NOTIFICATION_SUBJECT_TYPES)[number];

/**
 * One event type: its subject, and the installer-approved groups an
 * installation needs to receive it. The two shapes are the rule (#proj-apps
 * #35): an event about the App's own installation needs no group and only
 * ever goes to that installation; every other event needs at least one group
 * and can never use the `installation` subject to skip them.
 */
export type AppNotificationEventSpec =
  | { readonly subject: "installation"; readonly groups: readonly [] }
  | {
    readonly subject: Exclude<AppNotificationSubjectType, "installation">;
    readonly groups: readonly [AppNotificationGroup, ...AppNotificationGroup[]];
  };

/**
 * Every App Notification event type, its subject and its required groups.
 * Events Raft does not emit yet carry the subject they would be visible
 * through; revisit it when building one.
 */
export const APP_NOTIFICATION_EVENT_REGISTRY = {
  "server.member_added": { subject: "member", groups: ["server"] },
  "server.member_removed": { subject: "member", groups: ["server"] },
  "server.member_role_changed": { subject: "member", groups: ["server"] },
  "server.config_updated": { subject: "server", groups: ["server"] },
  "server.public_channel_created": { subject: "channel", groups: ["server", "channel"] },
  "server.public_channel_archived": { subject: "channel", groups: ["server", "channel"] },
  "server.plan_changed": { subject: "server", groups: ["server"] },
  "agent.status_changed": { subject: "agent", groups: ["agent"] },
  "agent.profile_updated": { subject: "agent", groups: ["agent"] },
  "agent.runtime_changed": { subject: "agent", groups: ["agent"] },
  "agent.model_changed": { subject: "agent", groups: ["agent"] },
  "channel.member_added": { subject: "channel", groups: ["channel"] },
  "channel.member_removed": { subject: "channel", groups: ["channel"] },
  "channel.config_updated": { subject: "channel", groups: ["channel"] },
  "channel.archived": { subject: "channel", groups: ["channel"] },
  "thread.created": { subject: "channel", groups: ["channel"] },
  "thread.resolved": { subject: "channel", groups: ["channel"] },
  "computer.online": { subject: "computer", groups: ["computer"] },
  "computer.offline": { subject: "computer", groups: ["computer"] },
  "computer.version_changed": { subject: "computer", groups: ["computer"] },
  "computer.agent_started": { subject: "computer", groups: ["computer", "agent"] },
  "computer.agent_stopped": { subject: "computer", groups: ["computer", "agent"] },
  // The App's bot on this installation was added, removed or declined.
  "installation.bot_changed": { subject: "installation", groups: [] },
} as const satisfies Record<string, AppNotificationEventSpec>;

type AppNotificationEventRegistry = typeof APP_NOTIFICATION_EVENT_REGISTRY;

/** Every App Notification event type. */
export type AppNotificationEventType = keyof AppNotificationEventRegistry;

/**
 * An event about the App's own installation: needs no group and no
 * declaration, is delivered to that installation only, and an App subscribes
 * to it on its installation directly.
 */
export type AppInstallationNotificationEvent = {
  [E in AppNotificationEventType]: AppNotificationEventRegistry[E]["subject"] extends "installation" ? E : never;
}[AppNotificationEventType];

/**
 * An event gated by installer-approved groups: every event but the
 * installation's own. These are what an App declares and an installer approves.
 */
export type AppNotificationEvent = Exclude<AppNotificationEventType, AppInstallationNotificationEvent>;

const EVENT_REGISTRY_ENTRIES = Object.entries(APP_NOTIFICATION_EVENT_REGISTRY) as Array<
  [AppNotificationEventType, AppNotificationEventSpec]
>;

/** The group-gated events and their required groups (no installation event). */
export const APP_NOTIFICATION_EVENT_GROUPS = Object.fromEntries(
  EVENT_REGISTRY_ENTRIES
    .filter(([, spec]) => spec.subject !== "installation")
    .map(([event, spec]) => [event, spec.groups]),
) as { readonly [E in AppNotificationEvent]: AppNotificationEventRegistry[E]["groups"] };

export const APP_INSTALLATION_NOTIFICATION_EVENTS = EVENT_REGISTRY_ENTRIES
  .filter(([, spec]) => spec.subject === "installation")
  .map(([event]) => event) as readonly AppInstallationNotificationEvent[];

/** The registry entry for an event type, or undefined for a string that is none. */
export function appNotificationEventSpec(event: string): AppNotificationEventSpec | undefined {
  return Object.prototype.hasOwnProperty.call(APP_NOTIFICATION_EVENT_REGISTRY, event)
    ? APP_NOTIFICATION_EVENT_REGISTRY[event as AppNotificationEventType]
    : undefined;
}

export function isAppInstallationNotificationEvent(event: string): event is AppInstallationNotificationEvent {
  return appNotificationEventSpec(event)?.subject === "installation";
}

export function appNotificationEventRequiredGroups(event: AppNotificationEvent): AppNotificationGroup[] {
  return [...APP_NOTIFICATION_EVENT_GROUPS[event]];
}

/**
 * The App's bot on one installation, as the App reads it (the installation
 * lookup's `bot.state` and `installation.bot_changed` data): `added` while it
 * is in the Server; `not_added` when no one has added it (or it is not live);
 * `declined` when a Server admin chose not to add it or removed it.
 */
export const APP_INSTALLATION_BOT_STATES = ["added", "not_added", "declined"] as const;
export type AppInstallationBotState = (typeof APP_INSTALLATION_BOT_STATES)[number];

/** `installation.bot_changed` event data. `agent_id` only while `added`. */
export type AppInstallationBotChangedData = {
  state: AppInstallationBotState;
  handle: string;
  agent_id?: string;
};
