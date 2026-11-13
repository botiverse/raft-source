import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ChangeEvent, ComponentType, CompositionEvent, KeyboardEvent, Ref, RefObject } from "react";
import { useIntl } from "react-intl";
import { ArrowDownToLine, ArrowUpToLine, ChevronDown, ChevronUp, Inbox, List, LocateFixed, Search, Wrench, X } from "lucide-react";
import {
  Button,
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  SegmentedControl,
  SegmentedControlCount,
  SegmentedControlItem,
  SegmentedControlLabel,
} from "@botiverse/raft-ui";
import { MessageIcon } from "@botiverse/ricons";
import { KbdShortcut } from "@botiverse/raft-ui/wip";

import type { MessageId } from "../../i18n/messages/en";
import { isSearchKeyboardComposing } from "../../features/search/searchComposition";
import { shortcutKeyNames, shortcutSpokenLabel } from "../../utils/keyboardShortcuts";
import type { ShortcutCombo } from "../../utils/keyboardShortcuts";
import Tooltip from "../ui/Tooltip";
import { AGENT_CONTEXT_VIEW_FILTERS, AGENT_CONTEXT_VIEW_SEARCH_DEBOUNCE_MS } from "./agentContextViewMessageFilter";
import type { AgentContextViewFilter } from "./agentContextViewMessageFilter";

const FILTER_COPY: Record<AgentContextViewFilter, MessageId> = {
  all: "agentContextView.filter.all",
  conversation: "agentContextView.filter.conversation",
  notices: "agentContextView.filter.notices",
  tools: "agentContextView.filter.tools",
};
const FILTER_ICON: Record<AgentContextViewFilter, ComponentType<{ "aria-hidden"?: boolean }>> = { all: List, conversation: MessageIcon, notices: Inbox, tools: Wrench };

const NEXT: ShortcutCombo = { key: "Enter" };
const PREVIOUS: ShortcutCombo = { key: "Enter", shift: true };

export type AgentContextViewJump = "trigger" | "top" | "end";

/**
 * Whether the filter's segments fit with their labels in the room they are
 * given (measured with the labels shown, whatever shows now, so it can't flap
 * at the edge; again when the room resizes or the labels or counts change).
 * Where they don't, a segment keeps its icon and its count, its label the
 * accessible name and a tooltip: raft-ui's icons-only mode would hide the
 * count too. Unmeasured (no layout), the labels show.
 *
 * Compact is one attribute on the track (`data-compact`): every compact style
 * (hidden labels, narrower padding) hangs off it, so a measurement that takes
 * it off reads the labelled layout whole, and the answer can't flap.
 */
function useFilterLabelsFit(track: RefObject<HTMLDivElement | null>, room: RefObject<HTMLDivElement | null>, labels: string) {
  const [fit, setFit] = useState(true);
  useLayoutEffect(() => {
    const trackElement = track.current;
    const roomElement = room.current;
    if (!trackElement || !roomElement || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const compact = trackElement.hasAttribute("data-compact");
      if (compact) trackElement.removeAttribute("data-compact");
      const needed = trackElement.scrollWidth;
      if (compact) trackElement.setAttribute("data-compact", "");
      const available = roomElement.clientWidth;
      setFit(available === 0 || needed <= available + 0.5);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(roomElement);
    return () => observer.disconnect();
  }, [labels, room, track]);
  return fit;
}

/**
 * The Messages list's toolbar (AgentContextViewContent), sticky at the top of
 * the panel's scroller: the search field with "3 of 17" and Previous / Next,
 * the filter, and the jumps (the send call, the first and the last message).
 * The filter is also search's scope: search reads only what the filter shows
 * (All, Conversation, Raft notices, Tool calls), so there is no second type
 * picker beside the field.
 * One row where the panel is wide (a container query on the toolbar, from
 * 48rem); narrower (the 440px side column, a phone) two: the search field the
 * whole width, then the filter (its labels give way where they don't fit,
 * each segment keeping its icon and count) and the jumps, so nothing is
 * squeezed, clipped or overlapped.
 *
 * The field owns what is typed; the list hears the query only once typing
 * rests (or on Enter), and never while an input method composes. Enter is
 * Next, Shift+Enter Previous. Esc clears a query and stays in the field (on a
 * phone page an Esc in an empty field still closes the page).
 */
export const AgentContextViewToolbar = memo(function AgentContextViewToolbar({ ref, filter, counts, onFilter, onQuery, onStep, active, total, hasTrigger, onJump }: {
  ref?: Ref<HTMLDivElement>;
  filter: AgentContextViewFilter;
  /** How many messages each filter shows. */
  counts: Record<AgentContextViewFilter, number>;
  onFilter: (filter: AgentContextViewFilter) => void;
  /** The query the list searches for ("" for none). */
  onQuery: (query: string) => void;
  onStep: (direction: 1 | -1) => void;
  /** The current match (0-based), and how many there are; total null while there is no query. */
  active: number | null;
  total: number | null;
  hasTrigger: boolean;
  onJump: (to: AgentContextViewJump) => void;
}) {
  const { formatMessage, formatNumber } = useIntl();
  const [draft, setDraft] = useState("");
  const filterTrack = useRef<HTMLDivElement | null>(null);
  const filterRoom = useRef<HTMLDivElement | null>(null);
  const segments = AGENT_CONTEXT_VIEW_FILTERS.map((value) => ({ value, label: formatMessage({ id: FILTER_COPY[value] }), count: formatNumber(counts[value]) }));
  const labelsFit = useFilterLabelsFit(filterTrack, filterRoom, segments.map((segment) => `${segment.label} ${segment.count}`).join("|"));
  const committed = useRef("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const field = useRef<HTMLInputElement | null>(null);
  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current);
  }, []);

  // The latest onQuery: a timer set before a filter change must search the new filter's rows.
  const onQueryRef = useRef(onQuery);
  useLayoutEffect(() => {
    onQueryRef.current = onQuery;
  }, [onQuery]);
  const commit = useCallback((query: string) => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    // Spaces around the words don't change the search.
    const trimmed = query.trim();
    if (trimmed === committed.current) return false;
    committed.current = trimmed;
    onQueryRef.current(trimmed);
    return true;
  }, []);
  const schedule = useCallback((query: string) => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => commit(query), AGENT_CONTEXT_VIEW_SEARCH_DEBOUNCE_MS);
  }, [commit]);

  const onChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const value = event.target.value;
    setDraft(value);
    // While an input method composes, the text isn't the query yet; it is once composing ends.
    if (!(event.nativeEvent as Partial<InputEvent>).isComposing) schedule(value);
  }, [schedule]);
  const onCompositionEnd = useCallback((event: CompositionEvent<HTMLInputElement>) => schedule(event.currentTarget.value), [schedule]);
  const clear = useCallback(() => {
    setDraft("");
    commit("");
    field.current?.focus();
  }, [commit]);
  const onKeyDown = useCallback((event: KeyboardEvent<HTMLInputElement>) => {
    if (isSearchKeyboardComposing(event)) return;
    if (event.key === "Enter") {
      event.preventDefault();
      // Typed but not searched yet: search now (that goes to its first match) rather than step.
      if (!commit(event.currentTarget.value)) onStep(event.shiftKey ? -1 : 1);
    } else if (event.key === "Escape" && event.currentTarget.value !== "") {
      // The field's Esc: not the phone page's (which would close it).
      event.preventDefault();
      event.stopPropagation();
      clear();
    }
  }, [clear, commit, onStep]);
  const previous = useCallback(() => onStep(-1), [onStep]);
  const next = useCallback(() => onStep(1), [onStep]);
  const jumpTrigger = useCallback(() => onJump("trigger"), [onJump]);
  const jumpTop = useCallback(() => onJump("top"), [onJump]);
  const jumpEnd = useCallback(() => onJump("end"), [onJump]);

  const label = formatMessage({ id: "agentContextView.search.label" });
  const previousLabel = formatMessage({ id: "agentContextView.search.previous" });
  const nextLabel = formatMessage({ id: "agentContextView.search.next" });
  const clearLabel = formatMessage({ id: "agentContextView.search.clear" });
  const count = total === null
    ? ""
    : total === 0 || active === null
      ? formatMessage({ id: "agentContextView.search.noMatches" })
      : formatMessage({ id: "agentContextView.search.count" }, { active: formatNumber(active + 1), total: formatNumber(total) });
  const moves = total !== null && total > 0;
  const jumps: Array<{ to: AgentContextViewJump; label: string; icon: typeof List; onClick: () => void }> = [
    ...(hasTrigger ? [{ to: "trigger" as const, label: formatMessage({ id: "agentContextView.jump.trigger" }), icon: LocateFixed, onClick: jumpTrigger }] : []),
    { to: "top", label: formatMessage({ id: "agentContextView.jump.top" }), icon: ArrowUpToLine, onClick: jumpTop },
    { to: "end", label: formatMessage({ id: "agentContextView.jump.end" }), icon: ArrowDownToLine, onClick: jumpEnd },
  ];

  return (
    <div
      ref={ref}
      className="@container/toolbar sticky top-0 z-chrome border-b border-line-hairline bg-layer-canvas px-(--column-margin) py-2"
      data-testid="agent-context-view-toolbar"
    >
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-2">
      <div role="search" className="flex min-w-0 basis-full items-center gap-1 @3xl/toolbar:flex-1 @3xl/toolbar:basis-0" data-testid="agent-context-view-toolbar-search">
        <InputGroup className="min-w-0 flex-1">
          <InputGroupAddon>
            <Search aria-hidden />
          </InputGroupAddon>
          <InputGroupInput
            ref={field}
            value={draft}
            onChange={onChange}
            onCompositionEnd={onCompositionEnd}
            onKeyDown={onKeyDown}
            placeholder={label}
            aria-label={label}
            suppressPasswordManager
            data-testid="agent-context-view-search"
          />
          <InputGroupAddon.Text align="inline-end" role="status" className="ps-2" data-testid="agent-context-view-search-count">{count}</InputGroupAddon.Text>
          {draft !== "" ? (
            <InputGroupAddon align="inline-end">
              <Tooltip content={clearLabel}>
                <Button type="button" size="icon-md" variant="ghost" onClick={clear} aria-label={clearLabel} data-testid="agent-context-view-search-clear">
                  <X aria-hidden />
                </Button>
              </Tooltip>
            </InputGroupAddon>
          ) : null}
        </InputGroup>
        <Tooltip content={<>{previousLabel}<KbdShortcut keys={shortcutKeyNames(PREVIOUS)} label={shortcutSpokenLabel(PREVIOUS, formatMessage)} /></>}>
          <Button type="button" size="icon-md" variant="ghost" onClick={previous} disabled={!moves} aria-label={previousLabel} data-testid="agent-context-view-search-previous">
            <ChevronUp aria-hidden />
          </Button>
        </Tooltip>
        <Tooltip content={<>{nextLabel}<KbdShortcut keys={shortcutKeyNames(NEXT)} label={shortcutSpokenLabel(NEXT, formatMessage)} /></>}>
          <Button type="button" size="icon-md" variant="ghost" onClick={next} disabled={!moves} aria-label={nextLabel} data-testid="agent-context-view-search-next">
            <ChevronDown aria-hidden />
          </Button>
        </Tooltip>
      </div>
      <div className="flex min-w-0 basis-full items-center justify-between gap-2 @3xl/toolbar:flex-1 @3xl/toolbar:basis-0" data-testid="agent-context-view-toolbar-filters">
        <div ref={filterRoom} className="min-w-0 flex-1">
        <SegmentedControl<AgentContextViewFilter>
          ref={filterTrack}
          className="data-compact:**:data-[slot=segmented-control-item]:px-2 data-compact:**:data-[slot=segmented-control-label]:sr-only"
          aria-label={formatMessage({ id: "agentContextView.filter.label" })}
          value={filter}
          onValueChange={onFilter}
          data-testid="agent-context-view-filter"
          data-labels={labelsFit ? "shown" : "hidden"}
          data-compact={labelsFit ? undefined : ""}
        >
          {segments.map(({ value, label, count }) => {
            const Icon = FILTER_ICON[value];
            const item = (
              <SegmentedControlItem key={value} value={value} data-testid={`agent-context-view-filter-${value}`}>
                <Icon aria-hidden />
                <SegmentedControlLabel>{label}</SegmentedControlLabel>
                <SegmentedControlCount>{count}</SegmentedControlCount>
              </SegmentedControlItem>
            );
            return labelsFit ? item : <Tooltip key={value} content={label}>{item}</Tooltip>;
          })}
        </SegmentedControl>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {jumps.map(({ to, label: jumpLabel, icon: Icon, onClick }) => (
            <Tooltip key={to} content={jumpLabel}>
              <Button type="button" size="icon-md" variant="ghost" onClick={onClick} aria-label={jumpLabel} data-testid={`agent-context-view-jump-${to}`}>
                <Icon aria-hidden />
              </Button>
            </Tooltip>
          ))}
        </div>
      </div>
      </div>
    </div>
  );
});
