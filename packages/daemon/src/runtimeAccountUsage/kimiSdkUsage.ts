// Kimi Code's account usage on the Kimi Code SDK the daemon bundles, for a
// Computer without the Kimi Code CLI (#triage:#253). OAR's `kimi` runtime
// reads usage through that CLI (`kimi provider list --json` for its auth
// config), so without it the card said "unsupported" although the agent runs
// and the person signed in on the web (on the SDK, `kimiSdkAuth.ts`).
//
// The SDK's `KimiAuthFacade.getManagedUsage()` (2.3.1-botiverse.1) reads the
// managed provider's quota with the stored token, refreshing it the way the
// SDK's agents do: `{ kind: "ok", quota }` or `{ kind: "error", status?,
// message }`. The quota is projected here into the snapshot OAR's own Kimi
// reader returns (`projectKimiUsage`), so the card reads the same either way:
// the same window labels, Extra Usage's monthly cap as a window, and
// `rateLimited` only when a window is full and Extra Usage has no headroom.
// The SDK reports no account identity: no email, plan or display name.

import type { AccountUsageWindow, UtcInstant } from "@botiverse/oar";
import type { RuntimeAuthStatus } from "@botiverse/raft-shared";

import type { OarAccountUsageSnapshot } from "./oarAdapter";

/** One usage bucket of the SDK's `ManagedQuota` (not exported by the SDK). */
interface KimiQuotaUsage {
  readonly usedRatio: number;
  readonly resetAt?: string | undefined;
}

/** The SDK's `ManagedQuota` as `getManagedUsage` returns it (not exported by the SDK). */
export interface KimiManagedQuota {
  readonly usages: {
    readonly limit5h?: KimiQuotaUsage | undefined;
    readonly limit7d?: KimiQuotaUsage | undefined;
    readonly monthTotal?: KimiQuotaUsage | undefined;
    readonly monthCode?: KimiQuotaUsage | undefined;
  };
  readonly extraUsage: {
    readonly balanceCents: number;
    readonly totalCents: number;
    readonly monthlyChargeLimitEnabled: boolean;
    readonly monthlyChargeLimitCents: number;
    readonly monthlyUsedCents: number;
    readonly currency: string;
  } | null;
}

export type KimiManagedUsageResult =
  | { readonly kind: "ok"; readonly quota: KimiManagedQuota }
  | { readonly kind: "error"; readonly status?: number | undefined; readonly message: string };

function ratio(value: number): number {
  return Number(Math.max(0, Math.min(1, value)).toFixed(6));
}

function utcInstant(value: string | undefined): UtcInstant | undefined {
  if (value === undefined) return undefined;
  const ms = Date.parse(value);
  // OAR's instants are ISO strings; branded there, built from a valid date here.
  return Number.isFinite(ms) ? (new Date(ms).toISOString() as unknown as UtcInstant) : undefined;
}

function window(label: string, usage: KimiQuotaUsage | undefined): AccountUsageWindow | null {
  if (!usage || !Number.isFinite(usage.usedRatio) || usage.usedRatio < 0) return null;
  const resetsAt = utcInstant(usage.resetAt);
  return { label, usedRatio: ratio(usage.usedRatio), ...(resetsAt === undefined ? {} : { resetsAt }) };
}

/** The SDK's quota as OAR's Kimi reader would report it. Throws when it holds no usable window (as OAR does). */
export function projectKimiManagedQuota(quota: KimiManagedQuota): OarAccountUsageSnapshot {
  const windows: AccountUsageWindow[] = [
    window("5h limit", quota.usages.limit5h),
    window("Weekly limit", quota.usages.limit7d),
    window("Monthly limit", quota.usages.monthTotal),
  ].filter((entry): entry is AccountUsageWindow => entry !== null);
  const extra = quota.extraUsage;
  const monthlyCap = extra?.monthlyChargeLimitEnabled === true && extra.monthlyChargeLimitCents > 0
    ? extra.monthlyChargeLimitCents
    : null;
  if (extra && monthlyCap !== null) {
    windows.push({ label: "Extra Usage monthly limit", usedRatio: ratio(extra.monthlyUsedCents / monthlyCap) });
  }
  if (windows.length === 0) throw new Error("Kimi usage contains no usable quota windows");
  // Extra Usage's balance bypasses exhausted subscription windows; its monthly cap is the only further blocker.
  const extraHeadroom = extra !== null
    && extra.balanceCents > 0
    && (monthlyCap === null || extra.monthlyUsedCents < monthlyCap);
  return {
    kind: "available",
    rateLimited: windows.some((entry) => entry.usedRatio === 1) && !extraHeadroom,
    windows,
  };
}

/**
 * Kimi Code's usage on the SDK. Signed out (no stored token): reauth, without
 * loading the SDK. 401/403: the token was rejected. 404: no usage endpoint.
 * Any other failure throws (the collector reports it as an error, never as
 * zero usage).
 */
export async function readKimiSdkUsage(deps: {
  status: () => Promise<RuntimeAuthStatus>;
  getManagedUsage: () => Promise<KimiManagedUsageResult>;
}): Promise<OarAccountUsageSnapshot> {
  if ((await deps.status()).kind === "logged_out") return { kind: "reauth_required", reason: "credentials_missing" };
  const result = await deps.getManagedUsage();
  if (result.kind === "ok") return projectKimiManagedQuota(result.quota);
  if (result.status === 401 || result.status === 403) return { kind: "reauth_required", reason: "credentials_rejected" };
  if (result.status === 404) return { kind: "unsupported", reason: "endpoint_unavailable" };
  throw new Error(`Kimi usage read failed${result.status === undefined ? "" : ` (HTTP ${result.status})`}`);
}
