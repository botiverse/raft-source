import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { AgentContextView } from "@botiverse/raft-shared";

import { AgentContextViewMessageRow } from "./AgentContextViewMessageRow";
import type { Folds, ToggleFold } from "./AgentContextViewMessageRow";
import { AgentContextViewToolbar } from "./AgentContextViewToolbar";
import type { AgentContextViewJump } from "./AgentContextViewToolbar";
import { Hint } from "./AgentContextViewText";
import {
  agentContextViewCallsById,
  agentContextViewDelivery,
  agentContextViewHitOffset,
  agentContextViewMessageCount,
  agentContextViewNoticeKey,
  agentContextViewPairs,
  agentContextViewPartKey,
  agentContextViewRowAtOrAfter,
  agentContextViewRowStepEdges,
  agentContextViewRows,
  agentContextViewSearchPattern,
  agentContextViewTimeline,
  findAgentContextViewMatches,
  firstAgentContextViewMatchFrom,
  locateAgentContextViewMatch,
} from "./agentContextViewMessageFilter";
import type { AgentContextViewFilter, AgentContextViewMatch, AgentContextViewMatches, AgentContextViewPairs, AgentContextViewRow } from "./agentContextViewMessageFilter";
import { raftSegmentAt } from "@botiverse/raft-shared";

/** A message row before it is measured. */
const ESTIMATED_ROW = 140;

const NO_FOLDS: Folds = { result: new Set(), text: new Set(), notice: new Set() };

function add(set: ReadonlySet<string>, key: string): ReadonlySet<string> {
  return set.has(key) ? set : new Set(set).add(key);
}

/**
 * The folds that hide a match, opened: a Raft notice's card, a step (call and
 * result) and its long input or output, the send step's command, a result
 * or a long text.
 */
function unfoldMatch(folds: Folds, context: AgentContextView, pairs: AgentContextViewPairs, match: AgentContextViewMatch, pattern: RegExp): Folds {
  const message = context.messages[match.messageIndex]!;
  const part = message.parts[match.partIndex]!;
  const key = agentContextViewPartKey(match.messageIndex, match.partIndex);
  const delivery = agentContextViewDelivery(message, part);
  if (delivery && part.kind === "text") {
    const segment = raftSegmentAt(delivery.segments, agentContextViewHitOffset(part.text, pattern, match.hit));
    if (segment === -1 || delivery.segments[segment]!.kind === "text") return folds;
    const notice = add(folds.notice, agentContextViewNoticeKey(match.messageIndex, match.partIndex, segment));
    return notice === folds.notice ? folds : { ...folds, notice };
  }
  // A paired result opens its call's step.
  const result = add(folds.result, pairs.callOf.get(key) ?? key);
  const text = add(folds.text, key);
  return result === folds.result && text === folds.text ? folds : { ...folds, result, text };
}

/** Where the list is asked to scroll, once it has rendered (a filter changes the rows first). */
type ScrollRequest = { index: number; align: "start" | "center" | "end"; match?: boolean } | { top: true };
type SearchState = { pattern: RegExp; matches: AgentContextViewMatches; active: number | null };

/**
 * Once the virtual scroll has brought the current match's row in, the match
 * itself into view: a row taller than the panel (an opened result) can hold
 * it outside the part centred. A few frames at most, while the row mounts.
 */
function revealCurrentMatch(scroller: HTMLElement, frames: { id: number }) {
  let left = 30;
  const tick = () => {
    const mark = scroller.querySelector<HTMLElement>("[data-agent-context-view-match='current']");
    if (mark) {
      const box = mark.getBoundingClientRect();
      const view = scroller.getBoundingClientRect();
      if (box.top >= view.top && box.bottom <= view.bottom) return;
      mark.scrollIntoView?.({ block: "center" });
    }
    if (--left > 0) frames.id = requestAnimationFrame(tick);
  };
  cancelAnimationFrame(frames.id);
  frames.id = requestAnimationFrame(tick);
}

/**
 * The messages, virtual inside the panel's scroller (the nearest
 * `[data-agent-context-view-scroll]`): `scrollMargin` is where the list starts
 * in it (the facts and the folded sections above), measured rows replace the
 * estimate as they mount. On open it scrolls to the send call (centred) or,
 * without one, to the last message. Above it, the toolbar (search, filter,
 * jumps); the filter, the search and the open folds live here, so a row
 * that scrolls out and back keeps them.
 */
export function AgentContextViewMessageList({ context, agentName, agentAvatarUrl, sent }: {
  context: AgentContextView;
  agentName: string;
  agentAvatarUrl: string | null;
  /** The message this context sent, as the send step shows it. */
  sent: { content: string; createdAt: string } | null;
}) {
  const { formatMessage } = useIntl();
  const listRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const [toolbarHeight, setToolbarHeight] = useState(0);
  const scrollElement = useCallback(() => listRef.current?.closest<HTMLElement>("[data-agent-context-view-scroll]") ?? null, []);
  useLayoutEffect(() => {
    const list = listRef.current;
    const scroller = scrollElement();
    if (!list || !scroller) return;
    const update = () => {
      const next = list.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
      setScrollMargin((current) => (Math.abs(current - next) < 0.5 ? current : next));
      setToolbarHeight(toolbarRef.current?.offsetHeight ?? 0);
    };
    update();
    const observer = new ResizeObserver(update);
    // The list moves when a section above it folds or unfolds, the toolbar wraps, or the panel resizes.
    observer.observe(scroller);
    if (scroller.firstElementChild) observer.observe(scroller.firstElementChild);
    if (toolbarRef.current) observer.observe(toolbarRef.current);
    return () => observer.disconnect();
  }, [scrollElement]);
  // Stuck at the scroller's top, the toolbar is opaque and painted over the
  // panel's scrollbar (its z-chrome over the gutters' z-1), so the scrollbar
  // starts below it (raft-ui ScrollArea's rail inset, set on the scroller,
  // which is the panel's): else the toolbar hides a thumb near the top and
  // shows only its part below the toolbar.
  useLayoutEffect(() => {
    const scroller = scrollElement();
    if (!scroller || toolbarHeight <= 0) return;
    scroller.style.setProperty("--r-scroll-area-rail-inset-top", `${toolbarHeight}px`);
    return () => {
      scroller.style.removeProperty("--r-scroll-area-rail-inset-top");
    };
  }, [scrollElement, toolbarHeight]);
  const trigger = context.trigger;
  const pairs = useMemo(() => agentContextViewPairs(context), [context]);
  const timeline = useMemo(() => agentContextViewTimeline(context), [context]);
  const rowsByFilter = useMemo(() => agentContextViewRows(context, pairs), [context, pairs]);
  const calls = useMemo(() => agentContextViewCallsById(context), [context]);
  const counts = useMemo(() => ({
    all: agentContextViewMessageCount(rowsByFilter.all),
    conversation: agentContextViewMessageCount(rowsByFilter.conversation),
    notices: agentContextViewMessageCount(rowsByFilter.notices),
    tools: agentContextViewMessageCount(rowsByFilter.tools),
  }), [rowsByFilter]);
  const [filter, setFilter] = useState<AgentContextViewFilter>("all");
  const rows = rowsByFilter[filter];
  const [search, setSearch] = useState<SearchState | null>(null);
  const [folds, setFolds] = useState<Folds>(NO_FOLDS);
  const [scrollRequest, setScrollRequest] = useState<ScrollRequest | null>(null);
  const getItemKey = useCallback((index: number) => `${filter}:${rows[index]?.messageIndex ?? index}`, [filter, rows]);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: scrollElement,
    estimateSize: () => ESTIMATED_ROW,
    getItemKey,
    overscan: 4,
    scrollMargin,
    // The sticky toolbar covers the top of the scroller.
    scrollPaddingStart: toolbarHeight,
    // A bounded first commit before the scroller is observed.
    initialRect: { width: 480, height: 800 },
  });
  // Where the panel opens: the send call, or (no trigger) the last message. Once, after the margin is known.
  const scrolled = useRef(false);
  useEffect(() => {
    if (scrolled.current || context.messages.length === 0) return;
    if (!scrollElement()) return;
    scrolled.current = true;
    const rowsShown = rowsByFilter.all;
    virtualizer.scrollToIndex(trigger ? agentContextViewRowAtOrAfter(rowsShown, trigger.messageIndex) : rowsShown.length - 1, { align: trigger ? "center" : "start" });
  }, [context.messages.length, rowsByFilter, scrollElement, scrollMargin, trigger, virtualizer]);
  // A scroll asked for by the toolbar, after the render that applied it (the rows of a new filter, an opened fold).
  const frames = useRef({ id: 0 });
  useLayoutEffect(() => {
    if (!scrollRequest) return;
    if ("top" in scrollRequest) {
      virtualizer.scrollToOffset(0);
      return;
    }
    virtualizer.scrollToIndex(scrollRequest.index, { align: scrollRequest.align });
    const scroller = scrollElement();
    if (scrollRequest.match && scroller && typeof requestAnimationFrame === "function") revealCurrentMatch(scroller, frames.current);
  }, [scrollElement, scrollRequest, virtualizer]);
  useEffect(() => {
    const pending = frames.current;
    return () => cancelAnimationFrame(pending.id);
  }, []);

  /** Make `active` the current match: open its folds and scroll to it. */
  const goToMatch = useCallback((next: SearchState) => {
    setSearch(next);
    if (next.active === null) return;
    const match = locateAgentContextViewMatch(next.matches, next.active);
    setFolds((current) => unfoldMatch(current, context, pairs, match, next.pattern));
    setScrollRequest({ index: match.row, align: "center", match: true });
  }, [context, pairs]);
  /** Search `rows` for `pattern`, starting from the row in view (or `fromRow`). */
  const searchRows = useCallback((pattern: RegExp, searched: readonly AgentContextViewRow[], fromRow: number) => {
    const matches = findAgentContextViewMatches(context, searched, pattern, pairs);
    goToMatch({ pattern, matches, active: matches.total > 0 ? firstAgentContextViewMatchFrom(matches, fromRow) : null });
  }, [context, goToMatch, pairs]);
  // The rows shown now, for a query that arrives after a filter change.
  const rowsRef = useRef(rows);
  useLayoutEffect(() => {
    rowsRef.current = rows;
  }, [rows]);
  const onQuery = useCallback((query: string) => {
    const pattern = agentContextViewSearchPattern(query);
    if (!pattern) {
      setSearch(null);
      return;
    }
    searchRows(pattern, rowsRef.current, virtualizer.range?.startIndex ?? 0);
  }, [searchRows, virtualizer]);
  const onStep = useCallback((direction: 1 | -1) => {
    if (!search || search.matches.total === 0) return;
    const total = search.matches.total;
    const active = search.active === null ? (direction === 1 ? 0 : total - 1) : (search.active + direction + total) % total;
    goToMatch({ ...search, active });
  }, [goToMatch, search]);
  /** Show another filter's rows, staying at the message in view (or the next one it shows); a search goes on in them. */
  const changeFilter = useCallback((next: AgentContextViewFilter) => {
    if (next === filter) return;
    const nextRows = rowsByFilter[next];
    const inView = rows[virtualizer.range?.startIndex ?? 0]?.messageIndex ?? 0;
    const fromRow = nextRows.length > 0 ? agentContextViewRowAtOrAfter(nextRows, inView) : 0;
    setFilter(next);
    if (search) searchRows(search.pattern, nextRows, fromRow);
    else if (nextRows.length > 0) setScrollRequest({ index: fromRow, align: "start" });
  }, [filter, rows, rowsByFilter, search, searchRows, virtualizer]);
  const onJump = useCallback((to: AgentContextViewJump) => {
    if (to === "top") setScrollRequest({ top: true });
    else if (to === "end") setScrollRequest({ index: rows.length - 1, align: "end" });
    else if (trigger) {
      // Conversation hides the send call: show it in All.
      const shown = rows.some((row) => row.messageIndex === trigger.messageIndex && row.parts.includes(trigger.partIndex));
      if (!shown) changeFilter("all");
      setScrollRequest({ index: agentContextViewRowAtOrAfter(shown ? rows : rowsByFilter.all, trigger.messageIndex), align: "center" });
    }
  }, [changeFilter, rows, rowsByFilter, trigger]);
  const toggleFold = useCallback<ToggleFold>((kind, key) => {
    setFolds((current) => {
      const set = new Set(current[kind]);
      if (!set.delete(key)) set.add(key);
      return { ...current, [kind]: set };
    });
  }, []);
  const activeMatch = useMemo(() => (search && search.active !== null ? locateAgentContextViewMatch(search.matches, search.active) : null), [search]);

  return (
    <>
      <AgentContextViewToolbar
        ref={toolbarRef}
        filter={filter}
        counts={counts}
        onFilter={changeFilter}
        onQuery={onQuery}
        onStep={onStep}
        active={search?.active ?? null}
        total={search ? search.matches.total : null}
        hasTrigger={trigger !== null}
        onJump={onJump}
      />
      {rows.length === 0 ? (
        <div className="px-(--column-margin) py-3">
          <Hint testId="agent-context-view-filter-empty">{formatMessage({ id: "agentContextView.filter.empty" })}</Hint>
        </div>
      ) : null}
      <div ref={listRef} style={{ height: virtualizer.getTotalSize(), position: "relative", width: "100%" }} data-testid="agent-context-view-message-list">
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index]!;
          const triggerShown = trigger && trigger.messageIndex === row.messageIndex && row.parts.includes(trigger.partIndex);
          const turnIndex = timeline.turnOf[row.messageIndex]!;
          const previous = rows[item.index - 1];
          const startsTurn = !previous || timeline.turnOf[previous.messageIndex] !== turnIndex;
          const next = rows[item.index + 1];
          const edges = agentContextViewRowStepEdges(context, row);
          const joinTop = !startsTurn && previous !== undefined && edges.starts && agentContextViewRowStepEdges(context, previous).ends;
          const joinBottom = next !== undefined && timeline.turnOf[next.messageIndex] === turnIndex && edges.ends && agentContextViewRowStepEdges(context, next).starts;
          return (
            <div
              key={item.key}
              ref={virtualizer.measureElement}
              data-index={item.index}
              style={{ left: 0, position: "absolute", top: 0, transform: `translateY(${item.start - scrollMargin}px)`, width: "100%" }}
            >
              <AgentContextViewMessageRow
                message={context.messages[row.messageIndex]!}
                index={row.messageIndex}
                row={row}
                messages={context.messages}
                turn={startsTurn ? timeline.turns[turnIndex]! : null}
                turnKind={timeline.turns[turnIndex]!.kind}
                first={item.index === 0}
                last={item.index === rows.length - 1}
                joinTop={joinTop}
                joinBottom={joinBottom}
                agentName={agentName}
                agentAvatarUrl={agentAvatarUrl}
                trigger={triggerShown ? trigger : null}
                stepOf={timeline.stepOf}
                pairs={pairs}
                calls={calls}
                sent={sent}
                folds={folds}
                onToggle={toggleFold}
                pattern={search?.pattern ?? null}
                activeMatch={activeMatch?.row === item.index ? activeMatch : null}
              />
            </div>
          );
        })}
      </div>
    </>
  );
}

