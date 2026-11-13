import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { Clock, Search, Star } from "lucide-react";
import { SearchResultsList, SearchResultsSectionHeading } from "@botiverse/raft-ui";
import AppEmptyState from "../../components/ui/EmptyState";
import type { SearchEntityResult as SearchEntityRecord } from "./searchEntities";
import { SearchHistorySection } from "./SearchHistorySection";

/**
 * Search with nothing to search yet: the plan's notice, then the home — a
 * conversation's own search's empty state, the ⌘K overlay's recent
 * conversations (`children`, the rows), or the full page's history and
 * frequent destinations.
 */
export function SearchHomeContent({
  historyNotice,
  scoped,
  scopeConversation,
  overlayHome,
  hasRecentConversations,
  children,
  hasSearchHomeContent,
  searchHistory,
  isTouchSearchHome,
  searchHistoryEditing,
  onToggleHistoryEdit,
  onClearHistory,
  onChooseHistory,
  onForgetHistory,
  frequentSearchEntities,
  renderSearchHomeEntity,
}: {
  historyNotice: ReactNode;
  scoped: boolean;
  scopeConversation: string | null;
  overlayHome: boolean;
  hasRecentConversations: boolean;
  /** The overlay's recent-conversation rows. */
  children: ReactNode;
  hasSearchHomeContent: boolean;
  searchHistory: string[];
  isTouchSearchHome: boolean;
  searchHistoryEditing: boolean;
  onToggleHistoryEdit: () => void;
  onClearHistory: () => void;
  onChooseHistory: (historyQuery: string) => void;
  onForgetHistory: (historyQuery: string) => void;
  frequentSearchEntities: SearchEntityRecord[];
  renderSearchHomeEntity: (result: SearchEntityRecord) => ReactNode;
}) {
  const { formatMessage } = useIntl();
  const centeredEmptyState = (
    <AppEmptyState
      className="flex-1 justify-center"
      data-testid="search-home"
      icon={<Search size={36} aria-hidden="true" />}
      title={formatMessage({ id: "search.emptyTitle" })}
      description={formatMessage({ id: "search.emptyBody" })}
    />
  );

  return (
    // Fills what is left of the search scroller's content, a flex column.
    <div className="flex flex-1 flex-col">
      {historyNotice ? <div className="pt-3">{historyNotice}</div> : null}
      {scoped ? (
        <AppEmptyState
          className="py-16"
          icon={<Search size={36} aria-hidden="true" />}
          title={formatMessage({ id: "search.scoped.emptyTitle" }, { conversation: scopeConversation })}
          description={formatMessage({ id: "search.scoped.emptyBody" })}
        />
      ) : overlayHome ? (
        hasRecentConversations ? (
          /* Overlay empty state (task #113, Slack): the conversations you were
             in most recently, as the same destination rows the results use. */
          <div data-testid="search-overlay-recent">
            <SearchResultsSectionHeading>
              <Clock size={14} aria-hidden="true" />
              <span>{formatMessage({ id: "search.overlay.recentConversations" })}</span>
            </SearchResultsSectionHeading>
            <SearchResultsList>
              {children}
            </SearchResultsList>
          </div>
        ) : centeredEmptyState
      ) : !hasSearchHomeContent ? centeredEmptyState : (
        <div data-testid="search-home">
          {searchHistory.length > 0 ? (
            <SearchHistorySection
              searchHistory={searchHistory}
              isTouchSearchHome={isTouchSearchHome}
              searchHistoryEditing={searchHistoryEditing}
              onToggleEdit={onToggleHistoryEdit}
              onClear={onClearHistory}
              onChoose={onChooseHistory}
              onForget={onForgetHistory}
            />
          ) : null}

          <section aria-labelledby="search-frequent-heading">
            <SearchResultsSectionHeading>
              <Star size={14} aria-hidden="true" />
              <span id="search-frequent-heading">{formatMessage({ id: "search.frequent" })}</span>
            </SearchResultsSectionHeading>
            {frequentSearchEntities.length > 0 ? (
              <SearchResultsList>
                {frequentSearchEntities.map(renderSearchHomeEntity)}
              </SearchResultsList>
            ) : (
              <p className="px-(--column-margin) py-2 text-callout text-foreground-hint">
                {formatMessage({ id: "search.frequentEmpty" })}
              </p>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
