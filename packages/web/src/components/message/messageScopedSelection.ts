export function getTextSelectionWithinElement(
  selection: Selection | null,
  root: HTMLElement | null,
): string {
  if (!selection || selection.isCollapsed || !root) return "";

  const selectedText = selection.toString().trim();
  if (!selectedText) return "";

  const anchorNode = selection.anchorNode;
  const focusNode = selection.focusNode;
  if (anchorNode && focusNode && root.contains(anchorNode) && root.contains(focusNode)) {
    return selectedText;
  }

  for (let index = 0; index < selection.rangeCount; index += 1) {
    const range = selection.getRangeAt(index);
    if (!rangeIntersectsNode(range, root)) continue;

    const scopedRange = range.cloneRange();
    if (!root.contains(scopedRange.startContainer)) {
      scopedRange.setStart(root, 0);
    }
    if (!root.contains(scopedRange.endContainer)) {
      scopedRange.setEnd(root, root.childNodes.length);
    }

    const text = scopedRange.cloneContents().textContent?.trim() ?? "";
    if (text) return text;
  }

  return "";
}

function rangeIntersectsNode(range: Range, node: Node): boolean {
  try {
    return range.intersectsNode(node);
  } catch {
    return false;
  }
}
