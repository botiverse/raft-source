import { useListSkeletonShown } from "../../components/ui/useListSkeletonShown";
import { AppCardSkeleton } from "./AppCard";
import { CONNECTED_APPS_GRID_CLASS } from "./connected-apps/connectedAppCatalog";

/**
 * Yours while it loads: card placeholders in the grid the Apps will be in,
 * after the 1s wait (raft-design Feedback), so the Apps land where these
 * were (#proj-raft-ui:#231). A card has a button only when something waits,
 * so its placeholder has none.
 */
export function InstalledAppsSkeleton() {
  const shown = useListSkeletonShown();
  return (
    <div aria-busy="true" data-testid="apps-loading">
      {shown ? (
        <div className={CONNECTED_APPS_GRID_CLASS} data-testid="apps-loading-collection">
          {Array.from({ length: 4 }, (_, index) => <AppCardSkeleton key={index} />)}
        </div>
      ) : null}
    </div>
  );
}
