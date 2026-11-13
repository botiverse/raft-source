import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { Card, CardContent, CardHeader, CardTitle, Spinner } from "@botiverse/raft-ui";
import type { HostedRuntimeSpendView } from "@botiverse/raft-shared";
import api from "../../api/client";
import Banner from "../ui/Banner";
import { useTimeFormatter } from "../../hooks/useTimeFormatter";
import { formatUsdAmount } from "../../utils/usdAmount";

export const HOSTED_RUNTIME_SPEND_PATH = "/billing/hosted-runtime-usage";

type LoadState =
  | { kind: "loading" }
  | { kind: "hidden" }
  | { kind: "error" }
  | { kind: "ready"; spend: HostedRuntimeSpendView };

function SpendRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[8rem_minmax(0,1fr)] items-baseline gap-x-4">
      <dt className="text-footnote font-medium text-foreground-hint">{label}</dt>
      <dd className="m-0 min-w-0 text-callout tabular-nums text-foreground">{children}</dd>
    </div>
  );
}

/**
 * The server's hosted-runtime (antiproton) spend on the Plan page: today
 * against the daily limit, the last 30 UTC days and spend by agent, as the
 * provider reports it. Fetched once on open (the provider caches 15 s).
 * Hidden when the server has no hosted runtime or the viewer is not an owner
 * or admin (4xx); a warning when the provider does not answer.
 */
export function HostedRuntimeSpendCard() {
  const intl = useIntl();
  const { formatMessage, formatDate } = intl;
  const { formatShortDateTime } = useTimeFormatter();
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    api.get<HostedRuntimeSpendView>(HOSTED_RUNTIME_SPEND_PATH).then(({ data }) => {
      if (!cancelled) setState({ kind: "ready", spend: data });
    }).catch((err: unknown) => {
      if (cancelled) return;
      const status = (err as { response?: { status?: number } }).response?.status;
      setState(status && status < 500 && status !== 429 && status !== 400 ? { kind: "hidden" } : { kind: "error" });
    });
    return () => { cancelled = true; };
  }, []);

  if (state.kind === "hidden") return null;
  const usd = (value: number) => formatUsdAmount(intl, value);
  const utcDay = (iso: string) => formatDate(iso, { month: "short", day: "numeric", timeZone: "UTC" });
  const muted = "text-caption text-foreground-hint";

  let body: ReactNode = null;
  if (state.kind === "loading") {
    body = <Spinner size="xs" aria-label={formatMessage({ id: "settings.hostedSpend.loading" })} />;
  } else if (state.kind === "error") {
    body = (
      <Banner intent="warning" density="sm">
        {formatMessage({ id: "settings.hostedSpend.loadFailed" })}
      </Banner>
    );
  } else {
    const { spend } = state;
    const { today } = spend;
    const resetsAt = formatShortDateTime(today.resetsAt);
    const hasUnpriced = spend.periods.some((period) => period.unpriced.length > 0);
    body = (
      <>
        {today.refusing && (
          <Banner intent="warning" density="sm" className="mb-4" data-testid="hosted-runtime-spend-refusing">
            {formatMessage(
              { id: today.platformLimitReached ? "settings.hostedSpend.refusingPlatform" : "settings.hostedSpend.refusingServer" },
              { time: resetsAt },
            )}
          </Banner>
        )}
        <dl className="m-0 stack-y-3">
          <SpendRow label={formatMessage({ id: "settings.hostedSpend.today" })}>
            <div data-testid="hosted-runtime-spend-today">
              {today.limitUsd === null
                ? formatMessage({ id: "settings.hostedSpend.noLimit" }, { spent: usd(today.spentUsd) })
                : formatMessage({ id: "settings.hostedSpend.ofLimit" }, { spent: usd(today.spentUsd), limit: usd(today.limitUsd) })}
            </div>
            <div className={muted}>{formatMessage({ id: "settings.hostedSpend.resets" }, { time: resetsAt })}</div>
          </SpendRow>
          <SpendRow label={formatMessage({ id: "settings.hostedSpend.last30Days" })}>
            <div className="font-mono text-mono-code" data-testid="hosted-runtime-spend-total">{usd(spend.totalUsd)}</div>
            {spend.periods.length === 0 ? (
              <div className={muted}>{formatMessage({ id: "settings.hostedSpend.empty" })}</div>
            ) : (
              <div className="mt-1 grid grid-cols-[auto_auto] justify-start gap-x-3 gap-y-0.5 font-mono text-mono-meta" data-testid="hosted-runtime-spend-days">
                {spend.periods.map((period) => (
                  <div key={period.start} className="contents">
                    <span className="text-foreground-hint">{utcDay(period.start)}</span>
                    <span className="text-foreground">{usd(period.totalUsd)}</span>
                  </div>
                ))}
              </div>
            )}
          </SpendRow>
          {spend.agents.length > 0 && (
            <SpendRow label={formatMessage({ id: "settings.hostedSpend.byAgent" })}>
              <ul className="m-0 list-none stack-y-0.5 p-0 text-footnote" data-testid="hosted-runtime-spend-agents">
                {spend.agents.map((agent) => (
                  <li key={agent.agentId ?? "deleted"} className="flex min-w-0 items-baseline gap-2">
                    <span className="truncate">{agent.name ?? formatMessage({ id: "settings.hostedSpend.deletedAgents" })}</span>
                    <span className="shrink-0 font-mono text-mono-meta text-foreground-hint">{usd(agent.totalUsd)}</span>
                  </li>
                ))}
              </ul>
            </SpendRow>
          )}
        </dl>
        {hasUnpriced && <p className={`mt-3 ${muted}`}>{formatMessage({ id: "settings.hostedSpend.unpriced" })}</p>}
        <p className={`mt-1 ${muted}`}>
          {formatMessage({ id: spend.estimated ? "settings.hostedSpend.noteEstimated" : "settings.hostedSpend.note" })}
        </p>
      </>
    );
  }

  // One of Plan & Billing's cards, titled like the others (task #13).
  return (
    <Card data-testid="hosted-runtime-spend">
      <CardHeader>
        <CardTitle render={<h2>{formatMessage({ id: "settings.hostedSpend.title" })}</h2>} />
      </CardHeader>
      <CardContent>{body}</CardContent>
    </Card>
  );
}
