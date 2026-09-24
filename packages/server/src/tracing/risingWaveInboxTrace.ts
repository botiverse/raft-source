import type { TraceAttributes } from "@botiverse/raft-shared";
import {
  getRisingWaveConnectionTimeoutMillis,
  getRisingWavePoolState,
  type RisingWavePoolState,
} from "../db/risingwave.js";
import { addTraceEvent } from "./semanticTrace.js";

export type RisingWaveInboxTraceRoute = "all" | "unread" | "mentions" | "unread_mentions" | "sidebar_summary" | "channel_unread";
export type RisingWaveInboxFallbackReason = "rw_error" | "breaker_open";
export type RisingWaveFailureStage = "acquire" | "connect" | "query" | "unknown";
export type RisingWaveErrorKind =
  | "rw_acquire_timeout"
  | "rw_connect_error"
  | "rw_query_error"
  | "rw_unknown_error";
export type RisingWaveBreakerState = "not_configured" | "closed" | "open" | "half_open";
export type RisingWaveFallbackTarget = "pg_fallback";
export type RisingWaveFallbackOutcome = "success" | "error";

type DriverCode =
  | "ECONNREFUSED"
  | "ECONNRESET"
  | "ENOTFOUND"
  | "EPIPE"
  | "ETIMEDOUT"
  | "PG_POOL_CONNECT_TIMEOUT"
  | "RW_DRIVER_UNKNOWN";

export interface RisingWaveInboxFailureTraceInput {
  route: RisingWaveInboxTraceRoute;
  error: unknown;
  contractVersion?: number;
  queryName?: string;
  poolState?: RisingWavePoolState;
  breakerState?: RisingWaveBreakerState;
  fallbackReason?: RisingWaveInboxFallbackReason;
  terminalStatus?: 500;
}

export interface RisingWaveInboxFallbackTraceInput extends Omit<RisingWaveInboxFailureTraceInput, "terminalStatus"> {
  fallbackTarget?: RisingWaveFallbackTarget;
  fallbackOutcome: RisingWaveFallbackOutcome;
  fallbackLatencyMs: number;
}

export function risingWaveInboxFailureAttrs(input: RisingWaveInboxFailureTraceInput): TraceAttributes {
  const classification = classifyRisingWaveError(input.error);
  const poolState = input.poolState ?? getRisingWavePoolState();
  return {
    event_kind: "rw_inbox_backend",
    outcome: "error",
    reason: input.fallbackReason ?? "rw_error",
    source: "rw_inbox_trace",
    "db.system": "risingwave",
    db_system: "risingwave",
    "inbox.backend": "rw_mv",
    "inbox.route": input.route,
    "inbox.fallback_reason": input.fallbackReason ?? "rw_error",
    "inbox.contract_version": input.contractVersion,
    inbox_backend: "rw_mv",
    inbox_route: input.route,
    inbox_fallback_reason: input.fallbackReason ?? "rw_error",
    inbox_contract_version: input.contractVersion,
    query_name: input.queryName,
    error_class: errorClass(input.error),
    error_kind: classification.errorKind,
    error_subkind: classification.failureStage,
    rw_failure_stage: classification.failureStage,
    sqlstate: classification.sqlstate,
    driver_code: classification.driverCode,
    timeout_ms: getRisingWaveConnectionTimeoutMillis(),
    ...poolState,
    rw_breaker_state: input.breakerState ?? "not_configured",
    fallback_outcome: input.terminalStatus ? "not_attempted" : undefined,
    terminal_status: input.terminalStatus ? String(input.terminalStatus) : undefined,
  };
}

export function risingWaveInboxFallbackAttrs(input: RisingWaveInboxFallbackTraceInput): TraceAttributes {
  if (input.error === undefined) {
    const poolState = input.poolState ?? getRisingWavePoolState();
    return {
      event_kind: "rw_inbox_backend",
      outcome: input.fallbackOutcome,
      reason: input.fallbackReason ?? "rw_error",
      source: "rw_inbox_trace",
      "db.system": "risingwave",
      db_system: "risingwave",
      "inbox.backend": "rw_mv",
      "inbox.route": input.route,
      "inbox.fallback_reason": input.fallbackReason ?? "rw_error",
      "inbox.contract_version": input.contractVersion,
      inbox_backend: "rw_mv",
      inbox_route: input.route,
      inbox_fallback_reason: input.fallbackReason ?? "rw_error",
      inbox_contract_version: input.contractVersion,
      query_name: input.queryName,
      timeout_ms: getRisingWaveConnectionTimeoutMillis(),
      ...poolState,
      rw_breaker_state: input.breakerState ?? "not_configured",
      fallback_target: input.fallbackTarget ?? "pg_fallback",
      fallback_outcome: input.fallbackOutcome,
      fallback_latency_ms: input.fallbackLatencyMs,
      terminal_status: undefined,
    };
  }
  return {
    ...risingWaveInboxFailureAttrs(input),
    outcome: input.fallbackOutcome,
    reason: input.fallbackReason ?? "rw_error",
    fallback_target: input.fallbackTarget ?? "pg_fallback",
    fallback_outcome: input.fallbackOutcome,
    fallback_latency_ms: input.fallbackLatencyMs,
    terminal_status: undefined,
  };
}

export function isRisingWaveInboxFailSoftError(error: unknown): boolean {
  const classification = classifyRisingWaveError(error);
  return classification.errorKind === "rw_acquire_timeout" || classification.errorKind === "rw_connect_error";
}

export function recordRisingWaveInboxBackendFailed(input: RisingWaveInboxFailureTraceInput): void {
  addTraceEvent("inbox.backend.failed", risingWaveInboxFailureAttrs(input));
}

export function recordRisingWaveInboxFallbackCompleted(input: RisingWaveInboxFallbackTraceInput): void {
  addTraceEvent("inbox.backend.fallback_completed", risingWaveInboxFallbackAttrs(input));
}

function classifyRisingWaveError(error: unknown): {
  errorKind: RisingWaveErrorKind;
  failureStage: RisingWaveFailureStage;
  sqlstate?: string;
  driverCode?: DriverCode;
} {
  const code = errorCode(error);
  const message = errorMessage(error);
  if (message && /timeout exceeded when trying to connect/i.test(message)) {
    return {
      errorKind: "rw_acquire_timeout",
      failureStage: "acquire",
      driverCode: "PG_POOL_CONNECT_TIMEOUT",
    };
  }
  if (code && isSqlState(code)) {
    if (isConnectionSqlState(code)) {
      return { errorKind: "rw_connect_error", failureStage: "unknown", sqlstate: code };
    }
    return { errorKind: "rw_query_error", failureStage: "query", sqlstate: code };
  }
  if (code && isDriverCode(code)) {
    return {
      errorKind: "rw_connect_error",
      failureStage: isPreConnectDriverCode(code) ? "connect" : "unknown",
      driverCode: code,
    };
  }
  if (message && /connection|connect|socket|terminated/i.test(message)) {
    return { errorKind: "rw_connect_error", failureStage: "unknown", driverCode: "RW_DRIVER_UNKNOWN" };
  }
  return { errorKind: "rw_unknown_error", failureStage: "unknown" };
}

function errorClass(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code.trim() ? code.trim() : undefined;
}

function errorMessage(error: unknown): string | undefined {
  if (error instanceof Error) return error.message;
  return undefined;
}

function isSqlState(code: string): boolean {
  return /^[0-9A-Z]{5}$/.test(code);
}

function isConnectionSqlState(code: string): boolean {
  return code.startsWith("08") || code === "57P01" || code === "57P02" || code === "57P03" || code === "28P01";
}

function isDriverCode(code: string): code is DriverCode {
  return code === "ECONNREFUSED"
    || code === "ECONNRESET"
    || code === "ENOTFOUND"
    || code === "EPIPE"
    || code === "ETIMEDOUT";
}

function isPreConnectDriverCode(code: DriverCode): boolean {
  return code === "ECONNREFUSED" || code === "ENOTFOUND";
}
