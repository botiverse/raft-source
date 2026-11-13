import { createElement } from "react";
import type { HTMLAttributes, ReactNode } from "react";
import {
  EmptyState,
  EmptyStateActions,
  EmptyStateContent,
  EmptyStateDescription,
  EmptyStateIcon,
  EmptyStateTitle,
} from "@botiverse/raft-ui";

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
 *   2. No page-owned icon frame. RUI owns the icon slot and muted treatment,
 *      so the empty state recedes consistently across surfaces.
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
type TitleRenderProps = HTMLAttributes<HTMLElement>;
const TITLE_HEADING_RENDER = {
  h2: (props: TitleRenderProps) => createElement("h2", props),
  h3: (props: TitleRenderProps) => createElement("h3", props),
} as const;

export interface EmptyStateProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  icon: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  /** The title's heading level when the empty state is the area's only
   *  content (Raft DS › EmptyState: then its title is a heading). */
  titleHeading?: "h2" | "h3";
}

export default function AppEmptyState({
  icon,
  title,
  description,
  action,
  titleHeading,
  className = "",
  ...props
}: EmptyStateProps) {
  return (
    <EmptyState
      {...props}
      className={className}
    >
      <EmptyStateIcon>
        {icon}
      </EmptyStateIcon>
      <EmptyStateContent>
        <EmptyStateTitle render={titleHeading ? TITLE_HEADING_RENDER[titleHeading] : undefined}>{title}</EmptyStateTitle>
        {description ? <EmptyStateDescription>{description}</EmptyStateDescription> : null}
      </EmptyStateContent>
      {action ? <EmptyStateActions>{action}</EmptyStateActions> : null}
    </EmptyState>
  );
}
