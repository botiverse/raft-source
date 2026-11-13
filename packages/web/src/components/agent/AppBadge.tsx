import { Badge } from "raft-ui";
import { useIntl } from "react-intl";
import Tooltip from "../ui/Tooltip";

/**
 * The App label: marks the identity an installed App posts as (an agent with
 * `managedByAppInstallId`, set by the app-bot identity service). It is called
 * App, never bot (raft-design, Identity and presence › An App in
 * conversations). Keep it a single component so every surface — message
 * header, DM header, sidebar row, detail panel, hover card — looks identical.
 *
 * With `appName` (the owning App, `agent.managedByApp.name`) it says which App
 * it is: "App · <App>" when the identity is shown under another name
 * (`botName`, the name rendered beside the badge), plain "App" when the names
 * match, and a "Created by the <App> app" tooltip either way. Without it (the
 * attribution is not loaded) it is the plain badge with no tooltip.
 *
 * `appearance="outline"` is for a row that tags each result's kind with an
 * outline Badge (search results: Agent, Human), so the App tag reads as one of
 * them. `compactInNarrowSidebar` is for sidebar rows: while the sidebar
 * (`@container/sidebar`) is narrower than 260px the label is just "App", so
 * the name keeps the room, and the App stays in the tooltip. The query reads
 * the container's content box, which is 1px inside the sidebar's own width
 * (its right seam), so "under 260px" is a content box under 259px.
 */
export default function AppBadge({
  className,
  appName,
  botName,
  appearance = "soft",
  compactInNarrowSidebar = false,
  truncateLabel = false,
}: {
  className?: string;
  appName?: string | null;
  botName?: string | null;
  appearance?: "soft" | "outline";
  compactInNarrowSidebar?: boolean;
  /** Allow a flex-constrained message header to show an ellipsis. */
  truncateLabel?: boolean;
}) {
  const { formatMessage } = useIntl();
  // The outline look is the kind tags' own (outline, default variant).
  const look = appearance === "outline"
    ? { appearance: "outline" as const }
    : { appearance: "soft" as const, variant: "muted" as const };
  const plainLabel = formatMessage({ id: "agent.appBadge" });
  if (!appName) {
    return (
      <Badge {...look} className={className} data-testid="app-bot-badge">
        {plainLabel}
      </Badge>
    );
  }
  const label = botName && botName !== appName
    ? formatMessage({ id: "agent.appBadgeWithApp" }, { app: appName })
    : plainLabel;
  return (
    <Tooltip content={formatMessage({ id: "agent.appBadgeTooltip" }, { app: appName })}>
      <Badge {...look} className={className} data-testid="app-bot-badge">
        {compactInNarrowSidebar && label !== plainLabel ? (
          <>
            <span data-app-bot-badge-label="full" className="@max-[259px]/sidebar:hidden">{label}</span>
            <span data-app-bot-badge-label="compact" className="hidden @max-[259px]/sidebar:inline">{plainLabel}</span>
          </>
        ) : truncateLabel ? <span className="block min-w-0 truncate">{label}</span> : label}
      </Badge>
    </Tooltip>
  );
}
