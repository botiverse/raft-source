import { spawn } from "node:child_process";
import type { AgentConfig, AxSurfaceText } from "@botiverse/raft-shared";
import type { RuntimeDriver, SpawnContext, SpawnResult, ParsedEvent, RuntimeProbeResult } from "./types.js";
import { buildCliTransportSystemPrompt, prepareCliTransport } from "./cliTransport.js";
import { ClaudeEventNormalizer } from "./claudeEventNormalizer.js";
import { assertClaudeStartupPayloadWithinBudget } from "./claudeInputBudget.js";
import { buildClaudeArgs, buildClaudeManagedMcpConfig, buildClaudeSpawnSpec, probeClaude, probeClaudeLaunch, resolveClaudeLaunchCommand, writeClaudeSystemPromptFile } from "./claudeLaunch.js";
import {
  buildClaudeProviderIsolationEnv,
  isClaudeCustomProviderConfig,
  LEGACY_CLAUDE_PROVIDER_CONFIG_DIR,
  shouldWarnLegacyClaudeProviderConfigDir,
} from "./claudeProviderIsolation.js";
import { logger } from "../logger.js";
import { resolveRaftHome } from "../raftHome.js";
import {
  prepareManagedMcpRuntimeProxy,
  writeManagedMcpRuntimeConfigFile,
} from "../managedMcpRuntimeProxy.js";

export {
  buildClaudeArgs,
  buildClaudeSpawnSpec,
  CLAUDE_DESKTOP_CLI_RELATIVE_PATH,
  CLAUDE_DESKTOP_CLI_SYSTEM_PATH,
  CLAUDE_DISALLOWED_TOOLS,
  probeClaude,
  resolveClaudeCommand,
  resolveClaudeLaunchCommand,
} from "./claudeLaunch.js";
export { buildClaudeProviderIsolationEnv } from "./claudeProviderIsolation.js";

export class ClaudeDriver implements RuntimeDriver {
  readonly id = "claude";
  readonly lifecycle = {
    kind: "persistent",
    stdin: "direct",
    inFlightWake: "steer",
  } as const;
  readonly communication = {
    chat: "slock_cli",
    runtimeControl: "none",
  } as const;
  readonly session = {
    recovery: "resume_or_fresh",
  } as const;
  readonly model = {
    detectedModelsVerifiedAs: "launchable",
    toLaunchSpec: (modelId: string) => ({ args: ["--model", modelId] }),
  } as const;
  readonly supportsStdinNotification = true;
  readonly acceptsStdinDuringCompaction = true;
  // Claude Code owns same-turn input ordering through its native stream-json
  // queued-command path. The daemon may therefore write a content-free inbox
  // update while output is active instead of duplicating Claude's queue with a
  // tool-boundary timing gate.
  readonly busyDeliveryMode = "direct" as const;
  // Claude can report a new session id before the conversation is resumable.
  // Treat fresh session ids as delivery-ready only after the producing turn
  // reaches a boundary; existing --resume sessions are ready at launch.
  readonly liveSessionReadyAt = "turn_end" as const;
  readonly supportsNativeStandingPrompt = true;
  // Field receipts prove Claude Code 2.1.59 fails Raft first-run launch with the
  // thinking.type.adaptive request shape and that upgrading to 2.1.220 fixes the
  // failing install. The true minimum fixed version is unknown and may be below
  // 2.1.220, so 2.1.220 is only the tested-good upgrade target, not a hard floor.
  readonly launchVersionPolicy = {
    displayName: "Claude Code",
    knownBadVersions: ["2.1.59"],
    testedGoodVersion: "2.1.220",
    probe: (config: AgentConfig, context: { workingDirectory: string }) => probeClaudeLaunch(config, { cwd: context.workingDirectory }),
  } as const;
  private readonly eventNormalizer = new ClaudeEventNormalizer();

  probe(): RuntimeProbeResult {
    return probeClaude();
  }

  buildClaudeArgs(
    config: AgentConfig,
    opts: { standingPromptFilePath: string; managedMcpConfigPath?: string | null },
  ): string[] {
    return buildClaudeArgs(config, opts);
  }

  async spawn(ctx: SpawnContext): Promise<SpawnResult> {
    // This preflight covers only daemon-owned launch text. Native `--resume`
    // history is assembled inside Claude Code and is not visible at this seam.
    assertClaudeStartupPayloadWithinBudget(ctx.config, `${ctx.standingPrompt}\n${ctx.prompt}`);

    // The daemon resolves the bundled CLI once, then gives each agent a local
    // `slock` wrapper and prepends that directory to PATH. This keeps runtime
    // behavior deterministic: agents always hit the daemon-managed CLI rather
    // than whatever `slock` binary the host machine happens to have installed.
    const { slockDir, tokenFile, spawnEnv } = await prepareCliTransport(
      ctx,
      buildClaudeProviderIsolationEnv(ctx),
    );
    if (
      isClaudeCustomProviderConfig(ctx.config) &&
      shouldWarnLegacyClaudeProviderConfigDir(ctx.workingDirectory)
    ) {
      logger.warn(
        `[Agent ${ctx.agentId}] Legacy Claude custom-provider config directory ${LEGACY_CLAUDE_PROVIDER_CONFIG_DIR} is no longer used; custom-provider Claude now uses host Claude state plus explicit provider env.`,
      );
    }
    const systemPromptPath = writeClaudeSystemPromptFile(ctx.standingPrompt, slockDir);
    const managedMcp = await prepareManagedMcpRuntimeProxy({
      agentId: ctx.agentId,
      launchId: ctx.launchId,
      serverUrl: ctx.config.serverUrl,
      agentCredentialKey: ctx.config.agentCredentialKey,
    });
    const managedMcpConfigPath = managedMcp
      ? writeManagedMcpRuntimeConfigFile({
          agentId: ctx.agentId,
          launchId: ctx.launchId,
          slockHome: ctx.slockHome ?? resolveRaftHome(),
          runtime: "claude",
          filename: "mcp.json",
          content: JSON.stringify(buildClaudeManagedMcpConfig(managedMcp)),
        })
      : null;

    const args = this.buildClaudeArgs(ctx.config, {
      standingPromptFilePath: systemPromptPath,
      managedMcpConfigPath,
    });

    delete spawnEnv.CLAUDECODE;

    logger.info(
      `[Agent ${ctx.agentId}] transport=cli cli=${ctx.slockCliPath} token_file=${tokenFile}`,
    );

    const claudeCommand = resolveClaudeLaunchCommand(ctx.config);
    const spawnSpec = buildClaudeSpawnSpec(claudeCommand);

    const proc = spawn(spawnSpec.command, args, {
      cwd: ctx.workingDirectory,
      stdio: ["pipe", "pipe", "pipe"],
      env: spawnEnv as NodeJS.ProcessEnv,
      shell: spawnSpec.shell,
    });

    // Send initial prompt via stdin (stream-json format)
    const stdinMsg = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: ctx.prompt }],
      },
      ...(ctx.config.sessionId ? { session_id: ctx.config.sessionId } : {}),
    });
    proc.stdin?.write(stdinMsg + "\n");

    return { process: proc };
  }

  parseLine(line: string): ParsedEvent[] {
    return this.eventNormalizer.normalizeLine(line);
  }

  get currentSessionId(): string | null {
    return this.eventNormalizer.currentSessionId;
  }

  encodeStdinMessage(
    text: string,
    sessionId: string | null,
    _opts?: { mode?: "idle" | "busy" },
  ): string | null {
    return JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text }],
      },
      ...(sessionId ? { session_id: sessionId } : {}),
    });
  }

  buildSystemPrompt(config: AgentConfig, _agentId: string): AxSurfaceText {
    return buildCliTransportSystemPrompt(config, {
      extraCriticalRules: [],
    });
  }

}
