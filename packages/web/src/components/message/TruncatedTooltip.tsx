import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import AttachmentTooltip from "./attachmentTooltip";

/**
 * A one-line text that shows its full text in a tooltip only when it is cut
 * off (its scroll width is past its box): an attachment chip's filename, a
 * forward destination's long thread or task title. Measured on mount, on
 * resize and on hover, so a row that gets wider loses the tooltip again.
 * The tooltip is the attachment preset (white surface, 600ms delay).
 */
export function TruncatedTooltip({
  content,
  className,
  affordance,
  testId,
  children,
}: {
  content: ReactNode;
  className: string;
  /** The span's `data-message-affordance`, where the host names one. */
  affordance?: string;
  testId?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [isTruncated, setIsTruncated] = useState(false);

  const measure = useCallback(() => {
    const node = ref.current;
    setIsTruncated(Boolean(node && node.scrollWidth > node.clientWidth + 1));
  }, []);

  useEffect(() => {
    measure();
    const node = ref.current;
    if (!node || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [measure]);

  const text = (
    <span
      ref={ref}
      data-message-affordance={affordance}
      data-testid={testId}
      data-truncated={isTruncated ? "true" : undefined}
      className={className}
      onMouseEnter={measure}
    >
      {children}
    </span>
  );

  if (!isTruncated) return text;
  return <AttachmentTooltip content={content}>{text}</AttachmentTooltip>;
}
