import { useCallback } from "react";
import { AppCard } from "./AppCard";
import { canEditSourceOwnedConnectedApp } from "./connected-apps/connectedAppStatus";
import { CONNECTED_APPS_GRID_CLASS } from "./connected-apps/connectedAppCatalog";
import type { InstalledConnectedApp, ServerRegisteredApp } from "./connected-apps/connectedAppTypes";
import type { YoursApp } from "./yoursApps";

interface YoursAppActions {
  /** A Raft App this Server has: its installed detail (everyone may read it). */
  onOpenInstalled: (app: InstalledConnectedApp) => void;
  /** Its waiting update: today's review. */
  onReviewInstalled: (app: InstalledConnectedApp) => void;
  /** A connected service: its editor (App managers only). */
  onOpenService: (app: { id: string }) => void;
  /** Its accounts, where a sign-in is renewed and a failure is read. */
  onOpenServiceAccounts: (app: { id: string }) => void;
  /** A Raft App built here: its editor. */
  onEditBuilt: (app: ServerRegisteredApp) => void;
}

/**
 * One App under Yours as the redesign's card. The card opens what the App's
 * row opened, and its state button the state's step; a viewer who can't
 * open or act gets a card without that button (today's permission checks:
 * everyone reads an installed App's detail, only App managers open an editor).
 */
function YoursAppCard({ entry, canManage, makerName, onOpenInstalled, onReviewInstalled, onOpenService, onOpenServiceAccounts, onEditBuilt }: {
  entry: YoursApp;
  canManage: boolean;
  /** Who made an App built here ("Internal · made by"), when the Server's people still have them. */
  makerName: string | null;
} & YoursAppActions) {
  const opens = entry.kind === "installed"
    || (canManage && (entry.kind === "service" || canEditSourceOwnedConnectedApp(entry.app.status)));
  const handleOpen = useCallback(() => {
    if (entry.kind === "installed") onOpenInstalled(entry.app);
    else if (entry.kind === "service") onOpenService(entry.app);
    else onEditBuilt(entry.app);
  }, [entry, onEditBuilt, onOpenInstalled, onOpenService]);
  const handleAction = useCallback(() => {
    if (entry.kind === "installed") onReviewInstalled(entry.app);
    else if (entry.kind === "service") onOpenServiceAccounts(entry.app);
    else onEditBuilt(entry.app);
  }, [entry, onEditBuilt, onOpenServiceAccounts, onReviewInstalled]);
  return (
    <AppCard
      app={entry.view}
      variant="yours"
      creatorName={makerName}
      onOpen={opens ? handleOpen : undefined}
      onAction={canManage && opens ? handleAction : undefined}
      testId={`connected-app-item-${entry.app.id}`}
    />
  );
}

/**
 * Yours' collection: the redesign's card for every App. Edit and Uninstall
 * are in the installed detail the card opens.
 */
export function YoursAppsList({ apps, canManage, makerNames, onOpenInstalled, onReviewInstalled, onOpenService, onOpenServiceAccounts, onEditBuilt }: {
  apps: readonly YoursApp[];
  canManage: boolean;
  /** The Server's people by user id (`appMakerNames`): a card names who made an App built here. */
  makerNames: ReadonlyMap<string, string>;
} & YoursAppActions) {
  return (
    <div className={CONNECTED_APPS_GRID_CLASS} data-testid="connected-apps-yours-collection">
      {apps.map((entry) => (
        <YoursAppCard
          key={entry.key}
          entry={entry}
          canManage={canManage}
          makerName={entry.view.createdByUserId ? makerNames.get(entry.view.createdByUserId) ?? null : null}
          onOpenInstalled={onOpenInstalled}
          onReviewInstalled={onReviewInstalled}
          onOpenService={onOpenService}
          onOpenServiceAccounts={onOpenServiceAccounts}
          onEditBuilt={onEditBuilt}
        />
      ))}
    </div>
  );
}
