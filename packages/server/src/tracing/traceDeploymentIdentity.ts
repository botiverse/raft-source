import { createHash, randomUUID } from "node:crypto";

export type TraceDeploymentIdentitySource = "aws_ecs_task" | "fly_machine" | "generated_process";
export type TraceDeploymentIdentityState = "resolved" | "ecs_metadata_unavailable" | "non_ecs";

export interface TraceDeploymentIdentity {
  serviceInstanceId: string;
  deploymentInstanceSource: TraceDeploymentIdentitySource;
  deploymentIdentityState: TraceDeploymentIdentityState;
  ecsTaskId?: string;
  ecsTaskFamily?: string;
  ecsTaskRevision?: string;
}

export interface TraceDeploymentResourceOptions {
  serviceInstanceId: string;
  deploymentInstanceSource: TraceDeploymentIdentitySource;
  deploymentIdentityState: TraceDeploymentIdentityState;
  ecsTaskId?: string;
  ecsTaskFamily?: string;
  ecsTaskRevision?: string;
}

type EcsTaskMetadata = {
  TaskARN?: unknown;
  Family?: unknown;
  Revision?: unknown;
};

type TraceDeploymentIdentityOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  processIdFactory?: () => string;
};

const SAFE_ECS_FAMILY_RE = /^[A-Za-z0-9_-]{1,255}$/;
const SAFE_ECS_REVISION_RE = /^\d{1,10}$/;

export async function resolveTraceDeploymentIdentity(
  env: NodeJS.ProcessEnv = process.env,
  options: TraceDeploymentIdentityOptions = {},
): Promise<TraceDeploymentIdentity> {
  const metadataUri = env.ECS_CONTAINER_METADATA_URI_V4?.trim();
  if (metadataUri) {
    const resolved = await resolveEcsTaskIdentity(metadataUri, options);
    if (resolved) return resolved;
    return createGeneratedTraceDeploymentIdentity("ecs_metadata_unavailable", options.processIdFactory);
  }

  const flyInstance = env.FLY_MACHINE_ID?.trim() || env.FLY_INSTANCE_ID?.trim();
  if (flyInstance) {
    const processNonce = (options.processIdFactory ?? randomUUID)();
    const opaqueId = opaqueIdentity(`${flyInstance}:${processNonce}`);
    return {
      serviceInstanceId: `fly:${opaqueId}`,
      deploymentInstanceSource: "fly_machine",
      deploymentIdentityState: "resolved",
    };
  }

  return createGeneratedTraceDeploymentIdentity("non_ecs", options.processIdFactory);
}

async function resolveEcsTaskIdentity(
  metadataUri: string,
  options: TraceDeploymentIdentityOptions,
): Promise<TraceDeploymentIdentity | null> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = Math.max(1, options.timeoutMs ?? 1_000);
  try {
    const response = await fetchImpl(`${metadataUri.replace(/\/+$/, "")}/task`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const metadata = await response.json() as EcsTaskMetadata;
    const taskArn = stringValue(metadata.TaskARN);
    const family = stringValue(metadata.Family);
    const revision = revisionValue(metadata.Revision);
    if (!taskArn || !family || !revision || !SAFE_ECS_FAMILY_RE.test(family)) return null;

    const taskId = opaqueIdentity(taskArn);
    const processNonce = (options.processIdFactory ?? randomUUID)();
    return {
      serviceInstanceId: `ecs:${opaqueIdentity(`${taskArn}:${processNonce}`)}`,
      deploymentInstanceSource: "aws_ecs_task",
      deploymentIdentityState: "resolved",
      ecsTaskId: taskId,
      ecsTaskFamily: family,
      ecsTaskRevision: revision,
    };
  } catch {
    return null;
  }
}

export function createGeneratedTraceDeploymentIdentity(
  state: Exclude<TraceDeploymentIdentityState, "resolved">,
  processIdFactory?: () => string,
): TraceDeploymentIdentity {
  const processId = (processIdFactory ?? randomUUID)();
  return {
    serviceInstanceId: `process:${opaqueIdentity(processId)}`,
    deploymentInstanceSource: "generated_process",
    deploymentIdentityState: state,
  };
}

export function traceDeploymentResourceOptions(
  identity: TraceDeploymentIdentity,
): TraceDeploymentResourceOptions {
  return {
    serviceInstanceId: identity.serviceInstanceId,
    deploymentInstanceSource: identity.deploymentInstanceSource,
    deploymentIdentityState: identity.deploymentIdentityState,
    ecsTaskId: identity.ecsTaskId,
    ecsTaskFamily: identity.ecsTaskFamily,
    ecsTaskRevision: identity.ecsTaskRevision,
  };
}

function opaqueIdentity(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function stringValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function revisionValue(value: unknown): string | null {
  const candidate = typeof value === "number" && Number.isInteger(value)
    ? String(value)
    : stringValue(value);
  return candidate && SAFE_ECS_REVISION_RE.test(candidate) ? candidate : null;
}
