import type { RuntimeDriver } from "./types.js";
import { ClaudeDriver } from "./claude.js";
import { CodexDriver } from "./codex.js";
import { GrokDriver } from "./grok.js";
import { AntigravityDriver } from "./antigravity.deprecated.js";
import { CopilotDriver } from "./copilot.js";
import { CursorDriver } from "./cursor.js";
import { GeminiDriver } from "./gemini.js";
import { KimiDriver } from "./kimi.js";
import { KimiSdkDriver } from "./kimi-sdk.js";
import { OpenCodeDriver } from "./opencode.js";
import { BuiltInDriver, PiDriver } from "./pi.js";

export type {
  RuntimeDriver,
  RuntimeBusyDeliveryReadiness,
  ParsedEvent,
  SpawnContext,
  SpawnResult,
  RuntimeSession,
  RuntimeExitInfo,
  RuntimeSendResult,
  RuntimeSessionDescriptor,
  RuntimeTurnAttribution,
} from "./types.js";
export { createChildProcessRuntimeSession, ChildProcessRuntimeSession } from "./runtimeSession.js";
export {
  allowedTranscriptRootsForRuntime,
  ensureRuntimeHomeDir,
  resolveRuntimeHomeDir,
  resolveRuntimeSessionRef,
  writeRuntimeTerminalCauseRecord,
  type ResolveRuntimeSessionRefOptions,
  type RuntimeTerminalCausePhase,
} from "./runtimeArtifacts.js";
export {
  projectCompactionInterruptionTraceAttrs,
  projectStructuredRuntimeTerminalFailure,
} from "../runtimeCompactionProjection.js";
export { resolveClaudeCommand } from "./claude.js";
export { buildCodexAppServerArgs, parseCodexJsonRpcLine, resolveCodexSpawn } from "./codex.js";

const driverFactories: Record<string, () => RuntimeDriver> = {
  builtin: () => new BuiltInDriver(),
  claude: () => new ClaudeDriver(),
  codex: () => new CodexDriver(),
  grok: () => new GrokDriver(),
  // Deprecated: retain for existing agents to run/resume. Shared availability
  // and server admission prohibit creating agents or switching into this runtime.
  antigravity: () => new AntigravityDriver(),
  copilot: () => new CopilotDriver(),
  cursor: () => new CursorDriver(),
  gemini: () => new GeminiDriver(),
  // Two separate Kimi runtimes (per #proj-runtime:cc818e65 6/16 consensus):
  //   - `kimi`     = legacy kimi-cli child-process driver. Backward-compat for
  //                  existing `runtime=kimi` agents. Frontend marks deprecated.
  //   - `kimi-sdk` = canonical in-process SDK driver. Frontend label "Kimi Code".
  // No alias / no auto-migration; explicit pick at agent-create time.
  kimi: () => new KimiDriver(),
  "kimi-sdk": () => new KimiSdkDriver(),
  opencode: () => new OpenCodeDriver(),
  pi: () => new PiDriver(),
};

/** Get the driver for a runtime ID. Throws if unknown. */
export function getDriver(runtimeId: string): RuntimeDriver {
  const createDriver = driverFactories[runtimeId];
  const driver = createDriver?.();
  if (!driver) {
    throw new Error(`Unknown runtime: ${runtimeId}. Available: ${Object.keys(driverFactories).join(", ")}`);
  }
  return driver;
}
