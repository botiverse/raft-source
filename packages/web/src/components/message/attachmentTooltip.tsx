import type { ComponentProps, ReactElement, ReactNode } from "react";
import { TooltipProvider } from "@botiverse/raft-ui";
import Tooltip from "../ui/Tooltip";

/**
 * Tooltip preset for attachment surfaces: white surface, 600ms hover delay.
 *
 * The delay lives on TooltipProvider (same as the mermaid toolbar), so wrapping
 * it here keeps every attachment tooltip on one feel instead of each call site
 * re-deciding. Chat body and forward preview share this by construction.
 *
 * Inside a lightbox (the file viewer, raft-ui's Lightbox at z-70), Base UI
 * portals the tooltip into the lightbox's own portal, above its content.
 */
export const ATTACHMENT_TOOLTIP_DELAY_MS = 600;

type AttachmentTooltipContentProps = NonNullable<ComponentProps<typeof Tooltip>["contentProps"]>;

export default function AttachmentTooltip({
  content,
  children,
  contentProps,
}: {
  content: ReactNode;
  children: ReactElement;
  contentProps?: Omit<AttachmentTooltipContentProps, "className">;
}) {
  return (
    <TooltipProvider delay={ATTACHMENT_TOOLTIP_DELAY_MS}>
      <Tooltip
        content={content}
        contentProps={contentProps}
      >
        {children}
      </Tooltip>
    </TooltipProvider>
  );
}
