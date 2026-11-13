import {
  OAR_ONLY_RUNTIME_IDS,
  getExistingAgentRuntimeOptions,
  getSetupRuntimeOptions,
  isRuntimeDeprecated,
  isRuntimeSelectableForNewAgent,
  RUNTIMES,
  type RuntimeAdmissionReason,
  type RuntimeInfo,
  type RuntimeSelectionOption,
} from "@botiverse/raft-shared";
import { agentRuntimeOarFeatureFlagKey, evaluateFeatureFlags } from "./featureFlagService";
import { runtimeFormV1Entry } from "./runtimeFormDefinitionService";
import { RUNTIME_FORM_V2_MARKER, runtimeFormV2Entry } from "./runtimeFormV2Registry";

/**
 * Released mobile apps (1.12, 1.13) decode runtime options STRICTLY: any key
 * they do not know fails the whole catalog (`computer_runtime_options_contract_mismatch`),
 * so the create-agent runtime list never opens. The `runtimeFormV2` marker is
 * therefore opt-in: only a client that asks for it (web, header
 * `X-Raft-Runtime-Form-V2: 1`) receives it; everyone else gets the pre-v2 key set unchanged.
 */
export interface RuntimeOptionProjection {
  includeRuntimeFormV2Marker: boolean;
}

const NO_RUNTIME_FORM_V2_MARKER: RuntimeOptionProjection = { includeRuntimeFormV2Marker: false };

/**
 * Which runtimes this server admits for new agents and switches beyond what a
 * Computer reports. A runtime that runs only on the Computer's OAR host
 * (shared OAR_ONLY_RUNTIME_IDS) is gated only if it has a server flag
 * (`agent_runtime_oar_<id>`, default off); none has one today, so the
 * Computer's report decides. An agent already on a gated runtime keeps it.
 */
export interface RuntimeAdmissionPolicy {
  disabledRuntimeIds: ReadonlySet<string>;
  /**
   * Deprecated runtimes this server offers again for new agents and switches
   * because their OAR host flag is on: Antigravity with
   * `agent_runtime_oar_antigravity` (tygg, #oar-raft:e9798673). Missing = none.
   */
  revivedRuntimeIds?: ReadonlySet<string>;
}

const FLAG_GATED_RUNTIME_IDS = OAR_ONLY_RUNTIME_IDS.filter((runtime) => agentRuntimeOarFeatureFlagKey(runtime) !== null);
/** Deprecated runtimes that run on the OAR host behind a server flag. */
const FLAG_REVIVED_RUNTIME_IDS = RUNTIMES
  .filter((runtime) => runtime.supported && runtime.deprecated && agentRuntimeOarFeatureFlagKey(runtime.id) !== null)
  .map((runtime) => runtime.id);

/** Fail closed: every flag-gated runtime off (a caller that did not resolve the policy). */
export const DEFAULT_RUNTIME_ADMISSION_POLICY: RuntimeAdmissionPolicy = { disabledRuntimeIds: new Set(FLAG_GATED_RUNTIME_IDS) };

/** A flag evaluation that fails leaves every gated runtime off, never a 500. */
export async function resolveRuntimeAdmissionPolicy(
  input: { serverId: string; userId: string },
  evaluate: typeof evaluateFeatureFlags = evaluateFeatureFlags,
): Promise<RuntimeAdmissionPolicy> {
  const runtimes = [...FLAG_GATED_RUNTIME_IDS, ...FLAG_REVIVED_RUNTIME_IDS];
  if (runtimes.length === 0) return { disabledRuntimeIds: new Set() };
  let evaluations: Awaited<ReturnType<typeof evaluateFeatureFlags>>;
  try {
    evaluations = await evaluate(runtimes.map((runtime) => ({
      key: agentRuntimeOarFeatureFlagKey(runtime)!,
      serverId: input.serverId,
      userId: input.userId,
    })));
  } catch {
    return DEFAULT_RUNTIME_ADMISSION_POLICY;
  }
  const disabled = new Set<string>(FLAG_GATED_RUNTIME_IDS);
  const revived = new Set<string>();
  runtimes.forEach((runtime, index) => {
    if (!evaluations[index]?.enabled) return;
    if (FLAG_REVIVED_RUNTIME_IDS.includes(runtime)) revived.add(runtime);
    else disabled.delete(runtime);
  });
  return { disabledRuntimeIds: disabled, revivedRuntimeIds: revived };
}

export function isRuntimeAdmittedForNewUse(runtime: string, policy: RuntimeAdmissionPolicy): boolean {
  return !policy.disabledRuntimeIds.has(runtime);
}

/** A deprecated runtime this server offers again (its OAR flag is on). */
export function isRuntimeRevived(runtime: string, policy: RuntimeAdmissionPolicy): boolean {
  return policy.revivedRuntimeIds?.has(runtime) ?? false;
}

/** Deprecated for new agents and switches on this server: deprecated and not revived. */
export function isRuntimeDeprecatedForServer(runtime: string, policy: RuntimeAdmissionPolicy): boolean {
  return isRuntimeDeprecated(runtime) && !isRuntimeRevived(runtime, policy);
}

function revivedRuntimes(policy: RuntimeAdmissionPolicy): RuntimeInfo[] {
  return RUNTIMES.filter((runtime) => runtime.supported && isRuntimeRevived(runtime.id, policy));
}

/** Request header a client sends to declare that it understands the `runtimeFormV2` marker. */
export const RUNTIME_FORM_V2_MARKER_HEADER = "x-raft-runtime-form-v2";

export function runtimeOptionProjectionFromHeaders(
  headers: Record<string, string | string[] | undefined>,
): RuntimeOptionProjection {
  return { includeRuntimeFormV2Marker: headers[RUNTIME_FORM_V2_MARKER_HEADER] === "1" };
}

function capabilityStatus(
  runtime: RuntimeInfo,
  installedRuntimeIds: ReadonlySet<string>,
): RuntimeSelectionOption["capabilityStatus"] {
  if (installedRuntimeIds.has(runtime.id)) return "available";
  return runtime.binary === "" ? "update_required" : "not_installed";
}

function projectRuntimeOption(input: {
  runtime: RuntimeInfo;
  installedRuntimeIds: ReadonlySet<string>;
  currentRuntime: string | null;
  admissionReason: RuntimeAdmissionReason;
  projection: RuntimeOptionProjection;
}): RuntimeSelectionOption {
  const current = input.runtime.id === input.currentRuntime;
  const capability = capabilityStatus(input.runtime, input.installedRuntimeIds);
  const admissionStatus = input.admissionReason === null
    ? "available_for_new" as const
    : "grandfathered_current" as const;
  const availableForNew = admissionStatus === "available_for_new";
  const capabilityAvailable = capability === "available";
  const manageableForCurrentAgent = current && capabilityAvailable;
  const canSelectInThisContext = capabilityAvailable
    && (availableForNew || (current && admissionStatus === "grandfathered_current"));
  const v1Form = runtimeFormV1Entry(input.runtime.id);

  return {
    runtimeId: input.runtime.id,
    capabilityStatus: capability,
    admissionStatus,
    admissionReason: input.admissionReason,
    current,
    availableForNew,
    manageableForCurrentAgent,
    canSelectInThisContext,
    // Two independent opt-ins: `formDefinitionRef` for the frozen v1 form (web
    // schema path, installed v1 apps), `runtimeFormV2` for the v2 form. A
    // runtime that only has a v2 form carries no v1 ref.
    ...(v1Form && (availableForNew || current) ? { formDefinitionRef: v1Form.ref } : {}),
    ...(input.projection.includeRuntimeFormV2Marker && runtimeFormV2Entry(input.runtime.id) && (availableForNew || current)
      ? { runtimeFormV2: RUNTIME_FORM_V2_MARKER }
      : {}),
  };
}

function projectNewUseOptions(
  candidates: RuntimeInfo[],
  installedRuntimeIds: readonly string[],
  projection: RuntimeOptionProjection,
  policy: RuntimeAdmissionPolicy,
): RuntimeSelectionOption[] {
  const installed = new Set(installedRuntimeIds);
  return candidates
    .filter((runtime) => isRuntimeAdmittedForNewUse(runtime.id, policy))
    .map((runtime) => projectRuntimeOption({
      runtime,
      installedRuntimeIds: installed,
      currentRuntime: null,
      admissionReason: null,
      projection,
    }));
}

export function projectNewAgentRuntimeOptions(
  installedRuntimeIds: readonly string[],
  projection: RuntimeOptionProjection = NO_RUNTIME_FORM_V2_MARKER,
  policy: RuntimeAdmissionPolicy = DEFAULT_RUNTIME_ADMISSION_POLICY,
): RuntimeSelectionOption[] {
  const candidates = RUNTIMES.filter((runtime) =>
    isRuntimeSelectableForNewAgent(runtime) || (runtime.supported && isRuntimeRevived(runtime.id, policy)));
  return projectNewUseOptions(candidates, installedRuntimeIds, projection, policy);
}

/** Server setup state never carries the marker: no client opens a v2 form from it. */
export function projectSetupRuntimeOptions(
  installedRuntimeIds: readonly string[],
  policy: RuntimeAdmissionPolicy = DEFAULT_RUNTIME_ADMISSION_POLICY,
): RuntimeSelectionOption[] {
  return projectNewUseOptions(getSetupRuntimeOptions(), installedRuntimeIds, NO_RUNTIME_FORM_V2_MARKER, policy);
}

export function projectExistingAgentRuntimeOptions(
  installedRuntimeIds: readonly string[],
  currentRuntime: string,
  projection: RuntimeOptionProjection = NO_RUNTIME_FORM_V2_MARKER,
  policy: RuntimeAdmissionPolicy = DEFAULT_RUNTIME_ADMISSION_POLICY,
): RuntimeSelectionOption[] {
  const installed = new Set(installedRuntimeIds);
  const listed = getExistingAgentRuntimeOptions(currentRuntime);
  return [...listed, ...revivedRuntimes(policy).filter((runtime) => !listed.includes(runtime))]
    .sort((a, b) => RUNTIMES.indexOf(a) - RUNTIMES.indexOf(b))
    .filter((runtime) => runtime.id === currentRuntime || isRuntimeAdmittedForNewUse(runtime.id, policy))
    .map((runtime) => {
      const admissionReason: RuntimeAdmissionReason = runtime.id === currentRuntime
        ? isRuntimeDeprecatedForServer(runtime.id, policy)
          ? "deprecated"
          : !isRuntimeAdmittedForNewUse(runtime.id, policy)
            ? "feature_flag_off"
            : null
        : null;
      return projectRuntimeOption({
        runtime,
        installedRuntimeIds: installed,
        currentRuntime,
        admissionReason,
        projection,
      });
    });
}
