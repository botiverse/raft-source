import { useIntl } from "react-intl";
import ExperimentalBadge from "../../../components/ui/ExperimentalBadge";

export function AppNotificationsLabel() {
  const { formatMessage } = useIntl();
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-1.5">
      <span>{formatMessage({ id: "settings.connectedApps.section.webhook" })}</span>
      <ExperimentalBadge />
    </span>
  );
}
