import type { CliReplyText } from "../../core/renderer.js";
import { formatIntegrationErrorV1, formatIntegrationReceiptV1 } from "./_format.js";
// Re-export for existing importers; canonical home is integration/_format.ts.
export { formatIntegrationErrorV1, formatIntegrationReceiptV1 } from "./_format.js";
import { randomUUID } from "node:crypto";

import { currentDate } from "@botiverse/raft-shared";

import type { AgentContext } from "../../auth/env.js";
import { CliError, type CliErrorCode } from "../../core/errors.js";
import type { RegisteredIntegrationService } from "./_format.js";
import { cookieHeaderForUrl, type SessionCookie } from "./_session.js";
import {
  actionContractDigest,
  buildV1RequestPlan,
  effectiveContractDigest,
  evaluateReadbackAssertions,
  manifestDigest,
  mapReadbackInput,
  requestBindingDigest,
  resolveRegisteredActionBaseUrl,
  validateV1Input,
  validateV1Output,
  V1RequestInputError,
} from "./actionV1.js";
import {
  finalizeInvocationAttemptV1,
  InvocationStoreError,
  prepareInvocationAttemptV1,
  type InvocationRecordV1,
} from "./invocationStoreV1.js";
import type { AgentManifestActionV1, AgentManifestV1, JsonValue } from "./manifestV1.js";
import type {
  IntegrationAuthorityStatusV1,
  IntegrationReadbackStatusV1,
  IntegrationResponseSchemaStatusV1,
  IntegrationTransportStatusV1,
} from "./readinessV1.js";

const MAX_ACTION_RESPONSE_BYTES = 1024 * 1024;

export type IntegrationOperationStatusV1 =
  | "blocked"
  | "accepted_unverified"
  | "verified"
  | "failed"
  | "indeterminate";

export interface IntegrationActionReceiptV1 {
  schema: "raft-integration-action-receipt.v1";
  receipt_id: string;
  observed_at: string;
  actor: {
    kind: "agent";
    id: string;
  };
  target: {
    server_id: string;
    integration_id: string;
    service_id: string;
    registered_base_url: string;
    manifest_sha256: string;
    effective_contract_sha256: string;
  };
  invocation: {
    id: string;
    attempt: number;
    retry_of_receipt_id: string | null;
  };
  action: {
    name: string;
    effect: AgentManifestActionV1["effect"];
    action_contract_sha256: string;
  };
  authority: {
    status: IntegrationAuthorityStatusV1;
  };
  idempotency:
    | { mode: "safe" | "idempotent" | "non_idempotent" }
    | {
        mode: "key_required";
        scope: "actor_action";
        key_sha256: string;
      };
  transport: {
    status: Exclude<IntegrationTransportStatusV1, "not_attempted">;
    http_status: number | null;
    request_id: string | null;
  };
  response_schema: {
    status: IntegrationResponseSchemaStatusV1;
  };
  readback: {
    status: IntegrationReadbackStatusV1;
    receipt_id: string | null;
  };
  operation: {
    status: IntegrationOperationStatusV1;
  };
  rollback: {
    mode: AgentManifestActionV1["rollback"]["mode"];
    status: "not_applicable" | "not_run" | "succeeded" | "failed" | "indeterminate";
  };
  retryable: boolean;
  next_action: string;
}

export interface IntegrationErrorV1 {
  schema: "raft-integration-error.v1";
  code: string;
  message: string;
  service_id: string;
  action: string | null;
  effect: AgentManifestActionV1["effect"] | null;
  fault_domain:
    | "registry"
    | "manifest_discovery"
    | "manifest_transport"
    | "manifest_response"
    | "manifest_schema"
    | "manifest_policy"
    | "auth"
    | "authority"
    | "input_schema"
    | "action_transport"
    | "service"
    | "output_schema"
    | "operation"
    | "readback"
    | "rollback";
  retryable: boolean;
  evidence: {
    manifest: "valid" | "missing" | "invalid" | "unavailable" | "unreachable" | "not_configured" | "unchecked";
    auth: "session_present" | "not_ready" | "not_required" | "unknown" | "accepted" | "rejected";
    authority: IntegrationAuthorityStatusV1;
    transport: IntegrationTransportStatusV1;
    response_schema: IntegrationResponseSchemaStatusV1;
    readback: IntegrationReadbackStatusV1;
  };
  schema_path: string | null;
  http_status: number | null;
  request_id: string | null;
  next_action: string;
}

export class IntegrationV1Error extends CliError {
  readonly machinePayload: {
    ok: false;
    error: IntegrationErrorV1;
    receipt?: IntegrationActionReceiptV1;
  };
  readonly typedText: CliReplyText;
  outputMode: "text" | "json" = "text";

  constructor(
    public readonly envelope: IntegrationErrorV1,
    public readonly receipt?: IntegrationActionReceiptV1,
  ) {
    super({
      code: envelope.code as CliErrorCode,
      message: envelope.message,
      layer: envelope.fault_domain,
      retryable: envelope.retryable,
      suggestedNextAction: envelope.next_action,
    });
    this.name = "IntegrationV1Error";
    this.machinePayload = {
      ok: false,
      error: envelope,
      ...(receipt ? { receipt } : {}),
    };
    this.typedText = formatIntegrationErrorV1(envelope, receipt);
  }
}

export interface IntegrationV1InvocationResult {
  value: unknown;
  status: number;
  receipt: IntegrationActionReceiptV1;
  readbackReceipt?: IntegrationActionReceiptV1;
}

function typedError(input: {
  code: string;
  message: string;
  serviceId: string;
  action?: AgentManifestActionV1 | null;
  faultDomain: IntegrationErrorV1["fault_domain"];
  retryable: boolean;
  auth?: IntegrationErrorV1["evidence"]["auth"];
  authority?: IntegrationAuthorityStatusV1;
  transport?: IntegrationTransportStatusV1;
  responseSchema?: IntegrationResponseSchemaStatusV1;
  readback?: IntegrationReadbackStatusV1;
  schemaPath?: string | null;
  httpStatus?: number | null;
  requestId?: string | null;
  nextAction: string;
  receipt?: IntegrationActionReceiptV1;
}): IntegrationV1Error {
  return new IntegrationV1Error({
    schema: "raft-integration-error.v1",
    code: input.code,
    message: input.message.slice(0, 512),
    service_id: input.serviceId,
    action: input.action?.name ?? null,
    effect: input.action?.effect ?? null,
    fault_domain: input.faultDomain,
    retryable: input.retryable,
    evidence: {
      manifest: "valid",
      auth: input.auth ?? "session_present",
      authority: input.authority ?? "unknown",
      transport: input.transport ?? "not_attempted",
      response_schema: input.responseSchema ?? "not_run",
      readback: input.readback ?? "not_run",
    },
    schema_path: input.schemaPath ?? null,
    http_status: input.httpStatus ?? null,
    request_id: input.requestId ?? null,
    next_action: input.nextAction,
  }, input.receipt);
}

export function localCliDesignBlockedError(input: {
  serviceId: string;
  action?: string;
}): IntegrationV1Error {
  return new IntegrationV1Error({
    schema: "raft-integration-error.v1",
    code: "INTEGRATION_LOCAL_CLI_DESIGN_BLOCKED",
    message: "Local CLI actions and credential materialization are design-blocked.",
    service_id: input.serviceId,
    action: input.action ?? null,
    effect: null,
    fault_domain: "manifest_policy",
    retryable: false,
    evidence: {
      manifest: "valid",
      auth: "unknown",
      authority: "unknown",
      transport: "not_attempted",
      response_schema: "not_run",
      readback: "not_run",
    },
    schema_path: null,
    http_status: null,
    request_id: null,
    next_action: "Use the documented Web surface; no local command or credential handoff is available.",
  });
}

export function actionUndeclaredV1Error(input: {
  serviceId: string;
  action: string;
}): IntegrationV1Error {
  return new IntegrationV1Error({
    schema: "raft-integration-error.v1",
    code: "INTEGRATION_ACTION_UNDECLARED",
    message: `The validated manifest does not declare action ${input.action}.`,
    service_id: input.serviceId,
    action: input.action,
    effect: null,
    fault_domain: "manifest_policy",
    retryable: false,
    evidence: {
      manifest: "valid",
      auth: "unknown",
      authority: "unknown",
      transport: "not_attempted",
      response_schema: "not_run",
      readback: "not_run",
    },
    schema_path: null,
    http_status: null,
    request_id: null,
    next_action: "Choose one action declared by `raft integration invoke --list-actions`.",
  });
}

function retryableFor(action: AgentManifestActionV1): boolean {
  return action.idempotency.mode !== "non_idempotent";
}

function requestIdFromHeaders(headers: Headers): string | null {
  const value = headers.get("x-request-id") ?? headers.get("request-id");
  const normalized = value?.trim() ?? "";
  return /^[A-Za-z0-9._:-]{1,200}$/.test(normalized) ? normalized : null;
}

function retryAfterFromHeaders(headers: Headers): string | null {
  const normalized = headers.get("retry-after")?.trim() ?? "";
  return /^[A-Za-z0-9,: +.-]{1,128}$/.test(normalized) ? normalized : null;
}

async function boundedResponseBytes(response: Response): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > MAX_ACTION_RESPONSE_BYTES) {
        await reader.cancel("bounded action response size exceeded");
        throw new Error("service response exceeds the bounded action response size");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

async function boundedResponseValue(response: Response): Promise<unknown> {
  if (response.status === 204) return null;
  const declaredLength = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_ACTION_RESPONSE_BYTES) {
    throw new Error("service response exceeds the bounded action response size");
  }
  const body = await boundedResponseBytes(response);
  if (body.byteLength === 0) return null;
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(body.toString("utf8"));
    } catch {
      throw new Error("service returned malformed JSON");
    }
  }
  return body.toString("utf8");
}

function receiptIdempotency(record: InvocationRecordV1): IntegrationActionReceiptV1["idempotency"] {
  if (record.idempotencyMode === "key_required") {
    if (!record.keySha256 || record.idempotencyScope !== "actor_action") {
      throw new InvocationStoreError(
        "stored key_required invocation is missing its key digest or scope",
        "INTEGRATION_RETRY_BINDING_MISMATCH",
      );
    }
    return {
      mode: "key_required",
      scope: "actor_action",
      key_sha256: record.keySha256,
    };
  }
  return { mode: record.idempotencyMode };
}

function rollbackStatus(action: AgentManifestActionV1): IntegrationActionReceiptV1["rollback"] {
  return {
    mode: action.rollback.mode,
    status: action.rollback.mode === "not_applicable" ? "not_applicable" : "not_run",
  };
}

function buildReceipt(input: {
  actorContext: AgentContext;
  service: RegisteredIntegrationService;
  manifest: AgentManifestV1;
  action: AgentManifestActionV1;
  registeredBaseUrl: URL;
  effectiveContractSha256: string;
  invocation: InvocationRecordV1;
  authority: IntegrationAuthorityStatusV1;
  transport: Exclude<IntegrationTransportStatusV1, "not_attempted">;
  httpStatus?: number | null;
  requestId?: string | null;
  responseSchema: IntegrationResponseSchemaStatusV1;
  readback: IntegrationReadbackStatusV1;
  readbackReceiptId?: string | null;
  operation: IntegrationOperationStatusV1;
  retryable: boolean;
  nextAction: string;
  observedAt?: string;
  receiptId?: string;
}): IntegrationActionReceiptV1 {
  return {
    schema: "raft-integration-action-receipt.v1",
    receipt_id: input.receiptId ?? randomUUID(),
    observed_at: input.observedAt ?? currentDate().toISOString(),
    actor: {
      kind: "agent",
      id: input.actorContext.agentId,
    },
    target: {
      server_id: input.invocation.serverId,
      integration_id: input.service.id,
      service_id: input.service.clientId,
      registered_base_url: input.registeredBaseUrl.toString(),
      manifest_sha256: manifestDigest(input.manifest),
      effective_contract_sha256: input.effectiveContractSha256,
    },
    invocation: {
      id: input.invocation.invocationId,
      attempt: input.invocation.attempt,
      retry_of_receipt_id: input.invocation.lastReceiptId,
    },
    action: {
      name: input.action.name,
      effect: input.action.effect,
      action_contract_sha256: actionContractDigest(input.action),
    },
    authority: {
      status: input.authority,
    },
    idempotency: receiptIdempotency(input.invocation),
    transport: {
      status: input.transport,
      http_status: input.httpStatus ?? null,
      request_id: input.requestId ?? null,
    },
    response_schema: {
      status: input.responseSchema,
    },
    readback: {
      status: input.readback,
      receipt_id: input.readbackReceiptId ?? null,
    },
    operation: {
      status: input.operation,
    },
    rollback: rollbackStatus(input.action),
    retryable: input.retryable,
    next_action: input.nextAction,
  };
}

function finalizeReceipt(input: {
  actorContext: AgentContext;
  env: NodeJS.ProcessEnv;
  receipt: IntegrationActionReceiptV1;
}): void {
  const operation = input.receipt.operation.status;
  const state = operation === "blocked" ? "failed" : operation;
  try {
    finalizeInvocationAttemptV1({
      agentContext: input.actorContext,
      env: input.env,
      invocationId: input.receipt.invocation.id,
      attempt: input.receipt.invocation.attempt,
      receiptId: input.receipt.receipt_id,
      state,
    });
  } catch (error) {
    throw new IntegrationV1Error({
      schema: "raft-integration-error.v1",
      code: error instanceof InvocationStoreError
        ? error.code
        : "INTEGRATION_RETRY_PERSISTENCE_REQUIRED",
      message: error instanceof Error
        ? error.message.slice(0, 512)
        : "The invocation receipt could not be durably finalized.",
      service_id: input.receipt.target.service_id,
      action: input.receipt.action.name,
      effect: input.receipt.action.effect,
      fault_domain: "operation",
      retryable: false,
      evidence: {
        manifest: "valid",
        auth: input.receipt.transport.http_status === 401 ? "rejected" : "accepted",
        authority: input.receipt.authority.status,
        transport: input.receipt.transport.status,
        response_schema: input.receipt.response_schema.status,
        readback: input.receipt.readback.status,
      },
      schema_path: null,
      http_status: input.receipt.transport.http_status,
      request_id: input.receipt.transport.request_id,
      next_action: "Repair the private invocation-state carrier before any retry; the prior attempt remains fail-closed as dispatching.",
    }, input.receipt);
  }
}

function storeFailureError(input: {
  error: unknown;
  serviceId: string;
  action: AgentManifestActionV1;
}): IntegrationV1Error {
  const code = input.error instanceof InvocationStoreError
    ? input.error.code
    : "INTEGRATION_RETRY_PERSISTENCE_REQUIRED";
  return typedError({
    code,
    message: input.error instanceof Error ? input.error.message : "could not persist the invocation binding",
    serviceId: input.serviceId,
    action: input.action,
    faultDomain: "operation",
    retryable: false,
    transport: "not_sent",
    nextAction: "Restore the private invocation-state carrier before retrying; no action request was sent.",
  });
}

interface ManifestActionPreflightV1Input {
  actorContext: AgentContext;
  service: RegisteredIntegrationService;
  manifest: AgentManifestV1;
  action: AgentManifestActionV1;
  payload: Record<string, unknown>;
}

export function preflightManifestActionV1(input: ManifestActionPreflightV1Input): {
  canonicalServerId: string;
  plan: ReturnType<typeof buildV1RequestPlan>;
  registeredBaseUrl: URL;
} {
  const canonicalServerId = input.actorContext.serverId?.trim();
  if (!canonicalServerId) {
    throw typedError({
      code: "INTEGRATION_TARGET_INVALID",
      message: "The canonical platform server id is unavailable for this invocation.",
      serviceId: input.service.clientId,
      action: input.action,
      faultDomain: "registry",
      retryable: false,
      auth: "unknown",
      transport: "not_sent",
      nextAction: "Restore the agent's canonical server context before invoking this action.",
    });
  }
  const inputFailure = validateV1Input(input.action, input.payload);
  if (inputFailure) {
    throw typedError({
      code: "INTEGRATION_INPUT_INVALID",
      message: `Action input does not match the declared schema at ${inputFailure.path ?? "/"}.`,
      serviceId: input.service.clientId,
      action: input.action,
      faultDomain: "input_schema",
      retryable: false,
      auth: "unknown",
      schemaPath: inputFailure.path,
      nextAction: "Correct the bounded action input and retry.",
    });
  }

  try {
    return {
      canonicalServerId,
      plan: buildV1RequestPlan(input),
      registeredBaseUrl: resolveRegisteredActionBaseUrl(input),
    };
  } catch (error) {
    if (error instanceof V1RequestInputError) {
      throw typedError({
        code: "INTEGRATION_INPUT_INVALID",
        message: error.message,
        serviceId: input.service.clientId,
        action: input.action,
        faultDomain: "input_schema",
        retryable: false,
        auth: "unknown",
        nextAction: "Correct the action input used by the declared request mapping and retry.",
      });
    }
    throw typedError({
      code: "INTEGRATION_ACTION_CONTRACT_INVALID",
      message: error instanceof Error ? error.message : "The action request mapping is invalid.",
      serviceId: input.service.clientId,
      action: input.action,
      faultDomain: "manifest_policy",
      retryable: false,
      auth: "unknown",
      nextAction: "Ask the service owner to correct the manifest v1 action contract.",
    });
  }
}

export async function invokeManifestActionV1(input: ManifestActionPreflightV1Input & {
  env: NodeJS.ProcessEnv;
  cookies: SessionCookie[];
  retryInvocationId?: string;
  fetchImpl?: typeof fetch;
}): Promise<IntegrationV1InvocationResult> {
  const {
    canonicalServerId,
    plan,
    registeredBaseUrl,
  } = preflightManifestActionV1(input);

  const cookie = cookieHeaderForUrl(input.cookies, plan.url);
  if (!cookie) {
    throw typedError({
      code: "INTEGRATION_AUTH_NOT_READY",
      message: "No usable agent session exists for this service action URL.",
      serviceId: input.service.clientId,
      action: input.action,
      faultDomain: "auth",
      retryable: false,
      auth: "not_ready",
      nextAction: `Run \`raft integration login --service ${JSON.stringify(input.service.clientId)}\` and retry.`,
    });
  }

  const serverId = canonicalServerId;
  const contractSha256 = effectiveContractDigest({
    actorServerId: serverId,
    service: input.service,
    manifest: input.manifest,
    action: input.action,
    registeredBaseUrl,
  });
  let invocation: InvocationRecordV1;
  try {
    invocation = prepareInvocationAttemptV1({
      agentContext: input.actorContext,
      env: input.env,
      retryInvocationId: input.retryInvocationId,
      binding: {
        actorId: input.actorContext.agentId,
        serverId,
        integrationId: input.service.id,
        serviceId: input.service.clientId,
        action: input.action.name,
        effect: input.action.effect,
        effectiveContractSha256: contractSha256,
        requestBindingSha256: requestBindingDigest({ payload: input.payload, plan }),
        idempotencyMode: input.action.idempotency.mode,
        idempotencyScope: input.action.idempotency.mode === "key_required" ? "actor_action" : undefined,
      },
    });
  } catch (error) {
    throw storeFailureError({ error, serviceId: input.service.clientId, action: input.action });
  }

  const headers: Record<string, string> = {
    accept: "application/json,text/plain,*/*",
    cookie,
  };
  if (input.action.idempotency.mode === "key_required") {
    if (!invocation.rawIdempotencyKey) {
      throw storeFailureError({
        error: new InvocationStoreError(
          "the durable invocation record is missing its idempotency key",
          "INTEGRATION_RETRY_PERSISTENCE_REQUIRED",
        ),
        serviceId: input.service.clientId,
        action: input.action,
      });
    }
    headers[input.action.idempotency.transport.name] = invocation.rawIdempotencyKey;
  }
  const requestInit: RequestInit = {
    method: plan.method,
    headers,
    redirect: "manual",
  };
  if (plan.body !== undefined) {
    headers["content-type"] = "application/json";
    requestInit.body = JSON.stringify(plan.body);
  }

  let response: Response;
  try {
    response = await (input.fetchImpl ?? fetch)(plan.url, requestInit);
  } catch {
    const receipt = buildReceipt({
      actorContext: input.actorContext,
      service: input.service,
      manifest: input.manifest,
      action: input.action,
      registeredBaseUrl,
      effectiveContractSha256: contractSha256,
      invocation,
      authority: "unknown",
      transport: "no_response",
      responseSchema: "not_run",
      readback: input.action.readback.mode === "not_applicable"
        ? "not_applicable"
        : input.action.readback.mode === "not_supported"
          ? "not_supported"
          : "not_run",
      operation: "indeterminate",
      retryable: retryableFor(input.action),
      nextAction: retryableFor(input.action)
        ? `Retry only with invocation ${invocation.invocationId}; do not create a new logical invocation.`
        : "Do not retry automatically; the operation outcome is indeterminate.",
    });
    finalizeReceipt({ actorContext: input.actorContext, env: input.env, receipt });
    throw typedError({
      code: "INTEGRATION_OPERATION_INDETERMINATE",
      message: "The action request was dispatched but no response was received.",
      serviceId: input.service.clientId,
      action: input.action,
      faultDomain: "action_transport",
      retryable: receipt.retryable,
      transport: "no_response",
      nextAction: receipt.next_action,
      receipt,
    });
  }

  const requestId = requestIdFromHeaders(response.headers);
  if (!response.ok) {
    const authority: IntegrationAuthorityStatusV1 = response.status === 403 ? "denied" : "unknown";
    const auth = response.status === 401 ? "rejected" : "accepted";
    const retryAfter = response.status === 429 ? retryAfterFromHeaders(response.headers) : null;
    const retryable = (response.status === 429 || response.status >= 500) && retryableFor(input.action);
    const receipt = buildReceipt({
      actorContext: input.actorContext,
      service: input.service,
      manifest: input.manifest,
      action: input.action,
      registeredBaseUrl,
      effectiveContractSha256: contractSha256,
      invocation,
      authority,
      transport: "rejected",
      httpStatus: response.status,
      requestId,
      responseSchema: "not_run",
      readback: input.action.readback.mode === "not_applicable"
        ? "not_applicable"
        : input.action.readback.mode === "not_supported"
          ? "not_supported"
          : "not_run",
      operation: "failed",
      retryable,
      nextAction: response.status === 401
        ? `Run \`raft integration login --service ${JSON.stringify(input.service.clientId)}\` and retry with the same invocation only when permitted.`
        : response.status === 403
          ? "The service denied this actor/action/resource tuple; do not infer service-wide unavailability."
          : retryable
            ? `Retry only with invocation ${invocation.invocationId}${retryAfter ? ` after Retry-After ${retryAfter}` : ""}.`
            : "Inspect the bounded status and service documentation before another invocation.",
    });
    finalizeReceipt({ actorContext: input.actorContext, env: input.env, receipt });
    throw typedError({
      code: response.status === 403
        ? "INTEGRATION_AUTHORITY_DENIED"
        : response.status === 401
          ? "INTEGRATION_AUTH_NOT_READY"
          : "INTEGRATION_SERVICE_REJECTED",
      message: `The service rejected the action with HTTP ${response.status}.`,
      serviceId: input.service.clientId,
      action: input.action,
      faultDomain: response.status === 403 ? "authority" : response.status === 401 ? "auth" : "service",
      retryable: receipt.retryable,
      auth,
      authority,
      transport: "rejected",
      httpStatus: response.status,
      requestId,
      readback: receipt.readback.status,
      nextAction: receipt.next_action,
      receipt,
    });
  }

  let value: unknown;
  try {
    value = await boundedResponseValue(response);
  } catch (error) {
    const receipt = buildReceipt({
      actorContext: input.actorContext,
      service: input.service,
      manifest: input.manifest,
      action: input.action,
      registeredBaseUrl,
      effectiveContractSha256: contractSha256,
      invocation,
      authority: "authorized",
      transport: "response_received",
      httpStatus: response.status,
      requestId,
      responseSchema: "failed",
      readback: input.action.readback.mode === "not_applicable"
        ? "not_applicable"
        : input.action.readback.mode === "not_supported"
          ? "not_supported"
          : "not_run",
      operation: "failed",
      retryable: false,
      nextAction: "Ask the service owner to return a bounded response matching the declared output schema.",
    });
    finalizeReceipt({ actorContext: input.actorContext, env: input.env, receipt });
    throw typedError({
      code: "INTEGRATION_OUTPUT_INVALID",
      message: error instanceof Error ? error.message : "The service response is invalid.",
      serviceId: input.service.clientId,
      action: input.action,
      faultDomain: "output_schema",
      retryable: false,
      auth: "accepted",
      authority: "authorized",
      transport: "response_received",
      responseSchema: "failed",
      httpStatus: response.status,
      requestId,
      readback: receipt.readback.status,
      nextAction: receipt.next_action,
      receipt,
    });
  }
  const outputFailure = validateV1Output(input.action, value);
  if (outputFailure) {
    const receipt = buildReceipt({
      actorContext: input.actorContext,
      service: input.service,
      manifest: input.manifest,
      action: input.action,
      registeredBaseUrl,
      effectiveContractSha256: contractSha256,
      invocation,
      authority: "authorized",
      transport: "response_received",
      httpStatus: response.status,
      requestId,
      responseSchema: "failed",
      readback: input.action.readback.mode === "not_applicable"
        ? "not_applicable"
        : input.action.readback.mode === "not_supported"
          ? "not_supported"
          : "not_run",
      operation: "failed",
      retryable: false,
      nextAction: "Ask the service owner to return a response matching the declared output schema.",
    });
    finalizeReceipt({ actorContext: input.actorContext, env: input.env, receipt });
    throw typedError({
      code: "INTEGRATION_OUTPUT_INVALID",
      message: `Action output does not match the declared schema at ${outputFailure.path ?? "/"}.`,
      serviceId: input.service.clientId,
      action: input.action,
      faultDomain: "output_schema",
      retryable: false,
      auth: "accepted",
      authority: "authorized",
      transport: "response_received",
      responseSchema: "failed",
      schemaPath: outputFailure.path,
      httpStatus: response.status,
      requestId,
      readback: receipt.readback.status,
      nextAction: receipt.next_action,
      receipt,
    });
  }

  if (input.action.effect === "read") {
    const receipt = buildReceipt({
      actorContext: input.actorContext,
      service: input.service,
      manifest: input.manifest,
      action: input.action,
      registeredBaseUrl,
      effectiveContractSha256: contractSha256,
      invocation,
      authority: "authorized",
      transport: "response_received",
      httpStatus: response.status,
      requestId,
      responseSchema: "passed",
      readback: "not_applicable",
      operation: "verified",
      retryable: false,
      nextAction: "The declared read action completed; this evidence does not transfer to mutation readiness.",
    });
    finalizeReceipt({ actorContext: input.actorContext, env: input.env, receipt });
    return { value, status: response.status, receipt };
  }

  if (input.action.readback.mode === "not_supported") {
    const receipt = buildReceipt({
      actorContext: input.actorContext,
      service: input.service,
      manifest: input.manifest,
      action: input.action,
      registeredBaseUrl,
      effectiveContractSha256: contractSha256,
      invocation,
      authority: "authorized",
      transport: "response_received",
      httpStatus: response.status,
      requestId,
      responseSchema: "passed",
      readback: "not_supported",
      operation: "accepted_unverified",
      retryable: false,
      nextAction: "The service accepted the mutation, but this manifest declares no machine readback.",
    });
    finalizeReceipt({ actorContext: input.actorContext, env: input.env, receipt });
    return { value, status: response.status, receipt };
  }

  if (input.action.readback.mode !== "action") {
    throw typedError({
      code: "INTEGRATION_ACTION_CONTRACT_INVALID",
      message: "The mutation action has no valid readback contract.",
      serviceId: input.service.clientId,
      action: input.action,
      faultDomain: "manifest_schema",
      retryable: false,
      auth: "accepted",
      authority: "authorized",
      transport: "response_received",
      responseSchema: "passed",
      nextAction: "Ask the service owner to correct the manifest readback mode.",
    });
  }
  const readbackContract = input.action.readback;
  const readbackAction = input.manifest.actions.find((candidate) => candidate.name === readbackContract.action);
  if (!readbackAction) {
    throw typedError({
      code: "INTEGRATION_ACTION_CONTRACT_INVALID",
      message: "The declared readback action is unavailable.",
      serviceId: input.service.clientId,
      action: input.action,
      faultDomain: "manifest_schema",
      retryable: false,
      auth: "accepted",
      authority: "authorized",
      transport: "response_received",
      responseSchema: "passed",
      nextAction: "Ask the service owner to correct the manifest readback reference.",
    });
  }
  let readbackPayload: Record<string, unknown>;
  try {
    readbackPayload = mapReadbackInput({
      bindings: readbackContract.input,
      request: input.payload,
      response: value,
    });
  } catch (error) {
    const receipt = buildReceipt({
      actorContext: input.actorContext,
      service: input.service,
      manifest: input.manifest,
      action: input.action,
      registeredBaseUrl,
      effectiveContractSha256: contractSha256,
      invocation,
      authority: "authorized",
      transport: "response_received",
      httpStatus: response.status,
      requestId,
      responseSchema: "passed",
      readback: "failed",
      operation: "failed",
      retryable: false,
      nextAction: "The mutation response could not bind the declared readback input.",
    });
    finalizeReceipt({ actorContext: input.actorContext, env: input.env, receipt });
    throw typedError({
      code: "INTEGRATION_READBACK_FAILED",
      message: error instanceof Error ? error.message : "Readback input binding failed.",
      serviceId: input.service.clientId,
      action: input.action,
      faultDomain: "readback",
      retryable: false,
      auth: "accepted",
      authority: "authorized",
      transport: "response_received",
      responseSchema: "passed",
      readback: "failed",
      httpStatus: response.status,
      requestId,
      nextAction: receipt.next_action,
      receipt,
    });
  }

  let readbackResult: IntegrationV1InvocationResult;
  try {
    readbackResult = await invokeManifestActionV1({
      ...input,
      action: readbackAction,
      payload: readbackPayload,
      retryInvocationId: undefined,
    });
  } catch (error) {
    const nestedReceipt = error instanceof IntegrationV1Error ? error.receipt : undefined;
    const readbackStatus: IntegrationReadbackStatusV1 =
      nestedReceipt?.operation.status === "indeterminate" ? "indeterminate" : "failed";
    const receipt = buildReceipt({
      actorContext: input.actorContext,
      service: input.service,
      manifest: input.manifest,
      action: input.action,
      registeredBaseUrl,
      effectiveContractSha256: contractSha256,
      invocation,
      authority: "authorized",
      transport: "response_received",
      httpStatus: response.status,
      requestId,
      responseSchema: "passed",
      readback: readbackStatus,
      readbackReceiptId: nestedReceipt?.receipt_id,
      operation: readbackStatus === "indeterminate" ? "indeterminate" : "failed",
      retryable: false,
      nextAction: "Inspect the independent readback receipt; the mutation is not verified.",
    });
    finalizeReceipt({ actorContext: input.actorContext, env: input.env, receipt });
    throw typedError({
      code: "INTEGRATION_READBACK_FAILED",
      message: "The declared readback action did not complete successfully.",
      serviceId: input.service.clientId,
      action: input.action,
      faultDomain: "readback",
      retryable: false,
      auth: "accepted",
      authority: "authorized",
      transport: "response_received",
      responseSchema: "passed",
      readback: readbackStatus,
      httpStatus: response.status,
      requestId,
      nextAction: receipt.next_action,
      receipt,
    });
  }

  const assertionResult = evaluateReadbackAssertions({
    assertions: readbackContract.assertions,
    response: readbackResult.value,
  });
  if (!assertionResult.passed) {
    const receipt = buildReceipt({
      actorContext: input.actorContext,
      service: input.service,
      manifest: input.manifest,
      action: input.action,
      registeredBaseUrl,
      effectiveContractSha256: contractSha256,
      invocation,
      authority: "authorized",
      transport: "response_received",
      httpStatus: response.status,
      requestId,
      responseSchema: "passed",
      readback: "failed",
      readbackReceiptId: readbackResult.receipt.receipt_id,
      operation: "failed",
      retryable: false,
      nextAction: "The readback response did not satisfy the declared assertion; the mutation is not verified.",
    });
    finalizeReceipt({ actorContext: input.actorContext, env: input.env, receipt });
    throw typedError({
      code: "INTEGRATION_READBACK_FAILED",
      message: `The readback assertion failed at ${assertionResult.failedPointer ?? "/"}.`,
      serviceId: input.service.clientId,
      action: input.action,
      faultDomain: "readback",
      retryable: false,
      auth: "accepted",
      authority: "authorized",
      transport: "response_received",
      responseSchema: "passed",
      readback: "failed",
      schemaPath: assertionResult.failedPointer,
      httpStatus: response.status,
      requestId,
      nextAction: receipt.next_action,
      receipt,
    });
  }

  const receipt = buildReceipt({
    actorContext: input.actorContext,
    service: input.service,
    manifest: input.manifest,
    action: input.action,
    registeredBaseUrl,
    effectiveContractSha256: contractSha256,
    invocation,
    authority: "authorized",
    transport: "response_received",
    httpStatus: response.status,
    requestId,
    responseSchema: "passed",
    readback: "passed",
    readbackReceiptId: readbackResult.receipt.receipt_id,
    operation: "verified",
    retryable: false,
    nextAction: "No further action is required.",
  });
  finalizeReceipt({ actorContext: input.actorContext, env: input.env, receipt });
  return {
    value,
    status: response.status,
    receipt,
    readbackReceipt: readbackResult.receipt,
  };
}


