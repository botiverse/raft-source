import { memo, useCallback, useMemo, useRef } from "react";
import type { CSSProperties, KeyboardEvent, MouseEvent, PointerEvent, ReactNode } from "react";
import { useIntl } from "react-intl";
import {
  ScrollArea,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableColgroup,
  TableColumn,
  TableHead,
  TableHeader,
  TableRow,
  Skeleton,
} from "@botiverse/raft-ui";
import { CommentIcon } from "@botiverse/ricons";

import { formatRelativeTime } from "../../utils/relativeTime";
import { ArtifactAuthor } from "./ArtifactAuthor";
import { artifactKindIcon } from "./ArtifactCardParts";
import { artifactShownTitle } from "./artifactFacts";
import { ArtifactNewSticker } from "./ArtifactNewSticker";
import ArtifactScopeLabel from "./ArtifactScopeLabel";
import { artifactUrl } from "./artifactLinks";
import type { ArtifactDashboardItem } from "./artifactDashboardItems";
import type { OpenRow } from "./artifactDashboardParts";
import {
  ARTIFACT_TABLE_COLUMNS,
  ARTIFACT_TABLE_DEFAULT_WIDTHS,
  ARTIFACT_TABLE_MAX_WIDTH,
  ARTIFACT_TABLE_MIN_WIDTH,
  clampWidth,
} from "./artifactDashboardPrefs";
import type { ArtifactTableColumn, ArtifactTableSizedColumn } from "./artifactDashboardPrefs";
import { isPlainPrimaryClick } from "./openArtifactInPlace";
import { useSkeletonShown } from "./artifactSkeletonShown";

/**
 * The home page's list view on a wider screen (#proj-workspace:#133, design D20,
 * D21; xxchan: a table like Feishu's list view): one row per Artifact, the title
 * (the kind's icon, the title, the pink sticker), who made it, when it was opened or
 * updated, its comments and who can see it, on raft-ui's Table. No column says
 * where it lives in words (#proj-workspace:#187): the scope chip already does.
 *
 * The rows come in the server's order and the page never sorts them: a sort
 * over the pages loaded so far would put a row from the next page in the wrong
 * place. No heading sorts or says an order (#proj-workspace:#210): the filter
 * bar alone does. The time column follows the rows: in the order they were
 * opened (`byOpened`) it is Opened, and a row never opened shows its update, the
 * tile's rule; else Updated.
 *
 * Built here, for raft-ui to take over (listed in the PR, Kirby upstreams them):
 * the column-resize grip and the whole-row link.
 */

const COLUMN_LABEL_IDS = {
  title: "artifacts.dashboard.table.title",
  author: "artifacts.dashboard.table.author",
  updated: "artifacts.dashboard.table.updated",
  comments: "artifacts.dashboard.table.comments",
  visibility: "artifacts.dashboard.table.visibility",
} as const satisfies Record<ArtifactTableColumn, string>;

/** Keyboard steps of the resize grip (design D21). */
const GRIP_STEP = 16;
/**
 * The least the title keeps (Kirby: a title narrower than this reads worse than the last column panning off). It takes
 * what the sized columns leave, and they stay as the reader dragged them, so it is the first to give way. Under this
 * the table is wider than its ScrollArea, which pans it, the edge fading to say so: nothing is cut for good. At the
 * default widths that is a table of 804px, which fits a page of 844px, so a 901px window with the 57px rail.
 */
const TITLE_MIN_WIDTH = 200;

/**
 * A sized column's width, a custom property on the table its `<col>` reads: a resize drag sets it on the table itself
 * as the pointer moves (ColumnGrip), so nothing renders until the drag ends and its width is kept, once.
 */
const columnVar = (column: ArtifactTableSizedColumn) => `--artifacts-col-${column}`;
const COLUMN_STYLES = ARTIFACT_TABLE_COLUMNS.map((column) => (column === "title" ? undefined : { width: `var(${columnVar(column)})` }));
const tableMinWidth = (widths: Record<ArtifactTableSizedColumn, number>) => TITLE_MIN_WIDTH + Object.values(widths).reduce((sum, width) => sum + width, 0);

export function ArtifactsTable({ items, byOpened, widths, onWidthChange, readerId, onOpen, empty, testId, loadingRows = 0 }: {
  items: readonly ArtifactDashboardItem[];
  /** The rows are in the order they were opened: the time column says when, not when they were updated. */
  byOpened: boolean;
  widths: Record<ArtifactTableSizedColumn, number>;
  /** A new width for a column; null puts back its default. */
  onWidthChange: (column: ArtifactTableSizedColumn, width: number | null) => void;
  readerId: string | null;
  onOpen: OpenRow;
  /** Shown under the header row when there are no rows (the header stays: design t5). */
  empty?: ReactNode;
  /** While the first page loads: this many placeholder rows under the real header, each a loaded row's height (#proj-raft-ui:#246). */
  loadingRows?: number;
  testId: string;
}) {
  const { formatMessage } = useIntl();
  // The kept widths; a drag shows its width live on the table's DOM (ColumnGrip) and is kept when it ends (one write per drag).
  const tableStyle = useMemo(() => {
    const style: Record<string, string | number> = { minWidth: tableMinWidth(widths) };
    for (const [column, width] of Object.entries(widths)) style[columnVar(column as ArtifactTableSizedColumn)] = `${width}px`;
    return style as CSSProperties;
  }, [widths]);

  return (
    <>
      {/* A wide table pans sideways in a raft-ui ScrollArea named like the table, its edge fading where more lies past
          it, so a touch screen, whose scrollbar shows only while panning, sees that at rest. The mask is measured from the
          content box and as wide as the area, so the margin is on the content: on the area it would push the fade 20px past
          the edge. It sits in the page's scroller, so overscroll stays `auto` (scroll chaining as before). */}
      <ScrollArea fade orientation="horizontal" overscroll="auto" role="region" aria-label={formatMessage({ id: "artifacts.dashboard.title" })} className="min-w-0" contentClassName="px-(--column-margin)" data-testid={testId}>
        <Table className="table-fixed" style={tableStyle}>
          <TableCaption className="sr-only">{formatMessage({ id: "artifacts.dashboard.title" })}</TableCaption>
          <TableColgroup>
            {ARTIFACT_TABLE_COLUMNS.map((column, index) => <TableColumn key={column} style={COLUMN_STYLES[index]} />)}
          </TableColgroup>
          <TableHeader>
            <TableRow>
              {ARTIFACT_TABLE_COLUMNS.map((column) => {
                const label = formatMessage({ id: column === "updated" && byOpened ? "artifacts.dashboard.table.opened" : COLUMN_LABEL_IDS[column] });
                return (
                  // The heading is named by its column alone (its grip is a control of its own beside the label).
                  <TableHead key={column} align={column === "comments" ? "right" : "left"} aria-label={label} className="relative" data-column={column}>
                    <span className="inline-flex items-center gap-1" data-testid="artifacts-table-heading-label">{label}</span>
                    {column === "title" ? null : (
                      <ColumnGrip
                        column={column}
                        label={formatMessage({ id: "artifacts.dashboard.table.resize" }, { column: label })}
                        width={widths[column]}
                        onCommit={onWidthChange}
                      />
                    )}
                  </TableHead>
                );
              })}
            </TableRow>
          </TableHeader>
          {items.length > 0 ? (
            <TableBody>
              {items.map((item, index) => <ArtifactTableRow key={item.card.id} item={item} index={index} readerId={readerId} onOpen={onOpen} />)}
            </TableBody>
          ) : loadingRows > 0 ? (
            <TableBody aria-hidden data-testid="artifacts-all-skeleton" data-layout="table">
              <ArtifactTableSkeletonRows count={loadingRows} />
            </TableBody>
          ) : null}
        </Table>
      </ScrollArea>
      {/* Past the area, not in it: the content box is as wide as the table, so it would centre off to the right and fade. */}
      {items.length === 0 && loadingRows === 0 && empty ? empty : null}
    </>
  );
}

/** The placeholder rows, once the skeleton's wait is over (useSkeletonShown). */
function ArtifactTableSkeletonRows({ count }: { count: number }) {
  const shown = useSkeletonShown();
  return shown ? <>{Array.from({ length: count }, (_, index) => <ArtifactTableSkeletonRow key={index} />)}</> : null;
}

/** A loaded row's cells, each a bar on its line: the row is the loaded row's height (its cells' padding and line). */
function ArtifactTableSkeletonRow() {
  const bar = (width: string) => <span className="flex h-[1lh] items-center"><Skeleton variant="line" className={width} /></span>;
  return (
    <TableRow data-testid="artifacts-skeleton-table-row">
      <TableCell><div className="flex min-w-0 items-start gap-2"><Skeleton variant="block" className="mt-0.5 size-4 shrink-0 rounded-sm" />{bar("w-3/4")}</div></TableCell>
      <TableCell>{bar("w-20")}</TableCell>
      <TableCell className="font-mono text-mono-meta">{bar("w-12")}</TableCell>
      <TableCell align="right" className="font-mono text-mono-meta">{bar("ms-auto w-4")}</TableCell>
      <TableCell>{bar("w-16")}</TableCell>
    </TableRow>
  );
}

/**
 * TODO(raft-ui): a table row that opens as a whole. The title is the row's link
 * and its ::after covers the row (the `tr` is its containing block: `relative`,
 * which WebKit and Chromium honour on a table row), as the cards' titles do; the
 * scope chip is a control of its own above it. Table has no row link yet.
 */
const ArtifactTableRow = memo(function ArtifactTableRow({ item, index, readerId, onOpen }: {
  item: ArtifactDashboardItem;
  index: number;
  readerId: string | null;
  onOpen: OpenRow;
}) {
  const intl = useIntl();
  const { formatMessage } = intl;
  const { card, news } = item;
  const open = useCallback((event: MouseEvent<HTMLAnchorElement>) => {
    if (!isPlainPrimaryClick(event)) return;
    event.preventDefault();
    onOpen(card, event.currentTarget, index);
  }, [card, onOpen, index]);
  return (
    <TableRow className="relative cursor-pointer" data-testid="artifacts-dashboard-row" data-view="table" data-artifact-id={card.id}>
      <TableCell>
        <div className="flex min-w-0 items-start gap-2">
          <span className="mt-0.5 shrink-0 text-foreground-muted [&_svg]:size-4" aria-hidden>{artifactKindIcon(card.kind)}</span>
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <a
              href={artifactUrl(card.id, null)}
              onClick={open}
              data-artifact-open=""
              data-artifact-title=""
              data-testid="artifacts-table-title"
              className="min-w-0 font-bold break-words text-foreground no-underline outline-none after:absolute after:inset-0 focus-visible:after:shadow-focus"
            >
              {artifactShownTitle(card.title)}
            </a>
            <ArtifactNewSticker news={news} />
          </div>
        </div>
      </TableCell>
      <TableCell><ArtifactAuthor actor={card.author} readerId={readerId} /></TableCell>
      <TableCell className="font-mono text-mono-meta whitespace-nowrap text-foreground-hint" data-testid="artifacts-table-time">{formatRelativeTime(item.openedAt ?? card.updatedAt, intl.locale)}</TableCell>
      <TableCell align="right" className="font-mono text-mono-meta text-foreground-hint" data-testid="artifacts-table-comments">
        <span className="inline-flex items-center gap-1 [&_svg]:size-3.5" aria-label={formatMessage({ id: "artifacts.card.comments" }, { count: card.commentCount })}>
          {card.commentCount > 0 ? <CommentIcon aria-hidden /> : null}
          {card.commentCount}
        </span>
      </TableCell>
      <TableCell><ArtifactScopeLabel home={card.home} fromAnotherServer={card.fromAnotherServer} onCard /></TableCell>
    </TableRow>
  );
});

/**
 * TODO(raft-ui): a column-resize grip (design D21). On a column's left edge in
 * the header row, 8px wide; under the pointer or while dragged a 2px bar shows
 * and the cursor is col-resize; no line at rest (Raft DS › Table › Rules: no
 * vertical lines). Dragging moves the edge (left widens the column, the title
 * gives the room); a double click puts back the default. Focusable on its own
 * as a separator: → or ↑ widens the column 16px, ← or ↓ narrows it (a
 * separator's value). Table has no resize part yet (table.md only says to fix
 * widths with TableColgroup), so it is built on `table-fixed` here.
 *
 * A drag follows the pointer without rendering: it sets the column's width
 * (its custom property), the table's least width and its own value on the DOM,
 * and on the release puts them back as rendered and keeps the new width, which
 * renders once (the rows are memoized and don't).
 */
function ColumnGrip({ column, label, width, onCommit }: {
  column: ArtifactTableSizedColumn;
  label: string;
  width: number;
  onCommit: (column: ArtifactTableSizedColumn, width: number | null) => void;
}) {
  const drag = useRef<{ x: number; width: number; last: number; grip: HTMLElement; table: HTMLElement | null; minWidth: string } | null>(null);
  const show = useCallback((start: NonNullable<typeof drag.current>, next: number) => {
    start.table?.style.setProperty(columnVar(column), `${next}px`);
    if (start.table) start.table.style.minWidth = next === start.width ? start.minWidth : `${(Number.parseFloat(start.minWidth) || 0) + next - start.width}px`;
    start.grip.setAttribute("aria-valuenow", String(next));
  }, [column]);
  const down = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const table = event.currentTarget.closest("table");
    drag.current = { x: event.clientX, width, last: width, grip: event.currentTarget, table, minWidth: table?.style.minWidth ?? "" };
  }, [width]);
  const move = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (!start) return;
    const next = clampWidth(start.width + (start.x - event.clientX));
    if (next === start.last) return;
    start.last = next;
    show(start, next);
  }, [show]);
  const up = useCallback(() => {
    const start = drag.current;
    drag.current = null;
    if (!start) return;
    // Back to what React rendered, so the kept width (rendered in this same event) is React's to write.
    show(start, start.width);
    if (start.last !== start.width) onCommit(column, start.last);
  }, [column, onCommit, show]);
  const key = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    // Not while the pointer holds it: the release puts back the width from the drag's start.
    if (drag.current) return;
    // As any separator's value: → and ↑ make the column wider, ← and ↓ narrower.
    const step = event.key === "ArrowRight" || event.key === "ArrowUp" ? GRIP_STEP : event.key === "ArrowLeft" || event.key === "ArrowDown" ? -GRIP_STEP : 0;
    if (step === 0) return;
    event.preventDefault();
    onCommit(column, width + step);
  }, [column, onCommit, width]);
  const reset = useCallback(() => onCommit(column, null), [column, onCommit]);
  const stop = useCallback((event: MouseEvent) => event.stopPropagation(), []);
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={ARTIFACT_TABLE_MIN_WIDTH}
      aria-valuemax={ARTIFACT_TABLE_MAX_WIDTH}
      tabIndex={0}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onKeyDown={key}
      onDoubleClick={reset}
      onClick={stop}
      data-default={width === ARTIFACT_TABLE_DEFAULT_WIDTHS[column] ? "" : undefined}
      data-testid={`artifacts-table-grip-${column}`}
      className="group/grip absolute inset-y-0 -left-1 z-control flex w-2 cursor-col-resize touch-none justify-center outline-none focus-visible:shadow-focus"
    >
      <span aria-hidden className="h-full w-0.5 rounded-full bg-transparent group-hover/grip:bg-line-strong group-active/grip:bg-line-strong group-focus-visible/grip:bg-line-strong" />
    </div>
  );
}
