import { AvatarBadge, Badge, Button, Skeleton, Status } from "@botiverse/raft-ui";
import type { AvatarBadgeOffset } from "@botiverse/raft-ui";
import { useCallback } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { Pencil } from "lucide-react";
import { useIntl } from "react-intl";
import SurfaceListItem from "../ui/SurfaceListItem";
import { SkeletonTextBar } from "../ui/Skeleton";
import { SKELETON_BADGE_CLASS, SKELETON_BUTTON_MD_CLASS } from "../ui/skeletonBoxes";
import { McpTag } from "../apps/AppsListParts";
import { ConnectedAppLogo } from "./ConnectedAppLogo";
import { CONNECTED_APP_CATEGORY_LABEL_ID } from "../../features/apps/connected-apps/connectedAppCatalog";
import { ConnectedAppDistributionBadge } from "../../features/apps/connected-apps/ConnectedAppDistributionBadge";
import { ConnectedAppOriginBadges } from "../../features/apps/connected-apps/ConnectedAppOriginBadges";
import { ConnectedAppSummary } from "../../features/apps/connected-apps/ConnectedAppSummary";
import { ConnectedAppUrlLink } from "../../features/apps/connected-apps/ConnectedAppUrlLink";
import type { ConnectedAppsViewMode, InstalledConnectedApp } from "../../features/apps/connected-apps/connectedAppTypes";

// The item's parts, shared with its skeleton (InstalledConnectedAppItemSkeleton).
const ITEM_GRID_CLASS = "flex min-h-[184px] w-full flex-col gap-3";
const ITEM_LIST_CLASS = "flex w-full flex-col gap-3 sm:flex-row sm:items-center sm:justify-between";
const ITEM_MAIN_CLASS = "flex min-w-0 flex-1 items-start gap-3";
const ITEM_NAME_LINE_CLASS = "flex min-w-0 flex-wrap items-center gap-1.5";
const ITEM_NAME_CLASS = "min-w-0 break-words text-body font-semibold text-foreground";
const ITEM_BY_LINE_CLASS = "mt-0.5 text-footnote text-foreground-muted";
const ITEM_BADGES_CLASS = "mt-2 flex flex-wrap items-center gap-1.5";
const itemActionsClass = (viewMode: ConnectedAppsViewMode) => (viewMode === "grid"
  ? "flex w-full flex-wrap justify-end gap-2 sm:w-auto mt-auto self-end"
  : "flex w-full flex-wrap justify-end gap-2 sm:w-auto self-end sm:self-auto");

/** The attention pixel's centre on the logo's top-right corner (DS ListRow › States). */
const TOP_RIGHT: AvatarBadgeOffset = ["100%", 0];

export function InstalledConnectedAppItem({
  app,
  viewMode,
  canManage,
  uninstalling,
  onOpen,
  onEdit,
  onRequestUninstall,
  testId,
  mcp = false,
  botAvailable = false,
}: {
  app: InstalledConnectedApp;
  viewMode: ConnectedAppsViewMode;
  canManage: boolean;
  uninstalling: boolean;
  onOpen: (app: InstalledConnectedApp) => void;
  onEdit: (app: InstalledConnectedApp) => void;
  onRequestUninstall: (app: InstalledConnectedApp) => void;
  testId?: string;
  /** An MCP App: the row is the ordinary one plus the MCP tag after its name (its type). */
  mcp?: boolean;
  /**
   * The App's bot can still be added here, and the viewer can add it (f1).
   * Grey text in the secondary line, like the category and developer: an
   * optional thing to do is not a badge and not counted with the permission
   * updates.
   */
  botAvailable?: boolean;
}) {
  const { formatMessage } = useIntl();
  const handleOpen = useCallback(() => onOpen(app), [app, onOpen]);
  const handleEdit = useCallback(() => onEdit(app), [app, onEdit]);
  const handleRequestUninstall = useCallback((event: ReactMouseEvent) => {
    event.stopPropagation();
    onRequestUninstall(app);
  }, [app, onRequestUninstall]);
  // Another Server's App, or one built here that this Server has installed:
  // the name opens its installed detail (permissions, Approve update).
  const opensDetail = !app.editable || app.installedHere === true;
  // Something on it waits for an owner or admin (#proj-apps task #24): the
  // pink attention pixel on the logo's corner, gone once it is handled.
  const attention = canManage && app.needsAdminReview === true;
  const categoryLabel = formatMessage({ id: CONNECTED_APP_CATEGORY_LABEL_ID[app.category] ?? "settings.connectedApps.categoryOther" });

  return (
    <SurfaceListItem
      interactive={false}
      data-testid={testId}
      data-needs-admin-review={attention ? "true" : undefined}
      className={viewMode === "grid" ? ITEM_GRID_CLASS : ITEM_LIST_CLASS}
    >
      <div className={ITEM_MAIN_CLASS}>
        <span className="relative inline-flex shrink-0">
          <ConnectedAppLogo name={app.name} logoUrl={app.logoUrl} seed={app.defaultLogoSeed} size="sm" />
          {attention ? (
            <AvatarBadge
              offset={TOP_RIGHT}
              data-testid="apps-row-attention-dot"
              render={<Status role="img" aria-label={formatMessage({ id: "apps.row.needsReview" })} variant="accent" size="sm" />}
            />
          ) : null}
        </span>
        <div className="min-w-0 flex-1">
          <div className={ITEM_NAME_LINE_CLASS}>
          {!opensDetail ? (
            <div className={ITEM_NAME_CLASS}>{app.name}</div>
          ) : (
            <div
              role="button"
              tabIndex={0}
              aria-label={app.name}
              onClick={() => onOpen(app)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " " && event.key !== "Spacebar") return;
                event.preventDefault();
                onOpen(app);
              }}
              className="w-fit max-w-full break-words rounded-sticker text-body font-semibold text-foreground decoration-[1.5px] underline-offset-[3px] outline-none hover:underline focus-visible:shadow-focus"
            >
              {app.name}
            </div>
          )}
          {mcp ? <McpTag /> : null}
          </div>
          <div className={ITEM_BY_LINE_CLASS}>
            {/* Where it came from: another Server's Raft App is "by {developer}";
                an MCP App's developer is already its source (Maintained by
                Raft, Custom), as is this Server's own App's. */}
            {app.origin === "marketplace" ? (
              <span>{formatMessage({ id: "settings.connectedApps.byLine" }, { category: categoryLabel, developer: app.developer })}</span>
            ) : (
              <>
                <span>{categoryLabel}</span>
                <span aria-hidden="true"> · </span>
                <span>{app.developer}</span>
              </>
            )}
            {botAvailable ? (
              <>
                <span aria-hidden="true"> · </span>
                <span data-testid="connected-app-bot-available">{formatMessage({ id: "settings.connectedApps.appIdentity.available" })}</span>
              </>
            ) : null}
          </div>
          <div className={ITEM_BADGES_CLASS}>
            <ConnectedAppDistributionBadge status={app.publishStatus} />
            {/* An MCP App's source is its line above; no This server badge. */}
            {mcp ? null : <ConnectedAppOriginBadges app={app} />}
            {app.permissionApprovalRequired ? (
              <Badge appearance="soft" variant="warning" data-testid="app-permission-approval-required">
                {formatMessage({ id: "settings.connectedApps.permissionUpdateRequired" })}
              </Badge>
            ) : null}
            {app.promptTextConfirmationRequired ? (
              <Badge appearance="soft" variant="warning" data-testid="app-prompt-text-needs-confirmation">
                {formatMessage({ id: "appPromptText.needsConfirmation" })}
              </Badge>
            ) : null}
          </div>
          {viewMode === "list" && (
            <ConnectedAppSummary description={app.description} />
          )}
          {viewMode === "grid" && (
            <ConnectedAppUrlLink url={app.homepageUrl} label={app.homepageDomain} className="mt-1" />
          )}
        </div>
      </div>
      {canManage && (app.editable ? (
        <div className={`flex flex-wrap justify-end gap-2 ${viewMode === "grid" ? "mt-auto self-end" : "self-end sm:self-auto"}`}>
        {app.permissionApprovalRequired ? <Button type="button" variant="outline" size="md" onClick={handleOpen}>
          {formatMessage({ id: "settings.connectedApps.reviewPermissionUpdate" })}
        </Button> : null}
        <Button size="md" variant="outline"
          type="button"
          onClick={handleEdit}
          className={`w-fit ${viewMode === "grid" ? "mt-auto self-end" : "self-end sm:self-auto"}`}
        >
          <Pencil size={14} />
          {formatMessage({ id: "settings.connectedApps.edit" })}
        </Button>
        </div>
      ) : (
        <div className={itemActionsClass(viewMode)}>
          {app.permissionApprovalRequired ? (
            <Button type="button" variant="outline" size="md" onClick={handleOpen}>
              {formatMessage({ id: "settings.connectedApps.reviewPermissionUpdate" })}
            </Button>
          ) : null}
          <Button
            variant="outline" size="md"
            type="button"
            onClick={handleRequestUninstall}
            disabled={uninstalling}
          >
            {uninstalling ? formatMessage({ id: "settings.connectedApps.uninstalling" }) : formatMessage({ id: "settings.connectedApps.uninstall" })}
          </Button>
        </div>
      ))}
    </SurfaceListItem>
  );
}

/**
 * An installed App while the list loads, in the view it will show: the item's
 * own card (in the grid, its 184px card; in the list, its row) with the
 * logo's 35px box, bars in the name and by-line (two lines below md), a badge's box, one line of
 * the summary (list) or the homepage (grid), and, for those who manage Apps,
 * a button's box where Uninstall or Edit goes (#proj-raft-ui:#231).
 */
export function InstalledConnectedAppItemSkeleton({ viewMode, canManage }: { viewMode: ConnectedAppsViewMode; canManage: boolean }) {
  return (
    <SurfaceListItem interactive={false} className={viewMode === "grid" ? ITEM_GRID_CLASS : ITEM_LIST_CLASS} aria-hidden="true" data-skeleton="">
      <div className={ITEM_MAIN_CLASS}>
        <Skeleton className="size-[35px] shrink-0" />
        <div className="min-w-0 flex-1">
          <div className={ITEM_NAME_LINE_CLASS}>
            <div className={ITEM_NAME_CLASS}><SkeletonTextBar className="w-32" /></div>
          </div>
          {/* Below md the by-line wraps in the narrow column: two lines. */}
          <div className={ITEM_BY_LINE_CLASS}>
            <div><SkeletonTextBar className="w-48 max-w-full" /></div>
            <div className="md:hidden"><SkeletonTextBar className="w-24" /></div>
          </div>
          <div className={ITEM_BADGES_CLASS}><Skeleton className={`w-20 ${SKELETON_BADGE_CLASS}`} /></div>
          {viewMode === "list" ? (
            <div className="mt-1 text-callout"><SkeletonTextBar className="w-64 max-w-full" /></div>
          ) : (
            // The homepage link's box (ConnectedAppUrlLink): inline-flex on the column's line.
            <span className="mt-1 inline-flex max-w-full min-w-0 items-center font-mono text-mono-meta">
              <span className="min-w-0 truncate"><SkeletonTextBar className="w-28" /></span>
            </span>
          )}
        </div>
      </div>
      {canManage ? (
        <div className={itemActionsClass(viewMode)}><Skeleton className={`w-24 ${SKELETON_BUTTON_MD_CLASS}`} /></div>
      ) : null}
    </SurfaceListItem>
  );
}
