import {
  RUNTIMES,
  RUNTIME_MODELS,
  SERVER_RUNTIME_CATALOG_VERSION,
  hasStaticRuntimeModelSource,
  isOarOnlyRuntime,
  type RuntimeInfo,
  type ServerRuntimeCatalog,
  type ServerRuntimeCatalogEntry,
  type ServerRuntimeCatalogForm,
} from "@botiverse/raft-shared";
import { isRuntimeAdmittedForNewUse, isRuntimeRevived, type RuntimeAdmissionPolicy } from "./runtimeAdmissionService";
import { runtimeFormV1Entry } from "./runtimeFormDefinitionService";
import { runtimeFormV2Entry } from "./runtimeFormV2Registry";

/**
 * `GET /api/servers/:id/runtimes` (docs/contracts/server-runtime-catalog.md):
 * the shared RUNTIMES catalog after this server's runtime switches, so a client
 * (the mobile app) learns a new runtime without a release. A runtime its switch
 * keeps off is left out; the policy already fails closed only for flag-gated
 * runtimes, so a flag store error never empties the list.
 */
export function projectServerRuntimeCatalog(policy: RuntimeAdmissionPolicy): ServerRuntimeCatalog {
  return {
    catalogVersion: SERVER_RUNTIME_CATALOG_VERSION,
    runtimes: RUNTIMES
      .filter((runtime) => isRuntimeAdmittedForNewUse(runtime.id, policy))
      .map((runtime) => projectEntry(runtime, policy)),
  };
}

function projectEntry(runtime: RuntimeInfo, policy: RuntimeAdmissionPolicy): ServerRuntimeCatalogEntry {
  return {
    id: runtime.id,
    displayName: runtime.displayName,
    abbreviation: runtime.abbreviation,
    binary: runtime.binary,
    supported: runtime.supported,
    experimental: Boolean(runtime.experimental),
    // A deprecated runtime this server revived (its OAR flag is on) is offered for new agents.
    deprecated: Boolean(runtime.deprecated) && !isRuntimeRevived(runtime.id, policy),
    oarOnly: isOarOnlyRuntime(runtime.id),
    models: RUNTIME_MODELS[runtime.id] ?? [],
    modelsSource: hasStaticRuntimeModelSource(runtime.id) ? "static" : "fallback",
    forms: runtimeForms(runtime.id),
  };
}

/**
 * The generic form is what released clients already use for a runtime whose
 * runtime-options row carries no v1 `formDefinitionRef`; a runtime with a v1
 * form needs that form (Built-in Pi's provider and key, Kimi Code's model).
 */
function runtimeForms(runtimeId: string): ServerRuntimeCatalogForm[] {
  const v1 = runtimeFormV1Entry(runtimeId);
  return [
    v1 ? { kind: "v1" as const, schemaVersion: v1.ref.schemaVersion } : { kind: "generic" as const },
    ...(runtimeFormV2Entry(runtimeId) ? [{ kind: "v2" as const }] : []),
  ];
}
