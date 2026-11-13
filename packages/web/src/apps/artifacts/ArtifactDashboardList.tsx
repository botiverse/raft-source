import { useCallback, useMemo } from "react";
import type { ChangeEvent, ReactNode, Ref } from "react";
import { useIntl } from "react-intl";
import { Search, TriangleAlert } from "lucide-react";
import {
  Banner,
  BannerAction,
  BannerDescription,
  Button,
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  ScrollArea,
} from "@botiverse/raft-ui";
import { ArtifactIcon } from "@botiverse/ricons";
import { WEB_SEARCH_QUERY_MAX_CHARS } from "@botiverse/raft-shared";
import type { ArtifactCard, ArtifactDashboardAuthor } from "@botiverse/raft-shared";

import EmptyState from "../../components/ui/EmptyState";
import { ArtifactAuthorFilter } from "./ArtifactAuthorFilter";
import { ArtifactConversationFilter } from "./ArtifactConversationFilter";
import { allItems } from "./artifactDashboardItems";
import type { ArtifactDashboardItem } from "./artifactDashboardItems";
import { ArtifactsTable } from "./ArtifactsTable";
import { ArtifactTile } from "./ArtifactTile";
import { SKELETON_TABLE_ROWS, TILE_GRID_CLASS } from "./artifactDashboardParts";
import { ArtifactDashboardSkeleton } from "./ArtifactDashboardSkeleton";
import type { AllArtifacts, ArtifactPlace, DashboardLayout, OpenRow, TableProps } from "./artifactDashboardParts";
import type { ArtifactHomeSort } from "./artifactDashboardPrefs";
import { DashboardToolbar, RelevantToggle, SortPicker } from "./ArtifactDashboardToolbar";
import { DASHBOARD_SEARCH_CLASS } from "./artifactDashboardToolbarLayout";
import { AllRow } from "./ArtifactDashboardRows";

/**
 * The home page's one list (#proj-workspace:#210): the filter bar, then every
 * Artifact the reader can see, in the order the sort asks the server for
 * (recently opened by default; the bar is the only place that sorts, and what the
 * rows' time says follows the rows on screen, `pageByOpened`), "Load More" for the
 * next page. 和我有关 narrows it to what concerns the reader, in an order the
 * server fixes: no sort then. Skeleton rows while the first page loads, an empty state
 * (the table keeps its header row over it), a warning with Retry when a read fails.
 */
export function DashboardList({ all, place, onPlace, author, onAuthor, search, onSearch, query, relevant, onRelevant, sort, onSort, listRef, onOpen, layout, phone, view, readerId, table }: {
  all: AllArtifacts;
  place: ArtifactPlace | null;
  onPlace: (place: ArtifactPlace | null) => void;
  author: ArtifactDashboardAuthor | null;
  onAuthor: (author: ArtifactDashboardAuthor | null) => void;
  /** What the field holds now. */
  search: string;
  onSearch: (search: string) => void;
  /** The settled search the rows are read for. */
  query: string;
  relevant: boolean;
  onRelevant: (relevant: boolean) => void;
  /** The sort the reader chose (kept on the device; the server sorts): 和我有关 leaves it as it is. */
  sort: ArtifactHomeSort;
  onSort: (sort: ArtifactHomeSort) => void;
  listRef: Ref<HTMLDivElement>;
  onOpen: OpenRow;
  layout: DashboardLayout;
  phone: boolean;
  view: ReactNode;
  readerId: string | null;
  table: TableProps;
}) {
  const { formatMessage } = useIntl();
  const { state, read, loadMore } = all;
  const { page, pageByOpened } = state;
  const rows = useMemo(() => page?.rows ?? [], [page]);
  const items = useMemo(() => allItems(rows, pageByOpened), [rows, pageByOpened]);
  const nextCursor = page?.nextCursor ?? null;
  const refreshing = state.status === "loading" && page !== null;
  const changeSearch = useCallback((event: ChangeEvent<HTMLInputElement>) => onSearch(event.target.value), [onSearch]);
  const clear = useCallback(() => {
    onSearch("");
    onPlace(null);
    onAuthor(null);
  }, [onSearch, onPlace, onAuthor]);
  const clearFilters = useCallback(() => {
    onPlace(null);
    onAuthor(null);
    onRelevant(false);
  }, [onPlace, onAuthor, onRelevant]);
  const seeAll = useCallback(() => onRelevant(false), [onRelevant]);
  const retry = useCallback(() => void read(page !== null), [read, page]);
  const more = useCallback(() => {
    if (nextCursor) loadMore(nextCursor);
  }, [nextCursor, loadMore]);
  const filtered = place !== null || author !== null;
  const narrowed = query !== "" || filtered;
  const clearLabel = query !== "" && filtered
    ? "artifacts.dashboard.all.clearAll"
    : query !== "" ? "artifacts.dashboard.all.clearSearch" : "artifacts.dashboard.clearFilters";
  const seen = useMemo(() => rows.map((row) => row.card.author), [rows]);

  // By cause: the sentence about the toggle only when the toggle alone left nothing. With a search, a conversation or an author
  // too, any of them may be why, so it is the ordinary no-match state, whose button is the way out a search alone has.
  const empty = relevant && !narrowed ? (
    // Not "clear": it says what the toggle was for.
    <EmptyState
      className="flex flex-1 flex-col items-center justify-center p-6"
      icon={<ArtifactIcon width={36} height={36} />}
      title={formatMessage({ id: "artifacts.dashboard.emptyRelevantTitle" })}
      titleHeading="h2"
      action={<Button size="md" variant="outline" onClick={seeAll} data-testid="artifacts-all-see-all">{formatMessage({ id: "artifacts.dashboard.seeAll" })}</Button>}
      data-testid="artifacts-all-empty"
    />
  ) : (
    <EmptyState
      className="flex flex-1 flex-col items-center justify-center p-6"
      icon={<ArtifactIcon width={36} height={36} />}
      title={formatMessage({ id: query !== "" ? "artifacts.dashboard.all.noResults" : filtered ? "artifacts.dashboard.emptyFilteredTitle" : "artifacts.dashboard.emptyTitle" })}
      titleHeading="h2"
      action={narrowed ? <Button size="md" variant="outline" onClick={clear}>{formatMessage({ id: clearLabel })}</Button> : undefined}
      data-testid="artifacts-all-empty"
    />
  );

  return (
    <>
      <DashboardToolbar
        phone={phone}
        view={view}
        // Only with both filters set: alone, a filter's own × says it. The toggle alone has none: another press is its way back.
        clear={place !== null && author !== null ? clearFilters : null}
        sort={relevant ? null : <SortPicker sort={sort} onChange={onSort} />}
        search={(
          <div role="search" className={DASHBOARD_SEARCH_CLASS}>
            <InputGroup size="md">
              <InputGroupAddon>
                <Search aria-hidden size={14} />
              </InputGroupAddon>
              <InputGroupInput
                type="search"
                value={search}
                onChange={changeSearch}
                // The server refuses a longer `q` (400), which would only fail.
                maxLength={WEB_SEARCH_QUERY_MAX_CHARS}
                // An attribute CSS can't swap; a phone's first row has room for the one word (existing copy, in every locale).
                placeholder={formatMessage({ id: phone ? "layout.mobileTabBar.search" : "artifacts.dashboard.all.searchPlaceholder" })}
                aria-label={formatMessage({ id: "artifacts.dashboard.all.searchLabel" })}
                data-testid="artifacts-all-search"
              />
            </InputGroup>
          </div>
        )}
        filters={(
          <>
            <ArtifactConversationFilter value={place} onChange={onPlace} testId="artifacts-all-conversation-filter" />
            <ArtifactAuthorFilter value={author} onChange={onAuthor} seen={seen} readerId={readerId} testId="artifacts-all-author-filter" />
            <RelevantToggle on={relevant} count={state.counts?.relevant ?? null} onChange={onRelevant} />
          </>
        )}
      />
      <ScrollArea
        ref={listRef}
        tabIndex={-1}
        className="min-h-0 flex-1 outline-none"
        // The content fills the area, so the empty state stays centred in it.
        contentClassName="flex min-h-full flex-col pb-6 safe-bottom"
        aria-busy={state.status === "loading" || state.status === "idle" || undefined}
        data-testid="artifacts-all-list"
        data-layout={layout}
      >
        {state.status === "failed" ? (
          // Feedback: a failed load is a warning with Retry, never an empty state; rows already on screen stay under it.
          <div className="px-(--column-margin) pt-2">
            <Banner status="warning" role="alert" data-testid="artifacts-all-failed">
              <TriangleAlert />
              <BannerDescription>{formatMessage({ id: "artifacts.dashboard.failedTitle" })}</BannerDescription>
              <BannerAction>
                <Button type="button" variant="outline" size="md" onClick={retry}>{formatMessage({ id: "artifacts.dashboard.retry" })}</Button>
              </BannerAction>
            </Banner>
          </div>
        ) : null}
        {state.status === "failed" && page === null ? null : page === null && layout !== "table" ? (
          // The view it loads into: the grid's tiles, or a phone's rows (#proj-raft-ui:#246); the table draws its own below.
          <ArtifactDashboardSkeleton layout={layout} phone={phone} />
        ) : layout === "table" ? (
          <ArtifactsTable
            testId="artifacts-all-table"
            loadingRows={page === null ? SKELETON_TABLE_ROWS : 0}
            byOpened={pageByOpened}
            items={items}
            empty={empty}
            readerId={readerId}
            onOpen={onOpen}
            {...table}
          />
        ) : rows.length === 0 ? empty : layout === "grid" ? (
          <TileGrid items={items} readerId={readerId} onOpen={onOpen} phone={phone} />
        ) : (
          <div className="flex flex-col gap-0.5 py-2" data-testid="artifacts-all-rows">
            {items.map((item, index) => <AllRow key={item.card.id} item={item} index={index} onOpen={onOpen} readerId={readerId} />)}
          </div>
        )}
        {nextCursor ? (
          <div className="px-(--column-margin) pt-1">
            {/* Off while the list reads itself again: this cursor continues rows that are being replaced. */}
            <Button
              size="md"
              variant="ghost"
              loading={state.paging}
              loadingLabel={formatMessage({ id: "common.loading" })}
              disabled={refreshing}
              onClick={more}
              data-testid="artifacts-all-more"
            >
              {formatMessage({ id: "artifacts.dashboard.showMore" })}
            </Button>
          </div>
        ) : null}
      </ScrollArea>
    </>
  );
}

/** The Artifacts in a grid of tiles (design D16): at least 248px a column, 12px apart; two columns on a phone, 8px apart. */
function TileGrid({ items, readerId, onOpen, phone }: { items: readonly ArtifactDashboardItem[]; readerId: string | null; onOpen: OpenRow; phone: boolean }) {
  return (
    <div className={TILE_GRID_CLASS} data-testid="artifacts-dashboard-grid">
      {items.map((item, index) => <GridTile key={item.card.id} item={item} index={index} readerId={readerId} onOpen={onOpen} phone={phone} />)}
    </div>
  );
}

function GridTile({ item, index, readerId, onOpen, phone }: { item: ArtifactDashboardItem; index: number; readerId: string | null; onOpen: OpenRow; phone: boolean }) {
  const open = useCallback((card: ArtifactCard, from: HTMLElement) => onOpen(card, from, index), [onOpen, index]);
  return <ArtifactTile item={item} readerId={readerId} onOpen={open} phone={phone} />;
}
