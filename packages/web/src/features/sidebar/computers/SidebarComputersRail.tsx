import { SidebarItem, SidebarSectionControl, SidebarSectionControls, SidebarSectionDisclosure, SidebarSectionHeader as RaftSidebarSectionHeader, SidebarSectionTitle, SidebarSectionTrailing } from "@botiverse/raft-ui";
import Tooltip from "../../../components/ui/Tooltip";
import { Plus, ArrowLeft } from "lucide-react";
import { SidebarCellList } from "../rows/SidebarCellList";
import { sidebarSkeletonRows } from "../../../components/layout/sidebarSectionRowCounts";
import { ComputerRowSkeleton } from "./ComputerRowSkeleton";
import { ComputersRailList } from "./ComputersRailList";
import { ComputersSectionCount } from "./ComputersSectionCount";
import { SidebarSectionDescription } from "../sections/SidebarSectionDescription";
import type { SidebarData } from "../hooks/useSidebarData";
import type { SidebarViewState } from "../hooks/useSidebarViewState";
import type { SidebarRowHandlers } from "../hooks/useSidebarRowHandlers";
import type { SidebarRoute } from "../hooks/useSidebarRoute";
import type { SidebarCreateActions } from "../hooks/useSidebarCreateActions";

/**
 * The Computers rail: the phone's Back row, the section head and one row per computer.
 */
export function SidebarComputersRail({ mobileInline, data, view, rowHandlers, route, createActions }: {
  mobileInline: boolean | undefined;
  data: SidebarData;
  view: SidebarViewState;
  rowHandlers: SidebarRowHandlers;
  route: SidebarRoute;
  createActions: SidebarCreateActions;
}) {
  const { formatMessage, machinesLoading, machineNames, sidebarMachineIds, rememberedComputerRows } = data;
  const { canRegisterMachines } = view;
  const { handleSelectMachine } = rowHandlers;
  const { backToSettingsFromComputers, isMachineSelected } = route;
  const { openAddMachineDialog } = createActions;

  // The list is still on its way: its rows are placeholders, and the head
  // has no count (a "0" there would be read as none).
  const listPending = machinesLoading && Object.keys(machineNames).length === 0;
  // Stryker disable all: pre-existing empty-computer state is outside the workspace mutation corpus.
  const emptyComputersContent = Object.keys(machineNames).length === 0
    ? listPending ? (
      // The loaded rows' own parts, as many as last time here (2 the first
      // time), so the rows land where their placeholders were.
      <SidebarCellList aria-busy="true" data-testid="computers-rail-skeleton">
        {Array.from({ length: sidebarSkeletonRows(rememberedComputerRows, 2) }, (_, i) => <ComputerRowSkeleton key={i} />)}
      </SidebarCellList>
    ) : (
      // The empty line sits 8px under the heading, where the first row would.
      <SidebarSectionDescription className="py-2">{formatMessage({ id: "layout.sidebar.noComputersYet" })}</SidebarSectionDescription>
    )
    : null;
  // Stryker restore all
  return (
    <>
      {/* Computers surface — one row per computer (name, its mono run
          label / version, presence pixel). Renders on both desktop
          (dedicated Computers rail) and mobile (reached via the
          Settings sub-nav → /computers). */}
      {/* Mobile-only back row — on mobile Computers is not a top-level
          tab, it's a level-2 push under the Settings tab. iOS
          NavigationView expects a back affordance at the top of every
          pushed view, so render a "← Settings" row that pops back to
          /settings (the Settings tab home). Desktop has its own
          dedicated Computers rail so the back row would be wrong there. */}
      {mobileInline && (
      <SidebarCellList>
        {/* A row of the list (raft-ui SidebarItem): its states on the
            cell's inset shape, like the rows under it. */}
        <SidebarItem
          tone="muted"
          onClick={backToSettingsFromComputers}
          data-testid="computers-mobile-back"
          className="gap-1"
          aria-label={formatMessage({ id: "layout.sidebar.backToSettings" })}
        >
          <ArrowLeft size={20} className="shrink-0" />
          {formatMessage({ id: "layout.sidebar.headerSettings" })}
        </SidebarItem>
      </SidebarCellList>
      )}
      {/* On desktop Computers is a full page with no sidebar
          (shellRouteLayout), so the rack has no entry here. */}
      <RaftSidebarSectionHeader>
        {/* Not collapsible: the section title's type, without the button. */}
        <SidebarSectionDisclosure render={<div />} type={undefined}>
          <SidebarSectionTitle>{formatMessage({ id: "layout.sidebar.computersSectionLabel" })}</SidebarSectionTitle>{listPending ? null : <> <ComputersSectionCount count={sidebarMachineIds.length} /></>}
        </SidebarSectionDisclosure>
        {canRegisterMachines && (
          <SidebarSectionTrailing>
            <SidebarSectionControls>
              <Tooltip content={formatMessage({ id: "layout.sidebar.addComputer" })}>
              <SidebarSectionControl
                type="button"
                aria-label={formatMessage({ id: "layout.sidebar.addComputer" })}
                onClick={openAddMachineDialog}
              >
                <Plus />
              </SidebarSectionControl>
              </Tooltip>
            </SidebarSectionControls>
          </SidebarSectionTrailing>
        )}
      </RaftSidebarSectionHeader>

      <ComputersRailList
        machineIds={sidebarMachineIds}
        isSelected={isMachineSelected}
        onSelect={handleSelectMachine}
        empty={emptyComputersContent}
      />
    </>
  );
}
