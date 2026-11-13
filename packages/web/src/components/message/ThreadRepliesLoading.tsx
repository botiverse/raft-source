import { useEffect, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { Button } from "@botiverse/raft-ui";

import { MessageRows } from "../../boot/bootSkeletons";
import { TIMELINE_NOTICE_LINE_HEIGHT, TIMELINE_NOTICE_ROW, TIMELINE_ROW_INSET, TIMELINE_START_ABOVE_ROW } from "./composerHost";
import Banner from "../ui/Banner";
import { ContentLoading } from "../ui/ContentLoading";
import { TraceIdNote } from "../errors/TraceIdNote";
import { takeRecentFailedRequestTraceId } from "../../utils/requestTraceId";

/** Raft DS Feedback › Empty, loading and failed: a skeleton shows only once the wait passes 1 second. */
export const THREAD_REPLIES_SLOW_MS = 1_000;

/**
 * The thread's replies while they load. DS Feedback: a load that finishes
 * within a second goes straight from nothing to the replies, so for the
 * first second the reply area is empty (the panel and its parent are already
 * there: the click has landed). Past it, "Loading replies..." and the message
 * skeleton appear together, in one frame, so nothing moves under the line.
 *
 * `since` is when the person asked (the click that opened the thread, or
 * Retry), not when this mounted: a thread that was still being found, then
 * mounts its replies, keeps counting the same second. Key it by `since`, so
 * a new open or a retry starts over.
 *
 * `aria-busy` belongs to the reply region that stays (ThreadPanelBody), not
 * here: this goes away before a screen reader could hear it finish.
 */
export function ThreadRepliesLoading({ since }: { since: number }) {
  const { formatMessage } = useIntl();
  const [shown, setShown] = useState(() => Date.now() - since >= THREAD_REPLIES_SLOW_MS);
  useEffect(() => {
    if (shown) return;
    // A timer, not data: the placeholder waits out the DS's 1-second
    // threshold, counted from the click, so a fast load never flashes it.
    const timer = window.setTimeout(() => setShown(true), Math.max(0, since + THREAD_REPLIES_SLOW_MS - Date.now()));
    return () => window.clearTimeout(timer);
  }, [shown, since]);
  if (!shown) return null;
  return (
    <div className="absolute inset-0 flex flex-col bg-layer-canvas" data-testid="thread-replies-loading">
      {/* The line stands where the replies' first row of the timeline (the
          history notice, "Beginning of replies") will: the same row inset and
          section step, and the notice's line height, so the rows under it
          start where the first reply does. */}
      <div className={`shrink-0 ${TIMELINE_ROW_INSET} ${TIMELINE_START_ABOVE_ROW}`}>
        <ContentLoading className={`${TIMELINE_NOTICE_ROW} ${TIMELINE_NOTICE_LINE_HEIGHT}`}>
          {formatMessage({ id: "message.threadPanel.loadingReplies" })}
        </ContentLoading>
      </div>
      <MessageRows from="top" />
    </div>
  );
}

/**
 * DS Feedback › failed to load: the orange banner where the replies would
 * be, saying what happened, with Retry. Both ways a thread fails to load
 * show it: finding the thread, and reading its replies. It shows when the
 * request has just failed, so it carries that request's trace id
 * (#proj-o11y:#18); a retry that fails again mounts a new one.
 */
export function ThreadRepliesLoadFailed({ onRetry, retryTestId, unavailableFrom }: {
  onRetry: () => void;
  retryTestId: string;
  /** The server answered that it can't show this thread: the server's name, for the plain "not available from" copy. */
  unavailableFrom?: string | null;
}) {
  const { formatMessage } = useIntl();
  // Taken once (a ref survives StrictMode's second render), so a later error toast does not repeat it.
  const traceIdRef = useRef<string | null | undefined>(undefined);
  if (traceIdRef.current === undefined) traceIdRef.current = takeRecentFailedRequestTraceId();
  const traceId = traceIdRef.current;
  return (
    <div className="flex flex-col px-3 pt-3">
      <Banner
        intent="warning"
        density="sm"
        withIcon
        data-testid="thread-replies-load-failed"
        title={formatMessage({ id: "message.threadPanel.loadFailedTitle" })}
        actions={(
          <Button type="button" size="md" variant="outline" onClick={onRetry} data-testid={retryTestId}>
            {formatMessage({ id: "message.threadPanel.retry" })}
          </Button>
        )}
      >
        {unavailableFrom
          ? formatMessage({ id: "message.threadPanel.unavailableBody" }, { server: unavailableFrom })
          : formatMessage({ id: "message.threadPanel.loadFailedBody" })}
        {traceId ? <span className="mt-1 block"><TraceIdNote traceId={traceId} /></span> : null}
      </Banner>
    </div>
  );
}
