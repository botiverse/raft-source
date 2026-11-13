import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent, RefObject } from "react";
import { X, Image, Copy, Check, Ellipsis } from "lucide-react";
import { useIntl } from "react-intl";
import { useSelectionStore } from "../../store/selectionStore";
import { useFocusRestore } from "../../hooks/useFocusRestore";
import {
  Button,
  Checkbox,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  MessageMultiSelectToolbar,
  MessageMultiSelectToolbarActions,
  Spinner,
} from "@botiverse/raft-ui";
import Tooltip from "../ui/Tooltip";
import { useToastViewportFloor } from "../toastViewportBottom";
import { COMPOSER_EDGE_CLASS } from "./composerHost";
import { ForwardIcon } from "./messageForwardIcon";

export interface SelectModeToolbarProps {
  /** Channel id this toolbar is mounted under. Renders only when select mode is scoped here. */
  channelId: string;
  /** Click handler for the Share preview button. Disabled when 0 selected. */
  onSavePic: () => void;
  /** Click handler for the Copy-MD button. Disabled when 0 selected. */
  onCopyMd: () => void;
  /** Click handler for opening the message-forward composer. */
  onForward?: () => void;
  /**
   * The source channel is still loading: Forward shows disabled, its tooltip
   * just its name (no reason sentence) (forwardAvailability).
   */
  forwardPending?: boolean;
  /** Click handler for copying permalinks for the current selection. */
  onCopyLinks?: () => void;
  /**
   * A thread's selectable messages (its parent and replies that can be
   * selected). Given only in a thread: the toolbar then leads with a
   * select-all checkbox before the count. A channel's toolbar has none.
   */
  selectableIds?: readonly string[];
  /**
   * False while the thread has messages not loaded yet (older or newer
   * pages, or history behind the plan's limit): selectableIds is then only
   * part of the thread, so the count never says "All".
   */
  selectableComplete?: boolean;
  /** True while the screenshot is being rendered for the Share preview. */
  capturing?: boolean;
  /** Cancels an in-flight image job without clearing the selection. */
  onCancelCapture?: () => void;
  captureProgressLabel?: string | null;
  /** True for ~1.5s after Copy MD succeeds, swaps the icon for a check. */
  copied?: boolean;
  /** The conversation (composer, rows, scroller) focus returns to when × ends the selection. */
  focusScopeRef?: RefObject<HTMLElement | null>;
}

/**
 * How far the toolbar sits from the conversation's bottom: 12px, plus the
 * home indicator on a phone.
 */
const PILL_BOTTOM_CLASS = "pb-[calc(12px+env(safe-area-inset-bottom,0px))]";

/**
 * The room the floating toolbar takes at the bottom of the conversation: its
 * 36px plus its offset (PILL_BOTTOM_CLASS). Set on the message list's
 * positioned container while select mode is on there, so the controls that
 * float over the list's bottom (the agent typing line, the jump pills) sit
 * above the toolbar instead of under it.
 */
export const SELECT_MODE_LIST_RESERVE_CLASS = "[--select-mode-reserve:calc(48px+env(safe-area-inset-bottom,0px))]";

/**
 * The list's extra end while select mode is on: the toolbar floats over the
 * bottom of the list, so the list ends the toolbar's height plus its offset
 * higher, and a reader at the bottom sees the last message whole above it.
 * Goes in the timeline footer, like AgentTypingListEnd.
 */
export function SelectModeListEnd() {
  return <div aria-hidden="true" data-testid="select-mode-list-end" className="h-[calc(48px+env(safe-area-inset-bottom,0px))]" />;
}

/**
 * Ends the selection, and returns focus if it was lost with the toolbar (×
 * or Esc: the toolbar unmounts and focus would fall to <body>): to the
 * composer, back in the toolbar's place; without one (read only, a thread
 * you can't reply in), to the message the selection started on; if that
 * isn't on screen, to the conversation's message list. Focus that is
 * somewhere real stays put (useFocusRestore, a frame later: the composer has
 * mounted in the toolbar's place, and one that focuses itself has done so).
 *
 * `containerRef` is the conversation: its composer, rows and scroller.
 */
export function useExitSelectionReturningFocus(containerRef: RefObject<HTMLElement | null> | undefined): () => void {
  const originRef = useRef<string | null>(null);
  const restore = useFocusRestore(() => {
    const container = containerRef?.current;
    if (!container?.isConnected) return null;
    const composerInput = container.querySelector<HTMLElement>('[data-slot="composer-root"] textarea');
    if (composerInput) return composerInput;
    const originId = originRef.current;
    const originBody = originId
      ? container.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(originId)}"]`)
      : null;
    // The row takes focus only from script (tabIndex -1), as a located
    // message does (raft-ui MessageItem, focus ring).
    const target = originBody?.closest<HTMLElement>('[data-slot="message-item"]')
      ?? container.querySelector<HTMLElement>('[data-testid="message-scroller"], [data-testid="thread-message-scroller"]');
    if (target && !target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
    return target;
  }, { preventScroll: true });
  return useCallback(() => {
    const { originId, exit } = useSelectionStore.getState();
    originRef.current = originId;
    exit();
    restore();
  }, [restore]);
}

// The row's give-way steps, taken one at a time until it fits on one line
// (the level is how many are taken): Copy Link shows its label only when it
// fits, otherwise only its icon (its name stays in its aria-label and
// tooltip); if there is still no room it moves into More. Only where even
// that can't fit (a long count in a long language on the narrowest phone)
// does Forward show only its icon, as a last resort. The count never gives
// way, and the row never wraps.
type FitStep = "copyLinkIcon" | "copyLinkInMore" | "forwardIcon";
type FitLevel = 0 | 1 | 2 | 3;

/**
 * The toolbar for selected messages (Raft DS › Components › Toolbar for
 * selected messages; Conversation › "Three kinds of control float over a
 * conversation"). It floats, centred, over the bottom of the conversation
 * where the composer was: raft-ui MessageMultiSelectToolbar, 36px tall, with
 * 28px buttons 4px inside it and 4px apart at radius-chip, the hover
 * toolbar's metrics. On a touch screen the buttons stay 28px: the raft-ui
 * part gives each a 44px tap, reaching only half the gap toward its
 * neighbour, so a tap between two lands on the nearer one.
 *
 * Order: (in a thread, the select-all checkbox) · "N selected" · Copy Link ·
 * Forward · More (Generate Image, Copy MD) · ×. Esc cancels the selection
 * (ChatPanel and ThreadPanel own that key).
 *
 * The thread's checkbox: [✓] when the selection is exactly the selectable
 * messages (the count then reads "All N selected", once the whole thread is
 * loaded; before that, the plain "N selected"), [-] when anything else is
 * selected (some of them, or messages outside them), [ ] when none are.
 * Clicking [-] or [✓] clears the selection; clicking [ ] selects them all.
 * With 0 selected the toolbar stays, every action is disabled, and only ×
 * ends the selection.
 *
 * Render it in the conversation's footer in place of the composer. It takes
 * no height there: it floats up over the list, which reserves its room with
 * SelectModeListEnd and SELECT_MODE_LIST_RESERVE_CLASS. It keeps the
 * composer's edge from the conversation's sides (COMPOSER_EDGE_CLASS) and
 * floats 12px above its bottom. When × or Esc ends the selection, focus
 * returns into the conversation (useExitSelectionReturningFocus).
 */
export default function SelectModeToolbar({
  channelId,
  onSavePic,
  onCopyMd,
  onForward,
  forwardPending = false,
  onCopyLinks,
  selectableIds,
  selectableComplete = true,
  capturing = false,
  onCancelCapture,
  captureProgressLabel,
  copied = false,
  focusScopeRef,
}: SelectModeToolbarProps) {
  const { formatMessage } = useIntl();
  const isActive = useSelectionStore((s) => s.isActive);
  const selectionChannelId = useSelectionStore((s) => s.channelId);
  const count = useSelectionStore((s) => s.selectedIds.size);
  // The selection is exactly the selectable set: not a message more (a row
  // ticked by hand that select-all leaves out, an id of a deleted message).
  const allSelected = useSelectionStore((s) => (
    !!selectableIds
    && selectableIds.length > 0
    && s.selectedIds.size === selectableIds.length
    && selectableIds.every((id) => s.selectedIds.has(id))
  ));
  const saysAll = allSelected && selectableComplete;
  const exitReturningFocus = useExitSelectionReturningFocus(focusScopeRef);
  const toastFloorRef = useToastViewportFloor();
  const [fitLevel, setFitLevel] = useState<FitLevel>(0);
  const areaRef = useRef<HTMLDivElement | null>(null);
  const pillRef = useRef<HTMLDivElement | null>(null);
  const actionsRef = useRef<HTMLDivElement | null>(null);
  // The width each level was entered at: the row steps back up a level once
  // its room is more than 8px wider than that (hysteresis, so it can't
  // flicker between two levels), however slowly the room grows.
  const enteredAtRef = useRef<Partial<Record<FitLevel, number>>>({});
  // The level the DOM shows. A measurement taken before a pending step has
  // rendered (StrictMode runs the effect twice) must not step again.
  const shownFitLevelRef = useRef(fitLevel);
  shownFitLevelRef.current = fitLevel;

  const canAct = count > 0 && !capturing;
  const canForward = canAct && !!onForward && !forwardPending;
  const fitSteps: FitStep[] = [
    ...(onCopyLinks ? ["copyLinkIcon", "copyLinkInMore"] as const : []),
    ...(onForward ? ["forwardIcon"] as const : []),
  ];
  const maxFitLevel = fitSteps.length as FitLevel;
  const taken = (step: FitStep) => fitSteps.indexOf(step) >= 0 && fitSteps.indexOf(step) < fitLevel;
  const copyLinkIconOnly = taken("copyLinkIcon");
  const copyLinkInMore = taken("copyLinkInMore");
  const forwardIconOnly = taken("forwardIcon");
  // Everything in More acts on the selection.
  const moreDisabled = count === 0;
  // [-] and [✓] clear; [ ] selects every selectable message. Select mode stays on.
  const onSelectAllCheckbox = useCallback(() => {
    const { selectAll } = useSelectionStore.getState();
    selectAll(count > 0 ? [] : selectableIds ?? []);
  }, [count, selectableIds]);
  const toolbarLabel = formatMessage({ id: "message.selectModeToolbar.label" });
  const selectAllInThreadLabel = formatMessage({ id: "message.selectModeToolbar.selectAllInThread" });
  const cancelLabel = formatMessage({ id: "message.selectModeToolbar.cancel" });
  const forwardLabel = formatMessage({ id: "message.selectModeToolbar.forward" });
  const copyLinkLabel = formatMessage({ id: "message.selectModeToolbar.copyLink" });
  const copiedLabel = formatMessage({ id: "message.selectModeToolbar.copied" });
  const moreLabel = formatMessage({ id: "message.selectModeToolbar.more" });
  const moreActionsLabel = formatMessage({ id: "message.selectModeToolbar.moreActions" });
  const renderingLabel = formatMessage({ id: "message.selectModeToolbar.rendering" });
  const generateImageLabel = formatMessage({ id: "message.selectModeToolbar.generateImage" });
  const copyMdLabel = formatMessage({ id: "message.selectModeToolbar.copyMd" });
  const copiedMdLabel = formatMessage({ id: "message.selectModeToolbar.copiedMd" });
  const shown = isActive && selectionChannelId === channelId;
  // What the row holds besides its fixed labels; when it changes the row is
  // fitted again from every label.
  const fitContentKey = `${shown}|${count}|${saysAll}|${copied}|${capturing}|${captureProgressLabel ?? ""}`;
  const fittedContentKeyRef = useRef(fitContentKey);

  useLayoutEffect(() => {
    const area = areaRef.current;
    const pill = pillRef.current;
    const actions = actionsRef.current;
    if (!area || !pill || !actions) return;
    // New content (another count, Copied, a capture's progress) may need
    // less room than what made a label give way: fit again from every label,
    // before paint.
    if (fittedContentKeyRef.current !== fitContentKey) {
      fittedContentKeyRef.current = fitContentKey;
      if (shownFitLevelRef.current > 0) {
        enteredAtRef.current = {};
        setFitLevel(0);
        return;
      }
    }
    let frame = 0;
    const decide = () => {
      const width = area.clientWidth;
      // The toolbar is no wider than the conversation; when its row needs
      // more, the actions run past its end. (Not scrollWidth: each button's
      // 44px hit area overhangs the toolbar's edge by design.)
      const contentEnd = pill.getBoundingClientRect().right - (Number.parseFloat(getComputedStyle(pill).paddingRight) || 0);
      const overflow = actions.getBoundingClientRect().right > contentEnd + 1;
      setFitLevel((current) => {
        if (current !== shownFitLevelRef.current) return current;
        if (overflow) {
          if (current >= maxFitLevel) return current;
          const next = (current + 1) as FitLevel;
          enteredAtRef.current[next] = width;
          return next;
        }
        // It fits. With clearly more room than this level was entered at,
        // try the level above; if that overflows it steps back down, before
        // paint, and remembers the new width.
        const enteredAt = enteredAtRef.current[current];
        if (current > 0 && enteredAt !== undefined && width > enteredAt + 8) return (current - 1) as FitLevel;
        return current;
      });
    };
    // Decide before paint: a state set in a layout effect re-renders before
    // the browser paints, so the row shows the level that fits from its
    // first frame (Raft DS › Responsive layout, "The first frame is the
    // settled one"). Later resizes wait for a frame.
    decide();
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(decide);
    });
    observer.observe(area);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [fitContentKey, fitLevel, maxFitLevel]);

  // role="toolbar": the arrow keys move between its buttons too (WAI-ARIA
  // toolbar pattern). Tab still visits each button in order.
  const onToolbarKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End") return;
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), [role="checkbox"]:not([data-disabled])'));
    const index = buttons.indexOf(document.activeElement as HTMLElement);
    if (index < 0 || buttons.length === 0) return;
    event.preventDefault();
    const next = event.key === "Home"
      ? 0
      : event.key === "End"
        ? buttons.length - 1
        : (index + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
  }, []);

  if (!shown) return null;

  return (
    // A zero-height slot: the toolbar floats up from it, over the list's
    // bottom edge. Clicks beside the toolbar reach the messages under it.
    <div className="relative h-0 w-full" data-testid="select-mode-toolbar-slot">
      <div
        ref={(element) => {
          areaRef.current = element;
          return toastFloorRef(element);
        }}
        className={`pointer-events-none absolute inset-x-0 bottom-0 flex justify-center ${COMPOSER_EDGE_CLASS} ${PILL_BOTTOM_CLASS}`}
        data-testid="select-mode-toolbar-area"
        data-fit-level={fitLevel}
      >
        <MessageMultiSelectToolbar
          ref={pillRef}
          role="toolbar"
          aria-label={toolbarLabel}
          aria-orientation="horizontal"
          onKeyDown={onToolbarKeyDown}
          // The raft-ui part, kept to one row: it may be no wider than the
          // conversation, and what doesn't fit gives way (FitLevel) instead
          // of wrapping. The seam ring sits inside its edge, like the hover
          // toolbar's.
          className="pointer-events-auto min-w-0 max-w-full flex-nowrap ring-inset"
          data-testid="select-mode-toolbar"
        >
          {selectableIds && (
            <Checkbox
              checked={allSelected}
              indeterminate={count > 0 && !allSelected}
              disabled={capturing || (count === 0 && selectableIds.length === 0)}
              onCheckedChange={onSelectAllCheckbox}
              aria-label={selectAllInThreadLabel}
              data-testid="select-mode-select-all"
            />
          )}
          {/* A polite live region: a screen reader says the new count when it changes. */}
          <span
            className="shrink-0 whitespace-nowrap text-control font-bold tabular-nums text-foreground"
            data-testid="select-mode-count"
            aria-live="polite"
            aria-atomic="true"
          >
            {saysAll
              ? formatMessage({ id: "message.selectModeToolbar.allSelectedCount" }, { count })
              : formatMessage({ id: "message.selectModeToolbar.selectedCount" }, { count })}
          </span>
          {captureProgressLabel ? (
            <span className="min-w-0 truncate font-mono text-mono-meta text-foreground-hint" data-testid="select-mode-capture-progress">
              {captureProgressLabel}
            </span>
          ) : null}
          <MessageMultiSelectToolbarActions ref={actionsRef} className="flex-none flex-nowrap">
            {onCopyLinks && !copyLinkInMore && (
              <Tooltip content={copied ? copiedLabel : copyLinkLabel}>
                <Button
                  type="button"
                  onClick={onCopyLinks}
                  disabled={count === 0}
                  size={copyLinkIconOnly ? "icon-md" : "md"}
                  variant="ghost"
                  aria-label={copyLinkLabel}
                  data-testid="select-mode-copy-link"
                >
                  {copied ? <Check /> : <Copy />}
                  {!copyLinkIconOnly && <span>{copied ? copiedLabel : copyLinkLabel}</span>}
                </Button>
              </Tooltip>
            )}
            {onForward && (
              <Tooltip content={forwardLabel}>
                <Button
                  type="button"
                  onClick={onForward}
                  disabled={!canForward}
                  size={forwardIconOnly ? "icon-md" : "md"}
                  variant="ghost"
                  aria-label={forwardLabel}
                  data-testid="select-mode-forward"
                >
                  <ForwardIcon />
                  {!forwardIconOnly && <span>{forwardLabel}</span>}
                </Button>
              </Tooltip>
            )}
            <DropdownMenu>
              <Tooltip content={moreLabel}>
                <DropdownMenuTrigger
                  disabled={moreDisabled}
                  render={(
                    <Button
                      type="button"
                      size="icon-md"
                      variant="ghost"
                      aria-label={moreActionsLabel}
                      data-testid="select-mode-more"
                    >
                      <Ellipsis />
                    </Button>
                  )}
                />
              </Tooltip>
              <DropdownMenuContent
                side="top"
                align="end"
                sideOffset={8}
                aria-label={moreActionsLabel}
                data-testid="select-mode-more-menu"
              >
                {copyLinkInMore && (
                  <DropdownMenuItem
                    onClick={onCopyLinks}
                    disabled={count === 0}
                    data-testid="select-mode-copy-link"
                  >
                    {copied ? <Check size={14} /> : <Copy size={14} />}
                    {copied ? copiedLabel : copyLinkLabel}
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem
                  onClick={onSavePic}
                  disabled={!canAct}
                  data-testid="select-mode-share-open"
                >
                  {capturing ? <Spinner size="sm" aria-label={formatMessage({ id: "common.loadingLabel" })} /> : <Image size={14} />}
                  {capturing ? renderingLabel : generateImageLabel}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={onCopyMd}
                  disabled={count === 0}
                  data-testid="select-mode-copy-md"
                >
                  {copied ? <Check size={14} /> : <Copy size={14} />}
                  {copied ? copiedMdLabel : copyMdLabel}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Tooltip content={cancelLabel}>
              <Button
                type="button"
                onClick={capturing && onCancelCapture ? onCancelCapture : exitReturningFocus}
                size="icon-md"
                variant="ghost"
                aria-label={cancelLabel}
                data-testid="select-mode-cancel"
              >
                <X />
              </Button>
            </Tooltip>
          </MessageMultiSelectToolbarActions>
        </MessageMultiSelectToolbar>
      </div>
    </div>
  );
}
