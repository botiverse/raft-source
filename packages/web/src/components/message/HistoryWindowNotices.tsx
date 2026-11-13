import { useCallback } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { History } from "lucide-react";
import { PLAN_CONFIG, currentTimeMs, getEffectiveLimits } from "@botiverse/raft-shared";
import type { PaywallSurface, ServerPlan } from "@botiverse/raft-shared";
import { TextLink } from "@botiverse/raft-ui";
import { usePaywallShown } from "../../analytics/paywall";
import { usePaywallUpgrade } from "../../hooks/usePaywallUpgrade";
import { useServerStore } from "../../store/serverStore";
import AppBanner from "../ui/Banner";

const FREE_HISTORY_DAYS = PLAN_CONFIG.free.limits.messageHistoryDays;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The plan's history window in days, or null when it keeps all history (the billing plan first, as the paywall labels read it). */
export function useHistoryWindowDays(): number | null {
  const plan = useServerStore((s) => (s.billing?.plan || s.current?.plan || "free") as ServerPlan);
  const days = getEffectiveLimits(plan).messageHistoryDays;
  return days === -1 ? null : days;
}

/** Whether something created at `createdAt` reaches back past the window, so the window may hide part of it. */
export function reachesPastHistoryWindow(createdAt: string | undefined, windowDays: number | null): boolean {
  if (windowDays === null || !createdAt) return false;
  const created = Date.parse(createdAt);
  return Number.isFinite(created) && created < currentTimeMs() - windowDays * DAY_MS;
}

/**
 * A list or a page that leaves out what is older than the plan's history
 * window (search, Saved, a channel's files) says so at its top: one line on
 * an info Banner (DS Banner: info is for limits) with an inline Upgrade to Pro.
 */
export function HistoryWindowBanner({ surface, children, className, testId }: {
  /** Where it shows, for the paywall events (Nova, 2026-10-29). */
  surface: Extract<PaywallSurface, "search" | "saved" | "files">;
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  const { formatMessage } = useIntl();
  const paywallUpgrade = usePaywallUpgrade();
  const upgrade = useCallback(() => paywallUpgrade("history_30d", surface), [paywallUpgrade, surface]);
  usePaywallShown("history_30d", surface);
  return (
    // Inset by a wrapper: a Banner takes no horizontal margin of its own.
    <div className={className}>
      <AppBanner intent="info" density="sm" live={false} withIcon data-testid={testId}>
        {children}{" "}
        <TextLink onClick={upgrade} variant="strong" data-testid={testId ? `${testId}-upgrade` : undefined}>
          {formatMessage({ id: "billing.upgradeToPro" })}
        </TextLink>
      </AppBanner>
    </div>
  );
}

/**
 * One message, quoted or listed away from its conversation, that is older
 * than the window: this line takes the place of its text, with an Upgrade to
 * Pro that opens the dialog. Use it where the line is not itself a button.
 */
export function OlderMessageNotice({ surface, testId = "history-older-message", withIcon = true }: {
  /** Where it shows, for the paywall events (Nova, 2026-10-29). */
  surface: Extract<PaywallSurface, "quoted_message" | "agent_activity">;
  testId?: string;
  /** False where the row already leads with its own icon. */
  withIcon?: boolean;
}) {
  const { formatMessage } = useIntl();
  const paywallUpgrade = usePaywallUpgrade();
  const upgrade = useCallback(() => paywallUpgrade("history_30d", surface), [paywallUpgrade, surface]);
  usePaywallShown("history_30d", surface);
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-x-1.5 text-foreground-muted" data-testid={testId}>
      {withIcon ? <History size={14} aria-hidden className="shrink-0" /> : null}
      <span>{formatMessage({ id: "message.historyPaywall.olderMessage" }, { days: FREE_HISTORY_DAYS })}</span>
      <TextLink onClick={upgrade} variant="strong" data-testid={`${testId}-upgrade`}>
        {formatMessage({ id: "billing.upgradeToPro" })}
      </TextLink>
    </span>
  );
}
