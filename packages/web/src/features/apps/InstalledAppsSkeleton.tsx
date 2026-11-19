import { InstalledConnectedAppItemSkeleton } from "../../components/settings/InstalledConnectedAppItem";
import { useListSkeletonShown } from "../../components/ui/useListSkeletonShown";
import type { ConnectedAppsViewMode } from "./connected-apps/connectedAppTypes";
import { connectedAppsCollectionClassName } from "./connected-apps/connectedAppsViewMode";

/**
 * Installed while it loads: item placeholders in the collection the Apps will
 * be in, in its view (the grid's cards or the list's rows), after the 1s wait
 * (raft-design Feedback), so the Apps land where these were (#proj-raft-ui:#231).
 */
export function InstalledAppsSkeleton({ viewMode, canManage }: { viewMode: ConnectedAppsViewMode; canManage: boolean }) {
  const shown = useListSkeletonShown();
  return (
    <div aria-busy="true" data-testid="apps-loading">
      {shown ? (
        <div className={connectedAppsCollectionClassName(viewMode)} data-view={viewMode} data-testid="apps-loading-collection">
          {Array.from({ length: 4 }, (_, index) => <InstalledConnectedAppItemSkeleton key={index} viewMode={viewMode} canManage={canManage} />)}
        </div>
      ) : null}
    </div>
  );
}
