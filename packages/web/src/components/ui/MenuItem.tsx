import type { ButtonHTMLAttributes, ReactNode } from "react";

/**
 * Pure-action menu row primitive.
 *
 * Shared by the family of "click → run an action" menus across the app:
 * - Right-click context menus (Sidebar channel/DM/agent, MessageItem,
 *   SavedPanel, ThreadsInbox)
 * - Sidebar add-popover menus (Add channel → Join existing / Create new …)
 * - Mark-as-read / pin / archive / delete rows
 *
 * Use it instead of hand-rolling a row, so every action menu keeps one case
 * (as written) and one density.
 *
 * Distinct from `SelectionPopover` — that primitive is for single-select
 * dropdowns where the trailing ✓ marks the chosen option. This row is
 * pure action: no ✓, no selected-state fill. An item whose label follows the
 * current state ("Mark as Read ↔ Mark as Unread", "Pin ↔ Unpin") only changes
 * its label; it is not a toggle.
 *
 * Raft Design System › Menu (`rf-menu__item`): 36 tall, `radius-chip` (6px), 14/20
 * 500 ink, a 16px ink-2 icon, 10px gap; pointer hover and keyboard focus are
 * the yellow-soft highlight, disabled is the disabled ink. Destructive rows
 * are NOT coloured — every irreversible action is gated by a `ConfirmDialog`
 * whose red/orange button carries the consequence, so the menu itself stays
 * visually uniform.
 *
 * Hand-rolled (not raft-ui's DropdownMenuItem / ContextMenuItem) because these
 * rows also live in plain popovers outside a Base UI Menu root; the classes
 * mirror raft-ui's raft menu-item recipe so both kinds of menu read the same.
 */
export type MenuItemProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  /** Optional leading icon, a Lucide icon; the row draws it at 16px. */
  icon?: ReactNode;
  /** Optional right-aligned slot (e.g. shortcut hint). */
  trailing?: ReactNode;
};

// Compact-viewport density (`max-height: 600px`) is applied unconditionally —
// harmless on tall viewports and keeps Sidebar / MessageItem / SavedPanel
// context menus visually uniform in small viewports without per-callsite
// opt-in.
const MENU_ITEM_CLASS = [
  "flex min-h-option w-full items-center gap-2.5 rounded-chip px-2.5 py-option-inset text-left [@media(max-height:600px)]:min-h-8 [@media(max-height:600px)]:py-1",
  "font-sans text-callout font-medium text-foreground",
  "outline-none transition-colors enabled:hover:bg-brand-soft enabled:focus-visible:bg-brand-soft",
  // The leading icon is 16px whatever size a caller passes: a menu's icons are
  // 16px (raft-design iconography.md, Sizes), so callers can't drift to 14px.
  "[&>svg]:shrink-0 [&>svg:first-child]:size-4 [&>svg:first-child]:text-foreground-muted",
  "disabled:cursor-not-allowed disabled:text-foreground-disabled disabled:[&>svg:first-child]:text-foreground-disabled",
].join(" ");

export default function MenuItem({
  icon,
  trailing,
  className = "",
  type = "button",
  role = "menuitem",
  children,
  ...rest
}: MenuItemProps) {
  return (
    <button
      type={type}
      role={role}
      data-slot="menu-item"
      className={`${MENU_ITEM_CLASS} ${className}`.trim()}
      {...rest}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {trailing}
    </button>
  );
}
