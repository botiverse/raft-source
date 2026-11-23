// Runtimes that run only on the OAR host (RFC 060): Qwen Code, Qoder and
// DeepSeek Harness have no legacy driver, only OAR's runtime. The daemon still asks a driver for the
// runtime's detection probe, its model listing and its standing prompt (the
// OAR host builds the first input from it, agentHost/oarAgentHost.ts), so each
// gets this driver shell. It never spawns: `oarOnly` tells the router
// (agentHost/agentHostRouter.ts) and the OAR host that no start of this runtime
// may go to the legacy host; one that cannot run on OAR fails instead.
//
// When the OAR host becomes the default and the legacy drivers retire, the
// `oarOnly` flag is the line along which these fields move into a per-runtime
// OAR descriptor next to `OAR_LAUNCHES`.

import type { AvailableInstallation, ModelEntry, Runtime, VersionUnsupportedInstallation } from "@botiverse/oar";
import type { AgentConfig, AxSurfaceText, RuntimeModelSourceOutcome } from "@botiverse/raft-shared";
import { loadOarRuntime, type OarOnlyRuntimeId } from "../oarLoader";
import { detectModelSourceViaOar } from "../runtimeModels/oarListModels";
import { buildCliTransportSystemPrompt, prepareCliTransport } from "./cliTransport";
import { lookupCommandOnPath, readCommandVersion, type ProbeDeps } from "./probe";
import type { ParsedEvent, RuntimeDriver, RuntimeProbeResult, SpawnContext, SpawnResult } from "./types";

/** The OAR-only runtimes: their ids are both Raft's and OAR's. */
export type { OarOnlyRuntimeId };

// Below the server's request budget (MODEL_DETECTION_REQUEST_TIMEOUT_MS, 20s), so our
// timeout, not the server's, is what the form sees. Qoder can take 7-25s to
// initialize (OAR #476): a slow first listing reports a retryable timeout.
const OAR_ONLY_MODEL_DETECTION_DEADLINE_MS = 18_000;

interface OarOnlyRuntimeSpec {
  id: OarOnlyRuntimeId;
  displayName: string;
  /** The executable OAR launches, looked up on PATH for detection. */
  binary: string;
  /**
   * A resumed session takes the standing prompt of this launch: OAR passes it
   * on resume and these runtimes apply it (Qoder per OAR #466; Qwen Code 0.26
   * sends the resumed turn with the new --system-prompt, checked against the
   * real CLI; DSH per OAR's `resumedSessionOptions`: a given prompt applies at
   * once). Otherwise a changed prompt would be re-delivered in the first
   * input (standingPromptRefresh.ts).
   */
  standingPromptRefreshesOnResume: boolean;
  /** Keep OAR's effort menu: only where Raft's form offers an effort for the runtime (DSH). */
  keepReasoningEfforts: boolean;
  /**
   * Detection counts the binary only when its `--version` line is a plain
   * semver, as OAR reads it (DSH: Debian's distributed shell is `/usr/bin/dsh`
   * too, and OAR refuses a version it cannot parse).
   */
  requireSemverVersion?: true;
}

/** A `--version` line that is one semver and nothing else (OAR's DSH version grammar). */
const SEMVER_LINE = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z.-]+)?$/u;

export const OAR_ONLY_RUNTIMES: Record<OarOnlyRuntimeId, OarOnlyRuntimeSpec> = {
  qwen: {
    id: "qwen",
    displayName: "Qwen Code",
    binary: "qwen",
    standingPromptRefreshesOnResume: true,
    keepReasoningEfforts: false,
  },
  qoder: {
    id: "qoder",
    displayName: "Qoder",
    binary: "qodercli",
    standingPromptRefreshesOnResume: true,
    keepReasoningEfforts: false,
  },
  dsh: {
    id: "dsh",
    displayName: "DeepSeek Harness",
    // Detection looks for `dsh` on PATH only; a launch runs what OAR's own
    // lookup finds (which also honours OAR_DSH_BIN).
    binary: "dsh",
    // OAR replaces the system prompt on resume too (`resumedSessionOptions`
    // systemPrompt `immediate`), and the launch gives it on every open.
    standingPromptRefreshesOnResume: true,
    // OAR lists each model's own reasoning efforts (dsh's catalog) and applies
    // the session's `effort` as dsh's `reasoningEffort`, refusing one dsh did not apply.
    keepReasoningEfforts: true,
    // Not Debian's distributed shell (`/usr/bin/dsh`), whose `--version` is no semver.
    requireSemverVersion: true,
  },
};

/** The launch environment of an OAR-only start: Raft's CLI transport, as a driver's spawn would prepare it. */
export async function prepareOarOnlyLaunchEnv(ctx: SpawnContext): Promise<NodeJS.ProcessEnv> {
  return (await prepareCliTransport(ctx, { NO_COLOR: "1" })).spawnEnv;
}

export function isOarOnlyRuntimeId(id: string): id is OarOnlyRuntimeId {
  return Object.hasOwn(OAR_ONLY_RUNTIMES, id);
}

/**
 * The installation OAR would launch; the one it found but refuses as too old
 * (`version_unsupported`, e.g. Qoder below 1.1.78 from OAR 0.115), so callers
 * say "update" rather than "not found"; or null when OAR finds none.
 */
export async function oarOnlyInstallation(runtime: Runtime): Promise<AvailableInstallation | VersionUnsupportedInstallation | null> {
  if (!runtime.installation) return null;
  const installation = await runtime.installation();
  if (installation.kind === "available") return installation;
  return installation.kind === "unsupported" && installation.code === "version_unsupported" ? installation : null;
}

export class OarOnlyDriver implements RuntimeDriver {
  readonly oarOnly = true as const;
  readonly id: OarOnlyRuntimeId;
  readonly lifecycle = { kind: "persistent", stdin: "direct", inFlightWake: "steer" } as const;
  readonly communication = { chat: "slock_cli", runtimeControl: "none" } as const;
  readonly stdoutChannel = "structured_protocol" as const;
  readonly session = {
    recovery: "resume_or_fresh",
    // The OAR host does not forward a compaction event for these runtimes.
    compaction: "unreported",
    compactionFailure: "does_not_stick",
  } as const;
  readonly model = { detectedModelsVerifiedAs: "launchable" } as const;
  readonly startupReadiness = "initial_turn" as const;
  readonly supportsStdinNotification = false;
  readonly busyDeliveryMode = "none" as const;
  /** OAR passes the standing prompt as the runtime's own system prompt. */
  readonly supportsNativeStandingPrompt = true;
  readonly standingPromptRefreshesOnResume: boolean;
  private readonly spec: OarOnlyRuntimeSpec;

  constructor(id: OarOnlyRuntimeId, private readonly probeDeps: ProbeDeps = {}) {
    this.spec = OAR_ONLY_RUNTIMES[id];
    this.id = id;
    this.standingPromptRefreshesOnResume = this.spec.standingPromptRefreshesOnResume;
  }

  probe(): RuntimeProbeResult {
    const { command, missReason } = lookupCommandOnPath(this.spec.binary, this.probeDeps);
    if (!command) {
      return { available: false, unavailableReason: missReason, diagnostic: `No ${this.spec.displayName} CLI (${this.spec.binary}) was found on PATH.` };
    }
    const version = readCommandVersion(command, [], this.probeDeps);
    if (this.spec.requireSemverVersion && !(version && SEMVER_LINE.test(version.trim()))) {
      return {
        available: false,
        unavailableReason: "not_installed",
        diagnostic: `The ${this.spec.binary} on PATH does not report a ${this.spec.displayName} version (another program of that name?).`,
      };
    }
    return { available: true, ...(version ? { version } : {}) };
  }

  /**
   * Never reached: the router fails an OAR-only start the OAR host cannot run
   * (agentHostRouter.ts), and the core fails one when the OAR host is off (core.ts).
   */
  spawn(): SpawnResult {
    throw new Error(`${this.spec.displayName} runs only on the OAR host; the legacy host must never start it`);
  }

  parseLine(): ParsedEvent[] {
    return [];
  }

  encodeStdinMessage(): string | null {
    return null;
  }

  buildSystemPrompt(config: AgentConfig, _agentId: string): AxSurfaceText {
    return buildCliTransportSystemPrompt(config, { extraCriticalRules: [] });
  }

  async detectModels(): Promise<RuntimeModelSourceOutcome> {
    const runtime = await loadOarRuntime(this.id);
    if (!runtime.listModels) return { kind: "error", retryable: false, code: "detect_failed" };
    const installation = await oarOnlyInstallation(runtime);
    if (!installation) return { kind: "error", retryable: true, code: "runtime_not_found" };
    // As oarListModels maps a lister's own `version_unsupported`: the form says to update the CLI.
    if (installation.kind === "unsupported") return { kind: "error", retryable: true, code: "protocol_unsupported" };
    return detectModelSourceViaOar({
      lister: runtime.listModels,
      installation,
      deadlineMs: OAR_ONLY_MODEL_DETECTION_DEADLINE_MS,
      label: (entry: ModelEntry) => entry.displayName ?? entry.id,
      keepReasoningEfforts: this.spec.keepReasoningEfforts,
      onUnsupported: () => ({ kind: "error", retryable: false, code: "detect_failed" }),
    });
  }
}
