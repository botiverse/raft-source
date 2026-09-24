import { createHash } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { normalizeRequestRoutePattern } from "./requestRoutePattern.js";

export const PERF_ATTRIBUTION_ENV = "PERF_ATTRIBUTION_LOGS";
export const PERF_CALLER_CONTEXT_HEADER = "x-perf-caller-context";
export const PERF_SCENARIO_ID_HEADER = "x-perf-scenario-id";
export const PERF_COLD_START_SEQ_HEADER = "x-perf-cold-start-seq";

export const PERF_CALLER_CONTEXTS = [
  "app_bootstrap",
  "server_switch",
  "channel_open",
  "thread_open",
  "reconnect_resume",
  "message_history_prepend",
  "unread_sync",
  "read_state_sync",
  "members_load",
  "search_open",
  "agent_originated",
  "unknown",
] as const;

export type PerfCallerContext = (typeof PERF_CALLER_CONTEXTS)[number];
export type PerfStatusBucket = "429" | "5xx";

export interface PerfAttributionEvent {
  route_pattern: string;
  method: string;
  response_status: number;
  status_bucket: PerfStatusBucket;
  caller_context: PerfCallerContext;
  cold_start_seq: number | null;
  scenario_id: string | null;
  user_id: string | null;
  ts: string;
}

const PERF_CALLER_CONTEXT_SET = new Set<string>(PERF_CALLER_CONTEXTS);
function hashActorId(actorId: string): string {
  return createHash("sha256").update(actorId).digest("hex").slice(0, 16);
}

export function normalizePerfCallerContext(value: string | undefined): PerfCallerContext {
  if (!value) return "unknown";
  return PERF_CALLER_CONTEXT_SET.has(value) ? (value as PerfCallerContext) : "unknown";
}

export function parsePerfColdStartSeq(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

export function perfAttributionEnabled(): boolean {
  return process.env[PERF_ATTRIBUTION_ENV] === "1";
}

export function perfAttributionHeadersPresent(req: Request): boolean {
  return typeof req.header(PERF_CALLER_CONTEXT_HEADER) === "string"
    || typeof req.header(PERF_SCENARIO_ID_HEADER) === "string"
    || typeof req.header(PERF_COLD_START_SEQ_HEADER) === "string";
}

export function normalizePerfRoutePattern(req: Request): string {
  return normalizeRequestRoutePattern(req, { includeQuery: true });
}

export function buildPerfAttributionEvent(req: Request, res: Response): PerfAttributionEvent | null {
  const status = res.statusCode;
  let statusBucket: PerfStatusBucket | null = null;
  if (status === 429) statusBucket = "429";
  else if (status >= 500) statusBucket = "5xx";
  if (!statusBucket) return null;

  const callerContext = normalizePerfCallerContext(req.header(PERF_CALLER_CONTEXT_HEADER)?.trim());
  const scenarioId = req.header(PERF_SCENARIO_ID_HEADER)?.trim() || null;
  const coldStartSeq = parsePerfColdStartSeq(req.header(PERF_COLD_START_SEQ_HEADER)?.trim());
  const actorId = req.userId ? `user:${req.userId}` : req.machineId ? `machine:${req.machineId}` : null;
  const shouldHashActorId = process.env.NODE_ENV === "production";

  return {
    route_pattern: normalizePerfRoutePattern(req),
    method: req.method,
    response_status: status,
    status_bucket: statusBucket,
    caller_context: callerContext,
    cold_start_seq: coldStartSeq,
    scenario_id: scenarioId,
    user_id: actorId ? (shouldHashActorId ? hashActorId(actorId) : actorId) : null,
    ts: new Date().toISOString(),
  };
}

export function perfAttributionMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!perfAttributionEnabled() || !perfAttributionHeadersPresent(req)) {
    next();
    return;
  }

  res.on("finish", () => {
    const event = buildPerfAttributionEvent(req, res);
    if (!event) return;
    console.info("[perf-attribution]", JSON.stringify(event));
  });

  next();
}
