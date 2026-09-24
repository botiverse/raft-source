import { createHash } from "node:crypto";

import type { AccountUsageSnapshot } from "@botiverse/oar";

import {
  RUNTIME_ACCOUNT_USAGE_PROTOCOL_VERSION,
  maskRuntimeAccountEmail,
  type RuntimeAccountUsageHealth,
  type RuntimeAccountUsageProvider,
  type RuntimeAccountUsageSnapshot,
} from "@botiverse/raft-shared";

export type OarAccountUsageSnapshot = AccountUsageSnapshot;

const STALE_AFTER_MS = 30 * 60 * 1_000;
/**
 * The wire schema caps an account at 12 windows. A provider may legitimately
 * report more; when it does, the reading is not representable and we say so.
 * Keeping the first 12 would emit a well-formed snapshot that silently
 * understates usage, which is indistinguishable from a real reading.
 */
const MAX_WIRE_WINDOWS = 12;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function safeLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 80) return undefined;
  return CONTROL_CHARS.test(trimmed) ? undefined : trimmed;
}

function accountKeyFor(provider: RuntimeAccountUsageProvider, localAccountSlot: string): string {
  return createHash("sha256").update(`${provider}\u0000${localAccountSlot}`).digest("hex");
}

function windowId(label: string, index: number): string {
  const suffix = createHash("sha256").update(label).digest("hex").slice(0, 12);
  return `w${index}_${suffix}`;
}

function isoOrUndefined(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

/** Mask identity and validate OAR measurements at the Computer/server boundary. */
export function projectOarAccountUsageSnapshot(input: {
  provider: RuntimeAccountUsageProvider;
  snapshot: OarAccountUsageSnapshot;
  localAccountSlot: string;
  collectorVersion: string;
  observedAtMs: number;
}): RuntimeAccountUsageSnapshot {
  const { provider, snapshot } = input;
  const accountKey = accountKeyFor(provider, input.localAccountSlot);
  const base = {
    protocolVersion: RUNTIME_ACCOUNT_USAGE_PROTOCOL_VERSION,
    provider,
    collectedAt: new Date(input.observedAtMs).toISOString(),
    staleAfter: new Date(input.observedAtMs + STALE_AFTER_MS).toISOString(),
    collectorVersion: input.collectorVersion,
  };

  if (snapshot.kind === "unsupported" || snapshot.kind === "reauth_required") {
    const health = snapshot.kind;
    // No windows. The schema forbids them for `unsupported`, and for
    // `reauth_required` an empty list is the only honest reading: we hold no
    // usage measurement at all.
    return { ...base, accounts: [{ accountKey, health, windows: [] }] };
  }

  const maskedLabel = maskRuntimeAccountEmail(snapshot.email);
  const planLabel = safeLabel(snapshot.plan);
  let sawUnreadableRatio = false;

  const windows = snapshot.windows.map((window, index) => {
    const label = safeLabel(window.label) ?? "Usage limit";
    const id = windowId(label, index);
    const ratio = window.usedRatio;
    const usable = typeof ratio === "number" && Number.isFinite(ratio) && ratio >= 0 && ratio <= 1;
    if (!usable) {
      sawUnreadableRatio = true;
      return { id, label, status: "parse_unavailable" as const };
    }
    const resetsAt = isoOrUndefined(window.resetsAt);
    return {
      id,
      label,
      status: ratio >= 1 ? ("limit_reached" as const) : ("ok" as const),
      usedRatio: Number(ratio.toFixed(6)),
      ...(resetsAt ? { resetsAt } : {}),
    };
  });

  if (windows.length > MAX_WIRE_WINDOWS) {
    // Not representable on the wire: report an explicit failure with no
    // windows rather than a truncated reading that would look successful.
    return {
      ...base,
      accounts: [{
        accountKey,
        ...(maskedLabel ? { maskedLabel } : {}),
        ...(planLabel ? { planLabel } : {}),
        health: "error",
        windows: [],
      }],
    };
  }

  const health: RuntimeAccountUsageHealth = snapshot.rateLimited ? "rate_limited" : "ok";
  return {
    ...base,
    accounts: [{
      accountKey,
      ...(maskedLabel ? { maskedLabel } : {}),
      ...(planLabel ? { planLabel } : {}),
      health,
      ...(sawUnreadableRatio ? { parseErrorCode: "oar_window_ratio_unreadable" } : {}),
      windows,
    }],
  };
}

/**
 * Failure projection. A read that threw, timed out, or returned an unusable
 * payload becomes an explicit `error` account with NO windows — never a
 * zero-usage reading. Consumers must be able to tell "we did not learn the
 * usage" apart from "usage is zero".
 */
export function projectOarAccountUsageFailure(input: {
  provider: RuntimeAccountUsageProvider;
  localAccountSlot: string;
  collectorVersion: string;
  observedAtMs: number;
}): RuntimeAccountUsageSnapshot {
  return {
    protocolVersion: RUNTIME_ACCOUNT_USAGE_PROTOCOL_VERSION,
    provider: input.provider,
    collectedAt: new Date(input.observedAtMs).toISOString(),
    staleAfter: new Date(input.observedAtMs + STALE_AFTER_MS).toISOString(),
    collectorVersion: input.collectorVersion,
    accounts: [{
      accountKey: accountKeyFor(input.provider, input.localAccountSlot),
      health: "error",
      windows: [],
    }],
  };
}
