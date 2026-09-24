// `raft integration env --service <service>` — print local CLI isolation env for a manifest-backed service.

import type { Command } from "commander";

import type { AgentContext } from "../../auth/env.js";
import { defineCommand, registerCliCommand } from "../../core/command.js";
import type { CommandRuntimeOptions } from "../../core/context.js";
import { cliError } from "../../core/errors.js";
import { writeJson, writeText, NL, adoptCliReplyText } from "../../core/renderer.js";
import { createAgentApiSurfaceClient } from "../../agentApiPath.js";
import type { IntegrationListResponse, RegisteredIntegrationService } from "./_format.js";
import {
  AgentManifestFetchError,
  AgentManifestResponseFormatError,
  buildLocalCliProfileEnv,
  fetchAgentManifest,
  fetchAgentManifestWithWellKnownAliases,
  formatShellExports,
  type AgentManifest,
  type LocalCliProfileEnv,
} from "./manifest.js";

interface EnvOptions {
  service: string;
  json?: boolean;
}

function normalizeService(value: string): string {
  return value.trim().toLowerCase();
}

function findService(data: IntegrationListResponse, service: string): RegisteredIntegrationService | null {
  const normalized = normalizeService(service);
  if (!normalized) return null;
  return data.services.find((candidate) =>
    candidate.id === service
    || normalizeService(candidate.clientId) === normalized
    || normalizeService(candidate.name) === normalized
  ) ?? null;
}

function describeNoLocalEnv(manifest: AgentManifest): string {
  if (manifest.schema === "slock-agent-manifest.v1" && manifest.execution.mode === "local_cli") {
    return "manifest v1 local CLI invocation and credential materialization are design-blocked";
  }
  if (manifest.execution.mode !== "local_cli") {
    if (manifest.actions && manifest.actions.length > 0) {
      return "manifest exposes HTTP API actions; no local CLI env is required";
    }
    return "manifest execution mode is http_api; no local CLI env is required";
  }
  if (!manifest.credential_boundary) {
    return "manifest does not request a Raft-managed local environment";
  }
  if (manifest.credential_boundary.storage === "slock_managed_token") {
    return "manifest uses Raft-managed token storage; no local HOME/XDG exports are required";
  }
  return "manifest does not request local CLI env exports";
}

function describeMissingManifest(input: { service: RegisteredIntegrationService; manifestUrl?: string | null }): string {
  if (input.manifestUrl) {
    return "agent behavior manifest was not found; no local CLI env is required";
  }
  return `${input.service.name} does not expose an agent behavior manifest; no local CLI env is required`;
}

function isInferredWellKnownManifest(service: RegisteredIntegrationService): boolean {
  return service.agentManifestUrlSource === "well_known";
}

function noLocalEnvForMissingManifest(
  service: RegisteredIntegrationService,
): Extract<IntegrationEnvResolution, { kind: "no-local-env" }> {
  return {
    kind: "no-local-env",
    service,
    manifestUrl: service.agentManifestUrl,
    manifest: null,
    message: describeMissingManifest({ service, manifestUrl: service.agentManifestUrl }),
  };
}

export type IntegrationEnvResolution =
  | {
      kind: "local-env";
      service: RegisteredIntegrationService;
      manifestUrl: string;
      profile: LocalCliProfileEnv;
    }
  | {
      kind: "no-local-env";
      service: RegisteredIntegrationService;
      manifestUrl: string | null;
      manifest: AgentManifest | null;
      message: string;
    };

export class IntegrationEnvError extends Error {
  constructor(
    public readonly code:
      | "INTEGRATION_MANIFEST_MISSING"
      | "INTEGRATION_MANIFEST_INVALID"
      | "INTEGRATION_MANIFEST_UNSUPPORTED",
    message: string,
  ) {
    super(message);
    this.name = "IntegrationEnvError";
  }
}

export async function resolveIntegrationEnv(input: {
  ctx: AgentContext;
  service: RegisteredIntegrationService;
  fetchManifest?: typeof fetchAgentManifest;
  env?: NodeJS.ProcessEnv;
}): Promise<IntegrationEnvResolution> {
  if (!input.service.agentManifestUrl) {
    return {
      kind: "no-local-env",
      service: input.service,
      manifestUrl: null,
      manifest: null,
      message: describeMissingManifest({ service: input.service }),
    };
  }

  const fetchManifestImpl = input.fetchManifest ?? (
    isInferredWellKnownManifest(input.service) ? fetchAgentManifestWithWellKnownAliases : fetchAgentManifest
  );
  let manifest;
  try {
    manifest = await fetchManifestImpl(input.service.agentManifestUrl);
  } catch (err) {
    if (err instanceof AgentManifestFetchError && (err.status === 404 || err.status === 410)) {
      return noLocalEnvForMissingManifest(input.service);
    }
    if (isInferredWellKnownManifest(input.service) && err instanceof AgentManifestResponseFormatError) {
      return noLocalEnvForMissingManifest(input.service);
    }
    throw new IntegrationEnvError("INTEGRATION_MANIFEST_INVALID", (err as Error).message);
  }

  if (
    manifest.schema === "slock-agent-manifest.v1"
    || manifest.execution.mode !== "local_cli"
    || manifest.credential_boundary?.storage !== "per_agent_home"
  ) {
    return {
      kind: "no-local-env",
      service: input.service,
      manifestUrl: input.service.agentManifestUrl,
      manifest,
      message: describeNoLocalEnv(manifest),
    };
  }

  try {
    return {
      kind: "local-env",
      service: input.service,
      manifestUrl: input.service.agentManifestUrl,
      profile: buildLocalCliProfileEnv({
        ctx: input.ctx,
        serviceId: input.service.clientId,
        manifest,
        env: input.env,
      }),
    };
  } catch (err) {
    throw new IntegrationEnvError("INTEGRATION_MANIFEST_UNSUPPORTED", (err as Error).message);
  }
}

function formatNoLocalEnv(input: {
  service: string;
  manifestUrl: string | null;
  message: string;
  actions?: string[];
}): string {
  const lines = [
    `# Raft integration profile for ${input.service}`,
    input.manifestUrl ? `# manifest: ${input.manifestUrl}` : "# manifest: none declared",
    "# No local CLI environment exports are required for this service.",
    `# ${input.message}`,
  ];
  if (input.actions && input.actions.length > 0) {
    lines.push(`# API actions: ${input.actions.join(", ")}`);
    lines.push(`# list actions: raft integration invoke --service ${JSON.stringify(input.service)} --list-actions`);
    lines.push(`# invoke action: raft integration invoke --service ${JSON.stringify(input.service)} --action <name>`);
  }
  lines.push("# Raft did not set HOME/XDG exports and did not execute manifest commands.");
  return lines.join("\n");
}

export const integrationEnvCommand = defineCommand(
  {
    name: "env",
    description: "Print per-agent local environment for a manifest-backed local CLI integration",
    options: [
      { flags: "--service <id>", description: "Registered service id, client id, or exact service name" },
      { flags: "--json", description: "Emit machine-readable JSON" },
    ],
  },
  async (cmdCtx, opts: EnvOptions) => {
    const serviceQuery = opts.service?.trim() ?? "";
    if (!serviceQuery) {
      throw cliError("INVALID_ARG", "--service must not be empty");
    }

    const ctx = cmdCtx.loadAgentContext();
    const client = cmdCtx.createApiClient(ctx);
    const res = await createAgentApiSurfaceClient(client).integrations.list();
    if (!res.ok || !res.data) {
      const code = res.status >= 500 ? "SERVER_5XX" : "INTEGRATION_LIST_FAILED";
      throw cliError(code, res.error ?? `HTTP ${res.status}`);
    }

    const integrations = res.data;
    const service = findService(integrations, serviceQuery);
    if (!service) {
      throw cliError("INTEGRATION_NOT_FOUND", `No registered integration matched ${serviceQuery}`);
    }
    let resolution;
    try {
      resolution = await resolveIntegrationEnv({ ctx, service });
    } catch (err) {
      if (err instanceof IntegrationEnvError) throw cliError(err.code, err.message, { cause: err });
      throw err;
    }

    if (resolution.kind === "no-local-env") {
      if (opts.json) {
        writeJson(cmdCtx.io, {
          ok: true,
          data: {
            service: resolution.service.clientId,
            manifestUrl: resolution.manifestUrl,
            requiresLocalEnv: false,
            command: resolution.manifest?.schema === "slock-agent-manifest.v0"
              ? resolution.manifest.execution.command ?? null
              : null,
            actions: resolution.manifest?.actions?.map((action) => action.name) ?? [],
            env: {},
            message: resolution.message,
          },
        });
        return;
      }
      writeText(cmdCtx.io, adoptCliReplyText(formatNoLocalEnv({
        service: resolution.service.clientId,
        manifestUrl: resolution.manifestUrl,
        message: resolution.message,
        actions: resolution.manifest?.actions?.map((action) => action.name) ?? [],
      })), NL);
      return;
    }

    if (opts.json) {
      writeJson(cmdCtx.io, {
        ok: true,
        data: {
          service: resolution.service.clientId,
          manifestUrl: resolution.manifestUrl,
          requiresLocalEnv: true,
          command: resolution.profile.command,
          profileHome: resolution.profile.profileHome,
          env: resolution.profile.env,
        },
      });
      return;
    }

    writeText(cmdCtx.io, adoptCliReplyText(formatShellExports(resolution.profile)), NL);
  },
);

export function registerIntegrationEnvCommand(parent: Command, runtimeOptions: CommandRuntimeOptions = {}): void {
  registerCliCommand(parent, integrationEnvCommand, runtimeOptions);
}
