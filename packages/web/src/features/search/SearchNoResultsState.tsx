import { useIntl } from "react-intl";
import { Search } from "lucide-react";
import { Button } from "@botiverse/raft-ui";
import AppEmptyState from "../../components/ui/EmptyState";

/**
 * DS EmptyState: say why it is empty and how to widen the search; at most
 * one ink-bordered small button.
 */
export function SearchNoResultsState({
  query,
  searchIncomplete,
  tooBroad,
  incompleteSearchNote,
  loadingMore,
  onContinueSearching,
}: {
  query: string;
  searchIncomplete: boolean;
  /** The server skipped the any-word search as too broad: the empty page is not "nothing matches". */
  tooBroad: boolean;
  incompleteSearchNote: string;
  loadingMore: boolean;
  onContinueSearching: () => void;
}) {
  const { formatMessage } = useIntl();
  return (
    <AppEmptyState
      className="py-16"
      icon={<Search size={36} aria-hidden="true" />}
      title={searchIncomplete
        ? formatMessage({ id: "search.incompleteNoMatchesYet" })
        : query.trim() ? formatMessage({ id: "search.noResultsForQuery" }, { query: query.trim() }) : formatMessage({ id: "search.noMatchingMessages" })}
      description={searchIncomplete
        ? incompleteSearchNote
        : tooBroad
          ? formatMessage({ id: "search.tooBroadHint" })
          : query.trim() ? formatMessage({ id: "search.tryDifferentKeywords" }) : formatMessage({ id: "search.tryDifferentFilters" })}
      action={searchIncomplete ? (
        <Button
          type="button"
          variant="outline"
          size="md"
          onClick={onContinueSearching}
          disabled={loadingMore}
        >
          {loadingMore ? formatMessage({ id: "common.loading" }) : formatMessage({ id: "search.continueSearching" })}
        </Button>
      ) : undefined}
    />
  );
}
