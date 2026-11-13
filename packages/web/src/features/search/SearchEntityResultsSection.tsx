import type { ReactNode, RefObject } from "react";
import { useIntl } from "react-intl";
import { SearchResultsList, SearchResultsSection, SearchResultsSectionHeading } from "@botiverse/raft-ui";
import ShowMoreToggle from "../../components/ui/ShowMoreToggle";
import { ENTITY_PREVIEW_COUNT } from "./searchConstants";

/** The destinations matching the query (`children`, the rows), with Show All / Show Fewer. */
export function SearchEntityResultsSection({
  count,
  listRef,
  expanded,
  onToggleExpanded,
  children,
}: {
  /** Every remaining destination, shown or not. */
  count: number;
  listRef: RefObject<HTMLDivElement | null>;
  expanded: boolean;
  onToggleExpanded: () => void;
  children: ReactNode;
}) {
  const { formatMessage } = useIntl();
  return (
    <SearchResultsSection>
      <SearchResultsSectionHeading>
        {formatMessage({ id: "search.serverEntities" })}
        <span className="font-mono text-mono-meta font-normal">{count}</span>
      </SearchResultsSectionHeading>
      <SearchResultsList ref={listRef} data-testid="search-entity-results">
        {children}
      </SearchResultsList>
      {count > ENTITY_PREVIEW_COUNT ? (
        <div className="px-(--column-margin) py-2">
          <ShowMoreToggle
            onClick={onToggleExpanded}
            expanded={expanded}
            collapsedLabel={formatMessage({ id: "search.showAllEntities" }, { count })}
            expandedLabel={formatMessage({ id: "search.showFewerEntities" })}
            aria-expanded={expanded}
            data-testid="search-entity-show-all"
          />
        </div>
      ) : null}
    </SearchResultsSection>
  );
}
