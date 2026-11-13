// Qwen Code, Qoder and CodeBuddy Code on OAR (RFC 060): the runtimes with no
// legacy driver (drivers/oarOnly.ts). OAR drives Qwen and Qoder through their
// native stream-json control protocol, CodeBuddy through ACP. Raft supplies what a driver would around the session, from
// the same preparation as Grok's: Raft's CLI transport in the launch
// environment (daemon credentials removed), the standing prompt as the
// runtime's system prompt, model, effort and the native session to resume.
// The executable is the one OAR's own installation lookup finds.
//
// Managed MCP (#oar-raft:#8): Qwen gets the launch's proxy as
// `SessionOptions.mcpServers` when the agent has managed MCP tools and its
// CLI is at least QWEN_MIN_HTTP_MCP_VERSION; OAR sends it in Qwen's
// `initialize` control request. Qoder gets none: OAR would write the token to
// a `--mcp-config` file the agent could read (oarManagedMcp.ts). Nor does
// CodeBuddy yet: what it keeps of a session's MCP entries is not audited.

import type { AvailableInstallation } from "@botiverse/oar";
import { hydrateRuntimeConfig, runtimeConfigToLaunchFields } from "@botiverse/raft-shared";
import { oarOnlyInstallation, OAR_ONLY_RUNTIMES, prepareOarOnlyLaunchEnv, readOarOnlyCliVersion, type OarOnlyRuntimeId } from "../drivers/index";
import type { SpawnContext } from "../drivers/types";
import { loadOarRuntime } from "../oarLoader";
import { RuntimeExecutableNotFoundError } from "../spawnFailureErrors";
import { compareRuntimeCliVersions } from "../runtimeCliVersionTracker";
import { logger } from "../logger";
import { launchEnvOverlay } from "./oarGrokLaunch";
import { withQwenRaftSystemDefaults } from "./qwenSystemDefaults";
import { resolveRaftHome } from "../raftHome";
import path from "node:path";
import type { OarLaunch } from "./oarLaunch";
import type { ManagedMcpRuntimeEndpoint } from "../managedMcpRuntimeProxy";
import { managedMcpSessionOptions, prepareOarManagedMcp } from "./oarManagedMcp";

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * How a delivery to a busy session lands. Qoder steers natively (a `priority:
 * next` user message joins at a tool boundary, OAR #478). Qwen and CodeBuddy
 * have no steer: OAR would queue the input itself, out of the host's sight, so
 * the host holds it and prompts it after the turn end.
 */
const BUSY_DELIVERY: Record<OarOnlyRuntimeId, OarLaunch["busyDelivery"]> = {
  qwen: "after_turn",
  qoder: "now",
  codebuddy: "after_turn",
};

/**
 * Whether the runtime gets managed MCP through `SessionOptions.mcpServers`.
 * Qoder's OAR channel is a 0600 config file for the process's lifetime, which
 * the agent (the same OS user) could read; Qoder never had managed MCP, so the
 * token does not start appearing in a file there.
 */
export const OAR_ONLY_MANAGED_MCP: Record<OarOnlyRuntimeId, boolean> = {
  qwen: true,
  qoder: false,
  // ACP `mcpServers[].headers` on `session/new` (stdin), but neither whether
  // CodeBuddy takes an HTTP server nor what it stores of one is verified.
  codebuddy: false,
};

/**
 * The oldest Qwen Code that takes a streamable HTTP server (`httpUrl`,
 * `headers`) in its `initialize` request: OAR's Qwen baseline, the version its
 * MCP evidence starts at (docs/runtimes/qwen.md; checked through 0.26.9).
 * Qwen has no legacy driver to fall back to, so a version that refused the
 * entry would fail the start; below this, or unreadable, nothing is attached.
 */
export const QWEN_MIN_HTTP_MCP_VERSION = "0.26.0";

/** Whether this Qwen `--version` output is known to take the managed MCP entry. */
export function qwenTakesHttpMcp(version: string | null): boolean {
  if (!version) return false;
  const comparison = compareRuntimeCliVersions(version, QWEN_MIN_HTTP_MCP_VERSION);
  return comparison !== null && comparison >= 0;
}

/** A launch of an OAR-only runtime from the prepared launch environment and OAR's installation. */
export function oarOnlyLaunch(
  runtimeId: OarOnlyRuntimeId,
  ctx: SpawnContext,
  launchEnv: NodeJS.ProcessEnv,
  installation: AvailableInstallation,
  inherited: NodeJS.ProcessEnv = process.env,
  managedMcp: ManagedMcpRuntimeEndpoint | null = null,
): OarLaunch {
  if (managedMcp && !OAR_ONLY_MANAGED_MCP[runtimeId]) throw new Error(`${runtimeId} on OAR takes no managed MCP server`);
  const launchFields = runtimeConfigToLaunchFields(hydrateRuntimeConfig(ctx.config));
  const model = launchFields.model === "default" ? null : nonEmpty(launchFields.model);
  const effort = model ? nonEmpty(launchFields.reasoningEffort) : null;
  const resume = nonEmpty(ctx.config.sessionId);
  return {
    runtimeId,
    installation,
    options: {
      cwd: ctx.workingDirectory,
      env: launchEnvOverlay(launchEnv, inherited),
      systemPrompt: ctx.standingPrompt,
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(resume ? { resume } : {}),
      // Given on every open: OAR passes them again on resume.
      ...managedMcpSessionOptions(managedMcp),
    },
    busyDelivery: BUSY_DELIVERY[runtimeId],
  };
}

export async function prepareOarOnlyLaunch(runtimeId: OarOnlyRuntimeId, ctx: SpawnContext): Promise<OarLaunch> {
  const preparedEnv = await prepareOarOnlyLaunchEnv(ctx);
  const spawnEnv = runtimeId === "qwen"
    ? withQwenRaftSystemDefaults(preparedEnv, ctx.slockHome ? path.resolve(ctx.slockHome) : resolveRaftHome())
    : preparedEnv;
  const installation = await oarOnlyInstallation(await loadOarRuntime(runtimeId));
  if (!installation) {
    const { displayName, binary } = OAR_ONLY_RUNTIMES[runtimeId];
    throw new RuntimeExecutableNotFoundError({ runtimeId, message: `${displayName} CLI (${binary}) was not found on this computer` });
  }
  // Read only once the agent turns out to have managed MCP tools.
  const admitQwen = async () => {
    const version = installation.via === "executable" ? await readOarOnlyCliVersion(installation.command, spawnEnv, ctx.launchSignal) : null;
    if (qwenTakesHttpMcp(version)) return true;
    logger.warn(`[Agent ${ctx.agentId}] managed MCP not attached on Qwen Code: version ${version ? JSON.stringify(version.slice(0, 80)) : "unreadable"} is below ${QWEN_MIN_HTTP_MCP_VERSION}, the oldest known to take an HTTP MCP server`);
    return false;
  };
  const managedMcp = OAR_ONLY_MANAGED_MCP[runtimeId] ? await prepareOarManagedMcp(ctx, admitQwen) : null;
  return oarOnlyLaunch(runtimeId, ctx, spawnEnv, installation, process.env, managedMcp);
}
