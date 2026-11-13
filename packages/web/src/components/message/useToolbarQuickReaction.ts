import { useCallback, useMemo, useRef, useState } from "react";
import type { FocusEvent } from "react";
import { currentFavoriteReaction } from "./reactionFavorite";

/**
 * The emoji on a message's toolbar reaction button: the person's most-used
 * reaction, read as the toolbar shows (the pointer or focus comes into the row
 * while none of its popups is open) and kept while it shows, so it never
 * changes under the pointer; the next toolbar shown has the new favorite
 * (cindyz). Only the row being entered reads it, so a count changing
 * re-renders no row. Spread `rowHandlers` on the message row.
 */
export function useToolbarQuickReaction(viewerUserId: string | null, rowPopupOpen: boolean) {
  const [quickReaction, setQuickReaction] = useState(() => currentFavoriteReaction(viewerUserId));
  const shownByRef = useRef({ pointer: false, focus: false });
  const refreshIfHidden = useCallback(() => {
    const shownBy = shownByRef.current;
    if (shownBy.pointer || shownBy.focus || rowPopupOpen) return;
    setQuickReaction(currentFavoriteReaction(viewerUserId));
  }, [rowPopupOpen, viewerUserId]);
  const rowHandlers = useMemo(() => {
    const fromOutside = (event: FocusEvent<HTMLElement>) => !(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget));
    return {
      onPointerEnter: () => {
        refreshIfHidden();
        shownByRef.current.pointer = true;
      },
      onPointerLeave: () => {
        shownByRef.current.pointer = false;
      },
      onFocus: (event: FocusEvent<HTMLElement>) => {
        if (!fromOutside(event)) return;
        refreshIfHidden();
        shownByRef.current.focus = true;
      },
      onBlur: (event: FocusEvent<HTMLElement>) => {
        if (fromOutside(event)) shownByRef.current.focus = false;
      },
    };
  }, [refreshIfHidden]);
  return { quickReaction, rowHandlers };
}
