// Claude Code on OAR (#oar-raft:#48, behind `agent_runtime_oar_claude` and
// `runtime-host:oar:claude`), through the generic capability-driven launch
// builder (`genericOarLaunch`, #oar-raft:#39).
//
// Maps Raft's Claude launch invariants onto OAR 0.123+ `SessionOptions`:
// - `appendSystemPrompt`: standing prompt (matches legacy `--append-system-prompt-file`)
// - `model` / `effort` / `serviceTier: "fast"` / `resume` / `disallowedTools`
// - `userConfiguration: { exclude: ["settings"] }` for custom providers
//   (replaces manual `--setting-sources project,local`)
// - `claudeRuntime.credentials.env` (plus legacy keys) stripped for custom
//   providers unless explicitly supplied in `envVars`
// - `CLAUDE_CODE_ENTRYPOINT = "raft"` (avoids `sdk-*` 5h-window burn),
//   `CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1"`, `CLAUDECODE` removed
// - Managed MCP proxy (including `continuation_tool_v0`) over OAR `mcpServers`
//   (0600 FIFO on POSIX, unlinked once Claude reads it)

import path from "node:path";
import type { AvailableInstallation, Runtime } from "@botiverse/oar";
import { hydrateRuntimeConfig, runtimeConfigToLaunchFields } from "@botiverse/raft-shared";
import { CONTINUATION_ANSWER_TOOL_NAME, RAFT_CONTINUATION_TOOL_ENV } from "@botiverse/raft-shared/src/continuations/index";
import { continuationAnswerRunnerForLaunch } from "../continuationAnswerTool";
import {
  assertClaudeStartupPayloadWithinBudget,
  CLAUDE_CODE_ENTRYPOINT,
  CLAUDE_CUSTOM_PROVIDER_HOST_ENV_KEYS,
  CLAUDE_DISALLOWED_TOOLS,
  isClaudeCustomProviderConfig,
  LEGACY_CLAUDE_PROVIDER_CONFIG_DIR,
  prepareClaudeCliTransport,
  resolveClaudeLaunchCommandAsync,
  shouldWarnLegacyClaudeProviderConfigDir,
} from "../drivers/index";
import type { SpawnContext } from "../drivers/types";
import { logger } from "../logger";
import { prepareManagedMcpRuntimeProxy, type ManagedMcpRuntimeEndpoint } from "../managedMcpRuntimeProxy";
import { loadOarSessionRuntime, oarInstalledSessionCapabilities } from "../oarLoader";
import { genericOarLaunch } from "./oarGenericLaunch";
import { OarLaunchDeclined, type OarLaunch } from "./oarLaunch";

const CLAUDE_DISALLOWED_TOOLS_LIST = CLAUDE_DISALLOWED_TOOLS.split(",").filter(Boolean);

/**
 * Parent-session markers inherited when the daemon itself runs inside another
 * Claude Code session (mirrors OAR `runtimes/claude/environment.js`). Removing
 * them from `spawnEnv` unless explicitly configured lets `launchEnvOverlay`
 * emit `null` so OAR strips them rather than overwriting OAR's removal map.
 */
const CLAUDE_INHERITED_PARENT_SESSION_MARKERS = [
  "CLAUDECODE",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_CHROME_MCP_ORG_DENIED",
  "CLAUDE_CODE_EVAL_INTERVIEW_SESSION",
  "CLAUDE_CODE_BRIDGE_SESSION_ID",
  "CLAUDE_CODE_HOST_WORKTREE",
  "CLAUDE_CODE_HOST_WORKTREE_FENCE",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
] as const;

function isClaudeScopedCredentialVar(name: string): boolean {
  return name.startsWith("ANTHROPIC_")
    || name.startsWith("CLAUDE_CODE_")
    || name.startsWith("VERTEX_REGION_CLAUDE_")
    || name === "AWS_BEARER_TOKEN_BEDROCK"
    || name === "CLOUD_ML_REGION";
}

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Custom-provider host-env isolation driven by OAR 0.123+'s
 * `claudeRuntime.credentials.env` (filtered to Claude/Anthropic-scoped names
 * so ambient AWS/GCP/Azure CLI credentials stay available to agent Bash tools,
 * matching legacy `ClaudeDriver`) union Raft's legacy list: any host provider
 * variable not explicitly configured in `envVars` is cleared (`undefined`), so
 * `launchEnvOverlay` emits `null` in `SessionOptions.env` to strip it from the
 * child process.
 */
export function buildOarClaudeProviderIsolationEnv(
  ctx: Pick<SpawnContext, "config">,
  runtime: Pick<Runtime, "credentials">,
): Record<string, string | undefined> {
  if (!isClaudeCustomProviderConfig(ctx.config)) return {};
  const launchFields = runtimeConfigToLaunchFields(hydrateRuntimeConfig(ctx.config));
  const explicitEnv = launchFields.envVars ?? {};
  const keys = new Set<string>(CLAUDE_CUSTOM_PROVIDER_HOST_ENV_KEYS);
  for (const variable of runtime.credentials?.env ?? []) {
    if (isClaudeScopedCredentialVar(variable.name)) {
      keys.add(variable.name);
    }
  }
  const env: Record<string, string | undefined> = {};
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(explicitEnv, key)) {
      env[key] = undefined;
    }
  }
  return env;
}

export interface PrepareClaudeOarLaunchDeps {
  loadRuntime?: () => Promise<Runtime>;
  resolveCommand?: (ctx: SpawnContext) => Promise<string | null>;
  prepareTransport?: (
    ctx: SpawnContext,
    extraEnv: Record<string, string | undefined>,
  ) => Promise<{ slockDir: string; spawnEnv: Record<string, string | undefined> }>;
  prepareManagedMcp?: (
    ctx: SpawnContext,
    input: { slockDir: string; spawnEnv: Record<string, string | undefined> },
  ) => Promise<{ endpoint: ManagedMcpRuntimeEndpoint | null; hasContinuationRunner: boolean }>;
  inheritedEnv?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

/**
 * Prepares a Claude Code launch on OAR (`agent_runtime_oar_claude`,
 * `#oar-raft:#48`) via `genericOarLaunch`.
 */
export async function prepareClaudeOarLaunch(
  ctx: SpawnContext,
  deps: PrepareClaudeOarLaunchDeps = {},
): Promise<OarLaunch> {
  if ((ctx.config.runtime || "claude") !== "claude") {
    throw new OarLaunchDeclined("claude_runtime_mismatch", `Expected runtime "claude", got ${ctx.config.runtime || "claude"}`);
  }

  const hydrated = hydrateRuntimeConfig(ctx.config);
  if (hydrated.runtime !== "claude") {
    throw new OarLaunchDeclined("claude_runtime_mismatch", `Hydrated runtime config is ${hydrated.runtime}, not claude`);
  }

  // Keep the exact startup payload preflight used by ClaudeDriver.
  assertClaudeStartupPayloadWithinBudget(ctx.config, `${ctx.standingPrompt}\n${ctx.prompt}`);

  const runtime = await (deps.loadRuntime ? deps.loadRuntime() : loadOarSessionRuntime("claude"));
  const command = await (deps.resolveCommand
    ? deps.resolveCommand(ctx)
    : resolveClaudeLaunchCommandAsync(ctx.config, { signal: ctx.launchSignal }));
  if (!command) {
    throw new OarLaunchDeclined("claude_not_found", "Claude Code CLI not found");
  }

  const installation: AvailableInstallation = { kind: "available", via: "executable", command };
  const customProvider = isClaudeCustomProviderConfig(ctx.config);
  const providerIsolationEnv = buildOarClaudeProviderIsolationEnv(ctx, runtime);
  const { slockDir, spawnEnv } = await (deps.prepareTransport
    ? deps.prepareTransport(ctx, providerIsolationEnv)
    : prepareClaudeCliTransport(ctx, providerIsolationEnv));

  if (customProvider && shouldWarnLegacyClaudeProviderConfigDir(ctx.workingDirectory)) {
    logger.warn(
      `[Agent ${ctx.agentId}] Legacy Claude custom-provider config directory ${LEGACY_CLAUDE_PROVIDER_CONFIG_DIR} is no longer used; custom-provider Claude now uses host Claude state plus explicit provider env.`,
    );
  }

  const launchFields = runtimeConfigToLaunchFields(hydrated);
  const explicitEnv = launchFields.envVars ?? {};
  for (const marker of CLAUDE_INHERITED_PARENT_SESSION_MARKERS) {
    if (marker === "CLAUDECODE" || !Object.prototype.hasOwnProperty.call(explicitEnv, marker)) {
      delete spawnEnv[marker];
    }
  }
  // Name Raft as the client entrypoint (matches legacy ClaudeDriver; avoids
  // headless `sdk-*` 5h-window burn, #triage:c73bf864).
  spawnEnv.CLAUDE_CODE_ENTRYPOINT = CLAUDE_CODE_ENTRYPOINT;
  // Raft keeps agent memory in workspace MEMORY.md; disable Claude auto-memory.
  spawnEnv.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";

  const caps = oarInstalledSessionCapabilities(runtime, installation);
  const refused = caps.refusedSessionOptions ?? {};
  let managedMcp: ManagedMcpRuntimeEndpoint | null = null;
  if (!refused.mcpServers && !refused.mcpServerCredentials) {
    if (deps.prepareManagedMcp) {
      const prepared = await deps.prepareManagedMcp(ctx, { slockDir, spawnEnv });
      managedMcp = prepared.endpoint;
      if (managedMcp && prepared.hasContinuationRunner) {
        spawnEnv[RAFT_CONTINUATION_TOOL_ENV] = CONTINUATION_ANSWER_TOOL_NAME;
      }
    } else {
      const continuationRunner = continuationAnswerRunnerForLaunch({
        config: ctx.config,
        raftBin: path.join(slockDir, "raft"),
        env: spawnEnv,
        cwd: ctx.workingDirectory,
      });
      managedMcp = await prepareManagedMcpRuntimeProxy({
        agentId: ctx.agentId,
        launchId: ctx.launchId,
        processInstanceId: ctx.processInstanceId,
        readTurnOrigin: ctx.readTurnOrigin,
        serverUrl: ctx.config.serverUrl,
        agentCredentialKey: ctx.config.agentCredentialKey,
        continuationRunner,
      });
      if (managedMcp && continuationRunner) {
        spawnEnv[RAFT_CONTINUATION_TOOL_ENV] = CONTINUATION_ANSWER_TOOL_NAME;
      }
    }
  }

  const model = launchFields.model === "default" ? null : (nonEmpty(launchFields.model) ?? "sonnet");
  const serviceTier = launchFields.mode.kind === "fast" ? "fast" : null;

  return genericOarLaunch("claude", runtime, installation, ctx, spawnEnv as NodeJS.ProcessEnv, {
    inherited: deps.inheritedEnv,
    platform: deps.platform,
    managedMcp,
    standingPromptMode: "appendSystemPrompt",
    model,
    effort: nonEmpty(launchFields.reasoningEffort),
    serviceTier,
    resume: nonEmpty(ctx.config.sessionId),
    disallowedTools: CLAUDE_DISALLOWED_TOOLS_LIST,
    ...(customProvider ? { userConfiguration: { exclude: ["settings"] } } : {}),
  });
}
