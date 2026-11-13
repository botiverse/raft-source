import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import {
  Badge,
  Button,
  SearchResultsList,
  SearchResultsSection,
  SearchResultsSectionHeading,
  SearchThreadResult,
  SearchThreadResultHeader,
  SearchThreadResultMessages,
  SearchThreadResultMeta,
  SearchThreadResultTimestamp,
  SearchThreadResultTitle,
} from "@botiverse/raft-ui";
import { ThreadIcon } from "@botiverse/ricons";
import AppBanner from "../../components/ui/Banner";
import { formatRelativeTimeParts } from "../../utils/relativeTime";
import { searchFailureTitleId } from "./searchFailure";
import type { SearchFailureKind } from "./searchFailure";
import { getSearchRelativeTimeParts } from "./searchGrouping";
import type { SearchResultGroup, SearchSort } from "./searchGrouping";
import type { MessageSearchResult } from "./searchResultTypes";
import { SearchResultsBoundary } from "./SearchResultsBoundary";
import { SearchSkeleton } from "./SearchSkeleton";

/**
 * The message results: their heading, the first load's skeleton, a failed
 * search's banner, or the hits (thread hits grouped under their thread).
 */
export function SearchMessageResultsSection({
  loading,
  searchError,
  resultsCount,
  totalResults,
  showInitialSkeleton,
  groupedMessageResults,
  sort,
  relevanceFallback,
  boundaryKey,
  selectedResultKey,
  onRetry,
  onSortByRecent,
  renderMessageHit,
  getSourceLabel,
}: {
  loading: boolean;
  searchError: SearchFailureKind | null;
  resultsCount: number;
  totalResults: number;
  showInitialSkeleton: boolean;
  groupedMessageResults: SearchResultGroup<MessageSearchResult>[];
  sort: SearchSort;
  /** The server answered this relevance search newest first (too many matches to rank, #14480). */
  relevanceFallback: boolean;
  boundaryKey: string;
  selectedResultKey: string | undefined;
  onRetry: () => void;
  onSortByRecent: () => void;
  renderMessageHit: (result: MessageSearchResult, nested?: boolean) => ReactNode;
  getSourceLabel: (result: MessageSearchResult) => string;
}) {
  const intl = useIntl();
  const { formatMessage } = intl;
  return (
    <SearchResultsSection>
      {((loading && !searchError) || groupedMessageResults.length > 0) && (
        <SearchResultsSectionHeading>
          {formatMessage({ id: "search.messages" })}
          {/* Messages only: the destinations above carry their own count. */}
          {!loading && resultsCount > 0 ? (
            <span className="font-mono text-mono-meta font-normal" data-testid="search-messages-count">{resultsCount}</span>
          ) : null}
        </SearchResultsSectionHeading>
      )}
      {relevanceFallback && sort !== "recent" && !loading && resultsCount > 0 ? (
        <p className="px-(--column-margin) pb-1 text-caption text-foreground-hint" data-testid="search-relevance-fallback">
          {formatMessage({ id: "search.relevanceFallbackNote" })}
        </p>
      ) : null}
      {showInitialSkeleton ? (
        <SearchSkeleton />
      ) : searchError && totalResults === 0 ? (
        <div className="px-(--column-margin)">
          <AppBanner
            intent="warning"
            live={false}
            withIcon
            title={formatMessage({ id: searchFailureTitleId(searchError) })}
            actions={searchError !== "query_too_broad" ? (
              <Button
                type="button"
                variant="outline"
                size="md"
                onClick={onRetry}
              >
                {formatMessage({ id: "search.retry" })}
              </Button>
            ) : sort !== "recent" ? (
              // Recent sort is never rejected as too broad: one click reruns the same search newest first.
              <Button
                type="button"
                variant="outline"
                size="md"
                onClick={onSortByRecent}
              >
                {formatMessage({ id: "search.queryTooBroadSortRecent" })}
              </Button>
            ) : undefined}
          >
            {formatMessage({
              id: searchError === "query_too_broad"
                ? "search.queryTooBroadBody"
                : searchError === "search_timeout"
                  ? "search.searchTimedOutBody"
                  : "search.searchFailedBody",
            })}
          </AppBanner>
        </div>
      ) : (
        <SearchResultsBoundary
          resetKey={boundaryKey}
          onRetry={onRetry}
        >
          <SearchResultsList>
            {groupedMessageResults.map((group) => {
              if (group.kind === "message") {
                return renderMessageHit(group.result);
              }

              const firstResult = group.results[0];
              const sourceLabel = firstResult ? getSourceLabel(firstResult) : formatMessage({ id: "search.unknownSource" });
              const groupHasSelected = group.results.some((r) => selectedResultKey === `message:${r.id}`);

              return (
                <SearchThreadResult
                  key={group.key}
                  selected={groupHasSelected}
                >
                  <SearchThreadResultHeader>
                    <div className="mb-0.5 flex min-w-0 flex-wrap items-center gap-1.5">
                      <Badge appearance="outline">
                        <ThreadIcon width={12} height={12} />
                        {formatMessage({ id: "search.threadBadge" })}
                      </Badge>
                      <SearchThreadResultMeta>{sourceLabel}</SearchThreadResultMeta>
                      <span className="font-mono text-mono-meta text-foreground-hint">{formatMessage({ id: "search.hitsCount" }, { count: group.hitCount })}</span>
                      <SearchThreadResultTimestamp>{(() => {
                        const parts = getSearchRelativeTimeParts(group.latestCreatedAt);
                        return parts ? formatRelativeTimeParts(parts.value, parts.unit, intl.locale) : formatMessage({ id: "search.grpUnknownTime" });
                      })()}</SearchThreadResultTimestamp>
                    </div>
                    <SearchThreadResultTitle>{group.title || formatMessage({ id: "search.grpThreadDiscussion" })}</SearchThreadResultTitle>
                  </SearchThreadResultHeader>
                  <SearchThreadResultMessages>
                    {group.results.map((result) => renderMessageHit(result, true))}
                  </SearchThreadResultMessages>
                </SearchThreadResult>
              );
            })}
          </SearchResultsList>
        </SearchResultsBoundary>
      )}
    </SearchResultsSection>
  );
}
