import { createHash } from "node:crypto";

import type { AccountUsageSnapshot, AccountUsageWindow } from "@botiverse/oar";

import {
  RUNTIME_ACCOUNT_USAGE_CREDITS_BALANCE_PATTERN,
  RUNTIME_ACCOUNT_USAGE_PROTOCOL_VERSION,
  RUNTIME_ACCOUNT_USAGE_TEMPORARILY_UNAVAILABLE_CODE,
  RUNTIME_LIMIT_RESETS_AVAILABLE_MAX,
  isRuntimeAccountUsageUnsupportedReason,
  maskRuntimeAccountEmail,
  type RuntimeAccountUsageAccount,
  type RuntimeAccountUsageHealth,
  type RuntimeAccountUsageProvider,
  type RuntimeAccountUsageSnapshot,
  type RuntimeAccountUsageWindowScope,
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

/** OAR's count of limit resets, when it is one the wire schema can carry. */
function limitResetsAvailableOf(snapshot: Extract<OarAccountUsageSnapshot, { kind: "available" }>): number | undefined {
  const available = snapshot.limitResets?.available;
  return typeof available === "number" && Number.isInteger(available) && available >= 0 && available <= RUNTIME_LIMIT_RESETS_AVAILABLE_MAX
    ? available
    : undefined;
}

/**
 * OAR's extra usage credits (Codex), forwarded: `available` and `unlimited`
 * as read, `balance` only when it is a number string the wire carries (it is
 * dropped otherwise, never the credits). Sent to a server that reads it only
 * (the daemon strips it otherwise, SERVER_CAPABILITY_RUNTIME_ACCOUNT_USAGE_CREDITS_V1).
 */
function creditsOf(snapshot: Extract<OarAccountUsageSnapshot, { kind: "available" }>): RuntimeAccountUsageAccount["credits"] {
  const credits = snapshot.credits;
  if (!credits || typeof credits.available !== "boolean") return undefined;
  const balance = typeof credits.balance === "string" ? credits.balance.trim() : undefined;
  return {
    available: credits.available,
    ...(typeof credits.unlimited === "boolean" ? { unlimited: credits.unlimited } : {}),
    ...(balance !== undefined && RUNTIME_ACCOUNT_USAGE_CREDITS_BALANCE_PATTERN.test(balance) ? { balance } : {}),
  };
}

/**
 * OAR's window scope, forwarded unchanged (a model's or a group of models'
 * name only when it is a label the wire carries). Absent stays absent:
 * unknown, not the account. Sent to a server that reads it only (the daemon
 * strips it otherwise, SERVER_CAPABILITY_RUNTIME_ACCOUNT_USAGE_WINDOW_SCOPE_V1;
 * a `models` one needs ..._V2).
 */
function scopeOf(window: AccountUsageWindow): RuntimeAccountUsageWindowScope | undefined {
  const scope = window.scope;
  if (!scope) return undefined;
  switch (scope.kind) {
    case "account":
      return { kind: "account" };
    case "model":
    case "models": {
      const name = safeLabel(scope.name);
      return name ? { kind: scope.kind, name } : undefined;
    }
  }
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

  if (snapshot.kind === "unsupported") {
    // No windows: the schema forbids them. The reason says why (OAR's code;
    // one Raft does not know reads as a plain `unsupported`).
    const unsupportedReason = isRuntimeAccountUsageUnsupportedReason(snapshot.reason) ? snapshot.reason : undefined;
    return { ...base, accounts: [{ accountKey, health: "unsupported", ...(unsupportedReason ? { unsupportedReason } : {}), windows: [] }] };
  }

  if (snapshot.kind === "reauth_required") {
    // An empty list is the only honest reading: we hold no usage measurement at all.
    return { ...base, accounts: [{ accountKey, health: "reauth_required", windows: [] }] };
  }

  if (snapshot.kind === "unavailable") {
    // Not read this time, read again later (Kimi: an expired access token
    // Kimi Code has not refreshed yet). Neither a failure nor zero usage:
    // one unreadable window with the code the web words as "temporarily
    // unavailable".
    return {
      ...base,
      accounts: [{
        accountKey,
        health: "ok",
        parseErrorCode: RUNTIME_ACCOUNT_USAGE_TEMPORARILY_UNAVAILABLE_CODE,
        windows: [{ id: windowId("Usage limit", 0), label: "Usage limit", status: "parse_unavailable" }],
      }],
    };
  }

  const maskedLabel = maskRuntimeAccountEmail(snapshot.email);
  const planLabel = safeLabel(snapshot.plan);
  // Only sent when there is no masked email: the UI would not show it, and a
  // server that predates the field rejects the whole snapshot (strict parse), so
  // email-identified accounts must never carry it.
  const displayName = maskedLabel ? undefined : safeLabel(snapshot.displayName);
  // Sent to a server that reads it only (the daemon strips it otherwise,
  // SERVER_CAPABILITY_RUNTIME_ACCOUNT_USAGE_LIMIT_RESETS_V1).
  const limitResetsAvailable = limitResetsAvailableOf(snapshot);
  const credits = creditsOf(snapshot);
  let sawUnreadableRatio = false;

  const windows = snapshot.windows.map((window, index) => {
    const label = safeLabel(window.label) ?? "Usage limit";
    const id = windowId(label, index);
    const scope = scopeOf(window);
    const ratio = window.usedRatio;
    const usable = typeof ratio === "number" && Number.isFinite(ratio) && ratio >= 0 && ratio <= 1;
    if (!usable) {
      sawUnreadableRatio = true;
      return { id, label, status: "parse_unavailable" as const, ...(scope ? { scope } : {}) };
    }
    const resetsAt = isoOrUndefined(window.resetsAt);
    return {
      id,
      label,
      status: ratio >= 1 ? ("limit_reached" as const) : ("ok" as const),
      usedRatio: Number(ratio.toFixed(6)),
      ...(resetsAt ? { resetsAt } : {}),
      ...(scope ? { scope } : {}),
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
        ...(displayName ? { displayName } : {}),
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
      ...(displayName ? { displayName } : {}),
      health,
      ...(limitResetsAvailable !== undefined ? { limitResetsAvailable } : {}),
      ...(credits ? { credits } : {}),
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
