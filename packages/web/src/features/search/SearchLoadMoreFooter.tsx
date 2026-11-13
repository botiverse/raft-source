import { useIntl } from "react-intl";
import { Button } from "@botiverse/raft-ui";
import AppBanner from "../../components/ui/Banner";

/** Below the message results: the next page, continuing an incomplete search, or retrying a failed page. */
export function SearchLoadMoreFooter({
  searchIncomplete,
  incompleteSearchNote,
  loadMoreError,
  loadingMore,
  onLoadMore,
}: {
  searchIncomplete: boolean;
  incompleteSearchNote: string;
  loadMoreError: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}) {
  const { formatMessage } = useIntl();
  return (
    <div className="flex flex-col items-center gap-2 px-(--column-margin) py-4">
      {searchIncomplete && !loadMoreError && (
        <p className="text-center text-caption text-foreground-hint">{incompleteSearchNote}</p>
      )}
      {loadMoreError ? (
        <AppBanner
          intent="warning"
          role="alert"
          withIcon
          className="w-full"
          actions={(
            <Button
              type="button"
              variant="outline"
              size="md"
              onClick={onLoadMore}
              disabled={loadingMore}
            >
              {loadingMore ? formatMessage({ id: "common.loading" }) : formatMessage({ id: "search.retry" })}
            </Button>
          )}
        >
          {formatMessage({ id: "search.loadMoreFailed" })}
        </AppBanner>
      ) : (
        <Button
          type="button"
          variant="outline"
          size="md"
          onClick={onLoadMore}
          disabled={loadingMore}
        >
          {loadingMore
            ? formatMessage({ id: "common.loading" })
            : formatMessage({ id: searchIncomplete ? "search.continueSearching" : "search.loadMore" })}
        </Button>
      )}
    </div>
  );
}
