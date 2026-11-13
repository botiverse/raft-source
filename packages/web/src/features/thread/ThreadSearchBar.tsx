import type { Dispatch, RefObject, SetStateAction } from "react";
import { useIntl } from "react-intl";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import { Button } from "@botiverse/raft-ui";
import CloseButton from "../../components/ui/CloseButton";
import Tooltip from "../../components/ui/Tooltip";
import { normalizeThreadSearchQuery } from "../../components/message/threadSearch";
import type { buildThreadSearchMatches } from "../../components/message/threadSearch";
import type { ThreadSearchPanelState } from "./useThreadSearch";

/** The bar of Search in this thread: the query, the match count, Previous / Next and Close. */
export function ThreadSearchBar({
  threadChromeLayerClassName,
  threadSearchInputRef,
  threadSearchQuery,
  setThreadSearchState,
  threadChannelId,
  parentTaskId,
  threadSearchLoading,
  threadSearchMatches,
  threadSearchActiveIndex,
  closeThreadSearch,
  goToThreadSearchMatch,
  handlePrevThreadSearchMatch,
  handleNextThreadSearchMatch,
}: {
  threadChromeLayerClassName: string;
  threadSearchInputRef: RefObject<HTMLInputElement | null>;
  threadSearchQuery: string;
  setThreadSearchState: Dispatch<SetStateAction<ThreadSearchPanelState>>;
  threadChannelId: string | null;
  parentTaskId: string | null;
  threadSearchLoading: boolean;
  threadSearchMatches: ReturnType<typeof buildThreadSearchMatches>;
  threadSearchActiveIndex: number;
  closeThreadSearch: () => void;
  goToThreadSearchMatch: (direction: 1 | -1) => void;
  handlePrevThreadSearchMatch: () => void;
  handleNextThreadSearchMatch: () => void;
}) {
  const { formatMessage } = useIntl();
  return (
    <div
      className={`${threadChromeLayerClassName} flex items-center gap-1 border-b border-line-seam bg-layer-canvas px-3 py-2`}
      data-testid="thread-search-bar"
    >
      <div className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-control border-[1.5px] border-line-field bg-layer-card px-2.5 has-focus-visible:shadow-focus">
      <Search size={16} className="shrink-0 text-foreground-hint" />
      <input
        ref={threadSearchInputRef}
        value={threadSearchQuery}
        onChange={(event) => {
          const nextQuery = event.target.value;
          setThreadSearchState((state) => ({
            ...state,
            threadId: threadChannelId ?? state.threadId,
            open: true,
            query: nextQuery,
            activeIndex: 0,
          }));
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            closeThreadSearch();
            return;
          }
          if (event.key === "Enter") {
            event.preventDefault();
            goToThreadSearchMatch(event.shiftKey ? -1 : 1);
          }
        }}
        className="h-full min-w-0 flex-1 bg-transparent text-callout text-foreground outline-none placeholder:text-foreground-hint"
        placeholder={formatMessage({ id: parentTaskId ? "message.threadPanel.searchThisTask" : "message.threadPanel.searchThisThread" })}
        aria-label={formatMessage({ id: parentTaskId ? "message.threadPanel.searchThisTask" : "message.threadPanel.searchThisThread" })}
        data-testid="thread-search-input"
      />
      </div>
      <div className="w-16 shrink-0 text-center font-mono text-mono-meta text-foreground-hint" data-testid="thread-search-count">
        {normalizeThreadSearchQuery(threadSearchQuery) && threadSearchLoading
          ? formatMessage({ id: "message.threadPanel.searchLoading" })
          : normalizeThreadSearchQuery(threadSearchQuery)
            ? (threadSearchMatches.length > 0
                ? `${threadSearchActiveIndex + 1}/${threadSearchMatches.length}`
                : "0/0")
            : ""}
      </div>
      <Tooltip content={formatMessage({ id: "message.threadPanel.previousMatch" })}>
        <Button
          type="button"
          size="icon-md"
          variant="ghost"
          onClick={handlePrevThreadSearchMatch}
          disabled={threadSearchMatches.length === 0}
          aria-label={formatMessage({ id: "message.threadPanel.previousMatch" })}
        >
          <ChevronUp size={14} />
        </Button>
      </Tooltip>
      <Tooltip content={formatMessage({ id: "message.threadPanel.nextMatch" })}>
        <Button
          type="button"
          size="icon-md"
          variant="ghost"
          onClick={handleNextThreadSearchMatch}
          disabled={threadSearchMatches.length === 0}
          aria-label={formatMessage({ id: "message.threadPanel.nextMatch" })}
        >
          <ChevronDown size={14} />
        </Button>
      </Tooltip>
      <Tooltip content={formatMessage({ id: "message.threadPanel.closeThreadSearch" })}>
      <CloseButton
        onClick={closeThreadSearch}
        aria-label={formatMessage({ id: "message.threadPanel.closeThreadSearch" })}
      >
        <X size={14} />
      </CloseButton>
      </Tooltip>
    </div>
  );
}
