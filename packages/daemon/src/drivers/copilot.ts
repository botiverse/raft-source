import { spawn } from "node:child_process";
import { hydrateRuntimeConfig, runtimeConfigToLaunchFields, type AgentConfig , type AxSurfaceText } from "@botiverse/raft-shared";
import type { RuntimeDriver, SpawnContext, SpawnResult, ParsedEvent } from "./types.js";
import { buildCliTransportSystemPrompt, prepareCliTransport } from "./cliTransport.js";
import {
  prepareManagedMcpRuntimeProxy,
  writeManagedMcpRuntimeConfigFile,
} from "../managedMcpRuntimeProxy.js";
import { resolveRaftHome } from "../raftHome.js";

export async function buildCopilotSpawnEnv(ctx: SpawnContext): Promise<NodeJS.ProcessEnv> {
  return (await prepareCliTransport(ctx, { NO_COLOR: "1" })).spawnEnv;
}

export function buildCopilotManagedMcpConfig(managedMcp: {
  name: string;
  url: string;
}): Record<string, unknown> {
  return {
    mcpServers: {
      [managedMcp.name]: {
        type: "http",
        url: managedMcp.url,
        tools: ["*"],
      },
    },
  };
}

export function buildCopilotArgs(ctx: SpawnContext, managedMcpConfigPath?: string | null): string[] {
  const args = [
    "--output-format", "json",
    "--allow-all-tools",
    "--allow-all-paths",
    "-p", ctx.prompt,
  ];

  if (managedMcpConfigPath) {
    args.push(`--additional-mcp-config=@${managedMcpConfigPath}`);
  }

  const launchRuntimeFields = runtimeConfigToLaunchFields(hydrateRuntimeConfig(ctx.config));
  if (launchRuntimeFields.model && launchRuntimeFields.model !== "default") {
    args.push("--model", launchRuntimeFields.model);
  }

  if (launchRuntimeFields.reasoningEffort) {
    args.push("--effort", launchRuntimeFields.reasoningEffort);
  }

  if (ctx.config.sessionId) {
    args.push(`--resume=${ctx.config.sessionId}`);
  }

  return args;
}

/**
 * GitHub Copilot CLI driver.
 *
 * Uses `--output-format json` which emits JSONL events with a different
 * schema from Claude/Cursor:
 *   { type: "assistant.message", data: { content, toolRequests, ... }, id, timestamp, ... }
 *
 * No stdin streaming support — each turn is a separate process invocation.
 */
export class CopilotDriver implements RuntimeDriver {
  readonly id = "copilot";
  readonly lifecycle = {
    kind: "per_turn",
    start: "immediate",
    exit: "natural",
    inFlightWake: "spawn_new",
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
  readonly supportsStdinNotification = false;
  readonly busyDeliveryMode = "none" as const;

  private sessionId: string | null = null;
  private sessionAnnounced = false;

  async spawn(ctx: SpawnContext): Promise<SpawnResult> {
    this.sessionId = ctx.config.sessionId || null;
    this.sessionAnnounced = false;

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
          runtime: "copilot",
          filename: "mcp-config.json",
          content: JSON.stringify(buildCopilotManagedMcpConfig(managedMcp)),
        })
      : null;
    const args = buildCopilotArgs(ctx, managedMcpConfigPath);

    const spawnEnv = await buildCopilotSpawnEnv(ctx);

    const proc = spawn("copilot", args, {
      cwd: ctx.workingDirectory,
      stdio: ["pipe", "pipe", "pipe"],
      env: spawnEnv,
      shell: process.platform === "win32",
    });

    return { process: proc };
  }

  parseLine(line: string): ParsedEvent[] {
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      return [];
    }

    const events: ParsedEvent[] = [];
    const eventType = event.type;
    const data = event.data || {};

    // Skip ephemeral setup events
    if (event.ephemeral && eventType?.startsWith("session.")) {
      return [];
    }

    switch (eventType) {
      case "assistant.turn_start":
        if (!this.sessionAnnounced && data.sessionId) {
          this.sessionId = data.sessionId;
          events.push({ kind: "session_init", sessionId: data.sessionId });
          this.sessionAnnounced = true;
        }
        events.push({ kind: "thinking", text: "" });
        break;

      case "assistant.reasoning":
        if (data.content) {
          events.push({ kind: "thinking", text: data.content });
        }
        break;

      case "assistant.message_delta":
        if (data.deltaContent) {
          events.push({ kind: "text", text: data.deltaContent });
        }
        break;

      case "assistant.message": {
        // Final assembled message — extract tool calls if any
        if (Array.isArray(data.toolRequests)) {
          for (const req of data.toolRequests) {
            events.push({
              kind: "tool_call",
              name: req.name || req.toolName || "unknown_tool",
              input: req.arguments || req.parameters || req.input || {},
            });
          }
        }
        // If this is the final message with text content and no delta was streamed
        if (!event.ephemeral && data.content && typeof data.content === "string") {
          // Only emit if we haven't already streamed via deltas
          // The message event without toolRequests is the final text
          if (!Array.isArray(data.toolRequests) || data.toolRequests.length === 0) {
            // Text was likely already streamed via message_delta, skip
          }
        }
        break;
      }

      case "assistant.turn_end":
        events.push({ kind: "turn_end", sessionId: this.sessionId || undefined });
        break;

      case "result": {
        // Result event has sessionId/exitCode at top level or inside data
        const resultSessionId = event.sessionId || data.sessionId;
        const exitCode = event.exitCode ?? data.exitCode;
        if (!this.sessionAnnounced && resultSessionId) {
          this.sessionId = resultSessionId;
          events.push({ kind: "session_init", sessionId: resultSessionId });
          this.sessionAnnounced = true;
        }
        if (exitCode && exitCode !== 0) {
          events.push({ kind: "error", message: `Copilot exited with code ${exitCode}` });
        }
        // Result is the final event — emit turn_end if not already emitted by turn_end event
        events.push({ kind: "turn_end", sessionId: this.sessionId || undefined });
        break;
      }
    }

    return events;
  }

  encodeStdinMessage(
    _text: string,
    _sessionId: string | null,
    _opts?: { mode?: "idle" | "busy" },
  ): string | null {
    // Copilot CLI does not support stdin streaming
    return null;
  }

  buildSystemPrompt(config: AgentConfig, _agentId: string): AxSurfaceText {
    return buildCliTransportSystemPrompt(config, {
      extraCriticalRules: [],
    });
  }

}
