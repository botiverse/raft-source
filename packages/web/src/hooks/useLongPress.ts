import { useRef, useCallback } from "react";

interface LongPressHandlers {
  onTouchStart: (e: React.TouchEvent) => void;
  onTouchEnd: (e: React.TouchEvent) => void;
  onTouchMove: (e: React.TouchEvent) => void;
  onTouchCancel: () => void;
  /** True after a long-press fires, until the next touchStart. Check in onClick to suppress navigation. */
  suppressClickRef: React.MutableRefObject<boolean>;
}

/**
 * Long-press hook for touch devices. Fires callback after holding for `delay` ms.
 * Cancels if finger moves more than `moveThreshold` px.
 * Suppresses the subsequent click event after a successful long-press.
 */
export function useLongPress(
  callback: (coords: { x: number; y: number }) => void,
  delay = 500,
  moveThreshold = 10
): LongPressHandlers {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startPos = useRef({ x: 0, y: 0 });
  const firedRef = useRef(false);
  const suppressClickRef = useRef(false);

  const clear = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const onTouchStart = useCallback(
    (e: React.TouchEvent) => {
      firedRef.current = false;
      suppressClickRef.current = false;
      const touch = e.touches[0];
      startPos.current = { x: touch.clientX, y: touch.clientY };

      timerRef.current = setTimeout(() => {
        firedRef.current = true;
        suppressClickRef.current = true;
        callback({ x: touch.clientX, y: touch.clientY });
      }, delay);
    },
    [callback, delay]
  );

  const onTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (!timerRef.current) return;
      const touch = e.touches[0];
      const dx = touch.clientX - startPos.current.x;
      const dy = touch.clientY - startPos.current.y;
      if (Math.abs(dx) > moveThreshold || Math.abs(dy) > moveThreshold) {
        clear();
      }
    },
    [clear, moveThreshold]
  );

  const onTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      clear();
      if (firedRef.current) {
        // Prevent the subsequent click from firing after a long-press
        e.preventDefault();
        firedRef.current = false;
      }
    },
    [clear]
  );

  const onTouchCancel = useCallback(() => {
    clear();
    firedRef.current = false;
  }, [clear]);

  return { onTouchStart, onTouchEnd, onTouchMove, onTouchCancel, suppressClickRef };
}
