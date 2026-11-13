import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { Search } from "lucide-react";
import {
  Kbd,
  SearchEntityResult,
  SearchEntityResultContent,
  SearchEntityResultDescription,
  SearchEntityResultHeader,
  SearchEntityResultIcon,
  SearchEntityResultLeading,
  SearchEntityResultTitle,
  SearchResultsList,
} from "@botiverse/raft-ui";
import { RETURN_KEY_GLYPH } from "./searchConstants";

/**
 * Overlay head (task #102, Slack): exact destination first when the query
 * names one (`children`), then the "view all results" row.
 */
export function SearchOverlayHead({
  query,
  allResultsSelected,
  onOpenAllResults,
  children,
}: {
  query: string;
  allResultsSelected: boolean;
  onOpenAllResults: () => void;
  /** The exact destination's row, if any. */
  children: ReactNode;
}) {
  const { formatMessage } = useIntl();
  return (
    <SearchResultsList className="pt-2" data-testid="search-overlay-head">
      {children}
      <SearchEntityResult
        type="button"
        data-testid="search-view-all-results"
        data-active={allResultsSelected ? "true" : undefined}
        selected={allResultsSelected}
        onClick={onOpenAllResults}
      >
        <SearchEntityResultLeading>
          <SearchEntityResultIcon>
            <Search size={14} aria-hidden="true" />
          </SearchEntityResultIcon>
        </SearchEntityResultLeading>
        <SearchEntityResultContent>
          <SearchEntityResultHeader>
            <SearchEntityResultTitle>
              {query.trim()
                ? formatMessage({ id: "search.overlay.searchFor" }, { query: query.trim() })
                : formatMessage({ id: "search.overlay.viewAllResults" })}
            </SearchEntityResultTitle>
          </SearchEntityResultHeader>
          <SearchEntityResultDescription>
            {formatMessage({ id: "search.overlay.viewAllResultsHint" })}
          </SearchEntityResultDescription>
        </SearchEntityResultContent>
        <Kbd aria-hidden="true">{RETURN_KEY_GLYPH}</Kbd>
      </SearchEntityResult>
    </SearchResultsList>
  );
}
