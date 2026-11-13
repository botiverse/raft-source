import type { MessageTimelineHandle } from "../../components/message/MessageTimeline";
import { normalizeThreadSearchSelectionText } from "../../components/message/threadSearch";

export function getThreadPanelSelectedSearchText(root: HTMLElement | null): string {
  if (!root) return "";
  const selection = window.getSelection?.();
  if (!selection) return "";

  const selectedText = normalizeThreadSearchSelectionText(selection.toString());

  for (let index = 0; index < selection.rangeCount; index += 1) {
    const range = selection.getRangeAt(index);
    if (root.contains(range.commonAncestorContainer)) return selectedText;
  }
  return "";
}

export function scrollThreadTimelineToTop(
  timeline: Pick<MessageTimelineHandle, "scrollToTop"> | null,
): void {
  timeline?.scrollToTop();
}
