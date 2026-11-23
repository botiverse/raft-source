// The log as a table (one row per move, the newest first) and its search field: the other view of the chart's moves,
// for finding a computer an agent was moved to or from. Moved out of MigrationLogPage so the page stays within its
// module-shape budget.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, ReactNode, RefObject } from "react";
import { useIntl } from "react-intl";
import { Search, SearchX, X } from "lucide-react";
import {
  Button, EmptyState, EmptyStateActions, EmptyStateContent, EmptyStateIcon, EmptyStateTitle, InputGroup, InputGroupAddon,
  InputGroupInput, Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow, TableScroll,
} from "@botiverse/raft-ui";
import type { AgentMigrationLogEntry } from "@botiverse/raft-shared";
import AvatarSlot from "../../ui/AvatarSlot";
import { durationSec, targetNode } from "./model";
import type { LogNode, NodeId } from "./model";
import { OutcomeBadge } from "./OutcomeBadge";

/** Rows drawn at first and added by each Show more: the log holds up to 2,000 moves. */
const PAGE_SIZE = 100;

/** The table's search: computer names and codes (now and at the time), and agent names. */
export function MigrationLogSearch({ value, onChange, onClear, inputRef, className }: {
  value: string;
  onChange: (value: string) => void;
  /** Empties the field and puts focus back in it (the page's, so the table's empty state can clear it too). */
  onClear: () => void;
  inputRef: RefObject<HTMLInputElement | null>;
  className?: string;
}) {
  const { formatMessage: t } = useIntl();
  const onInput = useCallback((e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value), [onChange]);
  const label = t({ id: "agent.migrationLog.table.search" });
  return (
    <InputGroup size="md" className={className}>
      <InputGroupAddon><Search aria-hidden /></InputGroupAddon>
      <InputGroupInput aria-label={label} placeholder={label} ref={inputRef} value={value} onChange={onInput} suppressPasswordManager data-testid="migration-log-search" />
      <InputGroupAddon align="inline-end">
        {value ? <Button type="button" variant="ghost" size="icon-md" aria-label={t({ id: "agent.migrationLog.table.clearSearch" })} onClick={onClear}><X aria-hidden /></Button> : null}
      </InputGroupAddon>
    </InputGroup>
  );
}

/**
 * A computer in a row: its code, then its name; and the name it had at the time of the move when it was renamed
 * since (what a search by that old name matched).
 */
function Place({ node, nodeName, recorded }: { node: LogNode | undefined; nodeName: (n: LogNode) => string; recorded: string | null }) {
  const { formatMessage: t } = useIntl();
  const name = node ? nodeName(node) : null;
  return (
    <span className="whitespace-nowrap">
      {t({ id: "agent.migrationLog.fmt.codeName" }, {
        code: <span key="code" className="font-mono font-bold text-foreground">{node?.code}</span>,
        name: <span key="name" className="text-foreground-muted">{name}</span>,
      })}
      {recorded && name && recorded !== name ? <span className="ms-1 text-caption text-foreground-hint" data-testid="migration-log-table-then">{t({ id: "agent.migrationLog.table.thenName" }, { name: recorded })}</span> : null}
    </span>
  );
}

export function MigrationLogTable({ entries, query, onClearSearch, nodeById, nodeName, agentLink, avatarOf, formatTime, formatDuration }: {
  /** The moves that pass the filters and the search, oldest first (as the log sends them). */
  entries: AgentMigrationLogEntry[];
  query: string;
  onClearSearch: () => void;
  nodeById: Map<NodeId, LogNode>;
  nodeName: (n: LogNode) => string;
  agentLink: (id: string) => ReactNode;
  avatarOf: (id: string) => string | null;
  formatTime: (iso: string) => string;
  formatDuration: (s: number | null) => string;
}) {
  const { formatMessage: t } = useIntl();
  // Rows shown, for this query: a new query starts again at one page (the table stays mounted while typing).
  const [page, setPage] = useState({ query, limit: PAGE_SIZE });
  const limit = page.query === query ? page.limit : PAGE_SIZE;
  const rows = useMemo(() => [...entries].reverse().slice(0, limit), [entries, limit]);
  // Show more takes focus to the first row it added (Show more itself goes once every row is shown).
  // An object per press, so a second press at the same index still moves focus.
  const [focusAt, setFocusAt] = useState<{ index: number } | null>(null);
  const bodyRef = useRef<HTMLTableSectionElement>(null);
  const more = useCallback(() => { setPage({ query, limit: limit + PAGE_SIZE }); setFocusAt({ index: limit }); }, [query, limit]);
  useEffect(() => {
    if (focusAt == null) return;
    bodyRef.current?.querySelectorAll<HTMLTableRowElement>("tr")[focusAt.index]?.focus();
  }, [focusAt]);

  if (!entries.length) {
    return (
      <EmptyState className="py-16" data-testid="migration-log-table-empty">
        <EmptyStateIcon><SearchX aria-hidden /></EmptyStateIcon>
        <EmptyStateContent><EmptyStateTitle>{t({ id: "agent.migrationLog.table.noMatch" }, { query: query.trim() })}</EmptyStateTitle></EmptyStateContent>
        <EmptyStateActions><Button variant="outline" size="md" onClick={onClearSearch}>{t({ id: "agent.migrationLog.table.clearSearch" })}</Button></EmptyStateActions>
      </EmptyState>
    );
  }
  const title = t({ id: "agent.migrationLog.table.caption" });
  return (
    <div className="stack-y-2">
      <TableScroll role="region" aria-label={title} className="w-full" data-testid="migration-log-table">
        <Table className="min-w-180">
          <TableCaption className="sr-only">{title}</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead aria-sort="descending">{t({ id: "agent.migrationLog.table.time" })}</TableHead>
              <TableHead>{t({ id: "agent.migrationLog.table.agent" })}</TableHead>
              <TableHead>{t({ id: "agent.migrationLog.table.route" })}</TableHead>
              <TableHead>{t({ id: "agent.migrationLog.filter.outcome" })}</TableHead>
              <TableHead align="right">{t({ id: "agent.migrationLog.table.duration" })}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody ref={bodyRef}>
            {rows.map((e, i) => (
              <TableRow key={e.migrationRef} tabIndex={i === focusAt?.index ? -1 : undefined} data-testid="migration-log-table-row">
                <TableCell className="whitespace-nowrap text-foreground-muted">{formatTime(e.startedAt)}</TableCell>
                <TableCell>
                  <span className="flex items-center gap-1.5"><AvatarSlot context="compact-row" type="agent" agentAvatarUrl={avatarOf(e.agentId)} />{agentLink(e.agentId)}</span>
                </TableCell>
                <TableCell data-testid="migration-log-table-route">
                  {t({ id: "agent.migrationLog.fmt.route" }, {
                    from: <Place key="from" node={nodeById.get(e.sourceMachineId)} nodeName={nodeName} recorded={e.sourceMachineName} />,
                    to: <Place key="to" node={nodeById.get(targetNode(e))} nodeName={nodeName} recorded={e.targetKind === "hosted" ? null : e.targetMachineName} />,
                  })}
                </TableCell>
                <TableCell data-testid="migration-log-table-outcome"><OutcomeBadge outcome={e.outcome} all /></TableCell>
                <TableCell align="right" className="font-mono">{formatDuration(durationSec(e))}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableScroll>
      {entries.length > rows.length ? (
        <Button variant="ghost" size="md" onClick={more} data-testid="migration-log-table-more">
          {t({ id: "agent.migrationLog.table.showMore" }, { count: Math.min(PAGE_SIZE, entries.length - rows.length) })}
        </Button>
      ) : null}
    </div>
  );
}
