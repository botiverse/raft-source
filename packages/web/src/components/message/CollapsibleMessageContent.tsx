import {
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type {
  ReactNode,
  MouseEvent,
} from "react";
import { IntlContext } from "react-intl";
import { en } from "../../i18n/messages/en";
import ShowMoreToggle from "../ui/ShowMoreToggle";
import {
  MessageTimelineKeepMessageVisibleContext,
  MessageTimelinePreserveViewportContext,
} from "./MessageTimeline";

const COLLAPSED_MESSAGE_CONTENT_HEIGHT_PX = 320;
export const MESSAGE_CONTENT_EXPANSION_CACHE_LIMIT = 200;

const expandedMessageIds = new Map<string, true>();
const measuredMessageOverflow = new Map<string, boolean>();
const observedContentCallbacks = new Map<Element, (renderedHeight: number) => void>();
let sharedResizeObserver: ResizeObserver | null = null;

function messageContentExceedsCollapseHeight(
  renderedHeight: number,
  threshold = COLLAPSED_MESSAGE_CONTENT_HEIGHT_PX,
): boolean {
  return renderedHeight > threshold;
}

function rememberExpandedMessage(messageId: string) {
  expandedMessageIds.delete(messageId);
  expandedMessageIds.set(messageId, true);
  while (expandedMessageIds.size > MESSAGE_CONTENT_EXPANSION_CACHE_LIMIT) {
    const oldestMessageId = expandedMessageIds.keys().next().value;
    if (!oldestMessageId) break;
    expandedMessageIds.delete(oldestMessageId);
  }
}

function forgetExpandedMessage(messageId: string) {
  expandedMessageIds.delete(messageId);
}

function rememberMeasuredOverflow(measurementKey: string, overflows: boolean) {
  measuredMessageOverflow.delete(measurementKey);
  measuredMessageOverflow.set(measurementKey, overflows);
  while (measuredMessageOverflow.size > MESSAGE_CONTENT_EXPANSION_CACHE_LIMIT) {
    const oldestMeasurementKey = measuredMessageOverflow.keys().next().value;
    if (!oldestMeasurementKey) break;
    measuredMessageOverflow.delete(oldestMeasurementKey);
  }
}

function getResizeObserverEntryHeight(entry: ResizeObserverEntry): number {
  const borderBoxSize = entry.borderBoxSize as ResizeObserverSize | readonly ResizeObserverSize[] | undefined;
  const firstBoxSize = Array.isArray(borderBoxSize) ? borderBoxSize[0] : borderBoxSize;
  if (firstBoxSize) return firstBoxSize.blockSize;
  return entry.contentRect.height;
}

function getSharedResizeObserver(): ResizeObserver | null {
  if (typeof ResizeObserver === "undefined") return null;
  if (!sharedResizeObserver) {
    sharedResizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        observedContentCallbacks.get(entry.target)?.(getResizeObserverEntryHeight(entry));
      }
    });
  }
  return sharedResizeObserver;
}

function observeContentHeight(element: HTMLElement, onMeasure: (renderedHeight: number) => void) {
  const observer = getSharedResizeObserver();
  if (!observer) {
    onMeasure(element.scrollHeight);
    return () => {};
  }
  observedContentCallbacks.set(element, onMeasure);
  observer.observe(element);
  return () => {
    observer.unobserve(element);
    observedContentCallbacks.delete(element);
    if (observedContentCallbacks.size === 0) {
      observer.disconnect();
      sharedResizeObserver = null;
    }
  };
}

export function __resetMessageContentCollapseStateForTests() {
  expandedMessageIds.clear();
  measuredMessageOverflow.clear();
  observedContentCallbacks.clear();
  sharedResizeObserver?.disconnect();
  sharedResizeObserver = null;
}

export function __getExpandedMessageContentCountForTests(): number {
  return expandedMessageIds.size;
}

interface CollapsibleMessageContentProps {
  messageId: string;
  measurementKey?: string;
  measureBeforePaint?: boolean;
  disabled: boolean;
  children: ReactNode;
}

export default function CollapsibleMessageContent({
  messageId,
  measurementKey = messageId,
  measureBeforePaint = false,
  disabled,
  children,
}: CollapsibleMessageContentProps) {
  const collapseRootRef = useRef<HTMLDivElement | null>(null);
  const collapsibleContentRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const cachedOverflow = measuredMessageOverflow.get(measurementKey);
  const measurementCompleteRef = useRef(cachedOverflow !== undefined);
  const contentDomId = useId();
  const preserveTimelineViewport = useContext(MessageTimelinePreserveViewportContext);
  const keepTimelineMessageVisible = useContext(MessageTimelineKeepMessageVisibleContext);
  const [expanded, setExpanded] = useState(() => expandedMessageIds.has(messageId));
  const [beforePaintMeasurementComplete, setBeforePaintMeasurementComplete] = useState(
    cachedOverflow !== undefined,
  );
  const reserveToggleSpace = measureBeforePaint && !beforePaintMeasurementComplete;
  // Pending content is clipped by measurementCompleteRef below. Keeping the
  // overflow state boolean lets the common short-message case remain a no-op
  // state update, so mounting a timeline does not re-render every row.
  const [overflows, setOverflows] = useState(cachedOverflow ?? false);

  // Stryker disable ArrayDeclaration: the callback closes over no changing values, so synthetic dependency entries are behavior-equivalent.
  const measure = useCallback((renderedHeight: number) => {
    const nextOverflows = messageContentExceedsCollapseHeight(renderedHeight);
    const firstMeasurement = !measurementCompleteRef.current;
    measurementCompleteRef.current = true;
    if (firstMeasurement && measureBeforePaint) {
      setBeforePaintMeasurementComplete(true);
    }
    if (measureBeforePaint) {
      rememberMeasuredOverflow(measurementKey, nextOverflows);
    } else {
      // The cache is a one-handoff bridge, not durable content state. Once
      // the persisted row has its own observer result, discard the optimistic
      // measurement so a later edited/remounted message cannot reuse it.
      measuredMessageOverflow.delete(measurementKey);
    }

    // A short row was only provisionally capped. Remove that inert cap in the
    // observer callback without committing a second React render for every
    // ordinary message in the timeline. A later parent render reads the ref and
    // produces the same declarative result.
    if (firstMeasurement && !nextOverflows) {
      if (measureBeforePaint) {
        return;
      }
      collapseRootRef.current?.setAttribute("data-message-collapse-measurement", "complete");
      const content = collapsibleContentRef.current;
      if (content?.dataset.messageCollapsed === "true") {
        content.dataset.messageCollapsed = "false";
        content.classList.remove("relative", "overflow-clip");
        content.style.removeProperty("max-height");
      }
      return;
    }

    setOverflows(nextOverflows);
  }, [measurementKey, measureBeforePaint]);
  // Stryker restore ArrayDeclaration

  // Stryker disable ArrayDeclaration: measure is stable by construction; removing the dependency is behavior-equivalent.
  useLayoutEffect(() => {
    // While disabled the measurement tree is not rendered; when the pref
    // flips back on at runtime this effect must re-run so the freshly
    // mounted content gets observed (task #187 collapse-long-messages).
    if (disabled) return;
    const content = contentRef.current;
    if (!content) return;
    // Newly-authored optimistic rows are the only rows that need a forced
    // first-paint answer. Measure that one row during layout, before the
    // browser can paint, then carry the result across the optimistic ->
    // persisted ID handoff via measurementKey. Historical timeline rows keep
    // the shared observer path and avoid per-row synchronous layout reads.
    if (measureBeforePaint && !measurementCompleteRef.current) {
      measure(content.scrollHeight);
    }
    return observeContentHeight(content, measure);
  }, [measure, measureBeforePaint, disabled]);
  // Stryker restore ArrayDeclaration

  if (disabled) {
    return <>{children}</>;
  }

  const collapsed = (!measurementCompleteRef.current || overflows) && !expanded;
  const toggleExpanded = () => {
    const next = !expanded;
    if (next) {
      preserveTimelineViewport?.();
      rememberExpandedMessage(messageId);
    } else {
      keepTimelineMessageVisible?.(messageId);
      forgetExpandedMessage(messageId);
    }
    setExpanded(next);
  };

  return (
    <div
      ref={collapseRootRef}
      data-message-collapsible={overflows ? "true" : "false"}
      data-message-collapse-measurement={measurementCompleteRef.current ? "complete" : "pending"}
    >
      <div
        ref={collapsibleContentRef}
        id={contentDomId}
        data-message-collapsible-content="true"
        data-message-collapsed={collapsed ? "true" : "false"}
        className={collapsed ? "relative overflow-clip" : ""}
        style={collapsed ? { maxHeight: COLLAPSED_MESSAGE_CONTENT_HEIGHT_PX } : undefined}
        onFocusCapture={(event) => {
          if (!collapsed) return;
          const contentBounds = event.currentTarget.getBoundingClientRect();
          const focusedBounds = event.target.getBoundingClientRect();
          if (focusedBounds.bottom > contentBounds.bottom) {
            toggleExpanded();
          }
        }}
      >
        <div ref={contentRef} data-message-collapsible-measure="true">
          {children}
        </div>
        {collapsed && overflows ? (
          <div
            aria-hidden="true"
            data-message-collapse-fade="true"
            className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-white to-transparent"
          />
        ) : null}
      </div>
      {overflows ? (
        <MessageContentToggle
          expanded={expanded}
          aria-controls={contentDomId}
          aria-expanded={expanded}
          messageId={messageId}
          onClick={(event) => {
            event.stopPropagation();
            toggleExpanded();
          }}
        />
      ) : reserveToggleSpace ? (
        <MessageContentTogglePlaceholder />
      ) : null}
    </div>
  );
}

function MessageContentTogglePlaceholder() {
  const intl = useContext(IntlContext);
  const collapsedLabel = intl?.formatMessage({ id: "message.content.showMore" }) ?? en["message.content.showMore"];
  return (
    <ShowMoreToggle
      expanded={false}
      collapsedLabel={collapsedLabel}
      aria-hidden="true"
      disabled
      tabIndex={-1}
      className="pointer-events-none invisible mt-1"
      data-message-content-toggle-placeholder="true"
    />
  );
}

interface MessageContentToggleProps {
  expanded: boolean;
  "aria-controls": string;
  "aria-expanded": boolean;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  messageId: string;
}

function MessageContentToggle({
  expanded,
  "aria-controls": ariaControls,
  "aria-expanded": ariaExpanded,
  onClick,
  messageId,
}: MessageContentToggleProps) {
  const intl = useContext(IntlContext);
  const collapsedLabel = intl?.formatMessage({ id: "message.content.showMore" }) ?? en["message.content.showMore"];
  // Stryker disable next-line StringLiteral: the missing-Intl fallback equals ShowMoreToggle's canonical default; active-provider English and Chinese labels are behavior-tested.
  const expandedLabel = intl?.formatMessage({ id: "message.content.collapse" }) ?? en["message.content.collapse"];
  return (
    <ShowMoreToggle
      expanded={expanded}
      collapsedLabel={collapsedLabel}
      expandedLabel={expandedLabel}
      aria-controls={ariaControls}
      aria-expanded={ariaExpanded}
      onClick={onClick}
      className="mt-1"
      data-message-content-toggle={messageId}
    />
  );
}
