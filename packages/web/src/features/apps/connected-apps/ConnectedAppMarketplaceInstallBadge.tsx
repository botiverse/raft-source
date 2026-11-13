import { Badge } from "@botiverse/raft-ui";
import { MARKETPLACE_INSTALL_BUCKET_LABELS } from "@botiverse/raft-shared";
import type { MarketplaceInstallBadge } from "@botiverse/raft-shared";
import { useIntl } from "react-intl";

export function ConnectedAppMarketplaceInstallBadge({ badge }: { badge: MarketplaceInstallBadge }) {
  const { formatMessage } = useIntl();
  if (badge.kind === "none") return null;
  if (badge.kind === "new") {
    return <Badge appearance="soft" variant="information">{formatMessage({ id: "settings.connectedApps.marketplaceNew" })}</Badge>;
  }
  return (
    <Badge appearance="outline">
      {formatMessage(
        { id: "settings.connectedApps.marketplaceInstallCount" },
        { count: MARKETPLACE_INSTALL_BUCKET_LABELS[badge.bucket] },
      )}
    </Badge>
  );
}
