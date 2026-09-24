import type { ComponentProps, ReactElement, ReactNode } from "react";
import { TooltipProvider } from "raft-ui";
import Tooltip from "../ui/Tooltip";
import { useLightboxPortalContainer } from "../ui/Lightbox";

/**
 * Tooltip preset for attachment surfaces: white surface, 600ms hover delay.
 *
 * The delay lives on TooltipProvider (same as the mermaid toolbar), so wrapping
 * it here keeps every attachment tooltip on one feel instead of each call site
 * re-deciding. Chat body and forward preview share this by construction.
 *
 * When rendered inside a Lightbox (the preview modal, z-70), the tooltip
 * portal moves into the Lightbox stacking context — a body-level portal (z-50)
 * would sit behind the overlay (same pattern as MermaidToolbar).
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
  const container = useLightboxPortalContainer();
  return (
    <TooltipProvider delay={ATTACHMENT_TOOLTIP_DELAY_MS}>
      <Tooltip
        content={content}
        contentProps={{ className: "bg-white", container: container ?? undefined, ...contentProps }}
      >
        {children}
      </Tooltip>
    </TooltipProvider>
  );
}
