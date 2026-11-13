import { ListRowGroup, ListRow, ListRowBody, ListRowChevron, ListRowTitle } from "@botiverse/raft-ui";
import { useCallback } from "react";
import { useServerStore } from "../../../store/serverStore";
import { useServerNotificationLevel } from "../../../store/notificationSettingsStore";
import { NOTIFICATION_LEVEL_LABEL_ID } from "../../../components/notifications/NotificationLevelMenu";
import { useAppNavigate } from "../../../hooks/useAppNavigate";
import { useIntl } from "react-intl";

/** The personal Notifications page's way to this server's own (its mute). */
export function ServerNotificationsLink() {
  const { formatMessage } = useIntl();
  const nav = useAppNavigate();
  const server = useServerStore((s) => s.current);
  const serverLevel = useServerNotificationLevel(server?.id);
  const open = useCallback(() => nav.toSettings("server-notifications"), [nav]);
  if (!server) return null;
  return (
    <ListRowGroup className="mt-4">
      <ListRow variant="plain" onClick={open} data-testid="settings-server-notifications-link">
        <ListRowBody>
          <ListRowTitle>{formatMessage({ id: "settings.notifications.serverLinkTitle" }, { serverName: server.name })}</ListRowTitle>
        </ListRowBody>
        <span className="shrink-0 text-footnote text-foreground-hint">
          {formatMessage({ id: NOTIFICATION_LEVEL_LABEL_ID[serverLevel] })}
        </span>
        <ListRowChevron />
      </ListRow>
    </ListRowGroup>
  );
}
