import type { HTMLAttributes } from "react";
import { cn } from "@botiverse/raft-ui";

/**
 * The leading slot of a menu row whose rows mix icons and avatars (a channel's
 * kind glyph next to a person's or an agent's face).
 *
 * raft-ui's menu item sizes a bare leading icon to 16 and lays the label out
 * right after whatever leads, so a 19px avatar (AvatarSlot `creator-link`,
 * raft-ui Avatar xs) pushes its row's label 3px further right than an icon
 * row's and sits 1.5px off the icons' centre line. Every row of such a menu
 * puts its icon or avatar in this one 20px box instead: icons stay the DS
 * menu's 16px ink-2 glyph and avatars keep their own 19px frame, both centred,
 * so the column of glyphs shares one centre and every label starts at the
 * same x. The same 20px slot as SelectionPopover's leading slot.
 */
export const MENU_ITEM_LEADING_SLOT = "menu-item-leading";

export default function MenuItemLeading({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      data-slot={MENU_ITEM_LEADING_SLOT}
      className={cn(
        "flex size-5 shrink-0 items-center justify-center",
        // The menu item's icon rule only reaches its direct svg children.
        "[&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-foreground-muted",
        "in-data-disabled:[&>svg]:text-foreground-disabled",
        className,
      )}
      {...props}
    />
  );
}
