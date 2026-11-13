import settingsSearchIndexJson from "@botiverse/raft-shared/src/settingsSearch.v1.json" with { type: "json" };
import type { SettingsSearchEntry, SettingsSearchIndex, SettingsSearchPlatform } from "@botiverse/raft-shared/src/settingsSearch";
import type { MessageId } from "../../../i18n/messages/en";

/**
 * The shared index (packages/shared/src/settingsSearch.v1.json): where each
 * setting is and the other words for it. Its name, description, section and
 * page are this app's own strings, below.
 */
export const SETTINGS_SEARCH_INDEX = settingsSearchIndexJson as SettingsSearchIndex;

/**
 * The words the web shows for a setting: the catalog ids of its name, its
 * description and its section. Named `…Id`, as SETTINGS_TAB_TITLE_ID is: they
 * are ids, looked up in the display language, not copy.
 */
export interface SettingsSearchCopy {
  readonly nameId: MessageId;
  readonly descriptionId?: MessageId;
  /** The section it is under; none where the setting is the section, or the page has no sections. */
  readonly sectionId?: MessageId;
}

/**
 * The web's words for each setting of the index, by id: the strings its row
 * already shows on its page. features/settings/tests/settingsSearchAnchors.test.ts
 * checks every
 * web entry has a line here and an `id` on its page.
 */
export const SETTINGS_SEARCH_COPY: Readonly<Record<string, SettingsSearchCopy>> = {
  "display-name": { nameId: "settings.account.displayNameLabel", sectionId: "settings.account.sectionLabel" },
  username: { nameId: "settings.account.usernameLabel", sectionId: "settings.account.sectionLabel" },
  email: { nameId: "settings.account.emailLabel", sectionId: "settings.account.sectionLabel" },
  password: { nameId: "settings.account.changePassword", sectionId: "settings.account.sectionLabel" },
  passkeys: { nameId: "settings.passkeys.sectionLabel" },
  "two-step": { nameId: "settings.twoStep.title" },
  "sign-out": { nameId: "settings.session.logOutTitle", descriptionId: "settings.session.logOutDescription", sectionId: "settings.session.sectionLabel" },
  "delete-account": { nameId: "accountDeletion.rowTitle", descriptionId: "accountDeletion.rowDescription", sectionId: "settings.dangerZone.sectionLabel" },
  "display-language": { nameId: "settings.language.displayLanguageTitle", sectionId: "settings.language.sectionLabel" },
  "translation-mode": { nameId: "settings.language.translationMode", sectionId: "settings.language.sectionLabel" },
  "time-format": { nameId: "settings.dateTime.timeFormat", sectionId: "settings.dateTime.sectionLabel" },
  timezone: { nameId: "settings.dateTime.timezone", sectionId: "settings.dateTime.sectionLabel" },
  // Light or dark: on the Theme page, by the themes (xxchan, #triage:56baf365).
  theme: { nameId: "settings.theme.groupMode" },
  "message-font-size": { nameId: "settings.appearance.messageFontSizeTitle", sectionId: "settings.appearance.sectionLabel" },
  "live-agent-activity": { nameId: "settings.appearance.liveAgentActivityTitle", sectionId: "settings.appearance.sectionLabel" },
  "show-agent-model": { nameId: "settings.appearance.showAgentModelNameTitle", sectionId: "settings.appearance.sectionLabel" },
  "show-sender-description": { nameId: "settings.appearance.showSenderDescriptionTitle", sectionId: "settings.appearance.sectionLabel" },
  "hide-empty-sidebar-sections": { nameId: "settings.appearance.hideEmptySidebarSectionsTitle", sectionId: "settings.appearance.sectionLabel" },
  "send-with": { nameId: "settings.appearance.sendKeyTitle", sectionId: "settings.appearance.keyboardSection" },
  // The desktop app's card is Desktop notifications, with no push to explain (useSettingsSearchSettings).
  "push-notifications": { nameId: "settings.notifications.device.browserTitle", sectionId: "settings.notifications.device.sectionLabel" },
  "pause-notifications": { nameId: "settings.notifications.pause.title", sectionId: "settings.notifications.pause.sectionLabel" },
  "quiet-hours": { nameId: "settings.notifications.quiet.title", sectionId: "settings.notifications.pause.sectionLabel" },
  "notification-preview": { nameId: "settings.notifications.preview.title", sectionId: "settings.notifications.content.sectionLabel" },
  "notification-sound": { nameId: "settings.notifications.sound.title", sectionId: "settings.notifications.content.sectionLabel" },
  "notification-followed-thread-replies": { nameId: "settings.notifications.followedThreadReplies.title", descriptionId: "settings.notifications.followedThreadReplies.description", sectionId: "settings.notifications.content.sectionLabel" },
  "server-theme": { nameId: "settings.tabs.theme", descriptionId: "settings.theme.description" },
  // The server's level, whose last choice is Mute.
  "mute-server": { nameId: "notifications.level.mute", descriptionId: "notifications.level.muteNote" },
  "server-name": { nameId: "settings.serverProfile.nameLabel", sectionId: "settings.serverProfile.sectionLabel" },
  "public-access": { nameId: "settings.publicVisibility.title", descriptionId: "settings.publicVisibility.description", sectionId: "settings.publicVisibility.sectionLabel" },
  "leave-server": { nameId: "settings.dangerZone.leaveServerTitle", descriptionId: "settings.dangerZone.leaveServerDescription", sectionId: "settings.dangerZone.sectionLabel" },
  plan: { nameId: "billing.managePlan" },
  "invite-links": { nameId: "settings.joinLinks.sectionLabel" },
  "single-sign-on": { nameId: "settings.sso.sectionLabel" },
  "member-permissions": { nameId: "settings.memberPermissions.sectionLabel" },
  "ai-providers": { nameId: "settings.providers.sectionTitle", descriptionId: "settings.providers.description" },
  "desktop-app": { nameId: "settings.desktopApp.sectionLabel" },
};

/** The index's entries for this client, in the list's order: its platform's, and none experimental. */
export function settingsSearchEntriesFor(platform: SettingsSearchPlatform): SettingsSearchEntry[] {
  return SETTINGS_SEARCH_INDEX.entries.filter((entry) => entry.platforms.includes(platform) && entry.experimental !== true);
}
