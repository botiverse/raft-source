import type { ButtonHTMLAttributes, ReactNode } from "react";
import { TextLink } from "@botiverse/raft-ui";

type ShowMoreToggleProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "type"> & {
  expanded: boolean;
  collapsedLabel: ReactNode;
  expandedLabel?: ReactNode;
};

/** "Show more" / "Collapse" toggle below content: a standalone raft-ui
 *  TextLink (muted variant) at footnote size. */
export default function ShowMoreToggle({
  expanded,
  collapsedLabel,
  expandedLabel = "Collapse",
  className = "",
  ...buttonProps
}: ShowMoreToggleProps) {
  return (
    <TextLink className={`text-footnote${className ? ` ${className}` : ""}`} {...buttonProps}>
      {expanded ? expandedLabel : collapsedLabel}
    </TextLink>
  );
}
