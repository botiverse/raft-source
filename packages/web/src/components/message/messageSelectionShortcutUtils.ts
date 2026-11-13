import { getTextSelectionWithinElement } from "./messageScopedSelection";

export const MESSAGE_SELECTION_SHORTCUT_ATTR = "data-message-selectable";
export const MESSAGE_SELECTION_SHORTCUT_SELECTOR = `[${MESSAGE_SELECTION_SHORTCUT_ATTR}="true"][data-quote-channel-id]`;
export const MESSAGE_SELECTION_SHORTCUT_GAP = 8;
export const MESSAGE_SELECTION_SHORTCUT_PADDING = 8;

export interface RectLike {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface MessageSelectionShortcutTarget {
  messageId: string | null;
  quoteChannelId: string;
  text: string;
  anchorRect: RectLike;
}

export interface MessageSelectionShortcutPosition {
  x: number;
  y: number;
}

function nodeElement(node: Node | null): Element | null {
  if (!node) return null;
  return node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement;
}

function rangeIntersectsNode(range: Range, node: Node): boolean {
  try {
    return range.intersectsNode(node);
  } catch {
    return false;
  }
}

function resolveSingleMessageBody(range: Range): HTMLElement | null {
  // Chromium's paragraph/line selection may place one endpoint on the row
  // boundary just outside the selectable message body. Resolve that boundary
  // shape from the Range instead of treating it as a cross-message selection.
  const commonElement = nodeElement(range.commonAncestorContainer);
  if (!commonElement) return null;
  const containingBody = commonElement.closest<HTMLElement>(MESSAGE_SELECTION_SHORTCUT_SELECTOR);
  if (containingBody) return containingBody;

  const intersectedBodies = [...commonElement.querySelectorAll<HTMLElement>(MESSAGE_SELECTION_SHORTCUT_SELECTOR)]
    .filter((body) => rangeIntersectsNode(range, body));
  return intersectedBodies.length === 1 ? intersectedBodies[0]! : null;
}

function isEditableSelectionEndpoint(node: Node | null): boolean {
  const element = nodeElement(node);
  if (!element) return false;
  return Boolean(element.closest("input, textarea, select, [contenteditable='true'], [contenteditable='']"));
}

function rectHasArea(rect: DOMRect): boolean {
  return rect.width > 0 && rect.height > 0;
}

function toRectLike(rect: DOMRect): RectLike {
  return {
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height,
  };
}

function containsRect(outer: RectLike, inner: RectLike): boolean {
  return outer !== inner
    && outer.left <= inner.left
    && outer.top <= inner.top
    && outer.right >= inner.right
    && outer.bottom >= inner.bottom
    && (outer.width > inner.width || outer.height > inner.height);
}

function isBackwardSelection(selection: Selection): boolean {
  const direction = (selection as Selection & { direction?: string }).direction;
  if (direction) return direction === "backward";
  const { anchorNode, anchorOffset, focusNode, focusOffset } = selection;
  if (!anchorNode || !focusNode || anchorOffset === undefined || focusOffset === undefined) return false;
  if (anchorNode === focusNode) return focusOffset < anchorOffset;
  try {
    return Boolean(anchorNode.compareDocumentPosition(focusNode) & Node.DOCUMENT_POSITION_PRECEDING);
  } catch {
    return false;
  }
}

/**
 * The rect of the line the selection's focus end is on: the last client rect
 * for a forward selection, the first for a backward one. A whole-line
 * selection also returns the box of the block holding those lines, which
 * spans the row; a rect that contains another one is such a box, not a line.
 */
export function getRangeFocusLineRect(range: Range, backward = false): RectLike | null {
  const rects = Array.from(range.getClientRects()).filter(rectHasArea);
  const lines = rects.filter((rect) => !rects.some((other) => containsRect(rect, other)));
  const focusRect = (backward ? lines[0] : lines.at(-1)) ?? range.getBoundingClientRect();
  if (!focusRect || !rectHasArea(focusRect)) return null;
  return toRectLike(focusRect);
}

export function getMessageSelectionShortcutTarget(selection: Selection | null): MessageSelectionShortcutTarget | null {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  if (isEditableSelectionEndpoint(selection.anchorNode) || isEditableSelectionEndpoint(selection.focusNode)) return null;

  const range = selection.getRangeAt(selection.rangeCount - 1);
  const messageBody = resolveSingleMessageBody(range);
  if (!messageBody) return null;

  const quoteChannelId = messageBody.dataset.quoteChannelId;
  if (!quoteChannelId) return null;

  const text = getTextSelectionWithinElement(selection, messageBody);
  if (!text) return null;

  const anchorRect = getRangeFocusLineRect(range, isBackwardSelection(selection));
  if (!anchorRect) return null;

  return {
    messageId: messageBody.dataset.messageId ?? null,
    quoteChannelId,
    text,
    anchorRect,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/**
 * Centers the toolbar over the focus line, above it when there is room and
 * below it otherwise, then clamps it inside the viewport.
 */
export function placeMessageSelectionShortcut({
  anchorRect,
  floatingSize,
  viewport,
  gap = MESSAGE_SELECTION_SHORTCUT_GAP,
  padding = MESSAGE_SELECTION_SHORTCUT_PADDING,
}: {
  anchorRect: RectLike;
  floatingSize: { width: number; height: number };
  viewport: { width: number; height: number; offsetLeft?: number; offsetTop?: number };
  gap?: number;
  padding?: number;
}): MessageSelectionShortcutPosition {
  const offsetLeft = viewport.offsetLeft ?? 0;
  const offsetTop = viewport.offsetTop ?? 0;
  const minX = offsetLeft + padding;
  const maxX = offsetLeft + viewport.width - floatingSize.width - padding;
  const minY = offsetTop + padding;
  const maxY = offsetTop + viewport.height - floatingSize.height - padding;
  const desiredX = anchorRect.left + anchorRect.width / 2 - floatingSize.width / 2;
  const aboveY = anchorRect.top - floatingSize.height - gap;
  const belowY = anchorRect.bottom + gap;
  const belowFits = belowY <= maxY;
  const aboveFits = aboveY >= minY;
  const desiredY = aboveFits || !belowFits ? aboveY : belowY;

  return {
    x: clamp(desiredX, minX, maxX),
    y: clamp(desiredY, minY, maxY),
  };
}
