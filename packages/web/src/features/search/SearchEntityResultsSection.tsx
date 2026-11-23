import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { useCallback, useRef, useSyncExternalStore } from "react";
import { useIntl } from "react-intl";
import { Button, SearchResultsList, SearchResultsSection, SearchResultsSectionHeading, SearchResultsSummary, TextLink } from "@botiverse/raft-ui";
import AppBanner from "../../components/ui/Banner";
import ShowMoreToggle from "../../components/ui/ShowMoreToggle";
import type { MessageId } from "../../i18n/messages/en";
import { ENTITY_PREVIEW_COUNT } from "./searchConstants";
import type { SearchEntityGroupId } from "./searchEntities";

const GROUP_LABEL: Record<SearchEntityGroupId, MessageId> = {
  channels: "search.channels",
  people: "search.entityGroup.people",
  computers: "search.entityGroup.computers",
};

/**
 * One group of destinations matching the query (`children`, the rows):
 * channels, people or computers. The heading has the group's count and its
 * one action, Show all / Show fewer, at its end as a muted text link
 * (raft-design list-row.md › Group headings; text-link.md: See all beside a
 * section title). The count is every match the group has (the server's
 * `total`); until the server answers it is unknown (`count` null), so there
 * is no count and no Show all yet (an expanded section keeps Show fewer).
 * Expanded, a server group pages on with its cursor (Load more, at the list's
 * end) until it has them all; a failed page says so in Load more's place,
 * with Retry. Focus follows the swap: Load more → Retry when a page fails,
 * Retry → Load more when it is pressed.
 */
export function SearchEntityResultsSection({
  group,
  count,
  pending = false,
  expanded,
  hasMore,
  paging,
  pageFailed = false,
  onToggleExpanded,
  onLoadMore,
  children,
}: {
  group: SearchEntityGroupId;
  /** Every remaining destination of the group, shown or not; null while the server's total hasn't arrived. */
  count: number | null;
  /** The group's server answer is still out (aria-busy). */
  pending?: boolean;
  expanded: boolean;
  /** The server has rows past the ones loaded. */
  hasMore: boolean;
  paging: boolean;
  /** The last next page failed. */
  pageFailed?: boolean;
  onToggleExpanded: (group: SearchEntityGroupId) => void;
  onLoadMore: (group: SearchEntityGroupId) => void;
  children: ReactNode;
}) {
  const { formatMessage } = useIntl();
  const toggle = useCallback(() => onToggleExpanded(group), [group, onToggleExpanded]);
  // Focus was on Load more or Retry when it was pressed: the other one takes
  // its place, so focus moves to it rather than falling to the page.
  const followFocusRef = useRef(false);
  const more = useCallback(() => {
    followFocusRef.current = true;
    onLoadMore(group);
  }, [group, onLoadMore]);
  // The control that mounts in the pressed one's place takes the focus.
  const takeFollowedFocus = useCallback((node: HTMLButtonElement | null) => {
    if (node && followFocusRef.current && node !== node.ownerDocument.activeElement) node.focus();
  }, []);
  return (
    <SearchResultsSection data-testid="search-entity-group" data-group={group} aria-busy={pending || undefined}>
      <SearchResultsSectionHeading className="pr-(--column-margin)">
        {formatMessage({ id: GROUP_LABEL[group] })}
        {count !== null ? (
          <span className="font-mono text-mono-meta font-normal" data-testid="search-entity-group-count">{count}</span>
        ) : null}
        {expanded || (count !== null && count > ENTITY_PREVIEW_COUNT) ? (
          <ShowMoreToggle
            className="ml-auto"
            onClick={toggle}
            expanded={expanded}
            collapsedLabel={formatMessage({ id: "search.showAllEntities" })}
            expandedLabel={formatMessage({ id: "search.showFewerEntities" })}
            aria-expanded={expanded}
            data-testid="search-entity-show-all"
          />
        ) : null}
      </SearchResultsSectionHeading>
      <SearchResultsList data-testid="search-entity-results">
        {children}
      </SearchResultsList>
      {expanded && hasMore ? (
        <div className="px-(--column-margin) pb-2">
          {pageFailed && !paging ? (
            // Feedback: the page that failed, in its own place (not a toast).
            <AppBanner
              intent="warning"
              density="sm"
              withIcon
              data-testid="search-entity-load-more-failed"
              actions={(
                <Button ref={takeFollowedFocus} type="button" variant="outline" size="md" onClick={more} data-testid="search-entity-load-more-retry">
                  {formatMessage({ id: "search.retry" })}
                </Button>
              )}
            >
              {formatMessage({ id: "search.loadMoreFailed" })}
            </AppBanner>
          ) : (
            // A frameless control lines up by its words (raft-design patterns/lists.md › One edge).
            <Button
              ref={takeFollowedFocus}
              type="button"
              size="md"
              variant="ghost"
              className="-ml-2.5"
              loading={paging}
              loadingLabel={formatMessage({ id: "common.loading" })}
              onClick={more}
              data-testid="search-entity-load-more"
            >
              {formatMessage({ id: "search.loadMore" })}
            </Button>
          )}
        </div>
      ) : null}
    </SearchResultsSection>
  );
}

function subscribeOnline(onChange: () => void) {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}

/** The browser says it has no network (`navigator.onLine === false`). */
function useBrowserOffline(): boolean {
  return useSyncExternalStore(subscribeOnline, () => navigator.onLine === false, () => false);
}

/** What the summary's second line says about the core groups (channels, people). */
export type SearchEntityResultsCompleteness = "complete" | "failed" | "retrying";

/**
 * Some destinations are the local list only because core's search couldn't
 * be asked: the summary's second line says why and what is shown. Offline
 * says so; a failed request offers Retry, and says Searching… in its place
 * while it asks again. Always mounted (empty when complete), so the status
 * region is in place before it is filled and screen readers announce it.
 */
export function SearchEntityResultsIncompleteNote({ state, onRetry, onRetryFocusLost }: {
  state: SearchEntityResultsCompleteness;
  onRetry: () => void;
  /** Retry had focus and is replaced by Searching…: put focus somewhere that stays (the search field). */
  onRetryFocusLost: () => void;
}) {
  const { formatMessage } = useIntl();
  const offline = useBrowserOffline();
  const retry = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    const hadFocus = event.currentTarget === event.currentTarget.ownerDocument.activeElement;
    onRetry();
    if (hadFocus) onRetryFocusLost();
  }, [onRetry, onRetryFocusLost]);
  return (
    <SearchResultsSummary
      role="status"
      className={state === "complete" ? "sr-only" : "pt-0.5"}
      data-testid="search-entity-incomplete"
      data-state={state}
    >
      {state === "complete" ? null : offline ? formatMessage({ id: "search.coreGroups.offline" }) : (
        <>
          {formatMessage({ id: "search.coreGroups.failed" })}
          {" "}
          {state === "retrying" ? (
            formatMessage({ id: "search.searching" })
          ) : (
            <TextLink variant="strong" nativeButton={false} onClick={retry} data-testid="search-entity-incomplete-retry">
              {formatMessage({ id: "search.retry" })}
            </TextLink>
          )}
        </>
      )}
    </SearchResultsSummary>
  );
}
