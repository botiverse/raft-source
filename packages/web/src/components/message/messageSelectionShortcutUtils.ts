import { createTextSelectionAnchor } from "@botiverse/raft-ui";
import type { TextSelectionAnchor } from "@botiverse/raft-ui";
import { getTextSelectionWithinElement } from "./messageScopedSelection";

export const MESSAGE_SELECTION_SHORTCUT_ATTR = "data-message-selectable";
export const MESSAGE_SELECTION_SHORTCUT_SELECTOR = `[${MESSAGE_SELECTION_SHORTCUT_ATTR}="true"][data-quote-channel-id]`;

export interface MessageSelectionShortcutTarget {
  messageId: string | null;
  quoteChannelId: string;
  authorName?: string;
  authorType?: "user" | "agent" | "external_projection" | "system";
  createdAt?: string;
  text: string;
  messageBody: HTMLElement;
  anchor: TextSelectionAnchor;
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

function isQuotePreviewSelectionNode(node: Node | null): boolean {
  const element = nodeElement(node);
  if (!element) return false;
  return Boolean(element.closest("[data-quote-reply-preview='true']"));
}

export function selectionRectHasArea(rect: DOMRect): boolean {
  return rect.width > 0 && rect.height > 0;
}

export function getMessageSelectionShortcutTarget(selection: Selection | null): MessageSelectionShortcutTarget | null {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  if (isEditableSelectionEndpoint(selection.anchorNode) || isEditableSelectionEndpoint(selection.focusNode)) return null;

  const range = selection.getRangeAt(0);
  if (
    isQuotePreviewSelectionNode(selection.anchorNode)
    || isQuotePreviewSelectionNode(selection.focusNode)
    || isQuotePreviewSelectionNode(range.commonAncestorContainer)
  ) {
    return null;
  }
  const messageBody = resolveSingleMessageBody(range);
  if (!messageBody) return null;

  const quoteChannelId = messageBody.dataset.quoteChannelId;
  if (!quoteChannelId) return null;

  const text = getTextSelectionWithinElement(selection, messageBody);
  if (!text) return null;

  const anchor = createTextSelectionAnchor(selection, messageBody);
  if (!anchor) return null;
  if (!selectionRectHasArea(anchor.getBoundingClientRect())) return null;

  const rawAuthorType = messageBody.dataset.quoteAuthorType;
  const authorType =
    rawAuthorType === "user" || rawAuthorType === "agent" || rawAuthorType === "external_projection" || rawAuthorType === "system"
      ? rawAuthorType
      : undefined;

  return {
    messageId: messageBody.dataset.messageId ?? null,
    quoteChannelId,
    authorName: messageBody.dataset.quoteAuthorName || undefined,
    authorType,
    createdAt: messageBody.dataset.quoteCreatedAt || undefined,
    text,
    messageBody,
    anchor,
  };
}
