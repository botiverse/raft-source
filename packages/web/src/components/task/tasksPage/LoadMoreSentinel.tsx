import { useEffect, useRef } from "react";
import { useIntl } from "react-intl";
import { Button } from "@botiverse/raft-ui";

/** How far ahead of the end the next page is read. */
const LOAD_AHEAD_MARGIN = "240px";

/**
 * The end of a group or column of the Tasks page: reaching it (scrolled into
 * view, within a screenful's margin) reads the next page. The observer starts
 * over after every read, so a short page that leaves the end in view reads
 * on. After a failed read it waits for a press instead.
 */
export function LoadMoreSentinel({ onLoadMore, loading, failed, testId }: {
  onLoadMore: () => void;
  loading: boolean;
  failed: boolean;
  testId?: string;
}) {
  const { formatMessage } = useIntl();
  const ref = useRef<HTMLDivElement>(null);
  const loadRef = useRef(onLoadMore);
  useEffect(() => {
    loadRef.current = onLoadMore;
  }, [onLoadMore]);

  useEffect(() => {
    const node = ref.current;
    if (!node || loading || failed || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) loadRef.current();
    }, { rootMargin: LOAD_AHEAD_MARGIN });
    observer.observe(node);
    return () => observer.disconnect();
  }, [loading, failed]);

  if (failed) {
    return (
      <Button type="button" size="md" variant="outline" className="w-full" onClick={onLoadMore} data-testid={testId}>
        {formatMessage({ id: "task.page.retry" })}
      </Button>
    );
  }
  return (
    <div ref={ref} className="h-px w-full" aria-hidden="true" data-testid={testId} data-loading={loading || undefined} />
  );
}
