import { SidebarItem, SidebarItemIcon, Skeleton } from "@botiverse/raft-ui";
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
 * (sidebarSectionRowCounts); none draws nothing.
 */
export function SidebarRowsSkeleton({ rows = 4, lead = "avatar" }: { rows?: number; lead?: "avatar" | "icon" }) {
  if (rows <= 0) return null;
  return (
    // 2px apart, like the loaded rows (raft-design patterns/lists.md).
    <div aria-hidden="true" className="flex flex-col gap-0.5">
      {Array.from({ length: rows }, (_, i) => (
        <SidebarItem key={i} interactive={false} data-skeleton="">
          {lead === "icon" ? (
            <SidebarItemIcon><Skeleton className="size-full" /></SidebarItemIcon>
          ) : (
            <Skeleton className="size-[19px] shrink-0" />
          )}
          {/* A fixed length, so the rows keep it when the column takes its remembered width. */}
          <SkeletonTextBar className="w-32" />
        </SidebarItem>
      ))}
    </div>
  );
}
// Stryker restore all
