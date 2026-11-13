import { useIntl } from "react-intl";
import { Search } from "lucide-react";
import {
  SearchEntityResult,
  SearchEntityResultContent,
  SearchEntityResultDescription,
  SearchEntityResultHeader,
  SearchEntityResultIcon,
  SearchEntityResultLeading,
  SearchEntityResultTitle,
  SearchResultsList,
} from "@botiverse/raft-ui";

/**
 * A conversation's own search: the row that searches everywhere instead
 * (the Search tab, with the same words).
 */
export function SearchEverywhereRow({ query, onClick }: { query: string; onClick: () => void }) {
  const { formatMessage } = useIntl();
  return (
    <SearchResultsList className="pt-2">
      <SearchEntityResult type="button" data-testid="search-everywhere" onClick={onClick}>
        <SearchEntityResultLeading>
          <SearchEntityResultIcon>
            <Search size={14} aria-hidden="true" />
          </SearchEntityResultIcon>
        </SearchEntityResultLeading>
        <SearchEntityResultContent>
          <SearchEntityResultHeader>
            <SearchEntityResultTitle>
              {query.trim()
                ? formatMessage({ id: "search.scoped.everywhereFor" }, { query: query.trim() })
                : formatMessage({ id: "search.scoped.everywhere" })}
            </SearchEntityResultTitle>
          </SearchEntityResultHeader>
          <SearchEntityResultDescription>
            {formatMessage({ id: "search.scoped.everywhereHint" })}
          </SearchEntityResultDescription>
        </SearchEntityResultContent>
      </SearchEntityResult>
    </SearchResultsList>
  );
}
