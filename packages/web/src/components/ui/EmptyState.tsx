import type { HTMLAttributes, ReactNode } from "react";

/**
 * Canonical empty-state primitive — used everywhere a surface needs to say
 * "nothing here yet" (ThreadPanel, SavedPanel, ChannelFilesPanel, TasksPanel,
 * NotificationCenter, AgentDetailPanel, AgentActivityLog, MobileComputersPanel,
 * ThreadsInbox, ChatPanel).
 *
 * Design contract locked in 2026-05-15 #proj-uiux:4e20fa91 (task #246) —
 * cindyz raised the screenshot, Joy + 跳虎 + Bugen aligned on B + C:
 *
 *   1. Title is sentence case. Callers pass the literal string they want
 *      rendered. This primitive does not force case CSS. Per CLAUDE.md
 *      "Text Styles", case-mangling is reserved for section labels (12px)
 *      and dialog titles. Empty-state titles are informational hints,
 *      neither category.
 *
 *   2. No icon frame. The previous wrapper rendered a soft-gray box that
 *      read as OS placeholder default, visually jarring next to
 *      brutal-bordered sibling surfaces. Removed. Icons render directly
 *      inside a `text-black/40` wrapper, letting the empty state recede
 *      naturally as a quiet info hint.
 *
 *   3. Icon size = 36 at the callsite. With the frame gone the icon loses
 *      visual mass; size 36 (up from 28) keeps empty states from looking
 *      deflated. Muted color carries the weight without needing a box.
 *
 *   4. Title color is muted, not pure black. The "No …" line should
 *      sit back as empty-state body copy instead of reading like a primary
 *      heading.
 *
 * Contract test: `packages/web/tests/emptyState.test.ts` reverse-greps the
 * source for the banned classes so the soft-frame look can't be
 * resurrected accidentally.
 */
export interface EmptyStateProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  icon: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}

export default function EmptyState({
  icon,
  title,
  description,
  action,
  className = "",
  ...props
}: EmptyStateProps) {
  return (
    <div
      {...props}
      className={[
        "px-6 py-12 text-center",
        className,
      ].filter(Boolean).join(" ")}
    >
      <div className="mb-4 inline-flex items-center justify-center text-black/40">
        {icon}
      </div>
      <div className="mb-2 text-lg font-display font-semibold text-black/60">{title}</div>
      {description ? <div className="mx-auto max-w-[32ch] text-sm leading-relaxed text-black/60">{description}</div> : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}
