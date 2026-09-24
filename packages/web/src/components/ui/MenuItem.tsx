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
 * Origin: stdrc 2026-05-25 #proj-theme:ac79cf20 msg=dae4c262 +
 * msg=245a96f0 + msg=8fdf9cba. Inventory pass found ~30 hand-rolled
 * `flex w-full … hover:bg-soft-signal transition-colors` rows that
 * had drifted on a few axes (`uppercase tracking-wide` on Sidebar
 * sort/add popovers, density modifiers in some places but not others).
 *
 * Distinct from `SelectionPopover` — that primitive is for single-select
 * dropdowns where the trailing ✓ marks the chosen option. This row is
 * pure action: no ✓, no selected-state fill. When state-changing items
 * like "Mark as Read ↔ Mark as Unread" or "Pin ↔ Unpin" toggle their
 * label based on current state, that's just label state, not a toggle
 * UI affordance (stdrc msg=245a96f0).
 *
 * Hover token: `bg-soft-signal/30` matches SegmentedControl unselected
 * hover + SelectionPopover row hover, so all selection-family and
 * action-menu surfaces share a single hover color. Right-click menus
 * intentionally do NOT differentiate destructive vs non-destructive at
 * the row level — every irreversible action is gated by a
 * `ConfirmDialog`, so the menu itself stays visually uniform (stdrc
 * msg=60e789d1: "Agent 的 Stop 和 Restart 菜单也没有特别的 hover 样式
 * … 因为它反正会弹出一个窗口提示，所以不需要在菜单上做特别呈现").
 */
export type MenuItemProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  /** Optional leading icon. Conventionally a lucide icon at `size={14}`. */
  icon?: ReactNode;
  /** Optional right-aligned slot (e.g. shortcut hint). */
  trailing?: ReactNode;
};

export default function MenuItem({
  icon,
  trailing,
  className = "",
  type = "button",
  role = "menuitem",
  children,
  ...rest
}: MenuItemProps) {
  // Compact-viewport density (`[@media(max-height:600px)]:py-1`) is
  // applied unconditionally — harmless on tall viewports and keeps
  // Sidebar / MessageItem / SavedPanel context menus visually uniform
  // in small viewports without per-callsite opt-in.
  const base = "flex w-full items-center gap-2 px-3 py-2 [@media(max-height:600px)]:py-1 text-sm text-left transition-colors";
  const tone = "font-medium text-black hover:bg-soft-signal/30 disabled:cursor-not-allowed disabled:text-black/30";

  return (
    <button
      type={type}
      role={role}
      className={`${base} ${tone} ${className}`}
      {...rest}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {trailing}
    </button>
  );
}
