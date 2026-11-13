import { SidebarItem, SidebarItemIcon, SidebarItemMeta, Skeleton } from "@botiverse/raft-ui";
import { SkeletonTextBar } from "../../../components/ui/Skeleton";
import {
  COMPUTER_ROW_ICON_CLASS,
  COMPUTER_ROW_META_CLASS,
  COMPUTER_ROW_NAME_CLASS,
  COMPUTER_ROW_NAME_LINE_CLASS,
  COMPUTER_ROW_TEXT_CLASS,
} from "./computerRowClasses";

/**
 * A computer row while the Computers list loads, built from the loaded row's
 * parts (ComputerRowBody): raft-ui's wrapping SidebarItem, the glyph's
 * SidebarItemIcon box with a 16px block where the glyph goes, and bars inside
 * the name line and the facts line (SidebarItemMeta). The lines' own type
 * gives the row its height, so it is the loaded two-line row's at every size.
 */
export function ComputerRowSkeleton() {
  return (
    <SidebarItem wrap interactive={false} aria-hidden="true" data-skeleton="" className="text-left">
      <SidebarItemIcon className={COMPUTER_ROW_ICON_CLASS}>
        <Skeleton className="size-4" />
      </SidebarItemIcon>
      <div className={COMPUTER_ROW_TEXT_CLASS}>
        <div className={COMPUTER_ROW_NAME_LINE_CLASS}>
          <span className={COMPUTER_ROW_NAME_CLASS}><SkeletonTextBar className="w-28" /></span>
        </div>
        <SidebarItemMeta className={COMPUTER_ROW_META_CLASS}>
          <span className="truncate"><SkeletonTextBar className="w-20" /></span>
        </SidebarItemMeta>
      </div>
    </SidebarItem>
  );
}
