// Generic capability-driven OAR launch builder (#oar-raft:#39, #oar-raft:#48).
//
// Reads OAR's own `Runtime.refusedSessionOptions` and `sessionCapabilities()`
// declarations so newly migrated runtimes (starting with Pi, next Claude/Kimi)
// share one standard SessionOptions builder instead of duplicating per-runtime
// launch plumbing.

import { chmodSync, closeSync, constants as fsConstants, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AvailableInstallation, Runtime, SessionOptions } from "@botiverse/oar";
import { hydrateRuntimeConfig, runtimeConfigToLaunchFields } from "@botiverse/raft-shared";
import { buildPiSpawnEnv, buildPiSessionDir } from "../drivers/index";
import type { SpawnContext } from "../drivers/types";
import { logger } from "../logger";
import type { ManagedMcpRuntimeEndpoint } from "../managedMcpRuntimeProxy";
import { loadOarSessionRuntime, oarInstalledSessionCapabilities } from "../oarLoader";
import { launchEnvOverlay } from "./oarGrokLaunch";
import { OarLaunchDeclined, type OarLaunch } from "./oarLaunch";
import { managedMcpSessionOptions, prepareOarManagedMcp } from "./oarManagedMcp";

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export interface GenericOarLaunchInput {
  inherited?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  managedMcp?: ManagedMcpRuntimeEndpoint | null;
  /** Preferred carrier for `ctx.standingPrompt`; falls back to the other if refused. */
  standingPromptMode?: "systemPrompt" | "appendSystemPrompt";
  disallowedTools?: readonly string[];
  launchArgs?: readonly string[];
  userConfiguration?: SessionOptions["userConfiguration"];
  model?: string | null;
  effort?: string | null;
  serviceTier?: string | null;
  resume?: string | null;
}

/**
 * Turns a Raft `SpawnContext` + launch environment into an `OarLaunch` driven
 * by the OAR runtime's declared `refusedSessionOptions` and `sessionCapabilities`.
 */
export function genericOarLaunch(
  runtimeId: OarLaunch["runtimeId"],
  runtime: Pick<Runtime, "refusedSessionOptions" | "manualCompaction" | "sessionCapabilities">,
  installation: AvailableInstallation,
  ctx: SpawnContext,
  launchEnv: NodeJS.ProcessEnv,
  input: GenericOarLaunchInput = {},
): OarLaunch {
  const capabilities = oarInstalledSessionCapabilities(runtime, installation);
  const refused = capabilities.refusedSessionOptions ?? {};
  const launchFields = runtimeConfigToLaunchFields(hydrateRuntimeConfig(ctx.config));
  const model = input.model !== undefined
    ? nonEmpty(input.model)
    : (launchFields.model === "default" ? null : nonEmpty(launchFields.model));
  const effort = input.effort !== undefined
    ? nonEmpty(input.effort)
    : nonEmpty(launchFields.reasoningEffort);
  const resume = input.resume !== undefined
    ? nonEmpty(input.resume)
    : nonEmpty(ctx.config.sessionId);

  let promptOption: Pick<SessionOptions, "systemPrompt" | "appendSystemPrompt"> = {};
  if (ctx.standingPrompt) {
    const preferred = input.standingPromptMode ?? "systemPrompt";
    const fallback = preferred === "systemPrompt" ? "appendSystemPrompt" : "systemPrompt";
    if (!refused[preferred]) promptOption = { [preferred]: ctx.standingPrompt };
    else if (!refused[fallback]) promptOption = { [fallback]: ctx.standingPrompt };
  }

  const options: SessionOptions = {
    cwd: ctx.workingDirectory,
    ...(!refused.env ? { env: launchEnvOverlay(launchEnv, input.inherited ?? process.env, input.platform ?? process.platform) } : {}),
    ...promptOption,
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(input.serviceTier && !refused.serviceTier ? { serviceTier: input.serviceTier } : {}),
    ...(resume ? { resume } : {}),
    ...(input.managedMcp && !refused.mcpServers && !refused.mcpServerCredentials ? managedMcpSessionOptions(input.managedMcp) : {}),
    ...(!refused.endTurnProcessesOnAbort ? { endTurnProcessesOnAbort: true } : {}),
    ...(input.disallowedTools && input.disallowedTools.length > 0 && !refused.disallowedTools ? { disallowedTools: [...input.disallowedTools] } : {}),
    ...(input.launchArgs && input.launchArgs.length > 0 && !refused.launchArgs ? { launchArgs: [...input.launchArgs] } : {}),
    ...(input.userConfiguration !== undefined
      && (input.userConfiguration === "include"
        || (input.userConfiguration === "exclude" && !refused.userConfiguration)
        || (typeof input.userConfiguration === "object" && !refused.userConfiguration && !refused.partialUserConfiguration))
      ? { userConfiguration: input.userConfiguration }
      : {}),
  };

  return {
    runtimeId,
    installation,
    options,
    busyDelivery: capabilities?.steer === false ? "after_turn" : "now",
  };
}

/**
 * Resolves Pi's global agent dir identically to OAR's `openPiRpc`
 * (`OAR_PI_AGENT_DIR` -> `PI_CODING_AGENT_DIR` -> `<HOME|USERPROFILE|homedir>/.pi/agent`).
 */
export function piOarAgentDir(
  env: NodeJS.ProcessEnv,
  homeDir: string = os.homedir(),
): string {
  const pinned = [env.OAR_PI_AGENT_DIR, env.PI_CODING_AGENT_DIR].find((value) => typeof value === "string" && value.length > 0);
  if (pinned) return path.resolve(pinned);
  const home = [env.HOME, env.USERPROFILE].find((value) => typeof value === "string" && value.length > 0) ?? homeDir;
  return path.resolve(path.join(home, ".pi", "agent"));
}

/**
 * Mirrors OAR's `piSessionDir` (`runtimes/pi/resolve.js`) and Pi SDK's
 * `getDefaultSessionDirPath`: `<agentDir>/sessions/--<cwd-slug>--`.
 */
export function piOarSessionDir(cwd: string, agentDir: string): string {
  const slug = path.resolve(cwd).replace(/^[/\\]/u, "").replaceAll(/[/\\:]/gu, "-");
  return path.join(path.resolve(agentDir), "sessions", `--${slug}--`);
}

const PI_SESSION_HEADER_READ_BYTES = 16 * 1024;

function readPiSessionHeaderId(filePath: string): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(filePath, "r");
    const buf = Buffer.allocUnsafe(PI_SESSION_HEADER_READ_BYTES);
    const bytesRead = readSync(fd, buf, 0, buf.length, 0);
    if (bytesRead <= 0) return null;
    const text = buf.subarray(0, bytesRead).toString("utf8");
    const newline = text.indexOf("\n");
    const firstLine = (newline >= 0 ? text.slice(0, newline) : text).trim();
    if (!firstLine) return null;
    const header = JSON.parse(firstLine) as { type?: unknown; id?: unknown };
    return header.type === "session" && typeof header.id === "string" && header.id.length > 0 ? header.id : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Ignore close errors on read-only fd.
      }
    }
  }
}

function findPiSessionFileInDir(dir: string, sessionId: string): string | null {
  try {
    // Reject symlinked directories (the agent controls its workspace cwd).
    if (!lstatSync(dir).isDirectory()) return null;
  } catch {
    return null;
  }
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  const suffix = `_${sessionId}.jsonl`;
  const priority: string[] = [];
  const rest: string[] = [];
  for (const name of entries) {
    if (!name.endsWith(".jsonl")) continue;
    const full = path.join(dir, name);
    try {
      if (!lstatSync(full).isFile()) continue;
    } catch {
      continue;
    }
    if (name.endsWith(suffix)) priority.push(full);
    else rest.push(full);
  }
  for (const full of [...priority, ...rest]) {
    if (readPiSessionHeaderId(full) === sessionId) return full;
  }
  return null;
}

/**
 * One-time non-destructive migration of a legacy Pi session file from
 * `<cwd>/.pi-sessions/` into OAR Pi's session store (`<agentDir>/sessions/--<cwd-slug>--/`).
 * Never overwrites an existing native OAR session file and leaves the legacy file intact
 * so a pre-first-turn fallback to legacy `PiDriver` still finds its snapshot.
 */
export function migrateLegacyPiSessionFile(
  cwd: string,
  sessionId: string,
  agentDir: string,
): { migrated: boolean; targetPath?: string } {
  const targetDir = piOarSessionDir(cwd, agentDir);
  if (findPiSessionFileInDir(targetDir, sessionId)) {
    return { migrated: false };
  }
  const legacyFile = findPiSessionFileInDir(buildPiSessionDir(cwd), sessionId);
  if (!legacyFile) return { migrated: false };

  mkdirSync(targetDir, { recursive: true, mode: 0o700 });
  const targetPath = path.join(targetDir, path.basename(legacyFile));
  try {
    copyFileSync(legacyFile, targetPath, fsConstants.COPYFILE_EXCL);
    try {
      chmodSync(targetPath, 0o600);
    } catch {
      // Best-effort permissions tightening.
    }
    return { migrated: true, targetPath };
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === "EEXIST") {
      return { migrated: false };
    }
    throw error;
  }
}

const PI_WORKSPACE_SKILL_PATHS = [
  path.join(".pi", "skills"),
  path.join(".pi", "prompts"),
  path.join(".agents", "skills"),
] as const;

/**
 * True when the workspace carries project-scoped Pi skills or prompts that
 * OAR's `projectTrusted: false` mode deliberately withholds.
 */
export function hasPiWorkspaceSkillsOrPrompts(cwd: string): boolean {
  for (const rel of PI_WORKSPACE_SKILL_PATHS) {
    const full = path.join(cwd, rel);
    if (!existsSync(full)) continue;
    try {
      const stat = lstatSync(full);
      if (!stat.isDirectory()) return true;
      if (readdirSync(full).length > 0) return true;
    } catch {
      return true;
    }
  }
  return false;
}

export interface PreparePiOarLaunchDeps {
  buildEnv?: (ctx: SpawnContext) => Promise<NodeJS.ProcessEnv>;
  loadRuntime?: () => Promise<Runtime>;
  prepareManagedMcp?: (ctx: SpawnContext) => Promise<ManagedMcpRuntimeEndpoint | null>;
  inheritedEnv?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

/**
 * Prepares a Pi launch on OAR (`agent_runtime_oar_pi`, #oar-raft:#48) through
 * `genericOarLaunch`, with canary decline guards for capabilities that keep
 * legacy `PiDriver` during rollout.
 */
export async function preparePiOarLaunch(
  ctx: SpawnContext,
  deps: PreparePiOarLaunchDeps = {},
): Promise<OarLaunch> {
  if ((ctx.config.runtime || "claude") !== "pi") {
    throw new OarLaunchDeclined("pi_runtime_mismatch", `Expected runtime "pi", got ${ctx.config.runtime || "claude"}`);
  }

  const hydrated = hydrateRuntimeConfig(ctx.config);
  if (hydrated.runtime !== "pi") {
    throw new OarLaunchDeclined("pi_runtime_mismatch", `Hydrated runtime config is ${hydrated.runtime}, not pi`);
  }
  if (hydrated.provider && hydrated.provider.kind !== "default") {
    throw new OarLaunchDeclined("pi_custom_provider", `Pi provider ${hydrated.provider.kind} stays on legacy driver during OAR canary`);
  }

  const launchFields = runtimeConfigToLaunchFields(hydrated);
  const model = launchFields.model === "default" ? null : nonEmpty(launchFields.model);
  if (model) {
    const slash = model.indexOf("/");
    if (slash <= 0 || slash === model.length - 1) {
      throw new OarLaunchDeclined("pi_unqualified_model", `Pi OAR requires a provider/model id; got ${JSON.stringify(model)}`);
    }
  }

  if (hasPiWorkspaceSkillsOrPrompts(ctx.workingDirectory)) {
    throw new OarLaunchDeclined("pi_workspace_skills_present", "Workspace contains .pi/skills, .pi/prompts, or .agents/skills; keeping legacy Pi driver");
  }

  const runtime = await (deps.loadRuntime ? deps.loadRuntime() : loadOarSessionRuntime("pi"));
  const installation = runtime.installation ? await runtime.installation() : { kind: "not_found" as const };
  if (installation.kind !== "available") {
    throw new OarLaunchDeclined("pi_installation_unavailable", `OAR Pi installation is ${installation.kind}`);
  }

  const spawnEnv = await (deps.buildEnv ? deps.buildEnv(ctx) : buildPiSpawnEnv(ctx));
  const resume = nonEmpty(ctx.config.sessionId);
  if (resume) {
    try {
      const result = migrateLegacyPiSessionFile(ctx.workingDirectory, resume, piOarAgentDir(spawnEnv));
      if (result.migrated) {
        logger.info(`[Agent ${ctx.agentId}] Migrated legacy Pi session ${resume} into OAR session store`);
      }
    } catch (error) {
      logger.warn(`[Agent ${ctx.agentId}] Failed to migrate legacy Pi session ${resume}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const refused = runtime.refusedSessionOptions ?? {};
  const managedMcp = !refused.mcpServers && !refused.mcpServerCredentials
    ? await (deps.prepareManagedMcp ? deps.prepareManagedMcp(ctx) : prepareOarManagedMcp(ctx))
    : null;

  return genericOarLaunch("pi", runtime, installation, ctx, spawnEnv, {
    inherited: deps.inheritedEnv,
    platform: deps.platform,
    managedMcp,
    standingPromptMode: "systemPrompt",
    model,
    effort: nonEmpty(launchFields.reasoningEffort),
    resume,
  });
}
