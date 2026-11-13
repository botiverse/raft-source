import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { Button, DescriptionList } from "@botiverse/raft-ui";
import { Meter, MeterHeader, MeterIndicator, MeterLabel, MeterTrack, MeterValue } from "@botiverse/raft-ui/wip";
import { getModelLabel, getRuntimeDisplayName } from "@botiverse/raft-shared";
import { ChartColumn } from "lucide-react";
import EmptyState from "../../components/ui/EmptyState";
import { useOpenAgentComputer } from "../../components/agent/useOpenAgentComputer";
import { useTimeFormatter } from "../../hooks/useTimeFormatter";
import { UsageSwatch } from "./AgentUsageDayBars";
import { cacheShareOfInput, chartTokens, tokensPerTurn, totalTokens } from "./agentUsage";
import type { AgentUsageRange, AgentUsageSummary, AgentUsageView } from "./agentUsage";
import { UsageChange, UsageFact as Fact } from "./AgentUsageParts";
import { useUsageFormat } from "./agentUsageHooks";

// One agent's usage figures, drawn alike by the agent panel's Usage tab and
// the one-agent view of Members › Agents › Usage (#proj-o11y:#36): the
// headline, freshness, token types, context and models of a summary, and
// what shows instead when there are none. Each lays out only itself; the
// surface places them (the panel in one column, Members wide).

export type ReadyUsageSummary = Extract<AgentUsageSummary, { kind: "ready" }>;

/** "As of …" (not for a past day: the context is the latest only), and "Usage since …" when the data starts inside the range. */
export function AgentUsageFreshness({ summary, view, today, className }: {
  summary: ReadyUsageSummary;
  view: AgentUsageView;
  today: string;
  className: string;
}) {
  const { formatMessage } = useIntl();
  const { formatShortDateTime } = useTimeFormatter();
  const { dayName } = useUsageFormat();
  const pickedPast = view.day !== null && view.day !== today;
  const firstDay = summary.days[0]?.day ?? today;
  return (
    <span className={`font-mono text-mono-meta text-foreground-hint ${className}`} data-testid="agent-usage-freshness">
      {pickedPast ? null : <span>{formatMessage({ id: "agent.usage.asOf" }, { time: formatShortDateTime(summary.asOf) })}</span>}
      {summary.since && firstDay < summary.since ? (
        <span data-testid="agent-usage-since">{formatMessage({ id: "agent.usage.since" }, { date: dayName(summary.since) })}</span>
      ) : null}
    </span>
  );
}

/** The period's tokens as the bars count them, and the change against before. */
export function AgentUsageHeadline({ summary, view, withCacheReads, children }: {
  summary: ReadyUsageSummary;
  view: AgentUsageView;
  withCacheReads: boolean;
  /** Between the figure and the change: what the figure counts, where the surface says it. */
  children?: ReactNode;
}) {
  const { dash, tokens } = useUsageFormat();
  const headline = chartTokens(summary.sums, withCacheReads);
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <span className="font-mono text-title font-bold text-foreground tabular-nums" data-testid="agent-usage-headline">
        {summary.noData || headline === null ? dash : tokens(headline)}
      </span>
      {children}
      <UsageChange figures={summary} picked={view.day !== null} testId="agent-usage-change" />
    </div>
  );
}

type KindLabelId = "agent.usage.kind.newInput" | "agent.usage.kind.cacheWrite" | "agent.usage.kind.cacheRead" | "agent.usage.kind.output";

/** Each kind with its share of all tokens, reasoning inside output, and the total. */
export function AgentUsageTokenTypes({ summary }: { summary: ReadyUsageSummary }) {
  const { formatMessage } = useIntl();
  const { dash, tokens: formatTokens, percent: formatPercent } = useUsageFormat();
  const { sums, noData } = summary;
  const total = totalTokens(sums);
  const withShare = (value: number | null) => (value === null || noData ? <span className="font-mono">{dash}</span> : (
    formatMessage({ id: "agent.usage.amountWithShare" }, {
      tokens: <span key="tokens" className="font-mono tabular-nums">{formatTokens(value)}</span>,
      percent: <span key="percent" className="text-foreground-hint">{formatPercent(total !== null && total > 0 ? value / total : 0)}</span>,
    })
  ));
  const kindTerm = (kind: "inputNew" | "cacheWrite" | "cacheRead" | "output", labelId: KindLabelId) => (
    <span className="inline-flex items-center gap-1.5"><UsageSwatch kind={kind} />{formatMessage({ id: labelId })}</span>
  );
  return (
    <DescriptionList className="gap-2" data-testid="agent-usage-token-types">
      <Fact term={kindTerm("inputNew", "agent.usage.kind.newInput")} testId="agent-usage-new-input">{withShare(sums.inputNew)}</Fact>
      {sums.cacheWrite !== null ? (
        <Fact term={kindTerm("cacheWrite", "agent.usage.kind.cacheWrite")} testId="agent-usage-cache-write">{withShare(sums.cacheWrite)}</Fact>
      ) : null}
      <Fact term={kindTerm("cacheRead", "agent.usage.kind.cacheRead")} testId="agent-usage-cache-read">{withShare(sums.cacheRead)}</Fact>
      <Fact term={kindTerm("output", "agent.usage.kind.output")} testId="agent-usage-output">
        {withShare(sums.output)}
        {sums.reasoning !== null && !noData ? (
          <div className="block w-full basis-full text-caption text-foreground-hint" data-testid="agent-usage-reasoning">
            {formatMessage({ id: "agent.usage.reasoning" }, { tokens: formatTokens(sums.reasoning) })}
          </div>
        ) : null}
      </Fact>
      <Fact term={formatMessage({ id: "agent.usage.total" })} testId="agent-usage-total">
        <span className="font-mono font-bold tabular-nums">{noData || total === null ? dash : formatTokens(total)}</span>
      </Fact>
    </DescriptionList>
  );
}

/** Cache reads' share of input, tokens per turn, and the context window (the latest reading: not for a past day). */
export function AgentUsageContext({ summary, pickedPast }: { summary: ReadyUsageSummary; pickedPast: boolean }) {
  const { formatMessage } = useIntl();
  const { dash, tokens: formatTokens, percent: formatPercent } = useUsageFormat();
  const { sums, noData } = summary;
  const share = noData ? null : cacheShareOfInput(sums);
  const perTurn = noData ? null : tokensPerTurn(sums);
  const context = pickedPast ? null : summary.context;
  return (
    <>
      <DescriptionList className="gap-2">
        <Fact term={formatMessage({ id: "agent.usage.cacheReads" })} testId="agent-usage-cache-share">
          {share === null ? <span className="font-mono">{dash}</span> : formatMessage({ id: "agent.usage.cacheShare" }, { percent: formatPercent(share) })}
        </Fact>
        <Fact term={formatMessage({ id: "agent.usage.perTurn" })} testId="agent-usage-per-turn">
          {perTurn === null ? <span className="font-mono">{dash}</span> : formatMessage({ id: "agent.usage.perTurnValue" }, { tokens: formatTokens(perTurn), turns: sums.turns })}
        </Fact>
        {context ? null : (
          <Fact term={formatMessage({ id: "agent.usage.contextWindow" })} testId="agent-usage-context-window">
            <span className="font-mono">{dash}</span>
          </Fact>
        )}
      </DescriptionList>
      {context ? (
        <Meter
          size="md"
          used={context.used}
          max={context.window}
          valueText={formatMessage({ id: "agent.usage.contextUsed" }, { percent: formatPercent(context.used / context.window, 0) })}
          className="mt-3"
          data-testid="agent-usage-context-meter"
        >
          <MeterHeader>
            <MeterLabel>{formatMessage({ id: "agent.usage.contextWindow" })}</MeterLabel>
            <MeterValue />
          </MeterHeader>
          <MeterTrack><MeterIndicator /></MeterTrack>
        </Meter>
      ) : null}
    </>
  );
}

/** The models the turns ran on, most tokens first, with their share. */
export function AgentUsageModels({ summary }: { summary: ReadyUsageSummary }) {
  const { formatMessage } = useIntl();
  const { dash, tokens: formatTokens, percent: formatPercent } = useUsageFormat();
  if (summary.models.length === 0 || summary.noData) {
    return <span className="font-mono text-callout text-foreground-hint">{dash}</span>;
  }
  const modelsTotal = summary.models.reduce((sum, model) => sum + (model.tokens ?? 0), 0);
  return (
    <div className="flex flex-col gap-2.5" data-testid="agent-usage-models">
      {summary.models.map((model) => (
        <div key={`${model.runtime}:${model.model}`} className="flex min-w-0 items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="truncate text-callout font-semibold text-foreground">
              {model.model ? getModelLabel(model.runtime ?? "", model.model) : formatMessage({ id: "agent.usage.unknownModel" })}
            </div>
            <div className="truncate font-mono text-mono-meta text-foreground-hint">{model.runtime ? getRuntimeDisplayName(model.runtime) : dash}</div>
          </div>
          <span className="font-mono text-mono-meta text-foreground-muted tabular-nums">{model.tokens === null ? dash : formatTokens(model.tokens)}</span>
          <span className="w-12 text-right font-mono text-mono-meta text-foreground tabular-nums">
            {model.tokens === null ? dash : formatPercent(modelsTotal > 0 ? model.tokens / modelsTotal : 0, 0)}
          </span>
        </div>
      ))}
    </div>
  );
}

/** No figures to draw: the agent's Computer sends no usage (Update, with a way to it), or the range has none. */
export function AgentUsageNoFigures({ kind, agentId, range }: { kind: "unsupported" | "empty"; agentId: string; range: AgentUsageRange }) {
  const { formatMessage } = useIntl();
  const { open: openComputer } = useOpenAgentComputer(agentId);
  if (kind === "unsupported") {
    return (
      <EmptyState
        className="flex flex-1 flex-col items-center justify-center"
        icon={<ChartColumn size={36} />}
        title={formatMessage({ id: "agent.usage.updateComputer" })}
        action={openComputer ? (
          <Button variant="outline" size="md" type="button" onClick={openComputer}>
            {formatMessage({ id: "agent.usage.openComputer" })}
          </Button>
        ) : undefined}
        data-testid="agent-usage-unsupported"
      />
    );
  }
  return (
    <EmptyState
      className="flex flex-1 flex-col items-center justify-center"
      icon={<ChartColumn size={36} />}
      title={formatMessage({ id: "agent.usage.empty" }, { count: range })}
      data-testid="agent-usage-empty"
    />
  );
}
