import { useCallback, useMemo } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import {
  Button,
  Card,
  CardContent,
  DescriptionList,
  ListRowGroup,
  ListRowMeta,
  Switch,
} from "@botiverse/raft-ui";
import { TableSortButton } from "@botiverse/raft-ui/wip";
import type { TableSort } from "@botiverse/raft-ui/wip";
import { ArrowDownRight, ArrowUpRight, RefreshCw, X } from "lucide-react";
import Banner from "../../components/ui/Banner";
import SectionEyebrow from "../../components/ui/SectionEyebrow";
import { useTimeFormatter } from "../../hooks/useTimeFormatter";
import type { MessageId } from "../../i18n/messages/en";
import type { Machine } from "../../store/machineStore";
import { AgentUsageDayBars, UsageSwatch } from "../agent/AgentUsageDayBars";
import { UsageChange, UsageFact } from "../agent/AgentUsageParts";
import { useElementWidth, useUsageFormat } from "../agent/agentUsageHooks";
import { cacheShareOfInput } from "../agent/agentUsage";
import { AfterSkeletonDelay } from "./MemberTileSkeletons";
import { AgentRowSkeleton, MembersAgentGroup, MembersAgentUsageHeadings } from "./MembersAgentList";
import { MembersAgentUsageOne } from "./MembersAgentUsageOne";
import { CELL, HEADING_LABEL } from "./membersAgentColumns";
import type { AgentRowUsage } from "./MembersAgentList";
import { firstUsageSort, sortUsageEntries } from "./membersAgentUsageModel";
import type { MembersAgentUsage, UsageSort, UsageSortKey } from "./membersAgentUsageModel";
import type { MembersAgentUsageState } from "./useMembersAgentUsage";
import type { MemberEntry, MemberGroup } from "./membersPageModel";

// Members › Agents › Usage (#proj-o11y:#36 step 2, v5 mock approved by
// Artea): beside Details, the same agents with their token usage for a
// period: a summary of the listed agents the reader may inspect (the bars pick
// a day), then per agent Tokens, Share, Per turn, Context and the change, sortable.
// One request per period for all of them; a row opens the agent's Usage tab.

// The usage columns' tracks, on the heading line and every row. Below 760px of
// list Per turn and Context give way; below 1040px the trend (and Model, which
// folds under the name: MembersAgentList).
const COL = {
  tokens: "flex w-[104px] shrink-0 justify-end text-right",
  share: "flex w-[60px] shrink-0 justify-end text-right",
  perTurn: "hidden w-[84px] shrink-0 justify-end text-right @[760px]/members-list:flex",
  context: "hidden w-[70px] shrink-0 justify-end text-right @[760px]/members-list:flex",
  change: "flex w-[124px] shrink-0 justify-end text-right",
  trend: "hidden w-[84px] shrink-0 @[1040px]/members-list:flex",
} as const;
const TREND_WIDTH = 80;
const TREND_HEIGHT = 20;
const CHART_FALLBACK_WIDTH = 480;


/**
 * A day's tokens over the range, as a line; the picked day (else the last)
 * marked. Today, still in progress, is the last point: its segment dashed and
 * its dot hollow, so a partial day doesn't read as a drop. Decorative: the
 * row's figures say it.
 */
function Trend({ values, mark, partial }: { values: readonly (number | null)[]; mark: number; partial: number }) {
  const max = Math.max(1, ...values.map((value) => value ?? 0));
  const step = (TREND_WIDTH - 4) / Math.max(1, values.length - 1);
  const points = values.map((value, index) => (value === null ? null : [2 + index * step, TREND_HEIGHT - 3 - ((TREND_HEIGHT - 6) * value) / max] as const));
  const line = (from: number, to: number) => points.slice(from, to).filter((point): point is readonly [number, number] => point !== null);
  const whole = line(0, partial < 0 ? points.length : partial);
  const tail = partial > 0 && points[partial] && points[partial - 1] ? [points[partial - 1]!, points[partial]!] : [];
  const lastKnown = points.reduce((last, point, index) => (point ? index : last), -1);
  const markIndex = points[mark] ? mark : lastKnown;
  const marked = points[markIndex];
  const toPoints = (list: readonly (readonly [number, number])[]) => list.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const stroke = { fill: "none", stroke: "var(--palette-lavender-600)", strokeWidth: 2, strokeLinejoin: "round", strokeLinecap: "round" } as const;
  return (
    <svg width={TREND_WIDTH} height={TREND_HEIGHT} aria-hidden="true" className="block shrink-0" data-testid="members-usage-trend">
      {whole.length > 1 ? <polyline points={toPoints(whole)} {...stroke} /> : null}
      {tail.length === 2 ? <polyline points={toPoints(tail)} {...stroke} strokeDasharray="2 3" data-partial="" /> : null}
      {marked ? (
        <circle
          cx={marked[0]}
          cy={marked[1]}
          r={2.5}
          fill={markIndex === partial ? "none" : "var(--palette-lavender-600)"}
          stroke={markIndex === partial ? "var(--palette-lavender-600)" : "var(--sticker-ink)"}
          strokeWidth={markIndex === partial ? 1.5 : 1}
        />
      ) : null}
    </svg>
  );
}

/**
 * A heading that sorts the list (Raft DS › Table › Sorting, a header row
 * drawn without `Table`, as Computers' RackListHeader): a columnheader with
 * its `aria-sort`, holding a raft-ui TableSortButton.
 */
function SortHeading({ column, label, sort, onSort, className, align }: {
  column: UsageSortKey;
  label: string;
  sort: UsageSort;
  onSort: (sort: UsageSort) => void;
  className: string;
  align?: "right";
}) {
  const tableSort: TableSort | undefined = sort.key === column ? sort.direction : undefined;
  const change = useCallback((direction: TableSort) => onSort({ key: column, direction }), [column, onSort]);
  return (
    <div role="columnheader" aria-sort={tableSort} className={`${className} ${HEADING_LABEL}`} data-testid={`members-usage-sort-${column}`}>
      <TableSortButton sort={tableSort} firstSort={firstUsageSort(column)} align={align} onSortChange={change}>
        <span className="truncate">{label}</span>
      </TableSortButton>
    </div>
  );
}

/**
 * The listed agents together, or with a filter the agents it keeps: the
 * headline, its kinds, and the bars, which pick a day. Filtered, the last
 * fact is the kept agents' share of all of them, and Clear filter goes back.
 */
function UsageSummary({ usage }: { usage: MembersAgentUsageState }) {
  const { formatMessage } = useIntl();
  const { formatShortDateTime } = useTimeFormatter();
  const format = useUsageFormat();
  const [measure, measuredWidth] = useElementWidth();
  const { view, figures, setView, today, setFilter } = usage;
  const pickDay = useCallback((day: string | null) => setView((current) => ({ range: current.range, day })), [setView]);
  const clearFilter = useCallback(() => setFilter([]), [setFilter]);
  if (!figures) return null;
  const { selection } = figures;
  const shown = selection ?? { total: figures.total, totalTokens: figures.totalTokens, reporting: figures.reporting, agents: figures.visible };
  const { total } = shown;
  const { sums, noData } = total;
  const amount = (value: number | null) => (value === null || noData ? format.dash : format.tokens(value));
  const pickedPast = view.day !== null && view.day !== today;
  const cacheShare = noData ? null : cacheShareOfInput(sums);
  const period = view.day === today
    ? formatMessage({ id: "agent.usage.period.today" })
    : view.day ? format.dayName(view.day) : formatMessage({ id: "agent.usage.period.days" }, { count: view.range });
  const kindTerm = (kind: "inputNew" | "cacheWrite" | "cacheRead" | "output", labelId: MessageId) => (
    <span className="inline-flex items-center gap-1.5"><UsageSwatch kind={kind} />{formatMessage({ id: labelId })}</span>
  );
  return (
    <Card className="mx-5 mt-3" data-testid="members-usage-summary">
      <CardContent className="flex flex-wrap items-end gap-x-8 gap-y-4">
        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <SectionEyebrow as="div" className="min-w-0" data-testid="members-usage-summary-heading">
              {formatMessage({ id: selection ? "members.usage.selectedHeading" : "members.usage.summaryHeading" }, { count: shown.agents, period })}
            </SectionEyebrow>
            {selection ? (
              <Button variant="ghost" size="sm" type="button" onClick={clearFilter} data-testid="members-usage-clear-filter">
                <X data-icon="inline-start" />
                {formatMessage({ id: "members.usage.clearFilter" })}
              </Button>
            ) : null}
            <label className="flex shrink-0 cursor-pointer items-center gap-2 text-caption text-foreground-muted">
              <Switch checked={usage.withCacheReads} onCheckedChange={usage.setWithCacheReads} data-testid="members-usage-cache-reads" />
              {formatMessage({ id: "agent.usage.cacheReads" })}
            </label>
          </div>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="font-mono text-title font-bold text-foreground tabular-nums" data-testid="members-usage-total">
              {amount(shown.totalTokens)}
            </span>
            <span className="text-caption text-foreground-muted">
              {formatMessage({ id: usage.withCacheReads ? "members.usage.allTokens" : "members.usage.withoutCacheReads" })}
            </span>
            <UsageChange figures={total} picked={view.day !== null} testId="members-usage-change" />
          </div>
          <DescriptionList className="gap-1" data-testid="members-usage-kinds">
            <UsageFact term={kindTerm("inputNew", "agent.usage.kind.newInput")} testId="members-usage-new-input">
              <span className="font-mono tabular-nums">{amount(sums.inputNew)}</span>
            </UsageFact>
            {sums.cacheWrite !== null ? (
              <UsageFact term={kindTerm("cacheWrite", "agent.usage.kind.cacheWrite")} testId="members-usage-cache-write">
                <span className="font-mono tabular-nums">{amount(sums.cacheWrite)}</span>
              </UsageFact>
            ) : null}
            <UsageFact term={kindTerm("output", "agent.usage.kind.output")} testId="members-usage-output">
              <span className="font-mono tabular-nums">{amount(sums.output)}</span>
              {sums.reasoning !== null && !noData ? (
                <div className="block w-full basis-full text-caption text-foreground-hint">{formatMessage({ id: "agent.usage.reasoning" }, { tokens: format.tokens(sums.reasoning) })}</div>
              ) : null}
            </UsageFact>
            <UsageFact term={kindTerm("cacheRead", "agent.usage.kind.cacheRead")} testId="members-usage-cache-read">
              {sums.cacheRead === null || noData ? <span className="font-mono">{format.dash}</span> : formatMessage({ id: "agent.usage.amountWithShare" }, {
                tokens: <span key="tokens" className="font-mono tabular-nums">{format.tokens(sums.cacheRead)}</span>,
                percent: <span key="percent" className="text-foreground-hint">{cacheShare === null ? format.dash : formatMessage({ id: "agent.usage.cacheShare" }, { percent: format.percent(cacheShare) })}</span>,
              })}
            </UsageFact>
            {selection ? (
              <UsageFact term={formatMessage({ id: "members.usage.column.share" })} testId="members-usage-share-of-total">
                {selection.totalTokens === null || figures.totalTokens === null || figures.totalTokens <= 0 ? <span className="font-mono">{format.dash}</span> : (
                  formatMessage({ id: "members.usage.shareOfTotal" }, {
                    percent: <span key="percent" className="font-mono tabular-nums">{format.percent(selection.totalTokens / figures.totalTokens)}</span>,
                    tokens: <span key="tokens" className="font-mono tabular-nums">{format.tokens(figures.totalTokens)}</span>,
                  })
                )}
              </UsageFact>
            ) : (
              <UsageFact term={formatMessage({ id: "members.usage.reporting" })} testId="members-usage-reporting">
                <span className="font-mono tabular-nums">{figures.reporting}</span>
              </UsageFact>
            )}
          </DescriptionList>
          <span className="flex flex-col font-mono text-mono-meta text-foreground-hint" data-testid="members-usage-freshness">
            {pickedPast ? null : <span>{formatMessage({ id: "agent.usage.asOf" }, { time: formatShortDateTime(total.asOf) })}</span>}
            {total.since && (total.days[0]?.day ?? today) < total.since ? (
              <span data-testid="members-usage-since">{formatMessage({ id: "agent.usage.since" }, { date: format.dayName(total.since) })}</span>
            ) : null}
          </span>
        </div>
        <div ref={measure} className="min-w-[280px] flex-1">
          <AgentUsageDayBars
            days={total.days}
            withCacheReads={usage.withCacheReads}
            width={measuredWidth || CHART_FALLBACK_WIDTH}
            selected={view.day}
            onSelect={pickDay}
            formatTokens={format.tokens}
          />
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * The Agents tab's body in the usage view: the summary, then the page's
 * groups with only the agents the server answered for, each sorted, their
 * rows opening the agent's Usage tab.
 */
export function MembersAgentUsageBody({ usage, groups, heading, openKey, onOpen }: {
  usage: MembersAgentUsageState;
  groups: readonly MemberGroup[];
  heading: (group: MemberGroup) => ReactNode;
  openKey: string | null;
  onOpen: (entry: MemberEntry) => void;
}) {
  const { formatMessage } = useIntl();
  const { load, figures } = usage;

  if (load.kind === "error") {
    return (
      <div className="px-5 pt-3">
        <Banner
          intent="warning"
          density="sm"
          actions={(
            <Button variant="outline" size="md" type="button" onClick={usage.retry}>
              <RefreshCw size={16} />
              {formatMessage({ id: "agent.usage.retry" })}
            </Button>
          )}
          data-testid="members-usage-error"
        >
          {formatMessage({ id: "agent.usage.loadFailed" })}
        </Banner>
      </div>
    );
  }
  if (!figures) {
    return (
      <section aria-busy="true" data-testid="members-usage-loading">
        <AfterSkeletonDelay>
          <ListRowGroup className="mx-5 mt-4">
            {Array.from({ length: 6 }, (_, index) => <AgentRowSkeleton key={index} />)}
          </ListRowGroup>
        </AfterSkeletonDelay>
      </section>
    );
  }
  if (usage.one) {
    return <div data-testid="members-usage-view"><MembersAgentUsageOne usage={usage} agent={usage.one} /></div>;
  }
  return <UsageList usage={usage} figures={figures} groups={groups} heading={heading} openKey={openKey} onOpen={onOpen} />;
}

function UsageList({ usage, figures, groups, heading, openKey, onOpen }: {
  usage: MembersAgentUsageState;
  figures: MembersAgentUsage;
  groups: readonly MemberGroup[];
  heading: (group: MemberGroup) => ReactNode;
  openKey: string | null;
  onOpen: (entry: MemberEntry) => void;
}) {
  const { formatMessage, locale } = useIntl();
  const format = useUsageFormat();
  const { view, sort, setSort, today } = usage;
  const labels = useMemo(() => ({
    agent: formatMessage({ id: "members.usage.column.agent" }),
    tokens: formatMessage({ id: "members.usage.column.tokens" }),
    share: formatMessage({ id: "members.usage.column.share" }),
    perTurn: formatMessage({ id: "agent.usage.perTurn" }),
    context: formatMessage({ id: "agent.usage.context" }),
    change: formatMessage({ id: view.day ? "members.usage.column.vsDay" : "members.usage.column.vsPrior" }),
  }), [formatMessage, view.day]);

  const headings = (
    <>
      <SortHeading column="tokens" label={labels.tokens} sort={sort} onSort={setSort} className={COL.tokens} align="right" />
      <SortHeading column="share" label={labels.share} sort={sort} onSort={setSort} className={COL.share} align="right" />
      <SortHeading column="perTurn" label={labels.perTurn} sort={sort} onSort={setSort} className={COL.perTurn} align="right" />
      <SortHeading column="context" label={labels.context} sort={sort} onSort={setSort} className={COL.context} align="right" />
      <SortHeading column="change" label={labels.change} sort={sort} onSort={setSort} className={COL.change} align="right" />
      <span role="columnheader" className={`${COL.trend} ${HEADING_LABEL}`}>{formatMessage({ id: "agent.usage.period.days" }, { count: view.range })}</span>
    </>
  );

  // Each agent's cells, built once per answer, period and sort-independent
  // state; every cell names its column for a screen reader (the rows are
  // buttons, outside the headings' table).
  const rowUsage = useMemo(() => {
    const pickedPast = view.day !== null && view.day !== today;
    const markIndex = view.day ? figures.total.days.findIndex((day) => day.day === view.day) : figures.total.days.length - 1;
    const partialIndex = figures.total.days.findIndex((day) => day.partial);
    const cell = (className: string, label: string, value: ReactNode, testId: string, title?: string) => (
      <span className={`${className} ${CELL}`} data-testid={testId}>
        <span className="sr-only">{label}</span>
        <ListRowMeta className="tabular-nums" title={title} data-value="">{value}</ListRowMeta>
      </span>
    );
    const byAgent = new Map<string, AgentRowUsage>();
    for (const [agentId, row] of figures.rows) {
      const share = row.tokens !== null && figures.totalTokens !== null && figures.totalTokens > 0 ? row.tokens / figures.totalTokens : null;
      byAgent.set(agentId, {
        cells: (
          <>
            <span className={`${COL.tokens} ${CELL}`} data-testid="members-usage-tokens">
              <span className="sr-only">{labels.tokens}</span>
              <span className="font-mono text-mono-meta text-foreground tabular-nums" data-value="">{row.tokens === null ? format.dash : format.tokens(row.tokens)}</span>
            </span>
            {cell(COL.share, labels.share, share === null ? format.dash : format.percent(share), "members-usage-share", formatMessage({ id: "members.usage.shareTitle" }))}
            {cell(COL.perTurn, labels.perTurn, row.perTurn === null ? format.dash : format.tokens(row.perTurn), "members-usage-per-turn")}
            {cell(
              COL.context,
              labels.context,
              row.context ? format.percent(row.context.used / row.context.window, 0) : format.dash,
              "members-usage-context",
              row.context
                ? formatMessage({ id: "members.usage.contextTitle" }, { used: format.tokens(row.context.used), window: format.tokens(row.context.window) })
                : pickedPast ? formatMessage({ id: "members.usage.contextLatestOnly" }) : undefined,
            )}
            <span className={`${COL.change} ${CELL} gap-1`} data-testid="members-usage-change-cell">
              <span className="sr-only">{labels.change}</span>
              {row.change === null ? null : row.change >= 0
                ? <ArrowUpRight className="size-3 shrink-0 text-foreground-muted" aria-hidden="true" />
                : <ArrowDownRight className="size-3 shrink-0 text-foreground-muted" aria-hidden="true" />}
              <ListRowMeta className="text-foreground tabular-nums" data-value="">
                {row.change === null ? format.dash : format.change(row.change)}
              </ListRowMeta>
            </span>
            <span className={`${COL.trend} ${CELL}`}><Trend values={row.trend} mark={markIndex} partial={partialIndex} /></span>
          </>
        ),
        // The server can't tell an agent that hasn't run since usage began
        // from one whose Computer doesn't send it, nor can the page (no
        // Computer version says it): "No usage yet", not "Update".
        note: row.hasUsage ? null : (
          <ListRowMeta data-testid="members-usage-no-usage">{formatMessage({ id: "members.usage.noUsageYet" })}</ListRowMeta>
        ),
      });
    }
    return { row: (agentId: string) => byAgent.get(agentId)! };
  }, [figures, format, formatMessage, labels, today, view.day]);

  // Only the listed agents the server answered for (and the filter keeps),
  // each group sorted; a group's heading counts the rows it shows.
  const { selected } = usage;
  const shown = useMemo(() => groups
    .map((group) => {
      const kept = group.entries.filter((entry) => figures.rows.has(entry.id) && (!selected || selected.has(entry.id)));
      return { ...group, entries: sortUsageEntries(kept, figures.rows, sort, locale) };
    })
    .filter((group) => group.entries.length > 0), [figures.rows, groups, locale, selected, sort]);

  return (
    <div data-testid="members-usage-view">
      <UsageSummary usage={usage} />
      <MembersAgentUsageHeadings
        label={formatMessage({ id: "members.usage.tableLabel" })}
        name={<SortHeading column="name" label={labels.agent} sort={sort} onSort={setSort} className="flex max-w-full" />}
        headings={headings}
      />
      {shown.map((group) => (
        <MembersAgentGroup
          key={group.key}
          heading={heading(group)}
          entries={group.entries}
          machinesById={EMPTY_MACHINES}
          showComputer={false}
          showColumnHeadings={false}
          openKey={openKey}
          usage={rowUsage}
          onOpen={onOpen}
        />
      ))}
      <p className="mx-5 mt-3 font-mono text-mono-meta text-foreground-hint" data-testid="members-usage-footnote">
        {formatMessage({ id: "members.usage.footnote" }, { count: figures.visible })}
      </p>
    </div>
  );
}

const EMPTY_MACHINES: ReadonlyMap<string, Machine> = new Map<string, Machine>();
