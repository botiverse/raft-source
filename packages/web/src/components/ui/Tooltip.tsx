import type { ComponentProps, ReactElement, ReactNode } from "react";
import {
  Tooltip as RaftTooltip,
  TooltipContent,
  TooltipTrigger,
} from "raft-ui";

type RaftTooltipProps = ComponentProps<typeof RaftTooltip>;
type TooltipContentProps = ComponentProps<typeof TooltipContent>;
type TooltipTriggerProps = Omit<ComponentProps<typeof TooltipTrigger>, "children" | "render">;

export interface TooltipProps extends Omit<RaftTooltipProps, "children"> {
  children: ReactElement;
  content: ReactNode;
  contentProps?: Omit<TooltipContentProps, "children">;
  triggerProps?: TooltipTriggerProps;
}

export default function Tooltip({
  children,
  content,
  contentProps,
  triggerProps,
  ...tooltipProps
}: TooltipProps) {
  return (
    <RaftTooltip {...tooltipProps}>
      <TooltipTrigger {...triggerProps} render={children} />
      <TooltipContent {...contentProps}>{content}</TooltipContent>
    </RaftTooltip>
  );
}
