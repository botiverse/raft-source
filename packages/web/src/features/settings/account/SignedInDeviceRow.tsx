import { Badge, Button, IconTile, ListRow, ListRowBody, ListRowSubtitle, ListRowTitle } from "@botiverse/raft-ui";
import { CircleHelp, Globe, Monitor, Smartphone } from "lucide-react";
import { useCallback } from "react";
import { useIntl } from "react-intl";

import { useTimeFormatter } from "../../../hooks/useTimeFormatter";
import { formatRelativeTime } from "../../../utils/relativeTime";
import type { MySession } from "./mySessionsApi";
import { signedInDeviceLabel } from "./signedInDeviceLabel";

function PlatformIcon({ platform }: { platform: string | null }) {
  if (platform === "browser" || platform === "pwa") return <Globe />;
  if (platform === "desktop_app") return <Monitor />;
  if (platform === "ios" || platform === "android" || platform === "harmonyos") return <Smartphone />;
  return <CircleHelp />;
}

/**
 * One sign-in of the person, a row of Signed-in devices: what it is (the
 * client's own claim), its version, when it signed in and was last active,
 * and Sign out. The sign-in this page is open in says This device and has no
 * action (Session's Sign out, at the end of Account, is its way out).
 */
export function SignedInDeviceRow({ session, onSignOut }: {
  session: MySession;
  onSignOut: (session: MySession) => void;
}) {
  const { formatMessage, locale } = useIntl();
  const { formatCompactDate } = useTimeFormatter();
  const handleSignOut = useCallback(() => onSignOut(session), [onSignOut, session]);
  const label = signedInDeviceLabel(session.platform, formatMessage);
  const facts = [
    session.version ? formatMessage({ id: "settings.account.signedInDevices.version" }, { version: session.version }) : null,
    formatMessage({ id: "settings.account.signedInDevices.signedIn" }, { date: formatCompactDate(session.createdAt) }),
    session.current
      ? formatMessage({ id: "settings.account.signedInDevices.activeNow" })
      : formatMessage({ id: "settings.account.signedInDevices.lastActive" }, { time: formatRelativeTime(session.lastActiveAt, locale) ?? "" }),
  ].filter((fact): fact is string => !!fact);

  return (
    <ListRow
      variant="plain"
      interactive={false}
      role="group"
      aria-label={label}
      data-testid={`signed-in-device-${session.id}`}
    >
      <IconTile><PlatformIcon platform={session.platform} /></IconTile>
      <ListRowBody>
        <span className="flex min-w-0 items-center gap-2">
          <ListRowTitle className="flex-initial">{label}</ListRowTitle>
          {session.current ? (
            <Badge variant="default" appearance="soft">{formatMessage({ id: "settings.account.signedInDevices.thisDevice" })}</Badge>
          ) : null}
        </span>
        <ListRowSubtitle>{facts.join(" · ")}</ListRowSubtitle>
      </ListRowBody>
      {session.current ? null : (
        <Button
          variant="outline"
          size="md"
          type="button"
          onClick={handleSignOut}
          className="shrink-0"
          data-testid={`signed-in-device-sign-out-${session.id}`}
        >
          {formatMessage({ id: "settings.account.signedInDevices.signOut" })}
        </Button>
      )}
    </ListRow>
  );
}
