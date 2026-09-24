import { useState, useEffect, useCallback, useRef } from "react";

/**
 * Generic autocomplete state manager for trigger-based completions (e.g. @mention, #channel).
 * Handles: show/hide, query extraction, index cycling, keyboard nav, text insertion.
 * Filtering is done externally using the returned `query`.
 */
export function useAutocomplete(trigger: RegExp, prefix: string) {
  const [show, setShow] = useState(false);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [startPos, setStartPos] = useState(-1);
  const popupRef = useRef<HTMLDivElement>(null);

  const detect = useCallback((textBeforeCursor: string, cursorPos: number) => {
    const match = textBeforeCursor.match(trigger);
    if (match) {
      setShow(true);
      setQuery(match[1]);
      setStartPos(cursorPos - match[0].length);
      setIndex(0);
      return true;
    }
    setShow(false);
    setQuery("");
    setStartPos(-1);
    return false;
  }, [trigger]);

  const dismiss = useCallback(() => {
    setShow(false);
    setQuery("");
    setStartPos(-1);
  }, []);

  /** Clamp index when item count changes. Call with current filtered count. */
  const clampIndex = useCallback((count: number) => {
    setIndex((i) => (i >= count ? Math.max(0, count - 1) : i));
  }, []);

  /** Build inserted text and return { newContent, cursorPos }. */
  const buildInsert = useCallback(
    (name: string, content: string, cursorPos: number) => {
      const before = content.slice(0, startPos);
      const after = content.slice(cursorPos);
      const newContent = `${before}${prefix}${name} ${after}`;
      const newCursor = before.length + prefix.length + name.length + 1;
      return { newContent, newCursor };
    },
    [startPos, prefix]
  );

  /**
   * Handle keyboard navigation for this autocomplete.
   * Returns true if the event was consumed.
   */
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent, itemCount: number, onSelect: () => void): boolean => {
      if (!show || itemCount === 0) return false;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        setIndex((i) => (i + 1) % itemCount);
        return true;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setIndex((i) => (i - 1 + itemCount) % itemCount);
        return true;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        onSelect();
        return true;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        dismiss();
        return true;
      }
      return false;
    },
    [show, dismiss]
  );

  // Auto-scroll selected item into view
  useEffect(() => {
    if (!show || !popupRef.current) return;
    // oxlint-disable-next-line react-doctor/no-event-handler -- YMNNE-family: pre-existing non-bug site grandfathered; rule now gates new code (see docs/frontend/render-cost-contract.md)
    const item = popupRef.current.querySelector(`[data-ac-index="${index}"]`);
    if (item) item.scrollIntoView({ block: "nearest" });
  }, [show, index]);

  return { show, query, index, startPos, popupRef, detect, dismiss, clampIndex, buildInsert, handleKeyDown };
}
