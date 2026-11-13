// Antigravity on OAR (RFC 060; #oar-raft:#2).
//
// OAR runs `agy acp --dangerously-skip-permissions --process-per-session`: one
// session that lives across turns, where the legacy driver starts `agy` per
// turn. Raft supplies what the driver supplies around it, from the same
// preparation (`prepareAntigravityEnvironment`): the executable, the launch
// environment, and the managed MCP server in the workspace's
// `.agents/mcp_config.json`. The standing prompt goes as `appendSystemPrompt`;
// OAR refuses `systemPrompt` here, and refuses an MCP entry with credentials,
// because `agy` would keep them in its conversation database. Raft's managed
// MCP entry always carries the launch token, so it stays in the workspace
// file and is never passed as `SessionOptions.mcpServers` (#oar-raft:#8,
// oarManagedMcp.ts).
//
// Sign-in is the user's own `agy` login on that machine (tygg, #oar-raft:e4bc9c95),
// made on the Computer or from the web (OAR 0.97 `login`, runtimeAuth/
// runtimeAuthHost.ts); the launch itself reads none of it.
//
// Resume: OAR's `resume` is `agy`'s own session id. The driver's id is its own
// (it resumes with `--continue`), so `agy` doesn't know it, OAR's open fails and
// that start falls back to the driver. An agent that has one moves here once
// its session is reset.

import { hydrateRuntimeConfig, runtimeConfigToLaunchFields } from "@botiverse/raft-shared";
import { prepareAntigravityEnvironment, resolveAntigravitySpawn } from "../drivers/index";
import type { SpawnContext } from "../drivers/types";
import { launchEnvOverlay } from "./oarGrokLaunch";
import type { OarLaunch } from "./oarLaunch";

/** A prepared Antigravity launch as an OAR launch. */
export function antigravityOarLaunch(
  ctx: SpawnContext,
  plan: { command: string; env: NodeJS.ProcessEnv },
  inherited: NodeJS.ProcessEnv = process.env,
): OarLaunch {
  const { model, reasoningEffort } = runtimeConfigToLaunchFields(hydrateRuntimeConfig(ctx.config));
  const resume = ctx.config.sessionId?.trim();
  const pinned = Boolean(model) && model !== "default";
  return {
    runtimeId: "antigravity",
    installation: { kind: "available", via: "executable", command: plan.command },
    options: {
      cwd: ctx.workingDirectory,
      env: launchEnvOverlay(plan.env, inherited),
      appendSystemPrompt: ctx.standingPrompt,
      // "default" leaves the model, and so its thought level, to agy; no effort
      // leaves the chosen model's own level.
      ...(pinned ? { model } : {}),
      ...(pinned && reasoningEffort ? { effort: reasoningEffort } : {}),
      ...(resume ? { resume } : {}),
    },
    // A second native prompt steers the same loop (OAR runtimes/antigravity/session.js).
    busyDelivery: "now",
  };
}

export async function prepareAntigravityOarLaunch(ctx: SpawnContext): Promise<OarLaunch> {
  const env = await prepareAntigravityEnvironment(ctx);
  return antigravityOarLaunch(ctx, { command: resolveAntigravitySpawn([]).command, env });
}
