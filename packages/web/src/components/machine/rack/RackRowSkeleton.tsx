import { Card, CardContent, CardDescription, CardHeader, CardLeading, CardTitle, CardTrailing, Separator, Skeleton } from "@botiverse/raft-ui";
import { SkeletonTextBar } from "../../ui/Skeleton";
import { CardHeading } from "../../../features/computer/CardHeading";
import { RACK_ACTION_WIDTH, RACK_CELL_WIDTH, RACK_IDENTITY_WIDTH } from "../../../features/computer/computersRackLayout";
import type { ComputersRackView } from "../../../store/computersRackViewPreference";
import type { RackCardShape } from "../../../features/computer/computersRackRemembered";

// The loaded row's own type on each line (ComputerRackRow), so each line is
// the loaded line's height with a bar in it (SkeletonTextBar). A bar sits in
// its own span where the loaded line is a flex box, so the line keeps the
// text's height.
const NAME_CLASS = "min-w-0 truncate text-callout font-bold";
const FACTS_CLASS = "font-mono text-mono-meta whitespace-nowrap";
const OWNER_CLASS = "min-w-0 truncate text-caption";
const CARD_LINE_LABEL_CLASS = "flex min-w-0 items-center gap-1.5 text-footnote";

/** Two agents' slots (compact-row avatars, 28px): the slot line's height. */
function SlotsSkeleton() {
  return (
    <div className="flex h-7 items-center gap-1">
      <Skeleton className="size-7" />
      <Skeleton className="size-7" />
    </div>
  );
}

/** A card's meter line (RackCardLine): name, bar, value. */
function CardLineSkeleton({ name }: { name: string }) {
  return (
    <span className="col-span-3 grid grid-cols-subgrid items-center">
      <span className={CARD_LINE_LABEL_CLASS}><span className="truncate"><SkeletonTextBar className={name} /></span></span>
      <span className="flex items-center"><Skeleton className="h-2 w-full" /></span>
      <span className={`text-right ${FACTS_CLASS}`}><SkeletonTextBar className="w-14" /></span>
    </span>
  );
}

/**
 * A computer while the Computers list loads, in the loaded row's own layout
 * (ComputerRackRow), so the computers land where these were (Raft DS ›
 * Feedback: the skeleton is the size of what it stands for): a computer's
 * card in the shape it had last time (`shape`: its usage lines, the Other
 * runtimes line, or an offline card's none; else one usage line) or a desktop list row (the phone draws its own, MobileComputersPanel). aria-hidden: the list
 * around it says it is busy.
 */
/** A usage line, with its model line under it when it had one ("Fable · 40%", RackUsageCardLine). */
function UsageLineSkeleton({ model }: { model: boolean }) {
  return (
    <>
      <CardLineSkeleton name="w-12" />
      {model ? <CardLineSkeleton name="w-10" /> : null}
    </>
  );
}

const DEFAULT_CARD_SHAPE: RackCardShape = { usageLines: 1, modelLines: 0, leadUsage: false, otherRuntimes: false, offline: false };

export function RackRowSkeleton({ view, shape = DEFAULT_CARD_SHAPE }: { view: ComputersRackView; shape?: RackCardShape }) {
  if (view === "cards") {
    return (
      <Card className="h-full" aria-hidden="true" data-skeleton="" data-layout="card" data-card-shape={shape.offline ? "offline" : `${shape.usageLines}${shape.leadUsage ? "^" : ""}${shape.otherRuntimes ? "+" : ""}${shape.modelLines > 0 ? `.${shape.modelLines}` : ""}`} data-testid="rack-row-skeleton">
        <CardHeader>
          <CardLeading><Skeleton className="size-5" /></CardLeading>
          <CardTitle render={<CardHeading />} className="flex min-w-0 items-center gap-2">
            <span className={NAME_CLASS}><SkeletonTextBar className="w-28" /></span>
          </CardTitle>
          <CardTrailing><div className="size-8 shrink-0" /></CardTrailing>
          <CardDescription className={`col-span-2 flex min-w-0 items-baseline ${FACTS_CLASS}`}>
            <span className="min-w-0 truncate"><SkeletonTextBar className="w-36" /></span>
          </CardDescription>
          <span className={`col-span-2 ${OWNER_CLASS}`}><SkeletonTextBar className="w-20" /></span>
        </CardHeader>
        <CardContent className="flex flex-1 flex-col gap-3">
          <SlotsSkeleton />
          {shape.offline ? null : (
            <div className="grid grid-cols-[76px_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-2">
              {/* As the loaded card: a usage line the list is sorted by leads, over its own divider. */}
              {shape.leadUsage ? <><UsageLineSkeleton model={shape.modelLines > 0} /><Separator className="col-span-3" /></> : null}
              <CardLineSkeleton name="w-8" />
              <CardLineSkeleton name="w-12" />
              {shape.usageLines > (shape.leadUsage ? 1 : 0) ? <Separator className="col-span-3" /> : null}
              {Array.from({ length: shape.usageLines - (shape.leadUsage ? 1 : 0) }, (_, line) => (
                <UsageLineSkeleton key={line} model={line + (shape.leadUsage ? 1 : 0) < shape.modelLines} />
              ))}
            </div>
          )}
          {/* The Other runtimes line (RackOtherCardLine): one footnote line. */}
          {shape.otherRuntimes ? <span className="text-footnote"><SkeletonTextBar className="w-40" /></span> : null}
        </CardContent>
      </Card>
    );
  }
  // The desktop list's row: the computer's column, its agents, Disk and Memory, the next step's and the menu's columns.
  return (
    <div className="flex min-h-12 items-center gap-3 border-b border-line-hairline px-(--surface-inset) py-1" aria-hidden="true" data-skeleton="" data-testid="rack-row-skeleton">
      <div className={`${RACK_IDENTITY_WIDTH} shrink-0`}>
        <div className="flex min-w-0 items-center gap-2">
          <Skeleton className="size-5 shrink-0" />
          <span className={NAME_CLASS}><SkeletonTextBar className="w-28" /></span>
        </div>
        <div className={`mt-0.5 pl-[28px] ${FACTS_CLASS}`}><SkeletonTextBar className="w-36" /></div>
        <span className={`block pl-[28px] ${OWNER_CLASS}`}><SkeletonTextBar className="w-20" /></span>
      </div>
      <div className="min-w-0 flex-1"><SlotsSkeleton /></div>
      <div className="flex shrink-0 items-center gap-3">
        {[0, 1].map((cell) => (
          <div key={cell} className={`${RACK_CELL_WIDTH} shrink-0`}>
            <div className={`mb-1 ${FACTS_CLASS}`}><SkeletonTextBar className="w-14" /></div>
            <Skeleton className="h-2 w-full" />
          </div>
        ))}
      </div>
      <div className={`${RACK_ACTION_WIDTH} shrink-0`} />
      <div className="size-8 shrink-0" />
    </div>
  );
}
