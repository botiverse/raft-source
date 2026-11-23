// Qwen Code, Qoder and DeepSeek Harness on OAR (RFC 060): the runtimes with
// no legacy driver (drivers/oarOnly.ts). OAR drives Qwen and Qoder through
// their native stream-json control protocol, DSH through a private bridge
// plugin in its own `dsh --profile acp` process. Raft supplies what a driver would around the session, from
// the same preparation as Grok's: Raft's CLI transport in the launch
// environment (daemon credentials removed), the standing prompt as the
// runtime's system prompt, model, effort and the native session to resume.
// The executable is the one OAR's own installation lookup finds.
//
// Busy delivery and managed MCP come from OAR's capability answer for the
// installation (`oarOnlyLaunchPolicy`), not the runtime id.
//
// Managed MCP (#oar-raft:#8, #39): the launch's proxy goes in as
// `SessionOptions.mcpServers` when the agent has managed MCP tools and OAR's
// answer for this installation says a session takes it: `"http"` among its
// verified `mcpTransports` (Raft's entry is a streamable HTTP server; Qwen
// declares it from 0.26.0, an unreadable version declares none) and no refusal
// of `mcpServers` or `mcpServerCredentials` (the token rides in a header; DSH
// refuses that). Raft's own allow-list (RAFT_ADMITS_MANAGED_MCP) stays on top
// until each runtime's credential channel is confirmed private (oarManagedMcp.ts).

import type { AvailableInstallation, SessionCapabilityDeclaration } from "@botiverse/oar";
import { hydrateRuntimeConfig, runtimeConfigToLaunchFields } from "@botiverse/raft-shared";
import { oarOnlyInstallation, OAR_ONLY_RUNTIMES, prepareOarOnlyLaunchEnv, type OarOnlyRuntimeId } from "../drivers/index";
import type { SpawnContext } from "../drivers/types";
import { loadOarRuntime, oarInstalledSessionCapabilities } from "../oarLoader";
import { RuntimeExecutableNotFoundError } from "../spawnFailureErrors";
import { RuntimeVersionTooOldError } from "../runtimeLaunchVersion";
import { launchEnvOverlay } from "./oarGrokLaunch";
import { withQwenRaftSystemDefaults } from "./qwenSystemDefaults";
import { resolveRaftHome } from "../raftHome";
import { logger } from "../logger";
import path from "node:path";
import type { OarLaunch } from "./oarLaunch";
import type { ManagedMcpRuntimeEndpoint } from "../managedMcpRuntimeProxy";
import { managedMcpSessionOptions, prepareOarManagedMcp } from "./oarManagedMcp";

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * What Raft gives an OAR-only launch, decided from OAR's answer for this
 * installation (`oarInstalledSessionCapabilities`), not from the runtime id.
 */
export interface OarOnlyLaunchPolicy {
  /**
   * How a delivery to a busy session lands. `after_turn` only where OAR says
   * a session from this installation has no `steer` (Qwen): OAR would queue
   * the input itself, out of the host's sight, so the host holds it and
   * prompts it after the turn end. Otherwise `now`, including where OAR leaves
   * `steer` unknown until the native handshake (DSH, whose method inventory
   * decides): the host steers only into a session that has `steer`
   * (`launchSteers`, oarAgentHost.ts), holding the input for the turn end
   * otherwise.
   */
  busyDelivery: OarLaunch["busyDelivery"];
  /**
   * Whether the launch gets managed MCP through `SessionOptions.mcpServers`:
   * only where OAR declares `"http"` in this installation's `mcpTransports`
   * (absent means unverified, so no), refuses neither `mcpServers` nor
   * `mcpServerCredentials` (Raft's entry always carries its token in a
   * header), and the runtime is in `RAFT_ADMITS_MANAGED_MCP`.
   */
  managedMcp: boolean;
}

/**
 * Raft's own rule, not an OAR refusal: the OAR-only runtimes whose channel for
 * session MCP servers Raft has checked keeps the managed entry's token away
 * from the agent. An allow-list on purpose: "OAR does not refuse
 * `mcpServerCredentials`" does not mean the token stays private (Qoder's OAR
 * channel is a 0600 `--mcp-config` file for the process's lifetime, which the
 * agent, the same OS user, could read), so a runtime newly added to
 * `OarOnlyRuntimeId` gets no Raft token until someone checks its channel.
 * TODO(#oar-raft:#39): Qoder's channel is now a 0600 FIFO removed after the
 * read (OAR runtimes/qoder/mcp-config.ts); Qoder joins, and this list goes,
 * once OAR's audit #core:#347 confirms every runtime's channel.
 */
export const RAFT_ADMITS_MANAGED_MCP: ReadonlySet<OarOnlyRuntimeId> = new Set(["qwen"]);

export function oarOnlyLaunchPolicy(runtimeId: OarOnlyRuntimeId, caps: SessionCapabilityDeclaration): OarOnlyLaunchPolicy {
  const refused = caps.refusedSessionOptions ?? {};
  return {
    busyDelivery: caps.steer === false ? "after_turn" : "now",
    managedMcp: caps.mcpTransports?.includes("http") === true
      && refused.mcpServers === undefined
      && refused.mcpServerCredentials === undefined
      && RAFT_ADMITS_MANAGED_MCP.has(runtimeId),
  };
}

/**
 * A launch of an OAR-only runtime from the prepared launch environment, OAR's
 * installation and OAR's capability answer for it (`caps`).
 */
export function oarOnlyLaunch(
  runtimeId: OarOnlyRuntimeId,
  ctx: SpawnContext,
  launchEnv: NodeJS.ProcessEnv,
  installation: AvailableInstallation,
  caps: SessionCapabilityDeclaration,
  inherited: NodeJS.ProcessEnv = process.env,
  managedMcp: ManagedMcpRuntimeEndpoint | null = null,
): OarLaunch {
  const policy = oarOnlyLaunchPolicy(runtimeId, caps);
  if (managedMcp && !policy.managedMcp) throw new Error(`${runtimeId} on OAR takes no managed MCP server`);
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
    busyDelivery: policy.busyDelivery,
  };
}

export async function prepareOarOnlyLaunch(runtimeId: OarOnlyRuntimeId, ctx: SpawnContext): Promise<OarLaunch> {
  const preparedEnv = await prepareOarOnlyLaunchEnv(ctx);
  // Raft's own Qwen settings defaults (qwenSystemDefaults.ts): Raft-side
  // configuration with no OAR session option or capability to express it.
  const spawnEnv = runtimeId === "qwen"
    ? withQwenRaftSystemDefaults(preparedEnv, ctx.slockHome ? path.resolve(ctx.slockHome) : resolveRaftHome())
    : preparedEnv;
  const runtime = await loadOarRuntime(runtimeId);
  const installation = await oarOnlyInstallation(runtime);
  if (!installation) {
    const { displayName, binary } = OAR_ONLY_RUNTIMES[runtimeId];
    throw new RuntimeExecutableNotFoundError({ runtimeId, message: `${displayName} CLI (${binary}) was not found on this computer` });
  }
  if (installation.kind === "unsupported") {
    throw new RuntimeVersionTooOldError({
      runtimeId,
      displayName: OAR_ONLY_RUNTIMES[runtimeId].displayName,
      actualVersion: installation.installedVersion ?? "(version unreadable)",
      testedGoodVersion: installation.requiredVersion ?? "a newer release",
    });
  }
  // OAR's answer for this installation (its version included) decides managed MCP.
  const caps = oarInstalledSessionCapabilities(runtime, installation);
  const admitted = oarOnlyLaunchPolicy(runtimeId, caps).managedMcp;
  // A runtime Raft admits that OAR's answer leaves out (an older or unreadable
  // CLI version declares no "http"): said once the agent turns out to have
  // managed MCP tools, so the missing tools can be traced.
  const managedMcp = admitted
    ? await prepareOarManagedMcp(ctx)
    : RAFT_ADMITS_MANAGED_MCP.has(runtimeId)
      ? await prepareOarManagedMcp(ctx, () => {
        const version = installation.via === "executable" ? installation.version : undefined;
        logger.warn(`[Agent ${ctx.agentId}] managed MCP not attached on ${OAR_ONLY_RUNTIMES[runtimeId].displayName}: OAR declares no http MCP transport for this installation (version ${version ? JSON.stringify(version.slice(0, 80)) : "unreadable"}, transports ${JSON.stringify(caps.mcpTransports ?? null)})`);
        return false;
      })
      : null;
  return oarOnlyLaunch(runtimeId, ctx, spawnEnv, installation, caps, process.env, managedMcp);
}
