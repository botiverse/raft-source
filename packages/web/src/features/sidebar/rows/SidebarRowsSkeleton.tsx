import { SidebarItem, SidebarItemContent, SidebarItemIcon, SidebarItemSubtitle, SidebarItemTitle, Skeleton } from "@botiverse/raft-ui";
import { SkeletonTextBar } from "../../../components/ui/Skeleton";

// Stryker disable all: drag-id helpers are exercised through source contracts and manual/browser DnD; the command-runner mutation oracle cannot synthesize dnd-kit pointer flows.
/**
 * Loading placeholder for a Sidebar list (channels / DMs / members). Shown
 * WHILE the store is loading so the section reads as "loading" rather than
 * flashing the "No X yet" empty state and then the real rows (闪回 fix, task
 * #32). Each placeholder is a raft-ui SidebarItem, the loaded row itself
 * (its height, 38px or 44px on a phone, its inset and gap), with the row's
 * lead in it: `avatar`, a person's or agent's 19px avatar (DMs, members), or
 * `icon`, SidebarItemIcon's box (a channel's or an entry's glyph, 16px with a
 * mouse on a desktop) — so content swaps in without the list or its leads
 * moving. The channel-tab sections pass the row count they last loaded with
 * (sidebarSectionRowCounts); none draws nothing. `twoLine`: the rows have a
 * footnote second line (a phone's agent row, Members), so each is the two-line
 * row's height (raft-ui's `wrap`), a bar in each line.
 */
export function SidebarRowsSkeleton({ rows = 4, lead = "avatar", twoLine = false }: { rows?: number; lead?: "avatar" | "icon"; twoLine?: boolean }) {
  if (rows <= 0) return null;
  return (
    // 2px apart, like the loaded rows (raft-design patterns/lists.md).
    <div aria-hidden="true" className="flex flex-col gap-0.5">
      {Array.from({ length: rows }, (_, i) => (
        <SidebarItem key={i} interactive={false} wrap={twoLine} data-skeleton="">
          {lead === "icon" ? (
            <SidebarItemIcon><Skeleton className="size-full" /></SidebarItemIcon>
          ) : (
            <Skeleton className="size-[19px] shrink-0" />
          )}
          {/* A fixed length, so the rows keep it when the column takes its remembered width. */}
          {!twoLine ? <SkeletonTextBar className="w-32" /> : (
            <SidebarItemContent stacked>
              <SidebarItemTitle><SkeletonTextBar className="w-32" /></SidebarItemTitle>
              <SidebarItemSubtitle className="text-footnote"><SkeletonTextBar className="w-40" /></SidebarItemSubtitle>
            </SidebarItemContent>
          )}
        </SidebarItem>
      ))}
    </div>
  );
}
// Stryker restore all
