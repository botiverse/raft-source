import type { TurnEndCompactionDriverOutcome, TurnEndContextFacts } from "../turnEndCompaction";
import { randomUUID } from "node:crypto";
import { ambientProcessEnv } from "../processEnvPatch";
import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import type {
  Session as KimiSession,
  createKimiHarness,
  Event as KimiSdkEvent,
  GoalToolResult,
  KimiHarness,
  KimiHostIdentity,
} from "@botiverse/kimi-code-sdk";

import {
  RuntimeConfigInvalidError,
  RuntimeLoginRequiredError,
  RuntimeModelNotConfiguredError,
} from "../spawnFailureErrors";
import { kimiToolResultOutcome } from "./kimiToolResult";
import { SendIntentArgumentScanner } from "./sendIntentScanner";

const requireFromHere = createRequire(import.meta.url);

type KimiSdk = typeof import("@botiverse/kimi-code-sdk");

// The SDK is loaded on the first Kimi launch, not at daemon startup: importing
// it builds ~8k zod schemas (~75 MB of heap) that every runner otherwise
// carries whether or not any agent on the machine uses Kimi. Model detection
// stays SDK-free (see resolveKimiHome below).
let kimiSdk: KimiSdk | null = null;
let kimiSdkLoading: Promise<KimiSdk> | null = null;

export function loadKimiSdk(): Promise<KimiSdk> {
  kimiSdkLoading ??= import("@botiverse/kimi-code-sdk").then((sdk) => (kimiSdk = sdk));
  return kimiSdkLoading;
}

/**
 * Load the SDK the way a Kimi launch does and check its entry point exists.
 * The SEA build ships it as a separate asset (computer native build), so the
 * release smoke runs this instead of waiting for a user's first Kimi agent.
 */
export async function verifyBundledKimiSdk(): Promise<void> {
  const sdk = await loadKimiSdk();
  if (typeof sdk.createKimiHarness !== "function") {
    throw new Error("bundled kimi SDK is missing createKimiHarness");
  }
}

/** A KimiError can only exist once the SDK has been loaded. */
function isKimiError(error: unknown): error is import("@botiverse/kimi-code-sdk").KimiError {
  return kimiSdk?.isKimiError(error) ?? false;
}

/**
 * The Kimi Code SDK home for an env (the spawn env at session launch, which
 * already merges the agent's env vars over the daemon's; the daemon's own env
 * for model detection), without loading the SDK. The transcript resolver
 * (runtimeArtifacts `resolveKimiSdkHomeFromConfig`) applies the same rule,
 * `kimiSdkHomeFromEnv` (kimiCodeHome.ts), to the same merge, so the two
 * cannot read different homes. It matches the SDK's own resolver for an unset
 * or absolute `KIMI_CODE_HOME` (pinned by kimi-sdk.test.ts); an empty value
 * counts as unset and a relative one is resolved against the daemon's cwd,
 * where the in-process SDK resolves it too.
 */
export function resolveKimiHome(env: Record<string, string | undefined> = process.env): string {
  return kimiSdkHomeFromEnv(env, homedir());
}

/**
 * Canonical `kimi-code-cli` UA product — the same product string upstream
 * `apps/kimi-code/src/constant/app.ts` uses (`CLI_USER_AGENT_PRODUCT`).
 * Moonshot's `kimi-for-coding` model gate keys on this product. We're a
 * legitimate consumer of `@moonshot-ai/kimi-code-sdk` (via the
 * `@botiverse/kimi-code-sdk` mirror), so identifying as `kimi-code-cli` is
 * accurate, not impersonation. Telemetry-side, the `userAgentSuffix` we add
 * (`slock-daemon/<version>`) makes our traffic distinguishable.
 */
const KIMI_CODE_USER_AGENT_PRODUCT = "kimi-code-cli";

/**
 * The `X-Msh-Platform` value reported to the OAuth host and managed endpoints.
 * Deliberately a SEPARATE constant from the UA product: the SDK 0.33.0
 * docblock documents this header with underscore examples (`kimi_code_cli`,
 * `kimi_code_desktop`) and requires every host to state its own, so reusing
 * the hyphenated UA product would couple two distinct wire-identity surfaces
 * and send an undocumented format. We present as the CLI product, with the
 * slock-daemon suffix already carried in userAgentSuffix.
 */
export const KIMI_CODE_PLATFORM = "kimi_code_cli";

/**
 * Version we report to Moonshot — the upstream Kimi Code release we mirror
 * the SDK from. Bumps in lockstep with the @botiverse/kimi-code-sdk dep
 * version we depend on. A contract test compares this value to the daemon's
 * exact dependency pin so a package-only bump cannot leave the wire identity
 * stale again.
 */
export const KIMI_CODE_HOST_VERSION = "2.3.1-botiverse.1";

function getDaemonVersion(): string {
  try {
    const pkg = requireFromHere("../../package.json") as { version?: string };
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * How this daemon identifies itself to Kimi's OAuth host and managed
 * endpoints: an agent's harness and the web sign-in (runtimeAuth/kimiSdkAuth.ts)
 * present the same identity, so the device a sign-in registers is the one
 * agents then run as.
 */
export function kimiCodeHostIdentity(): KimiHostIdentity {
  return {
    productName: KIMI_CODE_USER_AGENT_PRODUCT,
    version: KIMI_CODE_HOST_VERSION,
    platform: KIMI_CODE_PLATFORM,
    userAgentSuffix: `slock-daemon/${getDaemonVersion()}`,
  };
}

import {
  hydrateRuntimeConfig,
  runtimeConfigToLaunchFields,
  type AgentConfig,
  type RuntimeModelInfo,
  type RuntimeModelSourceOutcome,
  type AxSurfaceText,
} from "@botiverse/raft-shared";
import { buildCliTransportSystemPrompt, prepareCliTransport, SLOCK_AGENT_LAUNCH_DIR_ENV, SLOCK_CLI_TRANSPORT_DIR_ENV } from "./cliTransport";
import { kimiSdkHomeFromEnv } from "./kimiCodeHome";
import { prepareManagedMcpRuntimeProxy } from "../managedMcpRuntimeProxy";
import { RuntimeTurnOriginHolder, type RuntimeTurnOrigin } from "../runtimeTurnOrigin";
import {
  createKimiRequestDiagnosticSession,
  type KimiRequestDiagnosticRecord,
  type KimiRequestDiagnosticSession,
} from "./kimiRequestDiagnostics";
import type {
  ParsedEvent,
  RuntimeDriver,
  RuntimeExitInfo,
  RuntimeModelDetectionContext,
  RuntimeProbeResult,
  RuntimeSendResult,
  RuntimeSession,
  RuntimeSessionDescriptor,
  SpawnContext,
  SpawnResult,
} from "./types";

const KIMI_SESSION_DIR = ".kimi-sessions";

type RuntimeSessionEvents = {
  runtime_event: [ParsedEvent];
  stdout: [string];
  stderr: [string];
  error: [Error];
  exit: [RuntimeExitInfo];
  close: [RuntimeExitInfo];
};

type RuntimeSessionEventName = keyof RuntimeSessionEvents;

/** How long a turn-end compaction may run before it counts as failed (the wait ends; Kimi's compaction may still finish). */
const KIMI_TURN_END_COMPACTION_WAIT_MS = 10 * 60_000;

export type KimiSessionFactory = (ctx: SpawnContext, sessionId: string) => Promise<{
  harness: KimiHarness;
  session: KimiSession;
  /**
   * Absolute path to the per-agent `raft` CLI wrapper that prepareCliTransport
   * wrote for this session. Kept for diagnostics/observability; the LLM no
   * longer receives this path in the standing prompt. Instead, the harness's
   * tool base environment prepends the wrapper directory to PATH so the model
   * can use the bare `raft` command.
   */
  wrapperPath: string;
}>;

export interface KimiSdkEventMappingState {
  sessionId: string | null;
  sessionAnnounced: boolean;
  seenUsageSteps: Set<string>;
  usageIdentityOmissionObserved: boolean;
  /** Agent typing line: `raft message send` targets in streaming Bash arguments (created on first use). */
  sendIntentScanner?: SendIntentArgumentScanner;
  /** The daemon cancelled the running turn: its `cancelled` end is a stop, not a failure. */
  interruptRequested?: boolean;
  /**
   * #proj-runtime:#41 — subagents spawned in this session, by their agent id
   * (`subagent.spawned.subagentId`, the id their own events carry).
   */
  subagents?: Map<string, KimiSubagent>;
  /** Ends of subagents whose spawn has not arrived yet (bounded, oldest first). */
  unspawnedSubagentEnds?: Set<string>;
}

interface KimiSubagent {
  /** The call that started its current run; a spawn by a subagent is qualified by that subagent's agent id. */
  parentToolCallId: string;
  name?: string;
  /**
   * Its current run's task id when the main agent started it: the session
   * stops it by that id (`Session.stopBackgroundTask`, which looks only in the
   * main agent's tasks), foreground or background.
   */
  stopTaskId?: string;
  /** Its current run has started and not ended. A resume spawns it again with a new call. */
  running: boolean;
  /** Its text or reasoning not yet passed on, so interleaved deltas stay whole rows. */
  pendingText?: { kind: "thinking" | "text"; text: string };
}

/** At most this many ends of subagents not yet spawned are remembered (an end can beat its spawn). */
const KIMI_UNSPAWNED_ENDS_LIMIT = 64;

/** Its buffered text or reasoning, as one row, before anything else of its own is passed on. */
function flushKimiSubagentText(subagentId: string, subagent: KimiSubagent): ParsedEvent[] {
  const pending = subagent.pendingText;
  if (!pending || pending.text.length === 0) return [];
  subagent.pendingText = undefined;
  return [{ kind: pending.kind, text: pending.text, subagent: kimiSubagentLineage(subagentId, subagent) }];
}

function kimiSubagentLineage(subagentId: string, subagent: KimiSubagent): { parentToolUseId: string; taskId: string; subagentType?: string } {
  return { parentToolUseId: subagent.parentToolCallId, taskId: subagentId, ...(subagent.name ? { subagentType: subagent.name } : {}) };
}

function kimiSubagentEnded(state: KimiSdkEventMappingState, subagentId: string, taskStatus: "completed" | "failed" | "stopped"): ParsedEvent[] {
  const subagent = state.subagents?.get(subagentId);
  if (!subagent?.running) {
    // Its end beat its spawn (a cancel before a spawn or a resume was
    // announced): that spawn must not start it. The SDK sends one end per run.
    const ends = state.unspawnedSubagentEnds ??= new Set();
    ends.add(subagentId);
    const oldest = ends.values().next().value;
    if (ends.size > KIMI_UNSPAWNED_ENDS_LIMIT && oldest !== undefined) ends.delete(oldest);
    return [];
  }
  subagent.running = false;
  return [
    ...flushKimiSubagentText(subagentId, subagent),
    { kind: "subagent_progress", source: "kimi_subagent", phase: "notification", taskStatus, ...kimiSubagentLineage(subagentId, subagent) },
  ];
}

/**
 * #proj-runtime:#41 — a subagent's own event (its `agentId` is a subagent
 * this session spawned), or null for the main agent's and unknown agents'.
 * Kept: its text, reasoning and tool calls, with its lineage; its call ids
 * qualified by its agent id (ids are only unique per agent). Its usage is
 * counted as before. Its turn ends, errors and compaction stay out: they are
 * not the agent's.
 */
export function mapKimiSubagentEvent(event: KimiSdkEvent, state: KimiSdkEventMappingState): ParsedEvent[] | null {
  const agentId = (event as { agentId?: unknown }).agentId;
  if (typeof agentId !== "string" || agentId === KIMI_MAIN_AGENT_ID) return null;
  const subagent = state.subagents?.get(agentId);
  if (!subagent) return null;
  const subagentLineage = { subagent: kimiSubagentLineage(agentId, subagent) };
  switch (event.type) {
    case "thinking.delta":
    case "assistant.delta": {
      if (typeof event.delta !== "string" || event.delta.length === 0) return [];
      const kind = event.type === "thinking.delta" ? "thinking" : "text";
      // Buffered per subagent: the daemon's text buffer is per agent, so the
      // main agent's and other subagents' deltas would split each other's rows.
      const flushed = subagent.pendingText && subagent.pendingText.kind !== kind ? flushKimiSubagentText(agentId, subagent) : [];
      subagent.pendingText = { kind, text: (subagent.pendingText?.text ?? "") + event.delta };
      return flushed;
    }
    case "turn.step.completed":
    case "turn.ended":
      return flushKimiSubagentText(agentId, subagent);
    case "tool.call.started":
      return [...flushKimiSubagentText(agentId, subagent), {
        kind: "tool_call",
        name: event.name || "unknown_tool",
        input: event.args ?? {},
        ...(event.toolCallId ? { callId: `${agentId}:${event.toolCallId}` } : {}),
        ...subagentLineage,
      }];
    case "tool.result":
      return [{
        kind: "tool_output",
        name: "",
        ...(event.toolCallId ? { callId: `${agentId}:${event.toolCallId}` } : {}),
        ...kimiToolResultOutcome(event),
        ...subagentLineage,
      }];
    // Its own subagents' lifecycle (nested): recorded as any spawn's.
    case "subagent.spawned":
    case "subagent.completed":
    case "subagent.failed":
    case "subagent.cancelled":
      return mapKimiSdkEventToParsedEvents(event, state);
    default:
      return [];
  }
}

export function createKimiSdkEventMappingState(sessionId: string | null = null): KimiSdkEventMappingState {
  return {
    sessionId,
    sessionAnnounced: false,
    seenUsageSteps: new Set(),
    usageIdentityOmissionObserved: false,
  };
}

export function setKimiSdkEventMappingSession(
  state: KimiSdkEventMappingState,
  sessionId: string | null,
): void {
  if (state.sessionId === sessionId) return;
  state.sessionId = sessionId;
  state.sessionAnnounced = false;
  state.seenUsageSteps.clear();
  state.usageIdentityOmissionObserved = false;
  state.sendIntentScanner?.reset();
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function buildKimiStepUsageEvent(
  event: Extract<KimiSdkEvent, { type: "turn.step.completed" }>,
  state: KimiSdkEventMappingState,
): Extract<ParsedEvent, { kind: "telemetry" }> | null {
  if (!event.usage || typeof event.usage !== "object") return null;

  const usage = event.usage as unknown as Record<string, unknown>;
  const inputOther = finiteNumber(usage.inputOther);
  const output = finiteNumber(usage.output);
  const inputCacheRead = finiteNumber(usage.inputCacheRead);
  const inputCacheCreation = finiteNumber(usage.inputCacheCreation);
  const attrs: Record<string, number> = {};
  if (inputOther !== undefined) attrs.input_tokens = inputOther;
  if (output !== undefined) attrs.output_tokens = output;
  if (inputCacheRead !== undefined) attrs.cached_read_tokens = inputCacheRead;
  if (inputCacheCreation !== undefined) attrs.cache_write_tokens = inputCacheCreation;
  if (Object.keys(attrs).length === 0) return null;
  if (
    inputOther !== undefined
    && output !== undefined
    && inputCacheRead !== undefined
    && inputCacheCreation !== undefined
  ) {
    attrs.total_tokens = inputOther + output + inputCacheRead + inputCacheCreation;
  }

  // The live SDK path assigns one UUID to each loop step and preserves it on
  // the public completion event. The fallback covers schema-valid/replayed
  // events that omit stepId. Mark a step only after usable usage is observed,
  // so an earlier completion with absent usage cannot suppress a later report.
  const stepIdentity = typeof event.stepId === "string" && event.stepId.length > 0
    ? `step:${event.stepId}`
    : Number.isFinite(event.turnId) && Number.isFinite(event.step)
      ? `turn:${event.turnId}:step:${event.step}`
      : null;
  if (!stepIdentity) {
    if (state.usageIdentityOmissionObserved) return null;
    state.usageIdentityOmissionObserved = true;
    return {
      kind: "telemetry",
      name: "usage_omission",
      source: "kimi_turn_step_completed_usage",
      sessionId: state.sessionId || undefined,
      ...(Number.isFinite(event.turnId) ? { turnId: String(event.turnId) } : {}),
      attrs: {
        omission_reason: "missing_usage_identity",
        event_type: "turn.step.completed",
      },
    };
  }
  if (state.seenUsageSteps.has(stepIdentity)) return null;
  state.seenUsageSteps.add(stepIdentity);

  const sessionId = state.sessionId ?? event.sessionId;
  return {
    kind: "telemetry",
    name: "token_usage",
    source: "kimi_turn_step_completed_usage",
    usageKind: "per_generation",
    sessionId: sessionId || undefined,
    turnId: String(event.turnId),
    runtimeResultId: sessionId ? `${sessionId}:${stepIdentity}` : stepIdentity,
    attrs,
  };
}

export function buildKimiSessionDir(workingDirectory: string): string {
  return path.join(workingDirectory, KIMI_SESSION_DIR);
}

export async function buildKimiSpawnEnv(ctx: SpawnContext): Promise<NodeJS.ProcessEnv> {
  return (await prepareCliTransport(ctx, { NO_COLOR: "1" })).spawnEnv;
}

function kimiErrorMessage(error: unknown): string {
  if (typeof error === "string" && error.trim()) return error.trim();
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    if (typeof record.message === "string" && record.message.trim()) return record.message.trim();
    try {
      return JSON.stringify(error);
    } catch {
      // Fall through.
    }
  }
  return "Unknown Kimi error";
}

function kimiGoalIsActive(result: GoalToolResult | null | undefined): boolean {
  return result?.goal?.status === "active";
}

function pushSessionInitIfNeeded(state: KimiSdkEventMappingState, events: ParsedEvent[]): void {
  if (!state.sessionAnnounced && state.sessionId) {
    events.push({ kind: "session_init", sessionId: state.sessionId });
    state.sessionAnnounced = true;
  }
}

/**
 * Closed mapping from Kimi SDK Event union → ParsedEvent[].
 *
 * RS-004 closed-mapping discipline: every member of the SDK's `AgentEvent`
 * union is either mapped to at most one ParsedEvent.kind OR explicitly
 * dropped via `return events;`. Default branch is `_exhaustive: never` so the
 * TypeScript compiler fails closed if upstream adds a new event class
 * without our mapping table being extended.
 *
 * The single turn-triggering source class is `turn.ended` → daemon idle ONLY
 * derives from this. Other events MUST NOT produce `kind: "turn_end"`.
 */
export function mapKimiSdkEventToParsedEvents(
  event: KimiSdkEvent,
  state: KimiSdkEventMappingState,
): ParsedEvent[] {
  const events: ParsedEvent[] = [];
  pushSessionInitIfNeeded(state, events);

  switch (event.type) {
    // ── content streaming → ParsedEvent ──
    case "thinking.delta":
      if (typeof event.delta === "string" && event.delta.length > 0) {
        events.push({ kind: "thinking", text: event.delta });
      }
      return events;
    case "assistant.delta":
      if (typeof event.delta === "string" && event.delta.length > 0) {
        events.push({ kind: "text", text: event.delta });
      }
      return events;
    case "tool.call.started":
      events.push({
        kind: "tool_call",
        name: event.name || "unknown_tool",
        input: event.args ?? {},
        ...(event.toolCallId ? { callId: event.toolCallId } : {}),
      });
      return events;
    case "tool.result":
      events.push({
        kind: "tool_output",
        name: "",
        ...(event.toolCallId ? { callId: event.toolCallId } : {}),
        ...kimiToolResultOutcome(event),
      });
      return events;
    case "compaction.started":
      events.push({ kind: "compaction_started" });
      return events;
    case "compaction.completed":
      events.push({ kind: "compaction_finished" });
      return events;
    case "error":
      events.push({ kind: "error", message: kimiErrorMessage(event) });
      return events;

    // ── THE single turn-triggering source class ──
    case "turn.ended": {
      const interrupted = state.interruptRequested === true && event.reason === "cancelled";
      state.interruptRequested = false;
      events.push({ kind: "turn_end", sessionId: state.sessionId || undefined, ...(interrupted ? { interrupted: true as const } : {}) });
      return events;
    }

    case "turn.step.completed": {
      const usage = buildKimiStepUsageEvent(event, state);
      if (usage) events.push(usage);
      return events;
    }

    case "tool.call.delta": {
      // Agent typing line: Kimi streams the arguments JSON in `argumentsPart`
      // fragments keyed by the call id that `tool.call.started` later reuses.
      const sendIntent = (state.sendIntentScanner ??= new SendIntentArgumentScanner())
        .append(event.toolCallId, event.name, event.argumentsPart);
      if (sendIntent) events.push(sendIntent);
      return events;
    }

    // ── explicit drops (RS-004) ──
    // `warning` is non-fatal in the SDK's vocabulary; mapping it to
    // ParsedEvent.kind="error" would latch the agent into APM's error state
    // (lastRuntimeError set by `runtime.error`, then NOT cleared by the
    // following turn_end) — so a warning would brick the agent until
    // restart. Drop it here; the SDK's own log already records it.
    case "warning":
    // turn / step lifecycle (state-only, no parsed payload)
    case "turn.started":
    case "turn.step.started":
    case "turn.step.retrying":
    case "turn.step.interrupted":
    // tool-call progress / hooks (could elevate to internal_progress in future)
    case "tool.progress":
    case "shell.output":
    case "shell.started":
    case "shell.completed":
    case "hook.result":
    // status / meta updates
    case "agent.status.updated":
    case "session.meta.updated":
    case "event.session.created":
    case "event.workspace.created":
    case "event.workspace.updated":
    case "event.workspace.deleted":
    case "event.session.work_changed":
    case "event.session.status_changed":
    case "event.config.changed":
    case "event.model_catalog.changed":
    case "goal.updated":
    case "skill.activated":
    case "plugin_command.activated":
    // MCP infra
    case "tool.list.updated":
    case "mcp.server.status":
      return events;
    // #proj-runtime:#41: subagent lifecycle. A spawn names it (its agent id,
    // the call that started it, its profile) and starts it; its end says how.
    case "subagent.spawned": {
      if (!event.subagentId) return events;
      const subagents = state.subagents ??= new Map();
      const known = subagents.get(event.subagentId);
      // A spawn while its run is going is a repeat; one after it ended is a resume: a new run, under its new call.
      if (known?.running) return events;
      // The spawning agent's call ids are only unique per agent: a subagent's are qualified, as its tool rows are.
      const spawner = (event as { agentId?: unknown }).agentId;
      const parentToolCallId = typeof spawner === "string" && spawner !== KIMI_MAIN_AGENT_ID ? `${spawner}:${event.parentToolCallId}` : event.parentToolCallId;
      const endedAlready = state.unspawnedSubagentEnds?.delete(event.subagentId) === true;
      const subagent: KimiSubagent = {
        parentToolCallId,
        ...(event.subagentName ? { name: event.subagentName } : {}),
        ...(event.taskId && !(typeof spawner === "string" && spawner !== KIMI_MAIN_AGENT_ID) ? { stopTaskId: event.taskId } : {}),
        running: !endedAlready,
      };
      subagents.set(event.subagentId, subagent);
      if (subagent.running) events.push({ kind: "subagent_progress", source: "kimi_subagent", phase: "started", ...kimiSubagentLineage(event.subagentId, subagent) });
      return events;
    }
    case "subagent.completed":
      events.push(...kimiSubagentEnded(state, event.subagentId, "completed"));
      return events;
    case "subagent.failed":
      events.push(...kimiSubagentEnded(state, event.subagentId, "failed"));
      return events;
    case "subagent.cancelled":
      events.push(...kimiSubagentEnded(state, event.subagentId, "stopped"));
      return events;
    // Started (after its spawn) and suspended change nothing shown.
    case "subagent.started":
    case "subagent.suspended":
    // compaction sub-cases
    case "compaction.blocked":
    case "compaction.cancelled":
    // kimi-code 2.x engine notices: config load warnings, plugin and model
    // capability changes (state-only)
    case "event.config.warning":
    case "event.plugin.changed":
    case "event.capability.changed":
    // out-of-band
    case "task.started":
    case "task.terminated":
    case "background.task.started":
    case "background.task.terminated":
    case "cron.fired":
    case "prompt.submitted":
    case "prompt.completed":
    case "prompt.aborted":
    case "prompt.steered":
      return events;

    default: {
      // Compile-time exhaustiveness check. If this errors after a Kimi SDK
      // upgrade, the new event class needs a deliberate decision (map or drop)
      // — failing closed on unmapped event classes is RS-004.
      const _exhaustive: never = event;
      void _exhaustive;
      return events;
    }
  }
}

const KIMI_MAIN_AGENT_ID = "main";
/**
 * What of a subagent's events the daemon passes on. The engine delivers every
 * agent's events on the session, each with its own `agentId`: a subagent's
 * `turn.ended` must not end the main agent's turn, and its text, errors and
 * compaction are not the main agent's. Only its usage is counted here; a
 * subagent the session spawned has its text and tool calls shown with its
 * lineage (mapKimiSubagentEvent), which keeps them out of the agent's own turn.
 */
const KIMI_SUBAGENT_EVENTS_SHOWN: ReadonlySet<string> = new Set(["turn.step.completed"]);

export function kimiEventIsShownForMainAgent(event: KimiSdkEvent): boolean {
  const agentId = (event as { agentId?: unknown }).agentId;
  if (typeof agentId !== "string" || agentId === KIMI_MAIN_AGENT_ID) return true;
  return KIMI_SUBAGENT_EVENTS_SHOWN.has(event.type);
}

const KIMI_SDK_RUNTIME_SESSION_DESCRIPTOR = {
  transport: "sdk",
  lifecycle: "sdk_session",
  stdout: {
    channel: "diagnostic",
  },
  input: {
    initial: "start",
    idle: "sdk_prompt",
    busy: "sdk_steer",
  },
  readiness: "sdk_ready",
  turnBoundary: "sdk_event",
  startPolicy: "immediate",
  inFlightWake: "steer",
  busyDelivery: "direct",
  postTurn: "keep_alive",
} as const satisfies RuntimeSessionDescriptor;

/**
 * Composes the long-lived standing role addendum delivered to the Kimi SDK via
 * the sanctioned `roleAdditional` session option (renders into the base system
 * prompt's `{{ ROLE_ADDITIONAL }}` slot, sent on EVERY request). Unlike the old
 * first-turn injection, this lives outside compressible conversation history, so
 * it survives Kimi's context compaction and never has to be re-asserted.
 *
 * Returns the standing prompt verbatim (or "" when absent). The per-agent
 * `raft` wrapper is no longer surfaced here; instead, the harness's tool base
 * environment has PATH prepended with the current launch's wrapper directory,
 * so the model can use the bare `raft` command.
 *
 * The `wrapperPath` parameter is kept for signature compatibility but ignored.
 */
export function composeStandingRoleAdditional(
  standingPrompt: string | undefined,
  wrapperPath: string | null,
): string {
  void wrapperPath; // PATH is supplied via the harness's tool base env; no absolute-path note needed
  return standingPrompt ?? "";
}

/**
 * Injectable seams for {@link createKimiAgentSessionForContext} so tests can
 * exercise the real roleAdditional wiring without a live Kimi harness / on-disk
 * CLI wrapper. Production callers omit `deps` and get the real implementations.
 */
export interface KimiSessionFactoryDeps {
  createHarness?: typeof createKimiHarness;
  prepareTransport?: typeof prepareCliTransport;
}

/**
 * The environment every tool process the Kimi engine spawns starts from: the
 * spawn env the transport computed for this agent (the daemon's ambient env,
 * the agent's own variables, identity and runtime context, keys it removed
 * left out) plus the wrapper PATH and launch selectors. It replaces the
 * daemon's process.env as the base, so what Kimi's tools see is what a
 * child-process runtime gets, and nothing the daemon itself carries leaks in.
 */
export function kimiToolBaseEnv(input: {
  spawnEnv: NodeJS.ProcessEnv;
  slockDir: string;
  slockHome: string;
}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.spawnEnv)) {
    if (typeof value === "string") env[key] = value;
  }
  return {
    ...env,
    // Same PATH as the spawned-runtime env (wrapper dir + agent-configured or
    // daemon PATH).
    PATH: input.spawnEnv.PATH ?? `${input.slockDir}${path.delimiter}${ambientProcessEnv().PATH ?? ""}`,
    NO_COLOR: "1",
    SLOCK_HOME: input.slockHome,
    [SLOCK_AGENT_LAUNCH_DIR_ENV]: path.basename(input.slockDir),
    [SLOCK_CLI_TRANSPORT_DIR_ENV]: input.slockDir,
  };
}

export async function createKimiAgentSessionForContext(
  ctx: SpawnContext,
  sessionId: string,
  deps: KimiSessionFactoryDeps = {},
): Promise<{ harness: KimiHarness; session: KimiSession; wrapperPath: string }> {
  const sdk = deps.createHarness ? null : await loadKimiSdk();
  const createHarnessImpl = deps.createHarness ?? sdk!.createKimiHarness;
  const prepareTransportImpl = deps.prepareTransport ?? prepareCliTransport;
  const sessionDir = buildKimiSessionDir(ctx.workingDirectory);
  mkdirSync(sessionDir, { recursive: true });

  // prepareCliTransport writes the per-agent `raft` wrapper into daemon-owned
  // transport storage outside the model workspace. For the in-process Kimi SDK
  // runtime the wrapper directory reaches the engine's tool processes through
  // the harness's base env (PATH prepend + launch selector) instead of an
  // absolute wrapper path in the standing prompt.
  const cliTransport = await prepareTransportImpl(ctx, { NO_COLOR: "1" });
  const spawnEnv = cliTransport.spawnEnv;
  const wrapperPath = cliTransport.wrapperPath;
  const baseEnv = kimiToolBaseEnv({ spawnEnv, slockDir: cliTransport.slockDir, slockHome: cliTransport.slockHome });

  // Kimi Code keeps config, OAuth credentials, and sessions under
  // KIMI_CODE_HOME (default: ~/.kimi-code). Use the same resolver as model
  // detection so the two cannot silently read different homes. Pass the
  // prepared per-agent override into it; per-agent env is not installed into
  // the daemon process-wide environment.
  const homeDir = resolveKimiHome(spawnEnv);
  mkdirSync(homeDir, { recursive: true });

  // The standing prompt rides the harness's `roleAdditional` (botiverse
  // mirror): rendered into the main agent's `${role_additional}` slot of the
  // base system prompt, sent on EVERY request, so it survives context
  // compaction. A resumed session is re-rendered with the current value.
  const roleAdditional = composeStandingRoleAdditional(ctx.standingPrompt, wrapperPath);

  // The harness resolves auth from <homeDir>/credentials/kimi-code.json by
  // default (KimiAuthFacade with the homeDir we just passed). We do NOT call
  // applyCatalogProvider here — that's a config-patch helper, not session-time
  // setup. Provider/catalog choice flows through the SDK's own auth/config
  // pipeline based on what's already in <homeDir>.
  const harness = createHarnessImpl({
    homeDir,
    identity: kimiCodeHostIdentity(),
    ...(roleAdditional ? { roleAdditional } : {}),
    baseEnv,
  });

  const launchRuntimeFields = runtimeConfigToLaunchFields(hydrateRuntimeConfig(ctx.config));
  // Try to resume an existing kimi session if we have a persisted id; fall
  // back to fresh creation. Resume gives us memory continuity across daemon
  // restarts; createSession with a pre-existing id throws ("Session ... already
  // exists"), so we MUST go through resume on the second launch.
  const managedMcp = await prepareManagedMcpRuntimeProxy({
    agentId: ctx.agentId,
    launchId: ctx.launchId,
    processInstanceId: ctx.processInstanceId,
    readTurnOrigin: ctx.readTurnOrigin,
    serverUrl: ctx.config.serverUrl,
    agentCredentialKey: ctx.config.agentCredentialKey,
  });
  const selectedModel = launchRuntimeFields.model && launchRuntimeFields.model !== "default"
    ? launchRuntimeFields.model
    : null;
  const sessionFields = { workDir: ctx.workingDirectory };
  // task #365: right before the SDK session is resumed or created. What ran
  // before it is local preparation only (CLI transport files, the harness
  // object, the managed MCP proxy): no provider request and no tool
  // execution. A stale launch throws here; the launch's proxies are released
  // by the process manager's failed-start cleanup.
  ctx.assertLaunchCurrent?.();
  let session: KimiSession;
  try {
    let resumed = false;
    if (ctx.config.sessionId) {
      try {
        session = await harness.resumeSession({ ...sessionFields, id: ctx.config.sessionId });
        resumed = true;
      } catch (resumeError) {
        // Only a missing or corrupted session file falls through to a fresh
        // session (losing memory continuity beats bricking the agent). Every
        // other failure (login, config, I/O, anything unknown) is not fixed by a
        // fresh session and is surfaced instead of hidden (task #1221).
        if (!isKimiError(resumeError) || !KIMI_RECOVERABLE_RESUME_CODES.has(resumeError.code)) {
          throw typedKimiStartError(resumeError, selectedModel);
        }
        // task #365: the failed resume was an await; check again before the
        // fresh session is created.
        ctx.assertLaunchCurrent?.();
        session = await harness.createSession({
          ...sessionFields,
          ...(selectedModel ? { model: selectedModel } : {}),
          ...(launchRuntimeFields.reasoningEffort ? { thinking: launchRuntimeFields.reasoningEffort } : {}),
        });
      }
    } else {
      session = await harness.createSession({
        ...sessionFields,
        ...(selectedModel ? { model: selectedModel } : {}),
        ...(launchRuntimeFields.reasoningEffort ? { thinking: launchRuntimeFields.reasoningEffort } : {}),
      });
    }
    // The engine takes no MCP servers on create or resume; the managed server
    // is attached to the live session, every launch (not persisted). The
    // engine only gives an agent the tools of servers known when its session
    // was opened (agent-core-v2 freezes that set), so the session is reloaded
    // once to open it again with the managed server in it. This runs before
    // the Runtime Profile below is applied, so the reload cannot undo it.
    // Remove the reload once the SDK forwards `mcpServers` through the
    // harness's createSession/resumeSession (botiverse/kimi-code-sdk fork).
    if (managedMcp) await attachManagedMcpServer(ctx, session, managedMcp);
    if (resumed) {
      // Resume restores the persisted model/thinking profile. Re-apply the
      // current Runtime Profile before the first resumed turn: `model` and
      // `thinking` are not resume options, while the Session methods are the
      // SDK's supported live reconfiguration surface. A failure here is not a
      // missing session and must remain visible rather than falling back to a
      // fresh create.
      if (selectedModel) await session.setModel(selectedModel);
      if (launchRuntimeFields.reasoningEffort) await session.setThinking(launchRuntimeFields.reasoningEffort);
    } else if (selectedModel) {
      // createSession only records the model alias; the SDK resolves it against
      // the local config on the first request. Resolve it now so a model that is
      // not configured on this computer fails the start (typed, stops automatic
      // relaunches) instead of failing every first turn (task #1221).
      await session.setModel(selectedModel);
    }
  } catch (error) {
    // Nothing else holds this harness: close it, or a failed start keeps its
    // session, session lock and MCP connection open.
    await Promise.resolve().then(() => harness.close()).catch(() => undefined);
    throw typedKimiStartError(error, selectedModel);
  }
  return { harness, session, wrapperPath };
}

/**
 * Attach the launch's managed MCP server (Raft apps) to the live session and
 * reload the session so its tools reach the agent. Neither step is allowed to
 * fail the start: without them the agent only lacks the apps' tools, and the
 * session itself is fine (0.34 passed the server as a session option, so an
 * unreachable server never stopped the session from opening either). A
 * failure is recorded and the start goes on.
 */
async function attachManagedMcpServer(
  ctx: SpawnContext,
  session: KimiSession,
  managedMcp: { name: string; url: string },
): Promise<void> {
  let step: "add" | "reload" = "add";
  try {
    await session.addMcpServer({ name: managedMcp.name, transport: "http", url: managedMcp.url });
    step = "reload";
    await session.reloadSession();
  } catch (error) {
    const failureCode = isKimiError(error) ? error.code : error instanceof Error ? error.name : "unknown";
    console.warn(`[kimi-sdk] managed MCP ${managedMcp.name} unavailable for this session (${step} failed: ${failureCode}); starting without it`);
    ctx.tracer?.emitEvent("daemon.runtime.managed_mcp.attach_failed", {
      surface: "daemon",
      attrs: {
        runtime: "kimi-sdk",
        agent_id: ctx.agentId,
        launch_id: ctx.launchId ?? undefined,
        mcp_server_name: managedMcp.name,
        step_kind: step,
        failure_code: failureCode,
      },
    });
  }
}

/**
 * Resume failures a fresh session recovers from: the SDK's session-file codes
 * (@botiverse/kimi-code-sdk KIMI_ERROR_INFO): `session.not_found` (no such
 * session), `session.state_not_found` ("session directory is corrupted or
 * missing state.json"), `session.state_invalid` ("state.json is corrupted;
 * remove the session or repair the file"). The agent continues on a new
 * session; the old session files are left untouched (not deleted or repaired).
 */
const KIMI_RECOVERABLE_RESUME_CODES: ReadonlySet<string> = new Set([
  "session.not_found",
  "session.state_not_found",
  "session.state_invalid",
]);

/**
 * Map a Kimi SDK error to the daemon's typed start failure, so the reason
 * reaches the server (and the user) instead of the generic
 * runtime_spawn_failed. The SDK marks these codes non-retryable.
 */
export function typedKimiStartError(error: unknown, selectedModel: string | null): unknown {
  if (!isKimiError(error)) return error;
  const detailModel = typeof error.details?.model === "string" ? error.details.model : null;
  if ((error.code === "config.invalid" && detailModel) || error.code === "model.not_configured" || error.code === "model.config_invalid") {
    return Object.assign(new RuntimeModelNotConfiguredError({ runtimeId: "kimi-sdk", model: detailModel ?? selectedModel ?? "default" }), { cause: error });
  }
  if (error.code === "auth.login_required") {
    return Object.assign(new RuntimeLoginRequiredError({ runtimeId: "kimi-sdk", message: error.message }), { cause: error });
  }
  if (error.code === "config.invalid") {
    return Object.assign(new RuntimeConfigInvalidError({ runtimeId: "kimi-sdk", message: error.message }), { cause: error });
  }
  return error;
}

export class KimiSdkRuntimeSession implements RuntimeSession {
  readonly descriptor = KIMI_SDK_RUNTIME_SESSION_DESCRIPTOR;
  private readonly events = new EventEmitter();
  private readonly mappingState: KimiSdkEventMappingState;
  private harness: KimiHarness | null = null;
  private session: KimiSession | null = null;
  private wrapperPath: string | null = null;
  private unsubscribe: (() => void) | null = null;
  private started = false;
  private didClose = false;
  private requestedStopReason: string | undefined;
  private exitInfo: RuntimeExitInfo | null = null;
  private sdkTurnActive = false;
  /** #proj-runtime:#54 phase 3: the turn-end compaction this driver asked for, settled by its compaction event. */
  private turnEndCompactionWaiter: ((outcome: TurnEndCompactionDriverOutcome) => void) | null = null;
  /** Each prompt's number; interruptTurn marks the one it cancelled, whose late rejection is not an error. */
  private promptSeq = 0;
  private cancelledPromptSeq: number | null = null;
  private goalRunActive = false;
  private pendingTurnEndSessionId: string | undefined;
  private requestDiagnostics: KimiRequestDiagnosticSession | null = null;
  private readonly turnOrigin: RuntimeTurnOriginHolder;

  constructor(
    private readonly ctx: SpawnContext,
    private readonly setCurrentSessionId: (sessionId: string | null) => void,
    private readonly sessionFactory: KimiSessionFactory = createKimiAgentSessionForContext,
  ) {
    this.mappingState = createKimiSdkEventMappingState(ctx.config.sessionId || null);
    this.turnOrigin = new RuntimeTurnOriginHolder(ctx.processInstanceId);
    // Registered in the constructor so these run BEFORE any manager listener: on turn_end the
    // manager may immediately send the next idle prompt, which must see the previous turn closed.
    this.events.on("runtime_event", (event: ParsedEvent) => {
      if (event.kind === "turn_end") this.turnOrigin.endTurn();
    });
    this.events.on("exit", () => this.turnOrigin.close());
  }

  get pid(): undefined {
    return undefined;
  }

  get currentSessionId(): string | null {
    return this.mappingState.sessionId;
  }

  get exitCode(): number | null {
    return this.exitInfo?.code ?? null;
  }

  get signalCode(): NodeJS.Signals | null {
    return this.exitInfo?.signal ?? null;
  }

  get closed(): boolean {
    return this.didClose;
  }

  // In-process SDK session: there is no OS pid to probe with signal-0, so
  // liveness is unknowable via the pid-probe boundary. Return undefined, which
  // callers treat the same as the historic "no pid" probe result (RS-011).
  isAlive(): boolean | undefined {
    return undefined;
  }

  on<T extends RuntimeSessionEventName>(
    event: T,
    cb: (...args: RuntimeSessionEvents[T]) => void,
  ): void {
    this.events.on(event, cb as (...args: unknown[]) => void);
  }

  async start(input: { text: string; sessionId?: string | null; origin?: RuntimeTurnOrigin | null }): Promise<RuntimeSendResult> {
    if (this.started) {
      return { ok: false, reason: "runtime_error", error: "runtime session already started" };
    }
    if (this.didClose) return { ok: false, reason: "closed" };
    this.started = true;
    const sessionId = input.sessionId || this.ctx.config.sessionId || randomUUID();
    setKimiSdkEventMappingSession(this.mappingState, sessionId);
    this.setCurrentSessionId(sessionId);

    // task #365: before the native runtime session is created.
    this.ctx.assertLaunchCurrent?.();
    const { harness, session, wrapperPath } = await this.sessionFactory(
      {
        ...this.ctx,
        readTurnOrigin: this.turnOrigin.read,
        config: {
          ...this.ctx.config,
          sessionId,
        },
      },
      sessionId,
    );
    this.harness = harness;
    this.session = session;
    this.wrapperPath = wrapperPath;
    setKimiSdkEventMappingSession(this.mappingState, session.id);
    this.setCurrentSessionId(session.id);
    this.requestDiagnostics = createKimiRequestDiagnosticSession({
      env: ambientProcessEnv(),
      agentId: this.ctx.agentId,
      sessionId: session.id,
      emit: (record) => this.emitRequestDiagnostic(record),
    });
    await this.seedGoalState(session);
    // Auto-approve tool-call permission requests (Kimi SDK gates bash and a
    // few other tools through `setApprovalHandler`; without a handler all
    // calls return decision='cancelled' / feedback='No approval handler
    // registered', which blocks the agent from doing any real work).
    //
    // Slock's existing agent-isolation model (per-agent workingDirectory +
    // per-agent CLI proxy token) is the actual trust boundary, so always-
    // approving here is consistent with how Claude / Pi run (their child
    // processes don't have an in-band approval prompt either). If a future
    // policy wants to surface tool-call previews to humans, it lives at the
    // slock activity / UI layer, not at this approval-handler shim.
    session.setApprovalHandler(() => ({ decision: "approved", scope: "session" }));
    this.unsubscribe = session.onEvent((event) => this.handleSdkEvent(event));

    this.emitSessionInit();
    // The standing system prompt + wrapper CLI note are NOT injected into the
    // turn text anymore. They are delivered natively via the SDK's
    // `roleAdditional` session option (see composeStandingRoleAdditional +
    // createKimiAgentSessionForContext), which renders them into the base
    // system prompt on every request — so they survive Kimi's context
    // compaction instead of being condensed out of the first turn's history.
    // The first turn therefore carries only the user's text.
    const firstTurnText = this.composeFirstTurnPreamble(input.text);
    if (this.goalRunActive) {
      this.deferSdkCall({
        requestMethod: "turn/steer",
        text: firstTurnText,
        delivery: false,
        invoke: () => session.steer(firstTurnText),
      });
      return { ok: true, acceptedAs: "steer" };
    }
    this.turnOrigin.beginTurn(input.origin);
    this.launchPrompt(firstTurnText, "initial");
    return { ok: true, acceptedAs: "prompt" };
  }

  private composeFirstTurnPreamble(turnText: string): string {
    // Standing prompt + wrapper note now ride the native `roleAdditional`
    // session option, so the first turn is just the user's text. Kept as a seam
    // in case per-turn preamble is needed later.
    return turnText;
  }

  send(input: {
    mode: "idle" | "busy";
    text: string;
    sessionId?: string | null;
    origin?: RuntimeTurnOrigin | null;
  }): RuntimeSendResult {
    if (this.didClose) return { ok: false, reason: "closed" };
    const session = this.session;
    if (!session) return { ok: false, reason: "closed" };

    if (input.mode === "busy") {
      this.deferSdkCall({
        requestMethod: "turn/steer",
        text: input.text,
        delivery: true,
        invoke: () => session.steer(input.text),
      });
      return { ok: true, acceptedAs: "steer" };
    }

    if (this.sdkTurnActive || this.goalRunActive) {
      this.deferSdkCall({
        requestMethod: "turn/steer",
        text: input.text,
        delivery: true,
        invoke: () => session.steer(input.text),
      });
      return { ok: true, acceptedAs: "steer" };
    }

    this.turnOrigin.beginTurn(input.origin);
    this.launchPrompt(input.text, "delivery");
    return { ok: true, acceptedAs: "prompt" };
  }

  /**
   * Kimi's own cancel: the turn ends with `turn.ended` reason `cancelled` and
   * the session stays open. A goal run keeps its turn end pending, so it
   * takes the daemon's restart path instead, as does a turn that does not end
   * within the daemon's interrupt timeout.
   */
  /** #proj-runtime:#54 phase 3: the session's own context count and its model's window. */
  async turnEndContextFacts(): Promise<TurnEndContextFacts> {
    const session = this.session;
    if (this.didClose || !session) return { contextTokens: null, windowTokens: null };
    try {
      const status = await session.getStatus();
      return {
        contextTokens: status.contextTokens > 0 ? status.contextTokens : null,
        windowTokens: status.maxContextTokens > 0 ? status.maxContextTokens : null,
      };
    } catch {
      return { contextTokens: null, windowTokens: null };
    }
  }

  /**
   * #proj-runtime:#54 phase 3: Kimi's manual compaction on an idle session,
   * settled by its compaction.completed / blocked / cancelled event. The SDK
   * throws with a turn active or nothing to compact: a refusal.
   */
  async compactAtTurnEnd(): Promise<TurnEndCompactionDriverOutcome> {
    const session = this.session;
    if (this.didClose || !session) return { kind: "refused", reason: "no_session" };
    if (this.sdkTurnActive || this.goalRunActive) return { kind: "refused", reason: "busy" };
    if (this.turnEndCompactionWaiter) return { kind: "refused", reason: "compacting" };
    const settled = new Promise<TurnEndCompactionDriverOutcome>((resolve) => { this.turnEndCompactionWaiter = resolve; });
    try {
      await session.compact();
    } catch (error) {
      this.turnEndCompactionWaiter = null;
      return { kind: "refused", reason: /turn/i.test(kimiErrorMessage(error)) ? "busy" : "nothing_to_compact" };
    }
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<TurnEndCompactionDriverOutcome>((resolve) => {
      timer = setTimeout(() => resolve({ kind: "failed", reason: "timeout" }), KIMI_TURN_END_COMPACTION_WAIT_MS);
      timer.unref?.();
    });
    try {
      const outcome = await Promise.race([settled, timeout]);
      if (outcome.kind === "failed" && outcome.reason === "timeout") await this.cancelTurnEndCompaction();
      return outcome;
    } finally {
      if (timer) clearTimeout(timer);
      this.turnEndCompactionWaiter = null;
    }
  }

  /** Abort a compaction left running (its own wait or the manager's cap passed), so the next prompt isn't racing it. */
  async cancelTurnEndCompaction(): Promise<void> {
    const session = this.session;
    if (this.didClose || !session) return;
    try {
      await session.cancelCompaction();
    } catch (error) {
      this.events.emit("stderr", kimiErrorMessage(error));
    }
  }

  interruptTurn(): "sent" | "unsupported" {
    const session = this.session;
    if (this.didClose || !session || !this.sdkTurnActive || this.goalRunActive) return "unsupported";
    this.mappingState.interruptRequested = true;
    this.cancelledPromptSeq = this.promptSeq;
    void session.cancel().catch((error) => {
      this.events.emit("stderr", kimiErrorMessage(error));
    });
    return "sent";
  }

  /**
   * #proj-runtime:#41: stop one subagent through its task
   * (`Session.stopBackgroundTask` aborts the run: `subagent.cancelled`). It
   * covers foreground runs too (registered as tasks; the agent's Agent call
   * returns a stopped result and its turn carries on). The session looks only
   * in the main agent's tasks, so a subagent another subagent started cannot
   * be stopped from here.
   */
  interruptSubagent(subagentTaskId: string): "sent" | "not_running" | "unsupported" {
    const session = this.session;
    const subagent = this.mappingState.subagents?.get(subagentTaskId);
    if (this.didClose || !session || !subagent?.running) return "not_running";
    if (!subagent.stopTaskId) return "unsupported";
    void session.stopBackgroundTask(subagent.stopTaskId, { reason: "Stopped from Raft" }).catch((error: unknown) => {
      this.events.emit("stderr", kimiErrorMessage(error));
    });
    return "sent";
  }

  async stop(opts?: {
    signal?: NodeJS.Signals;
    forceAfterMs?: number;
    reason?: string;
  }): Promise<void> {
    if (this.didClose) return;
    this.turnOrigin.close();
    this.requestedStopReason = opts?.reason;
    const signal = opts?.signal ?? "SIGTERM";
    const session = this.session;
    if (session) {
      try {
        await session.cancel();
      } catch (error) {
        this.events.emit("stderr", kimiErrorMessage(error));
      }
    }
    await this.disposeSession();
    this.emitExitAndClose(null, signal);
  }

  async dispose(): Promise<void> {
    if (this.didClose) return;
    await this.disposeSession();
    this.emitExitAndClose(0, null);
  }

  private emitSessionInit(): void {
    const sessionId = this.mappingState.sessionId;
    if (!sessionId || this.mappingState.sessionAnnounced) return;
    this.mappingState.sessionAnnounced = true;
    this.events.emit("runtime_event", { kind: "session_init", sessionId } satisfies ParsedEvent);
  }

  private handleSdkEvent(event: KimiSdkEvent): void {
    this.requestDiagnostics?.observeSdkEvent(event);
    const subagentEvents = mapKimiSubagentEvent(event, this.mappingState);
    if (subagentEvents) {
      for (const parsed of subagentEvents) this.events.emit("runtime_event", parsed);
      // Its usage is still counted, as before.
      if (event.type !== "turn.step.completed") return;
    }
    if (!kimiEventIsShownForMainAgent(event)) return;
    if (this.turnEndCompactionWaiter && (event.type === "compaction.completed" || event.type === "compaction.blocked" || event.type === "compaction.cancelled")) {
      const settle = this.turnEndCompactionWaiter;
      this.turnEndCompactionWaiter = null;
      settle(event.type === "compaction.completed" ? { kind: "completed" } : { kind: "failed", reason: event.type === "compaction.blocked" ? "blocked" : "cancelled" });
    }
    if (event.type === "goal.updated") {
      this.updateGoalState({ goal: event.snapshot });
      return;
    }

    if (event.type === "turn.started") {
      this.sdkTurnActive = true;
    }

    if (event.type === "turn.ended" && this.goalRunActive) {
      this.sdkTurnActive = false;
      this.pendingTurnEndSessionId = this.mappingState.sessionId || undefined;
      return;
    }
    if (event.type === "turn.ended") {
      this.sdkTurnActive = false;
      if (this.pendingTurnEndSessionId) {
        const sessionId = this.pendingTurnEndSessionId;
        this.pendingTurnEndSessionId = undefined;
        this.emitSessionInit();
        this.events.emit("runtime_event", { kind: "turn_end", sessionId } satisfies ParsedEvent);
        return;
      }
    }
    for (const parsed of mapKimiSdkEventToParsedEvents(event, this.mappingState)) {
      this.events.emit("runtime_event", parsed);
    }
  }

  private flushPendingTurnEnd(): void {
    if (this.didClose || this.sdkTurnActive || this.goalRunActive || !this.pendingTurnEndSessionId) return;
    this.sdkTurnActive = false;
    const sessionId = this.pendingTurnEndSessionId;
    this.pendingTurnEndSessionId = undefined;
    this.emitSessionInit();
    this.events.emit("runtime_event", { kind: "turn_end", sessionId } satisfies ParsedEvent);
  }

  private async seedGoalState(session: KimiSession): Promise<void> {
    const getGoal = (session as { getGoal?: KimiSession["getGoal"] }).getGoal;
    if (!getGoal) return;
    try {
      this.updateGoalState(await getGoal.call(session));
    } catch (error) {
      this.events.emit("stderr", kimiErrorMessage(error));
    }
  }

  private markGoalActive(): void {
    this.goalRunActive = true;
  }

  private updateGoalState(result: GoalToolResult): void {
    if (kimiGoalIsActive(result)) {
      this.markGoalActive();
      return;
    }
    this.goalRunActive = false;
    this.flushPendingTurnEnd();
  }

  private launchPrompt(text: string, delivery: "initial" | "delivery"): void {
    const session = this.session;
    if (!session) {
      this.events.emit("runtime_event", {
        kind: "error",
        message: "Kimi SDK session is not started",
      } satisfies ParsedEvent);
      return;
    }
    this.sdkTurnActive = true;
    const seq = ++this.promptSeq;
    this.deferSdkCall({
      requestMethod: "turn/start",
      text,
      delivery: delivery === "delivery",
      invoke: () => session.prompt(text),
      // The prompt the daemon cancelled may reject; that is the stop, not a delivery failure.
      isCancelled: () => this.cancelledPromptSeq === seq,
      onSettled: (fulfilled) => {
        // A cancelled prompt settling late must not end the turn that followed it.
        if (!fulfilled && seq === this.promptSeq) {
          this.sdkTurnActive = false;
          this.pendingTurnEndSessionId = undefined;
        }
      },
    });
  }

  private emitSdkCallError(input: {
    error: unknown;
    requestMethod: "turn/start" | "turn/steer";
    text: string;
    delivery: boolean;
  }): void {
    const message = kimiErrorMessage(input.error);
    if (input.delivery) {
      this.events.emit("runtime_event", {
        kind: "delivery_error",
        message,
        requestMethod: input.requestMethod,
        source: "kimi_sdk_response",
        code: "runtime.delivery_error",
        payloadBytes: Buffer.byteLength(input.text, "utf8"),
      } satisfies ParsedEvent);
      return;
    }
    this.events.emit("runtime_event", {
      kind: "error",
      message,
    } satisfies ParsedEvent);
  }

  private deferSdkCall(input: {
    requestMethod: "turn/start" | "turn/steer";
    text: string;
    delivery: boolean;
    invoke: () => Promise<unknown>;
    isCancelled?: () => boolean;
    onSettled?: (fulfilled: boolean) => void;
  }): void {
    setImmediate(() => {
      if (this.didClose) {
        input.onSettled?.(false);
        return;
      }
      try {
        const invocation = this.requestDiagnostics?.run(input.invoke) ?? input.invoke();
        void invocation
          .then(
            () => {
              input.onSettled?.(true);
            },
            (error) => {
              if (!this.didClose && !input.isCancelled?.()) {
                this.emitSdkCallError({
                  error,
                  requestMethod: input.requestMethod,
                  text: input.text,
                  delivery: input.delivery,
                });
              }
              input.onSettled?.(false);
            },
          );
      } catch (error) {
        if (!this.didClose) {
          this.emitSdkCallError({
            error,
            requestMethod: input.requestMethod,
            text: input.text,
            delivery: input.delivery,
          });
        }
        input.onSettled?.(false);
      }
    });
  }

  private async disposeSession(): Promise<void> {
    this.requestDiagnostics?.close();
    this.requestDiagnostics = null;
    const unsubscribe = this.unsubscribe;
    this.unsubscribe = null;
    try {
      unsubscribe?.();
    } catch {
      // Ignore listener cleanup failures.
    }
    const session = this.session;
    this.session = null;
    try {
      await session?.close();
    } catch (error) {
      this.events.emit("stderr", kimiErrorMessage(error));
    }
    const harness = this.harness;
    this.harness = null;
    try {
      await harness?.close();
    } catch (error) {
      this.events.emit("stderr", kimiErrorMessage(error));
    }
  }

  private emitRequestDiagnostic(record: KimiRequestDiagnosticRecord): void {
    this.events.emit("runtime_event", {
      kind: "telemetry",
      name: "request_diagnostic",
      source: "kimi_request_diagnostic",
      sessionId: this.mappingState.sessionId || undefined,
      turnId: record.turnId,
      attrs: {
        diagnostic_kind: "kimi_request",
        correlation_id: record.correlationId,
        step: record.step,
        outer_attempt: record.outerAttempt,
        inner_attempt: record.innerAttempt,
        outcome: record.outcome,
        duration_ms: record.durationMs,
        ...(record.startedAtMs === undefined ? {} : { started_at_ms: record.startedAtMs }),
        ...(record.finishedAtMs === undefined ? {} : { finished_at_ms: record.finishedAtMs }),
        ...(record.statusCode === undefined ? {} : { status_code: record.statusCode }),
        ...(record.failedAttempt === undefined ? {} : { failed_attempt: record.failedAttempt }),
        ...(record.nextAttempt === undefined ? {} : { next_attempt: record.nextAttempt }),
        ...(record.maxAttempts === undefined ? {} : { max_attempts: record.maxAttempts }),
        ...(record.retryDelayMs === undefined ? {} : { retry_delay_ms: record.retryDelayMs }),
        ...(record.errorClass === undefined ? {} : { error_class: record.errorClass }),
      },
    } satisfies ParsedEvent);
  }

  private emitExitAndClose(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.didClose) return;
    this.didClose = true;
    const info: RuntimeExitInfo = {
      code,
      signal,
      reason: this.requestedStopReason ? "requested" : "runtime_exit",
    };
    this.exitInfo = info;
    this.events.emit("exit", info);
    this.events.emit("close", info);
  }
}

/**
 * Read the kimi-code SDK's user config and surface whatever models the user
 * has provisioned (most commonly via `kimi login` / `kimi-code login`, which
 * fetches the catalog from Moonshot's `/models` endpoint and writes each
 * entry as `[models."<id>"]` plus a top-level `default_model`). The kimi-code
 * TUI reads exactly the same `config.models` map for its picker
 * (`apps/kimi-code/src/tui/commands/reload.ts`), so daemons surface the same
 * set the user sees in the upstream CLI — including newly-added rollouts
 * (e.g. K2.7) without a daemon-side hardcode bump.
 *
 * Implementation note: we do a narrow regex scan rather than instantiating a
 * `KimiHarness` (the SDK's canonical async API). The harness path is
 * heavier (instantiates `KimiCore`, sets up RPC, allocates logs) for what is
 * a one-shot read; the TOML shape under `[models.<id>]` is stable across
 * upstream versions and all we need is `id` + optional `display_name`. Same
 * shape as `detectKimiModels(home)` in `kimi.ts`. `resolveKimiHome()` matches
 * the SDK's helper (pinned by a test) so we honor `KIMI_CODE_HOME` env
 * overrides (default fallback `~/.kimi-code`; see
 * `packages/agent-core/src/config/path.ts` upstream) without loading the SDK.
 *
 * Tracing: when a `RuntimeModelDetectionContext` is passed through, we
 * record exactly one terminal event `daemon.kimi_sdk.models.config` on the
 * parent `daemon.runtime_models.detect` span so production observers can
 * disambiguate the four reasons K2.7 (or any newly-rolled model) might fail
 * to surface — `outcome` ∈ {`models_returned`, `missing_config`, `no_models`,
 * `read_error`}. Attribute payload is intentionally low-cardinality (counts
 * + booleans + an errno code); model ids, display_names, default value, and
 * raw config bytes are deliberately omitted to keep user-provisioned model
 * rollouts out of trace exports.
 */
type KimiSdkDetectOutcome =
  | "models_returned"
  | "missing_config"
  | "no_models"
  | "read_error";

export function detectKimiSdkModels(
  home: string = resolveKimiHome(),
  ctx: RuntimeModelDetectionContext = {},
): RuntimeModelSourceOutcome {
  const span = ctx.span;
  const configPath = path.join(home, "config.toml");
  const homeFromEnv = Boolean(process.env.KIMI_CODE_HOME);

  const emit = (
    outcome: KimiSdkDetectOutcome,
    extra: Record<string, unknown> = {},
  ): void => {
    span?.addEvent("daemon.kimi_sdk.models.config", {
      outcome,
      kimi_code_home_env_set: homeFromEnv,
      ...extra,
    });
  };

  let raw: string;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code ?? "unknown";
    // ENOENT = user hasn't run `kimi login` yet (expected first-launch
    // shape, distinguishable from real errors). Anything else (EACCES,
    // EISDIR, etc.) gets the `read_error` bucket so an oncall can tell
    // "host misconfigured" apart from "user never logged in".
    const missingConfig = code === "ENOENT";
    emit(missingConfig ? "missing_config" : "read_error", { errno_code: code });
    return missingConfig
      ? { kind: "missing_config", recovery: "kimi_login" }
      : { kind: "error", retryable: true };
  }

  const models: RuntimeModelInfo[] = [];
  // Match `[models.<key>]` and `[models."<key>"]`. `<key>` may contain `/`,
  // dots, dashes, etc. — we conservatively grab everything up to the closing
  // `]` and trim quoting.
  const sectionRe = /^\s*\[models\.(.+?)\s*\]\s*$/gm;
  let sectionMatch: RegExpExecArray | null;
  let displayNamePresentCount = 0;
  while ((sectionMatch = sectionRe.exec(raw)) !== null) {
    let id = sectionMatch[1].trim();
    if (id.startsWith("\"") && id.endsWith("\"")) id = id.slice(1, -1);
    if (!id) continue;

    // Look for a `display_name = "..."` inside this model's body (lines
    // between this section header and the next `[...]` header). If the user
    // provisioned via `kimi login`, this is set by `provisionManagedKimiCodeConfig`
    // in `packages/oauth/src/managed-kimi-code.ts` upstream.
    const sectionStart = sectionMatch.index + sectionMatch[0].length;
    const nextSection = raw.slice(sectionStart).search(/^\s*\[/m);
    const body = nextSection === -1 ? raw.slice(sectionStart) : raw.slice(sectionStart, sectionStart + nextSection);
    const displayMatch = body.match(/^\s*display_name\s*=\s*"([^"]+)"/m);
    const label = displayMatch ? displayMatch[1] : id;
    if (displayMatch) displayNamePresentCount++;

    const effortListMatch = body.match(/^\s*support_efforts\s*=\s*\[([^\]]*)\]/m);
    const supportedReasoningEfforts = effortListMatch
      ? [...effortListMatch[1].matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"/g)]
          .map((match) => match[1])
          .filter((effort) => effort.length > 0 && effort.trim() === effort && !effort.includes("\0"))
      : [];
    const defaultEffortMatch = body.match(/^\s*default_effort\s*=\s*"([^"]+)"/m);
    const defaultReasoningEffort = defaultEffortMatch && supportedReasoningEfforts.includes(defaultEffortMatch[1])
      ? defaultEffortMatch[1]
      : undefined;

    models.push({
      id,
      label,
      verified: "launchable",
      ...(supportedReasoningEfforts.length > 0 ? { supportedReasoningEfforts } : {}),
      ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
    });
  }

  let defaultModel: string | undefined;
  const defaultMatch = raw.match(/^\s*default_model\s*=\s*"([^"]+)"/m);
  if (defaultMatch) defaultModel = defaultMatch[1];

  if (models.length === 0) {
    // Config exists but `[models.*]` is empty — login completed without any
    // model granted, or upstream changed the schema. Distinct from
    // `missing_config` so an oncall can tell whether the user logged in.
    emit("no_models", { default_model_present: Boolean(defaultModel) });
    return { kind: "no_models", recovery: "kimi_login" };
  }

  emit("models_returned", {
    models_count: models.length,
    display_name_present_count: displayNamePresentCount,
    default_model_present: Boolean(defaultModel),
  });

  return { kind: "live", value: { models, default: defaultModel } };
}

/**
 * Kimi SDK driver.
 *
 * Slock runs Kimi through the @botiverse/kimi-code-sdk Node SDK as a native
 * RuntimeSession. The legacy child-process kimi-cli driver (id "kimi") stays
 * registered alongside this one (frontend marks it deprecated). Visible
 * chat/task/attachment communication goes through the workspace-local `raft`
 * CLI wrapper, whose absolute path is surfaced to the LLM via the SDK's native
 * `roleAdditional` standing slot (process.env.PATH inheritance is unsafe across
 * in-process agents).
 */
export class KimiSdkDriver implements RuntimeDriver {
  readonly id = "kimi-sdk";
  // Its subagents stop through the SDK session (KimiSdkRuntimeSession.interruptSubagent).
  readonly stopsSubagentsInSession = true;
  /**
   * Genuine native support: the standing prompt (and wrapper CLI note) are
   * mounted via the Kimi SDK's `roleAdditional` session option, which renders
   * into the base system prompt on every request and therefore survives context
   * compaction — no per-turn re-assertion needed. See
   * composeStandingRoleAdditional + createKimiAgentSessionForContext.
   */
  readonly supportsNativeStandingPrompt = true;
  /** task #13: resumeSession re-renders roleAdditional from this launch (measured on the SDK 0.34). */
  readonly standingPromptRefreshesOnResume = true;
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
    detectedModelsVerifiedAs: "suggestion_only" as const,
    toLaunchSpec: (modelId: string) => ({ params: { model: modelId } }),
  };
  readonly supportsStdinNotification = true;
  readonly busyDeliveryMode = "direct" as const;
  // The Kimi SDK runs in the daemon process; its version is a constant of this build.
  readonly shipsWithComputer = true;

  private sessionId: string | null = null;

  get currentSessionId(): string | null {
    return this.sessionId;
  }

  probe(): RuntimeProbeResult {
    // SDK is in-process — availability is "is the package importable".
    // The import at the top of this file would have failed at module-load if
    // not, so by the time probe() runs the SDK is available.
    return { available: true, version: KIMI_CODE_HOST_VERSION };
  }

  async detectModels(ctx?: RuntimeModelDetectionContext): Promise<RuntimeModelSourceOutcome> {
    return detectKimiSdkModels(undefined, ctx);
  }

  createSession(ctx: SpawnContext): RuntimeSession {
    this.sessionId = ctx.config.sessionId || null;
    return new KimiSdkRuntimeSession(ctx, (sessionId) => {
      this.sessionId = sessionId;
    });
  }

  async spawn(_ctx: SpawnContext): Promise<SpawnResult> {
    throw new Error("KimiSdkDriver uses a native RuntimeSession; child-process spawn is unsupported");
  }

  parseLine(_line: string): ParsedEvent[] {
    return [];
  }

  encodeStdinMessage(
    _text: string,
    _sessionId: string | null,
    _opts?: { mode?: "idle" | "busy" },
  ): string | null {
    return null;
  }

  buildSystemPrompt(config: AgentConfig, _agentId: string): AxSurfaceText {
    return buildCliTransportSystemPrompt(config, {
      extraCriticalRules: [],
    });
  }
}
