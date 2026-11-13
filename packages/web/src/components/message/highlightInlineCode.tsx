import { Children } from "react";
import type { ReactNode } from "react";
import type { SearchHighlightPart } from "../../features/search/searchHighlightParts";
import { MessageTextMark } from "./MessageTextMark";

/** Marks the hits inside inline code (the tree pass skips code). */
export function highlightInlineCode(
  children: ReactNode,
  split: (text: string) => SearchHighlightPart[],
  testId: string,
): ReactNode {
  return Children.map(children, (child) => {
    if (typeof child !== "string") return child;
    const parts = split(child);
    if (!parts.some((part) => part.hit)) return child;
    let offset = 0;
    return parts.map((part) => {
      const key = offset;
      offset += part.text.length;
      return part.hit ? <MessageTextMark key={key} testId={testId}>{part.text}</MessageTextMark> : part.text;
    });
  });
}
