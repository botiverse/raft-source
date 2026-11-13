import { randomUUID } from "node:crypto";
import { spawnRuntimeChild } from "./runtimeChild";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { hydrateRuntimeConfig, runtimeConfigToLaunchFields, runtimeModelSourceOutcomeFromSet, type AgentConfig, type RuntimeModelInfo, type RuntimeModelSet, type RuntimeModelSourceOutcome , type AxSurfaceText } from "@botiverse/raft-shared";
import type { RuntimeDriver, SpawnContext, SpawnResult, ParsedEvent } from "./types";
import { buildCliTransportSystemPrompt, prepareCliTransport } from "./cliTransport";
import { kimiToolResultOutcome } from "./kimiToolResult";
import { OpenToolCalls } from "./openToolCalls";
import { resolveCommandOnPath, type ProbeDeps } from "./probe";
import {
  prepareManagedMcpRuntimeProxy,
  writeManagedMcpRuntimeConfigFile,
} from "../managedMcpRuntimeProxy";
import { resolveRaftHome } from "../raftHome";

const KIMI_WIRE_PROTOCOL_VERSION = "1.3";
const KIMI_SYSTEM_PROMPT_FILE = ".slock-kimi-system.md";
const KIMI_AGENT_FILE = ".slock-kimi-agent.yaml";

/**
 * Write the Kimi prompt + agent-config files for a launch.
 *
 * Extracted so the file modes are assertable without spawning a runtime, and
 * to mirror claudeLaunch.ts's writeClaudeSystemPromptFile.
 *
 * The system-prompt file holds the standing prompt (never the launch's first
 * input) and is rewritten on every launch, resume included, so it is always
 * the current one.
 *
 * Both files are 0o600. The prompt body is Raft-authored and carries no
 * credential field, but it lands in the agent workspace and every sibling
 * prompt writer is owner-only; without an explicit mode these are created
 * 0644 under the usual umask (task #302).
 */
export function writeKimiPromptFiles(
  workingDirectory: string,
  standingPrompt: string,
): { systemPromptPath: string; agentFilePath: string } {
  const systemPromptPath = path.join(workingDirectory, KIMI_SYSTEM_PROMPT_FILE);
  const agentFilePath = path.join(workingDirectory, KIMI_AGENT_FILE);
  writeFileSync(systemPromptPath, standingPrompt, { encoding: "utf8", mode: 0o600 });
  writeFileSync(agentFilePath, [
    "version: 1",
    "agent:",
    "  extend: default",
    `  system_prompt_path: ./${KIMI_SYSTEM_PROMPT_FILE}`,
    "",
  ].join("\n"), { encoding: "utf8", mode: 0o600 });
  // writeFileSync only applies `mode` when it CREATES the file, so a
  // pre-existing file keeps its old 0644 — which is exactly the stock this card
  // exists to fix, not just newly created files. chmod is idempotent (task #302).
  chmodSync(systemPromptPath, 0o600);
  chmodSync(agentFilePath, 0o600);
  return { systemPromptPath, agentFilePath };
}


interface JsonRpcEventMessage {
  jsonrpc: "2.0";
  method: "event";
  params?: {
    type?: string;
    payload?: Record<string, any>;
  };
}

interface JsonRpcSuccessResponse {
  jsonrpc: "2.0";
  id?: string;
  result?: Record<string, any>;
}

interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id?: string;
  error?: {
    message?: string;
  };
}

function parseToolArguments(raw: unknown): any {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export function resolveKimiSpawn(commandArgs: string[], deps: ProbeDeps = {}): { command: string; args: string[]; shell: false } {
  return {
    command: resolveCommandOnPath("kimi", deps) ?? "kimi",
    args: commandArgs,
    shell: false,
  };
}

export function buildKimiManagedMcpConfig(managedMcp: {
  name: string;
  url: string;
}): Record<string, unknown> {
  return {
    mcpServers: {
      [managedMcp.name]: {
        url: managedMcp.url,
        transport: "http",
      },
    },
  };
}

export function buildKimiArgs(input: {
  config: AgentConfig;
  sessionId: string;
  agentFilePath: string;
  managedMcpConfigPath?: string | null;
}): string[] {
  const args = [
    "--wire",
    "--yolo",
    "--agent-file", input.agentFilePath,
    "--session", input.sessionId,
  ];
  if (input.managedMcpConfigPath) {
    args.push("--mcp-config-file", input.managedMcpConfigPath);
  }
  const launchRuntimeFields = runtimeConfigToLaunchFields(hydrateRuntimeConfig(input.config));
  if (launchRuntimeFields.model && launchRuntimeFields.model !== "default") {
    args.push("--model", launchRuntimeFields.model);
  }
  return args;
}

export class KimiDriver implements RuntimeDriver {
  readonly id = "kimi";
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
    // Emits the compaction events.
    compaction: "reported",
    compactionFailure: "does_not_stick",
  } as const;
  readonly model = {
    detectedModelsVerifiedAs: "launchable",
    toLaunchSpec: (modelId: string) => ({ args: ["--model", modelId] }),
  } as const;
  readonly supportsStdinNotification = true;
  readonly busyDeliveryMode = "direct" as const;
  /** The standing prompt goes in the `--agent-file` system prompt, so the first input is only the launch's input. */
  readonly supportsNativeStandingPrompt = true;

  private sessionId: string | null = null;
  private sessionAnnounced = false;
  private promptRequestId: string | null = null;
  private readonly openTools = new OpenToolCalls();

  async spawn(ctx: SpawnContext): Promise<SpawnResult> {
    const sessionId = ctx.config.sessionId || randomUUID();
    this.sessionId = sessionId;
    this.sessionAnnounced = false;
    this.openTools.clear();
    this.promptRequestId = randomUUID();

    const { agentFilePath } = writeKimiPromptFiles(ctx.workingDirectory, ctx.standingPrompt);
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
          runtime: "kimi",
          filename: "mcp.json",
          content: JSON.stringify(buildKimiManagedMcpConfig(managedMcp)),
        })
      : null;
    const args = buildKimiArgs({
      config: ctx.config,
      sessionId,
      agentFilePath,
      managedMcpConfigPath,
    });

    const spawnEnv = (await prepareCliTransport(ctx, { NO_COLOR: "1" })).spawnEnv;

    const launch = resolveKimiSpawn(args);
    // task #365: after the last await, right before the child exists.
    ctx.assertLaunchCurrent?.();
    const proc = spawnRuntimeChild(launch.command, launch.args, {
      cwd: ctx.workingDirectory,
      stdio: ["pipe", "pipe", "pipe"],
      env: spawnEnv,
      // Windows cmd.exe defaults to the system code page (often CP936/GBK)
      // and has an 8191-character command-line limit. Kimi's official
      // installer/uv entrypoint is an executable, so launch it directly and
      // keep prompts on stdin / files instead of routing through cmd.exe.
      shell: launch.shell,
    });

    proc.stdin?.write(JSON.stringify({
      jsonrpc: "2.0",
      id: randomUUID(),
      method: "initialize",
      params: {
        protocol_version: KIMI_WIRE_PROTOCOL_VERSION,
        client: { name: "slock-daemon", version: "1.0.0" },
        capabilities: {
          supports_question: false,
          supports_plan_mode: false,
        },
      },
    }) + "\n");

    proc.stdin?.write(JSON.stringify({
      jsonrpc: "2.0",
      id: this.promptRequestId,
      method: "prompt",
      params: {
        user_input: ctx.prompt,
      },
    }) + "\n");

    return { process: proc };
  }

  parseLine(line: string): ParsedEvent[] {
    let message: JsonRpcEventMessage | JsonRpcSuccessResponse | JsonRpcErrorResponse;
    try {
      message = JSON.parse(line);
    } catch {
      return [];
    }

    const events: ParsedEvent[] = [];

    if (!this.sessionAnnounced && this.sessionId) {
      events.push({ kind: "session_init", sessionId: this.sessionId });
      this.sessionAnnounced = true;
    }

    if ("method" in message && message.method === "event") {
      const eventType = message.params?.type;
      const payload = message.params?.payload || {};

      switch (eventType) {
        case "StepBegin":
          events.push({ kind: "thinking", text: "" });
          break;

        case "CompactionBegin":
          events.push({ kind: "compaction_started" });
          break;

        case "CompactionEnd":
          events.push({ kind: "compaction_finished" });
          break;

        case "ContentPart":
          if (payload.type === "think" && payload.think) {
            events.push({ kind: "thinking", text: payload.think });
          } else if (payload.type === "text" && payload.text) {
            events.push({ kind: "text", text: payload.text });
          }
          break;

        case "ToolCall": {
          const name = payload.function?.name || "unknown_tool";
          const callId = typeof payload.id === "string" && payload.id ? payload.id : undefined;
          if (callId && !this.openTools.start(callId, name)) break;
          events.push({
            kind: "tool_call",
            name,
            input: parseToolArguments(payload.function?.arguments),
            ...(callId ? { callId } : {}),
          });
          break;
        }

        case "ToolResult": {
          // Paired with its ToolCall by id; a cancelled step sends none, and
          // the turn's end closes those.
          const callId = typeof payload.tool_call_id === "string" ? payload.tool_call_id : "";
          const name = callId ? this.openTools.end(callId) : undefined;
          if (name === undefined) break;
          const result = payload.return_value || {};
          events.push({
            kind: "tool_output",
            name,
            callId,
            ...kimiToolResultOutcome({ isError: result.is_error, output: result.message || result.output }),
          });
          break;
        }

        case "TurnEnd":
          this.openTools.clear();
          events.push({ kind: "turn_end", sessionId: this.sessionId || undefined });
          break;

        case "StepInterrupted":
          this.openTools.clear();
          events.push({ kind: "error", message: "Turn interrupted" });
          events.push({ kind: "turn_end", sessionId: this.sessionId || undefined });
          break;
      }

      return events;
    }

    if ("error" in message) {
      this.openTools.clear();
      events.push({ kind: "error", message: message.error?.message || "Unknown Kimi error" });
      events.push({ kind: "turn_end", sessionId: this.sessionId || undefined });
    }

    return events;
  }

  encodeStdinMessage(
    _text: string,
    _sessionId: string | null,
    opts?: { mode?: "idle" | "busy" },
  ): string | null {
    const mode = opts?.mode || "busy";

    if (mode === "idle") {
      return JSON.stringify({
        jsonrpc: "2.0",
        id: randomUUID(),
        method: "prompt",
        params: {
          user_input: _text,
        },
      });
    }

    return JSON.stringify({
      jsonrpc: "2.0",
      id: randomUUID(),
      method: "steer",
      params: {
        user_input: _text,
      },
    });
  }

  buildSystemPrompt(config: AgentConfig, _agentId: string): AxSurfaceText {
    return buildCliTransportSystemPrompt(config, {
      extraCriticalRules: [],
    });
  }

  async detectModels(): Promise<RuntimeModelSourceOutcome> {
    return detectKimiModelSource();
  }
}

/**
 * Kimi CLI stores its model catalog in `~/.kimi/config.toml` under
 * `[models.<name>]` sections, with a top-level `default_model`. We do a
 * narrow TOML scan rather than pulling in a full parser dependency.
 */
export function detectKimiModels(home: string = os.homedir()): RuntimeModelSet | null {
  const configPath = path.join(home, ".kimi", "config.toml");
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch {
    return null;
  }

  return parseKimiModelsConfig(raw);
}

export function detectKimiModelSource(home: string = os.homedir()): RuntimeModelSourceOutcome {
  const configPath = path.join(home, ".kimi", "config.toml");
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "ENOENT"
      ? { kind: "missing_config", recovery: "kimi_login" }
      : { kind: "error", retryable: true };
  }
  return runtimeModelSourceOutcomeFromSet(parseKimiModelsConfig(raw));
}

function parseKimiModelsConfig(raw: string): RuntimeModelSet | null {
  const models: RuntimeModelInfo[] = [];
  const sectionRe = /^\s*\[models(?:\.([^\]]+)|"\.[^"]+"|\."[^"]+")\s*\]\s*$/gm;
  // Match `[models.<key>]` and `[models."<key>"]`.
  const lineRe = /^\s*\[models\.(.+?)\s*\]\s*$/gm;
  let match: RegExpExecArray | null;
  while ((match = lineRe.exec(raw)) !== null) {
    let key = match[1].trim();
    if (key.startsWith("\"") && key.endsWith("\"")) key = key.slice(1, -1);
    if (!key) continue;
    models.push({ id: key, label: key, verified: "launchable" });
  }
  // sectionRe is unused but kept to document alternate forms; reference it
  // so TypeScript doesn't complain about an unused local.
  void sectionRe;

  if (models.length === 0) return null;

  let defaultModel: string | undefined;
  const defaultMatch = raw.match(/^\s*default_model\s*=\s*"([^"]+)"/m);
  if (defaultMatch) defaultModel = defaultMatch[1];

  return { models, default: defaultModel };
}
