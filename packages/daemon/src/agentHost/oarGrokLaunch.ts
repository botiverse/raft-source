// Grok Build on OAR (RFC 060, the first runtime the OAR host runs).
//
// OAR runs `grok agent --always-approve --no-leader stdio`, the command the
// legacy driver runs (flags in another order). Raft supplies what the driver
// supplied around it, from the same preparation (`prepareGrokLaunch`): the
// executable, the launch environment (Raft's CLI transport added, daemon
// credentials removed), model, effort and the native session to resume, plus
// the standing prompt as `systemPrompt`, which OAR sends as grok's
// `systemPromptOverride` like the driver does.
//
// Managed MCP (#oar-raft:#8; the driver attaches none): when the agent has
// managed MCP tools, the launch's proxy goes as `SessionOptions.mcpServers`,
// an HTTP entry with the token as a bearer header, which OAR sends as ACP
// `mcpServers` on `session/new` / `session/resume` (oarManagedMcp.ts).
//
// Resume: OAR's `resume` is grok's own session id (ACP `session/resume` or
// `session/load` with the same `sessionId` and `cwd` the driver sends to
// `session/load`), in grok's own store under the same environment and cwd, so
// a session the legacy driver started is the session OAR resumes.

import { prepareGrokLaunch, type GrokLaunchPlan } from "../drivers/index";
import type { SpawnContext } from "../drivers/types";
import type { ManagedMcpRuntimeEndpoint } from "../managedMcpRuntimeProxy";
import type { OarLaunch } from "./oarLaunch";
import { managedMcpSessionOptions, prepareOarManagedMcp } from "./oarManagedMcp";

/**
 * The launch environment as OAR's overlay on the daemon's environment (which
 * OAR inherits): every launch variable, and `null` for each daemon variable
 * the launch does not carry (credentials, profile pointers; see
 * `prepareCliTransport`), so the runtime gets exactly the launch environment.
 * On Windows names match in any case: the daemon's `Path` is the launch's
 * `PATH`, and a `null` for it would make OAR (which drops every spelling of a
 * name it sets or removes there) remove PATH altogether.
 */
export function launchEnvOverlay(
  launchEnv: NodeJS.ProcessEnv,
  inherited: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Record<string, string | null> {
  const key = platform === "win32" ? (name: string) => name.toUpperCase() : (name: string) => name;
  const overlay: Record<string, string | null> = {};
  const carried = new Set<string>();
  for (const [name, value] of Object.entries(launchEnv)) {
    if (value === undefined) continue;
    overlay[name] = value;
    carried.add(key(name));
  }
  for (const [name, value] of Object.entries(inherited)) {
    if (value !== undefined && !carried.has(key(name))) overlay[name] = null;
  }
  return overlay;
}

/** A prepared grok launch as an OAR launch. */
export function grokOarLaunch(
  ctx: SpawnContext,
  plan: GrokLaunchPlan & { managedMcp?: ManagedMcpRuntimeEndpoint | null },
  inherited: NodeJS.ProcessEnv = process.env,
): OarLaunch {
  return {
    runtimeId: "grok",
    installation: { kind: "available", via: "executable", command: plan.command },
    options: {
      cwd: ctx.workingDirectory,
      env: launchEnvOverlay(plan.env, inherited),
      systemPrompt: ctx.standingPrompt,
      ...(plan.model ? { model: plan.model } : {}),
      ...(plan.reasoningEffort ? { effort: plan.reasoningEffort } : {}),
      ...(plan.resumeSessionId ? { resume: plan.resumeSessionId } : {}),
      // Given on every open: grok remembers none across a resume.
      ...managedMcpSessionOptions(plan.managedMcp),
      // A Stop ends what the turn started (OAR 0.99, #733): once grok ends the
      // aborted turn, OAR stops the ACP terminals that turn created and answers
      // the abort request with a `cleanup` response, the stop's only
      // completion evidence (as Codex's). Terminals from before the prompt
      // are kept. OAR does not record it: given again on resume.
      endTurnProcessesOnAbort: true,
    },
    // OAR 0.96 (#716) steers grok with `_x.ai/interject`, as the driver does:
    // the input joins the running turn at its next safe point and cancels
    // nothing (accepted once grok answers `queued`). With no turn running OAR
    // answers `no_active_turn` and the host holds it for the turn end.
    busyDelivery: "now",
  };
}

export async function prepareGrokOarLaunch(ctx: SpawnContext): Promise<OarLaunch> {
  const plan = await prepareGrokLaunch(ctx);
  return grokOarLaunch(ctx, { ...plan, managedMcp: await prepareOarManagedMcp(ctx) });
}
