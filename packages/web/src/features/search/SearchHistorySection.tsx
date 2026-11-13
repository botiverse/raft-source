import { useIntl } from "react-intl";
import { Clock, X } from "lucide-react";
import { Badge, SearchResultsSectionHeading, TextLink } from "@botiverse/raft-ui";
import { shouldRenderSearchHistoryRemove } from "./searchHome";

/** The search home's recent queries, as tags: pick one to search it again. */
export function SearchHistorySection({
  searchHistory,
  isTouchSearchHome,
  searchHistoryEditing,
  onToggleEdit,
  onClear,
  onChoose,
  onForget,
}: {
  searchHistory: string[];
  isTouchSearchHome: boolean;
  searchHistoryEditing: boolean;
  onToggleEdit: () => void;
  onClear: () => void;
  onChoose: (historyQuery: string) => void;
  onForget: (historyQuery: string) => void;
}) {
  const { formatMessage } = useIntl();
  return (
    <section aria-labelledby="search-history-heading">
      <div className="flex items-center justify-between gap-3 pr-(--column-margin)">
        <SearchResultsSectionHeading>
          <Clock size={14} aria-hidden="true" />
          <span id="search-history-heading">{formatMessage({ id: "search.history" })}</span>
        </SearchResultsSectionHeading>
        {/* Section actions are underlined ink text buttons (DS rf-section__action). */}
        <div className="flex items-center gap-4 pt-5 pb-2">
          {isTouchSearchHome ? (
            <TextLink
              onClick={onToggleEdit}
              className="text-footnote"
              data-testid="search-history-edit-toggle"
            >
              {formatMessage({
                id: searchHistoryEditing ? "search.doneEditHistory" : "search.editHistory",
              })}
            </TextLink>
          ) : null}
          <TextLink
            onClick={onClear}
            className="text-footnote"
          >
            {formatMessage({ id: "search.clearHistory" })}
          </TextLink>
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5 px-(--column-margin)" data-testid="search-history-tags">
        {searchHistory.map((historyQuery) => (
          <Badge
            key={historyQuery.toLocaleLowerCase()}
            render={<div />}
            appearance="soft"
            className="group relative hover:overlay-medium has-focus-visible:shadow-focus"
            data-testid="search-history-tag"
          >
            <button
              type="button"
              onClick={() => onChoose(historyQuery)}
              className="flex min-w-0 items-center gap-1 text-left outline-none after:absolute after:inset-0"
            >
              <Clock size={14} aria-hidden="true" />
              <span className="truncate">{historyQuery}</span>
            </button>
            {shouldRenderSearchHistoryRemove({
              isTouchViewport: isTouchSearchHome,
              editing: searchHistoryEditing,
            }) ? (
              <button
                type="button"
                onClick={() => onForget(historyQuery)}
                className={searchHistoryEditing
                  ? "relative z-raised -my-1 -mr-1 flex size-5.5 shrink-0 items-center justify-center rounded-sticker text-foreground-hint hover:bg-fill-medium"
                  : "pointer-events-none relative z-raised -my-1 -mr-1 flex size-5.5 shrink-0 items-center justify-center rounded-sticker text-foreground-hint opacity-0 hover:bg-fill-medium group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 focus:pointer-events-auto focus:opacity-100"}
                aria-label={formatMessage({ id: "search.removeHistory" }, { query: historyQuery })}
              >
                <X size={14} aria-hidden="true" />
              </button>
            ) : null}
          </Badge>
        ))}
      </div>
    </section>
  );
}
