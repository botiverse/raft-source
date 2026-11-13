import { useCallback, useMemo } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { Button, Card, Switch } from "@botiverse/raft-ui";
import { X } from "lucide-react";
import AvatarSlot from "../../components/ui/AvatarSlot";
import SectionEyebrow from "../../components/ui/SectionEyebrow";
import type { Agent } from "../../store/agentStore";
import { AgentUsageDayBars } from "../agent/AgentUsageDayBars";
import {
  AgentUsageContext,
  AgentUsageFreshness,
  AgentUsageHeadline,
  AgentUsageModels,
  AgentUsageNoFigures,
  AgentUsageTokenTypes,
} from "../agent/AgentUsageSections";
import { summarizeAgentUsage } from "../agent/agentUsage";
import { useElementWidth, useUsageFormat } from "../agent/agentUsageHooks";
import { agentRuntimeFacts } from "./memberEntryFacts";
import { useRuntimeDeprecatedHere } from "../../hooks/useServerRuntimeCatalog";
import type { MembersAgentUsageState } from "./useMembersAgentUsage";

// Members › Agents › Usage with exactly one agent in the filter (#proj-o11y:#36,
// v5 mock): that agent's usage at the page's width, the panel's Usage tab
// laid out wide (the same parts, AgentUsageSections) from the view's one
// answer: no read of its own. The list hides (it would be one row); All
// agents clears the filter.

const CHART_FALLBACK_WIDTH = 480;

function Block({ title, children, testId }: { title: ReactNode; children: ReactNode; testId?: string }) {
  return (
    <section className="min-w-0 px-4 py-4" data-testid={testId}>
      <SectionEyebrow as="div" className="mb-3 truncate">{title}</SectionEyebrow>
      {children}
    </section>
  );
}

export function MembersAgentUsageOne({ usage, agent }: { usage: MembersAgentUsageState; agent: Agent }) {
  const { formatMessage } = useIntl();
  const format = useUsageFormat();
  const deprecatedHere = useRuntimeDeprecatedHere();
  const [measure, measuredWidth] = useElementWidth();
  const { load, view, setView, today, withCacheReads, setFilter } = usage;
  const summary = useMemo(
    () => (load.kind === "ready" ? summarizeAgentUsage(load.response, agent.id, view, withCacheReads) : null),
    [agent.id, load, view, withCacheReads],
  );
  const pickDay = useCallback((day: string | null) => setView((current) => ({ range: current.range, day })), [setView]);
  const clear = useCallback(() => setFilter([]), [setFilter]);
  if (!summary) return null;

  const { runtime, model } = agentRuntimeFacts(agent, formatMessage, deprecatedHere);
  const name = agent.displayName || agent.name;
  const pickedPast = view.day !== null && view.day !== today;
  const period = view.day === today
    ? formatMessage({ id: "agent.usage.period.today" })
    : view.day ? format.dayName(view.day) : formatMessage({ id: "agent.usage.period.days" }, { count: view.range });
  const heading = (labelId: "agent.usage.tokenTypes" | "agent.usage.context" | "agent.usage.models") => (
    view.day
      ? formatMessage({ id: "agent.usage.headingOnDay" }, { day: format.dayName(view.day), heading: formatMessage({ id: labelId }) })
      : formatMessage({ id: labelId })
  );

  return (
    <Card className="@container/usage-agent mx-5 mt-3 gap-0 p-0" data-testid="members-usage-agent" data-agent-id={agent.id}>
      <div className="flex flex-wrap items-center gap-3 border-b border-line-hairline px-4 py-3">
        <AvatarSlot context="list-row" type="agent" agentAvatarUrl={agent.avatarUrl} />
        <div className="min-w-0">
          <div className="truncate text-subhead font-bold text-foreground" data-testid="members-usage-agent-name">{name}</div>
          <div className="truncate font-mono text-mono-meta text-foreground-hint">
            {[`@${agent.name}`, model, runtime].filter(Boolean).join(" · ")}
          </div>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-3">
          <label className="flex cursor-pointer items-center gap-2 text-caption text-foreground-muted">
            <Switch checked={withCacheReads} onCheckedChange={usage.setWithCacheReads} data-testid="members-usage-cache-reads" />
            {formatMessage({ id: "agent.usage.cacheReads" })}
          </label>
          <Button
            variant="ghost"
            size="sm"
            type="button"
            onClick={clear}
            aria-label={formatMessage({ id: "members.usage.backToAll" })}
            data-testid="members-usage-all-agents"
          >
            <X data-icon="inline-start" />
            {formatMessage({ id: "members.usage.allAgents" })}
          </Button>
        </div>
      </div>
      {summary.kind !== "ready" ? (
        <div className="flex min-h-[240px] flex-col">
          <AgentUsageNoFigures kind={summary.kind} agentId={agent.id} range={view.range} />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-x-8 @[720px]/usage-agent:grid-cols-[minmax(0,1fr)_320px]">
            <Block title={period} testId="members-usage-agent-tokens">
              <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <AgentUsageHeadline summary={summary} view={view} withCacheReads={withCacheReads}>
                  <span className="text-caption text-foreground-muted">
                    {formatMessage({ id: withCacheReads ? "members.usage.allTokens" : "members.usage.withoutCacheReads" })}
                  </span>
                </AgentUsageHeadline>
                <AgentUsageFreshness summary={summary} view={view} today={today} className="flex flex-col items-end" />
              </div>
              <div ref={measure} className="min-w-0">
                <AgentUsageDayBars
                  days={summary.days}
                  withCacheReads={withCacheReads}
                  width={measuredWidth || CHART_FALLBACK_WIDTH}
                  selected={view.day}
                  onSelect={pickDay}
                  formatTokens={format.tokens}
                />
              </div>
            </Block>
            <Block title={heading("agent.usage.tokenTypes")}>
              <AgentUsageTokenTypes summary={summary} />
            </Block>
          </div>
          <div className="grid grid-cols-1 gap-x-8 border-t border-line-hairline @[720px]/usage-agent:grid-cols-[minmax(0,1fr)_320px]">
            <Block title={heading("agent.usage.context")}>
              <AgentUsageContext summary={summary} pickedPast={pickedPast} />
            </Block>
            <Block title={heading("agent.usage.models")}>
              <AgentUsageModels summary={summary} />
            </Block>
          </div>
        </>
      )}
    </Card>
  );
}
