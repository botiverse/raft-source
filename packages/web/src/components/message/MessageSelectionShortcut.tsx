import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Copy, TextQuote } from "lucide-react";
import { useIntl } from "react-intl";
import { useSelectionStore } from "../../store/selectionStore";
import { emitSelectedTextQuote } from "./selectedTextQuote";
import {
  getMessageSelectionShortcutTarget,
  placeMessageSelectionShortcut,
} from "./messageSelectionShortcutUtils";
import type {
  MessageSelectionShortcutTarget,
} from "./messageSelectionShortcutUtils";

const SHORTCUT_ESTIMATED_SIZE = { width: 124, height: 32 };
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

function viewport() {
  const visualViewport = window.visualViewport;
  if (visualViewport && visualViewport.width > 0 && visualViewport.height > 0) {
    return {
      width: visualViewport.width,
      height: visualViewport.height,
      offsetLeft: visualViewport.offsetLeft,
      offsetTop: visualViewport.offsetTop,
    };
  }
  return { width: window.innerWidth, height: window.innerHeight };
}

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
  const shortcutRef = useRef<HTMLDivElement | null>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dismissedSelectionRef = useRef<SelectionSnapshot | null>(null);
  const [target, setTarget] = useState<MessageSelectionShortcutTarget | null>(null);
  const [position, setPosition] = useState(() => ({ x: -9999, y: -9999 }));

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
    setPosition(placeMessageSelectionShortcut({
      anchorRect: nextTarget.anchorRect,
      avoidRect: nextTarget.selectionRect,
      floatingSize: SHORTCUT_ESTIMATED_SIZE,
      viewport: viewport(),
    }));
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

  useEffect(() => {
    if (!target) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (event.button === 2) return;
      if (isShortcutTarget(event.target)) return;
      close();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    const handleViewportChange = () => close();

    document.addEventListener("pointerdown", handlePointerDown, true);
    // keydown-global-exempt: Escape closes the non-modal selection shortcut.
    document.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("scroll", handleViewportChange, { capture: true, passive: true });
    window.addEventListener("resize", handleViewportChange);
    window.visualViewport?.addEventListener("resize", handleViewportChange);
    window.visualViewport?.addEventListener("scroll", handleViewportChange, { passive: true });
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("scroll", handleViewportChange, true);
      window.removeEventListener("resize", handleViewportChange);
      window.visualViewport?.removeEventListener("resize", handleViewportChange);
      window.visualViewport?.removeEventListener("scroll", handleViewportChange);
    };
  }, [close, target]);

  useLayoutEffect(() => {
    if (!target) return;
    const floating = shortcutRef.current;
    if (!floating) return;
    const rect = floating.getBoundingClientRect();
    setPosition(placeMessageSelectionShortcut({
      anchorRect: target.anchorRect,
      avoidRect: target.selectionRect,
      floatingSize: { width: rect.width, height: rect.height },
      viewport: viewport(),
    }));
  }, [target]);

  const handleQuote = useCallback(() => {
    if (!target) return;
    emitSelectedTextQuote(target.quoteChannelId, target.text);
    dismissCurrentSelection();
  }, [dismissCurrentSelection, target]);

  const handleCopy = useCallback(() => {
    if (!target) return;
    void navigator.clipboard.writeText(target.text);
    dismissCurrentSelection();
    window.getSelection()?.removeAllRanges();
  }, [dismissCurrentSelection, target]);

  if (!target) return null;

  return createPortal(
    <div
      ref={shortcutRef}
      role="menu"
      aria-label={formatMessage({ id: "message.selectionShortcut.actionsAria" })}
      data-message-selection-shortcut="true"
      className="fixed z-[70] flex overflow-hidden border-2 border-black bg-white text-xs font-semibold shadow-brutal-sm select-none"
      style={{ left: position.x, top: position.y }}
    >
      <button
        type="button"
        role="menuitem"
        onClick={handleQuote}
        className="flex h-7 items-center gap-1.5 px-2 text-black transition-colors hover:bg-soft-signal/30"
      >
        <TextQuote size={13} />
        {formatMessage({ id: "message.selectionShortcut.quote" })}
      </button>
      <div className="w-px bg-black/20" aria-hidden="true" />
      <button
        type="button"
        role="menuitem"
        onClick={handleCopy}
        className="flex h-7 items-center gap-1.5 px-2 text-black transition-colors hover:bg-soft-signal/30"
      >
        <Copy size={13} />
        {formatMessage({ id: "message.selectionShortcut.copy" })}
      </button>
    </div>,
    document.body,
  );
}
