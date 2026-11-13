import {
  ListRowGroup,
  ListRow,
  ListRowBody,
  ListRowChevron,
  ListRowTitle,
} from "@botiverse/raft-ui";
import { useCallback } from "react";
import { useServerStore } from "../../../store/serverStore";
import { useAppNavigate } from "../../../hooks/useAppNavigate";
import { useCurrentServerLook } from "../../../hooks/useServerTheme";
import { useIntl } from "react-intl";

/** The Appearance page's way to this server's theme. */
export function ServerThemeLink() {
  const { formatMessage } = useIntl();
  const nav = useAppNavigate();
  const server = useServerStore((s) => s.current);
  const look = useCurrentServerLook();
  const open = useCallback(() => nav.toSettings("theme"), [nav]);
  if (!server || !look) return null;
  return (
    <ListRowGroup className="mb-6">
      <ListRow variant="plain" onClick={open} data-testid="settings-server-theme-link">
        <ListRowBody>
          <ListRowTitle>{formatMessage({ id: "settings.appearance.serverThemeLinkTitle" }, { serverName: server.name })}</ListRowTitle>
        </ListRowBody>
        <ListRowChevron />
      </ListRow>
    </ListRowGroup>
  );
}
