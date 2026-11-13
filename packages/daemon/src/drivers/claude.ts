import { spawnRuntimeChild } from "./runtimeChild";
import type { AgentConfig, AxSurfaceText, RuntimeModelSourceOutcome } from "@botiverse/raft-shared";
import type { RuntimeDriver, SpawnContext, SpawnResult, ParsedEvent, RuntimeProbeResult } from "./types";
import { buildCliTransportSystemPrompt, prepareCliTransport } from "./cliTransport";
import { ClaudeEventNormalizer } from "./claudeEventNormalizer";
import { assertClaudeStartupPayloadWithinBudget } from "./claudeInputBudget";
import { buildClaudeArgs, buildClaudeManagedMcpConfig, buildClaudeSpawnSpec, probeClaude, probeClaudeLaunch, resolveClaudeLaunchCommand, resolveClaudeLaunchCommandAsync, writeClaudeSystemPromptFile } from "./claudeLaunch";
import { detectClaudeModelSource } from "./claudeModels";
import { ProbeChildError } from "./probeChild";
import {
  buildClaudeProviderIsolationEnv,
  isClaudeCustomProviderConfig,
  LEGACY_CLAUDE_PROVIDER_CONFIG_DIR,
  shouldWarnLegacyClaudeProviderConfigDir,
} from "./claudeProviderIsolation";
import { logger } from "../logger";
import { resolveRaftHome } from "../raftHome";
import {
  prepareManagedMcpRuntimeProxy,
  writeManagedMcpRuntimeConfigFile,
} from "../managedMcpRuntimeProxy";

export {
  buildClaudeArgs,
  buildClaudeSpawnSpec,
  CLAUDE_DESKTOP_CLI_RELATIVE_PATH,
  CLAUDE_DESKTOP_CLI_SYSTEM_PATH,
  CLAUDE_DISALLOWED_TOOLS,
  probeClaude,
  readClaudeInstallationAsync,
  resolveClaudeCommand,
  resolveClaudeLaunchCommand,
} from "./claudeLaunch";
export { buildClaudeProviderIsolationEnv } from "./claudeProviderIsolation";

export const CLAUDE_CODE_ENTRYPOINT = "raft";

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
    // ClaudeEventNormalizer emits the compaction events.
    compaction: "reported",
    compactionFailure: "does_not_stick",
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
  // Claude Code's `Agent` tool is not in CLAUDE_DISALLOWED_TOOLS.
  readonly supportsSubagents = true;
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

  async detectModels(): Promise<RuntimeModelSourceOutcome> {
    return detectClaudeModelSource();
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
    const { slockDir, spawnEnv } = await prepareCliTransport(
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
      processInstanceId: ctx.processInstanceId,
      readTurnOrigin: ctx.readTurnOrigin,
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
    // Name the client that runs this session (Claude Code records it as the
    // transcript `entrypoint`). Overwritten, not defaulted: a daemon started
    // from inside another Claude Code / SDK session inherits `sdk-cli` / `sdk-ts`.
    // Headless `sdk-*` sessions were measured to use a subscription's 5-hour
    // window ~2x faster per token (anthropics/claude-code#97074; #triage:c73bf864).
    spawnEnv.CLAUDE_CODE_ENTRYPOINT = CLAUDE_CODE_ENTRYPOINT;
    // Raft keeps agent memory in the workspace MEMORY.md. Claude Code's auto
    // memory adds a second MEMORY.md under ~/.claude/projects/<slug>/memory
    // with its own rules, so turn it off (as Qwen's managed memory is).
    spawnEnv.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";

    logger.info(
      `[Agent ${ctx.agentId}] transport=cli cli=${ctx.slockCliPath}`,
    );

    // task #1277: the PATH lookup runs as a bounded probe child under this
    // start attempt's signal; a cancelled lookup is rethrown, never a verdict.
    const claudeCommand = await resolveClaudeLaunchCommandAsync(ctx.config, { signal: ctx.launchSignal });
    const spawnSpec = buildClaudeSpawnSpec(claudeCommand, args, { env: spawnEnv as NodeJS.ProcessEnv });

    // task #365: after the last await, right before the child exists.
    ctx.assertLaunchCurrent?.();
    // A start stopped while the lookup ran must not create a child.
    if (ctx.launchSignal?.aborted) throw new ProbeChildError("claude launch cancelled before the child was created", { code: "ABORT_ERR" });
    const proc = spawnRuntimeChild(spawnSpec.command, spawnSpec.args, {
      cwd: ctx.workingDirectory,
      stdio: ["pipe", "pipe", "pipe"],
      env: spawnSpec.env ?? spawnEnv as NodeJS.ProcessEnv,
      shell: false,
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

  /**
   * task #25 step 2: Claude Code's stream-json interrupt. Checked on 2.1.299:
   * the turn ends with an `error_during_execution` result, Claude kills the
   * running tool's whole process tree (a `setsid` child included), and the
   * process takes the next message.
   */
  encodeInterruptRequest(): string {
    this.eventNormalizer.noteInterruptRequested();
    this.interruptRequests += 1;
    return JSON.stringify({
      type: "control_request",
      request_id: `raft-interrupt-${this.interruptRequests}`,
      request: { subtype: "interrupt" },
    });
  }

  private interruptRequests = 0;

  /**
   * #proj-runtime:#41: Claude Code's `stop_task` control request stops one
   * task by its `task_id` (the `task_started` envelope's, kept as the
   * subagent's `SubagentLineage.taskId`). Checked on 2.1.304, without an
   * initialize: a background or a foreground subagent ends with
   * `task_notification` status `stopped`; the agent's turn and its other
   * subagents carry on. Its control_response is not read.
   */
  encodeSubagentInterruptRequest(subagentTaskId: string): string {
    this.subagentStopRequests += 1;
    return JSON.stringify({
      type: "control_request",
      request_id: `raft-stop-task-${this.subagentStopRequests}`,
      request: { subtype: "stop_task", task_id: subagentTaskId },
    });
  }

  private subagentStopRequests = 0;

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
      supportsSubagents: this.supportsSubagents,
    });
  }

}
