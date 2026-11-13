import { getModelLabel, getRuntimeDisplayName, isClaudeOAuthAppsWindow } from "@botiverse/raft-shared";
import type { ReasoningEffort, RuntimeAccountUsageAccount, RuntimeAccountUsageSnapshot, RuntimeAccountUsageWindow, RuntimeConfig } from "@botiverse/raft-shared";
import {
  buildRuntimeConfig,
  supportsRuntimeFastMode,
} from "../../utils/runtimeConfigForm";

/**
 * Bulk "Change model" planner (task #1287, designs from task #1285).
 *
 * Pure: given the selected agents and one target, it decides per agent what
 * the apply step will do. The component only renders these rows and sends the
 * requests they describe, so every product rule lives here and is unit-tested.
 *
 * Contract (kept identical to the single-agent editor):
 * - Each agent is saved through the same `PATCH /agents/:id`. By default it
 *   carries no restart: a running agent switches at its next idle point
 *   (reconciler step 11c). With "Restart running agents now" the server saves
 *   first and then restarts it (forcing a session reset when the runtime or a
 *   Codex model changes). Stopped agents are only saved.
 * - Only settings this flow can rebuild safely are changed. Agents whose
 *   runtime config carries anything we would otherwise drop (custom provider,
 *   custom command, custom model name, schema-backed or provider-catalog
 *   runtimes) are excluded with a reason instead of being silently rewritten.
 * - A retry carries each unfinished agent's phase. `restart_pending` means the
 *   config already matches the target and only the restart is owed; it must
 *   NOT be treated as "no change".
 */

export interface BulkModelTarget {
  runtime: string;
  model: string;
  reasoningEffort: ReasoningEffort | null;
}

export type BulkUnfinishedPhase = "save_failed" | "restart_pending";

export interface BulkPlanAgentInput {
  id: string;
  runtime: string;
  model: string;
  reasoningEffort: ReasoningEffort | null;
  runtimeConfig?: RuntimeConfig | null;
  envVars?: Record<string, string> | null;
  external?: boolean;
  /** Agent is running now: applying restarts it, or it switches when next idle. */
  running: boolean;
  /** From the agent's runtime-options read; `false` = this agent may not select
   *  the target runtime. `undefined` = not known yet / not needed. */
  targetRuntimeAllowed?: boolean;
  /** Set only when re-opened from a partial-failure receipt. */
  phase?: BulkUnfinishedPhase;
}

export type BulkSkipReason = "customSettings" | "runtimeUnavailable" | "noChange";

export type BulkPlanRow =
  | {
      agentId: string;
      kind: "change";
      runtimeChanges: boolean;
      /** Whether the PATCH carries a restart (the agent is running and "restart now" is chosen). */
      restarts: boolean;
    }
  | {
      agentId: string;
      kind: "restartOnly";
      restarts: true;
    }
  | {
      agentId: string;
      kind: "skip";
      reason: BulkSkipReason;
    };

export interface BulkPlan {
  rows: BulkPlanRow[];
  /** Agents that will receive a request. */
  applyCount: number;
  /** Agents restarted now ("N running agents will restart."). */
  restartCount: number;
  /** Running agents among the changes, restarted now or switching when next idle. */
  runningChangeCount: number;
}

/** Runtimes whose model list does not depend on per-agent provider state. */
const BULK_UNSUPPORTED_RUNTIMES = new Set(["builtin", "pi", "kimi-sdk"]);

export function isBulkSelectableRuntime(runtime: string): boolean {
  return !BULK_UNSUPPORTED_RUNTIMES.has(runtime);
}

/**
 * True when this flow can rebuild the agent's config without dropping anything
 * the user set. Conservative on purpose: anything it does not understand is
 * left to the single-agent editor.
 */
export function agentHasOnlyRebuildableSettings(agent: BulkPlanAgentInput): boolean {
  if (agent.external) return false;
  if (!isBulkSelectableRuntime(agent.runtime)) return false;
  const config = agent.runtimeConfig;
  if (!config) return true;
  if (config.runtime !== agent.runtime) return false;
  if (config.model.kind !== "preset") return false;
  const provider = (config as { provider?: { kind?: string } }).provider;
  if (provider && provider.kind !== "default") return false;
  const command = (config as { command?: string | null }).command;
  if (typeof command === "string" && command.trim()) return false;
  return true;
}

function sameTarget(agent: BulkPlanAgentInput, target: BulkModelTarget): boolean {
  return agent.runtime === target.runtime
    && agent.model === target.model
    && (agent.reasoningEffort ?? null) === (target.reasoningEffort ?? null);
}

/** `restartNow`: running agents restart at once instead of switching at their next idle point. */
export function planBulkModelChange(agents: readonly BulkPlanAgentInput[], target: BulkModelTarget, { restartNow }: { restartNow: boolean }): BulkPlan {
  const rows: BulkPlanRow[] = agents.map((agent) => {
    if (agent.phase === "restart_pending" && sameTarget(agent, target)) {
      return { agentId: agent.id, kind: "restartOnly", restarts: true };
    }
    if (!agentHasOnlyRebuildableSettings(agent)) {
      return { agentId: agent.id, kind: "skip", reason: "customSettings" };
    }
    const runtimeChanges = agent.runtime !== target.runtime;
    if (runtimeChanges && agent.targetRuntimeAllowed === false) {
      return { agentId: agent.id, kind: "skip", reason: "runtimeUnavailable" };
    }
    if (sameTarget(agent, target)) {
      return { agentId: agent.id, kind: "skip", reason: "noChange" };
    }
    return { agentId: agent.id, kind: "change", runtimeChanges, restarts: agent.running && restartNow };
  });
  const applying = rows.filter((row) => row.kind !== "skip");
  const runningIds = new Set(agents.filter((agent) => agent.running).map((agent) => agent.id));
  return {
    rows,
    applyCount: applying.length,
    restartCount: applying.filter((row) => row.restarts).length,
    runningChangeCount: applying.filter((row) => row.kind === "change" && runningIds.has(row.agentId)).length,
  };
}

/**
 * The PATCH body for one agent. Keeps the agent's own env vars, and its fast
 * mode when it stays on a runtime that supports it. Provider/command are never
 * present here because such agents are excluded by the planner.
 */
export function buildBulkAgentUpdate(agent: BulkPlanAgentInput, target: BulkModelTarget): {
  runtime: string;
  model: string;
  reasoningEffort: ReasoningEffort | null;
  runtimeConfig: RuntimeConfig;
} {
  const keepFast = agent.runtime === target.runtime
    && supportsRuntimeFastMode(target.runtime)
    && !!agent.runtimeConfig
    // The saved choice, not the effective one: moving off a model that no
    // longer runs fast keeps fast mode, and buildRuntimeConfig drops it for a
    // target model that does not run fast.
    && agent.runtimeConfig.mode.kind === "fast";
  const envVars = agent.runtimeConfig?.envVars ?? agent.envVars ?? null;
  const runtimeConfig = buildRuntimeConfig({
    runtime: target.runtime,
    model: target.model,
    customModelMode: false,
    fastMode: keepFast,
    reasoningEffort: target.reasoningEffort,
    envVars,
  });
  return {
    runtime: target.runtime,
    model: target.model,
    reasoningEffort: target.reasoningEffort,
    runtimeConfig,
  };
}

/**
 * After a failed request, decide from a FRESH read of the agent what is still
 * owed. The server saves before it restarts, so a request can fail after the
 * new config is already stored: then only the restart is owed.
 */
export function classifyUnfinished(
  fresh: { runtime: string; model: string; reasoningEffort: ReasoningEffort | null } | null,
  target: BulkModelTarget,
): BulkUnfinishedPhase {
  if (fresh && fresh.runtime === target.runtime && fresh.model === target.model
    && (fresh.reasoningEffort ?? null) === (target.reasoningEffort ?? null)) {
    return "restart_pending";
  }
  return "save_failed";
}

/** "Model" or "Runtime · Model" for the review rows and the success banner. */
export function formatBulkModelLabel(runtime: string, model: string, withRuntime: boolean): string {
  const modelLabel = getModelLabel(runtime, model) || model;
  return withRuntime ? [getRuntimeDisplayName(runtime), modelLabel].join(" · ") : modelLabel;
}

/**
 * One-line usage state for a runtime option in the bulk dialog (task #1292,
 * design #1285 step 3: "Max · 42% used" / "Plus · Used up · back …";
 * what is used of the tightest window: usage shows what is used, stdrc
 * 2026-10-29).
 * Read-only decision support: it never changes what the flow applies.
 * Returns null when there is nothing trustworthy to say.
 */
export type BulkRuntimeUsageSummary =
  | { kind: "limit"; plan: string | null; resetsAt: string | null }
  | { kind: "used"; plan: string | null; percent: number }
  | { kind: "attention"; plan: string | null };

/** A window the runtime ties to one model or a group of models (OAR's `scope`), not the whole account. */
export function isModelScopedUsageWindow(window: RuntimeAccountUsageWindow): boolean {
  return window.scope?.kind === "model" || window.scope?.kind === "models";
}

/** How used a window is, to compare windows: a reached limit above any share; null when unreadable. */
function windowTightness(window: RuntimeAccountUsageWindow): number | null {
  if (window.status === "limit_reached") return 2;
  return window.status === "ok" && typeof window.usedRatio === "number" ? window.usedRatio : null;
}

/**
 * An account whose every window is a group of models' (Antigravity: "Gemini
 * Models", "Claude and GPT models", OAR 0.103), with two groups or more: it
 * runs while any group has quota left (OAR reports it rate limited only once
 * every group is used up), so it counts as its group with the most left. Null
 * for any other account.
 */
function roomiestModelGroup(windows: readonly RuntimeAccountUsageWindow[]): RuntimeAccountUsageWindow[] | null {
  const groups = new Map<string, RuntimeAccountUsageWindow[]>();
  for (const window of windows) {
    if (window.scope?.kind !== "models") return null;
    const key = window.scope.name.toLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), window]);
  }
  if (groups.size < 2) return null;
  let roomiest: { windows: RuntimeAccountUsageWindow[]; tightness: number } | null = null;
  for (const group of groups.values()) {
    const readings = group.map(windowTightness).filter((value): value is number => value !== null);
    if (readings.length === 0) continue;
    const tightness = Math.max(...readings);
    if (roomiest === null || tightness < roomiest.tightness) roomiest = { windows: group, tightness };
  }
  return roomiest?.windows ?? null;
}

/**
 * The account as every usage summary counts it (the rack's cell and its
 * first line, the rack's sort, the bulk dialog): never Claude's OAuth apps'
 * window (third-party apps' use), and a model's or a group of models' own
 * window (OAR's `scope`) only when the account reports nothing else; then
 * `modelLine` is false, so the same model is never shown twice. An account
 * of model groups only (Antigravity) counts as its group with the most left,
 * and its model line shows the others. A limit reached only on a window left
 * out leaves the account its percentage: OAR marks the whole account rate
 * limited only when the runtime says it cannot run, and the model line says
 * it (agent blocking still follows the account's own health on the server,
 * never this).
 */
export function allModelsUsageAccount(account: RuntimeAccountUsageAccount): { account: RuntimeAccountUsageAccount; modelLine: boolean } {
  const counted = account.windows.filter((window) => !isClaudeOAuthAppsWindow(window));
  const allModels = counted.filter((window) => !isModelScopedUsageWindow(window));
  const roomiestGroup = allModels.length === 0 ? roomiestModelGroup(counted) : null;
  const modelLine = roomiestGroup !== null || (allModels.length > 0 && counted.some(isModelScopedUsageWindow));
  const kept = roomiestGroup ?? (allModels.length > 0 ? allModels : counted);
  if (kept.length === account.windows.length) return { account, modelLine };
  const limitOnlyLeftOut = account.health === "rate_limited"
    && !kept.some((window) => window.status === "limit_reached")
    && account.windows.some((window) => !kept.includes(window) && window.status === "limit_reached");
  return { account: { ...account, ...(limitOnlyLeftOut ? { health: "ok" as const } : {}), windows: kept }, modelLine };
}

export function summarizeRuntimeUsage(snapshot: RuntimeAccountUsageSnapshot | null): BulkRuntimeUsageSummary | null {
  const first = snapshot?.accounts[0];
  if (!first) return null;
  const { account } = allModelsUsageAccount(first);
  const plan = account.planLabel ?? null;
  const limited = account.windows.filter((window) => window.status === "limit_reached");
  if (limited.length > 0) return { kind: "limit", plan, resetsAt: usableAgainAt(limited.map((window) => window.resetsAt ?? null)) };
  if (account.health !== "ok") return { kind: "attention", plan };
  const ratios = account.windows
    .filter((window) => window.status === "ok" && typeof window.usedRatio === "number")
    .map((window) => window.usedRatio as number);
  if (ratios.length === 0) return null;
  return { kind: "used", plan, percent: runtimeUsagePercentUsed(Math.max(...ratios)) };
}

/**
 * When an account whose windows are at their limit can be used again: the
 * latest of their resets (with the weekly limit still reached, the 5-hour
 * reset frees nothing). Null when any of them doesn't say when it resets.
 */
function usableAgainAt(resets: readonly (string | null)[]): string | null {
  let latest: string | null = null;
  for (const reset of resets) {
    const ms = reset ? Date.parse(reset) : Number.NaN;
    if (!reset || Number.isNaN(ms)) return null;
    if (latest === null || ms > Date.parse(latest)) latest = reset;
  }
  return latest;
}

/** What is used of a window, in whole percent, from its used ratio (0–1). */
export function runtimeUsagePercentUsed(usedRatio: number): number {
  return Math.round(usedRatio * 100);
}
