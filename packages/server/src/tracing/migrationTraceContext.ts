export type RequestHostClass =
  | "api_raft_build"
  | "api_slock_ai"
  | "custom"
  | "direct"
  | "unknown";

export type RuntimeCohort = "aws" | "fly" | "unknown";

export interface MachineConnectTraceContext {
  requestHostClass: RequestHostClass;
  requestHostPresent: boolean;
  cohort: RuntimeCohort;
}

export function buildMachineConnectTraceContext(
  hostHeader: string | string[] | number | undefined,
  env: NodeJS.ProcessEnv = process.env,
): MachineConnectTraceContext {
  return {
    requestHostClass: classifyRequestHost(hostHeader),
    requestHostPresent: normalizeHostHeader(hostHeader) !== null,
    cohort: classifyRuntimeCohort(env),
  };
}

export function buildRuntimeTraceContext(env: NodeJS.ProcessEnv = process.env): MachineConnectTraceContext {
  return {
    requestHostClass: "unknown",
    requestHostPresent: false,
    cohort: classifyRuntimeCohort(env),
  };
}

export function projectMachineConnectTraceAttrs(context: MachineConnectTraceContext): Record<string, unknown> {
  return {
    request_host_class: context.requestHostClass,
    request_host_present: context.requestHostPresent,
    cohort: context.cohort,
  };
}

export function projectOwnerTraceAttrs(
  context: Partial<MachineConnectTraceContext> | null | undefined,
): Record<string, unknown> {
  return {
    owner_cohort: context?.cohort ?? "unknown",
    owner_request_host_class: context?.requestHostClass ?? "unknown",
    owner_request_host_present: context?.requestHostPresent ?? false,
  };
}

function classifyRuntimeCohort(env: NodeJS.ProcessEnv): RuntimeCohort {
  if (env.FLY_APP_NAME || env.FLY_MACHINE_ID || env.FLY_ALLOC_ID || env.FLY_INSTANCE_ID) {
    return "fly";
  }
  if (
    env.ECS_CONTAINER_METADATA_URI_V4 ||
    env.ECS_CONTAINER_METADATA_URI ||
    env.AWS_EXECUTION_ENV?.startsWith("AWS_ECS")
  ) {
    return "aws";
  }
  return "unknown";
}

function classifyRequestHost(hostHeader: string | string[] | number | undefined): RequestHostClass {
  const host = normalizeHostHeader(hostHeader);
  if (!host) return "unknown";
  if (host === "api.raft.build") return "api_raft_build";
  if (host === "api.slock.ai") return "api_slock_ai";
  if (isDirectHost(host)) return "direct";
  return "custom";
}

function normalizeHostHeader(hostHeader: string | string[] | number | undefined): string | null {
  const raw = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader;
  if (raw === undefined || raw === null) return null;
  const trimmed = String(raw).trim().toLowerCase();
  if (!trimmed) return null;
  if (trimmed.startsWith("[")) {
    const bracketEnd = trimmed.indexOf("]");
    return bracketEnd > 1 ? trimmed.slice(1, bracketEnd) : null;
  }
  if ((trimmed.match(/:/g) ?? []).length > 1) {
    return trimmed;
  }
  return trimmed.split(":")[0] || null;
}

function isDirectHost(host: string): boolean {
  if (host === "localhost") return true;
  if (host.endsWith(".fly.dev") || host.endsWith(".elb.amazonaws.com")) return true;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return true;
  if (host === "::1" || host.includes(":")) return true;
  return false;
}
