import { NotificationSettingsSection } from "../../../components/settings/notifications/NotificationSettingsSection";
import { PwaInstallSettingsCard } from "../../../components/pwa/PwaInstallPrompt";
import { ServerNotificationsLink } from "./ServerNotificationsLink";

export function NotificationsTabContent() {
  return (
    <>
      <PwaInstallSettingsCard />
      <NotificationSettingsSection />
      <ServerNotificationsLink />
    </>
  );
}
