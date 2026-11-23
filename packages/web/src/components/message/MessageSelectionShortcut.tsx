import { useCallback, useEffect, useRef, useState } from "react";
import { Copy, TextQuote } from "lucide-react";
import {
  Popover,
  PopoverContent,
  TextSelectionToolbar,
  TextSelectionToolbarButton,
  TextSelectionToolbarSeparator,
} from "@botiverse/raft-ui";
import { useIntl } from "react-intl";
import { useSelectionStore } from "../../store/selectionStore";
import { dismissLayerProps } from "../ui/dismissLayer";
import { emitSelectedTextQuote } from "./selectedTextQuote";
import type { SelectedTextQuoteSource } from "./selectedTextQuote";
import { getMessageSelectionShortcutTarget, selectionRectHasArea } from "./messageSelectionShortcutUtils";
import type { MessageSelectionShortcutTarget } from "./messageSelectionShortcutUtils";
import { useShortcutLayer } from "../../features/shortcuts/useShortcutLayer";

const COLLISION_AVOIDANCE = { side: "flip", align: "shift", fallbackAxisSide: "none" } as const;

const MESSAGE_ACTION_SELECTOR = [
  "button",
  "a",
  "input",
  "select",
  "textarea",
  "[role='button']",
  "[role='link']",
  "[role='menuitem']",
  "[role='toolbar']",
].join(",");

function isShortcutTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest("[data-message-selection-shortcut='true']"));
}

function isMessageActionTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest(MESSAGE_ACTION_SELECTOR));
}

function skipsSelectionRefresh(target: EventTarget | null): boolean {
  return isShortcutTarget(target) || isMessageActionTarget(target);
}

function isMobileSelectionViewport(): boolean {
  return window.innerWidth < 768 || Boolean(window.matchMedia?.("(hover: none) and (pointer: coarse)").matches);
}

type SelectionSnapshot = {
  startContainer: Node;
  startOffset: number;
  endContainer: Node;
  endOffset: number;
  text: string;
};

function snapshotSelection(selection: Selection | null): SelectionSnapshot | null {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  try {
    const range = selection.getRangeAt(0);
    return {
      startContainer: range.startContainer,
      startOffset: range.startOffset,
      endContainer: range.endContainer,
      endOffset: range.endOffset,
      text: selection.toString(),
    };
  } catch {
    return null;
  }
}

function matchesSelectionSnapshot(selection: Selection | null, snapshot: SelectionSnapshot | null): boolean {
  if (!selection || !snapshot || selection.isCollapsed || selection.rangeCount === 0) return false;
  try {
    const range = selection.getRangeAt(0);
    return range.startContainer === snapshot.startContainer
      && range.startOffset === snapshot.startOffset
      && range.endContainer === snapshot.endContainer
      && range.endOffset === snapshot.endOffset
      && selection.toString() === snapshot.text;
  } catch {
    return false;
  }
}

export default function MessageSelectionShortcut() {
  const { formatMessage } = useIntl();
  const selectModeActive = useSelectionStore((s) => s.isActive);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dismissedSelectionRef = useRef<SelectionSnapshot | null>(null);
  const [target, setTarget] = useState<MessageSelectionShortcutTarget | null>(null);

  const close = useCallback(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    setTarget(null);
  }, []);

  const updateFromSelection = useCallback(() => {
    if (selectModeActive || isMobileSelectionViewport()) {
      close();
      return;
    }
    const selection = window.getSelection();
    if (matchesSelectionSnapshot(selection, dismissedSelectionRef.current)) {
      close();
      return;
    }
    dismissedSelectionRef.current = null;
    const nextTarget = getMessageSelectionShortcutTarget(selection);
    if (!nextTarget) {
      close();
      return;
    }
    setTarget(nextTarget);
  }, [close, selectModeActive]);

  const dismissCurrentSelection = useCallback(() => {
    dismissedSelectionRef.current = snapshotSelection(window.getSelection());
    close();
  }, [close]);

  const scheduleUpdate = useCallback(() => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(() => {
      debounceTimerRef.current = null;
      updateFromSelection();
    }, 100);
  }, [updateFromSelection]);

  useEffect(() => {
    if (selectModeActive) close();
  }, [close, selectModeActive]);

  useEffect(() => {
    const handleMouseUp = (event: MouseEvent) => {
      // A control activation dispatches mouseup before click. Its pointerdown
      // closes this menu, so scheduling from mouseup would otherwise reopen it
      // whenever the native selection survives the action.
      if (skipsSelectionRefresh(event.target)) return;
      scheduleUpdate();
    };
    const handleFinalTripleClick = (event: MouseEvent) => {
      // Chromium has finalized the paragraph selection by the third click.
      // Snapshot it now: a rich-text row can finish measuring immediately
      // afterward and clear the native Selection before the debounced refresh.
      // Ordinary clicks remain covered by selectionchange / mouseup and must
      // not re-arm the shortcut after an action closes it.
      if (event.detail < 3 || skipsSelectionRefresh(event.target)) return;
      dismissedSelectionRef.current = null;
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      updateFromSelection();
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      // Space activates a focused button as keyup -> click. Scheduling from
      // that keyup would outlive the click's close and reopen the shortcut
      // whenever the browser selection survives an action.
      if (skipsSelectionRefresh(event.target)) return;
      scheduleUpdate();
    };

    document.addEventListener("selectionchange", scheduleUpdate);
    document.addEventListener("mouseup", handleMouseUp, true);
    document.addEventListener("click", handleFinalTripleClick, true);
    document.addEventListener("keyup", handleKeyUp, true);
    document.addEventListener("touchend", scheduleUpdate, true);
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      document.removeEventListener("selectionchange", scheduleUpdate);
      document.removeEventListener("mouseup", handleMouseUp, true);
      document.removeEventListener("click", handleFinalTripleClick, true);
      document.removeEventListener("keyup", handleKeyUp, true);
      document.removeEventListener("touchend", scheduleUpdate, true);
    };
  }, [scheduleUpdate, updateFromSelection]);

  // While the toolbar is open:
  // 1. Hide immediately on outside primary pointerdown so starting a new drag
  //    selection or clicking a control that stops click propagation doesn't
  //    leave the previous toolbar lingering. Preserve right-click so the
  //    browser/message context menu can open over the active selection.
  // 2. Close immediately if the message row unmounts (e.g. virtualizer recycle)
  //    or the live range collapses to zero area so the popup never teleports to (0, 0).
  useEffect(() => {
    if (!target) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (event.button === 2) return;
      if (isShortcutTarget(event.target)) return;
      close();
    };
    const checkAnchorAlive = () => {
      if (!target.messageBody.isConnected || !selectionRectHasArea(target.anchor.getBoundingClientRect())) {
        close();
      }
    };
    const root = target.messageBody.closest(
      '[data-virtual-timeline], [data-testid="message-scroller"], [data-testid="thread-message-scroller"]',
    ) ?? target.messageBody.ownerDocument.body;
    const mutations = typeof MutationObserver === "undefined" || !root
      ? null
      : new MutationObserver(checkAnchorAlive);
    if (root) mutations?.observe(root, { childList: true, subtree: true });
    document.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("scroll", checkAnchorAlive, { capture: true, passive: true });
    window.addEventListener("resize", checkAnchorAlive);
    return () => {
      mutations?.disconnect();
      document.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("scroll", checkAnchorAlive, true);
      window.removeEventListener("resize", checkAnchorAlive);
    };
  }, [close, target]);

  const handleOpenChange = useCallback((next: boolean) => {
    if (!next) close();
  }, [close]);

  // Esc closes the non-modal selection shortcut: a layer heard in the capture phase, before the thread's own Esc.
  useShortcutLayer("selection", !!target, { onEscape: () => { close(); }, phase: "capture", ignoreDefaultPrevented: true });

  const handleQuote = useCallback(() => {
    if (!target) return;
    const source: SelectedTextQuoteSource | undefined = target.messageId
      ? {
          messageId: target.messageId,
          authorName: target.authorName,
          authorType: target.authorType,
          createdAt: target.createdAt,
          isPartial: true,
        }
      : undefined;
    emitSelectedTextQuote(target.quoteChannelId, target.text, source);
    dismissCurrentSelection();
  }, [dismissCurrentSelection, target]);

  const handleCopy = useCallback(() => {
    if (!target) return;
    void navigator.clipboard.writeText(target.text);
    dismissCurrentSelection();
    window.getSelection()?.removeAllRanges();
  }, [dismissCurrentSelection, target]);

  return (
    <Popover open={Boolean(target)} onOpenChange={handleOpenChange}>
      <PopoverContent
        {...dismissLayerProps}
        align="center"
        anchor={target?.anchor}
        collisionAvoidance={COLLISION_AVOIDANCE}
        initialFocus={false}
        finalFocus={false}
        side="top"
        sideOffset={8}
        className="min-w-0 overflow-visible rounded-none bg-transparent p-0 shadow-none ring-0 [[data-anchor-hidden]_&]:invisible [[data-anchor-hidden]_&]:pointer-events-none"
      >
        <TextSelectionToolbar
          aria-label={formatMessage({ id: "message.selectionShortcut.actionsAria" })}
          data-message-selection-shortcut="true"
        >
          <TextSelectionToolbarButton onClick={handleQuote}>
            <TextQuote />
            {formatMessage({ id: "message.selectionShortcut.quote" })}
          </TextSelectionToolbarButton>
          <TextSelectionToolbarSeparator />
          <TextSelectionToolbarButton onClick={handleCopy}>
            <Copy />
            {formatMessage({ id: "message.selectionShortcut.copy" })}
          </TextSelectionToolbarButton>
        </TextSelectionToolbar>
      </PopoverContent>
    </Popover>
  );
}
