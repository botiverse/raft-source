import { useCallback, useEffect, useMemo, useState } from "react";
import { useIntl } from "react-intl";
import { Blocks, RefreshCw } from "lucide-react";
import { Button } from "@botiverse/raft-ui";
import type { MarketplaceCursor, MarketplaceListingsResponse } from "@botiverse/raft-shared";
import api from "../../api/client";
import Banner from "../../components/ui/Banner";
import EmptyState from "../../components/ui/EmptyState";
import { useListSkeletonShown } from "../../components/ui/useListSkeletonShown";
import { AppsNoMatchState } from "../../components/apps/AppsListParts";
import { hasActiveAppsFilters } from "../../components/apps/appsFilters";
import type { AppsFilters } from "../../components/apps/appsFilters";
import { AppCard, AppCardSkeleton } from "./AppCard";
import { listingView } from "./appView";
import type { AppView, AppViewContext } from "./appView";
import { CONNECTED_APPS_GRID_CLASS } from "./connected-apps/connectedAppCatalog";
import type { MarketplaceOAuthClientRecord } from "./connected-apps/oauthClientRecords";
import { appendListings, discoverListingParams, MARKETPLACE_LISTINGS_PATH } from "./discoverListings";
import type { DiscoverListing } from "./discoverListings";

type Page = MarketplaceListingsResponse<MarketplaceOAuthClientRecord>;

/** What one request (its filters, search and attempt) returned. */
type ListingsResult =
  | { key: string; status: "failed" }
  | { key: string; status: "loaded"; items: DiscoverListing[]; nextCursor: MarketplaceCursor | null; total: number; loadMoreFailed: boolean };

/** One listing as its card: the redesign's card in its Discover variant (Add, or Added). */
function DiscoverAppCard({ listing, view, onOpen, onAdd, addingId, addError }: {
  listing: DiscoverListing;
  view: AppView;
  onOpen: (listing: DiscoverListing) => void;
  onAdd?: (listing: DiscoverListing) => void;
  addingId: string | null;
  addError: string | undefined;
}) {
  const handleOpen = useCallback(() => onOpen(listing), [listing, onOpen]);
  const handleAdd = useCallback(() => onAdd?.(listing), [listing, onAdd]);
  return (
    <AppCard
      app={view}
      variant="discover"
      onOpen={handleOpen}
      onAdd={onAdd ? handleAdd : undefined}
      adding={addingId === listing.id}
      addDisabled={addingId !== null}
      addError={addError}
      testId={`apps-marketplace-row-${listing.id}`}
    />
  );
}

/** Six cards in the grid, after the 1s wait (raft-design Feedback); with Add's box for a viewer who adds Apps. */
function DiscoverCardSkeletons({ canManage }: { canManage: boolean }) {
  const shown = useListSkeletonShown();
  if (!shown) return null;
  return (
    <div className={CONNECTED_APPS_GRID_CLASS} data-testid="apps-marketplace-loading-collection">
      {Array.from({ length: 6 }, (_, index) => <AppCardSkeleton key={index} button={canManage} />)}
    </div>
  );
}

/**
 * Discover: pages of GET /integrations/marketplace/listings (Raft Apps and
 * Raft's connected services in one list), each as the same card Yours draws
 * (`AppCard`, `variant="discover"`). Category and search are the server's;
 * "Load more" asks for the next page with its cursor (the DS has no page
 * numbers).
 *
 * R41: every card opens the App's details (`onOpen`), whoever looks; only
 * the card's own Add adds it at once (`onAdd`, for the people who add Apps:
 * leave it out for anyone else, and the card has no Add). An App this Server
 * has says Added. A listing has no state of its own: no problem shows here.
 * While one Add runs (`addingId`) its card says Adding… and the others' Add
 * wait; a failed one says why on its card (`addError`).
 */
export function DiscoverAppsList({
  filters,
  query,
  context,
  reloadKey,
  onOpen,
  onAdd,
  addingId = null,
  addError = null,
  onClearFilters,
}: {
  filters: AppsFilters;
  /** The search text once typing has paused. */
  query: string;
  /** The viewer and the Server, for the cards' views; `canManage` also sizes the skeleton. */
  context: AppViewContext;
  /** Changes after an add or a removal, so the cards say Added. */
  reloadKey: number;
  onOpen: (listing: DiscoverListing) => void;
  onAdd?: (listing: DiscoverListing) => void;
  /** The listing whose Add is running; every other card's Add waits. */
  addingId?: string | null;
  /** The listing whose last Add failed, and why: said on its card. */
  addError?: { listingId: string; message: string } | null;
  onClearFilters: () => void;
}) {
  const { formatMessage } = useIntl();
  const { category } = filters;
  const [attempt, setAttempt] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  // The listing this view asks for; a result for another one is stale, and
  // until this one's arrives the cards are loading.
  const requestKey = JSON.stringify([category, query, reloadKey, attempt]);
  const [result, setResult] = useState<ListingsResult | null>(null);

  useEffect(() => {
    let ignore = false;
    api.get<Page>(MARKETPLACE_LISTINGS_PATH, { params: discoverListingParams({ category }, query) })
      .then(({ data }) => {
        if (ignore) return;
        setResult({
          key: requestKey,
          status: "loaded",
          items: Array.isArray(data?.items) ? data.items : [],
          nextCursor: data?.nextCursor ?? null,
          total: data?.total ?? 0,
          loadMoreFailed: false,
        });
      })
      .catch(() => {
        if (!ignore) setResult({ key: requestKey, status: "failed" });
      });
    return () => {
      ignore = true;
    };
  }, [category, query, requestKey]);

  const state = result?.key === requestKey ? result : null;
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  const nextCursor = state?.status === "loaded" ? state.nextCursor : null;
  const loadMore = useCallback(async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    const markFailed = () => setResult((current) => (current?.status === "loaded" && current.key === requestKey ? { ...current, loadMoreFailed: true } : current));
    try {
      const { data } = await api.get<Page>(MARKETPLACE_LISTINGS_PATH, { params: discoverListingParams({ category }, query, nextCursor) });
      setResult((current) => (current?.status === "loaded" && current.key === requestKey && current.nextCursor === nextCursor
        ? { ...current, items: appendListings(current.items, data?.items ?? []), nextCursor: data?.nextCursor ?? null, total: data?.total ?? current.total, loadMoreFailed: false }
        : current));
    } catch (error) {
      // A cursor the server no longer takes (INVALID_CURSOR): start the listing over.
      const code = (error as { response?: { data?: { code?: string } } })?.response?.data?.code;
      if (code === "INVALID_CURSOR") retry();
      else markFailed();
    } finally {
      setLoadingMore(false);
    }
  }, [category, nextCursor, query, requestKey, retry]);
  const handleLoadMore = useCallback(() => { void loadMore(); }, [loadMore]);

  const items = state?.status === "loaded" ? state.items : null;
  const views = useMemo(() => items?.map((listing) => ({ listing, view: listingView(listing, context) })) ?? [], [context, items]);

  if (state?.status === "failed") {
    return (
      <Banner
        intent="warning"
        density="sm"
        live={false}
        data-testid="apps-marketplace-load-failed"
        actions={(
          <Button type="button" variant="outline" size="md" onClick={retry}>
            <RefreshCw size={16} />
            {formatMessage({ id: "apps.retry" })}
          </Button>
        )}
      >
        {formatMessage({ id: "apps.marketplace.loadFailed" })}
      </Banner>
    );
  }
  if (!state) {
    return (
      <div aria-busy="true" data-testid="apps-marketplace-loading">
        <DiscoverCardSkeletons canManage={context.canManage} />
      </div>
    );
  }
  if (state.items.length === 0) {
    return hasActiveAppsFilters(filters, "discover")
      ? <AppsNoMatchState title={formatMessage({ id: "settings.connectedApps.noMarketplaceMatch" })} scope="discover" filters={filters} onClearAll={onClearFilters} />
      : (
        <EmptyState
          className="py-10"
          icon={<Blocks size={36} />}
          title={formatMessage({ id: "apps.marketplace.emptyTitle" })}
          description={formatMessage({ id: "apps.marketplace.emptyDescription" })}
          data-testid="apps-marketplace-empty"
        />
      );
  }
  return (
    <div className="flex flex-col gap-3" data-testid="apps-marketplace-list">
      <div className={CONNECTED_APPS_GRID_CLASS} data-testid="connected-apps-marketplace-collection">
        {views.map(({ listing, view }) => (
          <DiscoverAppCard
            key={listing.id}
            listing={listing}
            view={view}
            onOpen={onOpen}
            onAdd={onAdd}
            addingId={addingId}
            addError={addError?.listingId === listing.id ? addError.message : undefined}
          />
        ))}
      </div>
      {state.loadMoreFailed ? (
        <Banner intent="warning" density="sm" live={false} data-testid="apps-marketplace-load-more-failed">
          {formatMessage({ id: "apps.marketplace.loadMoreFailed" })}
        </Banner>
      ) : null}
      <div className="flex items-center justify-center gap-3">
        <span className="font-mono text-mono-meta text-foreground-muted" data-testid="apps-marketplace-showing">
          {formatMessage({ id: "apps.marketplace.showing" }, { shown: state.items.length, total: state.total })}
        </span>
        {state.nextCursor ? (
          <Button type="button" variant="outline" size="md" disabled={loadingMore} onClick={handleLoadMore} data-testid="apps-marketplace-load-more">
            {formatMessage({ id: loadingMore ? "common.loadingLabel" : "apps.marketplace.loadMore" })}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
