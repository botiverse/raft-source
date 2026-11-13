import type { ComponentProps } from "react";

// A whole literal: Tailwind finds classes by scanning source text, and a
// class glued to `${` is not one it can see (tailwindClassScan.test.ts).
const DOT_CLASS = "size-1.5 shrink-0 rounded-[2px] bg-foreground-hint";

/**
 * Unread with no count: the sidebar's quiet square pixel (a non-joined
 * channel with something new, a conversation marked unread), also drawn by
 * an Activity row marked unread. A square pixel, never a round dot. An image
 * to assistive technology, named by the caller's aria-label.
 */
export function QuietUnreadDot({ className, ...props }: ComponentProps<"span">) {
  return <span role="img" {...props} className={className ? `${DOT_CLASS} ${className}` : DOT_CLASS} />;
}
