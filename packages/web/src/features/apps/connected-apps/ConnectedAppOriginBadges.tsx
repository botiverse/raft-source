import { Badge } from "@botiverse/raft-ui";
import { useIntl } from "react-intl";
import type { InstalledConnectedApp } from "./connectedAppTypes";

// Exported for settingsSubBatchD.i18n.behavior.test.tsx (removed in the 2026-11 web DOM test prune) — pure presentational,
// so the zh teeth render the real component with no API/data harness.
export function ConnectedAppOriginBadges({ app, className = "" }: { app: InstalledConnectedApp; className?: string }) {
  // useIntl() must stay above the early return — hooks cannot be conditional.
  const { formatMessage } = useIntl();
  if (!app.privateShared && app.origin !== "private") return null;
  return (
    <div className={`flex flex-wrap items-center gap-1.5 ${className}`.trim()}>
      {app.privateShared ? <Badge appearance="soft">{formatMessage({ id: "settings.connectedApps.sharedBadge" })}</Badge> : null}
      {app.origin === "private" ? <Badge appearance="soft" variant="information">{formatMessage({ id: "settings.connectedApps.thisServerBadge" })}</Badge> : null}
    </div>
  );
}
