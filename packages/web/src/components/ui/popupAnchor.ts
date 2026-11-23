export interface VirtualPopupAnchor {
  getBoundingClientRect: () => DOMRect;
  contextElement?: Element;
}

export type PopupAnchorTarget = Element | VirtualPopupAnchor;

function makeRect(x: number, y: number, width: number, height: number): DOMRect {
  if (typeof DOMRect === "function") return new DOMRect(x, y, width, height);
  return {
    x,
    y,
    width,
    height,
    top: y,
    left: x,
    right: x + width,
    bottom: y + height,
    toJSON: () => ({ x, y, width, height, top: y, left: x, right: x + width, bottom: y + height }),
  } as DOMRect;
}

/**
 * 1×1 point rect so a valid click at `(0, 0)` or on the exact top/left pixel of
 * a clipping container does not trip Base UI's `0×0` at `(0, 0)` `anchorHidden`
 * check or Floating UI's `overflow[side] - 0 >= 0` boundary condition.
 */
function makePointRect(x: number, y: number): DOMRect {
  return makeRect(x, y, 1, 1);
}

/**
 * Zero-area origin rect emitted when a previously visible element collapses via
 * `display: none`, signalling Base UI's `hideMiddleware` to mark the anchor hidden.
 */
function makeCollapsedRect(): DOMRect {
  return makeRect(0, 0, 0, 0);
}

/**
 * Captures a viewport point `(x, y)` relative to `element` atomically at event
 * time so a floating menu tracks `element` across scroll and resize instead of
 * freezing at stale screen coordinates.
 *
 * - Keyboard-triggered context menus (`x === 0 && y === 0`) on a laid-out
 *   element anchor near the element's leading edge rather than at `(0, 0)`.
 * - If a previously laid-out connected element collapses via `display: none`
 *   (`0×0` at `(0, 0)`), returns a `0×0` collapsed rect so Base UI hides and
 *   closes the menu instead of teleporting to `(offsetX, offsetY)`.
 * - If `element` detaches from the document, holds its last measured viewport
 *   coordinates until unmount/close rather than jumping back on-screen.
 */
export function capturePointAnchor(
  x: number,
  y: number,
  element?: Element | null,
): VirtualPopupAnchor {
  if (!element || !element.isConnected) {
    return {
      getBoundingClientRect: () => makePointRect(x, y),
    };
  }
  const origin = element.getBoundingClientRect();
  const hadArea = origin.width > 0 || origin.height > 0;
  const startX = hadArea && x === 0 && y === 0
    ? origin.left + Math.min(12, origin.width / 2)
    : x;
  const startY = hadArea && x === 0 && y === 0
    ? origin.top + Math.min(12, origin.height / 2)
    : y;
  const offsetX = startX - origin.left;
  const offsetY = startY - origin.top;
  let lastX = startX;
  let lastY = startY;
  return {
    contextElement: element,
    getBoundingClientRect() {
      if (element.isConnected) {
        const rect = element.getBoundingClientRect();
        if (hadArea && rect.width === 0 && rect.height === 0 && rect.left === 0 && rect.top === 0) {
          return makeCollapsedRect();
        }
        lastX = rect.left + offsetX;
        lastY = rect.top + offsetY;
      }
      return makePointRect(lastX, lastY);
    },
  };
}
