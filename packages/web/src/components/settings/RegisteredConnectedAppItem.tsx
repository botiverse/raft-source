import { Badge, Button } from "@botiverse/raft-ui";
import Tooltip from "../ui/Tooltip";
import { useCallback } from "react";
import { Pencil } from "lucide-react";
import { useIntl } from "react-intl";
import SurfaceListItem from "../ui/SurfaceListItem";
import { ConnectedAppLogo } from "./ConnectedAppLogo";
import { CONNECTED_APP_CATEGORY_LABEL_ID } from "../../features/apps/connected-apps/connectedAppCatalog";
import { ConnectedAppDistributionBadge } from "../../features/apps/connected-apps/ConnectedAppDistributionBadge";
import { ConnectedAppSummary } from "../../features/apps/connected-apps/ConnectedAppSummary";
import { ConnectedAppUrlLink } from "../../features/apps/connected-apps/ConnectedAppUrlLink";
import { canEditSourceOwnedConnectedApp, sourceOwnedConnectedAppStatusHint } from "../../features/apps/connected-apps/connectedAppStatus";
import { getDomainFromUrl } from "../../features/apps/connected-apps/getDomainFromUrl";
import type { ConnectedAppsViewMode, ServerRegisteredApp } from "../../features/apps/connected-apps/connectedAppTypes";

/** What a My apps row shows; an ordinary App (`ServerRegisteredApp`) and an MCP App both provide it. */
export type RegisteredConnectedAppRow = Pick<ServerRegisteredApp, "name" | "logoUrl" | "defaultLogoSeed" | "category" | "status" | "description" | "homepageUrl">;

export function RegisteredConnectedAppItem<T extends RegisteredConnectedAppRow>({
  app,
  viewMode,
  canManage,
  onEdit,
  testId,
  mcp = false,
}: {
  app: T;
  viewMode: ConnectedAppsViewMode;
  canManage: boolean;
  onEdit: (app: T) => void;
  testId?: string;
  /** An MCP App: the row is the ordinary one plus a single MCP tag (its type). */
  mcp?: boolean;
}) {
  const { formatMessage } = useIntl();
  const handleEdit = useCallback(() => onEdit(app), [app, onEdit]);
  const statusHintId = sourceOwnedConnectedAppStatusHint(app.status);

  return (
    <SurfaceListItem
      interactive={false}
      data-testid={testId}
      className={viewMode === "grid"
 ? "flex min-h-[184px] w-full flex-col gap-3"
 : "flex w-full flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"}
    >
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <ConnectedAppLogo name={app.name} logoUrl={app.logoUrl} seed={app.defaultLogoSeed} size="sm" />
        <div className="min-w-0 flex-1">
          <div className="min-w-0 break-words text-body font-semibold text-foreground">{app.name}</div>
          <div className="mt-0.5 text-footnote text-foreground-muted">{formatMessage({ id: CONNECTED_APP_CATEGORY_LABEL_ID[app.category] ?? "settings.connectedApps.categoryOther" })}</div>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {mcp ? <Badge appearance="outline">{formatMessage({ id: "settings.connectedApps.mcp.badge" })}</Badge> : null}
            <ConnectedAppDistributionBadge status={app.status} />
          </div>
          {viewMode === "list" && (
            <ConnectedAppSummary description={app.description} />
          )}
          {viewMode === "grid" && (
            <>
              {statusHintId && (
                <Tooltip content={formatMessage({ id: statusHintId })}>
                <div className="mt-1 line-clamp-2 text-footnote text-foreground-muted">
                  {formatMessage({ id: statusHintId })}
                </div>
                </Tooltip>
              )}
              <ConnectedAppUrlLink url={app.homepageUrl} label={getDomainFromUrl(app.homepageUrl)} className="mt-1" />
            </>
          )}
        </div>
      </div>
      {canManage && (
        <div className={`flex w-full flex-wrap items-center justify-end gap-2 sm:w-auto ${viewMode === "grid" ? "mt-auto" : ""}`}>
          {canEditSourceOwnedConnectedApp(app.status) && (
            <Button
              variant="outline" size="md" type="button" onClick={handleEdit}>
              <Pencil size={14} />
              {formatMessage({ id: "settings.connectedApps.edit" })}
            </Button>
          )}
        </div>
      )}
    </SurfaceListItem>
  );
}
