import type {
  AccountUsageReauthReason,
  LimitResetInspection,
  LimitResetKindStatus,
  LimitResetResult,
  LimitResetUnsupportedReason,
  Runtime,
} from "@botiverse/oar";

import {
  RUNTIME_LIMIT_RESET_CLAUDE_TIMEOUT_MS,
  RUNTIME_LIMIT_RESET_KINDS,
  RUNTIME_LIMIT_RESET_REDEEM_TIMEOUT_MS,
  RUNTIME_LIMIT_RESETS_AVAILABLE_MAX,
  runtimeLimitResetsReadResultSchema,
  type ClaudeFiveHourLimit,
  type RuntimeAccountUsageProvider,
  type RuntimeLimitResetIdempotencyKey,
  type RuntimeLimitResetKind,
  type RuntimeLimitResetKindStatus,
  type RuntimeLimitResetResult,
  type RuntimeLimitResetsReadResult,
} from "@botiverse/raft-shared";

import { loadOarRuntime } from "../oarLoader";

/**
 * Limit resets through OAR (docs/contracts/runtime-account-usage.md): Codex's
 * `redeemLimitReset`, and Claude's `inspectLimitResets` / `redeemLimitReset`
 * (OAR 0.102 drives Claude Code's own `/limit-reset`; the daemon no longer
 * has a driver of its own). This file only chooses the call and maps OAR's
 * answer onto the wire Raft already speaks, so older servers and web bundles
 * keep reading it.
 */

/**
 * Whether OAR drives Claude Code's `/limit-reset` on this platform (OAR 0.102:
 * Linux only; anywhere else it answers `unsupported_platform`). Decides the
 * daemon's Claude limit-reset capability, so a Computer that could only say
 * "not supported" offers nothing, as before.
 */
export function claudeLimitResetsDrivable(platform: NodeJS.Platform): boolean {
  return platform === "linux";
}

/** Injectable for tests; production loads the real OAR runtime. */
export type OarLimitResetDeps = {
  readonly runtime?: Runtime;
  readonly timeoutMs?: number;
  /**
   * Reads usage now and says whether the Claude account is at its 5-hour
   * limit; asked only after OAR refused a redeem with `consent_required`, to
   * tell the 5-hour wall from a kind the account cannot use here yet. The
   * daemon passes its usage collector; without it the answer is `unknown`.
   */
  readonly fiveHourLimit?: () => Promise<ClaudeFiveHourLimit>;
};

/** What the daemon traces beside a wire answer: OAR's own answer, before it was mapped. */
export type RuntimeLimitResetReport = {
  /** `<kind>` or `<kind>:<reason>`, e.g. `not_attempted:busy`; never account data. */
  oarOutcome?: string;
  /** The Claude Code version whose screens OAR read (inspection only). */
  claudeVersion?: string;
};

/**
 * `kind` is the Claude reset kind the person clicked, absent for every other
 * provider. `observe` hears what OAR answered before the mapping, for telemetry.
 */
export type RuntimeLimitResetRedeemer = (
  provider: RuntimeAccountUsageProvider,
  idempotencyKey: RuntimeLimitResetIdempotencyKey,
  kind?: RuntimeLimitResetKind,
  observe?: (report: RuntimeLimitResetReport) => void,
) => Promise<RuntimeLimitResetResult>;

export type RuntimeLimitResetsReadInput = {
  /** What the server's cached usage says; anything but `false` counts as at the 5-hour limit. */
  atFiveHourLimit: boolean;
  atFiveHourLimitConsent: boolean;
  includeFiveHour: boolean;
};

export type RuntimeLimitResetsReader = (
  provider: RuntimeAccountUsageProvider,
  input: RuntimeLimitResetsReadInput,
  observe?: (report: RuntimeLimitResetReport) => void,
) => Promise<RuntimeLimitResetsReadResult>;

const NOT_ATTEMPTED = { kind: "unsupported", reason: "not_attempted" } as const;

function reauthReasonOf(reason: AccountUsageReauthReason): Extract<RuntimeLimitResetResult, { kind: "reauth_required" }>["reason"] {
  switch (reason) {
    case "not_authenticated":
    case "credentials_missing":
    case "scope_missing":
    case "credentials_rejected":
      return reason;
    default: {
      // A reason a newer OAR adds: still "sign in again".
      const _newer: never = reason;
      return "not_authenticated";
    }
  }
}

type WireUnsupportedReason = Extract<RuntimeLimitResetsReadResult, { kind: "unsupported" }>["reason"];

/**
 * OAR's reason on the wire. `consent_required` is the read's own reason; a
 * redeem maps it by the 5-hour limit (see `projectOarLimitResetResult`).
 * `reset_id_required` cannot happen (the daemon always names the kind) and
 * reads as the general "not supported".
 */
function unsupportedReasonOf(reason: LimitResetUnsupportedReason): WireUnsupportedReason {
  switch (reason) {
    case "capability_unavailable":
    case "unsupported_installation":
    case "unsupported_auth_mode":
    case "unsupported_auth_storage":
    case "auth_configuration_unavailable":
    case "endpoint_unavailable":
    case "quota_unavailable":
    case "unsupported_platform":
    case "unsupported_version":
    case "consent_required":
      return reason;
    case "reset_id_required":
      return "capability_unavailable";
    default: {
      const _newer: never = reason;
      return "capability_unavailable";
    }
  }
}

function oarOutcomeOf(result: { kind: string; reason?: string }): string {
  return result.reason ? `${result.kind}:${result.reason}` : result.kind;
}

/**
 * OAR's redeem answer on the wire (`RuntimeLimitResetResult`).
 *
 * - `not_attempted` (busy, deadline, usage_unread, startup_failed): nothing
 *   was sent that could spend; the wire's `unsupported: not_attempted`, which
 *   the web already words as "nothing was used, try again". OAR's reason
 *   reaches telemetry only (`oar_outcome`).
 * - `unsupported: consent_required`: Claude without consent refused to type
 *   a kind other than `five_hour`, for one of two reasons OAR does not tell
 *   apart: usage shows (or cannot rule out) the 5-hour limit, or Claude
 *   Code's cached flag does not show the newer reset program. `fiveHourLimit`
 *   (usage read again after the refusal) tells them apart: clear of the
 *   limit, the kind is not available to this account here yet
 *   (`capability_unavailable`, as the daemon's own driver answered); at it,
 *   or unknown, `not_attempted` (the web's "at your 5-hour limit, use
 *   claude.ai"). Nothing was typed either way. The redeem message carries no
 *   consent (the web offers only the 5-hour reset at the limit).
 * - `unknown`: may or may not have been spent, `fiveHourSpent` kept.
 */
export function projectOarLimitResetResult(result: LimitResetResult, fiveHourLimit: ClaudeFiveHourLimit = "unknown"): RuntimeLimitResetResult {
  switch (result.kind) {
    case "reset":
    case "nothing_to_reset":
    case "no_reset":
    case "already_redeemed":
      return { kind: result.kind };
    case "reauth_required":
      return { kind: "reauth_required", reason: reauthReasonOf(result.reason) };
    case "unsupported": {
      const reason = unsupportedReasonOf(result.reason);
      if (reason !== "consent_required") return { kind: "unsupported", reason };
      return fiveHourLimit === "not_at_limit" ? { kind: "unsupported", reason: "capability_unavailable" } : NOT_ATTEMPTED;
    }
    case "not_attempted":
      return NOT_ATTEMPTED;
    case "unknown":
      return result.fiveHourSpent ? { kind: "unknown", fiveHourSpent: true } : { kind: "unknown" };
    default: {
      // A kind a newer OAR adds: not known whether a reset was spent.
      const _newer: never = result;
      return { kind: "unknown" };
    }
  }
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function wireLabel(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.length > 80 || CONTROL_CHARS.test(trimmed)) return undefined;
  return trimmed;
}

function kindStatusOf(kind: RuntimeLimitResetKind, status: LimitResetKindStatus | undefined): RuntimeLimitResetKindStatus {
  if (!status) return { kind, state: "not_checked" };
  switch (status.state) {
    case "available": {
      const left = status.resetsLeft;
      const expiresText = wireLabel(status.expiresText);
      return {
        kind,
        state: "available",
        ...(typeof left === "number" && Number.isInteger(left) && left >= 0 && left <= RUNTIME_LIMIT_RESETS_AVAILABLE_MAX ? { resetsLeft: left } : {}),
        ...(expiresText ? { expiresText } : {}),
      };
    }
    case "none":
    case "not_offered":
    case "unknown":
    case "not_checked":
      return { kind, state: status.state };
    default: {
      const _newer: never = status.state;
      return { kind, state: "unknown" };
    }
  }
}

/**
 * OAR's inspection on the wire (`RuntimeLimitResetsReadResult`): one entry
 * per kind in RUNTIME_LIMIT_RESET_KINDS order (a kind OAR did not list is
 * `not_checked`, an id Raft does not know is left out), `not_attempted` as
 * the wire's `unsupported: not_attempted`. An answer the wire schema still
 * refuses is `unknown`.
 */
export function projectOarLimitResetInspection(inspection: LimitResetInspection): RuntimeLimitResetsReadResult {
  switch (inspection.kind) {
    case "inspected": {
      const byKind = new Map(inspection.resets.map((reset) => [reset.id, reset]));
      const projected: RuntimeLimitResetsReadResult = {
        kind: "read",
        ...(inspection.program === "legacy" ? { program: "legacy" as const } : {}),
        ...(inspection.fiveHourSpent ? { fiveHourSpent: true as const } : {}),
        resets: RUNTIME_LIMIT_RESET_KINDS.map((kind) => kindStatusOf(kind, byKind.get(kind))),
      };
      const parsed = runtimeLimitResetsReadResultSchema.safeParse(projected);
      return parsed.success ? parsed.data : { kind: "unknown" };
    }
    case "reauth_required":
      return { kind: "reauth_required", reason: reauthReasonOf(inspection.reason) };
    case "unsupported":
      return { kind: "unsupported", reason: unsupportedReasonOf(inspection.reason) };
    case "not_attempted":
      return NOT_ATTEMPTED;
    case "unknown":
      return { kind: "unknown" };
    default: {
      const _newer: never = inspection;
      return { kind: "unknown" };
    }
  }
}

/**
 * Spends one of the provider account's limit resets through OAR, with the
 * idempotency key exactly as the person's click minted it.
 *
 * - Only a runtime that has `redeemLimitReset` can; the presence of the
 *   method decides, never the runtime's name.
 * - Claude needs the kind the person clicked (`resetId`); without one it is
 *   `unsupported` and nothing runs: the Computer never picks a kind. Other
 *   providers get no `resetId` (Codex chooses), whatever `kind` says.
 * - No `env`: Raft's usage read passes none, so the redeem acts on the same
 *   account the card showed.
 * - Any exception is `unknown`: whether a reset was spent is not known, so
 *   the person checks usage (Claude) or retries with the same key (Codex).
 */
export async function redeemOarLimitReset(input: {
  provider: RuntimeAccountUsageProvider;
  idempotencyKey: RuntimeLimitResetIdempotencyKey;
  kind?: RuntimeLimitResetKind;
  deps?: OarLimitResetDeps;
  observe?: (report: RuntimeLimitResetReport) => void;
}): Promise<RuntimeLimitResetResult> {
  const claude = input.provider === "claude";
  if (claude && !input.kind) return { kind: "unsupported", reason: "capability_unavailable" };
  try {
    const runtime = input.deps?.runtime ?? await loadOarRuntime(input.provider);
    const probe = runtime.installation;
    const redeem = runtime.redeemLimitReset;
    if (!probe || !redeem) return { kind: "unsupported", reason: "capability_unavailable" };
    const installation = await probe();
    if (installation.kind !== "available") return { kind: "unsupported", reason: "not_installed" };
    const result = await redeem(installation, {
      idempotencyKey: input.idempotencyKey,
      ...(claude ? { resetId: input.kind } : {}),
      timeoutMs: input.deps?.timeoutMs ?? (claude ? RUNTIME_LIMIT_RESET_CLAUDE_TIMEOUT_MS : RUNTIME_LIMIT_RESET_REDEEM_TIMEOUT_MS),
    });
    input.observe?.({ oarOutcome: oarOutcomeOf(result) });
    const fiveHourLimit = result.kind === "unsupported" && result.reason === "consent_required" && input.deps?.fiveHourLimit
      ? await input.deps.fiveHourLimit().catch((): ClaudeFiveHourLimit => "unknown")
      : "unknown";
    return projectOarLimitResetResult(result, fiveHourLimit);
  } catch {
    input.observe?.({ oarOutcome: "rejected" });
    return { kind: "unknown" };
  }
}

/**
 * Reads which limit resets the provider account holds (OAR
 * `inspectLimitResets`, Claude; a runtime without the method is
 * `unsupported`): only on a person's click, never a poll.
 *
 * At the 5-hour limit (by the server's cached usage) without the person's
 * consent it is refused here (`consent_required`) without starting Claude
 * Code. Otherwise OAR gets the consent as given and reads usage again itself
 * right before the first command when there is none. A rejection is `unknown`.
 */
export async function readOarLimitResets(input: {
  provider: RuntimeAccountUsageProvider;
  read: RuntimeLimitResetsReadInput;
  deps?: OarLimitResetDeps;
  observe?: (report: RuntimeLimitResetReport) => void;
}): Promise<RuntimeLimitResetsReadResult> {
  try {
    const runtime = input.deps?.runtime ?? await loadOarRuntime(input.provider);
    const probe = runtime.installation;
    const inspect = runtime.inspectLimitResets;
    if (!probe || !inspect) return { kind: "unsupported", reason: "capability_unavailable" };
    if (input.read.atFiveHourLimit !== false && !input.read.atFiveHourLimitConsent) {
      return { kind: "unsupported", reason: "consent_required" };
    }
    const installation = await probe();
    if (installation.kind !== "available") return { kind: "unsupported", reason: "not_installed" };
    const inspection = await inspect(installation, {
      ...(input.read.atFiveHourLimitConsent ? { fiveHourLimitConsent: true } : {}),
      includeFiveHour: input.read.includeFiveHour,
      timeoutMs: input.deps?.timeoutMs ?? RUNTIME_LIMIT_RESET_CLAUDE_TIMEOUT_MS,
    });
    input.observe?.({
      oarOutcome: oarOutcomeOf(inspection),
      ...(inspection.kind === "inspected" && inspection.version ? { claudeVersion: inspection.version } : {}),
    });
    return projectOarLimitResetInspection(inspection);
  } catch {
    input.observe?.({ oarOutcome: "rejected" });
    return { kind: "unknown" };
  }
}

export function createRuntimeLimitResetRedeemer(deps?: OarLimitResetDeps): RuntimeLimitResetRedeemer {
  return (provider, idempotencyKey, kind, observe) => redeemOarLimitReset({
    provider,
    idempotencyKey,
    ...(kind ? { kind } : {}),
    ...(deps ? { deps } : {}),
    ...(observe ? { observe } : {}),
  });
}

export function createRuntimeLimitResetsReader(deps?: OarLimitResetDeps): RuntimeLimitResetsReader {
  return (provider, read, observe) => readOarLimitResets({
    provider,
    read,
    ...(deps ? { deps } : {}),
    ...(observe ? { observe } : {}),
  });
}
