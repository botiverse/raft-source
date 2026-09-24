import { daemonFetch } from "./daemonFetch.js";

export const AGENT_O11Y_EVENTS_PATH = "/internal/computer/agent-o11y/events";

export type AgentO11yEventKind = "turn" | "step" | "observation";
export type AgentO11yPayloadTier = "T0" | "T1" | "T2";

export type AgentO11yJsonValue =
  | string
  | number
  | boolean
  | null
  | AgentO11yJsonValue[]
  | { [key: string]: AgentO11yJsonValue };

export type AgentO11yEventFields = Record<string, AgentO11yJsonValue>;

export interface BuildAgentO11yDaemonEventInput {
  event_kind: AgentO11yEventKind;
  agent_id: string;
  turn_id: string;
  occurred_at?: string;
  payload_tier?: AgentO11yPayloadTier;
  turn_trigger_hash?: string;
  step_input_hash?: string;
  fields?: AgentO11yEventFields;
}

export interface AgentO11yDaemonEvent extends BuildAgentO11yDaemonEventInput {
  occurred_at: string;
}

export interface AgentO11yEventBatch {
  events: AgentO11yDaemonEvent[];
}

export type AgentO11yPostResult =
  | { ok: true; status: number; accepted: number | null }
  | { ok: false; status: number | null; code: string; message: string; retryable: boolean };

export type AgentO11yFetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface AgentO11yDaemonClientOptions {
  serverUrl: string;
  daemonApiKey: string;
  fetchImpl?: AgentO11yFetchLike;
}

const FORBIDDEN_CARRIER_KEYS = new Set(["turnId", "runtime_turn_id"]);
const FORBIDDEN_STALE_WIRE_KEYS = new Set(["payload_mode"]);
const FORBIDDEN_TENANT_KEYS = new Set([
  "computerId",
  "computer_id",
  "machineId",
  "machine_id",
  "serverId",
  "server_id",
]);
const FORBIDDEN_RAW_PAYLOAD_KEYS = new Set([
  "content",
  "input",
  "message",
  "output",
  "payload",
  "prompt",
  "raw_payload",
  "response",
]);

export class AgentO11yFastCheckError extends Error {
  readonly code = "daemon_o11y_fast_check_failed";

  constructor(message: string) {
    super(message);
    this.name = "AgentO11yFastCheckError";
  }
}

export function buildAgentO11yDaemonEvent(input: BuildAgentO11yDaemonEventInput): AgentO11yDaemonEvent {
  const event: AgentO11yDaemonEvent = {
    ...input,
    occurred_at: input.occurred_at ?? new Date().toISOString(),
  };
  assertAgentO11yEventFastCheck(event);
  return event;
}

export function assertAgentO11yEventFastCheck(event: unknown): asserts event is AgentO11yDaemonEvent {
  if (!isRecord(event)) {
    throw new AgentO11yFastCheckError("event must be an object");
  }
  assertNoForbiddenCarrierShape(event, []);
  assertNoForbiddenStaleWireShape(event, []);
  assertNoForbiddenTenantShape(event, []);

  if (!["turn", "step", "observation"].includes(String(event.event_kind))) {
    throw new AgentO11yFastCheckError("event_kind must be turn, step, or observation");
  }
  assertNonEmptyString(event.agent_id, "agent_id");
  assertNonEmptyString(event.turn_id, "turn_id");
  assertNonEmptyString(event.occurred_at, "occurred_at");

  if (event.payload_tier !== undefined && !["T0", "T1", "T2"].includes(String(event.payload_tier))) {
    throw new AgentO11yFastCheckError("payload_tier must be T0, T1, or T2");
  }
  assertNoRawPayloadInNonRawMode(event, String(event.payload_tier ?? "T0"));
  if (event.turn_trigger_hash !== undefined) assertNonEmptyString(event.turn_trigger_hash, "turn_trigger_hash");
  if (event.step_input_hash !== undefined) assertNonEmptyString(event.step_input_hash, "step_input_hash");
  if (event.fields !== undefined && !isPlainJsonObject(event.fields)) {
    throw new AgentO11yFastCheckError("fields must be a JSON object");
  }
}

export function assertAgentO11yBatchFastCheck(events: readonly unknown[]): asserts events is AgentO11yDaemonEvent[] {
  if (!Array.isArray(events) || events.length === 0) {
    throw new AgentO11yFastCheckError("events must be a non-empty array");
  }
  for (const event of events) {
    assertAgentO11yEventFastCheck(event);
  }
}

export class AgentO11yDaemonClient {
  private readonly options: AgentO11yDaemonClientOptions;
  private readonly fetchImpl: AgentO11yFetchLike;

  constructor(options: AgentO11yDaemonClientOptions) {
    this.options = options;
    this.fetchImpl = options.fetchImpl ?? daemonFetch;
  }

  async postEvents(events: readonly AgentO11yDaemonEvent[]): Promise<AgentO11yPostResult> {
    try {
      assertAgentO11yBatchFastCheck(events);
    } catch (err) {
      return {
        ok: false,
        status: null,
        code: err instanceof AgentO11yFastCheckError ? err.code : "daemon_o11y_fast_check_failed",
        message: err instanceof Error ? err.message : String(err),
        retryable: false,
      };
    }

    try {
      const res = await this.fetchImpl(new URL(AGENT_O11Y_EVENTS_PATH, this.options.serverUrl).toString(), {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.options.daemonApiKey}`,
          "Content-Type": "application/json",
          "X-Raft-Client": "daemon-agent-o11y",
        },
        body: JSON.stringify({ events } satisfies AgentO11yEventBatch),
      });

      const body = await readJsonBody(res);
      if (res.ok) {
        return {
          ok: true,
          status: res.status,
          accepted: typeof body?.accepted === "number" ? body.accepted : null,
        };
      }

      const code = typeof body?.code === "string" ? body.code : `http_${res.status}`;
      const message = typeof body?.message === "string"
        ? body.message
        : typeof body?.error === "string"
          ? body.error
          : `HTTP ${res.status}`;
      return {
        ok: false,
        status: res.status,
        code,
        message,
        retryable: res.status >= 500,
      };
    } catch (err) {
      return {
        ok: false,
        status: null,
        code: "agent_o11y_events_request_failed",
        message: err instanceof Error ? err.message : String(err),
        retryable: true,
      };
    }
  }
}

async function readJsonBody(res: Response): Promise<Record<string, unknown> | null> {
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return null;
  return await res.json().catch(() => null) as Record<string, unknown> | null;
}

function assertNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new AgentO11yFastCheckError(`${field} must be a non-empty string`);
  }
}

function assertNoForbiddenCarrierShape(value: unknown, path: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoForbiddenCarrierShape(entry, [...path, String(index)]));
    return;
  }
  if (!isRecord(value)) return;

  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_CARRIER_KEYS.has(key)) {
      throw new AgentO11yFastCheckError(`forbidden carrier field ${[...path, key].join(".")}`);
    }
    if (key === "metadata" && isRecord(child) && "turn_id" in child) {
      throw new AgentO11yFastCheckError("turn_id must be top-level, not metadata.turn_id");
    }
    assertNoForbiddenCarrierShape(child, [...path, key]);
  }
}

function assertNoForbiddenStaleWireShape(value: unknown, path: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoForbiddenStaleWireShape(entry, [...path, String(index)]));
    return;
  }
  if (!isRecord(value)) return;

  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_STALE_WIRE_KEYS.has(key)) {
      throw new AgentO11yFastCheckError(`stale wire field ${[...path, key].join(".")} is not allowed`);
    }
    assertNoForbiddenStaleWireShape(child, [...path, key]);
  }
}

function assertNoForbiddenTenantShape(value: unknown, path: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoForbiddenTenantShape(entry, [...path, String(index)]));
    return;
  }
  if (!isRecord(value)) return;

  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_TENANT_KEYS.has(key)) {
      throw new AgentO11yFastCheckError(`tenant identity field ${[...path, key].join(".")} is not allowed`);
    }
    assertNoForbiddenTenantShape(child, [...path, key]);
  }
}

function assertNoRawPayloadInNonRawMode(value: unknown, payloadTier: string, path: string[] = []): void {
  if (payloadTier === "T2") return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoRawPayloadInNonRawMode(entry, payloadTier, [...path, String(index)]));
    return;
  }
  if (!isRecord(value)) return;

  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_RAW_PAYLOAD_KEYS.has(key) || key.endsWith("_payload")) {
      throw new AgentO11yFastCheckError(`raw payload field ${[...path, key].join(".")} is not allowed for payload_tier=${payloadTier}`);
    }
    assertNoRawPayloadInNonRawMode(child, payloadTier, [...path, key]);
  }
}

function isPlainJsonObject(value: unknown): value is AgentO11yEventFields {
  if (!isRecord(value) || Array.isArray(value)) return false;
  for (const child of Object.values(value)) {
    if (!isJsonValue(child)) return false;
  }
  return true;
}

function isJsonValue(value: unknown): value is AgentO11yJsonValue {
  if (value === null) return true;
  switch (typeof value) {
    case "string":
    case "number":
    case "boolean":
      return Number.isFinite(value) || typeof value !== "number";
    case "object":
      if (Array.isArray(value)) return value.every(isJsonValue);
      return isPlainJsonObject(value);
    default:
      return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
