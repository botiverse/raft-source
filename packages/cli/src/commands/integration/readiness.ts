import { currentDate } from "@botiverse/raft-shared";

import {
  CanonicalFetchTransportError,
  credentialFreeDiagnosticUrl,
  type FetchTransportCauseClass,
} from "../../proxy.js";
import type { RegisteredIntegrationService } from "./_format.js";
import {
  AgentManifestFetchError,
  AgentManifestResponseFormatError,
  fetchAgentManifest,
  fetchAgentManifestWithWellKnownAliases,
  type AgentManifest,
} from "./manifest.js";

export type ManifestObservationStatus =
  | "valid"
  | "missing"
  | "invalid"
  | "unavailable"
  | "unreachable"
  | "not_configured"
  | "unchecked";

export type IntegrationSurface =
  | "web_only_no_actions"
  | "manifest_actions"
  | "local_cli"
  | "unknown";

export type ManifestFaultDomain =
  | "manifest_registry"
  | "manifest_discovery"
  | "manifest_service"
  | "manifest_transport"
  | "manifest_response"
  | "manifest_schema"
  | "manifest_policy"
  | "manifest_observation";

export interface ManifestObservation {
  service_id: string;
  manifest_url: string | null;
  status: ManifestObservationStatus;
  surface: IntegrationSurface;
  observed_at: string;
  source: "service_registry" | "live_manifest_probe";
  evidence_ceiling: "registry_metadata" | "manifest_shape";
  fault_domain: ManifestFaultDomain | null;
  retryable: boolean | null;
  next_action: string;
  http_status?: number;
  content_type?: string;
  retry_after?: string | null;
  schema_path?: string;
  detail?: string;
  actual_url?: string;
  cause_class?: FetchTransportCauseClass | "http";
  cause_code?: string;
}

export interface ManifestProbeResult {
  observation: ManifestObservation;
  manifest: AgentManifest | null;
  error?: unknown;
}

interface ProbeOptions {
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  fetchManifest?: (url: string) => Promise<AgentManifest>;
  fetchManifestWithAliases?: (url: string) => Promise<AgentManifest>;
}

function observedAt(options: Pick<ProbeOptions, "now">): string {
  return (options.now?.() ?? currentDate()).toISOString();
}

function listActionsCommand(service: RegisteredIntegrationService): string {
  return `raft integration invoke --service ${JSON.stringify(service.clientId)} --list-actions`;
}

export function registryManifestObservation(
  service: RegisteredIntegrationService,
  options: Pick<ProbeOptions, "now"> = {},
): ManifestObservation {
  const common = {
    service_id: service.clientId,
    manifest_url: service.agentManifestUrl,
    observed_at: observedAt(options),
    source: "service_registry" as const,
    evidence_ceiling: "registry_metadata" as const,
  };

  if (!service.agentManifestUrl) {
    return {
      ...common,
      status: "not_configured",
      surface: "web_only_no_actions",
      fault_domain: "manifest_registry",
      retryable: false,
      next_action: "Use the service's web surface; no agent action manifest is configured.",
    };
  }

  return {
    ...common,
    status: "unchecked",
    surface: "unknown",
    fault_domain: null,
    retryable: null,
    next_action: `Run \`${listActionsCommand(service)}\` for a targeted live manifest check.`,
  };
}

function inferSchemaPath(message: string): string | null {
  if (/^manifest must be a JSON object/.test(message)) return "$";
  if (/^manifest schema must be/.test(message)) return "schema";
  if (/^duplicate action name:/.test(message)) return "actions[].name";

  const match = message.match(
    /^(actions(?:\[\d+\])?(?:\.[A-Za-z0-9_]+)*|execution(?:\.[A-Za-z0-9_]+)*|auth(?:\.[A-Za-z0-9_]+)*|credential_boundary(?:\.[A-Za-z0-9_]+)*|context_check|docs_url|app_origin)(?=\s|$)/,
  );
  return match?.[1] ?? null;
}

function isTransportError(error: Error): boolean {
  if (error instanceof CanonicalFetchTransportError) return true;
  if (error.name === "AbortError" || error.name === "TimeoutError") return true;
  if (error instanceof TypeError) return true;
  return /(?:ECONN|ENOTFOUND|EAI_AGAIN|fetch failed|network|socket|TLS|timed? out)/i.test(error.message);
}

function transportNextAction(causeClass: FetchTransportCauseClass): string {
  switch (causeClass) {
    case "proxy":
      return "Retry after checking HTTPS_PROXY/HTTP_PROXY/ALL_PROXY and NO_PROXY for the reported manifest URL.";
    case "dns":
      return "Retry after DNS resolution for the reported manifest host is restored.";
    case "connect":
      return "Retry after TCP reachability to the reported manifest host is restored.";
    case "tls":
      return "Retry after the reported manifest host's TLS certificate and trust path are valid.";
    case "timeout":
      return "Retry after the reported manifest route responds within the 10 second manifest timeout.";
    case "unknown":
      return "Retry the targeted manifest check; preserve the reported URL and cause code when escalating the transport failure.";
  }
}

function validSurface(manifest: AgentManifest): IntegrationSurface | null {
  const mode = (manifest as { execution?: { mode?: unknown } }).execution?.mode;
  if (mode === "local_cli") return "local_cli";
  if (mode === "http_api") {
    return (manifest.actions?.length ?? 0) > 0 ? "manifest_actions" : "web_only_no_actions";
  }
  return null;
}

function validNextAction(
  service: RegisteredIntegrationService,
  surface: IntegrationSurface,
  manifest: AgentManifest,
): string {
  if (surface === "local_cli") {
    return manifest.schema === "slock-agent-manifest.v1"
      ? "This local CLI surface is discoverable but agent invocation and credential materialization are design-blocked."
      : `Run \`raft integration env --service ${JSON.stringify(service.clientId)}\` before using the local CLI.`;
  }
  if (surface === "manifest_actions") {
    return `Run \`${listActionsCommand(service)}\` to inspect declared actions; endpoint read/write readiness is not proven by this manifest check.`;
  }
  return "Use the service's web surface; the valid manifest declares no agent actions.";
}

export async function probeIntegrationManifest(
  service: RegisteredIntegrationService,
  options: ProbeOptions = {},
): Promise<ManifestProbeResult> {
  if (!service.agentManifestUrl) {
    return { observation: registryManifestObservation(service, options), manifest: null };
  }

  const common = {
    service_id: service.clientId,
    manifest_url: service.agentManifestUrl,
    source: "live_manifest_probe" as const,
    evidence_ceiling: "manifest_shape" as const,
  };

  try {
    const fetchManifest = service.agentManifestUrlSource === "well_known"
      ? (options.fetchManifestWithAliases
        ?? ((url: string) => fetchAgentManifestWithWellKnownAliases(
          url,
          (candidate) => fetchAgentManifest(candidate, options.env),
        )))
      : (options.fetchManifest ?? ((url: string) => fetchAgentManifest(url, options.env)));
    const manifest = await fetchManifest(service.agentManifestUrl);
    const surface = validSurface(manifest);
    if (!surface) {
      return {
        observation: {
          ...common,
          status: "unchecked",
          surface: "unknown",
          observed_at: observedAt(options),
          fault_domain: "manifest_observation",
          retryable: null,
          next_action: "Update the CLI before interpreting this unrecognized manifest execution mode.",
          detail: "manifest execution mode is not recognized by this CLI",
        },
        manifest: null,
      };
    }
    return {
      observation: {
        ...common,
        status: "valid",
        surface,
        observed_at: observedAt(options),
        fault_domain: null,
        retryable: false,
        next_action: validNextAction(service, surface, manifest),
      },
      manifest,
    };
  } catch (error) {
    const timestamp = observedAt(options);
    if (error instanceof AgentManifestFetchError) {
      const details = {
        ...common,
        observed_at: timestamp,
        http_status: error.status,
        content_type: error.details.contentType,
        detail: error.message,
        actual_url: error.details.url,
        cause_class: error.details.causeClass,
        cause_code: error.details.causeCode,
      };
      if (error.status === 404 || error.status === 410) {
        return {
          observation: {
            ...details,
            status: "missing",
            surface: "unknown",
            fault_domain: "manifest_discovery",
            retryable: false,
            next_action: "Ask the service owner to publish a credential-free agent manifest at the registered URL.",
          },
          manifest: null,
          error,
        };
      }
      if (error.status === 429 || error.status >= 500) {
        return {
          observation: {
            ...details,
            status: "unavailable",
            surface: "unknown",
            fault_domain: "manifest_service",
            retryable: true,
            retry_after: error.details.retryAfter ?? null,
            next_action: error.details.retryAfter
              ? `Retry after ${error.details.retryAfter}; the service responded but its manifest is currently unavailable.`
              : "Retry later; the service responded but its manifest is currently unavailable and supplied no Retry-After value.",
          },
          manifest: null,
          error,
        };
      }
      return {
        observation: {
          ...details,
          status: "invalid",
          surface: "unknown",
          fault_domain: "manifest_service",
          retryable: false,
          next_action: "Ask the service owner to expose the manifest as public credential-free JSON at the registered URL.",
        },
        manifest: null,
        error,
      };
    }

    if (error instanceof AgentManifestResponseFormatError) {
      return {
        observation: {
          ...common,
          status: "invalid",
          surface: "unknown",
          observed_at: timestamp,
          fault_domain: "manifest_response",
          retryable: false,
          next_action: "Ask the service owner to return credential-free application/json instead of an HTML or malformed response.",
          content_type: error.details.contentType,
          detail: error.message,
        },
        manifest: null,
        error,
      };
    }

    if (error instanceof Error && isTransportError(error)) {
      const diagnostics = error instanceof CanonicalFetchTransportError
        ? error.diagnostics
        : null;
      const causeClass = diagnostics?.causeClass ?? "unknown";
      return {
        observation: {
          ...common,
          status: "unreachable",
          surface: "unknown",
          observed_at: timestamp,
          fault_domain: "manifest_transport",
          retryable: true,
          next_action: transportNextAction(causeClass),
          detail: error.message,
          actual_url: diagnostics?.url ?? credentialFreeDiagnosticUrl(service.agentManifestUrl),
          cause_class: causeClass,
          cause_code: diagnostics?.causeCode,
        },
        manifest: null,
        error,
      };
    }

    if (error instanceof Error) {
      const schemaPath = inferSchemaPath(error.message);
      return {
        observation: {
          ...common,
          status: "invalid",
          surface: "unknown",
          observed_at: timestamp,
          fault_domain: schemaPath ? "manifest_schema" : "manifest_policy",
          retryable: false,
          next_action: schemaPath
            ? `Ask the service owner to fix manifest schema path ${schemaPath}.`
            : "Ask the service owner to fix the manifest URL, size, redirect, or credential-free transport policy.",
          schema_path: schemaPath ?? undefined,
          detail: error.message,
        },
        manifest: null,
        error,
      };
    }

    return {
      observation: {
        ...common,
        status: "unchecked",
        surface: "unknown",
        observed_at: timestamp,
        fault_domain: "manifest_observation",
        retryable: null,
        next_action: "Update or inspect the CLI before interpreting this unrecognized manifest observation failure.",
        detail: String(error),
      },
      manifest: null,
      error,
    };
  }
}

export function humanSurface(surface: IntegrationSurface): string {
  return surface === "web_only_no_actions" ? "web_only/no_actions" : surface;
}
