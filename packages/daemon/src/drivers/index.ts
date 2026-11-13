import type { RuntimeDriver } from "./types";
import { ClaudeDriver } from "./claude";
import { CodexDriver } from "./codex";
import { GrokDriver } from "./grok";
import { AntigravityDriver } from "./antigravity.deprecated";
import { CopilotDriver } from "./copilot";
import { CursorDriver } from "./cursor";
import { GeminiDriver } from "./gemini";
import { KimiDriver } from "./kimi";
import { KimiSdkDriver } from "./kimi-sdk";
import { OpenCodeDriver } from "./opencode";
import { BuiltInDriver, PiDriver } from "./pi";
import { OarOnlyDriver } from "./oarOnly";

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
  RuntimeSessionRotationHold,
  RuntimeProviderCallSnapshot,
  RuntimeTurnAttribution,
  RuntimeStopOptions,
} from "./types";
export { createChildProcessRuntimeSession, ChildProcessRuntimeSession, RUNTIME_OOM_SCORE_ADJ } from "./runtimeSession";
export {
  allowedTranscriptRootsForRuntime,
  ensureRuntimeHomeDir,
  resolveRuntimeHomeDir,
  resolveRuntimeSessionRef,
  resolveRuntimeSessionRefDetailed,
  runtimeTranscriptHomesForConfig,
  writeRuntimeLifecycleDiagnosticRecord,
  writeRuntimeTerminalCauseRecord,
  type RuntimeLifecycleDiagnosticEvent,
  type ResolveRuntimeSessionRefOptions,
  type RuntimeSessionRefResolution,
  type RuntimeSessionResolution,
  type RuntimeTerminalCausePhase,
  type RuntimeTranscriptHomes,
} from "./runtimeArtifacts";
export {
  projectCompactionInterruptionTraceAttrs,
  projectCompactionInterruption,
  formatCompactionInterruption,
  projectStructuredRuntimeTerminalFailure,
} from "../runtimeCompactionProjection";
export { readClaudeInstallationAsync, resolveClaudeCommand } from "./claude";
export { buildCodexAppServerArgs, buildCodexInstructionShapeAttrs, buildCodexInstructionShapeStaticAttrs, type CodexInstructionObservationPhase, type CodexThreadRequestMethod, codexBlankFinalAnswerDiagnostic, codexCandidateTraceAttrs, codexMcpToolName, codexNotificationDiagnostics, parseCodexTelemetryEvent, CODEX_MANAGED_MCP_TOKEN_ENV, codexThreadFields, parseCodexJsonRpcLine, prepareCodexLaunch, resolveCodexSpawn, type CodexLaunchPreparation, type CodexThreadFields } from "./codex";
export { ANTIGRAVITY_ENV_OVERRIDES, excludeFromWorkspaceGit, prepareAntigravityEnvironment, resolveAntigravitySpawn } from "./antigravity.deprecated";
export { prepareGrokLaunch, type GrokLaunchPlan } from "./grok";
export { isOarOnlyRuntimeId, OAR_ONLY_RUNTIMES, oarOnlyInstallation, prepareOarOnlyLaunchEnv, readOarOnlyCliVersion, type OarOnlyRuntimeId } from "./oarOnly";

const driverFactories: Record<string, () => RuntimeDriver> = {
  builtin: () => new BuiltInDriver(),
  claude: () => new ClaudeDriver(),
  codex: () => new CodexDriver(),
  grok: () => new GrokDriver(),
  // Deprecated: retain for existing agents to run/resume. Shared availability
  // and server admission prohibit creating agents or switching into this runtime.
  antigravity: () => new AntigravityDriver(),
  // Deprecated: retain for existing agents to run/resume. Shared availability
  // and server admission prohibit creating agents or switching into this runtime.
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
  // Run only on the OAR host (drivers/oarOnly.ts): no legacy driver exists.
  qwen: () => new OarOnlyDriver("qwen"),
  qoder: () => new OarOnlyDriver("qoder"),
  codebuddy: () => new OarOnlyDriver("codebuddy"),
};

/** Every runtime id `getDriver` accepts. */
export function registeredRuntimeIds(): string[] {
  return Object.keys(driverFactories);
}

/** The runtimes that are part of the Computer itself (`RuntimeDriver.shipsWithComputer`). */
export function runtimeIdsShippedWithComputer(): Set<string> {
  return new Set(registeredRuntimeIds().filter((id) => getDriver(id).shipsWithComputer === true));
}

/** Get the driver for a runtime ID. Throws if unknown. */
export function getDriver(runtimeId: string): RuntimeDriver {
  const createDriver = driverFactories[runtimeId];
  const driver = createDriver?.();
  if (!driver) {
    throw new Error(`Unknown runtime: ${runtimeId}. Available: ${Object.keys(driverFactories).join(", ")}`);
  }
  return driver;
}

// The release smoke loads the kimi SDK the way a launch does (computer native build).
export { loadKimiSdk, verifyBundledKimiSdk } from "./kimi-sdk";
// The web sign-in for Kimi Code runs on the same SDK, home and identity as its agents.
export { kimiCodeHostIdentity, resolveKimiHome } from "./kimi-sdk";
