import { useCallback } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { ChevronDown } from "lucide-react";
import type { ComputersRackView } from "../../store/computersRackViewPreference";

/**
 * A group's title in the rack: a toolbar group (Group) or the folded
 * Offline section: a chevron that folds
 * the group, its name and its count in machine type ("6 computers"). The
 * whole title is the fold's button, so the hit area is the row.
 */
export function RackGroupTitle({ view, children, testId, counts, collapsed, groupKey = "", onToggle }: {
  view: ComputersRackView;
  children: ReactNode;
  testId: string;
  counts?: string;
  collapsed?: boolean;
  /** The group `onToggle` is told about. */
  groupKey?: string;
  /** The title folds its group. */
  onToggle: (groupKey: string) => void;
}) {
  const { formatMessage } = useIntl();
  const toggleGroup = useCallback(() => onToggle(groupKey), [groupKey, onToggle]);
  const name = typeof children === "string" ? children : "";
  const toggle = (
    <button
      type="button"
      onClick={toggleGroup}
      aria-expanded={!collapsed}
      // Its name says the group and how many it holds, as the title shows them.
      aria-label={formatMessage({ id: collapsed ? "machine.rack.group.expand" : "machine.rack.group.collapse" }, { group: name, count: counts ?? "" })}
      className="group/rack-title flex w-full min-w-0 items-baseline gap-2 rounded-control text-left outline-none focus-visible:shadow-focus"
      data-testid={`${testId}-toggle`}
    >
      <ChevronDown
        size={14}
        aria-hidden
        className={`shrink-0 translate-y-0.5 self-start text-foreground-hint transition-transform group-hover/rack-title:text-foreground ${collapsed ? "-rotate-90" : ""}`}
      />
      <span className="min-w-0 truncate font-sans text-subhead font-bold text-foreground">{children}</span>
      {counts ? <span className="shrink-0 font-mono text-mono-meta text-foreground-hint" data-testid={`${testId}-counts`}>{counts}</span> : null}
    </button>
  );
  if (view === "cards") return <div className="col-span-full pt-2 first:pt-0" data-testid={testId}>{toggle}</div>;
  return (
    <div role="row" className="border-b border-line-hairline bg-layer-canvas" data-testid={testId}>
      <div role="cell" className="px-(--surface-inset) pt-4 pb-2">{toggle}</div>
    </div>
  );
}
