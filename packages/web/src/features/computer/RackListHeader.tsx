import { useIntl } from "react-intl";
import { useCallback } from "react";
import type { ReactNode } from "react";
import { Separator } from "@botiverse/raft-ui";
import { TableSortButton } from "@botiverse/raft-ui/wip";
import type { TableSort } from "@botiverse/raft-ui/wip";
import type { RackRuntimeColumns } from "../../components/machine/rack/rackRuntimeColumns";
import { RackRuntimeHeading } from "../../components/machine/rack/RackRuntimeUsage";
import type { ComputersRackSort, ComputersRackSortKey } from "../../store/computersRackSortPreference";
import type { RackVariant } from "./computersRackTypes";
import { firstSortDirection, remainingSortKey } from "./computersRackSort";
import { RACK_CELL_WIDTH, RACK_USAGE_CELL_WIDTH, RACK_IDENTITY_WIDTH, RACK_OTHER_WIDTH, RACK_ACTION_WIDTH, phoneRuntimeGrid } from "./computersRackLayout";

const TABLE_SORT: Record<ComputersRackSort["direction"], TableSort> = { asc: "ascending", desc: "descending" };

/**
 * A heading that sorts the list (Raft DS › Table › Sorting, a header row
 * drawn without `Table`): a columnheader of this hand-drawn row, in the row's
 * type, line and height, holding a raft-ui TableSortButton that fills it. It
 * marks the sorted column (`aria-sort` on the cell, the arrow on the button)
 * and reverses it on a click; numbers start high to low.
 */
function SortHeading({ sortKey, sort, onSort, className, children }: {
  sortKey: ComputersRackSortKey;
  sort: ComputersRackSort | null;
  onSort: (sort: ComputersRackSort) => void;
  className: string;
  children: ReactNode;
}) {
  const fromTableSort = useCallback(
    (next: TableSort) => onSort({ key: sortKey, direction: next === "ascending" ? "asc" : "desc" }),
    [onSort, sortKey],
  );
  const tableSort = sort?.key === sortKey ? TABLE_SORT[sort.direction] : undefined;
  return (
    <div role="columnheader" aria-sort={tableSort} className={className} data-testid={`rack-sort-${sortKey}`}>
      <TableSortButton
        sort={tableSort}
        firstSort={TABLE_SORT[firstSortDirection(sortKey)]}
        onSortChange={fromTableSort}
      >
        {children}
      </TableSortButton>
    </div>
  );
}

/**
 * The list's column headings, sticky at the top of the scroll: on desktop
 * every column; on a phone, where a block has no Disk / Memory, only the
 * runtime columns, over the blocks' runtime cells. On desktop the Computer,
 * Disk, Memory and usage headings sort the list (`sort`, `onSort`); a phone's
 * headings don't.
 */
export function RackListHeader({ variant, columns, sort = null, onSort }: {
  variant: RackVariant;
  columns: RackRuntimeColumns;
  sort?: ComputersRackSort | null;
  onSort?: (sort: ComputersRackSort) => void;
}) {
  const { formatMessage } = useIntl();
  const desktop = variant === "desktop";
  const runtimeHeadings = (
    <>
      {columns.usage.map((column) => (desktop && onSort ? (
        <SortHeading key={column.provider} sortKey={remainingSortKey(column.provider)} sort={sort} onSort={onSort} className={`${RACK_USAGE_CELL_WIDTH} shrink-0`}>
          <RackRuntimeHeading runtimeId={column.runtimeId} />
        </SortHeading>
      ) : (
        <RackRuntimeHeading
          key={column.provider}
          runtimeId={column.runtimeId}
          role={desktop ? "columnheader" : undefined}
          className={desktop ? `${RACK_USAGE_CELL_WIDTH} shrink-0 self-center text-foreground-muted` : "text-foreground-muted"}
        />
      )))}
      {columns.other.length > 0 ? (
        <span role={desktop ? "columnheader" : undefined} className={`${desktop ? `${RACK_OTHER_WIDTH} shrink-0 self-center` : ""} truncate`}>
          {formatMessage({ id: "machine.rack.colOther" })}
        </span>
      ) : null}
    </>
  );
  if (!desktop) {
    if (columns.usage.length === 0 && columns.other.length === 0) return null;
    return (
      <div className="sticky top-0 z-sticky border-b border-line-seam bg-layer-card" data-testid="computers-rack-header">
        <div className="flex h-7 items-center px-4 font-mono text-mono-meta text-foreground-hint">
          <div className="w-full" style={phoneRuntimeGrid(columns)}>{runtimeHeadings}</div>
        </div>
      </div>
    );
  }
  // The row doesn't center its cells: a heading that sorts stretches to the
  // row's height so its button fills it (the button centers its label); the
  // other headings center themselves.
  const heading = (key: ComputersRackSortKey, width: string, label: string) => (onSort
    ? <SortHeading sortKey={key} sort={sort} onSort={onSort} className={`${width} shrink-0`}>{label}</SortHeading>
    : <span role="columnheader" className={`${width} shrink-0 self-center truncate`}>{label}</span>);
  return (
    <div className="sticky top-0 z-sticky border-b border-line-hairline bg-layer-canvas" data-testid="computers-rack-header">
      <div role="row" className="flex h-7 gap-3 px-(--surface-inset) font-mono text-mono-meta text-foreground-hint">
        {heading("name", RACK_IDENTITY_WIDTH, formatMessage({ id: "machine.rack.colComputer" }))}
        <span role="columnheader" className="min-w-0 flex-1 self-center">{formatMessage({ id: "machine.rack.colAgents" })}</span>
        <div className="flex shrink-0 gap-3">
          {heading("disk", RACK_CELL_WIDTH, formatMessage({ id: "agent.migration.target.disk" }))}
          {heading("memory", RACK_CELL_WIDTH, formatMessage({ id: "agent.migration.target.memory" }))}
          {columns.usage.length > 0 || columns.other.length > 0 ? <Separator orientation="vertical" className="h-4 self-center" /> : null}
          {runtimeHeadings}
        </div>
        {/* The next step's and the menu's columns have no heading. */}
        <span role="columnheader" className={`${RACK_ACTION_WIDTH} shrink-0`} />
        <span role="columnheader" className="size-8 shrink-0" />
      </div>
    </div>
  );
}
