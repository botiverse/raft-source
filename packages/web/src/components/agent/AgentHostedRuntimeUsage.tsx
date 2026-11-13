import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { DescriptionDetails, DescriptionItem, DescriptionList, DescriptionTerm, Separator, Spinner } from "@botiverse/raft-ui";
import api from "../../api/client";
import SectionEyebrow from "../ui/SectionEyebrow";
import { formatRelativeTime } from "../../utils/relativeTime";
import { formatUsdAmount } from "../../utils/usdAmount";
import { useTimeFormatter } from "../../hooks/useTimeFormatter";
import { hostedRuntimeUsagePath, hostedRuntimeUsageWindow, summarizeHostedRuntimeUsage } from "./hostedRuntimeUsage";
import type { HostedRuntimeUsageResponse } from "./hostedRuntimeUsage";

type LoadState =
  | { kind: "loading" }
  | { kind: "hidden" }
  | { kind: "error" }
  | { kind: "ready"; usage: HostedRuntimeUsageResponse };

/** One fact of the DS PropertyList (raft-ui DescriptionList, horizontal): label in ink-3, value in ink. */
function UsageRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <DescriptionItem>
      <DescriptionTerm>{label}</DescriptionTerm>
      <DescriptionDetails>
        <div className="min-w-0 py-1.5 tabular-nums">{children}</div>
      </DescriptionDetails>
    </DescriptionItem>
  );
}

/** A two-column grid of machine facts inside one value (dates, amounts, token counts). */
const FACT_GRID_CLASS = "grid grid-cols-[auto_auto] items-baseline justify-start gap-x-3 gap-y-0.5 text-caption";

/**
 * Last-7-days usage of a hosted (provider-backed) agent: USD by UTC day when
 * the provider prices it, tokens by kind summed across models, tool calls and
 * the top models. Hidden when the agent is not
 * hosted or the caller may not see it (4xx); a warning on provider failures.
 */
export function AgentHostedRuntimeUsage({ agentId }: { agentId: string }) {
  const intl = useIntl();
  const { formatMessage, formatNumber, formatDate } = intl;
  const formatUsd = (usd: number) => formatUsdAmount(intl, usd);
  const { formatShortDateTime } = useTimeFormatter();
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    // Keyed by agent at the call site, so the state starts as loading per agent.
    let cancelled = false;
    const { from, to } = hostedRuntimeUsageWindow(new Date());
    api.get<HostedRuntimeUsageResponse>(hostedRuntimeUsagePath(agentId), {
      params: { from, to, bucket: "1d" },
    }).then(({ data }) => {
      if (!cancelled) setState({ kind: "ready", usage: data });
    }).catch((err: unknown) => {
      if (cancelled) return;
      const status = (err as { response?: { status?: number } }).response?.status;
      setState(status && status < 500 && status !== 429 && status !== 400 ? { kind: "hidden" } : { kind: "error" });
    });
    return () => { cancelled = true; };
  }, [agentId]);

  const summary = useMemo(
    () => state.kind === "ready" ? summarizeHostedRuntimeUsage(state.usage.rows) : null,
    [state],
  );

  if (state.kind === "hidden") return null;
  return (
    <>
    <Separator />
    <div className="px-(--surface-inset) py-4" data-testid="agent-hosted-runtime-usage">
      <SectionEyebrow as="div" className="mb-2">
        {formatMessage({ id: "agent.detail.usage.title" })}
      </SectionEyebrow>
      {state.kind === "loading" ? (
        <Spinner size="xs" aria-label={formatMessage({ id: "agent.workspace.loading" })} />
      ) : state.kind === "error" ? (
        <p className="text-footnote font-semibold text-warning-strong">
          {formatMessage({ id: "agent.detail.usage.loadFailed" })}
        </p>
      ) : summary && !summary.hasUsage ? (
        <p className="text-callout text-foreground-hint">
          {formatMessage({ id: "agent.detail.usage.empty" })}
        </p>
      ) : summary ? (
        // Labels stack over values by the list's own width (raft-ui 0.23's
        // horizontal list is its own container), so a 320px profile panel on
        // a wide window stacks long labels (es: "Tokens de razonamiento").
        <DescriptionList direction="horizontal">
          {summary.cost && (
            <UsageRow label={formatMessage({ id: "agent.detail.usage.cost" })}>
              <div className={FACT_GRID_CLASS} data-testid="agent-hosted-runtime-cost">
                {summary.cost.days.map((day) => (
                  <div key={day.day} className="contents">
                    <span className="font-mono text-mono-meta text-foreground-hint">
                      {formatDate(`${day.day}T00:00:00Z`, { month: "short", day: "numeric", timeZone: "UTC" })}
                    </span>
                    <span className="font-mono text-mono-meta text-foreground">
                      {day.priced ? formatUsd(day.usd) : formatMessage({ id: "agent.detail.usage.cost.unpriced" })}
                    </span>
                  </div>
                ))}
                <span className="text-foreground-hint">{formatMessage({ id: "agent.detail.usage.cost.total" })}</span>
                <span className="font-mono text-mono-meta font-bold text-foreground">
                  {summary.cost.priced ? formatUsd(summary.cost.totalUsd) : formatMessage({ id: "agent.detail.usage.cost.unpriced" })}
                </span>
              </div>
              {summary.cost.hasUnpriced && (
                <p className="mt-1 text-caption text-foreground-hint">
                  {formatMessage({ id: "agent.detail.usage.cost.includesUnpriced" })}
                </p>
              )}
              <p className="mt-1 text-caption text-foreground-hint">
                {formatMessage({ id: "agent.detail.usage.cost.note" })}
              </p>
            </UsageRow>
          )}
          <UsageRow label={formatMessage({ id: "agent.detail.usage.tokens" })}>
            <div className={FACT_GRID_CLASS}>
              {([
                ["agent.detail.usage.tokens.input", summary.tokens.input],
                ["agent.detail.usage.tokens.output", summary.tokens.output],
                ["agent.detail.usage.tokens.reasoning", summary.tokens.reasoning],
                ["agent.detail.usage.tokens.cacheRead", summary.tokens.cacheRead],
                ["agent.detail.usage.tokens.cacheWrite", summary.tokens.cacheWrite],
                ["agent.detail.usage.tokens.total", summary.tokens.total],
              ] as const).map(([labelId, value]) => (
                <div key={labelId} className="contents">
                  <span className="text-foreground-hint">{formatMessage({ id: labelId })}</span>
                  <span className="font-mono text-mono-meta text-foreground">{formatNumber(value)}</span>
                </div>
              ))}
            </div>
          </UsageRow>
          <UsageRow label={formatMessage({ id: "agent.detail.usage.toolCalls" })}>
            {formatMessage(
              { id: "agent.detail.usage.toolCallsValue" },
              {
                total: formatNumber(summary.toolCalls.total),
                succeeded: formatNumber(summary.toolCalls.succeeded),
                failed: formatNumber(summary.toolCalls.failed),
              },
            )}
          </UsageRow>
          {summary.topModels.length > 0 && (
            <UsageRow label={formatMessage({ id: "agent.detail.usage.topModels" })}>
              <ul className="m-0 list-none stack-y-0.5 p-0">
                {summary.topModels.map((entry) => (
                  <li key={entry.model} className="flex min-w-0 items-baseline gap-2">
                    <span className="truncate font-mono text-mono-meta text-foreground">{entry.model}</span>
                    <span className="shrink-0 font-mono text-mono-meta text-foreground-hint">{formatNumber(entry.tokens)}</span>
                  </li>
                ))}
              </ul>
            </UsageRow>
          )}
        </DescriptionList>
      ) : null}
      {state.kind === "ready" && state.usage.partial && (
        <p className="mt-2 text-caption text-foreground-hint">
          {formatMessage(
            { id: "agent.detail.usage.partial" },
            { time: formatRelativeTime(state.usage.asOf, intl.locale) ?? formatShortDateTime(state.usage.asOf) },
          )}
        </p>
      )}
    </div>
    </>
  );
}
