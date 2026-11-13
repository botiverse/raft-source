import { Button, Card, CardContent, CardDescription, CardHeader, CardLeading, CardTitle, CardTrailing, IconTile, PanelAction, PanelScrollViewport, ListRow, ListRowBody, ListRowDescription, ListRowGroup, ListRowTitle, Skeleton } from "@botiverse/raft-ui";
import { EllipsisVertical, Monitor, Plus, RefreshCw } from "lucide-react";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import type { ComponentProps, MouseEvent } from "react";
import { useIntl } from "react-intl";
import { useLocation } from "react-router-dom";
import { useAuthStore } from "../../store/authStore";
import { useMachineStore } from "../../store/machineStore";
import { useShallow } from "zustand/react/shallow";
import { orderSidebarMachineIds } from "../layout/sidebarMachineOrder";
import { readSidebarComputerRowCount } from "../layout/sidebarSectionRowCounts";
import { useServerStore } from "../../store/serverStore";
import { useServerPermissions } from "../../hooks/useServerPermissions";
import { useAppNavigate, useMobileBack } from "../../hooks/useAppNavigate";
import Banner from "../ui/Banner";
import EmptyState from "../ui/EmptyState";
import PanelHeader from "../ui/PanelHeader";
import { SkeletonTextBar } from "../ui/Skeleton";
import { ComputerDeviceIcon } from "./ComputerDeviceIcon";
import { MachineRunLabel } from "./MachineRunLabel";
import { ComputerRowStatusDot, ComputerRowVersionFact } from "./ComputerRowVersionFact";
import { getComputerAttentionStatus } from "../../utils/computerUpgradeIndicator";
import { getComputerAvailableVersion } from "../../utils/computerVersionFact";
import { machineDiskLowPresentation } from "../../utils/machineDiskPresentation";
import { formatMachinePlatformLine } from "../../utils/machinePlatformLine";
import { deferredPanel } from "../../boot/deferredUi";
import { loadComputersRack } from "../../features/computer/computersRackChunk";
import type { ComputersRackList as RackList } from "../../features/computer/ComputersRackList";
import type { ComputersRackToolbar as RackToolbar } from "../../features/computer/ComputersRackToolbar";
import { useComputersRackView } from "../../store/computersRackViewPreference";
import { useLocalComputerMachineId } from "./localComputer/localComputerStore";

/**
 * Mobile-only Computers panel — renders as a regular detail panel (the
 * shared PanelHeader over a paper body) so /computers visually matches other
 * Settings sub-pages like Account / Browser / Server. Reported as a styling
 * inconsistency by @stdrc 2026-05-01 `#proj-uiux:c8711d2a` msg 2a500cb7 —
 * previously /computers on mobile rendered via the Sidebar's inline branch,
 * which read as sidebar navigation rather than a page.
 *
 * Raft Design System › ListRow: the computers are one inset list (surface,
 * hairline, container radius) of 64-tall rows — a neutral square tile with
 * the presence pixel, the name 16/24 600, the description 14/20 ink-2, the
 * run label in Space Mono. Hairlines between rows start at the text edge.
 *
 * Desktop still uses the Sidebar's dedicated Computers rail column;
 * only mobile routes /computers here.
 */
// A computer row's lines under its name, shared with its skeleton
// (ComputerListSkeleton): the run label and facts, then the platform.
const COMPUTER_ROW_FACTS_CLASS = "flex min-w-0 items-center gap-1.5 font-mono text-mono-meta text-foreground-hint";
const COMPUTER_ROW_PLATFORM_CLASS = "truncate font-mono text-mono-meta text-foreground-hint";

/**
 * The computers while the list loads: the loaded list's own ListRowGroup and
 * ListRows (no gap, the group's hairlines), each with the IconTile's 35px box
 * and bars in the name, the facts and the platform line (a connected
 * computer reports its platform), so the rows land where these were
 * (#proj-raft-ui:#231).
 */
export function ComputerListSkeleton({ count = 4 }: { count?: number }) {
  return (
    <ListRowGroup aria-busy="true" data-testid="computers-loading-skeleton">
      {Array.from({ length: count }, (_, index) => (
        <ListRow key={index} interactive={false} render={<div />} aria-hidden="true" data-skeleton="">
          <Skeleton className="size-[35px] shrink-0 rounded-control" />
          <ListRowBody>
            <ListRowTitle><SkeletonTextBar className="w-28" /></ListRowTitle>
            {/* The bar in the facts line's own truncating span (a flex item), so the line keeps its height. */}
            <div className={COMPUTER_ROW_FACTS_CLASS}><span className="truncate"><SkeletonTextBar className="w-40" /></span></div>
            <div className={COMPUTER_ROW_PLATFORM_CLASS}><SkeletonTextBar className="w-24" /></div>
          </ListRowBody>
        </ListRow>
      ))}
    </ListRowGroup>
  );
}

// The rack loads on demand: the desktop overview
// lazy-loads the same module (MainLayout), so a static import here would put
// all of it in the first download. This panel stays eager (the native WebView
// lands on it, and main.tsx starts the rack's code at boot on this route); the
// rack shows a skeleton of its own layout until its code is in, and a failed
// download shows Try again in its place (deferredPanel).
const ComputersRackList = deferredPanel<ComponentProps<typeof RackList>>(() => loadComputersRack().then((module) => ({ default: module.ComputersRackList })));
// The rack's search and its Filter / Group / Sort menus, from the same load.
const ComputersRackToolbar = deferredPanel<ComponentProps<typeof RackToolbar>>(() => loadComputersRack().then((module) => ({ default: module.ComputersRackToolbar })));

// The rack's phone parts, for its skeleton (RackSkeleton): the card's meters
// grid (ComputerRackRow's cards) and the list's runtime header line
// (RackListHeader's phone row).
const RACK_CARD_METERS_CLASS = "grid grid-cols-[76px_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-2";
const RACK_CARD_LINE_LABEL_CLASS = "flex min-w-0 items-center gap-1.5 text-footnote";
const RACK_MONO_META_CLASS = "font-mono text-mono-meta whitespace-nowrap";
// The agents' line: their 27px slots (RackSlotStrip, whose 4px inset its
// negative margin takes back).
const RACK_SLOTS_LINE_CLASS = "h-[27px]";

/** A card's Disk or Memory line: label, bar, "x% used" (RackResource's card line). */
function RackCardLineSkeleton() {
  return (
    <>
      <span className={RACK_CARD_LINE_LABEL_CLASS}><span><SkeletonTextBar className="w-12" /></span></span>
      <span className="flex items-center"><Skeleton variant="line" className="h-2 w-full" /></span>
      <span className={RACK_MONO_META_CLASS}><SkeletonTextBar className="w-14" /></span>
    </>
  );
}

/**
 * A computer's card while the rack loads, from the loaded card's parts
 * (ComputerRackRow, cards): the head (the device's 20px glyph, the name, the
 * … menu's box, the facts line, the owner line), the agents' line, and
 * Disk and Memory. The usage and Other runtimes lines below them depend on
 * the computer's runtimes, not known yet.
 */
function RackCardSkeleton() {
  return (
    <Card aria-hidden="true" data-skeleton="" className="h-full">
      <CardHeader>
        <CardLeading><Skeleton className="size-5" /></CardLeading>
        <CardTitle render={<div />} className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 text-callout font-bold"><SkeletonTextBar className="w-28" /></span>
        </CardTitle>
        {/* The menu's box, held invisible. */}
        <CardTrailing className="invisible">
          <PanelAction disabled tabIndex={-1}><EllipsisVertical /></PanelAction>
        </CardTrailing>
        <CardDescription className={`col-span-2 flex min-w-0 items-baseline ${RACK_MONO_META_CLASS}`}>
          <span className="min-w-0 truncate"><SkeletonTextBar className="w-48" /></span>
        </CardDescription>
        <span className="col-span-2 min-w-0 text-caption"><SkeletonTextBar className="w-24" /></span>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-3">
        <div className={RACK_SLOTS_LINE_CLASS} />
        <div className={RACK_CARD_METERS_CLASS}>
          <RackCardLineSkeleton />
          <RackCardLineSkeleton />
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * A computer's block in the phone list while the rack loads, from the loaded
 * block's parts (ComputerRackRow, phone): the name line (glyph, name, version
 * on the right), the owner line, the agents' line and the runtime cells' line.
 */
function RackBlockSkeleton() {
  return (
    <div aria-hidden="true" data-skeleton="" className="border-b border-line-seam px-4 py-3">
      <div className="flex items-center gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Skeleton className="size-5 shrink-0" />
          <span className="min-w-0 text-callout font-bold"><SkeletonTextBar className="w-28" /></span>
        </div>
        <span className={`shrink ${RACK_MONO_META_CLASS}`}><SkeletonTextBar className="w-20" /></span>
      </div>
      <span className="mt-1 block text-caption"><SkeletonTextBar className="w-24" /></span>
      <div className={`mt-2 ${RACK_SLOTS_LINE_CLASS}`} />
      {/* The runtime cells' line (their 24px buttons). */}
      <div className={`mt-2 flex h-6 items-center ${RACK_MONO_META_CLASS}`}><SkeletonTextBar className="w-3/5" /></div>
    </div>
  );
}

/**
 * The rack while its computers or its code load, in the loaded rack's own
 * layout so nothing moves when it arrives: the cards' one-column grid, or the
 * list's runtime header over its flat, full-width blocks between seam lines
 * (the body has no padding then).
 */
function RackSkeleton({ view, count, testId }: { view: "list" | "cards"; count: number; testId: string }) {
  if (view === "cards") {
    return (
      <div className="grid grid-cols-1 gap-3" data-testid={testId} data-view="cards">
        {Array.from({ length: count }, (_, index) => <RackCardSkeleton key={index} />)}
      </div>
    );
  }
  return (
    <div className="bg-layer-card" data-testid={testId} data-view="list">
      <div className="border-b border-line-seam" aria-hidden="true">
        <div className={`flex h-7 items-center px-4 ${RACK_MONO_META_CLASS}`}><SkeletonTextBar className="w-3/5" /></div>
      </div>
      {Array.from({ length: count }, (_, index) => <RackBlockSkeleton key={index} />)}
    </div>
  );
}

/**
 * The most computers the rack's skeleton draws (more are below the fold).
 * While the list itself loads it draws as many as the list had last time
 * here (the sidebar's remembered count), two when never loaded.
 */
const RACK_SKELETON_MAX = 6;

export default function MobileComputersPanel() {
  const { formatMessage } = useIntl();
  // The same order as the desktop sidebar's Computers list
  // (sidebarMachineOrder.ts): this device, then the viewer's own, then the rest.
  const localMachineId = useLocalComputerMachineId();
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const machines = useMachineStore(useShallow((s) => {
    const byId = new Map(s.machines.map((machine) => [machine.id, machine]));
    return orderSidebarMachineIds(s.machines, localMachineId, userId).map((id) => byId.get(id)!);
  }));
  const latestComputerVersion = useMachineStore((s) => s.latestComputerVersion);
  const machinesLoading = useMachineStore((s) => s.loading);
  const machineLoadStatus = useMachineStore((s) => s.loadStatus);
  const machineLoadError = useMachineStore((s) => s.loadError);
  const loadMachines = useMachineStore((s) => s.loadMachines);
  const setShowAddMachine = useMachineStore((s) => s.setShowAddMachine);
  const serverSlug = useServerStore((s) => s.current?.slug);
  const { capabilities } = useServerPermissions();
  const canRegisterMachines = capabilities.registerMachines;
  const nav = useAppNavigate();
  const location = useLocation();
  const attentionOnly = new URLSearchParams(location.search).get("filter") === "attention";
  const rackView = useComputersRackView();
  const showRack = !machinesLoading && machineLoadStatus === "loaded" && machines.length > 0 && !attentionOnly;
  // While the list loads, the rack's skeleton stands where the rack will be.
  const rackSkeleton = machinesLoading && !attentionOnly;
  const rackList = (showRack || rackSkeleton) && rackView === "list";
  const serverId = useServerStore((s) => s.current?.id);
  const rememberedComputers = useMemo(() => readSidebarComputerRowCount(userId, serverId), [userId, serverId]);
  // The rack's toolbar shows with the page, loading, empty or errored too (Raft DS › A page of a list: a list
  // page always shows its head, its toolbar and its list, skeleton rows while it loads), Add computer at its end.
  // The desktop overview shows it the same way.
  const showToolbar = !attentionOnly;
  // Its code loads apart: until it is on screen (or if it fails to load), the dashed add row stays.
  const [toolbarMounted, setToolbarMounted] = useState(false);
  // Start the rack's code with the machine list rather than after it.
  useEffect(() => {
    if (!attentionOnly) void loadComputersRack().catch(() => {});
  }, [attentionOnly]);
  const visibleMachines = attentionOnly
    ? machines.filter((machine) => getComputerAttentionStatus(machine) !== "none")
    : machines;
  // Computers is a page pushed from the server tab's popover on mobile; back
  // pops to where it was opened (Home when opened cold, or the app root if
  // serverSlug is missing).
  const onMobileBack = useMobileBack(serverSlug ? `/s/${serverSlug}` : "/");
  const mobileBackProps = useMemo(
    () => ({ "data-testid": "computers-mobile-back", title: formatMessage({ id: "common.announcement.back" }) }),
    [formatMessage],
  );
  const retryLoadMachines = useCallback(() => {
    void loadMachines();
  }, [loadMachines]);
  const openAddMachine = useCallback(() => setShowAddMachine(true), [setShowAddMachine]);
  const openComputer = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    const machineId = event.currentTarget.dataset.machineId;
    if (machineId) nav.toComputer(machineId);
  }, [nav]);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="mobile-computers-panel">
      {/* Header — uses canonical PanelHeader so padding (`gap-3 px-5`),
          back-chevron sizing, and action-slot wrapping match every other
          Settings sub-page (Account / Browser / Server). Was hand-rolled
          with `gap-3 px-5` before; converted to PanelHeader after stdrc
          confirmed (2026-05-14 #wg-theme:16123203) that the wider BEFORE
          padding is the canonical look on every breakpoint. */}
      <PanelHeader
        title={formatMessage({ id: "machine.mobile.title" })}
        onMobileBack={onMobileBack}
        mobileBackProps={mobileBackProps}
      />
      {/* The view switch and Add computer are at the toolbar's end (Raft DS › A page of a list). */}
      {showToolbar ? (
        <Suspense fallback={null}>
          <ComputersRackToolbar variant="phone" onAdd={canRegisterMachines ? openAddMachine : undefined} onMountedChange={setToolbarMounted} />
        </Suspense>
      ) : null}

      {/* Body — paper, with the computers as one inset list. */}
      {/* The rack's list runs edge to edge under its sticky header, so the
          body drops its padding for it (a sticky header stays inside a
          scroller's padding). */}
      {/* The panel's one scroller, a raft-ui ScrollArea. */}
      <PanelScrollViewport className={`flex-1 bg-layer-canvas safe-bottom ${rackList ? "" : "p-4"}`} data-testid="mobile-computers-scroll">
        <div className="flex flex-col gap-2.5">
          {/* The rack's skeleton in its view (cards or list); the attention list, the rows'. */}
          {machinesLoading && (!attentionOnly
            ? <RackSkeleton view={rackView} count={Math.min(rememberedComputers ?? 2, RACK_SKELETON_MAX)} testId="computers-loading-skeleton" />
            : <ComputerListSkeleton />)}
          {!machinesLoading && machineLoadError && machines.length > 0 && (
            // The list below is a saved copy: a recoverable problem (Raft DS
            // warning Banner) with one small ink-line action. Part of the page,
            // not news, so it does not announce itself.
            <div className={rackList ? "px-4 pt-4" : "contents"}>
              <Banner
                intent="warning"
                live={false}
                data-testid="computers-refresh-error"
                title={formatMessage({ id: "machine.mobile.refreshErrorSaved" })}
                actions={(
                  <Button size="md" variant="outline" onClick={retryLoadMachines}>
                    <RefreshCw size={16} />
                    {formatMessage({ id: "machine.mobile.retry" })}
                  </Button>
                )}
              />
            </div>
          )}
          {!machinesLoading && machineLoadStatus === "error" && (
            <EmptyState
              className="flex flex-col items-center justify-center py-10"
              icon={<Monitor size={36} />}
              title={formatMessage({ id: "machine.mobile.loadErrorTitle" })}
              description={formatMessage({ id: "machine.mobile.loadErrorDescription" })}
              action={
                <Button size="md" variant="outline" onClick={retryLoadMachines}>
                  <RefreshCw size={16} />
                  {formatMessage({ id: "machine.mobile.retry" })}
                </Button>
              }
            />
          )}
          {!machinesLoading && machineLoadStatus === "loaded" && machines.length === 0 && (
            <EmptyState
              className="flex flex-col items-center justify-center py-10"
              icon={<Monitor size={36} />}
              title={formatMessage({ id: "emptyState.noComputersTitle" })}
              description={formatMessage({ id: "machine.mobile.emptyDescription" })}
            />
          )}
          {!machinesLoading && machineLoadStatus === "loaded" && machines.length > 0 && visibleMachines.length === 0 && (
            <EmptyState
              className="flex flex-col items-center justify-center py-10"
              icon={<Monitor size={36} />}
              title={formatMessage({ id: "machine.mobile.noAttentionTitle" })}
              description={formatMessage({ id: "machine.mobile.noAttentionDescription" })}
            />
          )}
          {/* Every computer as a block with its agents as slots (the rack
              overview's phone layout, no drag). */}
          {showRack && (
            <Suspense fallback={<RackSkeleton view={rackView} count={Math.min(machines.length, RACK_SKELETON_MAX)} testId="computers-rack-loading" />}>
              {rackView === "cards" ? (
                <ComputersRackList variant="phone" view="cards" />
              ) : (
                // Flat, full width: rows separated by seam lines, no card.
                <div className="bg-layer-card">
                  <ComputersRackList variant="phone" view="list" />
                </div>
              )}
            </Suspense>
          )}
          {!machinesLoading && machineLoadStatus === "loaded" && visibleMachines.length > 0 && attentionOnly && (
            <ListRowGroup>
          {visibleMachines.map((machine) => {
              // Same row signal as the desktop Sidebar: the web's own version comparison.
              const availableVersion = getComputerAvailableVersion(machine, latestComputerVersion);
              const diskLow = machineDiskLowPresentation(machine, formatMessage);
              const platformLine = formatMachinePlatformLine(machine);
              return (
                // Raft Design System › ListRow (raft-ui): the neutral IconTile
                // with the presence pixel on its corner, the name, the
                // description and the facts in machine type. The group draws
                // the hairline from the text column (16 + 35 + 12).
                <ListRow
                  key={machine.id}
                  data-machine-id={machine.id}
                  onClick={openComputer}
                  data-testid={`computer-list-item-${machine.id}`}
                >
                  <span className="relative shrink-0">
                    <IconTile>
                      <ComputerDeviceIcon machine={machine} />
                    </IconTile>
                    <ComputerRowStatusDot
                      className="absolute -right-1 -top-1"
                      machine={machine}
                      availableVersion={availableVersion}
                    />
                  </span>
                  <ListRowBody>
                    <ListRowTitle>{machine.name}</ListRowTitle>
                    {machine.description && (
                      <ListRowDescription>{machine.description}</ListRowDescription>
                    )}
                    <div className={COMPUTER_ROW_FACTS_CLASS}>
                      <span className="truncate">
                        <MachineRunLabel machine={machine} />
                      </span>
                      {/* An update, available or required, needs handling:
                          orange, as the pixel on the tile and low disk. */}
                      <ComputerRowVersionFact
                        machine={machine}
                        availableVersion={availableVersion}
                        arrowClassName="shrink-0 font-bold text-warning-strong"
                        chipClassName="shrink-0 font-bold text-warning-strong"
                      />
                      {diskLow && (
                        <span
                          className="shrink-0 font-bold text-warning-strong"
                          data-testid={`computer-disk-low-${machine.id}`}
                          title={formatMessage({ id: "machine.diskLow.chipTitle" }, { free: diskLow.free, total: diskLow.total })}
                        >
                          {formatMessage({ id: "machine.diskLow.chip" })}
                        </span>
                      )}
                    </div>
                    {/* OS release · cloud platform, in the same machine type
                        as the facts above; no line when neither is known. */}
                    {platformLine && (
                      <div
                        className={COMPUTER_ROW_PLATFORM_CLASS}
                        data-testid={`computer-platform-${machine.id}`}
                      >
                        {platformLine}
                      </div>
                    )}
                  </ListRowBody>
                </ListRow>
              );
          })}
            </ListRowGroup>
          )}
          {/* @artin: the add affordance is a full-width "+" row at the END of the list,
              not a top-right corner icon. A dashed seam (like an empty board column)
              marks it as an action rather than an item. Gated on
              register-machines permission; under host-shell the panel header no longer carries
              an actions row, so this row is the sole add path in the embedded WebView.
              With the rack's toolbar on screen, Add computer is at its end instead. */}
          {!machinesLoading && machineLoadStatus === "loaded" && canRegisterMachines && !toolbarMounted && (
            <button
              onClick={openAddMachine}
              data-testid="computers-add-row"
              className="flex min-h-11 w-full items-center justify-center gap-2 rounded-container border border-dashed border-line-seam px-4 py-3 text-subhead font-bold text-foreground-muted outline-none hover:bg-fill-medium hover:text-foreground active:bg-fill-medium focus-visible:shadow-focus"
            >
              <Plus size={18} aria-hidden="true" />
              {formatMessage({ id: "machine.mobile.addComputer" })}
            </button>
          )}
        </div>
      </PanelScrollViewport>
    </div>
  );
}
