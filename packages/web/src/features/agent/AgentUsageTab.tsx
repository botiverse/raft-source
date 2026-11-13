import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import {
  Button,
  ScrollArea,
  Skeleton,
  Switch,
} from "@botiverse/raft-ui";
import { currentTimeMs } from "@botiverse/raft-shared";
import { RefreshCw } from "lucide-react";
import Banner from "../../components/ui/Banner";
import SectionEyebrow from "../../components/ui/SectionEyebrow";
import { AgentUsageDayBars } from "./AgentUsageDayBars";
import { summarizeAgentUsage, utcDay } from "./agentUsage";
import type { AgentUsageView } from "./agentUsage";
import { AgentUsagePeriodSelect } from "./AgentUsageParts";
import {
  AgentUsageContext,
  AgentUsageFreshness,
  AgentUsageHeadline,
  AgentUsageModels,
  AgentUsageNoFigures,
  AgentUsageTokenTypes,
} from "./AgentUsageSections";
import { useElementWidth, useUsageFormat } from "./agentUsageHooks";
import { useAgentUsage } from "./useAgentUsage";

// The agent panel's Usage tab (#proj-o11y:#36 step 1, v5 mock approved by
// Artea): a time range, the daily bars (cache reads off by default), then the
// figures for the range or a picked day: token types, context, models.

const CHART_FALLBACK_WIDTH = 360;
const SKELETON_DELAY_MS = 1000;

function Section({ title, aside, children }: { title: ReactNode; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="border-t border-line-hairline px-(--surface-inset) py-4 first:border-t-0">
      <div className="mb-3 flex min-w-0 items-baseline justify-between gap-2">
        <SectionEyebrow as="div" className="min-w-0 truncate">{title}</SectionEyebrow>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** The loading skeleton, drawn only once the wait passes a second (DS Feedback). Mounted only while loading. */
function UsageSkeleton() {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setShown(true), SKELETON_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);
  if (!shown) return null;
  return (
    <div className="flex flex-col gap-3 px-(--surface-inset) py-4" data-testid="agent-usage-skeleton">
      <Skeleton variant="line" className="w-24" />
      <Skeleton className="h-[132px] w-full" />
    </div>
  );
}

export function AgentUsageTab({ agentId }: { agentId: string }) {
  const { formatMessage } = useIntl();
  const [view, setView] = useState<AgentUsageView>({ range: 7, day: null });
  const [withCacheReads, setWithCacheReads] = useState(false);
  const { load, retry } = useAgentUsage(agentId, view.range);
  const [measure, measuredWidth] = useElementWidth();
  const format = useUsageFormat();
  const { tokens: formatTokens, dayName } = format;

  const today = load.kind === "ready" ? load.response.to : utcDay(currentTimeMs());
  const summary = useMemo(
    () => (load.kind === "ready" ? summarizeAgentUsage(load.response, agentId, view, withCacheReads) : null),
    [agentId, load, view, withCacheReads],
  );
  const pickDay = useCallback((day: string | null) => setView((current) => ({ range: current.range, day })), []);

  const controls = (
    <div className="flex items-center justify-between gap-2 px-(--surface-inset) pt-4 pb-1">
      <AgentUsagePeriodSelect view={view} today={today} onChange={setView} testId="agent-usage-period" />
      <label className="flex shrink-0 cursor-pointer items-center gap-2 text-caption text-foreground-muted">
        <Switch checked={withCacheReads} onCheckedChange={setWithCacheReads} data-testid="agent-usage-cache-reads" />
        {formatMessage({ id: "agent.usage.cacheReads" })}
      </label>
    </div>
  );

  let body: ReactNode;
  if (load.kind === "error") {
    body = (
      <div className="px-(--surface-inset) py-4">
        <Banner
          intent="warning"
          density="sm"
          actions={(
            <Button variant="outline" size="md" type="button" onClick={retry}>
              <RefreshCw size={16} />
              {formatMessage({ id: "agent.usage.retry" })}
            </Button>
          )}
        >
          {formatMessage({ id: "agent.usage.loadFailed" })}
        </Banner>
      </div>
    );
  } else if (!summary) {
    body = <UsageSkeleton />;
  } else if (summary.kind !== "ready") {
    body = <AgentUsageNoFigures kind={summary.kind} agentId={agentId} range={view.range} />;
  } else {
    const pickedPast = view.day !== null && view.day !== today;
    const heading = (labelId: "agent.usage.tokens" | "agent.usage.tokenTypes" | "agent.usage.context" | "agent.usage.models") => (
      view.day
        ? formatMessage({ id: "agent.usage.headingOnDay" }, { day: dayName(view.day), heading: formatMessage({ id: labelId }) })
        : formatMessage({ id: labelId })
    );

    body = (
      <>
        <Section
          title={heading("agent.usage.tokens")}
          aside={<AgentUsageFreshness summary={summary} view={view} today={today} className="flex shrink-0 flex-col items-end" />}
        >
          <div className="mb-3">
            <AgentUsageHeadline summary={summary} view={view} withCacheReads={withCacheReads} />
          </div>
          <div ref={measure} className="min-w-0">
            <AgentUsageDayBars
              days={summary.days}
              withCacheReads={withCacheReads}
              width={measuredWidth || CHART_FALLBACK_WIDTH}
              selected={view.day}
              onSelect={pickDay}
              formatTokens={formatTokens}
            />
          </div>
        </Section>

        <Section title={heading("agent.usage.tokenTypes")}>
          <AgentUsageTokenTypes summary={summary} />
        </Section>

        <Section title={heading("agent.usage.context")}>
          <AgentUsageContext summary={summary} pickedPast={pickedPast} />
        </Section>

        <Section title={heading("agent.usage.models")}>
          <AgentUsageModels summary={summary} />
        </Section>
      </>
    );
  }

  return (
    <ScrollArea
      role="region"
      aria-label={formatMessage({ id: "agent.detail.tab.usage" })}
      aria-busy={load.kind === "loading"}
      className="flex-1 bg-layer-canvas"
      contentClassName="flex min-h-full flex-col"
      data-testid="agent-usage-tab"
    >
      {controls}
      {body}
    </ScrollArea>
  );
}
