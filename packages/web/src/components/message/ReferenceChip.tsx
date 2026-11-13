import { MessageReferenceChip } from "@botiverse/raft-ui";
import type { MessageReferenceChipVariant } from "@botiverse/raft-ui";
import type { ComponentType, SVGProps } from "react";
import Tooltip from "../ui/Tooltip";
import { STATIC_REFERENCE_CLASS } from "./clickableAffordance";

/**
 * Shared in-message reference chip. Both the Slock-permalink inline ref and the
 * attachment comment-ref render through this one structure so they are provably
 * consistent (same box/weight/layout, one height via the RUI message-reference
 * recipe, which owns size and baseline since raft-ui 0.5.16), differing only by icon, color, label, and
 * an optional trailing badge (stdrc directive).
 *
 * Cursor and hover follow the clickable-affordance contract
 * (./clickableAffordance): rendered as an `<a>` the chip keeps the recipe's
 * pointer and press wash; rendered as a `<span>` (nothing to open) it takes
 * the arrow cursor and no hover.
 */
export function ReferenceChip({
  icon: Icon,
  variant,
  label,
  trailing,
  as = "span",
  href,
  onClick,
  title,
  "data-message-affordance": dataMessageAffordance,
  "data-select-screenshot-author-link": authorLink,
  "data-select-screenshot-author-text": authorText,
}: {
  /** A lucide or raft-ui icon (raft-ui's take SVG props, so width/height, not size). */
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  variant: MessageReferenceChipVariant;
  label: React.ReactNode;
  trailing?: React.ReactNode;
  as?: "a" | "span";
  href?: string;
  onClick?: (e: React.MouseEvent) => void;
  title?: string;
  "data-message-affordance"?: string;
  /** The link the author wrote, when the label is something resolved for this viewer: share images show it instead (selectScreenshot.ts). */
  "data-select-screenshot-author-link"?: string;
  /** The words the author gave that link, when not its address. */
  "data-select-screenshot-author-text"?: string;
}) {
  const Tag = as;
  const anchorProps = as === "a" ? { href, onClick } : {};

  const chip = (
    <MessageReferenceChip
      variant={variant}
      render={(
        <Tag
          {...anchorProps}
          data-message-affordance={dataMessageAffordance}
          data-select-screenshot-author-link={authorLink}
          data-select-screenshot-author-text={authorText}
        />
      )}
      className={as === "span" ? STATIC_REFERENCE_CLASS : undefined}
    >
      <Icon width={12} height={12} className="shrink-0" />
      <span className="min-w-0 truncate">{label}</span>
      {trailing}
    </MessageReferenceChip>
  );
  // Native title= on the chip element is only a hover tooltip; route it
  // through the RUI Tooltip so it follows the theme recipe (title= migration).
  return title ? <Tooltip content={title}>{chip}</Tooltip> : chip;
}
