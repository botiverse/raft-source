import { isRuntimeUsageModelGroupWindow, runtimeUsageModelGroupOf } from "@botiverse/raft-shared";
import type { RuntimeAccountUsageAccount, RuntimeAccountUsageProvider, RuntimeAccountUsageSnapshot, RuntimeAccountUsageWindow } from "@botiverse/raft-shared";
import type { Machine } from "../../../store/machineStore";
import type { RuntimeAccountUsageReadResult } from "../../../utils/runtimeAccountUsageClient";
import { allModelsUsageAccount, isModelScopedUsageWindow, runtimeUsagePercentUsed, summarizeRuntimeUsage } from "../bulkChangeModelPlan";
import type { BulkRuntimeUsageSummary } from "../bulkChangeModelPlan";
import { usageProviderForRuntime } from "../../../utils/runtimeUsageProvider";
import { compareRuntimeCatalogOrder } from "../../../utils/runtimeCatalogOrder";

/** A nearly used allowance: this much used or more (raft-ui Meter's default `warnAt`, 0.8). */
export const RACK_USAGE_WARN_PERCENT = 80;

export type RackUsageResults = Partial<Record<RuntimeAccountUsageProvider, RuntimeAccountUsageReadResult>>;

/** A usage column: one provider's account, whichever of its runtimes a computer has. */
export interface RackUsageColumn {
  provider: RuntimeAccountUsageProvider;
  /** The runtime that names the column: the provider's first in the catalog among the computers'. */
  runtimeId: string;
}

export interface RackRuntimeColumns {
  /** One column per usage provider, in catalog order (at most one per provider). */
  usage: RackUsageColumn[];
  /** Every runtime that reports no usage, in catalog order. */
  other: string[];
}

const catalogOrder = compareRuntimeCatalogOrder;

/**
 * The runtime columns for these computers, the same on every row: one per
 * usage provider any of them has (Kimi Code and Kimi CLI share Kimi's
 * account, so its column), in catalog order; every runtime that reports no
 * usage is in Other. A card passes its own computer alone.
 */
export function rackRuntimeColumns(machines: readonly Machine[]): RackRuntimeColumns {
  const present = [...new Set(machines.flatMap((machine) => machine.runtimes))].sort(catalogOrder);
  const usage: RackUsageColumn[] = [];
  const other: string[] = [];
  for (const runtimeId of present) {
    const provider = usageProviderForRuntime(runtimeId);
    if (!provider) other.push(runtimeId);
    else if (!usage.some((column) => column.provider === provider)) usage.push({ provider, runtimeId });
  }
  return { usage, other };
}

/** The computer's runtime for a provider (the usage card's subject), or null when it has none. */
export function rackProviderRuntime(machine: Machine, provider: RuntimeAccountUsageProvider): string | null {
  return [...machine.runtimes].sort(catalogOrder).find((runtimeId) => usageProviderForRuntime(runtimeId) === provider) ?? null;
}

/**
 * The cell's second line: the tightest window the account reports as one
 * model's or a group of models' (OAR's `scope`), e.g. "Opus · 40%",
 * "Gemini · 100%"; for a group, the group the computer's agents' models
 * count against when Raft can tell (`rackAgentModelGroups`). Display only:
 * whether an agent is blocked is the account's health, never this.
 */
export interface RackModelLine {
  /** The runtime's own name for the model ("Opus", "Fable") or its group, without a trailing "models" ("Gemini"). */
  name: string;
  /** Whole percent used; 100 once its limit is reached. */
  used: number;
  usedUp: boolean;
  resetsAt: string | null;
}

/** One usage provider on one computer, as its cell draws it. */
export type RackRuntimeCell =
  /** None of the provider's runtimes installed: an empty cell. */
  | { kind: "absent" }
  /**
   * Installed and read, its usage not answered yet: a placeholder in the
   * value's shape, never "—", which says there is nothing to read.
   */
  | { kind: "pending"; provider: RuntimeAccountUsageProvider; runtimeId: string }
  /**
   * Installed, but no share used to read (not allowed, a failed read, nothing
   * readable, or every account needs attention): "—".
   */
  | { kind: "unavailable"; provider: RuntimeAccountUsageProvider; runtimeId: string; attention: BulkRuntimeUsageSummary | null }
  /**
   * The tightest account's share used; `warn` from 80% used, `usedUp` when
   * its limit is reached; `attention` when another account needs it.
   */
  | {
    kind: "value";
    provider: RuntimeAccountUsageProvider;
    runtimeId: string;
    used: number;
    warn: boolean;
    usedUp: boolean;
    stale: boolean;
    summary: BulkRuntimeUsageSummary;
    attention: BulkRuntimeUsageSummary | null;
    /** The account reports a model's own window: the cell's second line. */
    model: RackModelLine | null;
  };

function usedOf(summary: BulkRuntimeUsageSummary | null): number | null {
  if (summary?.kind === "used") return summary.percent;
  if (summary?.kind === "limit") return 100;
  return null;
}

/**
 * The model groups (a `models` scope's name) these agents' models count
 * against, as Raft reads their model ids (Antigravity's "Gemini Models",
 * "Claude and GPT models"); empty when it cannot tell for any of them.
 */
export function rackAgentModelGroups(agents: readonly { runtime: string; model?: string | null }[]): string[] {
  const groups = new Set<string>();
  for (const agent of agents) {
    const group = runtimeUsageModelGroupOf(agent.runtime, agent.model);
    if (group) groups.add(group);
  }
  return [...groups].sort();
}

/** A scope's name on the cell's line: a group's without its trailing "models" ("Claude and GPT models" → "Claude and GPT"). */
function modelLineName(scope: NonNullable<RuntimeAccountUsageWindow["scope"]>): string {
  if (scope.kind === "account") return "";
  return scope.kind === "models" ? scope.name.replace(/\s+models$/iu, "") || scope.name : scope.name;
}

/**
 * The account's tightest model (or model group) window, or null when it
 * reports none it can read, or nothing but model windows (its first line
 * already counts them: `allModelsUsageAccount`). With `groups` (the
 * computer's agents' model groups), the tightest of those groups' windows
 * when the account reports any.
 */
function modelLineOf(account: RuntimeAccountUsageAccount, groups: readonly string[] = []): RackModelLine | null {
  if (!allModelsUsageAccount(account).modelLine) return null;
  const scoped = account.windows.filter(isModelScopedUsageWindow);
  const agents = scoped.filter((window) => groups.some((group) => isRuntimeUsageModelGroupWindow(window, group)));
  let tightest: RackModelLine | null = null;
  for (const window of agents.length > 0 ? agents : scoped) {
    if (!window.scope || window.status === "parse_unavailable") continue;
    const usedUp = window.status === "limit_reached";
    if (!usedUp && typeof window.usedRatio !== "number") continue;
    const line: RackModelLine = {
      name: modelLineName(window.scope),
      used: usedUp ? 100 : runtimeUsagePercentUsed(window.usedRatio!),
      usedUp,
      resetsAt: window.resetsAt ?? null,
    };
    if (tightest === null || line.used > tightest.used || (line.used === tightest.used && usedUp && !tightest.usedUp)) tightest = line;
  }
  return tightest;
}

/** One account's summary, on the all-models basis (`summarizeRuntimeUsage`). */
function summarizeAccount(snapshot: RuntimeAccountUsageSnapshot, account: RuntimeAccountUsageAccount): BulkRuntimeUsageSummary | null {
  return summarizeRuntimeUsage({ ...snapshot, accounts: [account] });
}

/** The tightest account with a share used to read, and the first needing attention. */
function readAccounts(snapshot: RuntimeAccountUsageSnapshot) {
  let tightest: { used: number; summary: BulkRuntimeUsageSummary; account: RuntimeAccountUsageAccount } | null = null;
  let attention: BulkRuntimeUsageSummary | null = null;
  for (const account of snapshot.accounts) {
    const summary = summarizeAccount(snapshot, account);
    if (summary?.kind === "attention") attention ??= summary;
    const used = usedOf(summary);
    if (!summary || used === null) continue;
    if (tightest === null || used > tightest.used || (used === tightest.used && summary.kind === "limit")) tightest = { used, summary, account };
  }
  return { tightest, attention };
}

/** Whether a provider's answer draws its cell in two lines: a value with a model line (rackRuntimeCell's `model`). */
export function rackUsageTwoLines(result: RuntimeAccountUsageReadResult): boolean {
  if (result.snapshot === null) return false;
  const { tightest } = readAccounts(result.snapshot);
  return tightest !== null && modelLineOf(tightest.account) !== null;
}

/**
 * What a provider's cell shows on a computer. `results` is null when the
 * viewer may not see that computer's usage; a provider missing from it is
 * not answered yet (pending). Several accounts: the tightest
 * one (its usage card lists them all); at a tie, a reached limit, which
 * says when it resets. `modelGroups`: the computer's agents' model groups,
 * for the model line (`rackAgentModelGroups`).
 */
export function rackRuntimeCell(machine: Machine, provider: RuntimeAccountUsageProvider, results: RackUsageResults | null, modelGroups: readonly string[] = []): RackRuntimeCell {
  const runtimeId = rackProviderRuntime(machine, provider);
  if (!runtimeId) return { kind: "absent" };
  const result = results?.[provider];
  // Read (results), but not answered yet: a failed read is answered as missing (useRackRuntimeUsages).
  if (results && !result) return { kind: "pending", provider, runtimeId };
  // A Computer whose daemon does not read this provider's usage: as if it reported none.
  if (result?.state === "unsupported") return { kind: "absent" };
  if (!result || result.snapshot === null) return { kind: "unavailable", provider, runtimeId, attention: null };
  const { tightest, attention } = readAccounts(result.snapshot);
  if (!tightest) return { kind: "unavailable", provider, runtimeId, attention };
  return {
    kind: "value",
    provider,
    runtimeId,
    used: tightest.used,
    warn: tightest.used >= RACK_USAGE_WARN_PERCENT,
    usedUp: tightest.summary.kind === "limit",
    stale: result.state === "stale",
    summary: tightest.summary,
    attention,
    model: modelLineOf(tightest.account, modelGroups),
  };
}

/** The computer's runtimes in Other, in the columns' order. */
export function rackOtherRuntimes(machine: Machine, other: readonly string[]): string[] {
  return other.filter((runtimeId) => machine.runtimes.includes(runtimeId));
}

/** The step a usage cell shows instead of the bar when the Computer's login for that provider holds agents. */
export type RackLoginStep = "verify_account" | "sign_in";

/**
 * The step on a provider's cell (designer Jasper, #14587 follow-up): when the
 * Computer's machine login of one of the provider's runtimes (`shared:<runtime>`)
 * is blocked and holds at least one agent there (an item of the server's
 * needs-attention summary), "Verify" or "Sign in" instead of the bar. Only a
 * viewer who may see the reason gets the item's code and resource; anyone else
 * keeps "—". Null when nothing on that login needs a step.
 */
export function rackLoginStep(machine: Machine, provider: RuntimeAccountUsageProvider): RackLoginStep | null {
  for (const item of machine.attention?.items ?? []) {
    if (!item.code || item.agentCount === 0 || item.resource?.kind !== "login" || !item.resource.key.startsWith("shared:")) continue;
    const runtimeId = item.resource.key.slice("shared:".length);
    if (!machine.runtimes.includes(runtimeId) || usageProviderForRuntime(runtimeId) !== provider) continue;
    if (item.action === "verify_account" || item.action === "sign_in") return item.action;
  }
  return null;
}
