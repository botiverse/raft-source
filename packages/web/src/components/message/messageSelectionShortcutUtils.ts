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
  selectionRect: RectLike;
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

export function getRangeShortcutRects(range: Range): { anchorRect: RectLike; selectionRect: RectLike } | null {
  const rects = Array.from(range.getClientRects()).filter(rectHasArea);
  const anchorRect = rects.at(-1) ?? range.getBoundingClientRect();
  if (!anchorRect || !rectHasArea(anchorRect)) return null;
  let selectionRect = toRectLike(rects[0] ?? anchorRect);
  for (const rect of rects.slice(1)) {
    const left = Math.min(selectionRect.left, rect.left);
    const top = Math.min(selectionRect.top, rect.top);
    const right = Math.max(selectionRect.right, rect.right);
    const bottom = Math.max(selectionRect.bottom, rect.bottom);
    selectionRect = { left, top, right, bottom, width: right - left, height: bottom - top };
  }
  return {
    anchorRect: toRectLike(anchorRect),
    selectionRect,
  };
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

  const shortcutRects = getRangeShortcutRects(range);
  if (!shortcutRects) return null;

  return {
    messageId: messageBody.dataset.messageId ?? null,
    quoteChannelId,
    text,
    anchorRect: shortcutRects.anchorRect,
    selectionRect: shortcutRects.selectionRect,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

export function placeMessageSelectionShortcut({
  anchorRect,
  avoidRect = anchorRect,
  floatingSize,
  viewport,
  gap = MESSAGE_SELECTION_SHORTCUT_GAP,
  padding = MESSAGE_SELECTION_SHORTCUT_PADDING,
}: {
  anchorRect: RectLike;
  avoidRect?: RectLike;
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
  const desiredX = avoidRect.left + avoidRect.width / 2 - floatingSize.width / 2;
  const aboveY = avoidRect.top - floatingSize.height - gap;
  const belowY = avoidRect.bottom + gap;
  const belowFits = belowY <= maxY;
  const aboveFits = aboveY >= minY;
  const desiredY = aboveFits || !belowFits ? aboveY : belowY;

  return {
    x: clamp(desiredX, minX, maxX),
    y: clamp(desiredY, minY, maxY),
  };
}
