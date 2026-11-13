// Settings › Notifications (design §4.3): this device, pause and schedule,
// content, and every server's level. Replaces the old Web Push / desktop
// cards and the per-server mute card.

import { useEffect } from "react";
import AssistantSettingChanges from "../AssistantSettingChanges";
import type { AssistantChangedSetting } from "../AssistantSettingChanges";
import { useNotificationSettingsStore } from "../../../store/notificationSettingsStore";
import { ContentCard } from "./ContentCard";
import { PauseAndScheduleCard } from "./PauseAndScheduleCard";
import { ServersCard } from "./ServersCard";
import { ThisDeviceCard } from "./ThisDeviceCard";

/** What the owner's assistant did here as them (muted a conversation, set a level). */
const NOTIFICATION_ASSISTANT_SETTINGS: readonly AssistantChangedSetting[] = ["conversationMute", "notificationLevel"];

export function NotificationSettingsSection() {
  // Fresh account settings each time the page opens (another device may have changed them).
  useEffect(() => {
    void useNotificationSettingsStore.getState().loadAccount();
  }, []);
  return (
    <div className="stack-y-6" data-testid="notification-settings-section">
      <ThisDeviceCard />
      <PauseAndScheduleCard />
      <ContentCard />
      <ServersCard />
      <AssistantSettingChanges settings={NOTIFICATION_ASSISTANT_SETTINGS} />
    </div>
  );
}

export { CurrentServerNotificationsCard } from "./ServersCard";
