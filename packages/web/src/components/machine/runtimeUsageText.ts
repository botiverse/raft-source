import { currentTimeMs, defaultRuntimeUsageAccount } from "@botiverse/raft-shared";
import type { RuntimeAccountUsageSnapshot } from "@botiverse/raft-shared";
import type { IntlShape } from "react-intl";
import { usageResetText } from "./rack/rackResetText";
import { formatRuntimePlanName } from "../../features/computer/accountText";
import { runtimeUsagePercentUsed } from "./bulkChangeModelPlan";
import type { BulkRuntimeUsageSummary } from "./bulkChangeModelPlan";
import { usageOnCredits } from "./runtimeUsageCredits";

/**
 * One compact line for what a runtime account has used, e.g.
 * "Claude Max · 28% used". Shared by the pickers that show it as an option's
 * second line (bulk Change model, Move to another computer) so the copy is
 * identical. No summary, no line.
 */
export function runtimeUsageText(
  summary: BulkRuntimeUsageSummary | null | undefined,
  formatMessage: IntlShape["formatMessage"],
  locale: string,
): string | undefined {
  if (!summary) return undefined;
  const plan = formatRuntimePlanName(summary.plan) ?? formatMessage({ id: "machine.runtimeUsage.accountFallback" });
  if (summary.kind === "used") return formatMessage({ id: "machine.detail.bulkModel.usageUsed" }, { plan, percent: summary.percent });
  if (summary.kind === "attention") return formatMessage({ id: "machine.detail.bulkModel.usageAttention" }, { plan });
  // A window used up while the account runs on credits: still usable, no reset to wait for.
  if (summary.kind === "credits") return formatMessage({ id: "machine.detail.bulkModel.usageCredits" }, { plan });
  const reset = usageResetText(summary.resetsAt, locale, currentTimeMs());
  return reset
    ? formatMessage({ id: "machine.detail.bulkModel.usageLimit" }, { plan, reset })
    : formatMessage({ id: "machine.detail.bulkModel.usageLimitNoReset" }, { plan });
}

type RuntimeUsageWindow = RuntimeAccountUsageSnapshot["accounts"][number]["windows"][number];

/**
 * Window labels as the Computer sends them (OAR's adapters; the window ids on
 * the wire are opaque hashes of the label, so the label is what names them).
 * Claude: "Current session" (5 hours) and "Current week (all models)". Codex:
 * the duration, prefixed with its limit name ("Codex · 5 hours", "Codex · 1 week").
 * Grok: "Weekly included usage".
 * Only these two make the compact line; per-model and other windows belong to
 * the full usage card.
 */
const FIVE_HOUR_LABELS = new Set(["Current session", "5 hours", "Codex · 5 hours"]);
const WEEK_LABELS = new Set(["Current week (all models)", "1 week", "Codex · 1 week", "Weekly included usage"]);

function windowRank(window: Pick<RuntimeUsageWindow, "label">): number {
  if (FIVE_HOUR_LABELS.has(window.label)) return 0;
  if (WEEK_LABELS.has(window.label)) return 1;
  return 2;
}

function windowName(rank: number, formatMessage: IntlShape["formatMessage"]): string {
  return formatMessage({ id: rank === 0 ? "machine.runtimeUsage.line.fiveHour" : "machine.runtimeUsage.line.week" });
}

/**
 * A window's name on the usage card: the 5-hour and weekly windows in the
 * reader's language ("5 hours", "This week"), any other window (a model's own,
 * a runtime's own kind) as the Computer named it.
 */
export function runtimeUsageWindowLabel(window: Pick<RuntimeUsageWindow, "label">, formatMessage: IntlShape["formatMessage"]): string {
  const rank = windowRank(window);
  return rank === 2 ? window.label : windowName(rank, formatMessage);
}

/** One window of the compact line; a used-up window is drawn as a warning, unless the account runs on credits. */
export interface RuntimeUsageLinePart {
  text: string;
  limitReached: boolean;
}

/**
 * The compact usage line. `text` is the whole line as plain text (labels,
 * descriptions); `plan` and `windows` let a renderer colour the used-up window.
 * A line with no windows ("needs attention") is `text` alone.
 */
export interface RuntimeUsageLine {
  text: string;
  plan: string;
  windows: RuntimeUsageLinePart[];
}

/**
 * The account's plan with its 5-hour and weekly windows, in that order, e.g.
 * "Claude Max · 5h 28% used · Week 60% used"; a window used up while the
 * account runs on credits reads "Week on credits". An account that is not healthy
 * (other than being rate limited, which its windows already say) reads
 * "needs attention"; no account or neither window readable, no line.
 */
export function runtimeUsageWindowsLine(
  snapshot: RuntimeAccountUsageSnapshot | null | undefined,
  formatMessage: IntlShape["formatMessage"],
  locale: string,
): RuntimeUsageLine | undefined {
  // The Computer's default account, never an agent's own folder's (`agentIds`).
  const account = defaultRuntimeUsageAccount(snapshot);
  if (!account) return undefined;
  const plan = formatRuntimePlanName(account.planLabel) ?? formatMessage({ id: "machine.runtimeUsage.accountFallback" });
  const attention = (): RuntimeUsageLine => ({
    text: formatMessage({ id: "machine.detail.bulkModel.usageAttention" }, { plan }),
    plan,
    windows: [],
  });
  if (account.health !== "ok" && account.health !== "rate_limited") return attention();
  const onCredits = usageOnCredits(account);
  const windows = account.windows
    .filter((window) => window.status !== "parse_unavailable")
    .map((window, index) => ({ window, index, rank: windowRank(window) }))
    .filter(({ rank }) => rank < 2)
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ window, rank }): RuntimeUsageLinePart | null => {
      const name = windowName(rank, formatMessage);
      if (window.status === "limit_reached" && onCredits) {
        return { text: formatMessage({ id: "machine.runtimeUsage.line.credits" }, { window: name }), limitReached: false };
      }
      if (window.status === "limit_reached") {
        const reset = usageResetText(window.resetsAt, locale, currentTimeMs());
        const text = reset
          ? formatMessage({ id: "machine.runtimeUsage.line.limit" }, { window: name, reset })
          : formatMessage({ id: "machine.runtimeUsage.line.limitNoReset" }, { window: name });
        return { text, limitReached: true };
      }
      if (typeof window.usedRatio !== "number") return null;
      const text = formatMessage(
        { id: "machine.runtimeUsage.line.used" },
        { window: name, percent: runtimeUsagePercentUsed(window.usedRatio) },
      );
      return { text, limitReached: false };
    })
    .filter((part): part is RuntimeUsageLinePart => part !== null);
  if (windows.length === 0) return account.health === "ok" ? undefined : attention();
  return {
    text: formatMessage({ id: "machine.runtimeUsage.line.all" }, { plan, windows: windows.length >= 2
      ? formatMessage({ id: "machine.runtimeUsage.line.pair" }, { first: windows[0]!.text, second: windows[1]!.text })
      : windows[0]!.text }),
    plan,
    windows,
  };
}
