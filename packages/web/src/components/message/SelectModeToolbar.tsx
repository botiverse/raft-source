import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { Image, Copy, Check, Link } from "lucide-react";
import { useIntl } from "react-intl";
import { useSelectionStore } from "../../store/selectionStore";
import { useFocusRestore } from "../../hooks/useFocusRestore";
import {
  Checkbox,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  Spinner,
} from "@botiverse/raft-ui";
import {
  SelectionToolbar,
  SelectionToolbarAction,
  SelectionToolbarActions,
  SelectionToolbarClose,
  SelectionToolbarCount,
  SelectionToolbarCountValue,
  SelectionToolbarDock,
  SelectionToolbarHint,
  SelectionToolbarItem,
  SelectionToolbarMore,
  SelectionToolbarMoreItems,
} from "@botiverse/raft-ui/wip";
import { useToastViewportFloor } from "../toastViewportBottom";
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
  /** Copies the selection's links; resolves true once they are on the clipboard (the action then says Copied). */
  onCopyLinks?: () => Promise<boolean>;
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
  /**
   * Stops an in-flight image job, the selection kept: Generate image while it
   * renders. Ending the selection stops it too, in useSelectionShareHandlers.
   */
  onCancelCapture?: () => void;
  captureProgressLabel?: string | null;
  /** True for ~1.5s after Copy Markdown succeeds: its action shows a check and "Copied". */
  copied?: boolean;
  /** The conversation (composer, rows, scroller) focus returns to when × ends the selection. */
  focusScopeRef?: RefObject<HTMLElement | null>;
}

/**
 * The room the floating toolbar takes at the bottom of the conversation: its
 * height, a head's (`--header-height`: 44px with a mouse, 56px by touch), plus
 * the 12px and safe area SelectionToolbarDock floats it by. Set on the message list's
 * positioned container while select mode is on there, so the controls that
 * float over the list's bottom (the agent typing line, the jump pills) sit
 * above the toolbar instead of under it.
 */
export const SELECT_MODE_LIST_RESERVE_CLASS = "[--select-mode-reserve:calc(var(--header-height)+12px+env(safe-area-inset-bottom,0px))]";

/**
 * The list's extra end while select mode is on: the toolbar floats over the
 * bottom of the list, so the list ends the toolbar's height plus its offset
 * higher, and a reader at the bottom sees the last message whole above it.
 * Goes in the timeline footer, like AgentTypingListEnd.
 */
export function SelectModeListEnd() {
  return <div aria-hidden="true" data-testid="select-mode-list-end" className="h-[calc(var(--header-height)+12px+env(safe-area-inset-bottom,0px))]" />;
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

/** A second click on Generate image sooner than this after the first is a double click, not Stop. */
const CAPTURE_STOP_GUARD_MS = 400;
/** How long a copy action says Copied (the same as Copy Markdown's, useSelectionShareHandlers). */
const COPIED_FLASH_MS = 1500;

/**
 * The toolbar for selected messages: raft-ui SelectionToolbar, the one the
 * Tasks page uses (Raft DS › Components › Toolbar for selected items; stdrc,
 * 2026-11-14, #proj-raft-ui:#256). It floats, centred, over the bottom of the
 * conversation where the composer was (SelectionToolbarDock), one row at any
 * width: what doesn't fit gives way into More, measured by the toolbar.
 *
 * Order: (in a thread, the select-all checkbox) · "N selected" · (while an
 * image renders, its progress as the hint) · Forward · Generate image ·
 * Copy link · Copy Markdown · More · ×. The last three are secondary: the
 * first into More. Esc cancels the selection (ChatPanel and ThreadPanel own
 * that key).
 *
 * The thread's checkbox: [✓] when the selection is exactly the selectable
 * messages (the count then reads "All N selected", once the whole thread is
 * loaded; before that, the plain "N selected"), [-] when anything else is
 * selected (some of them, or messages outside them), [ ] when none are.
 * Clicking [-] or [✓] clears the selection; clicking [ ] selects them all.
 * With 0 selected the toolbar stays, every action is disabled, and only ×
 * ends the selection.
 *
 * While an image renders, Generate image shows a spinner and "Stop rendering",
 * and a click on it stops the rendering, the selection kept (a click within
 * CAPTURE_STOP_GUARD_MS of starting is a double click and is ignored); the
 * progress is the hint after the count (the first thing to give way). Ending
 * the selection any way (×, Esc) stops a rendering (useSelectionShareHandlers). Copy link and Copy
 * Markdown each show a check and "Copied" on their own action for a moment
 * after their copy succeeded (Raft DS › Toolbar for selected items).
 *
 * Render it in the conversation's footer in place of the composer. It takes
 * no height there: it floats up over the list, which reserves its room with
 * SelectModeListEnd and SELECT_MODE_LIST_RESERVE_CLASS. When × or Esc ends
 * the selection, focus returns into the conversation
 * (useExitSelectionReturningFocus).
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
  const shown = isActive && selectionChannelId === channelId;
  const selectedIdsKey = useSelectionStore((s) => [...s.selectedIds].sort().join(","));
  const selectionKey = shown ? `${channelId}|${selectedIdsKey}` : null;
  // Copy link says Copied on itself for COPIED_FLASH_MS after its copy succeeded, as Copy Markdown does.
  // The selection the last successful copy was of; Copied shows only while it is still that selection.
  const [linksCopiedFor, setLinksCopiedFor] = useState<string | null>(null);
  useEffect(() => {
    if (linksCopiedFor === null) return undefined;
    const timer = setTimeout(() => setLinksCopiedFor(null), COPIED_FLASH_MS);
    return () => clearTimeout(timer);
  }, [linksCopiedFor]);
  const onCopyLinksClick = useCallback(() => {
    const copiedFor = selectionKey;
    void onCopyLinks?.().then((ok) => { if (ok) setLinksCopiedFor(copiedFor); });
  }, [onCopyLinks, selectionKey]);
  const linksCopied = linksCopiedFor !== null && linksCopiedFor === selectionKey;

  // When Generate image last started an image: a second click within
  // CAPTURE_STOP_GUARD_MS of it is a double click, not a request to stop.
  const startedAt = useRef<number | null>(null);

  const canAct = count > 0 && !capturing;
  const canForward = canAct && !!onForward && !forwardPending;
  // [-] and [✓] clear; [ ] selects every selectable message. Select mode stays on.
  const onSelectAllCheckbox = useCallback(() => {
    const { selectAll } = useSelectionStore.getState();
    selectAll(count > 0 ? [] : selectableIds ?? []);
  }, [count, selectableIds]);
  const onGenerateImage = useCallback(() => {
    if (!capturing) {
      startedAt.current = Date.now();
      onSavePic();
      return;
    }
    if (startedAt.current !== null && Date.now() - startedAt.current < CAPTURE_STOP_GUARD_MS) return;
    onCancelCapture?.();
  }, [capturing, onCancelCapture, onSavePic]);

  const toolbarLabel = formatMessage({ id: "message.selectModeToolbar.label" });
  const selectAllInThreadLabel = formatMessage({ id: "message.selectModeToolbar.selectAllInThread" });
  const cancelLabel = formatMessage({ id: "message.selectModeToolbar.cancel" });
  const forwardLabel = formatMessage({ id: "message.selectModeToolbar.forward" });
  const copyLinkLabel = formatMessage({ id: "message.selectModeToolbar.copyLink" });
  const copiedLabel = formatMessage({ id: "message.selectModeToolbar.copied" });
  const moreActionsLabel = formatMessage({ id: "message.selectModeToolbar.moreActions" });
  const stopRenderingLabel = formatMessage({ id: "message.selectModeToolbar.stopRendering" });
  const generateImageLabel = formatMessage({ id: "message.selectModeToolbar.generateImage" });
  const copyMdLabel = formatMessage({ id: "message.selectModeToolbar.copyMd" });
  const copiedMdLabel = formatMessage({ id: "message.selectModeToolbar.copiedMd" });
  const number = <SelectionToolbarCountValue key="n">{count}</SelectionToolbarCountValue>;

  if (!shown) return null;

  return (
    // A zero-height slot: the toolbar floats up from it, over the list's
    // bottom edge. Clicks beside the toolbar reach the messages under it.
    <div className="relative h-0 w-full" data-testid="select-mode-toolbar-slot">
      <SelectionToolbarDock ref={toastFloorRef} data-testid="select-mode-toolbar-area">
        <SelectionToolbar aria-label={toolbarLabel} data-testid="select-mode-toolbar">
          {selectableIds && (
            <SelectionToolbarItem>
              <Checkbox
                checked={allSelected}
                indeterminate={count > 0 && !allSelected}
                disabled={capturing || (count === 0 && selectableIds.length === 0)}
                onCheckedChange={onSelectAllCheckbox}
                aria-label={selectAllInThreadLabel}
                data-testid="select-mode-select-all"
              />
            </SelectionToolbarItem>
          )}
          <SelectionToolbarCount data-testid="select-mode-count">
            {saysAll
              ? formatMessage({ id: "message.selectModeToolbar.allSelectedCount" }, { count, number })
              : formatMessage({ id: "message.selectModeToolbar.selectedCount" }, { count, number })}
          </SelectionToolbarCount>
          {captureProgressLabel ? (
            <SelectionToolbarHint data-testid="select-mode-capture-progress">{captureProgressLabel}</SelectionToolbarHint>
          ) : null}
          <SelectionToolbarActions>
            {onForward && (
              <SelectionToolbarAction
                icon={<ForwardIcon />}
                onClick={onForward}
                disabled={!canForward}
                data-testid="select-mode-forward"
              >
                {forwardLabel}
              </SelectionToolbarAction>
            )}
            <SelectionToolbarAction
              secondary
              icon={capturing ? <Spinner size="sm" aria-hidden /> : <Image aria-hidden />}
              onClick={onGenerateImage}
              disabled={capturing ? !onCancelCapture : !canAct}
              data-testid="select-mode-share-open"
              data-capturing={capturing ? "" : undefined}
            >
              {capturing ? stopRenderingLabel : generateImageLabel}
            </SelectionToolbarAction>
            {onCopyLinks && (
              <SelectionToolbarAction
                secondary
                icon={linksCopied ? <Check aria-hidden /> : <Link aria-hidden />}
                onClick={onCopyLinksClick}
                disabled={count === 0}
                data-testid="select-mode-copy-link"
              >
                {linksCopied ? copiedLabel : copyLinkLabel}
              </SelectionToolbarAction>
            )}
            <SelectionToolbarAction
              secondary
              icon={copied ? <Check aria-hidden /> : <Copy aria-hidden />}
              onClick={onCopyMd}
              disabled={count === 0}
              data-testid="select-mode-copy-md"
            >
              {copied ? copiedMdLabel : copyMdLabel}
            </SelectionToolbarAction>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<SelectionToolbarMore aria-label={moreActionsLabel} title={moreActionsLabel} data-testid="select-mode-more" />}
              />
              <DropdownMenuContent
                side="top"
                align="end"
                sideOffset={8}
                aria-label={moreActionsLabel}
                data-testid="select-mode-more-menu"
              >
                <SelectionToolbarMoreItems />
              </DropdownMenuContent>
            </DropdownMenu>
          </SelectionToolbarActions>
          <SelectionToolbarClose aria-label={cancelLabel} title={cancelLabel} onClick={exitReturningFocus} data-testid="select-mode-cancel" />
        </SelectionToolbar>
      </SelectionToolbarDock>
    </div>
  );
}
