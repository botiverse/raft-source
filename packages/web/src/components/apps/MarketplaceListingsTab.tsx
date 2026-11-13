import { useCallback, useEffect, useState } from "react";
import type { MouseEvent, ReactNode } from "react";
import { useIntl } from "react-intl";
import { Blocks, RefreshCw } from "lucide-react";
import {
  Badge,
  Card,
  Button,
  ListRow,
  ListRowBody,
  ListRowBottom,
  ListRowDescription,
  ListRowMeta,
  ListRowTitle,
  ListRowTop,
  Skeleton,
} from "@botiverse/raft-ui";
import { MARKETPLACE_INSTALL_BUCKET_LABELS } from "@botiverse/raft-shared";
import type { MarketplaceCursor, MarketplaceListing, MarketplaceListingsResponse, MarketplaceMcpListing } from "@botiverse/raft-shared";
import api from "../../api/client";
import { useTimeFormatter } from "../../hooks/useTimeFormatter";
import Banner from "../ui/Banner";
import EmptyState from "../ui/EmptyState";
import { ListRowSkeletonList, SkeletonTextBar } from "../ui/Skeleton";
import { SKELETON_BADGE_CLASS, SKELETON_BUTTON_MD_CLASS } from "../ui/skeletonBoxes";
import { useListSkeletonShown } from "../ui/useListSkeletonShown";
import { CONNECTED_APP_CATEGORY_LABEL_ID, CONNECTED_APP_INSTALL_CUE_CLASS } from "../../features/apps/connected-apps/connectedAppCatalog";
import { ConnectedAppLogo } from "../settings/ConnectedAppLogo";
import { ConnectedAppMarketplaceInstallBadge } from "../../features/apps/connected-apps/ConnectedAppMarketplaceInstallBadge";
import { connectedAppsCollectionClassName } from "../../features/apps/connected-apps/connectedAppsViewMode";
import { mapClientToMarketplaceApp } from "../../features/apps/connected-apps/connectedAppMapping";
import type { ConnectedAppListing, ConnectedAppsViewMode } from "../../features/apps/connected-apps/connectedAppTypes";
import type { MarketplaceOAuthClientRecord } from "../../features/apps/connected-apps/oauthClientRecords";
import { AppsNoMatchState, McpTag } from "./AppsListParts";
import type { AppsFilters } from "./appsFilters";

export const MARKETPLACE_LISTINGS_PATH = "/integrations/marketplace/listings";

type Listing = MarketplaceListing<MarketplaceOAuthClientRecord>;
/**
 * What a Marketplace card draws: a listing, without the id the listings
 * endpoint mints for it (the card's test id says which one it is). The
 * Apps page's recommendations draw one from the App's record.
 */
export type MarketplaceCardListing = Listing extends infer L ? (L extends Listing ? Omit<L, "id"> : never) : never;
type Page = MarketplaceListingsResponse<MarketplaceOAuthClientRecord>;

/** What one request (its filters, search and attempt) returned. */
type ListingsResult =
  | { key: string; status: "failed" }
  | { key: string; status: "loaded"; items: Listing[]; nextCursor: MarketplaceCursor | null; total: number; loadMoreFailed: boolean };

/**
 * The next page after the ones shown. The cursor is a position in the sort
 * (an install bucket, for the default sort), so an App that changed bucket
 * between two requests can come again: it keeps its first place.
 */
export function appendListings<T extends { id: string }>(shown: T[], next: T[]): T[] {
  const seen = new Set(shown.map((listing) => listing.id));
  return [...shown, ...next.filter((listing) => !seen.has(listing.id))];
}

function listingParams(filters: Pick<AppsFilters, "type" | "category" | "sort">, q: string, cursor?: MarketplaceCursor) {
  return {
    ...(filters.type !== "all" ? { type: filters.type } : {}),
    ...(filters.category !== "all" ? { category: filters.category } : {}),
    sort: filters.sort,
    ...(q ? { q } : {}),
    ...(cursor ? { cursor } : {}),
  };
}

/**
 * The Marketplace tab (#proj-apps task #22): pages of GET
 * /integrations/marketplace/listings, Apps and Raft-recommended MCP Apps in
 * one list. Type, category, search and sort are the server's; "Load More"
 * asks for the next page with its cursor (the DS has no page numbers).
 */
export function MarketplaceListingsTab({
  filters,
  viewMode,
  query,
  canManage,
  reloadKey,
  onOpenApp,
  onInstallMcp,
  installingTemplateKey,
  onClearFilters,
  botHint,
}: {
  filters: AppsFilters;
  /** Cards in a grid, or rows. */
  viewMode: ConnectedAppsViewMode;
  /** The search text once typing has paused. */
  query: string;
  canManage: boolean;
  /** Changes after an install, so the rows say Installed. */
  reloadKey: number;
  onOpenApp: (listing: ConnectedAppListing) => void;
  /** A Raft template's Install: installs it at once (no form in between). */
  onInstallMcp: (listing: MarketplaceMcpListing) => Promise<void>;
  /** The template whose Install is running: its row says Installing…, and no row takes a click. */
  installingTemplateKey: string | null;
  onClearFilters: () => void;
  /**
   * What an App's card says about its bot (#proj-apps:#35 layer 2), by the
   * App's id (`listing.app.id`, the installed list's id; the listing's own id
   * is opaque); null for nothing, which is every App this Server hasn't
   * installed or whose bot is decided.
   */
  botHint?: (appId: string) => ReactNode;
}) {
  const { formatMessage } = useIntl();
  const { type, category, sort } = filters;
  const [attempt, setAttempt] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  // The listing this view asks for; a result for another one is stale, and
  // until this one's arrives the rows are loading.
  const requestKey = JSON.stringify([type, category, sort, query, reloadKey, attempt]);
  const [result, setResult] = useState<ListingsResult | null>(null);

  useEffect(() => {
    let ignore = false;
    api.get<Page>(MARKETPLACE_LISTINGS_PATH, { params: listingParams({ type, category, sort }, query) })
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
  }, [category, query, requestKey, sort, type]);

  const state = result?.key === requestKey ? result : null;
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  const nextCursor = state?.status === "loaded" ? state.nextCursor : null;
  const loadMore = useCallback(async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    const markFailed = () => setResult((current) => (current?.status === "loaded" && current.key === requestKey ? { ...current, loadMoreFailed: true } : current));
    try {
      const { data } = await api.get<Page>(MARKETPLACE_LISTINGS_PATH, { params: listingParams({ type, category, sort }, query, nextCursor) });
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
  }, [category, nextCursor, query, requestKey, retry, sort, type]);
  const handleLoadMore = useCallback(() => { void loadMore(); }, [loadMore]);

  const handleOpen = useCallback((listing: Listing) => {
    if (listing.kind === "app") onOpenApp(mapClientToMarketplaceApp(listing.app, formatMessage));
    else if (canManage && !listing.installed && installingTemplateKey === null) void onInstallMcp(listing);
  }, [canManage, formatMessage, installingTemplateKey, onInstallMcp, onOpenApp]);

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
        {viewMode === "grid" ? <MarketplaceCardSkeletons canManage={canManage} /> : <ListRowSkeletonList count={6} description />}
      </div>
    );
  }
  if (state.items.length === 0) {
    return filters.search.trim() || type !== "all" || category !== "all"
      ? <AppsNoMatchState title={formatMessage({ id: "settings.connectedApps.noMarketplaceMatch" })} filters={filters} onClearAll={onClearFilters} />
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
      <div
        className={viewMode === "grid" ? connectedAppsCollectionClassName("grid") : "flex flex-col"}
        data-testid="connected-apps-marketplace-collection"
        data-view={viewMode}
      >
        {state.items.map((listing) => (
          <MarketplaceListingRow
            key={listing.id}
            listing={listing}
            testId={`apps-marketplace-row-${listing.id}`}
            viewMode={viewMode}
            canManage={canManage}
            installing={listing.kind === "mcp" && listing.templateKey === installingTemplateKey}
            botHint={listing.kind === "app" ? botHint?.(listing.app.id) ?? null : null}
            onOpen={handleOpen}
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

// A grid card's parts, shared with its skeleton (MarketplaceCardSkeleton).
const CARD_CLASS = "h-full w-full p-3 text-left outline-none";
const CARD_HEAD_CLASS = "flex items-start gap-3";
const CARD_NAME_LINE_CLASS = "flex flex-wrap items-center gap-2";
const CARD_NAME_CLASS = "text-body font-semibold text-foreground";
const CARD_BY_LINE_CLASS = "mt-0.5 text-footnote text-foreground-muted";
const CARD_FOOT_CLASS = "mt-auto flex flex-wrap items-center justify-end gap-2 pt-3";

/**
 * A Marketplace card while the listings load: the grid card's own Card, the
 * logo's 51px box, bars in the name and by-line, and in the foot the box of
 * what it will hold (Install, a button's box, for owners and admins; a badge's
 * otherwise).
 */
export function MarketplaceCardSkeleton({ canManage }: { canManage: boolean }) {
  return (
    <Card className={CARD_CLASS} aria-hidden="true" data-skeleton="">
      <div className={CARD_HEAD_CLASS}>
        <Skeleton className="size-[51px] shrink-0" />
        <div className="min-w-0 flex-1">
          <div className={CARD_NAME_LINE_CLASS}><div className={CARD_NAME_CLASS}><SkeletonTextBar className="w-28" /></div></div>
          {/* Below md the by-line wraps in the card's narrow text column: two lines. */}
          <div className={CARD_BY_LINE_CLASS}>
            <div><SkeletonTextBar className="w-40 max-w-full" /></div>
            <div className="md:hidden"><SkeletonTextBar className="w-24" /></div>
          </div>
        </div>
      </div>
      <div className={CARD_FOOT_CLASS}>
        <Skeleton className={canManage ? `w-16 ${SKELETON_BUTTON_MD_CLASS}` : `w-20 ${SKELETON_BADGE_CLASS}`} />
      </div>
    </Card>
  );
}

/** Six cards in the loaded grid, after the 1s wait (raft-design Feedback). */
function MarketplaceCardSkeletons({ canManage }: { canManage: boolean }) {
  const shown = useListSkeletonShown();
  if (!shown) return null;
  return (
    <div className={connectedAppsCollectionClassName("grid")} data-view="grid" data-testid="apps-marketplace-loading-collection">
      {Array.from({ length: 6 }, (_, index) => <MarketplaceCardSkeleton key={index} canManage={canManage} />)}
    </div>
  );
}

/**
 * One Marketplace listing as a ListRow: logo, the name with the MCP tag after
 * it, the published date as meta; category, developer and description below
 * with the install bucket as its one badge; on the right Installed, the
 * Install cue (owners and admins) or Available. In the grid view it is the
 * card Settings had: logo, name and badge, the by-line, the cue at the foot.
 * The Apps page's recommendations draw the same card with their own line
 * (`summary`) in place of the by-line and description.
 */
export function MarketplaceListingRow<L extends MarketplaceCardListing>({
  listing,
  testId,
  viewMode,
  canManage,
  installing,
  botHint,
  summary,
  onOpen,
}: {
  listing: L;
  testId: string;
  viewMode: ConnectedAppsViewMode;
  canManage: boolean;
  /** This template's one-step Install is running. */
  installing: boolean;
  /** Its bot's Add (or who can add it), a control of its own on the card. */
  botHint: ReactNode;
  /** Why it is recommended: one line in place of the by-line (and, in a row, the description). */
  summary?: string;
  onOpen: (listing: L) => void;
}) {
  const { formatMessage } = useIntl();
  const { formatCompactDate } = useTimeFormatter();
  const app = listing.kind === "app" ? mapClientToMarketplaceApp(listing.app, formatMessage) : null;
  const name = app?.name ?? listing.name;
  // A recommendation's own line stands for the description too.
  const description = summary === undefined ? app?.description ?? listing.description : null;
  const categoryLabel = formatMessage({ id: CONNECTED_APP_CATEGORY_LABEL_ID[listing.category] ?? "settings.connectedApps.categoryOther" });
  // A Raft template's Install installs it in one step; once this server has
  // one, or for a member, there is nothing to press.
  const interactive = listing.kind === "app" || (canManage && !listing.installed);
  const handleClick = useCallback((event: MouseEvent) => {
    event.preventDefault();
    onOpen(listing);
  }, [listing, onOpen]);
  // A recommended MCP App is Raft's: "Maintained by Raft" says who, so it
  // stands alone rather than inside "by {developer}".
  const byLine = summary ?? (app
    ? formatMessage({ id: "settings.connectedApps.byLine" }, { category: categoryLabel, developer: app.developer })
    : formatMessage({ id: "apps.marketplace.raftByLine" }, { category: categoryLabel }));
  const installBadge = app ? (
    // An App's own install badge: its bucket, or New while it is new on the Marketplace.
    <ConnectedAppMarketplaceInstallBadge badge={app.marketplaceInstallBadge} />
  ) : listing.installBucket ? (
    <Badge appearance="outline" className="shrink-0" data-testid="apps-marketplace-install-bucket">
      {formatMessage({ id: "settings.connectedApps.marketplaceInstallCount" }, { count: MARKETPLACE_INSTALL_BUCKET_LABELS[listing.installBucket] })}
    </Badge>
  ) : null;
  const status = listing.installed ? (
    <Badge appearance="soft" variant="success">{formatMessage({ id: "settings.connectedApps.installed" })}</Badge>
  ) : canManage ? (
    <span className={CONNECTED_APP_INSTALL_CUE_CLASS} data-testid="apps-marketplace-install-cue">
      {formatMessage({ id: installing ? "settings.connectedApps.installing" : "settings.connectedApps.install" })}
    </span>
  ) : (
    <Badge appearance="soft" variant="muted">{formatMessage({ id: "settings.connectedApps.available" })}</Badge>
  );
  // With the bot's Add on it, the card can't be one button (no button in a
  // button): a button named after the App covers it and opens it, and the
  // Add sits above that one, a control of its own (as a file card's actions
  // over its link, DS MessageAttachment). The card shows the cover's hover,
  // press and focus.
  const open = botHint ? (
    <button type="button" aria-label={name} onClick={handleClick} data-listing-open className="absolute inset-0 rounded-[inherit] outline-none" />
  ) : null;
  const openStates = "relative has-[[data-listing-open]:hover]:overlay-subtle has-[[data-listing-open]:active]:overlay-medium has-[[data-listing-open]:focus-visible]:shadow-focus";
  const hint = botHint ? <div className="relative" data-testid="apps-marketplace-bot-hint">{botHint}</div> : null;
  const logo = <ConnectedAppLogo name={listing.name} logoUrl={listing.logoUrl} seed={listing.kind === "mcp" ? listing.templateKey : listing.app.clientId} />;
  if (viewMode === "grid") {
    return (
      <Card
        {...(interactive && !open ? { render: <button type="button" onClick={handleClick} /> } : {})}
        className={`${CARD_CLASS} ${open ? openStates : interactive ? "hover:overlay-subtle active:overlay-medium focus-visible:shadow-focus" : ""}`}
        data-testid={testId}
        data-kind={listing.kind}
      >
        {open}
        <div className={CARD_HEAD_CLASS}>
          {logo}
          <div className="min-w-0 flex-1">
            <div className={CARD_NAME_LINE_CLASS}>
              <div className={CARD_NAME_CLASS}>{name}</div>
              {listing.kind === "mcp" ? <McpTag /> : null}
              {installBadge}
            </div>
            <div className={CARD_BY_LINE_CLASS}>{byLine}</div>
          </div>
        </div>
        <div className={CARD_FOOT_CLASS}>
          {hint ? <div className="mr-auto">{hint}</div> : null}
          {status}
        </div>
      </Card>
    );
  }
  return (
    <ListRow
      interactive={interactive && !open}
      {...(interactive && !open ? { onClick: handleClick } : {})}
      className={`items-center ${open ? openStates : ""}`}
      data-testid={testId}
      data-kind={listing.kind}
    >
      {open}
      {logo}
      <ListRowBody>
        <ListRowTop>
          <ListRowTitle className="flex min-w-0 items-center gap-1.5">
            <span className="truncate">{name}</span>
            {listing.kind === "mcp" ? <McpTag /> : null}
          </ListRowTitle>
          {listing.publishedAt ? <ListRowMeta>{formatCompactDate(listing.publishedAt)}</ListRowMeta> : null}
        </ListRowTop>
        <ListRowBottom>
          <ListRowDescription>
            <span>{byLine}</span>
            {description ? <span aria-hidden="true"> · </span> : null}
            {description ? <span>{description}</span> : null}
          </ListRowDescription>
          {installBadge}
        </ListRowBottom>
        {hint ? <div className="mt-2">{hint}</div> : null}
      </ListRowBody>
      <span className="ml-2 shrink-0">{status}</span>
    </ListRow>
  );
}
