import { makeIsMember } from "@botiverse/raft-shared";

// Single source of truth: the literal tuple derives both the type and the
// runtime guard, so the union and the validator can never drift apart.
export const AGENT_O11Y_EVENT_KINDS = ["turn", "step", "observation"] as const;
export type AgentO11yEventKind = (typeof AGENT_O11Y_EVENT_KINDS)[number];
export const AGENT_O11Y_PAYLOAD_TIERS = ["T0", "T1", "T2"] as const;
export type AgentO11yPayloadTier = (typeof AGENT_O11Y_PAYLOAD_TIERS)[number];

export type AgentO11yJsonValue =
  | string
  | number
  | boolean
  | null
  | AgentO11yJsonValue[]
  | { [key: string]: AgentO11yJsonValue };

export type AgentO11yEventFields = Record<string, AgentO11yJsonValue>;

export interface AgentO11yAcceptedEvent {
  event_kind: AgentO11yEventKind;
  agent_id: string;
  turn_id: string;
  occurred_at: string;
  payload_tier: AgentO11yPayloadTier;
  turn_trigger_hash?: string;
  step_input_hash?: string;
  fields?: AgentO11yEventFields;
}

export interface AgentO11yRejected {
  ok: false;
  status: number;
  code: string;
  message: string;
}

export interface AgentO11yValidatedBatch {
  ok: true;
  events: AgentO11yAcceptedEvent[];
}

const isAgentO11yEventKind = makeIsMember(AGENT_O11Y_EVENT_KINDS);
const isAgentO11yPayloadTier = makeIsMember(AGENT_O11Y_PAYLOAD_TIERS);
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

const UUIDISH_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function getAgentO11yMaxEventsPerBatch(): number {
  const raw = Number(process.env.AGENT_O11Y_MAX_EVENTS_PER_BATCH ?? 500);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 500;
}

export function getAgentO11yMaxBatchBytes(): number {
  const raw = Number(process.env.AGENT_O11Y_MAX_BATCH_BYTES ?? 1_000_000);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 1_000_000;
}

export function validateAgentO11yBatch(body: unknown): AgentO11yValidatedBatch | AgentO11yRejected {
  if (!isRecord(body)) {
    return reject(400, "agent_o11y_invalid_batch", "body must be an object");
  }
  try {
    assertNoForbiddenCarrierShape(body, []);
    assertNoForbiddenStaleWireShape(body, []);
    assertNoForbiddenTenantShape(body, []);
  } catch (err) {
    const normalized = normalizeAgentO11yValidationError(err);
    if (normalized) return normalized;
    throw err;
  }

  if (!Array.isArray(body.events) || body.events.length === 0) {
    return reject(400, "agent_o11y_invalid_batch", "events must be a non-empty array");
  }
  if (body.events.length > getAgentO11yMaxEventsPerBatch()) {
    return reject(413, "agent_o11y_batch_too_large", "too many events in batch");
  }
  const bodyBytes = Buffer.byteLength(JSON.stringify(body), "utf8");
  if (bodyBytes > getAgentO11yMaxBatchBytes()) {
    return reject(413, "agent_o11y_batch_too_large", "batch body too large");
  }

  const events: AgentO11yAcceptedEvent[] = [];
  for (let i = 0; i < body.events.length; i++) {
    const result = validateAgentO11yEvent(body.events[i], i);
    if (!result.ok) return result;
    events.push(result.event);
  }
  return { ok: true, events };
}

function validateAgentO11yEvent(value: unknown, index: number): { ok: true; event: AgentO11yAcceptedEvent } | AgentO11yRejected {
  if (!isRecord(value)) {
    return reject(400, "agent_o11y_invalid_event", `events[${index}] must be an object`);
  }

  const eventKind = value.event_kind;
  if (!isAgentO11yEventKind(eventKind)) {
    return reject(400, "agent_o11y_invalid_event", `events[${index}].event_kind must be turn, step, or observation`);
  }

  const agentId = value.agent_id;
  if (!isNonEmptyString(agentId) || !UUIDISH_RE.test(agentId)) {
    return reject(400, "agent_o11y_invalid_event", `events[${index}].agent_id must be a UUID string`);
  }

  const turnId = value.turn_id;
  if (!isNonEmptyString(turnId)) {
    return reject(400, "agent_o11y_invalid_event", `events[${index}].turn_id must be a non-empty string`);
  }

  const occurredAt = value.occurred_at;
  if (!isNonEmptyString(occurredAt) || Number.isNaN(Date.parse(occurredAt))) {
    return reject(400, "agent_o11y_invalid_event", `events[${index}].occurred_at must be an ISO timestamp string`);
  }

  const payloadTier = value.payload_tier === undefined ? "T0" : value.payload_tier;
  if (!isAgentO11yPayloadTier(payloadTier)) {
    return reject(400, "agent_o11y_invalid_event", `events[${index}].payload_tier must be T0, T1, or T2`);
  }

  const rawPayloadError = findRawPayloadInNonRawMode(value, payloadTier, []);
  if (rawPayloadError) {
    return reject(400, "agent_o11y_invalid_event", `${rawPayloadError} is not allowed for payload_tier=${payloadTier}`);
  }

  const turnTriggerHash = value.turn_trigger_hash;
  if (turnTriggerHash !== undefined && !isNonEmptyString(turnTriggerHash)) {
    return reject(400, "agent_o11y_invalid_event", `events[${index}].turn_trigger_hash must be a non-empty string`);
  }

  const stepInputHash = value.step_input_hash;
  if (stepInputHash !== undefined && !isNonEmptyString(stepInputHash)) {
    return reject(400, "agent_o11y_invalid_event", `events[${index}].step_input_hash must be a non-empty string`);
  }

  const fields = value.fields;
  if (fields !== undefined && !isPlainJsonObject(fields)) {
    return reject(400, "agent_o11y_invalid_event", `events[${index}].fields must be a JSON object`);
  }

  return {
    ok: true,
    event: {
      event_kind: eventKind,
      agent_id: agentId,
      turn_id: turnId,
      occurred_at: occurredAt,
      payload_tier: payloadTier,
      ...(turnTriggerHash !== undefined ? { turn_trigger_hash: turnTriggerHash as string } : {}),
      ...(stepInputHash !== undefined ? { step_input_hash: stepInputHash as string } : {}),
      ...(fields !== undefined ? { fields } : {}),
    },
  };
}

function reject(status: number, code: string, message: string): AgentO11yRejected {
  return { ok: false, status, code, message };
}

function assertNoForbiddenCarrierShape(value: unknown, path: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoForbiddenCarrierShape(entry, [...path, String(index)]));
    return;
  }
  if (!isRecord(value)) return;

  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_CARRIER_KEYS.has(key)) {
      throw new AgentO11yValidationPanic(`forbidden carrier field ${[...path, key].join(".")}`);
    }
    if (key === "metadata" && isRecord(child) && "turn_id" in child) {
      throw new AgentO11yValidationPanic("turn_id must be top-level, not metadata.turn_id");
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
      throw new AgentO11yValidationPanic(`stale wire field ${[...path, key].join(".")} is not allowed`);
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
      throw new AgentO11yValidationPanic(`tenant identity field ${[...path, key].join(".")} is not allowed`);
    }
    assertNoForbiddenTenantShape(child, [...path, key]);
  }
}

function findRawPayloadInNonRawMode(value: unknown, payloadTier: string, path: string[]): string | null {
  if (payloadTier === "T2") return null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const found = findRawPayloadInNonRawMode(value[i], payloadTier, [...path, String(i)]);
      if (found) return found;
    }
    return null;
  }
  if (!isRecord(value)) return null;

  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_RAW_PAYLOAD_KEYS.has(key) || key.endsWith("_payload")) {
      return `raw payload field ${[...path, key].join(".")}`;
    }
    const found = findRawPayloadInNonRawMode(child, payloadTier, [...path, key]);
    if (found) return found;
  }
  return null;
}

class AgentO11yValidationPanic extends Error {}

export function normalizeAgentO11yValidationError(err: unknown): AgentO11yRejected | null {
  if (!(err instanceof AgentO11yValidationPanic)) return null;
  return reject(400, "agent_o11y_invalid_event", err.message);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
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
    case "boolean":
      return true;
    case "number":
      return Number.isFinite(value);
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
