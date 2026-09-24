import { createHmac, timingSafeEqual } from "node:crypto";
import { formatTraceparent, setClockTimeout } from "@botiverse/raft-shared";
import type { Request, Response } from "express";
import {
  clearMachineReplicaOwnerIfMatches,
  getFlyInstanceForMachine,
  getMachineReplicaReplayTarget,
  type MachineReplicaReplayTarget,
} from "./replicaRouter.js";
import { addTraceEvent, getCurrentTraceContext } from "./tracing/semanticTrace.js";

const REPLAY_MARKER_HEADER = "x-raft-replica-replay";
const REPLAY_MACHINE_HEADER = "x-raft-replica-replay-machine";
const REPLAY_TIMESTAMP_HEADER = "x-raft-replica-replay-timestamp";
const REPLAY_SIGNATURE_HEADER = "x-raft-replica-replay-signature";
const REPLAY_TIMEOUT_MS = parsePositiveInt(process.env.SLOCK_REPLICA_REPLAY_TIMEOUT_MS, 8_000);
const OWNER_HANDOFF_WAIT_MS = parsePositiveInt(process.env.SLOCK_MACHINE_OWNER_HANDOFF_WAIT_MS, 2_000);
const REPLAY_SIGNATURE_MAX_AGE_MS = 5 * 60 * 1000;

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

const REPLAY_CONTROL_HEADERS = new Set([
  REPLAY_MARKER_HEADER,
  REPLAY_MACHINE_HEADER,
  REPLAY_TIMESTAMP_HEADER,
  REPLAY_SIGNATURE_HEADER,
]);

const MACHINE_LOCAL_ROUTE_ALLOWLIST: Array<{ method: string; path: RegExp }> = [
  { method: "POST", path: /^\/api\/agents$/ },
  { method: "PATCH", path: /^\/api\/agents\/[^/]+$/ },
  { method: "POST", path: /^\/api\/agents\/[^/]+\/start$/ },
  {
    method: "POST",
    path: /^\/api\/agents\/[^/]+\/(?:assign-machine|migrate)$/,
  },
  { method: "GET", path: /^\/api\/agents\/[^/]+\/workspace-files$/ },
  { method: "GET", path: /^\/api\/agents\/[^/]+\/workspace-files\/read$/ },
  { method: "GET", path: /^\/api\/agents\/[^/]+\/skills$/ },
  { method: "DELETE", path: /^\/api\/servers\/[^/]+\/machines\/[^/]+$/ },
  { method: "POST", path: /^\/api\/servers\/[^/]+\/machines\/[^/]+\/computer\/(?:restart|upgrade)$/ },
  { method: "POST", path: /^\/api\/servers\/[^/]+\/machines\/[^/]+\/computer-lifecycle-operations$/ },
  { method: "GET", path: /^\/api\/servers\/[^/]+\/machines\/[^/]+\/workspaces$/ },
  { method: "GET", path: /^\/api\/servers\/[^/]+\/machines\/[^/]+\/runtime-models\/[^/]+$/ },
  { method: "GET", path: /^\/api\/servers\/[^/]+\/machines\/[^/]+\/runtime-form-definitions\/[^/]+\/option-sources\/[^/]+$/ },
  { method: "GET", path: /^\/api\/servers\/[^/]+\/machines\/[^/]+\/agents\/[^/]+\/diagnostic\/session-transcript$/ },
  { method: "POST", path: /^\/api\/servers\/[^/]+\/machines\/[^/]+\/agents\/[^/]+\/feedback\/[^/]+\/transcript$/ },
  { method: "DELETE", path: /^\/api\/servers\/[^/]+\/machines\/[^/]+\/workspaces\/[^/]+$/ },
];

type MachineAffinityRoute =
  | "local"
  | "aws_replay"
  | "fly_replay"
  | "owner_missing"
  | "owner_not_local"
  | "timeout"
  | "replay_failed"
  | "not_allowed";

type ReplayFailureKind = "timeout" | "replay_failed";
type ReplayAttempt =
  | { kind: "response"; response: globalThis.Response; body: Buffer }
  | { kind: ReplayFailureKind; errorClass?: string };

export interface MachineLocalRoutingDeps {
  getReplayTarget(machineId: string): Promise<MachineReplicaReplayTarget | null>;
  clearOwner(
    machineId: string,
    expectedReplicaId: string,
    expectedGeneration: string,
    expectedVersion: string,
    expectedEndpoint?: string,
  ): Promise<"deleted" | "mismatch" | "missing">;
  getFlyInstance(machineId: string): Promise<string | null>;
  fetch(input: string | URL, init?: RequestInit): Promise<globalThis.Response>;
  sleep(ms: number): Promise<void>;
}

export type MachineLocalRoutingResult = "handled" | "confirmed_local" | "not_routed";

const defaultRoutingDeps: MachineLocalRoutingDeps = {
  getReplayTarget: getMachineReplicaReplayTarget,
  clearOwner: clearMachineReplicaOwnerIfMatches,
  getFlyInstance: getFlyInstanceForMachine,
  fetch: (input, init) => fetch(input, init),
  sleep: (ms) => new Promise((resolve) => setClockTimeout(resolve, ms)),
};

export function isMachineLocalReplayAllowed(method: string, originalUrl: string): boolean {
  const pathname = getPathname(originalUrl);
  const normalizedMethod = method.toUpperCase();
  return MACHINE_LOCAL_ROUTE_ALLOWLIST.some((entry) => entry.method === normalizedMethod && entry.path.test(pathname));
}

export async function handleMachineLocalRouting(
  req: Request,
  res: Response,
  machineId: string,
  machineLocal: boolean | (() => boolean),
  deps: MachineLocalRoutingDeps = defaultRoutingDeps,
): Promise<MachineLocalRoutingResult> {
  const isMachineLocal = typeof machineLocal === "function" ? machineLocal : () => machineLocal;
  if (!isMachineLocalReplayAllowed(req.method, req.originalUrl || req.url)) {
    addMachineAffinityTrace("not_allowed", machineId);
    return "not_routed";
  }

  const incomingReplay = verifyIncomingReplay(req, machineId);
  if (isMachineLocal()) {
    if (incomingReplay === "invalid") {
      addMachineAffinityTrace("owner_not_local", machineId, { replay_signature_valid: false });
      res.status(400).json({
        error: "Invalid internal replay signature",
        code: "invalid_replica_replay_signature",
        machineAffinityRoute: "owner_not_local",
      });
      return "handled";
    }
    addMachineAffinityTrace("local", machineId, { replay_request: incomingReplay === "valid" });
    return "confirmed_local";
  }

  if (incomingReplay === "valid") {
    addMachineAffinityTrace("owner_not_local", machineId);
    res.status(409).json({
      error: "Machine is not connected to this replica",
      code: "machine_owner_not_local",
      machineAffinityRoute: "owner_not_local",
    });
    return "handled";
  }
  if (incomingReplay === "invalid") {
    addMachineAffinityTrace("owner_not_local", machineId, { replay_signature_valid: false });
    res.status(400).json({
      error: "Invalid internal replay signature",
      code: "invalid_replica_replay_signature",
      machineAffinityRoute: "owner_not_local",
    });
    return "handled";
  }

  let replayTarget = await deps.getReplayTarget(machineId);
  let allowHandoffWait = true;
  let allowReplacementReread = true;
  if (replayTarget?.currentReplica) {
    if (isMachineLocal()) return "confirmed_local";

    const clearedTarget = replayTarget;
    await clearUnbackedCurrentReplicaOwner(machineId, clearedTarget, deps);
    if (!isIdempotentRead(req.method)) return "not_routed";

    // The stale local snapshot consumed the same one-successor discovery
    // budget used after a failed remote replay. Do not turn its replacement
    // into a new two-hop replay chain.
    replayTarget = await deps.getReplayTarget(machineId);
    allowHandoffWait = false;
    allowReplacementReread = false;
    if (replayTarget?.currentReplica) {
      if (isMachineLocal()) return "confirmed_local";
      if (!sameReplayTargetSnapshot(replayTarget, clearedTarget)) {
        await clearUnbackedCurrentReplicaOwner(machineId, replayTarget, deps);
      }
      return "not_routed";
    }
  }

  // A graceful disconnect intentionally leaves a bounded handoff gap. One
  // delayed authoritative reread keeps the first request from converting that
  // expected gap into an immediate owner_missing response.
  if (!replayTarget?.endpoint && allowHandoffWait) {
    await deps.sleep(OWNER_HANDOFF_WAIT_MS);
    replayTarget = await deps.getReplayTarget(machineId);
    if (replayTarget?.currentReplica) {
      if (isMachineLocal()) return "confirmed_local";
      await clearUnbackedCurrentReplicaOwner(machineId, replayTarget, deps);
      return "not_routed";
    }
  }

  if (replayTarget?.endpoint) {
    return routeToReplica(req, res, machineId, {
      ...replayTarget,
      endpoint: replayTarget.endpoint,
    }, isMachineLocal, allowReplacementReread, deps);
  }

  const flyInstance = await deps.getFlyInstance(machineId);
  if (flyInstance) {
    addMachineAffinityTrace("fly_replay", machineId, { fly_instance_present: true });
    res.set("fly-replay", `instance=${flyInstance}`);
    res.status(307).end();
    return "handled";
  }

  return "not_routed";
}

export function sendMachineAffinityUnavailable(
  res: Response,
  machineId: string,
  status = 503,
  code = "machine_affinity_unavailable",
): void {
  addMachineAffinityTrace("owner_missing", machineId);
  res.status(status).json({
    error: "Machine is not connected to this server replica",
    code,
    machineAffinityRoute: "owner_missing",
  });
}

function addMachineAffinityTrace(route: MachineAffinityRoute, machineId: string, attrs: Record<string, unknown> = {}) {
  addTraceEvent("machine.affinity.routed", {
    machine_affinity_route: route,
    machine_id_present: Boolean(machineId),
    ...attrs,
  });
}

async function clearUnbackedCurrentReplicaOwner(
  machineId: string,
  target: MachineReplicaReplayTarget,
  deps: MachineLocalRoutingDeps,
): Promise<void> {
  const clearResult = await deps.clearOwner(
    machineId,
    target.replicaId,
    target.generation,
    target.version,
    target.endpoint ?? undefined,
  );
  addMachineAffinityTrace("owner_missing", machineId, {
    owner_replica_present: true,
    current_replica_without_live_socket: true,
    stale_owner_clear_result: clearResult,
  });
}

function sameReplayTargetSnapshot(
  left: MachineReplicaReplayTarget,
  right: MachineReplicaReplayTarget,
): boolean {
  return left.replicaId === right.replicaId &&
    left.generation === right.generation &&
    left.version === right.version &&
    left.endpoint === right.endpoint;
}

async function replayToReplica(
  req: Request,
  machineId: string,
  target: MachineReplicaReplayTarget & { endpoint: string },
  deps: MachineLocalRoutingDeps,
): Promise<ReplayAttempt> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REPLAY_TIMEOUT_MS);
  try {
    const targetUrl = new URL(req.originalUrl || req.url, target.endpoint);
    const body = serializeReplayBody(req);
    const response = await deps.fetch(targetUrl, {
      method: req.method,
      headers: buildReplayHeaders(req, machineId, body),
      body,
      redirect: "manual",
      signal: controller.signal,
    });
    const buffer = response.status === 204 || response.status === 304
      ? Buffer.alloc(0)
      : Buffer.from(await response.arrayBuffer());
    return { kind: "response", response, body: buffer };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { kind: "timeout" };
    }
    return { kind: "replay_failed", errorClass: error instanceof Error ? error.name : typeof error };
  } finally {
    clearTimeout(timer);
  }
}

async function routeToReplica(
  req: Request,
  res: Response,
  machineId: string,
  target: MachineReplicaReplayTarget & { endpoint: string },
  isMachineLocal: () => boolean,
  allowReplacementReread: boolean,
  deps: MachineLocalRoutingDeps,
): Promise<MachineLocalRoutingResult> {
  const first = await replayToReplica(req, machineId, target, deps);
  if (first.kind === "response" && !isOwnerNotLocalResponse(first)) {
    sendReplayResponse(first, res);
    addMachineAffinityTrace("aws_replay", machineId, {
      owner_replica_present: true,
      replay_status: first.response.status,
    });
    return "handled";
  }

  const failureKind: ReplayFailureKind | "owner_not_local" = first.kind === "response"
    ? "owner_not_local"
    : first.kind;
  const clearResult = await deps.clearOwner(
    machineId,
    target.replicaId,
    target.generation,
    target.version,
    target.endpoint,
  );
  addMachineAffinityTrace(failureKind, machineId, {
    owner_replica_present: true,
    stale_owner_clear_result: clearResult,
    ...(first.kind === "replay_failed" ? { error_class: first.errorClass } : {}),
  });

  if (!isIdempotentRead(req.method) || !allowReplacementReread) {
    sendReplayFailure(first, res);
    return "handled";
  }

  const replacement = await deps.getReplayTarget(machineId);
  if (replacement?.currentReplica) {
    if (isMachineLocal()) return "confirmed_local";
    await clearUnbackedCurrentReplicaOwner(machineId, replacement, deps);
    return "not_routed";
  }
  if (
    replacement?.endpoint &&
    (
      replacement.replicaId !== target.replicaId ||
      replacement.generation !== target.generation ||
      replacement.version !== target.version
    )
  ) {
    const second = await replayToReplica(req, machineId, {
      ...replacement,
      endpoint: replacement.endpoint,
    }, deps);
    if (second.kind === "response" && !isOwnerNotLocalResponse(second)) {
      sendReplayResponse(second, res);
      addMachineAffinityTrace("aws_replay", machineId, {
        owner_replica_present: true,
        replay_status: second.response.status,
        replay_rerouted: true,
      });
      return "handled";
    }
    const secondFailureKind: ReplayFailureKind | "owner_not_local" = second.kind === "response"
      ? "owner_not_local"
      : second.kind;
    const secondClearResult = await deps.clearOwner(
      machineId,
      replacement.replicaId,
      replacement.generation,
      replacement.version,
      replacement.endpoint,
    );
    addMachineAffinityTrace(secondFailureKind, machineId, {
      owner_replica_present: true,
      replay_rerouted: true,
      stale_owner_clear_result: secondClearResult,
      ...(second.kind === "replay_failed" ? { error_class: second.errorClass } : {}),
    });
    sendReplayFailure(second, res);
    return "handled";
  }

  sendReplayFailure(first, res);
  return "handled";
}

function isIdempotentRead(method: string): boolean {
  return method.toUpperCase() === "GET" || method.toUpperCase() === "HEAD";
}

function isOwnerNotLocalResponse(attempt: Extract<ReplayAttempt, { kind: "response" }>): boolean {
  if (attempt.response.status !== 409) return false;
  try {
    const parsed = JSON.parse(attempt.body.toString("utf8")) as { code?: unknown };
    return parsed.code === "machine_owner_not_local";
  } catch {
    return false;
  }
}

function sendReplayResponse(
  attempt: Extract<ReplayAttempt, { kind: "response" }>,
  res: Response,
): void {
  copyReplayResponseHeaders(attempt.response, res);
  res.status(attempt.response.status);
  if (attempt.response.status === 204 || attempt.response.status === 304) {
    res.end();
    return;
  }
  res.send(attempt.body);
}

function sendReplayFailure(attempt: ReplayAttempt, res: Response): void {
  if (attempt.kind === "response") {
    sendReplayResponse(attempt, res);
    return;
  }
  if (attempt.kind === "timeout") {
    res.status(504).json({
      error: "Timed out routing request to machine owner replica",
      code: "machine_affinity_replay_timeout",
      machineAffinityRoute: "timeout",
    });
    return;
  }
  res.status(503).json({
    error: "Failed to route request to machine owner replica",
    code: "machine_affinity_replay_failed",
    machineAffinityRoute: "replay_failed",
  });
}

export function buildReplayHeaders(req: Request, machineId: string, body: BodyInit | undefined): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower) || REPLAY_CONTROL_HEADERS.has(lower)) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  if (body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const activeTraceContext = getCurrentTraceContext();
  if (activeTraceContext) {
    // Bind the owner-replica server span to this exact ingress span. Forwarding
    // the client's original traceparent would only create sibling spans and a
    // normal browser request has no traceparent at all.
    headers.set("traceparent", formatTraceparent(activeTraceContext));
  }
  const timestamp = String(Date.now());
  headers.set(REPLAY_MARKER_HEADER, "1");
  headers.set(REPLAY_MACHINE_HEADER, machineId);
  headers.set(REPLAY_TIMESTAMP_HEADER, timestamp);
  headers.set(REPLAY_SIGNATURE_HEADER, signReplay(req.method, getPathnameWithSearch(req.originalUrl || req.url), machineId, timestamp));
  return headers;
}

function copyReplayResponseHeaders(response: globalThis.Response, res: Response): void {
  for (const [name, value] of response.headers) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower)) continue;
    res.setHeader(name, value);
  }
}

function serializeReplayBody(req: Request): BodyInit | undefined {
  if (req.method === "GET" || req.method === "HEAD") return undefined;
  const body = req.body;
  if (body === undefined || body === null) return undefined;
  if (Buffer.isBuffer(body)) return new Uint8Array(body);
  if (typeof body === "string") return body;
  if (typeof body === "object" && Object.keys(body).length === 0) return undefined;
  return JSON.stringify(body);
}

function verifyIncomingReplay(req: Request, machineId: string): "absent" | "valid" | "invalid" {
  if (getHeader(req, REPLAY_MARKER_HEADER) !== "1") return "absent";
  const replayMachineId = getHeader(req, REPLAY_MACHINE_HEADER);
  const timestamp = getHeader(req, REPLAY_TIMESTAMP_HEADER);
  const signature = getHeader(req, REPLAY_SIGNATURE_HEADER);
  if (!replayMachineId || !timestamp || !signature || replayMachineId !== machineId) return "invalid";
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > REPLAY_SIGNATURE_MAX_AGE_MS) return "invalid";
  const expected = signReplay(req.method, getPathnameWithSearch(req.originalUrl || req.url), machineId, timestamp);
  return timingSafeEqualString(signature, expected) ? "valid" : "invalid";
}

function signReplay(method: string, pathWithSearch: string, machineId: string, timestamp: string): string {
  return createHmac("sha256", getReplaySecret())
    .update(method.toUpperCase())
    .update("\n")
    .update(pathWithSearch)
    .update("\n")
    .update(machineId)
    .update("\n")
    .update(timestamp)
    .digest("hex");
}

function getReplaySecret(): string {
  // server.ts requires JWT_SECRET during startup; the fallback only keeps
  // focused unit imports from throwing before the full server bootstrap runs.
  return process.env.SLOCK_REPLICA_REPLAY_SECRET || process.env.JWT_SECRET || "test-replica-replay-secret";
}

function timingSafeEqualString(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function getHeader(req: Request, name: string): string | null {
  const value = req.headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function getPathname(originalUrl: string): string {
  try {
    return new URL(originalUrl, "http://localhost").pathname;
  } catch {
    return originalUrl.split("?")[0] || "/";
  }
}

function getPathnameWithSearch(originalUrl: string): string {
  try {
    const url = new URL(originalUrl, "http://localhost");
    return `${url.pathname}${url.search}`;
  } catch {
    return originalUrl.startsWith("/") ? originalUrl : `/${originalUrl}`;
  }
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}
