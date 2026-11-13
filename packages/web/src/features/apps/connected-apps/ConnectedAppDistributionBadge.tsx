import { Badge } from "@botiverse/raft-ui";
import { useIntl } from "react-intl";
import { connectedAppOverviewDistributionLabel } from "./connectedAppStatus";
import type { ConnectedAppStatus } from "./connectedAppTypes";

// Exported for settingsSubBatchF.i18n.behavior.test.tsx (removed in the 2026-11 web DOM test prune) — presentational, so the
// zh tooth renders the real component with no API/data harness.
export function ConnectedAppDistributionBadge({ status }: { status: ConnectedAppStatus | null }) {
  // useIntl() must stay above the early return — hooks cannot be conditional.
  const { formatMessage } = useIntl();
  if (!status) return null;
  const label = formatMessage({ id: connectedAppOverviewDistributionLabel(status) });
  if (status === "published") return <Badge appearance="soft" variant="success">{label}</Badge>;
  if (status === "publish_requested" || status === "in_review" || status === "unpublish_requested" || status === "rejected") {
    return <Badge appearance="soft" variant="warning">{label}</Badge>;
  }
  return <Badge appearance="soft" variant="muted">{label}</Badge>;
}
