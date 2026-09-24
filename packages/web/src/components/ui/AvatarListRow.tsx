import type { ButtonHTMLAttributes, ReactNode } from "react";
import SurfaceListItem from "./SurfaceListItem";

/**
 * Canonical "card-style row with an avatar on the left" primitive — the
 * pattern visible as `AGENTS ON THIS COMPUTER` rows in MachineDetailPanel.
 *
 * Per stdrc 2026-05-11 #wg-theme:eb11794c ("所有在 detail/profile 之类页面
 * 列出 agent、human 列表的地方，item 都应该复用 AGENTS ON THIS COMPUTER
 * 这个区域的那个 list item。组件化."): every place that lists agents or
 * humans inside a detail / profile panel should reuse this single row.
 * Previously the codebase had three independent implementations:
 *
 *   1. MachineDetailPanel agents — `<SurfaceListItem>` + inline `rowBody`
 *      with `<AvatarSlot context="surface-list">` + name + runtime +
 *      `<StatusDot>` + activity text. The canonical visual reference.
 *   2. AgentDetailPanel / HumanDetailPanel "Created Agents" — different
 *      primitive (`<AgentListRow>`), rendered as a `btn-brutal-sm`
 *      button with similar content but a different card frame.
 *   3. SettingsPanel admins — hand-rolled `<div border-2 border-black/30>`
 *      with `<AvatarSlot>` + name + email + Remove button (no shared
 *      component at all).
 *
 * `<AvatarListRow>` collapses (1) and (2) into one shape and provides
 * the API (3) needs (right-aligned action slot in place of StatusDot).
 *
 * **Slot contract** (every slot is a `ReactNode`, the primitive does NOT
 * own the participant kind — callers pass `<AvatarSlot type="agent|human">`
 * themselves so this stays orthogonal to the avatar primitive):
 *
 * - `avatar` — left column. Almost always `<AvatarSlot context="surface-list" ...>`.
 *   Required.
 * - `name` — primary text on the middle column (typically `displayName || name`).
 *   Required.
 * - `subtitle` — secondary text on the same line as `name` (runtime label,
 *   email, role label, etc.). Rendered in `text-xs font-mono text-black/50`
 *   and `flex-wrap`-friendly so it never crowds `name` on narrow viewports.
 *   Optional.
 * - `rightContent` — right column. Typical content: `<StatusDot>` plus an
 *   activity label, or a Remove / Demote / Promote button. Optional.
 *
 * **Interactive vs static**:
 *
 * - When `onClick` is passed, the row renders as a `<button>` that fills
 *   the SurfaceListItem and adds hover/active feedback via the existing
 *   `SurfaceListItem interactive` shadow contract.
 * - When `onClick` is omitted, the row renders as a static `<div>` and
 *   `SurfaceListItem interactive={false}` suppresses the hover affordance.
 *   Use this for SettingsPanel admin rows where the row body is static
 *   but the right slot houses a separate Remove `<button>`.
 *
 * **Selection mode** (MachineDetail's checkbox-mode bulk-select) is
 * intentionally NOT part of this primitive. Selection adds a leading
 * checkbox column and a different click handler — the caller wraps a
 * specialised selection-aware button around the same `avatar` / `name` /
 * `subtitle` / `rightContent` slots. Keeping selection out of the
 * primitive avoids leaking bulk-action concerns into every consumer.
 *
 * **Padding & background**: matches the canonical MachineDetailPanel row
 * (`px-3 py-2`). Pass `className` to override per-row background tint
 * (e.g. `bg-gray-100 hover:bg-white` for "not currently active" rows
 * inside MachineDetail).
 */
export interface AvatarListRowProps {
  avatar: ReactNode;
  name: ReactNode;
  subtitle?: ReactNode;
  rightContent?: ReactNode;
  /** When set, the row renders as a clickable `<button>`. */
  onClick?: () => void;
  /** Marks the row as "currently selected" (e.g. selection mode). The
   *  SurfaceListItem renders cyan-tint bg + shadow when selected. */
  selected?: boolean;
  /** Cross-axis alignment of the row contents.
   *
   *  - `"center"` (default) — matches the original MachineDetailPanel rows
   *    where the avatar is roughly the same height as the text column.
   *  - `"start"` — top-aligns avatar / text / actions. Use when the avatar
   *    is visually taller than the text column (e.g. multi-line metadata
   *    or a tall file thumbnail), per stdrc 2026-05-10 #wg-theme:7470ca2a
   *    ("头像在左边都应顶在左上角"). When `start` is set, the secondary
   *    text column also stacks vertically (name on top, subtitle wraps
   *    underneath) instead of the inline flex-wrap layout.
   */
  align?: "start" | "center";
  /** Interactive trailing slot rendered as a sibling of the row button
   *  (NOT inside it). Use this for actions like a Download / Remove
   *  button that must remain its own click target while the rest of the
   *  row triggers `onClick`. Distinct from `rightContent`, which is
   *  rendered inside the row button alongside `name` + `subtitle`. */
  actionContent?: ReactNode;
  /** Extra classes applied to the outer `<SurfaceListItem>` (padding /
   *  background / margin tweaks). */
  className?: string;
  /** Extra props for the inner `<button>` when `onClick` is provided
   *  (e.g. `data-testid`, `aria-label`, `title`). Ignored on the static
   *  variant. */
  buttonProps?: ButtonHTMLAttributes<HTMLButtonElement> & Record<`data-${string}`, string | undefined>;
}

export default function AvatarListRow({
  avatar,
  name,
  subtitle,
  rightContent,
  onClick,
  selected = false,
  align = "center",
  actionContent,
  className = "",
  buttonProps,
}: AvatarListRowProps) {
  const interactive = onClick !== undefined;
  const itemsAlignClass = align === "start" ? "items-start" : "items-center";
  // When the row is `align="start"`, the text column stacks name + subtitle
  // vertically (filename on top, metadata wrapping below) rather than the
  // default inline flex-wrap row.
  const textColumn = (
    <div className="min-w-0 flex-1">
      {align === "start" ? (
        <div className="flex min-w-0 flex-col gap-1">
          <span className="truncate text-sm font-bold text-black">{name}</span>
          {subtitle != null && subtitle !== false && (
            <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs font-mono text-black/50">
              {subtitle}
            </span>
          )}
        </div>
      ) : (
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <span className="truncate text-sm font-bold text-black">{name}</span>
          {subtitle != null && subtitle !== false && (
            <span className="text-xs font-mono text-black/50">{subtitle}</span>
          )}
        </div>
      )}
    </div>
  );
  // Body = avatar + (name + subtitle) + rightContent. Reused inside
  // either a `<button>` (interactive) or a `<div>` (static).
  const body = (
    <>
      {avatar}
      {textColumn}
      {rightContent != null && rightContent !== false && (
        // `self-center` overrides the outer `items-start` cross-axis
        // alignment when the row is `align="start"` (tall avatar) so the
        // rightContent slot stays vertically centered like the action
        // slot below, per stdrc 2026-05-15 #wg-theme:25bb834a
        // ("这个组件的按钮都应该是垂直居中").
        <div className="flex shrink-0 self-center items-center gap-1.5">{rightContent}</div>
      )}
    </>
  );
  const hasAction = actionContent != null && actionContent !== false;
  return (
    <SurfaceListItem
      selected={selected}
      interactive={interactive}
      className={`group px-3 py-2 ${className}`}
    >
      <div className={`flex w-full min-w-0 gap-3 ${itemsAlignClass}`}>
        {interactive ? (
          <button
            {...buttonProps}
            type="button"
            onClick={onClick}
            className={`flex min-w-0 flex-1 gap-3 text-left ${itemsAlignClass}`}
          >
            {body}
          </button>
        ) : (
          <div className={`flex min-w-0 flex-1 gap-3 ${itemsAlignClass}`}>{body}</div>
        )}
        {hasAction && (
          // Action slot always vertically centers itself, even when the row
          // is `align="start"` (tall avatar) — keeps icon-btn pairs from
          // hugging the top edge per stdrc 2026-05-15 #wg-theme:25bb834a
          // ("右边的按钮应该垂直居中").
          <div className="flex shrink-0 self-center items-center gap-1.5">{actionContent}</div>
        )}
      </div>
    </SurfaceListItem>
  );
}
