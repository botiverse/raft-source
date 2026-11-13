// Agent host backed by OAR sessions (RFC 060).
//
// The legacy host is AgentProcessManager plus the runtime drivers. This host
// runs the same agents on an OAR `Session`: OAR owns the process, the record
// stream, turn boundaries and typed control results; this host owns Raft's
// part around them (launch preparation, the first input, delivery policy,
// status, activity and the RFC 071 runtime-outcome frames). It never sees a
// `ParsedEvent`.
//
// It reuses the legacy host's own pieces wherever they are not tied to a
// driver: the start ladder (`planStartupInput`), wake session recycling, the
// startup MEMORY.md block, the standing-prompt refresh, the launch's spawn
// config and CLI transport, the RFC 071 gate. What it cannot run it hands
// back before anything ran (`supports()` before the start, `fallback` during
// it), and the legacy host runs that start. A runtime with no legacy driver
// (`RuntimeDriver.oarOnly`: Qwen Code, Qoder) is never handed back: the router
// fails what this host cannot run (agentHostRouter.ts).
//
// Scope today: antigravity, codex, cursor, grok, qwen, qoder, codebuddy (`OAR_LAUNCHES`). See README.md in this directory.

import { randomUUID } from "node:crypto";
import path from "node:path";
import type { AuthStatus, Event, FailedTurn, FailureClass, RejectionCode, Session, TurnOutcome, Unsubscribe } from "@botiverse/oar";
import { activityTurnTokensFrom } from "../runtimeTurnTokens";
import { resolveRaftHome } from "../raftHome";
import { SessionSummaryRecorder, SessionSummaryStore, sessionSummaryDir } from "./oarSessionSummary";
import {
  AGENT_TURN_ENDED_MAX_SHOWN_TARGETS,
  type AgentActivityDetailKind,
  type AgentActivityKind,
  type AgentConfig,
  type AgentInboxAppItem,
  type AgentMessage,
  type AgentRuntimeOutcome,
  type AgentServerFeatures,
  type AgentStartNotSpawnedReason,
  type AgentSubagentInterruptOutcome,
  type AgentTurnEndedOutcome,
  type MachineToServerMessage,
  type RuntimeErrorActivityDiagnostic,
  type RuntimeErrorClass,
  type SpawnFailureReason,
  type CredentialHoldActivityDiagnostic,
  type TrajectoryEntry,
  type TraceContext,
  type Tracer,
  isRuntimeProgressDetailKind,
  pickAgentServerFeatures,
} from "@botiverse/raft-shared";
import { LegacyActivitySink, type ActivityProducerContext, type ActivitySink } from "../activity/activitySink";
import type { AgentAppInboxNoticeOptions, AgentAppInboxStore } from "../agentAppInbox";
import { AGENT_DRAIN_MAX_DEADLINE_MS, AgentDrains, type AgentDrainNotQuiet, type AgentDrainNotRunnable, type AgentDrainOptions, type AgentDrainProgress, type AgentDrainSummary } from "../agentDrain";
import {
  agentNotIdleReason,
  agentNotRunnableReason,
  agentStopWaitReason,
  type AgentIdleFacts,
  type AgentIdleOptions,
  type AgentNotIdleReason,
  type AgentRunnableFacts,
  type AgentStopWait,
} from "../agentIdle";
import { AgentIdleHoldTracker } from "../agentIdleHold";
import { appInboxItemNoticed, appInboxNoticeText, inboxItemsLaunchAtMs } from "../agentAppInboxNotice";
import { reportThirdPartyEventsDelivered } from "../agentCredentialProxy";
import { initializeLaunchWorkspace, withLocalRuntimeContext } from "../agentLaunchWorkspace";
import {
  RUNTIME_PROFILE_DAEMON_NOTICE_MESSAGE_PREFIX,
  formatConcreteMessagesRuntimeInput,
  formatInboxUpdateRuntimeInput,
  inboxUpdateRenderOptions,
  formatServerContextPrefix,
  formatSubagentsFinishedRuntimeInput,
  formatSystemNoticeRuntimeInput,
  isServerContextMessage,
  projectThreadJoinContextsForRuntimeInput,
  renderedUnreadSummaryTargets,
  runtimeProfileNotificationFromMessage,
  type AxSurfaceText,
} from "../agentRuntimeInput";
import type { AgentStartAcceptance } from "../agentStartDispatchProjection";
import { getDriver } from "../drivers/index";
import type { ParsedEvent, RuntimeDriver, SpawnContext } from "../drivers/types";
import { CodexSessionTraces } from "./oarCodexTraces";
import { OarTaskRows, type OarTaskRow } from "./oarTaskActivity";
import { codexCommunicationGapAttrs, type TurnSpanEventLimits } from "../runtimeCommunicationTrace";
import { messagesTraceAttrs } from "../runtimeTurnTrace";
import { appInboxTurnTriggerAttrs, messageTurnTriggerAttrs } from "../turnTriggerTrace";
import { runtimeTelemetryVersionAttrs, sanitizeRuntimeTelemetryPayloadAttrs } from "../runtimeTelemetrySanitization";
import { spawnCliTransportDir } from "../drivers/cliTransport";
import { AGENT_STOP_KILL_CONFIRM_MS, AGENT_STOP_KILL_GRACE_MS } from "../drivers/processStop";
import { planSpawnContextGeneration } from "../contextGeneration";
import { cleanupLaunchProxies, cleanupLaunchProxiesForLaunch } from "../launchProxyCleanup";
import { logger } from "../logger";
import { cursorSdkAvailable, loadOarObserve, loadOarRuntime, loadOarSessionRuntime, type OarObserve } from "../oarLoader";
import {
  ProviderLimitLedger,
  credentialInvalidAppliesToModel,
  credentialInvalidNoticeKey,
  ownProviderLimitCredentialKey,
  providerLimitCredentialKey,
  providerLimitCredentialKeyKind,
  type CredentialInvalidReason,
  type CredentialInvalidRecord,
  type CredentialInvalidVisibility,
  type ProviderLimitBackoffRecord,
  type ProviderLimitChange,
  type ProviderLimitCredentialKey,
} from "../providerLimitLedger";
import { RecentDeliveryIds } from "../recentDeliveryIds";
import { bucketMs } from "../runtimeBusyDeliveryCoordinator";
import { runtimeDiagnosticTrajectoryEntry } from "../runtimeDiagnosticEntry";
import { runtimeDiagnosticTraceAttrs, type RuntimeDiagnosticEvent } from "../runtimeEventTrace";
import { carryHeldRunnerCredential, revokeManagedRunnerCredential } from "../runnerCredentialRevoke";
import {
  buildBoundedVisibleCrashDetail,
  buildRuntimeErrorActivityDiagnostic,
  buildRuntimeErrorDiagnosticEnvelope,
  formatCredentialInvalidHeldNotice,
  formatRuntimeBillingExhaustedMessage,
  formatRuntimeInputTooLargeMessage,
  formatRuntimeLoginRequiredMessage,
  formatRuntimeMessageTooLargeMessage,
  formatRuntimePlanAccessMessage,
  formatRuntimeStartupInputTooLargeMessage,
  formatRuntimeResetSessionGuidance,
  runtimeDisplayName,
} from "../runtimeErrorDiagnostics";
import {
  isProviderStreamFailureText,
  isRuntimeUsageLimitText,
  providerLimitBackoffDelayMs,
  QUOTA_RESET_BACKOFF_MAX_MS,
  RUNTIME_ERROR_DELIVERY_BACKOFF_BASE_MS,
  RUNTIME_ERROR_DELIVERY_BACKOFF_MAX_MS,
  recoverableRuntimeProcessCloseReason,
  runtimeErrorDeliveryBackoffDelayMs,
  type RuntimeErrorProviderLimit,
} from "../runtimeErrorDeliveryPolicy";
import { terminalFailureFromRawText } from "../runtimeOutcome";
import type { CapabilityWait, RecoveryGrant, StartRefusalDecision } from "../runtimeOutcomeOutbox";
import {
  StandingPromptLedger,
  applyFreshSessionStandingPrompt,
  applyStandingPromptUpdate,
  planStandingPromptRefresh,
  stableStandingPromptConfig,
  standingPromptGoesInFirstInput,
  standingPromptHash,
  standingPromptRecordForReportedSession,
  standingPromptSessionBinding,
} from "../standingPromptRefresh";
import { applyStartupMemoryBlock, buildStartupMemoryBlock, resolveStartupMemoryBlockConfig } from "../startupMemoryBlock";
import { planStartupInput, type ThreadJoinContextProjector } from "../startupInput";
import { thirdPartyEventIdsFromEvents } from "../thirdPartyEventDeliveryReporter";
import { TurnSummaryTracker, turnOutcomeForActivity, turnTriggerFromMessages } from "../turnSummaryTracker";
import { serverFeaturesDrift } from "../serverFeaturesRefresh";
import { AgentConfigRevisions } from "../agentConfigRevisions";
import { SpecHandbacks } from "../specHandbacks";
import { ambientProcessEnv } from "../processEnvPatch";
import { credentialAccountCheck, createCredentialAccountReader, type CredentialAccount, type CredentialAccountReader } from "../credentialSource";
import { isCursorSdkSessionId, runtimeHostSessionDrop, runtimeSpecDrift, runtimeSpecOf, sessionDropReason, sessionDropReasonText, SessionSpecMemory, type RuntimeSpecDriftKind, type RuntimeSpecReconcileTrigger, type RuntimeSpecSnapshot } from "../runtimeSpec";
import {
  STALLED_REPLACEMENT_MAX_STREAK,
  STALLED_WITH_WORK_THRESHOLDS,
  StalledReplacementStreaks,
  stalledWithWork,
  type StalledWithWorkDeliveryHold,
  type StalledWithWorkFacts,
  type StalledWithWorkThresholds,
} from "../stalledWithWork";
import { chooseSession, RESUME_FAILURE_THRESHOLD } from "../chooseSession";
import {
  ExitStreaks,
  formatCrashStreakExhaustedMessage,
  formatZeroEvidenceStreakMessage,
  planExit,
  type ExitExpectedTermination,
  type ExitFacts,
  type ExitPlan,
  type RecoverableExitError,
} from "../planExit";
import { startFailureActivity } from "../spawnFailureClassification";
import { reportedStickyFailureReason, type SessionResetCause } from "../stickyFailureRecords";
import { TURN_END_COMPACTION_EVENT, TURN_END_COMPACTION_OAR_RUNTIMES, TurnEndCompactionArming, turnEndCompactionLogLine, decideTurnEndCompaction, resolveTurnEndCompactionConfig, turnEndCompactionTraceAttrs, type TurnEndContextFacts } from "../turnEndCompaction";
import { COLD_IDLE_SWEEP_MS, WAKE_RECYCLE_SUMMARY_FACTS_RUNTIMES, applyWakeRecycleBriefing, coldIdleGate, decideColdIdle, describeAppliedWakeRecycle, describeRecycledWakeLogLine, recycleThresholdTraceAttrs, planWakeSessionRecycle, resolveWakeRecycleConfig, sessionSummaryResumeFacts, wakeRecycleKindTraceAttrs } from "../wakeSessionRecycle";
import { WARM_RECYCLE_CANCELLED_EVENT, WARM_RECYCLE_MARKED_EVENT, WARM_RECYCLE_STOPPED_EVENT, WarmRecycleMarks, decideWarmRecycleMark, describeWarmRecycleCancelled, describeWarmRecycleMarked, describeWarmRecycleStopped, resolveWarmRecycleConfig, warmRecycleCoversRuntime, warmRecycleSenderKind, type WarmRecycleCancelReason, type WarmRecycleConfig, type WarmRecycleMark, type WarmRecycleSenderKind, type WarmRecycleTimers } from "../wakeRecycleWarm";
import type { AgentDeliveryContext, AgentIdleNoticeDelivery, AgentIdleNoticeFacts, AgentStartRequest, AgentTurnInterruptReport, HostedAgentSession } from "./agentLifecycleHost";
import { OarActivityProjector, type OarToolClassifier } from "./oarActivity";
import { OarTurnTrace, isOarModelWork, oarTraceCounterKinds, refusalTraceAttrs, type OarTurnStart } from "./oarTurnTrace";
import { withOarOomPreference } from "./oarOomPreference";
import { prepareAntigravityOarLaunch } from "./oarAntigravityLaunch";
import { CodexActivityReader } from "./oarCodexActivity";
import { prepareCodexOarLaunch } from "./oarCodexLaunch";
import { cursorAuthEnv, cursorSdkCredentialPresent, cursorSdkSignIn, prepareCursorOarLaunch } from "./oarCursorLaunch";
import { prepareGrokOarLaunch } from "./oarGrokLaunch";
import { prepareOarOnlyLaunch } from "./oarOnlyLaunch";
import type { OarLaunch, PrepareOarLaunch } from "./oarLaunch";

/** How each runtime this host runs turns a Raft launch into an OAR launch. */
const OAR_LAUNCHES: Readonly<Record<string, PrepareOarLaunch>> = {
  antigravity: (ctx) => prepareAntigravityOarLaunch(ctx),
  codex: (ctx) => prepareCodexOarLaunch(ctx),
  // #oar-raft:#10, behind `agent_runtime_oar_cursor` (oarCursorLaunch.ts).
  cursor: (ctx) => prepareCursorOarLaunch(ctx),
  grok: (ctx) => prepareGrokOarLaunch(ctx),
  qwen: (ctx) => prepareOarOnlyLaunch("qwen", ctx),
  qoder: (ctx) => prepareOarOnlyLaunch("qoder", ctx),
  codebuddy: (ctx) => prepareOarOnlyLaunch("codebuddy", ctx),
};

/**
 * What OAR keeps of one session's records in this process (#wg-ax:#3, M1):
 * past it the oldest frames keep their kind, `seq`, usage and text but lose
 * native frames and tool input and output (`elided`). Raft reads every record
 * live, from the session's first record (`afterSeq: -1` at open), and reads
 * stored records only for the exit code, which an elided frame keeps; so the
 * payloads OAR would otherwise hold for a session's whole life serve nothing.
 */
export const OAR_RETAINED_BYTES = 4 * 1024 * 1024;

/** A launch with the host's record bound, unless the launch set its own. */
export function withOarRecordRetention(launch: OarLaunch): OarLaunch {
  if (launch.options.retainedBytes !== undefined) return launch;
  return { ...launch, options: { ...launch.options, retainedBytes: OAR_RETAINED_BYTES } };
}

/** Runtimes this host can run; one with a legacy driver still needs its server flag (`agent_runtime_oar_<runtime>`). */
export const OAR_HOSTED_RUNTIMES: ReadonlySet<string> = new Set(Object.keys(OAR_LAUNCHES));

const HEARTBEAT_INTERVAL_MS = 60_000;
/** #oar-raft:#10: how long a Cursor start waits for the SDK's sign-in status (its first load included). */
const CURSOR_SIGN_IN_READ_MS = 20_000;
/** #oar-raft:#10: Cursor CLI sessions remembered as already reported moved (`cursorMigrationsNoted`), oldest dropped past this. */
const CURSOR_MIGRATIONS_NOTED_MAX = 1_000;
/**
 * #oar-raft:#10: why a Cursor start failed when the SDK's sign-in could not be
 * read and the agent's session is the SDK's (`cursor_sdk_status_unknown`):
 * what happened and what to do, in the owner's words.
 */
export const CURSOR_SIGN_IN_UNREADABLE_TEXT = "The agent didn't start because Raft couldn't check this Computer's Cursor sign-in (the check failed or took too long). Its Cursor session is kept. Start the agent again; if this keeps happening, restart the Computer.";
/** #oar-raft:#10: the Activity Log row when a Cursor CLI session is left for a new SDK session. */
export const CURSOR_SESSION_MIGRATED_TEXT = "Raft now runs Cursor through the Cursor SDK, which can't continue sessions from the Cursor CLI, so this agent started a new Cursor session. Its memory and Raft history are unchanged.";
/** Steers the runtime may refuse in one turn before held deliveries wait for its end. */
const STEER_REFUSALS_PER_TURN = 3;
/** The taken-id window (`HostedAgent.delivered`): past the server's longest re-send of a delivery. */
const TAKEN_ID_LIMIT = 4096;
const TAKEN_ID_MAX_AGE_MS = 60 * 60_000;
/** Ends whose dropped deliveries the server carries by design (a stop); others are logged as warnings. */
const OAR_STOP_REASONS: ReadonlySet<string> = new Set(["explicit_stop", "silent_stop", "stopped_start", "spec_restart", "stalled_recovery"]);
const TEXT_COALESCE_MS = 1_000;
const DELIVERY_ORIGIN = { kind: "notification", source: "raft" } as const;

export type OarHostSupport = { ok: true } | { ok: false; reason: string };

/** Opens an OAR session for a launch; replaceable in tests (OAR's `scriptedRuntime`). */
export type OpenOarSession = (launch: OarLaunch) => Promise<Session>;

/** The RFC 071 gate (`runtimeOutcomeOutbox.ts`), the same object the legacy host uses. */
export interface OarRuntimeProcessGate {
  openProcess(agentId: string, processInstanceId: string, spawnLaunchId: string | null): boolean;
  processExitedLocally(agentId: string, processInstanceId: string): void;
  processNotStarted(agentId: string, processInstanceId: string): void;
  startRefusal(agentId: string, launchId: string | null, recoveryGrant: RecoveryGrant | null): StartRefusalDecision | null;
  waitForCapability(): CapabilityWait;
}

/** RFC 071 launch results; the accepted-launch ledger is the legacy host's, shared per agent. */
export interface OarLaunchLedger {
  /** Every accepted launch of the agent still waiting for its result (named by `process_spawned`). */
  take(agentId: string): string[];
  /** A launch no longer waiting keeps the result it has. */
  settleNotSpawned(agentId: string, launchId: string, reason: AgentStartNotSpawnedReason): void;
  settleRebound(agentId: string, launchId: string, processInstanceId: string): void;
}

/** The oldest Grok Build the OAR Grok adapter runs (the fleet's 1.0.70 and 1.0.77 lines, #oar-raft:#4). */
export const OAR_GROK_MIN_CLI_VERSION = [1, 0, 70] as const;

/**
 * Grok Build itself (`grok 1.0.77`, optionally `[stable]`) at or above
 * OAR_GROK_MIN_CLI_VERSION. Another program in the slot (`raft-devin-adapter
 * 0.2.0`, `grok 0.9.0 (raft-acp-bridge 0.3.0)`, `aiderdesk 0.1.0`) or no
 * version at all is not.
 */
export function isVerifiedGrokCli(version: string | undefined): boolean {
  const match = /^grok (\d+)\.(\d+)\.(\d+)(?: \[[a-z]+\])?$/i.exec(version?.trim() ?? "");
  if (!match) return false;
  const parts = [Number(match[1]), Number(match[2]), Number(match[3])];
  for (let i = 0; i < 3; i++) {
    if (parts[i]! !== OAR_GROK_MIN_CLI_VERSION[i]) return parts[i]! > OAR_GROK_MIN_CLI_VERSION[i]!;
  }
  return true;
}

export interface OarAgentHostDeps {
  dataDir: string;
  /** The runtime CLI's version as the last ready reported it (`grok 1.0.77 [stable]`); Grok starts need a verified one (#oar-raft:#4). */
  detectedRuntimeCliVersion?: (runtimeId: string) => string | undefined;
  /** Reconciler step 15: reads the account an agent's runtime signs in as (credentialSource.ts); tests fake it. */
  credentialAccountReader?: CredentialAccountReader;
  serverUrl: string;
  daemonApiKey: string;
  slockCliPath: string;
  slockHome?: string;
  /** Where the agents' session summaries live (daemon state, never a workspace); `<raft home>/agent-session-summaries` by default. */
  sessionSummaryDir?: string;
  daemonVersion?: string | null;
  computerVersion?: string | null;
  /** The agent frame route: RFC 071 frames go through the outbox, the rest straight to the server. */
  sendToServer(msg: MachineToServerMessage): void;
  /** The shared per-agent client sequence (RFC 069 §8). */
  nextClientSeq(agentId: string): number;
  daemonInstanceId(): string | null;
  /** The config a launch runs with; the legacy host's `buildSpawnConfig`. */
  buildSpawnConfig(agentId: string, config: AgentConfig): Promise<AgentConfig>;
  /** task #365: the start was claimed against another server connection than the current one. */
  isStaleClaim(claimedConnectionEpochId: string | null): boolean;
  gate: OarRuntimeProcessGate | null;
  launches: OarLaunchLedger;
  appInboxForAgent?(agentId: string): AgentAppInboxStore;
  /**
   * The agent went from Working to Idle: a turn ended and nothing more was
   * waiting to be handed over. The legacy host's `onAgentWorkingToIdle` (the
   * built-in apps' idle hook: MEMORY.md cleaner, idle task reminder).
   */
  onAgentWorkingToIdle?(agentId: string): void;
  /** View Context stays with the legacy host's manager (`agentContextView/`): this host tells it of its sessions and sends. */
  contextView?: {
    /** `enabled`: the agent's gate now, which the launch's config (`session.config`) may be behind. */
    sessionStarted(agentId: string, session: HostedAgentSession, enabled: boolean): void;
    messageCommitted(agentId: string, input: { messageId: string; route: "send" | "task_reply" }): void;
  };
  /** The legacy host's `agent:runtime_profile` report, for a session of this host (`session_init` at the commit, `stop` after an explicit stop). */
  sendRuntimeProfileReport?(agentId: string, session: HostedAgentSession, source: "session_init" | "stop"): void;
  /** `parent`: the trace the event joins (a turn's), else the active span's. */
  recordEvent(name: string, attrs: Record<string, unknown>, status?: "ok" | "error" | "cancelled", parent?: TraceContext | null): void;
  /**
   * #proj-raft-computer:#46: the provider limits per credential, shared with
   * the legacy host (its `providerLimitLedger`), so a limit either host's
   * agent hits on a shared sign-in holds the agents of both. A ledger of this
   * host's own by default.
   */
  providerLimits?: ProviderLimitLedger;
  /**
   * Reconciler step 7: the runtime and model each agent's last session
   * started on, shared with the legacy host (its `sessionSpecs`), so a start
   * on either host does not resume a session another runtime (or Codex
   * model) ran. One of this host's own by default.
   */
  sessionSpecs?: SessionSpecMemory;
  /**
   * Reconciler step 11: the order of the configs the server sends each
   * agent, and a push held until a host registers the agent; shared with the
   * legacy host (its `configRevisions`). One of this host's own by default.
   */
  configRevisions?: AgentConfigRevisions;
  /**
   * Reconciler step 11c: the agents a spec stop handed to the server, shared
   * with the legacy host (its `specHandbacks`), whose refusal of the next
   * delivery then reports a start. One of this host's own by default.
   */
  specHandbacks?: SpecHandbacks;
  /**
   * The wait for a provider limit with no reported reset, and (reconciler
   * step 10b) the crash streak's restart backoff: the legacy host's delivery
   * backoff policy, as both of its uses there (tests shorten it).
   */
  providerLimitBackoff?: { baseMs?: number; maxMs?: number; jitterRatio?: number; jitterRandom?: () => number };
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  /** Where runtimes keep their sessions (wake recycle reads transcripts there); the user's home by default. */
  runtimeSessionHomeDir?: string;
  now?(): number;
  /** RFC 070 §6.5: the warm-recycle quiet timer (tests fire it by hand); real timers when absent. */
  warmRecycleTimers?: WarmRecycleTimers;
  openSession?: OpenOarSession;
  /** OAR's observe entry (`observeStalls`); the bundled one by default (tests delay it). */
  loadObserve?: () => Promise<OarObserve>;
  prepareLaunch?: PrepareOarLaunch;
  platform?: NodeJS.Platform;
  /**
   * #oar-raft:#10: whether this daemon can run Cursor through the SDK
   * (`cursorSdkAvailable`: Linux, non-SEA, the SDK resolves); tests fake it.
   */
  cursorSdkAvailable?: () => boolean;
  /** #oar-raft:#10: the Cursor SDK's sign-in status (OAR's local `authStatus`) in the environment given (`cursorAuthEnv`); tests fake it. */
  cursorAuthStatus?: (env: Record<string, string>) => Promise<AuthStatus>;
  /** How many taken ids a launch remembers for dedup (tests). */
  takenIdLimit?: number;
  /**
   * Reconciler step 5: resolves once a stopped legacy-host process of the
   * agent has been seen to exit (at once if none is exiting), or once
   * `signal` aborts. A launch waits for it: two processes never run one agent.
   */
  legacyRuntimeExited?(agentId: string, signal: AbortSignal): Promise<void>;
  /** Reconciler step 5: the stop grace and the exit confirmation window (tests shorten them). */
  stopKill?: { graceMs?: number; confirmMs?: number };
  /**
   * Reconciler steps 6, 7 and 9: how often sessions held from their runtime
   * spec, or with deliveries waiting, are decided again (the legacy host's
   * sweep interval by default).
   */
  featuresSweepMs?: number;
  /** Reconciler step 9: the stall thresholds (stalledWithWork.ts; tests shorten them). Also the "No runtime output" report's. */
  stalledWithWorkThresholds?: StalledWithWorkThresholds;
  /**
   * Reconciler step 9: the stalled-replacement streaks, shared with the
   * legacy host (its lifecycle records). One of this host's own by default.
   */
  stalledReplacements?: StalledReplacementStreaks;
  /**
   * Reconciler step 10b: the exit streaks (crash and cap streaks, the
   * early-crash record of a resumed session; planExit.ts), shared with the
   * legacy host: one per daemon, from core.ts. One of this host's own by default.
   */
  exitStreaks?: ExitStreaks;
  /**
   * Reconciler step 5, the orphan sweep: a session opened (its runtime is
   * recorded), a session was disposed (the record goes once it is gone).
   */
  runtimeProcesses?: { opened(agentId: string, launchId: string | null): void; closed(agentId: string): void };
  /** The `daemon.runtime.turn` span's event cap; the legacy host's by default (tests shrink it). */
  turnSpanEventLimits?: TurnSpanEventLimits;
  /** How long a turn cut short waits for the exit (OAR_TURN_EXIT_WAIT_MS by default; tests change it). */
  turnExitWaitMs?: number;
}

/**
 * One delivery the host holds until the runtime takes it. A server delivery
 * (`custody`) was acked to the core when the host took it, as the legacy host
 * acks what it queues: an ack is custody, not consumption, and a message the
 * runtime never took stays unread on the server for the next start's catch-up
 * (task #353). The host's own inputs (app Inbox and release notices) settle
 * when the runtime takes them.
 */
interface Delivery {
  message: AgentMessage;
  contexts: AgentDeliveryContext[];
  custody: boolean;
  /** A tracked mention's `daemon_pending` was sent (it waits for a turn end or the commit). */
  pendingReported: boolean;
  /** Pre-rendered input (app Inbox notice): handed over as is, never batched. */
  rawInput?: string;
  /** A start's own first input, held at its commit (a credential hold): it belongs to that launch. */
  firstInput?: true;
  /** When this host took it (the turn span's `local_wait_ms`). */
  receivedAtMs: number;
  /** A pre-rendered input's turn span start (its reason and trigger); ordinary messages carry theirs. */
  turnStart?: OarTurnStart;
  onAccepted?: () => void;
  settled: Promise<boolean>;
  settle(accepted: boolean | Promise<boolean>): void;
}

/** A delivery handed to another host after a fallback; `settle` with that host's answer. */
export interface HeldDelivery {
  message: AgentMessage;
  context: AgentDeliveryContext;
  settle(accepted: boolean | Promise<boolean>): void;
}

export type OarStartOutcome =
  | { kind: "started" }
  | { kind: "rebound" }
  | { kind: "stopped" }
  /**
   * Nothing runs on OAR: the legacy host runs `request`, then takes `held`.
   * For an OAR-only runtime the router fails the start instead: `cause` is
   * the launch error, `refusal` the RFC 071 gate's decision, when either is why.
   */
  | {
    kind: "fallback";
    reason: string;
    request: AgentStartRequest;
    held: HeldDelivery[];
    cause?: unknown;
    refusal?: StartRefusalDecision;
    /** #oar-raft:#10: not for the legacy host (it would drop the session): the router fails the start with this sentence. */
    failHere?: string;
  };

/** How long a turn-end compaction is waited for (its wait, not the compaction: OAR never cancels it). */
const TURN_END_COMPACTION_WAIT_MS = 10 * 60_000;

interface HostedAgent {
  agentId: string;
  request: AgentStartRequest;
  runtimeId: string;
  driver: RuntimeDriver;
  committed: boolean;
  stopping: boolean;
  abort: AbortController;
  launchId: string | null;
  /** The accepted launches this start took on: its own and the ones rebound onto it before the commit. */
  launchIds: string[];
  /** The launch its launch proxies were registered for (`prepareLaunch`); null before. */
  proxyLaunch: { launchId: string | null } | null;
  /** This start's run; a later start of the agent waits for it once it was stopped. */
  finished: Promise<unknown>;
  /** The launch the process was born with (RFC 071 `spawnLaunchId`). */
  birthLaunchId: string | null;
  processInstanceId: string;
  processOpened: boolean;
  launch: OarLaunch | null;
  session: Session | null;
  runtimeConfig: AgentConfig | null;
  launchConfig: AgentConfig | null;
  credentialReleased: boolean;
  capabilityWait: CapabilityWait | null;
  /** Deliveries the first input names while it is in flight. */
  carried: Delivery[];
  /** Deliveries not yet handed to the runtime, in arrival order. */
  pending: Delivery[];
  /**
   * Message ids and server delivery ids the runtime has taken in this launch,
   * kept longer than the server re-sends one (30 min for a held mention) and
   * bounded in number.
   */
  delivered: RecentDeliveryIds;
  /** The app Inbox items this launch told the agent of, by item id, each with its createdAtMs then (appInboxItemNoticed). */
  appNoticedItems: Map<string, number | undefined>;
  unsubscribe: Unsubscribe[];
  /** #wg-ax task #3: the session's durable summary (`.raft/session-summary.json`); null before the session is observed. */
  summary: SessionSummaryRecorder | null;
  /** The session's events read into activity facts; null before the session is observed. */
  activity: OarActivityProjector | null;
  /** OAR's tool classification for this runtime; null when its observe entry didn't load. */
  classifyTool: OarToolClassifier | null;
  /** Codex only: what its native frames add to its events (legacy tool names, commentary, warnings). */
  codexActivity: CodexActivityReader | null;
  codexTraces: CodexSessionTraces | null;
  heartbeat: ReturnType<typeof setInterval> | null;
  /**
   * The last published activity. `credentialHold` (reconciler step 4b) is set
   * only while it is the idle status showing the held notice, so every frame
   * that re-states it (heartbeat, probe reply, diagnostic, released turn)
   * carries the reason too.
   */
  last: { activityKind: AgentActivityKind; detail: string; detailKind: AgentActivityDetailKind; credentialHold?: CredentialHoldActivityDiagnostic; runtimeError?: RuntimeErrorActivityDiagnostic };
  flushing: boolean;
  flushAgain: boolean;
  /**
   * How many held messages still go one at a time: the runtime refused them
   * together as one input too long (OAR `input_too_large`, a batch or a
   * first input), so only a message too long on its own is refused. Later
   * messages batch again once they are through.
   */
  deliverSingly: number;
  turn: { textEvents: number; toolCalls: number; runtimeErrors: number; thinkingEvents: number };
  /**
   * #wg-ax:#3 D1/D2, a launch that steers (`busyDelivery: "now"`): while the
   * turn compacts (or codex reviews) a delivery is held, as the legacy host
   * holds it; a steer the runtime refused stays held and is tried again at
   * the next tool start, at most STEER_REFUSALS_PER_TURN times a turn, then
   * at the turn end.
   */
  steerHold: { compacting: boolean; refusals: number };
  /**
   * #proj-runtime:#54 phase 3: native compaction at a turn end past the size
   * threshold (turnEndCompaction.ts). While one is in flight, deliveries are
   * held here and handed over when it settles.
   */
  turnEndCompaction: { arming: TurnEndCompactionArming; inFlight: { startedAtMs: number; heldSinceMs: number | null } | null; lastSkipKey: string | null };
  catchupBatch: { launchId: string; batchId: string; renderedRows: number } | null;
  shownUnreadTargets: string[];
  turnEndedReported: boolean;
  runtimeReadySent: boolean;
  processExitedSent: boolean;
  /** When the running (or last) turn started (`turn_started`), on OAR's clock; null before the first. */
  turnStartedAtMs: number | null;
  /**
   * #proj-raft-computer:#46: the agent's credential is at a provider limit and
   * held deliveries (the first input of a start included) wait for it to end
   * (`handOff`). The timer ends the wait at `untilMs`; a release ends it
   * early (`onProviderLimitChange`).
   */
  providerLimitWait: { untilMs: number; timer: ReturnType<typeof setTimeout> } | null;
  /**
   * Reconciler step 4a: what the agent shows of the invalid credential
   * holding it, its own error or the held notice (`credentialInvalidHeldNotice`).
   */
  credentialInvalidVisibility: CredentialInvalidVisibility | null;
  /**
   * Reconciler step 6: the server features this agent should run with, the
   * latest `server:features` answer applied since its start (null: none; its
   * start's own values then stand). Its session started on its launch's
   * `runtimeConfig`; the two differ is the drift (`reconcileSpec`).
   */
  serverFeatures: AgentServerFeatures | null;
  /**
   * Reconciler step 7: the runtime spec its session started with (of its
   * launch's `runtimeConfig`; runtimeSpec.ts, in memory only); null before
   * the launch is planned. Its request's config, which a rebind replaces,
   * holds the one it should run with: the two differ is the drift (`reconcileSpec`).
   */
  startedSpec: RuntimeSpecSnapshot | null;
  /**
   * Reconciler step 15: the provider account its launch signed in as
   * (credentialSource.ts; a digest, in memory only); null before the launch
   * is planned or when its runtime's account is not read.
   */
  credentialAccount: CredentialAccount | null;
  /** Reconciler step 15: its released credential now signs in as another (or an unreadable) account: a drift. */
  credentialAccountChanged: boolean;
  /**
   * Reconciler step 11: a pushed config naming another runtime than this
   * launch's, which arrived before the launch was planned (its driver is
   * fixed at the start). The request takes it once the launch is planned;
   * the drift then ends the session once idle.
   */
  pushAfterPlan: AgentConfig | null;
  /**
   * Reconciler step 9: the root agent's tool calls of the running turn that
   * started (`tool_call_started`) and have not ended (`tool_call_ended`);
   * cleared at each turn start and end. OAR has no tool diagnostic
   * snapshots, so an open one is never proven idle (`reconcileHealth`).
   */
  openToolCalls: Set<string>;
  /** #proj-runtime:#42: the sub-agents this launch has running. */
  taskRows: OarTaskRows;
  /**
   * #proj-runtime:#41, a runtime that only queues sub-agent results for its
   * next turn (`needsWakeAfterSubagents`, Codex): a sub-agent ended on its own
   * after the main turn ended and no turn has ended since (`resultUnread`),
   * and whether the last main turn was aborted (`lastTurnAborted`).
   */
  subagentWake: { resultUnread: boolean; lastTurnAborted: boolean };
  /**
   * Reconciler step 9: decides the agent again at the moment its held
   * deliveries would cross the stall threshold (`armStallDeadline`). One per
   * launch; it decides nothing itself.
   */
  stallDeadline: ReturnType<typeof setTimeout> | null;
  /**
   * Reconciler step 10b, the exit's facts (`exitFacts`): when the session
   * was opened (OAR's clock; null before), for the uptime.
   */
  openedAtMs: number | null;
  /** The session produced model output (text, reasoning, a tool start). */
  modelOutput: boolean;
  /** A turn runs (`turn_started` .. `turn_ended`). */
  turnOpen: boolean;
  /** The last turn was cut by the process's end (failed `runtime_exited`, or aborted with no abort asked). */
  turnCutByExit: boolean;
  /** This host asked OAR to abort the running turn (a person's turn interrupt). */
  abortRequested: boolean;
  /**
   * The last turn failed and no turn started since (the legacy host's live
   * runtime error, cleared by the next delivery): OAR's class and the
   * runtime's words. A `runtime_exited` failure is the exit itself, never this.
   */
  lastFailure: { failure: FailureClass; reason: string } | null;
  /** A restart after an exit (step 10b): the launch waits until then (the crash streak's backoff, a provider limit's wait); null: no wait. */
  startNotBeforeMs: number | null;
  /** That wait: a provider limit's (a release of the limit ends it early), and how to end it while it runs. */
  startWait: { untilLimitReleased: boolean; end: (() => void) | null } | null;
  /** Reconciler step 13: the launch went past the point a drain holds starts at; it is spawning (a drain waits for it). */
  pastDrainHold: boolean;
  /** The running turn's `daemon.runtime.turn` span (oarTurnTrace.ts). */
  turnTrace: OarTurnTrace;
  /** What the input handed over last starts: the span of the turn it begins (`turn_started`) takes it. */
  nextTurn: OarTurnStart | null;
  /**
   * #oar-raft:#10: the Cursor CLI session this launch left behind for a new
   * SDK session, reported once the session is open (`commit`): a start
   * handed back before then still resumes it on the driver.
   */
  migratedFromSessionId?: string;
  /** #oar-raft:#10: an Activity Log row this start shows once its session is open (a Cursor SDK session that could not be resumed). */
  sessionNotice?: TrajectoryEntry;
}

class LaunchStopped extends Error {}

/** A start the OAR host hands back to the legacy host; `reason` is traced. */
class HandBack extends Error {
  /**
   * #oar-raft:#10: the start must not reach the legacy host, which would drop
   * the agent's session (a Cursor SDK session the Cursor CLI cannot resume):
   * the router fails it with this sentence instead, and the next start tries
   * OAR again.
   */
  readonly failHere?: string;
  constructor(readonly reason: string, readonly refusal?: StartRefusalDecision, options?: { cause?: unknown; failHere?: string }) {
    super(reason, options);
    if (options?.failHere) this.failHere = options.failHere;
  }
}

/** The legacy host's `sameWakeMessage`: one message by id, or the same object. */
function sameWakeMessage(left: AgentMessage | undefined, right: AgentMessage): boolean {
  if (!left) return false;
  if (left.message_id && right.message_id) return left.message_id === right.message_id;
  return left === right;
}

function errorName(error: unknown): string {
  if (error instanceof Error) return error.name && error.name !== "Error" ? error.name : "Error";
  return typeof error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * task #1328: why an OAR session failed to open, as a closed class. The
 * reason names only the error class (nearly always `Error`), and the error's
 * own text is content: it never reaches a trace. A class does, so a problem
 * report can tell a model mismatch from a missing CLI without the text.
 */
export const OAR_OPEN_FAILURE_CLASSES = [
  "model_not_confirmed",
  "settings_not_confirmed",
  "runtime_not_found",
  "permission_denied",
  "auth_failed",
  "timeout",
  "network",
  "unknown",
] as const;
export type OarOpenFailureClass = typeof OAR_OPEN_FAILURE_CLASSES[number];

export function oarOpenFailureClass(cause: unknown): OarOpenFailureClass {
  if (!(cause instanceof Error)) return "unknown";
  const code = (cause as { code?: unknown }).code;
  const text = `${typeof code === "string" ? code : ""} ${cause.message}`;
  // qoder 1.1.82+ (OAR 0.87.1): a selector that is not one catalog `value`, or
  // whose display name is not unique, is refused at open.
  if (/did not confirm model|kept model .* although|model catalog did not (?:contain requested selector|provide a resolved name)/i.test(text)) return "model_not_confirmed";
  // codex: the thread came back with another service tier, effort or workspace roots than asked.
  if (/reports serviceTier .* although|(?:effort|reasoningEffort) .*although|effort .* cannot be confirmed|did not confirm the requested additionalDirectories/i.test(text)) return "settings_not_confirmed";
  // ACP effort (grok `reasoning_effort`, kimi `thinking`): a level the model
  // does not offer is refused `-32602 Invalid params` (OAR shared/acp/effort.ts
  // wraps every failure of that call as "... was refused: <error>", so only
  // the invalid-params answer is a setting; a timeout or exit falls through).
  if (/set_config_option \S+=\S+ was refused: Invalid params/i.test(text)) return "settings_not_confirmed";
  if (/\bENOENT\b|command not found|not installed/i.test(text)) return "runtime_not_found";
  if (/\bEACCES\b|\bEPERM\b|permission denied/i.test(text)) return "permission_denied";
  if (/\b(401|403)\b|unauthori[sz]ed|not logged in|log ?in required|authenticat/i.test(text)) return "auth_failed";
  if (/\bETIMEDOUT\b|timed? ?out/i.test(text)) return "timeout";
  if (/\b(ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN)\b/i.test(text)) return "network";
  return "unknown";
}

/**
 * The OAR failure class the legacy text classifier reads in a failure's
 * reason (runtimeErrorDiagnostics), for a failure OAR left `unknown`; null
 * when the text says nothing terminal either (it stays a failed turn).
 */
export function failureFromDiagnostic(diagnostic: RuntimeErrorActivityDiagnostic): FailureClass | null {
  // A plan without the model is action required, not a failure class (onFailedTurn).
  if (diagnostic.requiredAction === "user_reauth") return "auth";
  if (diagnostic.errorClass === "BillingError") return "billing";
  if (diagnostic.errorClass === "InputTooLargeError") return "input_too_large";
  return null;
}

/**
 * A failed turn's class: OAR's, or (#wg-ax:#3 A8) for a failure OAR could not
 * classify (codex reports an expired login or a used-up plan as `unknown`)
 * read from its text, as the legacy host reads every runtime error.
 */
function classifiedFailure(outcome: Extract<TurnOutcome, { kind: "failed" }>): { diagnostic: RuntimeErrorActivityDiagnostic; fromText: FailureClass | null; failure: FailureClass } {
  const diagnostic = buildRuntimeErrorActivityDiagnostic(outcome.reason);
  const fromText = outcome.failure === "unknown" ? failureFromDiagnostic(diagnostic) : null;
  return { diagnostic, fromText, failure: fromText ?? outcome.failure };
}

/**
 * The provider limit a failed turn's class says the agent's credential hit
 * (#proj-raft-computer:#46, design row C6), as the legacy host reads a
 * runtime error's (`runtimeErrorProviderLimit`): `quota` is a used-up quota
 * (until the reset OAR reports, if any), `rate_limited` and `overloaded` a
 * transient throttle; a failure OAR left `unknown` whose text says the usage
 * limit is reached is a used-up quota with no known reset (C5). Null for
 * every other failure.
 */
export function oarFailureProviderLimit(failure: FailureClass, outcome: FailedTurn): RuntimeErrorProviderLimit | null {
  switch (failure) {
    case "quota":
      return { kind: "quota_exhausted", ...(outcome.failure === "quota" && outcome.resetsAt ? { resetsAt: outcome.resetsAt } : {}), source: "structured" };
    case "rate_limited":
    case "overloaded":
      return { kind: "transient_rate_limit", source: "structured" };
    case "unknown":
      return isRuntimeUsageLimitText(outcome.reason) ? { kind: "quota_exhausted", source: "text" } : null;
    default:
      return null;
  }
}

/**
 * Reconciler step 10b: the recoverable class (planExit's D3) of a failed
 * turn before an exit, from OAR's failure class: a used-up quota, a rate
 * limit and an overloaded provider are the legacy host's rate limit, a
 * provider error its provider server error (the classes the legacy host reads
 * from a 429 / 5xx); a failure OAR left `unknown` is read from its text as
 * the legacy host reads every runtime error (connection and stream failures
 * included). Null for every other class (none is a provider's).
 */
export function oarRecoverableExitError(failure: FailureClass, reason: string): RecoverableExitError | null {
  switch (failure) {
    case "quota":
    case "rate_limited":
      return "rate_limited";
    case "overloaded":
    case "provider":
      return "provider_server_error";
    case "unknown":
      return recoverableRuntimeProcessCloseReason(reason, null, null) as RecoverableExitError | null;
    default:
      return null;
  }
}

/**
 * The backoff reason an OAR provider limit is recorded with: the legacy
 * host's for a rate limit, so a legacy process holding on it is released
 * only by real model output, never by turn-start bookkeeping.
 */
const OAR_PROVIDER_LIMIT_REASON = "rate_limited";

/** Grok's echo of an accepted `_x.ai/interject` for this input, in the session's records. */
export function interjectionEchoed(session: Pick<Session, "records">, inputId: string): boolean {
  return session.records().some((record) =>
    record.kind === "frame"
    && record.body.type === "_x.ai/session/interjection"
    && JSON.stringify(record.body.native ?? null).includes(inputId));
}

/**
 * Why the OAR host starts an agent again itself: a stall replacement, an exit
 * (step 10b), a session that no longer fits (step 12), the runtime's account
 * changing, or an idle session that refused a prompt (`prompt_refused`, once
 * per refusal streak; `recoverIdleRefusal`).
 */
type OarRestartCause = "stalled_recovery" | "exit" | "session_replaced" | "credential_account" | "prompt_refused";

/** A refusal's class in plain words, for the owner; none for a class that says nothing (a generic runtime error). */
const REFUSAL_CLASS_WORDS: Partial<Record<RuntimeErrorClass, string>> = {
  InputTooLargeError: "the input was too large for the model",
  RateLimitError: "the provider is rate limiting it",
  AuthError: "its account needs to sign in again",
  BillingError: "the provider account's balance is used up",
  NotFoundError: "its session or model was not found",
  ModelConfigError: "its model setting was not accepted",
  TimeoutError: "the request timed out",
  ProviderConnectionError: "it could not reach the provider",
  ProviderServerError: "the provider had a server error",
};

/**
 * The error a person sees when the runtime refused messages again after its
 * session was started again: what is true of the agent now (paused, retried
 * by the server's breaker), what happens to messages, one next step. The why
 * only in plain words, never the runtime's text or a code.
 */
function formatPromptRefusedAgainMessage(label: string, reason: string): string {
  const errorClass = reason ? buildRuntimeErrorDiagnosticEnvelope(reason).spanAttrs.runtime_error_class : undefined;
  const words = typeof errorClass === "string" ? REFUSAL_CLASS_WORDS[errorClass as RuntimeErrorClass] : undefined;
  const why = words ? ` (${words})` : "";
  return `${label} refused new messages again right after Raft restarted its session${why}. Raft has paused this agent and will try again by itself later; messages sent to it stay unread until it starts. To try now, restart it (Restart / Reset in the agent menu). If it keeps happening, switch its model or runtime.`;
}

export class OarAgentHost {
  /** Agents this host starts or runs; a stopped start leaves at once (`detachStopped`). */
  private readonly agents = new Map<string, HostedAgent>();
  /** #oar-raft:#10: Cursor CLI sessions whose move to the SDK was already reported (`noteCursorSessionMigrated`). */
  private readonly cursorMigrationsNoted = new Set<string>();
  /**
   * Agents whose idle session refused a prompt (`runtime_refused`) and were
   * started again on it once; the next refusal hands the agent to the server
   * (`recoverIdleRefusal`). Cleared by a later idle prompt the runtime takes
   * as a new turn (not by a steer into a running turn, nor by the restarted
   * session's first input, so a session that takes only that one cannot
   * restart once per message), by the hand-over, and by a person's stop (a
   * Restart gets its one reopen again, as the stalled-replacement streak does).
   */
  private readonly idleRefusalReopens = new Set<string>();
  /**
   * Launches the agent no longer holds that are still being undone, per
   * agent: stopped starts undoing their launch (their grok may still be
   * opening the agent's session) and ended sessions still disposing. The next
   * start of the agent, on either host, waits for them (`unwound`).
   */
  private readonly unwinding = new Map<string, Promise<void>>();
  /** Thread targets whose join context a first input or delivery rendered, per agent, across launches. */
  private readonly renderedThreadTargets = new Map<string, Set<string>>();
  /**
   * task #26: server context about the agent's own setup, written ahead of the
   * next input of each session that has not had it yet.
   */
  private readonly heldServerContext = new Map<string, { id: string; body: string; writtenTo: Set<string> }>();
  /** Reconciler step 13: the drain (agentDrain.ts); held deliveries wait in `pending`, held starts before their spawn. */
  /** Idle agents whose idle task reminder a drain answered `busy`: the end of the drain gives them one more idle edge (as the legacy host). */
  private readonly drainRefusedIdleNotices = new Set<string>();
  private readonly drain = new AgentDrains({
    host: "oar",
    progress: (agentId) => this.computeDrainProgress(agentId),
    release: (agentId) => this.releaseDrainHeld(agentId),
    recordEvent: (name, attrs) => this.deps.recordEvent(name, attrs),
    now: () => this.now(),
  });
  private readonly turnSummaries = new TurnSummaryTracker();
  private readonly sink: ActivitySink;
  private readonly openSession: OpenOarSession;
  private readonly loadObserve: () => Promise<OarObserve>;
  private readonly prepareLaunch: PrepareOarLaunch;
  private readonly standingPromptLedger: StandingPromptLedger;
  private readonly sessionSummaries: SessionSummaryStore;
  /** RFC 070 §6.5: sessions marked for a warm recycle, and the stops the next start decides on (wakeRecycleWarm.ts). */
  private readonly warmRecycle: WarmRecycleMarks;
  private readonly now: () => number;
  private readonly providerLimits: ProviderLimitLedger;
  private readonly providerLimitBackoff: { baseMs: number; maxMs: number; jitterRatio: number; jitterRandom: () => number };
  private tracer: Tracer | undefined;
  private cliTransportTraceDir: string | null = null;
  private serverReadsTurnEnded = false;
  /** Reconciler step 12: SERVER_CAPABILITY_STICKY_FAILURE_REASONS_V1 on the current connection. */
  private serverCountsStickyReasons = false;
  /** How long the runtime spec gate has been held by the same reason (agentIdleHold.ts). */
  private readonly idleHolds = new AgentIdleHoldTracker();
  /** Decides every agent again while one is held from its spec or has deliveries waiting; cleared when none is (`reconcile`). */
  private reconcileSweep: ReturnType<typeof setInterval> | null = null;
  private readonly sessionSpecs: SessionSpecMemory;
  private readonly configRevisions: AgentConfigRevisions;
  private readonly specHandbacks: SpecHandbacks;
  private readonly stallThresholds: StalledWithWorkThresholds;
  private readonly stalledReplacements: StalledReplacementStreaks;
  private readonly exitStreaks: ExitStreaks;

  /** Reconciler step 15: the account an agent's runtime signs in as. */
  private readonly readCredentialAccount: CredentialAccountReader;

  constructor(private readonly deps: OarAgentHostDeps) {
    this.readCredentialAccount = deps.credentialAccountReader ?? createCredentialAccountReader(ambientProcessEnv);
    this.now = deps.now ?? Date.now;
    this.warmRecycle = new WarmRecycleMarks(deps.warmRecycleTimers);
    this.providerLimits = deps.providerLimits ?? new ProviderLimitLedger();
    this.sessionSpecs = deps.sessionSpecs ?? new SessionSpecMemory();
    this.configRevisions = deps.configRevisions ?? new AgentConfigRevisions();
    this.specHandbacks = deps.specHandbacks ?? new SpecHandbacks(() => this.now());
    this.stallThresholds = deps.stalledWithWorkThresholds ?? STALLED_WITH_WORK_THRESHOLDS;
    this.stalledReplacements = deps.stalledReplacements ?? new StalledReplacementStreaks();
    this.exitStreaks = deps.exitStreaks ?? new ExitStreaks();
    this.providerLimits.subscribe((change) => this.onProviderLimitChange(change));
    const backoff = deps.providerLimitBackoff ?? {};
    const baseMs = Math.max(0, Math.floor(backoff.baseMs ?? RUNTIME_ERROR_DELIVERY_BACKOFF_BASE_MS));
    this.providerLimitBackoff = {
      baseMs,
      maxMs: Math.max(baseMs, Math.floor(backoff.maxMs ?? RUNTIME_ERROR_DELIVERY_BACKOFF_MAX_MS)),
      jitterRatio: Math.max(0, Math.min(1, backoff.jitterRatio ?? 0.1)),
      jitterRandom: backoff.jitterRandom ?? Math.random,
    };
    this.openSession = deps.openSession ?? (async (launch) => (await loadOarSessionRuntime(launch.runtimeId)).session(launch.installation, launch.options));
    this.loadObserve = deps.loadObserve ?? loadOarObserve;
    this.prepareLaunch = deps.prepareLaunch ?? ((ctx) => {
      const prepare = OAR_LAUNCHES[ctx.config.runtime || "claude"];
      if (!prepare) throw new Error(`OAR host cannot launch runtime ${ctx.config.runtime}`);
      return prepare(ctx);
    });
    this.standingPromptLedger = new StandingPromptLedger(deps.dataDir, () => this.now());
    this.sessionSummaries = new SessionSummaryStore(deps.sessionSummaryDir ?? sessionSummaryDir(deps.slockHome ?? resolveRaftHome()), (agentId, error) => {
      logger.warn(`[Agent ${agentId}] session summary not written: ${errorMessage(error)}`);
    });
    this.sink = new LegacyActivitySink({
      sendToServer: (msg) => deps.sendToServer(msg),
      nextClientSeq: (agentId) => deps.nextClientSeq(agentId),
      daemonInstanceId: () => deps.daemonInstanceId(),
      recordEvent: (name, attrs, status) => deps.recordEvent(name, attrs, status),
      now: () => this.now(),
    });
  }

  setTracer(tracer: Tracer): void {
    this.tracer = tracer;
  }

  setCliTransportTraceDir(traceDir: string | null): void {
    this.cliTransportTraceDir = traceDir;
  }

  setServerTurnEndedCapable(capable: boolean): void {
    this.serverReadsTurnEnded = capable;
  }

  /** Reconciler step 12: the server counts `model_unsupported` and `runtime_repeated_failure` (SERVER_CAPABILITY_STICKY_FAILURE_REASONS_V1). */
  setServerStickyFailureReasonsCapable(capable: boolean): void {
    this.serverCountsStickyReasons = capable;
  }

  /**
   * Whether this host can run this start; otherwise the legacy host runs it.
   * Each reason is traced by the router (`daemon.agent.host.selected`).
   */
  supports(request: AgentStartRequest): OarHostSupport {
    const { config } = request;
    const runtime = config.runtime || "claude";
    if (!OAR_HOSTED_RUNTIMES.has(runtime)) return { ok: false, reason: `runtime_not_hosted:${runtime}` };
    const platform = this.deps.platform ?? process.platform;
    // On Windows only Codex runs here so far (its launch takes the driver's
    // Windows resolution, oarCodexLaunch.ts); the others keep the driver.
    if (platform === "win32" && runtime !== "codex") return { ok: false, reason: "platform_unsupported" };
    if (runtime === "cursor") {
      const cursor = this.cursorSupport();
      if (!cursor.ok) return cursor;
    }
    // A runtime with no legacy host runs these starts here: its runtime
    // profile notice is not injected (the start's own config carries it again
    // until the notice is acknowledged), a runtime profile wake message is
    // delivered as a message, and a recovery grant is spent at this host's
    // gate (`launch`).
    if (getDriver(runtime).oarOnly) return { ok: true };
    // #oar-raft:#4: the Grok slot also runs other ACP programs (a Devin
    // adapter, an ACP bridge, AiderDesk). Only Grok Build itself, at a version
    // the OAR Grok adapter was checked against, runs here; anything else keeps
    // the driver until it is verified.
    if (runtime === "grok" && !isVerifiedGrokCli(this.deps.detectedRuntimeCliVersion?.("grok"))) return { ok: false, reason: "grok_cli_not_verified" };
    if (config.runtimeProfileControl) return { ok: false, reason: "runtime_profile_control" };
    if (request.wakeMessage && runtimeProfileNotificationFromMessage(request.wakeMessage)) return { ok: false, reason: "runtime_profile_message" };
    // RFC 071: an admitted human start's grant is spent at the legacy host's
    // spawn gate; that start stays on the host whose gate it was admitted for.
    if (request.recoveryGrant) return { ok: false, reason: "recovery_grant" };
    return { ok: true };
  }

  /**
   * #oar-raft:#10: the Cursor-only reasons a start stays on the legacy
   * driver, each traced by the router (`daemon.agent.host.selected`
   * `fallback_reason`) so the OAR share can be counted. The SDK's sign-in is
   * read at the launch (`cursor_sdk_signed_out`): it is async.
   */
  private cursorSupport(): OarHostSupport {
    // Only Linux is checked so far (the SDK's child, its native companion
    // and packaging).
    if ((this.deps.platform ?? process.platform) !== "linux") return { ok: false, reason: "platform_unsupported" };
    if (!(this.deps.cursorSdkAvailable ?? (() => cursorSdkAvailable()))()) return { ok: false, reason: "cursor_sdk_unavailable" };
    return { ok: true };
  }

  /**
   * #oar-raft:#10: the Cursor SDK's sign-in (`cursorSdkSignIn`) for this
   * agent, in the environment its session would get (`cursorAuthEnv`: its
   * env vars over the daemon's, so its own `CURSOR_API_KEY` and HOME count).
   * With neither `CURSOR_API_KEY` nor the SDK's auth file, it is signed out
   * and no child is started for the check. Otherwise OAR's `authStatus`: a
   * one-shot child that loads the SDK (a large bundle with a native
   * companion; the first load can be slow) and asks `Cursor.auth.status()`,
   * which reads the stored login from disk with no network. A failed or late
   * read is `unknown`, never "signed out".
   */
  private async cursorSignIn(request: AgentStartRequest): Promise<"signed_in" | "signed_out" | "unknown"> {
    try {
      const read = this.deps.cursorAuthStatus
        ?? (async (env: Record<string, string>) => {
          if (!cursorSdkCredentialPresent({ env, ...(env.HOME ? { homeDir: env.HOME } : {}) })) return { kind: "logged_out", source: "no CURSOR_API_KEY and no Cursor SDK auth file" } satisfies AuthStatus;
          const runtime = await loadOarRuntime("cursor");
          if (!runtime.authStatus) return { kind: "unknown", detail: "no authStatus" } satisfies AuthStatus;
          return runtime.authStatus({ kind: "available", via: "bundled" }, { timeoutMs: CURSOR_SIGN_IN_READ_MS, env });
        });
      return cursorSdkSignIn(await read(cursorAuthEnv(request.config.envVars)));
    } catch (error) {
      logger.warn(`[Cursor] SDK sign-in status unreadable: ${errorMessage(error)}`);
      return "unknown";
    }
  }

  owns(agentId: string): boolean {
    return this.agents.has(agentId);
  }

  /** A stopped start of the agent is still undoing its launch. */
  isUnwinding(agentId: string): boolean {
    return this.unwinding.has(agentId);
  }

  /**
   * Resolves once no stopped start of the agent is undoing its launch any
   * more (at once if none is), or once `signal` aborts: a start waiting here
   * that is stopped itself does not wait for the unwind.
   */
  unwound(agentId: string, signal?: AbortSignal): Promise<void> {
    const unwinding = this.unwinding.get(agentId);
    if (!unwinding || !signal) return unwinding ?? Promise.resolve();
    if (signal.aborted) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = () => { signal.removeEventListener("abort", done); resolve(); };
      signal.addEventListener("abort", done, { once: true });
      void unwinding.then(done);
    });
  }

  getRunningAgentIds(): string[] {
    return [...this.agents.values()].filter((agent) => agent.committed && !agent.stopping).map((agent) => agent.agentId);
  }

  /**
   * #wg-rbac:#27: the runner credentials this host's launches hold right now,
   * committed or still starting: each launch's own (minted at spawn) and its
   * start's, when another. A stopping launch's are being revoked. Read synchronously.
   */
  getHeldRunnerCredentialIds(): string[] {
    const ids = new Set<string>();
    for (const agent of this.agents.values()) {
      if (agent.stopping) continue;
      for (const config of [agent.launchConfig, agent.request.config]) {
        if (config?.agentCredentialId) ids.add(config.agentCredentialId);
      }
    }
    return [...ids];
  }

  getAgentSessionId(agentId: string): string | null {
    const agent = this.agents.get(agentId);
    return agent?.committed ? this.reportableSessionId(agent, agent.session?.id) : null;
  }

  /**
   * The one place this host reports a session to the server (`agent:session`;
   * also `getAgentSessionId`), as the legacy host's: never one whose config
   * no longer takes it (#13295 residual). After a Codex model or runtime
   * change the server forgets the session; the session still running the old
   * one must not report it back, or the next start resumes it.
   */
  private reportableSessionId(agent: HostedAgent, sessionId: string | null | undefined): string | null {
    if (!sessionId) return null;
    if (agent.startedSpec && sessionDropReason(agent.startedSpec, runtimeSpecOf(agent.request.config)) !== null) return null;
    return sessionId;
  }

  private reportSession(agent: HostedAgent, sessionId: string): void {
    const reportable = this.reportableSessionId(agent, sessionId);
    if (!reportable) return;
    this.deps.sendToServer({ type: "agent:session", agentId: agent.agentId, sessionId: reportable, ...(agent.launchId ? { launchId: agent.launchId } : {}) });
  }

  /** The request takes a pushed config; one naming another runtime waits until the launch is planned (`pushAfterPlan`). */
  private takePushedConfig(agent: HostedAgent, config: AgentConfig): void {
    if (!agent.startedSpec && (config.runtime || "claude") !== agent.runtimeId) {
      agent.pushAfterPlan = config;
      return;
    }
    agent.pushAfterPlan = null;
    agent.request = { ...agent.request, config: withPushedConfig(agent.request.config, config) };
  }

  /**
   * Reconciler step 11 (`agent:config`, ordered by the core): the agent's
   * current config. Its request takes it (keeping the launch's session and
   * runner credential): a launch not yet planned is planned on it (the
   * request is read again before the first input, `launch`); a committed
   * session whose spec drifted is ended once idle (`reconcileSpec`), and,
   * as every spec stop here, never started again by this host: the next
   * delivery finds no agent and the server's start runs on the new config,
   * on the host the router picks.
   *
   * Unlike a rebound start (`rebind`), it carries no launch and no wake, so
   * it never wakes the agent, settles a launch or reports a status: a
   * rebind with a wake keeps the session busy until that wake's turn ends,
   * a push only waits for the current turn (and any held delivery) to end.
   */
  applyConfig(agentId: string, config: AgentConfig, revision: number): void {
    const agent = this.agents.get(agentId);
    if (!agent || agent.stopping) {
      // Not this host's any more: the next start (either host) takes it.
      this.configRevisions.holdPush(agentId, { config, revision });
      return;
    }
    // Kept for the next registration: a start older than it may still start a new session.
    this.configRevisions.holdPush(agentId, { config, revision });
    this.takePushedConfig(agent, config);
    const drift = agent.startedSpec ? runtimeSpecDrift(agent.startedSpec, runtimeSpecOf(agent.request.config)) : [];
    this.deps.recordEvent("daemon.agent.config_push", {
      agentId,
      revision,
      outcome: "applied",
      stage: agent.committed ? "running" : "starting",
      launchId: agent.launchId ?? undefined,
      // Kinds only, never a value.
      drift: drift.join(",") || undefined,
      host: "oar",
    });
    logger.info(`[Agent ${agentId}] Config revision ${revision} applied (OAR${drift.length > 0 ? `; spec drift: ${drift.join(", ")}; ends once idle` : ""})`);
    this.reconcile(agent, "signal");
  }

  getAgentLaunchId(agentId: string): string | null {
    return this.agents.get(agentId)?.launchId ?? null;
  }

  /** For the legacy host's transcript and runtime-profile reads (`HostedAgentSessions`). */
  hostedSession(agentId: string): HostedAgentSession | null {
    const agent = this.agents.get(agentId);
    if (!agent?.committed) return null;
    return {
      config: agent.runtimeConfig ?? agent.request.config,
      sessionId: agent.session?.id ?? null,
      launchId: agent.launchId,
      processInstanceId: agent.processInstanceId,
    };
  }

  hostedAgentIds(): string[] {
    return this.getRunningAgentIds();
  }

  getAgentStartAcceptance(agentId: string): AgentStartAcceptance {
    const agent = this.agents.get(agentId);
    if (agent?.committed) return { queueState: "running", queueDepth: 0, queueAgeMs: 0, processInstanceId: agent.processInstanceId };
    return { queueState: "starting", queueDepth: 0, queueAgeMs: 0 };
  }

  /** The agent is still this host's, and nobody asked it to stop. */
  private isCurrent(agent: HostedAgent): boolean {
    return !agent.stopping && this.agents.get(agent.agentId) === agent;
  }

  private checkpoint(agent: HostedAgent): void {
    if (!this.isCurrent(agent)) throw new LaunchStopped();
  }

  /**
   * Start (or rebind) an agent. Registers it synchronously, so
   * `getAgentStartAcceptance` reads `starting` right after the call.
   */
  start(request: AgentStartRequest): Promise<OarStartOutcome> {
    return this.startHosted(request, null);
  }

  /**
   * `start`, or (reconciler steps 9 and 10b) the host's own restart after an
   * ended session: it starts with the deliveries that session held (`carried`,
   * its first input takes them) and, after a crash, once its backoff is over
   * (`notBeforeMs`).
   */
  private startHosted(request: AgentStartRequest, restart: { carried: Delivery[]; notBeforeMs: number | null; untilLimitReleased?: boolean; sessionNotice?: TrajectoryEntry } | null): Promise<OarStartOutcome> {
    const existing = this.agents.get(request.agentId);
    if (existing) return Promise.resolve(this.rebind(existing, request));
    const runtimeId = request.config.runtime || "claude";
    const agent: HostedAgent = {
      agentId: request.agentId,
      request,
      runtimeId,
      driver: getDriver(runtimeId),
      committed: false,
      stopping: false,
      abort: new AbortController(),
      launchId: request.launchId || null,
      launchIds: request.launchId ? [request.launchId] : [],
      proxyLaunch: null,
      finished: Promise.resolve(),
      birthLaunchId: null,
      processInstanceId: randomUUID(),
      processOpened: false,
      launch: null,
      session: null,
      runtimeConfig: null,
      launchConfig: null,
      credentialReleased: false,
      capabilityWait: null,
      carried: [],
      pending: [],
      delivered: new RecentDeliveryIds(this.deps.takenIdLimit ?? TAKEN_ID_LIMIT, TAKEN_ID_MAX_AGE_MS),
      appNoticedItems: new Map(),
      unsubscribe: [],
      summary: null,
      activity: null,
      classifyTool: null,
      codexActivity: null,
      codexTraces: null,
      heartbeat: null,
      last: { activityKind: "working", detail: "Starting…", detailKind: "starting" },
      flushing: false,
      flushAgain: false,
      deliverSingly: 0,
      turn: { textEvents: 0, toolCalls: 0, runtimeErrors: 0, thinkingEvents: 0 },
      steerHold: { compacting: false, refusals: 0 },
      turnEndCompaction: { arming: new TurnEndCompactionArming(), inFlight: null, lastSkipKey: null },
      catchupBatch: null,
      shownUnreadTargets: [],
      turnEndedReported: false,
      runtimeReadySent: false,
      processExitedSent: false,
      turnStartedAtMs: null,
      providerLimitWait: null,
      credentialInvalidVisibility: null,
      serverFeatures: null,
      startedSpec: null,
      credentialAccount: null,
      credentialAccountChanged: false,
      pushAfterPlan: null,
      openToolCalls: new Set(),
      taskRows: new OarTaskRows(() => this.now()),
      subagentWake: { resultUnread: false, lastTurnAborted: false },
      stallDeadline: null,
      openedAtMs: null,
      modelOutput: false,
      turnOpen: false,
      turnCutByExit: false,
      abortRequested: false,
      lastFailure: null,
      startNotBeforeMs: restart?.notBeforeMs ?? null,
      startWait: restart?.untilLimitReleased ? { untilLimitReleased: true, end: null } : null,
      pastDrainHold: false,
      turnTrace: new OarTurnTrace({ tokensFromTelemetry: runtimeId === "codex", limits: this.deps.turnSpanEventLimits, exitWaitMs: this.deps.turnExitWaitMs }),
      nextTurn: null,
      ...(restart?.sessionNotice ? { sessionNotice: restart.sessionNotice } : {}),
    };
    if (restart) agent.pending.push(...restart.carried);
    this.agents.set(agent.agentId, agent);
    // Reconciler step 11: a config pushed before this start reached the host.
    const held = this.configRevisions.takeHeldPush(agent.agentId);
    if (held?.applies) {
      this.takePushedConfig(agent, held.push.config);
      this.deps.recordEvent("daemon.agent.config_push", { agentId: agent.agentId, revision: held.push.revision, outcome: "applied", stage: "registered", host: "oar" });
    } else if (held) {
      this.deps.recordEvent("daemon.agent.config_push", { agentId: agent.agentId, revision: held.push.revision, outcome: "held_dropped_stale", host: "oar" });
    }
    this.releaseCredentialInvalidForModelChange(agent.agentId, request.config);
    // Reconciler step 12: another runtime or model may work.
    this.exitStreaks.sticky.forgetUnusableModelUnless(agent.agentId, request.config.runtime || runtimeId, request.config.model);
    this.deps.recordEvent("daemon.agent.oar.start_requested", {
      agentId: agent.agentId,
      launchId: agent.launchId ?? undefined,
      runtime: runtimeId,
      session_id_present: Boolean(request.config.sessionId),
    });
    const run = this.runStart(agent);
    agent.finished = run;
    return run;
  }

  private async runStart(agent: HostedAgent): Promise<OarStartOutcome> {
    const startedAt = this.now();
    try {
      await this.launch(agent);
      this.deps.recordEvent("daemon.agent.oar.started", {
        agentId: agent.agentId,
        launchId: agent.launchId ?? undefined,
        runtime: agent.runtimeId,
        launch_ms: this.now() - startedAt,
        resumed: Boolean(agent.launch?.options.resume),
      });
      return { kind: "started" };
    } catch (error) {
      if (error instanceof LaunchStopped || !this.isCurrent(agent)) {
        this.detachStopped(agent);
        await this.abandonLaunch(agent);
        return this.cancelStart(agent);
      }
      const reason = error instanceof HandBack ? error.reason : `error:${errorName(error)}`;
      if (!(error instanceof HandBack)) logger.error(`[Agent ${agent.agentId}] OAR launch failed; handing it to the legacy host: ${errorMessage(error)}`);
      await this.abandonLaunch(agent);
      // A stop that landed while the session was disposed wins: the start is
      // cancelled, never handed to the legacy host (its credential is revoked).
      if (!this.isCurrent(agent)) return this.cancelStart(agent);
      this.revokeLaunchOnlyCredential(agent);
      const cursorResume = this.cursorSdkResumeFailed(agent, error);
      if (cursorResume) return this.startCursorAfterResumeFailure(agent, cursorResume.sessionId, cursorResume.cause);
      this.deps.recordEvent("daemon.agent.oar.fallback", {
        agentId: agent.agentId,
        launchId: agent.launchId ?? undefined,
        runtime: agent.runtimeId,
        reason,
        held_count: agent.pending.length,
        ...(error instanceof HandBack ? {} : { error_message: errorMessage(error).slice(0, 300) }),
        ...(error instanceof HandBack && /^(open|resume)_failed:/.test(reason) ? { open_failure_class: oarOpenFailureClass(error.cause) } : {}),
      }, error instanceof HandBack ? "ok" : "error");
      const held = agent.pending.splice(0).map((delivery) => this.heldDelivery(delivery));
      this.agents.delete(agent.agentId);
      return {
        kind: "fallback",
        reason,
        request: { ...agent.request, launchId: agent.launchId ?? undefined },
        held,
        ...(error instanceof HandBack
          ? {
            ...(error.cause !== undefined ? { cause: error.cause } : {}),
            ...(error.refusal ? { refusal: error.refusal } : {}),
            ...(error.failHere ? { failHere: error.failHere } : {}),
          }
          : { cause: error }),
      };
    }
  }

  /**
   * #oar-raft:#10 (Tenny): a Cursor SDK agent (`agent-<uuid>`) the SDK would
   * not resume. The legacy driver (the Cursor CLI) cannot resume it either,
   * so this is not handed back: a new SDK session starts here instead (row
   * D4). Only when the SDK says the session is gone (OAR's
   * `SessionNotFoundError`, the SDK's `agent_not_found`); any other resume
   * failure fails the start and keeps the session (`failHere`).
   */
  private cursorSdkResumeFailed(agent: HostedAgent, error: unknown): { sessionId: string; cause: string } | null {
    if (agent.runtimeId !== "cursor" || !(error instanceof HandBack) || error.reason !== "resume_failed:SessionNotFoundError") return null;
    const sessionId = agent.launch?.options.resume;
    if (!sessionId || !isCursorSdkSessionId(sessionId)) return null;
    return { sessionId, cause: errorName(error.cause) };
  }

  /**
   * The new session after `cursorSdkResumeFailed`: the same start (its
   * launch, wake and held deliveries) with no session, so its first input is
   * a fresh session's (the standing prompt ahead of it). The server forgets
   * the old session; the new session's Activity Log says why.
   */
  private startCursorAfterResumeFailure(agent: HostedAgent, sessionId: string, cause: string): Promise<OarStartOutcome> {
    const { agentId } = agent;
    const launchId = agent.launchId ?? undefined;
    logger.warn(`[Agent ${agentId}] Cursor SDK session ${sessionId} could not be resumed (${cause}); starting a new session`);
    this.deps.recordEvent("daemon.agent.oar.resume_failed_new_session", { agentId, launchId, runtime: agent.runtimeId, failure: cause }, "error");
    this.deps.sendToServer({ type: "agent:session:invalidate", agentId, sessionId, ...(launchId ? { launchId } : {}), reason: "missing" });
    const carried = agent.pending.splice(0);
    this.agents.delete(agentId);
    return this.startHosted(
      { ...agent.request, launchId, config: { ...agent.request.config, sessionId: null } },
      {
        carried,
        notBeforeMs: null,
        sessionNotice: {
          kind: "system",
          title: "New Cursor session",
          text: `Stored Cursor session ${sessionId} could not be resumed, so this agent started a new Cursor session. Earlier runtime context may not be restored; its memory and Raft history are unchanged.`,
        },
      },
    );
  }

  /**
   * Stopped before any runtime ran: the launches this start took on are
   * cancelled. A launch accepted for the agent after the stop is not this
   * start's: its own start runs it.
   */
  private cancelStart(agent: HostedAgent): OarStartOutcome {
    for (const launchId of agent.launchIds) this.deps.launches.settleNotSpawned(agent.agentId, launchId, "cancelled");
    this.deps.recordEvent("daemon.agent.oar.start_cancelled", { agentId: agent.agentId, launchId: agent.launchId ?? undefined });
    return { kind: "stopped" };
  }

  /**
   * A stopped start no longer holds the agent while it undoes its launch: the
   * next start is a new start (the router may send it to either host), never
   * a rebind onto this one. A new OAR start waits for this unwind first.
   */
  private detachStopped(agent: HostedAgent): void {
    agent.stopping = true;
    if (this.agents.get(agent.agentId) !== agent) return;
    this.agents.delete(agent.agentId);
    this.trackUnwind(agent.agentId, agent.finished);
  }

  /**
   * A launch the agent no longer holds is still being undone (an uncommitted
   * start's unwind, a committed session's dispose): the next start, on either
   * host, and a waiting stop wait for it (`unwound`).
   */
  private trackUnwind(agentId: string, work: Promise<unknown>): void {
    // A start stopped while it waited for an earlier unwind ends before that
    // unwind does: the agent is unwound once both are.
    const earlier = this.unwinding.get(agentId);
    const unwound = Promise.allSettled(earlier ? [earlier, work] : [work]).then(() => {});
    this.unwinding.set(agentId, unwound);
    void unwound.then(() => { if (this.unwinding.get(agentId) === unwound) this.unwinding.delete(agentId); });
  }

  /**
   * Undo an uncommitted launch: no runtime is left, nothing was reported
   * spawned. The runner credential stays (the start's config carries it and
   * the legacy host may run the start with it); a stop revokes it.
   */
  private async abandonLaunch(agent: HostedAgent): Promise<void> {
    agent.capabilityWait?.cancel();
    this.clearProviderLimitWait(agent);
    agent.abort.abort();
    for (const unsubscribe of agent.unsubscribe.splice(0)) unsubscribe();
    const session = agent.session;
    agent.session = null;
    if (session) await this.disposeSession(agent, session, "abandoned_launch");
    // Only this launch's proxies: a start that came after a stop may hold its own.
    if (agent.proxyLaunch) cleanupLaunchProxiesForLaunch(agent.agentId, agent.proxyLaunch.launchId);
    agent.proxyLaunch = null;
    // The carried deliveries were never taken: back to the front.
    agent.pending.unshift(...agent.carried.splice(0));
    if (agent.processOpened && this.deps.gate && this.deps.daemonInstanceId()) {
      this.deps.gate.processNotStarted(agent.agentId, agent.processInstanceId);
    }
    agent.processOpened = false;
    if (agent.stopping) {
      this.revokeCredential(agent);
      this.dropHeld(agent, "stopped_start");
      if (this.agents.get(agent.agentId) === agent) this.agents.delete(agent.agentId);
    }
  }

  private heldDelivery(delivery: Delivery): HeldDelivery {
    const contexts = delivery.contexts;
    const context: AgentDeliveryContext = {
      ...contexts[0],
      onMentionTransition: (stage, outcome) => { for (const each of contexts) each.onMentionTransition?.(stage, outcome); },
      onMentionTerminalError: (code) => { for (const each of contexts) each.onMentionTerminalError?.(code); },
      onMentionAck: () => { for (const each of contexts) each.onMentionAck?.(); },
      onRejectedNoProcess: () => { for (const each of contexts) each.onRejectedNoProcess?.(); },
    };
    return { message: delivery.message, context, settle: (accepted) => delivery.settle(accepted) };
  }

  private async launch(agent: HostedAgent): Promise<void> {
    const { agentId } = agent;
    const workingDirectory = path.join(this.deps.dataDir, agentId);
    // A stopped start of this agent may still be undoing its launch (session,
    // open record, proxies): this one starts after it, unless it is stopped
    // first.
    if (this.isUnwinding(agentId)) {
      await this.unwound(agentId, agent.abort.signal);
      this.checkpoint(agent);
    }
    // Reconciler step 5: nor while a stopped legacy process of the agent is
    // still exiting (bounded by the legacy host's stop grace).
    if (this.deps.legacyRuntimeExited) {
      await this.deps.legacyRuntimeExited(agentId, agent.abort.signal);
      this.checkpoint(agent);
    }
    // #oar-raft:#10: a Computer signed in to the Cursor CLI only keeps the
    // driver, silently (the router traces the reason), before anything ran.
    // An unreadable status never hands back an agent whose session is the
    // SDK's: the driver would drop that session. That start fails here, and
    // the next one reads the status again.
    if (agent.runtimeId === "cursor") {
      const signIn = await this.cursorSignIn(agent.request);
      this.checkpoint(agent);
      if (signIn === "signed_out") throw new HandBack("cursor_sdk_signed_out");
      if (signIn === "unknown") {
        throw new HandBack("cursor_sdk_status_unknown", undefined, isCursorSdkSessionId(agent.request.config.sessionId)
          ? { failHere: CURSOR_SIGN_IN_UNREADABLE_TEXT }
          : undefined);
      }
    }
    // Reconciler step 10b: a restart after a crash waits out the crash
    // streak's backoff here, registered: a server start meanwhile rebinds
    // onto it, a delivery is held for it, a stop cancels it.
    // A provider limit's wait ends with the limit, also when it was released
    // while the ended session was still being undone.
    const limitReleased = agent.startWait?.untilLimitReleased === true && this.activeProviderLimit(agent) === null;
    if (agent.startNotBeforeMs !== null && agent.startNotBeforeMs > this.now() && !limitReleased) {
      await this.restartBackoff(agent, agent.startNotBeforeMs - this.now());
      this.checkpoint(agent);
    }
    // Reconciler step 13: a drain holds the spawn (the start stays
    // registered: a delivery is held for it, a rebind lands on it, a stop
    // cancels it); its end lets it go on. A drain of one agent (step 14)
    // holds no start.
    if (this.drain.holdingStarts) {
      this.deps.recordEvent("daemon.agent.oar.start_held_for_drain", { agentId, launchId: agent.launchId ?? undefined });
      await this.drain.startsReleased(agent.abort.signal);
      this.checkpoint(agent);
    }
    agent.pastDrainHold = true;
    await initializeLaunchWorkspace(workingDirectory, agentId, agent.request.config);
    this.checkpoint(agent);

    // RFC 071: the same gate the legacy spawn passes. Held until this
    // connection's capability is confirmed; a stop cancels the wait.
    const gate = this.deps.daemonInstanceId() ? this.deps.gate : null;
    if (gate) {
      const wait = gate.waitForCapability();
      agent.capabilityWait = wait;
      const confirmed = await wait.confirmed;
      agent.capabilityWait = null;
      this.checkpoint(agent);
      if (!confirmed) throw new LaunchStopped();
      // A refusal is the legacy host's to show (terminal state, kept messages):
      // it decides the same start the same way.
      // An OAR-only runtime has no legacy host to take an admitted human
      // start: its recovery grant is spent at this gate instead.
      const refusal = gate.startRefusal(agentId, agent.launchId, agent.driver.oarOnly ? agent.request.recoveryGrant : null);
      if (refusal) throw new HandBack("start_refused", refusal);
    }

    // A rebind before the first input is built replaces this start's request
    // (`rebind`): the launch is planned on the latest one, read again after
    // the last wait before the first input. A rebind after that adds its
    // launch and its wake (a delivery); its config, unread summary and resume
    // input do not change the launch, as on a legacy start already spawning.
    let request: AgentStartRequest;
    let runtimeConfig: AgentConfig;
    let wakeRecycle: Awaited<ReturnType<typeof planWakeSessionRecycle>>;
    // §6.5: a warm-recycle stop remembered for this agent is taken by this
    // start, whatever it decides (a resume for any other reason forgets it).
    const warmStop = this.warmRecycle.takeStopped(agentId);
    do {
      request = agent.request;
      runtimeConfig = this.withoutSessionStartedOnOtherSpec(agent, withLocalRuntimeContext(request.config, agentId, workingDirectory));
      // RFC 070: at a cold wake with a large prior context, retire the session.
      wakeRecycle = await planWakeSessionRecycle({
        config: runtimeConfig,
        hasResumePrompt: Boolean(request.resumePrompt),
        nowMs: this.now(),
        ...(this.deps.runtimeSessionHomeDir ? { homeDir: this.deps.runtimeSessionHomeDir } : {}),
        // #wg-ax task #3, #proj-runtime:#54: facts and panel from this host's
        // session summary, for Codex and Grok while the Server's
        // `wake_recycle_oar` is on (summaryFactsRuntimesFor).
        readSessionSummary: () => this.sessionSummaries.read(agentId),
        warmStop,
      });
      this.checkpoint(agent);
    } while (agent.request !== request);

    let wakeMessage = request.wakeMessage;
    let resumeMessages = request.resumeMessages;
    // task #26: server context rides ahead of the first input, never as a wake.
    if (wakeMessage && isServerContextMessage(wakeMessage)) {
      this.holdServerContext(agentId, wakeMessage);
      wakeMessage = undefined;
    }
    if (resumeMessages?.some(isServerContextMessage)) {
      for (const message of resumeMessages.filter(isServerContextMessage)) this.holdServerContext(agentId, message);
      resumeMessages = resumeMessages.filter((message) => !isServerContextMessage(message));
    }

    const driver = agent.driver;
    // A warm stop this start resumed anyway (a resume prompt, a runtime-profile
    // control, unknown facts): marking that session again would stop it after
    // every turn end only for the next start to resume it again.
    if (warmStop && wakeRecycle.action === "resume") this.warmRecycle.decline(agentId, warmStop.sessionId);
    if (wakeRecycle.action === "resume") {
      this.deps.recordEvent("daemon.agent.wake_recycle_skipped", {
        agentId,
        runtime: runtimeConfig.runtime ?? "claude",
        reason: wakeRecycle.reason,
        has_session: Boolean(runtimeConfig.sessionId),
        ...(wakeRecycle.thresholds ? recycleThresholdTraceAttrs(wakeRecycle.thresholds) : {}),
        ...(warmStop ? { warm_stop_dropped: true, band: warmStop.band } : {}),
        host: "oar",
      });
    }
    // Reconciler step 8a: the last session rule, from the plan's facts.
    const wakeChoice = chooseSession({ sessionId: runtimeConfig.sessionId, wakeRecycle });
    if (wakeChoice.kind === "new" && wakeChoice.reason === "wake_recycle") {
      runtimeConfig = { ...runtimeConfig, sessionId: null };
      const applied = describeAppliedWakeRecycle(agentId, wakeChoice.recycle);
      const startTriggerKind = messageTurnTriggerAttrs(wakeMessage ? [wakeMessage] : undefined, this.now(), () => undefined).trigger_kind;
      this.deps.recordEvent("daemon.agent.wake_recycle", { ...applied.traceAttrs, ...wakeRecycleKindTraceAttrs(wakeChoice.recycle, typeof startTriggerKind === "string" ? startTriggerKind : undefined), host: "oar" });
      logger.info(`[Agent ${agentId}] ${applied.logLine}`);
      logger.info(describeRecycledWakeLogLine(agentId, wakeChoice.recycle, "oar"));
    }
    agent.runtimeConfig = runtimeConfig;
    agent.startedSpec = runtimeSpecOf(runtimeConfig);
    agent.credentialAccount = this.credentialAccountOf(runtimeConfig);
    if (agent.pushAfterPlan) {
      // Reconciler step 11: planned on its own runtime; the pushed one is now drift.
      agent.request = { ...agent.request, config: withPushedConfig(agent.request.config, agent.pushAfterPlan) };
      agent.pushAfterPlan = null;
    }
    const isResume = Boolean(runtimeConfig.sessionId) || wakeRecycle.action === "recycle";
    const standingPrompt = driver.buildSystemPrompt(runtimeConfig, agentId);
    const stableStandingPrompt = String(driver.buildSystemPrompt(stableStandingPromptConfig(runtimeConfig), agentId));
    const nativeStandingPrompt = Boolean(driver.supportsNativeStandingPrompt);
    const promptHash = standingPromptHash(stableStandingPrompt, { nativeStandingPrompt });
    const standingPromptPlan = planStandingPromptRefresh({
      ledger: this.standingPromptLedger,
      agentId,
      resumeSessionId: runtimeConfig.sessionId ?? null,
      refreshesOnResume: driver.standingPromptRefreshesOnResume === true,
      promptHash,
      nowMs: this.now(),
    });
    // A runtime without a native standing prompt gets it ahead of a fresh
    // session's first input, as on the legacy host (grok has a native one).
    const standingPromptInFirstInput = standingPromptGoesInFirstInput({ nativeStandingPrompt, resumeSessionId: runtimeConfig.sessionId ?? null });

    // The first input, from the legacy host's own ladder. The deliveries it
    // names are taken in the same step, so nothing arriving later is counted
    // as seen by the model.
    const arrived = agent.pending.filter((delivery) => !delivery.rawInput && !delivery.contexts.some((context) => context.transient));
    const planFirstInput = (withMessages: boolean) => planStartupInput({
      driver,
      runtimeConfig,
      isResume,
      standingPromptReachesSession: !runtimeConfig.sessionId || driver.standingPromptRefreshesOnResume === true,
      standingPromptInFirstInput,
      // Without its messages (one input too long with them): they follow as deliveries.
      ...(withMessages ? { wakeMessage, resumeMessages } : {}),
      wakeMessageTransient: request.wakeMessageTransient,
      resumePrompt: request.resumePrompt,
      unreadSummary: request.unreadSummary,
      startingInboxMessages: withMessages ? arrived.map((delivery) => delivery.message) : [],
      projectThreadJoinContexts: this.projector(agentId),
    });
    let startup = planFirstInput(true);
    const carriedMessages = new Set<AgentMessage>(startup.firstInputMessages);
    agent.carried = agent.pending.filter((delivery) => carriedMessages.has(delivery.message));
    agent.pending = agent.pending.filter((delivery) => !carriedMessages.has(delivery.message));
    const memoryBlockConfig = !runtimeConfig.sessionId && wakeRecycle.action !== "recycle" ? resolveStartupMemoryBlockConfig(runtimeConfig.envVars) : null;
    const memoryBlock = memoryBlockConfig?.enabled
      ? await buildStartupMemoryBlock({ workspacePath: workingDirectory, budgetTokens: memoryBlockConfig.budgetTokens })
      : null;
    this.checkpoint(agent);
    // The ladder's input, then the briefing, MEMORY.md and the standing prompt.
    const firstInputOf = (plan: typeof startup) => {
      let { prompt, promptSource } = plan;
      ({ prompt, promptSource } = applyWakeRecycleBriefing(wakeRecycle, prompt, promptSource));
      if (memoryBlock) ({ prompt, promptSource } = applyStartupMemoryBlock(memoryBlock, prompt, promptSource));
      prompt = applyFreshSessionStandingPrompt(standingPromptInFirstInput, standingPrompt, prompt);
      return applyStandingPromptUpdate(standingPromptPlan, stableStandingPrompt, prompt, promptSource);
    };
    let { prompt, promptSource } = firstInputOf(startup);
    // task #13: the ledger records the current prompt only for a session it reached.
    const standingPromptBinding = standingPromptSessionBinding({
      nativeStandingPrompt,
      resumeSessionId: runtimeConfig.sessionId ?? null,
      promptInFirstInput: standingPromptInFirstInput || standingPromptPlan.action === "inject",
    });
    agent.catchupBatch = agent.launchId && request.catchupBatchId
      ? { launchId: agent.launchId, batchId: request.catchupBatchId, renderedRows: startup.resumeCatchupDeliveredAsInput ? startup.resumeCatchupMessages.length : 0 }
      : null;
    agent.shownUnreadTargets = startup.unreadSummaryShown ? renderedUnreadSummaryTargets(request.unreadSummary) : [];

    const effectiveConfig = await this.deps.buildSpawnConfig(agentId, runtimeConfig);
    agent.launchConfig = effectiveConfig;
    this.checkpoint(agent);
    const ctx: SpawnContext = {
      agentId,
      config: effectiveConfig,
      standingPrompt,
      prompt,
      workingDirectory,
      slockCliPath: this.deps.slockCliPath,
      daemonVersion: this.deps.daemonVersion,
      computerVersion: this.deps.computerVersion,
      daemonApiKey: this.deps.daemonApiKey,
      slockHome: this.deps.slockHome,
      launchId: agent.launchId,
      processInstanceId: agent.processInstanceId,
      launchSignal: agent.abort.signal,
      agentAppInbox: this.deps.appInboxForAgent?.(agentId),
      agentCredentialProxyMessageCommitted: (input) => this.deps.contextView?.messageCommitted(agentId, input),
      // The turn span's Raft sends (`runtime_raft_messages_sent_count`), as the legacy host's coordinator hears them.
      agentCredentialProxySendOutcome: (outcome) => agent.turnTrace.noteSendOutcome(outcome.state),
      // The live flag, as this host's wake-up notice reads it.
      agentCredentialProxyInboxItems: () => inboxUpdateRenderOptions(agent.serverFeatures ?? agent.request.config).inboxItems === true,
      cliTransportTraceDir: this.cliTransportTraceDir,
      tracer: this.tracer,
    };
    // RFC 072: this spawn's context id, planned with the driver's compaction declaration.
    ctx.contextGeneration = planSpawnContextGeneration(spawnCliTransportDir(ctx), {
      compaction: driver.session.compaction,
      resumeSessionId: effectiveConfig.sessionId,
    });
    agent.proxyLaunch = { launchId: ctx.launchId ?? null };
    // Bounded whichever way the launch was prepared (a test's deps included).
    const launch = withOarOomPreference(
      withOarRecordRetention(await this.prepareLaunch(ctx)),
      path.join(this.deps.slockHome ?? resolveRaftHome(), "oar-launch"),
      this.deps.platform,
    );
    agent.launch = launch;
    this.checkpoint(agent);
    // task #365: a start claimed against an earlier connection gets no process.
    if (agent.launchId && this.deps.isStaleClaim(agent.request.claimedConnectionEpochId)) throw new HandBack("stale_dispatch");
    // RFC 071: the open record is durable before the process exists.
    if (gate) {
      if (!gate.openProcess(agentId, agent.processInstanceId, agent.launchId)) throw new HandBack("outcome_storage_blocked");
      agent.processOpened = true;
    }

    const resume = launch.options.resume;
    // Loaded before the session opens, so the stall observer can subscribe as
    // soon as it is open (see below). Unavailable: no observer, as before.
    const observe = await this.loadObserve().catch((error: unknown) => {
      logger.warn(`[Agent ${agentId}] OAR stall observer unavailable: ${errorMessage(error)}`);
      return null;
    });
    agent.classifyTool = observe ? (tool, input) => observe.classifyTool(agent.runtimeId, tool, input) : null;
    let session: Session;
    agent.openedAtMs = this.now();
    try {
      session = await this.openSession(launch);
    } catch (error) {
      this.checkpoint(agent);
      // Never a fresh session in place of the one this agent had: the legacy
      // host runs the start, on the same session (or with its own recovery).
      // #oar-raft:#10: a Cursor SDK session the SDK failed to resume for any
      // reason but "not found" (network, service, unknown) stays the agent's:
      // the driver would drop it, so the start fails here and the next one
      // tries again (no invalidate). "Not found" starts a new SDK session
      // (`cursorSdkResumeFailed`).
      const keepSdkSession = agent.runtimeId === "cursor" && isCursorSdkSessionId(resume) && errorName(error) !== "SessionNotFoundError";
      throw new HandBack(`${resume ? "resume_failed" : "open_failed"}:${errorName(error)}`, undefined, {
        cause: error,
        ...(keepSdkSession ? { failHere: `Cursor could not resume this agent's session (${errorName(error)}). The session is kept; retry the agent.` } : {}),
      });
    }
    agent.session = session;
    // Before the first input: OAR's stall observer reads live records only
    // (no replay, unlike the readers `observe` subscribes at the commit), and
    // the first input's turn starts before the commit. Subscribed later, it
    // never sees that turn running, and a silence in it is never reported
    // (row C15). An uncommitted launch's abandon unsubscribes it.
    if (observe) this.observeStalls(agent, session, observe);
    // Reconciler step 5: its runtime is recorded for the orphan sweep (OAR keeps the pid to itself).
    this.deps.runtimeProcesses?.opened(agent.agentId, agent.launchId);
    this.checkpoint(agent);
    if (launch.firstInputReady) {
      const ready = await launch.firstInputReady(session, agent.abort.signal);
      this.deps.recordEvent("daemon.agent.oar.first_input_ready", {
        agentId,
        launchId: agent.launchId ?? undefined,
        runtime: launch.runtimeId,
        waited_for: ready.waitedFor,
        outcome: ready.outcome,
        waited_ms: ready.waitedMs,
      }, ready.outcome === "ready" || ready.outcome === "stopped" ? "ok" : "error");
      this.checkpoint(agent);
    }

    const commitPromptHash = standingPromptRecordForReportedSession(standingPromptBinding, session.id, promptHash).promptHash;
    let acceptedMessages = wakeMessage
      ? [wakeMessage]
      : startup.resumeCatchupInputMessages.length > 0 ? startup.resumeCatchupInputMessages : startup.startingInboxMessages;
    // The first input's turn span, as the legacy host's `spawn` turn: catch-up
    // messages ride along with a restart; they did not trigger it.
    let firstTurn = this.turnStartFor("spawn", acceptedMessages, new Map(), wakeMessage ? {} : { trigger_kind: "other" });
    const hold = this.deliveryHold(agent);
    if (hold) {
      // #proj-raft-computer:#46: the credential is at its provider limit, or
      // invalid. The session runs and is reported as any other; its first
      // input (a turn) is held like any delivery, until the limit ends or the
      // hold is released.
      this.deps.recordEvent("daemon.agent.oar.first_input", {
        agentId,
        launchId: agent.launchId ?? undefined,
        source: promptSource,
        carried_deliveries: agent.carried.length,
        ...this.holdTraceAttrs(hold),
      });
      this.commit(agent, session, commitPromptHash, startup.renderedStartupThreadContextMessages, startup.startupBodyMessages, acceptedMessages, firstTurn, String(prompt));
      return;
    }
    const serverContext = this.pendingServerContext(agentId, session.id);
    const firstInput = async (withoutMessages: boolean) => {
      const outcome = await session.prompt(serverContext ? `${formatServerContextPrefix(serverContext.body)}${prompt}` : String(prompt), { origin: DELIVERY_ORIGIN });
      this.deps.recordEvent("daemon.agent.oar.first_input", {
        agentId,
        launchId: agent.launchId ?? undefined,
        source: promptSource,
        carried_deliveries: agent.carried.length,
        outcome: outcome.kind,
        ...(outcome.kind === "rejected" ? { code: outcome.code, ...(outcome.failure ? { oar_failure: outcome.failure } : {}) } : {}),
        ...(withoutMessages ? { without_messages: true } : {}),
      }, outcome.kind === "rejected" ? "error" : "ok");
      this.checkpoint(agent);
      return outcome;
    };
    let outcome = await firstInput(false);
    // OAR refused it as one input too long (Antigravity's bound; decided by
    // its `failure`). Never the older driver, which would cut it without
    // saying so: the session starts on the input without its messages, and
    // they follow as deliveries one at a time, where one too long on its own
    // is refused with Raft's hint (`publishMessageTooLarge`).
    const tooLong = (rejected: typeof outcome) => rejected.kind === "rejected" && rejected.failure === "input_too_large";
    const carriedDeliveryMessages = new Set(agent.carried.map((delivery) => delivery.message));
    const deferred = tooLong(outcome) ? acceptedMessages.filter((message) => !carriedDeliveryMessages.has(message)) : [];
    if (tooLong(outcome) && (deferred.length > 0 || agent.carried.length > 0)) {
      startup = planFirstInput(false);
      ({ prompt, promptSource } = firstInputOf(startup));
      outcome = await firstInput(true);
      if (outcome.kind === "accepted") {
        const wakeContext = { ...(request.wakeMessageTransient ? { transient: true } : {}) };
        const carriedCount = agent.carried.length;
        agent.pending = [
          ...deferred.map((message) => this.newDelivery(message, [message === wakeMessage ? wakeContext : {}])),
          ...agent.carried.splice(0),
          ...agent.pending,
        ];
        agent.deliverSingly = deferred.length + carriedCount;
        agent.catchupBatch = null;
        agent.shownUnreadTargets = startup.unreadSummaryShown ? renderedUnreadSummaryTargets(request.unreadSummary) : [];
        acceptedMessages = [];
        firstTurn = this.turnStartFor("spawn", [], new Map(), { trigger_kind: "other" });
      }
    }
    if (tooLong(outcome)) {
      // Too long without any message: the startup input itself (standing prompt, MEMORY.md).
      throw new HandBack("first_input_rejected:input_too_large", undefined, { failHere: formatRuntimeStartupInputTooLargeMessage(agent.runtimeId) });
    }
    if (outcome.kind === "rejected") throw new HandBack(`first_input_rejected:${outcome.code}`);
    serverContext?.writtenTo.add(session.id);

    this.commit(agent, session, commitPromptHash, startup.renderedStartupThreadContextMessages, startup.startupBodyMessages, acceptedMessages, firstTurn);
  }

  /**
   * The first input was taken, or is held (`heldFirstInput`, a provider
   * limit): from here the agent runs on OAR. A held first input is the first
   * held delivery; what its taking means (the deliveries it names taken, the
   * standing prompt and thread context reached the session) happens when
   * the runtime takes it.
   */
  private commit(
    agent: HostedAgent,
    session: Session,
    promptHash: string,
    renderedThreadContext: readonly AgentMessage[],
    bodies: readonly AgentMessage[],
    acceptedMessages: readonly AgentMessage[],
    firstTurn: OarTurnStart,
    heldFirstInput?: string,
  ): void {
    const { agentId } = agent;
    agent.committed = true;
    agent.birthLaunchId = agent.launchId;
    this.sendProcessSpawned(agent);
    this.sendStatus(agent, "active");
    // The old session is forgotten before the new one is reported.
    this.reportCursorSessionMigrated(agent);
    this.reportSession(agent, session.id);
    const hosted = this.hostedSession(agentId);
    if (hosted) this.deps.sendRuntimeProfileReport?.(agentId, hosted, "session_init");
    this.reportContextViewSession(agent);
    const firstInputTaken = () => {
      this.recordStandingPrompt(agentId, session.id, promptHash);
      this.noteRendered(agentId, renderedThreadContext);
      const thirdPartyEventIds = thirdPartyEventIdsFromEvents(bodies);
      if (thirdPartyEventIds.length > 0) reportThirdPartyEventsDelivered(agentId, thirdPartyEventIds);
      const ordinary = acceptedMessages.filter((message) => !runtimeProfileNotificationFromMessage(message));
      if (ordinary.length > 0) this.publishMessageReceived(agent, ordinary, true);
      for (const delivery of agent.carried.splice(0)) this.accept(agent, delivery);
    };
    if (heldFirstInput === undefined) {
      // Its turn started before the commit; `observe` replays that `turn_started`.
      agent.nextTurn = firstTurn;
      this.publish(agent, "working", "Starting…", "starting");
      firstInputTaken();
    } else {
      // The session is open and idle: ready, with nothing running yet.
      this.sendRuntimeReady(agent, false);
      this.publish(agent, "online", "Idle", "idle");
      const message: AgentMessage = {
        channel_id: "first-input",
        channel_name: "first-input",
        channel_type: "dm",
        sender_id: "system",
        sender_name: "system",
        sender_type: "system",
        content: "",
        timestamp: new Date(this.now()).toISOString(),
      };
      const first = this.newDelivery(message, [{}], { rawInput: heldFirstInput, firstInput: true, onAccepted: firstInputTaken, turnStart: firstTurn });
      // Not taken after all (refused, or the session ended): the deliveries it names go with it.
      void first.settled.then((accepted) => {
        if (!accepted) for (const delivery of agent.carried.splice(0)) delivery.settle(false);
      });
      agent.pending.unshift(first);
      this.reportHeld(agent.carried);
    }
    this.observe(agent, session);
    void this.flushPending(agent, session);
  }

  private reportContextViewSession(agent: HostedAgent): void {
    const hosted = this.hostedSession(agent.agentId);
    if (!hosted) return;
    this.deps.contextView?.sessionStarted(agent.agentId, hosted, agent.serverFeatures?.agentContextView ?? agent.request.config.agentContextView === true);
  }

  /**
   * A start for an agent this host already starts or runs. Running: the
   * session carries the new launch (RFC 071 `rebound`), as a legacy process
   * would. Starting: the launch in progress carries it; its
   * `process_spawned` names both launches.
   */
  private rebind(agent: HostedAgent, request: AgentStartRequest): OarStartOutcome {
    const { agentId } = agent;
    const launchId = request.launchId || null;
    this.deps.recordEvent("daemon.agent.oar.start_rebound", {
      agentId,
      launchId: launchId ?? undefined,
      previous_launch_id: agent.launchId ?? undefined,
      committed: agent.committed,
    });
    // #wg-rbac:#27: the launch keeps the runner credential it holds (the one
    // it was planned with, else its start's); the one this start brought, if
    // another, is revoked now, also when the rebind is refused below.
    // Reconciler step 11: a start older than a config already applied keeps
    // the request's config (the newer one); its launch and wake rebind as usual.
    const staleConfig = this.configRevisions.isStaleStart(request.config);
    const carried = this.carryRunnerCredential(agent, request);
    const config = staleConfig ? agent.request.config : carried;
    if (staleConfig) {
      this.deps.recordEvent("daemon.agent.config_push", { agentId, outcome: "stale_start_config_kept", launchId: launchId ?? undefined, host: "oar" });
    }
    if (!agent.committed) {
      // The start's own wake stays its wake (no inbox holds it); this start's
      // wake is a delivery below, as on a running session, unless it is that
      // same wake (the legacy host's `rebindWake` check).
      const ownWake = agent.request.wakeMessage;
      agent.request = { ...request, config, wakeMessage: ownWake, wakeMessageTransient: agent.request.wakeMessageTransient };
      agent.launchId = launchId || agent.launchId;
      if (launchId && !agent.launchIds.includes(launchId)) agent.launchIds.push(launchId);
      if (request.wakeMessage && !sameWakeMessage(ownWake, request.wakeMessage)) {
        void this.deliverMessage(agentId, request.wakeMessage, { transient: request.wakeMessageTransient });
      }
      return { kind: "rebound" };
    }
    const gate = this.deps.daemonInstanceId() ? this.deps.gate : null;
    const refusal = gate?.startRefusal(agentId, launchId, request.recoveryGrant) ?? null;
    if (refusal) {
      logger.warn(`[Agent ${agentId}] ${refusal.detail}`);
      this.deps.recordEvent("daemon.agent.start.refused", { agentId, launchId: launchId ?? undefined, stage: "rebind", reason: refusal.reason, host: "oar" }, "error");
      if (launchId) this.deps.launches.settleNotSpawned(agentId, launchId, refusal.reason);
      if (request.wakeMessage) void this.deliverMessage(agentId, request.wakeMessage, { transient: request.wakeMessageTransient });
      return { kind: "rebound" };
    }
    if (gate && !gate.openProcess(agentId, agent.processInstanceId, agent.launchId || launchId)) {
      this.deps.recordEvent("daemon.agent.start.refused", { agentId, launchId: launchId ?? undefined, stage: "rebind", reason: "terminal_failure_outcome_storage_blocked", host: "oar" }, "error");
      if (launchId) this.deps.launches.settleNotSpawned(agentId, launchId, "terminal_failure_outcome_storage_blocked");
      if (request.wakeMessage) void this.deliverMessage(agentId, request.wakeMessage, { transient: request.wakeMessageTransient });
      return { kind: "rebound" };
    }
    agent.launchId = launchId || agent.launchId;
    agent.request = { ...request, config };
    if (launchId) this.deps.launches.settleRebound(agentId, launchId, agent.processInstanceId);
    this.sendStatus(agent, "active");
    if (agent.runtimeReadySent) this.sendRuntimeReady(agent, true);
    if (agent.session) this.reportSession(agent, agent.session.id);
    this.reportContextViewSession(agent);
    if (request.wakeMessage) void this.deliverMessage(agentId, request.wakeMessage, { transient: request.wakeMessageTransient });
    // Reconciler step 7: the rebound config is the spec the session should
    // run with. Decided after its wake is held, which keeps it busy: the
    // session ends at the end of the turn that wake starts.
    this.reconcile(agent, "signal");
    return { kind: "rebound" };
  }

  /**
   * Only the fact (row C15): held deliveries make the stall a question for
   * reconcile (reconciler step 9), at its stall deadline.
   */
  private observeStalls(agent: HostedAgent, session: Session, observe: OarObserve): void {
    agent.unsubscribe.push(observe.observeStalls(session, {
      stallAfterMs: this.stallThresholds.stallMs,
      onStall: (info) => {
        if (this.isCurrent(agent) && agent.session === session) this.publish(agent, "error", `No runtime output for ${Math.round(info.silentForMs / 60_000)} min`, "runtime_stalled");
      },
    }));
  }

  private observe(agent: HostedAgent, session: Session): void {
    // Replays everything since the session opened (the first input's turn
    // started before the commit), then continues live.
    const summary = new SessionSummaryRecorder(
      this.sessionSummaries,
      agent.agentId,
      agent.runtimeId,
      session.id,
      path.join(this.deps.dataDir, agent.agentId),
      () => this.now(),
    );
    agent.summary = summary;
    agent.unsubscribe.push(session.rawEvents((record) => summary.observe(record), { sessionId: session.id, afterSeq: -1 }));
    // Subscribed before the events: a record's frame is read before its events arrive (oarCodexActivity.ts).
    const codex = agent.runtimeId === "codex" ? new CodexActivityReader(session.id) : null;
    agent.codexActivity = codex;
    agent.activity = new OarActivityProjector(codex ?? undefined, agent.classifyTool ?? undefined);
    agent.codexTraces = null;
    if (codex) {
      const traces = new CodexSessionTraces({
        developerInstructions: agent.launch?.options.appendSystemPrompt,
        resumed: agent.launch?.options.resume !== undefined,
        managedMcpServerName: agent.launch?.managedMcpServerName ?? null,
      }, (name, attrs) => this.recordCodexTrace(agent, session, name, attrs));
      agent.codexTraces = traces;
      traces.opened();
      agent.unsubscribe.push(session.rawEvents((record) => {
        if (this.isCurrent(agent) && agent.session === session) traces.observeRecord(record);
        const telemetry = codex.telemetry(record);
        if (telemetry && this.isCurrent(agent) && agent.session === session) this.recordRuntimeTelemetry(agent, session, telemetry);
        const diagnostics = codex.observe(record);
        if (diagnostics.length > 0 && this.isCurrent(agent) && agent.session === session) for (const diagnostic of diagnostics) this.publishDiagnostic(agent, diagnostic);
      }, { sessionId: session.id, afterSeq: -1 }));
    }
    // A Stop on a launch that ends the turn's processes (Codex, Grok:
    // `endTurnProcessesOnAbort`) is complete only when OAR answers the abort
    // request with its `cleanup` response, not at the accepted abort or the
    // turn's end: traced then, with what OAR ended.
    if (agent.launch?.options.endTurnProcessesOnAbort === true) {
      const aborts = new Set<string>();
      agent.unsubscribe.push(session.rawEvents((record) => {
        if (record.kind === "request") {
          if (record.direction === "toRuntime" && record.body.kind === "abort") aborts.add(record.id);
          return;
        }
        if (record.kind !== "response" || record.body.kind !== "cleanup" || !aborts.delete(record.requestId)) return;
        if (!this.isCurrent(agent) || agent.session !== session) return;
        const cleanup = record.body.result;
        this.deps.recordEvent("daemon.agent.turn_interrupt.cleanup", {
          agentId: agent.agentId,
          launchId: agent.launchId ?? undefined,
          runtime: agent.runtimeId,
          host: "oar",
          outcome: cleanup.kind,
          signalled: cleanup.signalled,
        }, cleanup.kind === "completed" ? "ok" : "error");
      }, { sessionId: session.id, afterSeq: -1 }));
    }
    agent.unsubscribe.push(session.events((event) => this.onEvent(agent, session, event), {
      cursor: { sessionId: session.id, afterSeq: -1 },
      coalesceText: { maxHoldMs: TEXT_COALESCE_MS },
    }));
    agent.heartbeat = setInterval(() => {
      if (!this.isCurrent(agent) || session.status().value.kind !== "running") return;
      this.sink.publishHeartbeat({ agentId: agent.agentId, ...agent.last, launchId: agent.launchId ?? undefined }, this.producer(agent));
    }, HEARTBEAT_INTERVAL_MS);
    agent.heartbeat.unref?.();
  }

  private onEvent(agent: HostedAgent, session: Session, event: Event): void {
    // A stopped or replaced launch never speaks for the agent again.
    if (!this.isCurrent(agent) || agent.session !== session) return;
    // A task's events come from wherever the runtime reports them: Grok on the parent, Qwen and Qoder on the sub-agent.
    this.publishTaskRow(agent, event);
    // Sub-agents (and grok's child sessions, which carry their own session id) stay in OAR's stream.
    if (event.agentPath.length > 0 || event.sessionId !== session.id) return;
    if (!agent.runtimeReadySent && event.kind !== "turn_started" && event.kind !== "turn_active" && event.kind !== "user_message") {
      this.sendRuntimeReady(agent, false);
    }
    if (event.kind === "turn_started") agent.turnStartedAtMs = event.receivedAt;
    if (event.kind === "text_delta" && event.text) agent.turn.textEvents += 1;
    if (event.kind === "tool_call_started") agent.turn.toolCalls += 1;
    if (event.kind === "reasoning") agent.turn.thinkingEvents += 1;
    if ((event.kind === "text_delta" && event.text) || event.kind === "tool_call_started") this.releaseProviderLimitOnModelOutput(agent, event.kind);
    // Reconciler step 9: open tool calls, and model output or a turn end ends
    // the stalled-replacement streak (as the legacy host's text, thinking and
    // tool calls do).
    if (event.kind === "turn_started" || event.kind === "turn_ended") agent.openToolCalls.clear();
    if (event.kind === "tool_call_started") agent.openToolCalls.add(event.callId);
    if (event.kind === "tool_call_ended") agent.openToolCalls.delete(event.callId);
    if ((event.kind === "text_delta" && event.text) || event.kind === "reasoning" || event.kind === "tool_call_started" || event.kind === "turn_ended") {
      this.stalledReplacements.delete(agent.agentId);
    }
    // Reconciler step 10b: the exit's facts. A turn start is the legacy
    // host's delivery: it clears the live runtime error.
    if (event.kind === "turn_started") {
      agent.turnOpen = true;
      agent.turnCutByExit = false;
      agent.lastFailure = null;
    }
    if ((event.kind === "text_delta" && event.text) || event.kind === "reasoning" || event.kind === "tool_call_started") this.noteModelOutput(agent, event.kind);
    if (event.kind === "retry") {
      this.deps.recordEvent("daemon.agent.provider_reconnect", {
        agentId: agent.agentId,
        launchId: agent.launchId ?? undefined,
        runtime: agent.runtimeId,
        model: (agent.runtimeConfig ?? agent.request.config).model,
        host: "oar",
        attempt: event.attempt,
      });
    }
    agent.codexTraces?.observeEvent(event.kind);
    if (event.kind === "compaction_started") agent.steerHold.compacting = true;
    if (event.kind === "compaction_ended") agent.steerHold.compacting = false;
    // A held delivery steers at the next tool start or compaction end, not
    // only at the turn end; not while it would only be held again.
    if ((event.kind === "tool_call_started" || event.kind === "compaction_ended") && agent.pending.length > 0 && agent.launch?.busyDelivery === "now" && !this.steerHeldReason(agent)) {
      void this.flushPending(agent, session);
    }
    const facts = agent.activity?.facts(event) ?? [];
    this.traceTurnEvent(agent, session, event, oarTraceCounterKinds(facts));
    for (const fact of facts) this.publish(agent, fact.activityKind, fact.detail, fact.detailKind, fact.entries);
    // Progress with deliveries waiting and no deadline armed (the last
    // decision found nothing to wait for: an open tool, a hold, no turn): the
    // earliest it could be stalled is the stall threshold from now.
    if (agent.pending.length > 0 && agent.stallDeadline === null) this.armStallDeadline(agent, session, this.stallThresholds.stallMs);
    if (event.kind === "turn_ended") this.onTurnEnded(agent, session, event.outcome, event.seq);
    if (event.kind === "exited") this.onExited(agent, session, event.code);
  }

  private recordCodexTrace(agent: HostedAgent, session: Session, name: string, attrs: Record<string, unknown>): void {
    const runtimeContext = (agent.runtimeConfig ?? agent.request.config).runtimeContext;
    this.deps.recordEvent(name, {
      // The legacy driver's names and sources: the shape event's attribute contract keeps no others.
      agent_id: agent.agentId,
      server_id: runtimeContext?.serverId,
      machine_id: runtimeContext?.machineId,
      launch_id: agent.launchId ?? undefined,
      process_instance_id: agent.processInstanceId,
      runtime_version: runtimeContext?.daemonVersion,
      runtime: agent.runtimeId,
      host: "oar",
      session_id: session.id,
      session_id_present: true,
      ...runtimeTelemetryVersionAttrs(this.deps.daemonVersion, this.deps.computerVersion),
      ...attrs,
    });
  }

  /** The legacy host's `daemon.runtime.telemetry.*`: trace only, nothing reads it to decide anything. */
  private recordRuntimeTelemetry(agent: HostedAgent, session: Session, event: Extract<ParsedEvent, { kind: "telemetry" }>): void {
    // On the turn span as the legacy host adds it (its tokens are the turn's `input_tokens` ...).
    agent.turnTrace.noteTelemetry(event, {
      ...sanitizeRuntimeTelemetryPayloadAttrs(event.attrs),
      ...runtimeTelemetryVersionAttrs(this.deps.daemonVersion, this.deps.computerVersion),
      ...(event.source ? { source: event.source } : {}),
      ...(event.usageKind ? { usageKind: event.usageKind } : {}),
      sessionId: session.id,
      ...(event.turnId ? { turnId: event.turnId } : {}),
    });
    this.deps.recordEvent(`daemon.runtime.telemetry.${event.name}`, {
      agentId: agent.agentId,
      launchId: agent.launchId ?? undefined,
      runtime: agent.runtimeId,
      model: (agent.runtimeConfig ?? agent.request.config).model,
      host: "oar",
      telemetry_name: event.name,
      ...sanitizeRuntimeTelemetryPayloadAttrs(event.attrs),
      ...runtimeTelemetryVersionAttrs(this.deps.daemonVersion, this.deps.computerVersion),
      ...(event.source ? { source: event.source } : {}),
      ...(event.usageKind ? { usageKind: event.usageKind } : {}),
      ...(event.turnId ? { turnId: event.turnId } : {}),
      sessionId: session.id,
    });
  }

  /** A turn that ended with text the user saw, but no tool call and so no Raft send (`runtime.turn.communication_gap`). */
  private recordCommunicationGap(agent: HostedAgent): void {
    if (!agent.codexActivity) return;
    const attrs = codexCommunicationGapAttrs("codex", {
      textEvents: agent.codexActivity.turnShowedText ? agent.turn.textEvents : 0,
      toolCalls: agent.turn.toolCalls,
      // A send is a tool call here: the agent's raft CLI runs in its shell.
      raftMessageSendAttempts: 0,
      thinkingEvents: agent.turn.thinkingEvents,
    });
    if (!attrs) return;
    agent.turnTrace.event("runtime.turn.communication_gap", attrs);
    this.deps.recordEvent("daemon.runtime.turn.communication_gap", { ...this.identityTraceAttrs(agent, agent.session?.id), ...attrs });
  }

  /** The legacy host's identity attrs (its `processLifecycleIdentityAttrs`), so one query finds both hosts' rows. */
  private identityTraceAttrs(agent: HostedAgent, sessionId: string | undefined): Record<string, unknown> {
    const runtimeContext = (agent.runtimeConfig ?? agent.request.config).runtimeContext;
    return {
      agent_id: agent.agentId,
      server_id: runtimeContext?.serverId,
      machine_id: runtimeContext?.machineId,
      launch_id: agent.launchId ?? undefined,
      process_instance_id: agent.processInstanceId,
      session_id: sessionId,
      session_id_present: Boolean(sessionId),
      runtime: agent.runtimeId,
      host: "oar",
    };
  }

  /**
   * The turn span (oarTurnTrace.ts), for one root event: a prompt's
   * `turn_started` opens it with what the input handed over said; model work
   * with no turn running opens one too (the runtime started a turn itself: a
   * codex goal continuation, a queued input's turn), as on the legacy host,
   * and ends a cut turn's span still waiting for its exit as interrupted
   * first, so that turn is never folded into the cut one. Every root event
   * is counted as the legacy driver's events it stands for.
   */
  private traceTurnEvent(agent: HostedAgent, session: Session, event: Event, kinds: ReturnType<typeof oarTraceCounterKinds>): void {
    const trace = agent.turnTrace;
    if (event.kind === "turn_started") {
      const start = agent.nextTurn ?? { reason: "prompt", attrs: { trigger_kind: "other" } };
      agent.nextTurn = null;
      trace.start(this.tracer, this.turnSpanAttrs(agent, session), start, event.requestId);
    } else if (!trace.turnRunning && isOarModelWork(kinds)) {
      trace.start(this.tracer, this.turnSpanAttrs(agent, session), { reason: "runtime-progress", attrs: { trigger_kind: "other" } }, null);
    }
    trace.note(event, kinds);
    if (event.kind === "usage") trace.noteUsage(event.usage.tokens);
    if (event.kind === "control_rejected" && event.action === "prompt") trace.promptRejected(event.requestId, event.code, event.reason);
  }

  /** The legacy host's turn span start attributes, where they apply to an OAR session. */
  private turnSpanAttrs(agent: HostedAgent, session: Session): Record<string, unknown> {
    const config = agent.runtimeConfig ?? agent.request.config;
    const installation = agent.launch?.installation;
    return {
      agentId: agent.agentId,
      runtime: agent.runtimeId,
      model: config.model,
      // A bundled runtime is the version the daemon pins; only a machine-installed CLI reports its own.
      runtime_cli_version: installation?.via === "executable" ? installation.version : undefined,
      hasSession: Boolean(session.id),
      ...this.identityTraceAttrs(agent, session.id),
      runtime_version: config.runtimeContext?.daemonVersion,
    };
  }

  /** What a turn started by `messages` (or a pre-rendered input: `attrs` names its trigger) puts on its span. */
  private turnStartFor(
    reason: string,
    messages: readonly AgentMessage[] | undefined,
    deliveries: ReadonlyMap<AgentMessage, Delivery>,
    attrs: Record<string, unknown> = {},
  ): OarTurnStart {
    return {
      reason,
      attrs: {
        ...messagesTraceAttrs(messages, (message) => deliveries.get(message)?.contexts.find((context) => context.deliveryId)?.deliveryId),
        // A caller that knows the trigger better passes trigger_kind (the legacy host's rule).
        ...(attrs.trigger_kind === undefined ? messageTurnTriggerAttrs(messages, this.now(), (message) => deliveries.get(message)?.receivedAtMs) : {}),
        ...attrs,
      },
    };
  }

  /**
   * The turn span's end at the turn's end. A turn the process's end cut short
   * waits for the exit (`onExited`), whose outcome it takes, as on the legacy
   * host; a release ends it if no exit comes.
   */
  private endTurnTrace(agent: HostedAgent, outcome: TurnOutcome, seq: number): void {
    const trace = agent.turnTrace;
    // The turn's own token counts go on its summary (agent usage,
    // #proj-o11y:42f2af5c), as on the legacy host.
    this.turnSummaries.noteTokens(agent.agentId, activityTurnTokensFrom(trace.runtimeTraceCounters.tokens, (agent.runtimeConfig ?? agent.request.config).model));
    trace.event("runtime.turn.completed", { turn_outcome: outcome.kind });
    if (agent.turnCutByExit) {
      trace.awaitExit();
      return;
    }
    if (outcome.kind === "completed") {
      trace.endAtTurnEnd("ok", { outcome: "turn-completed" }, seq);
    } else if (outcome.kind === "aborted") {
      trace.endAtTurnEnd("cancelled", { outcome: "turn-interrupted" }, seq);
    } else {
      const { diagnostic, failure } = classifiedFailure(outcome);
      // The class and fingerprint of the turn's own cause (OAR's reason
      // carries Codex's last error), as the legacy host's turn span.
      trace.endAtTurnEnd("error", { outcome: "runtime-error", oar_failure: failure, runtime_error_class: diagnostic.errorClass, runtime_error_fingerprint: diagnostic.fingerprint }, seq);
    }
  }

  /**
   * A launch released with its turn span still open (a stop, a stalled
   * session replaced, a crash): the span ends with it, so none outlives its
   * launch or a restart.
   */
  private endTurnTraceOnRelease(agent: HostedAgent, reason: string): void {
    const trace = agent.turnTrace;
    // A turn that already ended keeps its own outcome; it ends now rather than
    // on the next tick, after the launch is gone (and after stopAll returned).
    trace.flushPendingEnd();
    if (!trace.open) return;
    if (reason === "stalled_recovery") {
      trace.end("error", { outcome: "runtime-stalled", exit_reason: reason, runtime_exit_before_turn_boundary: true });
    } else if (OAR_STOP_REASONS.has(reason)) {
      trace.end("cancelled", { outcome: "process-exit", expectedTerminationReason: reason, runtime_exit_before_turn_boundary: true });
    } else if (reason === "terminal_runtime_error") {
      trace.end("error", { outcome: "runtime-error", exit_reason: reason, runtime_exit_before_turn_boundary: true });
    } else {
      trace.end("error", { outcome: "process-crash", exit_reason: reason, runtime_exit_before_turn_boundary: true });
    }
  }

  private onTurnEnded(agent: HostedAgent, session: Session, outcome: TurnOutcome, seq: number): void {
    // Reconciler step 10b: whether the process's end cut this turn short
    // (the exit's turn boundary), and a completed turn that did something
    // ends the crash streaks (the legacy host's turn end with no runtime
    // error). A completed turn with no output is not progress: D6 counts it.
    agent.turnOpen = false;
    agent.turnCutByExit = (outcome.kind === "failed" && outcome.failure === "runtime_exited") || (outcome.kind === "aborted" && !agent.abortRequested);
    agent.abortRequested = false;
    // The turn that just ended had any waiting sub-agent results in its input.
    agent.subagentWake = { resultUnread: false, lastTurnAborted: outcome.kind === "aborted" };
    if (outcome.kind === "completed" && agent.turn.textEvents + agent.turn.toolCalls > 0) {
      this.endExitStreaks(agent, "runtime_progress:turn_end");
      // Reconciler step 12: a turn of the session completed; it fits.
      this.exitStreaks.sticky.endSessionReset(agent.agentId);
    }
    let turnEnded: AgentTurnEndedOutcome;
    let terminal = false;
    if (outcome.kind === "failed") {
      agent.turn.runtimeErrors += 1;
      turnEnded = "failed";
      // Ended before the failure is acted on: that may end the session.
      this.endTurnTrace(agent, outcome, seq);
      terminal = this.onFailedTurn(agent, outcome);
    } else {
      turnEnded = outcome.kind === "aborted" ? "interrupted" : "completed";
      const blank = outcome.kind === "completed" ? agent.codexActivity?.blankFinalAnswer() : null;
      if (blank) this.publishDiagnostic(agent, blank);
      if (outcome.kind === "completed") this.recordCommunicationGap(agent);
      this.endTurnTrace(agent, outcome, seq);
      this.publish(agent, "online", "Idle", "idle");
    }
    // RFC 071 §4.4 E2: a clean turn with model output is recovery evidence.
    if (outcome.kind === "completed" && agent.turn.runtimeErrors === 0 && agent.turn.textEvents + agent.turn.toolCalls > 0) {
      const batch = agent.catchupBatch && agent.catchupBatch.launchId === agent.launchId ? agent.catchupBatch : null;
      this.sendRuntimeOutcome(agent, {
        kind: "turn_completed",
        textEvents: agent.turn.textEvents,
        toolCalls: agent.turn.toolCalls,
        ...(batch && batch.renderedRows > 0 ? { catchupBatchId: batch.batchId, catchupRenderedRows: batch.renderedRows } : {}),
      });
    } else if (outcome.kind === "completed" && turnEnded === "completed" && agent.turn.textEvents + agent.turn.toolCalls === 0) {
      turnEnded = "failed";
    }
    agent.catchupBatch = null;
    agent.turn = { textEvents: 0, toolCalls: 0, runtimeErrors: 0, thinkingEvents: 0 };
    agent.steerHold = { compacting: false, refusals: 0 };
    this.reportFirstTurnEnded(agent, turnEnded);
    if (terminal) return;
    if (!this.isCurrent(agent) || agent.session !== session) return;
    // Working → Idle only when the turn is over and nothing waited for it: a
    // held delivery handed over now opens the next turn, whose end is the edge.
    const idleEdge = outcome.kind !== "failed" && agent.pending.length === 0;
    // A clean turn end: the runtime ended it itself, with output (not aborted, not failed).
    const cleanEnd = turnEnded === "completed";
    void this.flushPending(agent, session).then(() => {
      if (idleEdge) this.notifyWorkingToIdle(agent, session);
      // Server features: a turn end is a "became idle" fact (reconciler step 6).
      this.reconcile(agent, "turn_end");
      // Only one of the two acts on a turn end: warm recycle goes first when
      // its gate passes (the session is about to be replaced; compacting it
      // first would pay for a context nothing resumes).
      if (idleEdge && !this.maybeMarkWarmRecycle(agent, session, cleanEnd)) void this.maybeCompactAtTurnEnd(agent, session);
    });
  }

  /**
   * RFC 070 §6.5 (wakeRecycleWarm.ts): at a clean turn end with nothing
   * running, held or queued, a Codex or Grok session whose last reported
   * context is past the warm threshold (on a window of at least 400k) is
   * marked. Past the ceiling it is ended now; otherwise after the quiet
   * period, unless a delivery arrives first (`cancelWarmRecycle`). Only while
   * the Server's `wake_recycle_warm` is on, for the runtimes whose summary
   * supplies the next start's facts (`wake_recycle_oar`). Returns whether it marked.
   */
  private maybeMarkWarmRecycle(agent: HostedAgent, session: Session, cleanEnd: boolean): boolean {
    const config = this.warmRecycleConfig(agent);
    if (!config) return false;
    // A mark cancelled before its stop (a delivery) skipped its turn end's
    // compaction: this turn end is compaction's, below the ceiling (asked
    // once; the turn end after it may mark again).
    const yieldToCompaction = this.warmRecycle.takeYield(agent.agentId, session.id);
    const summary = agent.summary?.current() ?? null;
    const context = summary && summary.sessionId === session.id ? summary.context : null;
    // The turn-end compaction gate's facts: the last reported context and the model's window.
    const decision = cleanEnd && !this.warmRecycle.declined(agent.agentId, session.id) && this.warmRecycleStoppable(agent, session)
      ? decideWarmRecycleMark(config, { contextTokens: context?.tokens ?? null, windowTokens: context?.window ?? null })
      : null;
    if (!decision?.mark || (yieldToCompaction && decision.band === "quiet")) {
      // This turn end decides again: a mark an earlier one left is not kept past it.
      this.warmRecycle.cancel(agent.agentId);
      return false;
    }
    const mark: WarmRecycleMark = { sessionId: session.id, contextTokens: decision.contextTokens, windowTokens: decision.windowTokens, band: decision.band, markedAtMs: this.now() };
    this.warmRecycle.mark(agent.agentId, mark, decision.band === "quiet" ? { quietMs: config.quietMs, onQuiet: () => this.stopForWarmRecycle(agent, session) } : null);
    const described = describeWarmRecycleMarked(this.warmRecycleTraceBase(agent), mark, config);
    this.deps.recordEvent(WARM_RECYCLE_MARKED_EVENT, described.attrs);
    logger.info(described.logLine);
    if (decision.band === "ceiling") this.stopForWarmRecycle(agent, session);
    return true;
  }

  /** The warm-recycle knobs for this agent, or null when it is off for it (the flag, the local off switch, a runtime with no facts for the next start). */
  private warmRecycleConfig(agent: HostedAgent): WarmRecycleConfig | null {
    const agentConfig = this.agentConfig(agent);
    const features = agent.serverFeatures ?? pickAgentServerFeatures(agentConfig);
    const config = resolveWarmRecycleConfig({ envVars: agentConfig.envVars, wakeRecycleWarm: features.wakeRecycleWarm === true });
    if (!config.enabled || !warmRecycleCoversRuntime("oar", agent.runtimeId, { wakeRecycleOar: features.wakeRecycleOar === true })) return null;
    return config;
  }

  private warmRecycleTraceBase(agent: HostedAgent) {
    return { agentId: agent.agentId, launchId: agent.launchId ?? undefined, runtime: agent.runtimeId, host: "oar" as const };
  }

  /**
   * Idle as the cold-idle stop reads it (`reconcileColdIdle`): no turn,
   * compaction, background task or sub-agent, nothing held or being written;
   * and, as the legacy host's `warmRecycleStoppable`, no failure or hold in
   * the way. Of the legacy checks: the provider-limit wait, a credential
   * hold (an invalid credential or a provider limit on it) and a drain are
   * `stalledWithWorkDeliveryHold`; the live runtime error is `lastFailure`
   * (cleared by a turn start, so set only by this session's latest turn).
   * Not mirrored, being covered elsewhere: a sticky failure (input too large,
   * an unusable model) fails its turn, which is no clean end, and ends or
   * replaces the session there; and no CLI version floor applies here
   * (`COLD_IDLE_RUNTIME_VERSION_FLOORS` names only Claude, which this host
   * never marks: `warmRecycleCoversRuntime`).
   */
  private warmRecycleStoppable(agent: HostedAgent, session: Session): boolean {
    if (!this.isCurrent(agent) || agent.session !== session || agent.stopping || !agent.committed) return false;
    if (agent.steerHold.compacting || agent.turnEndCompaction.inFlight) return false;
    if (agent.lastFailure !== null || this.stalledWithWorkDeliveryHold(agent) !== null) return false;
    if (agent.pending.length > 0 || agent.carried.length > 0 || agent.flushing) return false;
    if (this.agentNotIdle(agent, session) !== null || session.status().value.kind !== "idle") return false;
    // Ending the session kills its sub-agents: a task with no end holds it (as in reconcileColdIdle).
    return agent.taskRows.runningCount(Number.POSITIVE_INFINITY) === 0;
  }

  /**
   * The warm-recycle stop: everything is decided again, then the session is
   * ended as the cold-idle stop ends it (clean, the session kept, the next
   * delivery's start is the Server's); that start finds the stop remembered
   * and recycles (`planWakeSessionRecycle`, `warmStop`).
   */
  private stopForWarmRecycle(agent: HostedAgent, session: Session): void {
    const mark = this.warmRecycle.pending(agent.agentId);
    if (!mark) return;
    if (mark.sessionId !== session.id || !this.warmRecycleConfig(agent) || !this.warmRecycleStoppable(agent, session)) {
      this.cancelWarmRecycle(agent, { reason: "not_idle" });
      return;
    }
    const nowMs = this.now();
    this.warmRecycle.stopped(agent.agentId, nowMs);
    const described = describeWarmRecycleStopped(this.warmRecycleTraceBase(agent), mark, nowMs);
    this.deps.recordEvent(WARM_RECYCLE_STOPPED_EVENT, described.attrs);
    logger.info(described.logLine);
    this.planEnd(agent, session, "cold_idle_recycle", null);
    this.specHandbacks.mark(agent.agentId);
    void this.endSession(agent, "warm_recycle");
  }

  /** A delivery before the stop: the session keeps running, and its next clean turn end decides again. */
  private cancelWarmRecycle(agent: HostedAgent, cause: { reason: WarmRecycleCancelReason; senderKind?: WarmRecycleSenderKind; triggerKind?: string }): void {
    // The mark skipped its turn end's compaction: the next turn end is compaction's (`takeYield`).
    const mark = this.warmRecycle.cancel(agent.agentId, { yieldNext: true });
    if (!mark) return;
    const described = describeWarmRecycleCancelled(this.warmRecycleTraceBase(agent), mark, this.now(), cause);
    this.deps.recordEvent(WARM_RECYCLE_CANCELLED_EVENT, described.attrs);
    logger.info(described.logLine);
  }

  /**
   * #proj-runtime:#54 phase 3: at a turn end with nothing running, held or
   * queued, a Codex or Grok session whose last reported context is past the
   * threshold (on a window of at least 400k) compacts with OAR's
   * `Session.compact()`. A refusal (Codex: a goal active, input queued) is a
   * skip: the arm is kept for a later turn end. Deliveries that arrive during
   * it are held (`handOff`) and handed over once it settles.
   */
  private async maybeCompactAtTurnEnd(agent: HostedAgent, session: Session): Promise<void> {
    if (!TURN_END_COMPACTION_OAR_RUNTIMES.has(agent.runtimeId)) return;
    if (!this.isCurrent(agent) || agent.session !== session || agent.stopping || !agent.committed) return;
    const state = agent.turnEndCompaction;
    if (state.inFlight) return;
    const agentConfig = this.agentConfig(agent);
    const features = agent.serverFeatures ?? pickAgentServerFeatures(agentConfig);
    const config = resolveTurnEndCompactionConfig({ envVars: agentConfig.envVars, turnEndCompaction: features.turnEndCompaction === true });
    if (!config.enabled) return;
    const summary = agent.summary?.current() ?? null;
    const context = summary && summary.sessionId === session.id ? summary.context : null;
    const facts: TurnEndContextFacts = { contextTokens: context?.tokens ?? null, windowTokens: context?.window ?? null };
    const armed = state.arming.observe(session.id, facts.contextTokens, config.minContextTokens);
    const decision = decideTurnEndCompaction(config, facts, armed);
    const base = { agentId: agent.agentId, launchId: agent.launchId ?? undefined, runtime: agent.runtimeId, host: "oar", ...turnEndCompactionTraceAttrs(config, facts) };
    if (!decision.fire) {
      // One event per session and reason, so a busy agent's every turn end doesn't repeat it.
      const key = `${session.id}:${decision.reason}`;
      if (state.lastSkipKey !== key) {
        state.lastSkipKey = key;
        this.deps.recordEvent(TURN_END_COMPACTION_EVENT, { ...base, outcome: `skipped:${decision.reason}` });
      }
      return;
    }
    const blocked = !session.compact
      ? "unsupported"
      : agent.steerHold.compacting
        ? "compacting"
        : agent.pending.length > 0 || agent.carried.length > 0 || agent.flushing
          ? "deliveries_waiting"
          : this.agentNotIdle(agent, session) !== null || session.status().value.kind !== "idle"
            ? "agent_busy"
            : null;
    if (blocked) {
      // Not this turn end; the next one decides again (the arm is kept).
      this.deps.recordEvent(TURN_END_COMPACTION_EVENT, { ...base, outcome: `skipped:${blocked}` });
      return;
    }
    const startedAtMs = this.now();
    state.inFlight = { startedAtMs, heldSinceMs: null };
    state.arming.markFired();
    // What the runtime's own compaction shows, from the moment it is asked for: the agent already answered, and is not stuck.
    this.publish(agent, "working", "Compacting context", "compacting_context");
    this.deps.recordEvent(TURN_END_COMPACTION_EVENT, { ...base, outcome: "started" });
    let outcome: Awaited<ReturnType<NonNullable<Session["compact"]>>> | null = null;
    let thrown = false;
    try {
      outcome = await session.compact!({ timeoutMs: TURN_END_COMPACTION_WAIT_MS });
    } catch (error) {
      thrown = true;
      logger.warn(`[Agent ${agent.agentId}] Turn-end compaction failed to run: ${errorMessage(error)}`);
    }
    const inFlight = state.inFlight;
    state.inFlight = null;
    const nowMs = this.now();
    const result = thrown || !outcome
      ? "failed:threw"
      : outcome.kind === "completed"
        ? "completed"
        : outcome.kind === "rejected"
          ? `refused:${outcome.code}`
          : outcome.kind === "aborted"
            ? "aborted"
            : `${outcome.kind}:${outcome.code}`;
    // A refusal did nothing: keep the arm for a later turn end.
    if (outcome?.kind === "rejected") state.arming.rearm();
    const after = agent.summary?.current() ?? null;
    this.deps.recordEvent(TURN_END_COMPACTION_EVENT, {
      ...base,
      outcome: result,
      duration_ms: nowMs - startedAtMs,
      ...(after && after.sessionId === session.id && after.context ? { context_after_tokens: after.context.tokens } : {}),
      deliveries_held: agent.pending.length,
      ...(inFlight?.heldSinceMs != null ? { hold_ms: nowMs - inFlight.heldSinceMs } : {}),
    });
    logger.info(turnEndCompactionLogLine({ agentId: agent.agentId, host: "oar", outcome: result, contextTokens: facts.contextTokens, contextAfterTokens: after && after.sessionId === session.id && after.context ? after.context.tokens : null, durationMs: nowMs - startedAtMs }));
    // Hand over what waited behind it (nothing else would: a compaction is no turn, so no turn end flushes them).
    if (this.isCurrent(agent) && agent.session === session && agent.pending.length > 0) void this.flushPending(agent, session);
    // Nothing waited: back to idle, without the idle hooks (they ran at the turn end before it; a compaction ends no work).
    else if (this.isCurrent(agent) && agent.session === session && !agent.stopping && session.status().value.kind === "idle") this.publish(agent, "online", "Idle", "idle");
  }

  /** The idle hook, once the agent is still this launch's, idle, with nothing held. */
  private notifyWorkingToIdle(agent: HostedAgent, session: Session): void {
    if (!this.deps.onAgentWorkingToIdle) return;
    if (!this.isCurrent(agent) || agent.session !== session || agent.stopping) return;
    if (agent.pending.length > 0 || agent.flushing || session.status().value.kind !== "idle") return;
    // A host-asked compaction is no work of the agent's: a turn end it reports runs no idle hooks.
    if (agent.turnEndCompaction.inFlight) return;
    try {
      this.deps.onAgentWorkingToIdle(agent.agentId);
    } catch (error) {
      // Runs in the session's event handling; never let it escape.
      logger.error(`[Agent ${agent.agentId}] Working-to-idle listener failed`, error);
    }
  }

  /**
   * A failed turn, by OAR's typed failure class, mapped to the legacy host's
   * handling of the same runtime fact. Returns whether the session was ended.
   */
  private onFailedTurn(agent: HostedAgent, outcome: Extract<TurnOutcome, { kind: "failed" }>): boolean {
    const runtimeId = agent.runtimeId;
    const { diagnostic, fromText, failure } = classifiedFailure(outcome);
    // Reconciler step 10b: the live runtime error an exit reads (its
    // recoverable class), until the next turn starts. A runtime_exited
    // failure is the exit itself (`turnCutByExit`).
    if (failure !== "runtime_exited") agent.lastFailure = { failure, reason: outcome.reason };
    // The plan does not include the model (task #352): the user changes the
    // model or the plan.
    const planAccess = failure === "unknown" && diagnostic.requiredAction === "user_model_access";
    this.deps.recordEvent("daemon.agent.oar.turn_failed", {
      agentId: agent.agentId,
      launchId: agent.launchId ?? undefined,
      failure,
      ...(fromText ? { failure_from_text: true } : {}),
      ...(planAccess ? { required_action: "user_model_access" } : {}),
      runtime_error_class: diagnostic.errorClass,
      runtime_error_fingerprint: diagnostic.fingerprint,
    }, "error", agent.turnTrace.traceContext);
    // #proj-raft-computer:#46 (reconciler step 4a): a rejected sign-in, a
    // plan without the model, an exhausted billing balance: the credential's
    // current version is invalid, the session is not broken. Recorded on the
    // credential (both hosts hold every agent it applies to); this session
    // keeps running, no E1, and its deliveries are held until the credential
    // changes, a turn on it produces model output, or a person stops the
    // agent (Retry). The user still sees what to do.
    const credentialInvalid: { reason: CredentialInvalidReason; detail: string } | null = failure === "auth"
      ? { reason: "user_reauth", detail: formatRuntimeLoginRequiredMessage(runtimeId) }
      : failure === "billing"
        ? { reason: "billing", detail: formatRuntimeBillingExhaustedMessage(runtimeId) }
        : planAccess
          ? { reason: "user_model_access", detail: formatRuntimePlanAccessMessage(runtimeId, this.agentConfig(agent).model) }
          : null;
    if (credentialInvalid) {
      // This agent shows its own error (what to do), not the held notice.
      agent.credentialInvalidVisibility = { kind: "own_error" };
      this.recordCredentialInvalid(agent, credentialInvalid.reason, failure);
      this.publish(agent, "error", credentialInvalid.detail, "runtime_error", [], diagnostic);
      return false;
    }
    // Reconciler step 12 (rows C8, C9): a failure a new message would only
    // repeat. No terminal record: a session that no longer fits is replaced
    // (once), an unusable model gives the agent back to the server at once.
    const sticky: "input_too_large" | "model_unsupported" | null = failure === "input_too_large"
      ? "input_too_large"
      : failure === "model_unavailable" ? "model_unsupported" : null;
    if (!sticky) {
      // #proj-raft-computer:#46 (design row C6): a provider limit is the
      // credential's. Recorded there, it holds this agent's deliveries, and
      // those of every agent on the same shared sign-in on either host, until
      // it ends; the session keeps running.
      const providerLimit = oarFailureProviderLimit(failure, outcome);
      if (providerLimit) this.recordProviderLimit(agent, providerLimit, failure);
      this.publish(agent, "error", `${runtimeDisplayName(runtimeId)} turn failed: ${outcome.reason}`, "runtime_error", [], diagnostic);
      return false;
    }
    // RFC 071 §7 E1, before the launch is released (it names launch and session).
    const evidence = terminalFailureFromRawText("sticky_runtime_error", outcome.reason);
    this.sendRuntimeOutcome(agent, {
      kind: "terminal_failure",
      failureKind: evidence.failureKind,
      fingerprint: evidence.fingerprint,
      errorClass: evidence.errorClass,
    });
    const label = runtimeDisplayName(runtimeId);
    const records = this.exitStreaks.sticky;
    logger.warn(`[Agent ${agent.agentId}] ${runtimeId} turn failed (${failure}); ending the OAR session`);
    if (sticky === "model_unsupported") {
      const config = this.agentConfig(agent);
      records.noteUnusableModel(agent.agentId, { runtime: config.runtime || runtimeId, model: config.model ?? null });
      this.handStickyFailureToServer(agent, "model_unsupported", `${label} cannot use this model: ${outcome.reason}`, failure, diagnostic);
      return true;
    }
    if (records.sessionReset(agent.agentId)) {
      this.handStickyFailureToServer(agent, "session_needs_reset", `${label} failed again in the new session Raft started for it (${formatRuntimeInputTooLargeMessage(runtimeId)}). Raft stopped starting new sessions. ${formatRuntimeResetSessionGuidance()}`, failure, diagnostic);
      return true;
    }
    this.publish(agent, "error", formatRuntimeInputTooLargeMessage(runtimeId), "runtime_error", [], diagnostic);
    this.replaceSession(agent, "input_too_large");
    return true;
  }

  /**
   * Reconciler step 12 (row C8, the legacy host's
   * `replaceSessionAfterStickyFailure`): the session no longer fits the
   * model. The server forgets it (`agent:session:invalidate`, as D4 does)
   * and the agent starts again here on a new session, with the deliveries
   * the old one held (`restartAfterEnd`), once: the same failure before a
   * turn of the new one completes is the server's (`session_needs_reset`).
   */
  private replaceSession(agent: HostedAgent, cause: SessionResetCause): void {
    const session = agent.session;
    this.exitStreaks.sticky.noteSessionReset(agent.agentId, cause);
    if (session?.id) {
      this.deps.sendToServer({ type: "agent:session:invalidate", agentId: agent.agentId, sessionId: session.id, ...(agent.launchId ? { launchId: agent.launchId } : {}), reason: cause });
    }
    const label = runtimeDisplayName(agent.runtimeId);
    this.deps.recordEvent("daemon.agent.session_replaced", {
      agentId: agent.agentId,
      launchId: agent.launchId ?? undefined,
      runtime: agent.runtimeId,
      cause,
      session_id_present: Boolean(session?.id),
      carried_count: [...agent.carried, ...agent.pending].filter((delivery) => !this.isTransient(delivery)).length,
      host: "oar",
    }, "error");
    this.publish(agent, "working", `${label} session no longer fits the model's input limit; starting a new session…`, "runtime_unavailable", [{
      kind: "text",
      text: `The ${label} session no longer fits the model's input limit. Starting a new session; earlier runtime context is not restored. Raft messages and workspace files are kept.`,
    }]);
    this.restartAfterEnd(
      agent,
      { kind: "session_replaced", session: { kind: "new", reason: "no_session" }, crashStreak: this.exitStreaks.crashStreak(agent.agentId), hold: null },
      "session_replaced",
      0,
      () => { void this.endSession(agent, "terminal_runtime_error"); },
    );
  }

  /**
   * Reconciler step 12 (the legacy host's `handStickyFailureToServer`): the
   * agent is given back to the server at the first report: a failed start
   * with a typed reason that pauses its automatic wakes at once
   * (`runtime_spawn_failed` to a server that does not count it), an error
   * the person sees, and the session ended (held deliveries stay unread on
   * the server).
   */
  private handStickyFailureToServer(
    agent: HostedAgent,
    stickyReason: "model_unsupported" | "runtime_repeated_failure" | "session_needs_reset",
    detail: string,
    failure: FailureClass,
    diagnostic: RuntimeErrorActivityDiagnostic,
  ): void {
    const reason = reportedStickyFailureReason(stickyReason, this.serverCountsStickyReasons);
    this.deps.recordEvent("daemon.agent.sticky_failure.handed_to_server", {
      agentId: agent.agentId,
      launchId: agent.launchId ?? undefined,
      runtime: agent.runtimeId,
      cause: failure,
      reason: stickyReason,
      reported_reason: reason,
      dropped_count: [...agent.carried, ...agent.pending].filter((delivery) => !this.isTransient(delivery)).length,
      host: "oar",
    }, "error");
    this.reportStartFailure(agent, detail, reason);
    this.publish(agent, "error", detail, "runtime_error", [], diagnostic);
    void this.endSession(agent, "terminal_runtime_error");
  }

  /**
   * Reconciler step 10b (rows D1-D6; before it the OAR host never
   * restarted an agent on an exit): the runtime exited on its
   * own. The legacy host's rule decides (`planExit`, from `exitFacts`), and
   * this host acts on the plan:
   * - start now (D1 with deliveries held, D4 on a new session) or after the
   *   crash streak's backoff (D3, D6 with deliveries held) or the provider
   *   limit's wait (which a release of the limit ends early): the agent
   *   starts again here with them (`restartAfterEnd`).
   * - the next wake (D2, D5, D3 with nothing held, a credential hold): as
   *   before, the agent is released, `inactive` with the exit; held
   *   deliveries are dropped (a held tracked mention is handed back, so the
   *   server wakes the agent; plain ones stay unread for that start).
   * - the cap: handed to the server (`handCrashStreakToServer`).
   */
  private onExited(agent: HostedAgent, session: Session, code: number | null): void {
    this.deps.recordEvent("daemon.agent.oar.exited", { agentId: agent.agentId, launchId: agent.launchId ?? undefined, code, held: agent.pending.length }, "error");
    const { facts, plan } = this.planEnd(agent, session, null, code);
    // A turn this exit cut short ends with it, as on the legacy host's close.
    agent.turnTrace.end(plan.clean ? "ok" : "error", {
      outcome: plan.clean ? "process-exit" : "process-crash",
      runtime_turn_boundary_satisfied: facts.turnBoundarySatisfied,
      runtime_exit_before_turn_boundary: !facts.turnBoundarySatisfied || undefined,
      exitCode: code,
    });
    if (plan.handToServer) {
      this.handCrashStreakToServer(agent, session, plan, facts, code);
      return;
    }
    const restartInMs = plan.start === "now" ? 0 : typeof plan.start === "object" ? plan.start.afterMs : null;
    if (restartInMs !== null) {
      if (plan.session.kind === "new" && plan.session.reason === "resume_failed") {
        const label = runtimeDisplayName(agent.runtimeId);
        const what = plan.session.cause === "repeated_early_crash" ? "keeps crashing on resume" : "cannot be resumed";
        this.publish(agent, "working", `Stored ${label} session ${what}; starting a new session…`, "runtime_unavailable", [{
          kind: "text",
          text: `Stored ${label} session ${plan.session.sessionId} ${what}. Starting a new session; earlier runtime context may not be restored.`,
        }]);
      } else if (restartInMs > 0) {
        // D3, D6, a provider limit's wait: kept wakeable (the restart is this
        // host's), as the legacy host does.
        this.sendStatus(agent, "active");
        const what = plan.kind === "zero_evidence_turn" ? `Exited without output (exit code ${code ?? "unknown"})` : `Crashed (exit code ${code ?? "unknown"})`;
        const when = plan.hold === "provider_limit" ? "restarting when the provider limit ends" : `restarting in ${Math.ceil(restartInMs / 1000)} s`;
        this.publish(agent, "offline", `${what}; ${when}`, "runtime_crashed");
      }
      this.sendProcessExited(agent, code);
      this.restartAfterEnd(agent, plan, "exit", restartInMs, () => {
        this.release(agent, "runtime_exited");
        this.trackUnwind(agent.agentId, this.disposeSession(agent, session, "runtime_exited"));
      });
      return;
    }
    this.sendStatus(agent, "inactive", { code, signal: null });
    this.publish(agent, "offline", `Crashed (exit code ${code ?? "unknown"})`, "runtime_crashed");
    this.sendProcessExited(agent, code);
    // The next wake is the server's start (it re-selects the host).
    this.release(agent, "runtime_exited");
    this.trackUnwind(agent.agentId, this.disposeSession(agent, session, "runtime_exited"));
  }

  /**
   * Reconciler step 10b: an end's facts for `planExit`, read from OAR. What
   * OAR does not expose is read conservatively (README, "Exit and restart"):
   * - code: OAR's `exited` code; null when it has none, and for the daemon's
   *   own stops (planned before the dispose). Signal and OOM: never exposed
   *   (OAR keeps the pid): null and false, so an exit with no code is a crash
   *   (D5), never clean and never an early crash of a resumed session.
   * - turn boundary: no turn runs and the exit did not cut the last one short.
   * - runtime error: the last turn failed and no turn started since. Its
   *   recoverable class: OAR's failure class (`oarRecoverableExitError`), an
   *   unclassified one by its text as the legacy host reads it; a stream
   *   failure by the same text.
   * - sticky failure: never here: OAR's sticky failures (input too large, an
   *   unusable model) end the session through E1 first (`onFailedTurn`).
   * - inbox: every non-transient delivery held (OAR defers none), a first
   *   input held at the commit included.
   * - credential: the shared ledger's invalid record and provider limit.
   * - session: the session and the one the launch resumed; no known resume
   *   error (a resume OAR refuses at open hands the start to the legacy host
   *   before the commit), the shared early-crash record.
   * - model output, uptime since the session's open, the shared streaks, and
   *   the backoff policy (the legacy host's delivery backoff).
   * - a turn that did nothing (D6): an exit on its own with work held and no
   *   model output from the session.
   */
  private exitFacts(agent: HostedAgent, session: Session, expected: ExitExpectedTermination | null, code: number | null): ExitFacts {
    const { agentId } = agent;
    const now = this.now();
    const failure = agent.lastFailure;
    const held = [...agent.carried, ...agent.pending].filter((delivery) => !this.isTransient(delivery));
    return {
      code,
      signal: null,
      oom: false,
      turnBoundarySatisfied: !agent.turnOpen && !agent.turnCutByExit,
      expectedTermination: expected,
      runtimeError: failure !== null,
      stickyFailure: false,
      providerStreamFailure: failure !== null && isProviderStreamFailureText(failure.reason),
      recoverableError: failure ? oarRecoverableExitError(failure.failure, failure.reason) : null,
      inbox: { wakes: held.length > 0, pending: held.length > 0 },
      credential: {
        invalid: this.activeCredentialInvalid(agent) !== null,
        limitUntilMs: this.providerLimits.get(this.credentialKey(agent), now)?.untilMs ?? null,
      },
      nowMs: now,
      session: {
        sessionId: session.id,
        resumedSessionId: agent.launch?.options.resume ?? null,
        knownResumeError: null,
        resumeFailures: this.exitStreaks.resumeFailureRecord(agentId),
      },
      modelOutput: agent.modelOutput,
      // D6 on a persistent session (Tenny, review of #13336): an exit on its
      // own with work held and no model output from the session did nothing
      // the host can see, whether or not a turn ever started; planExit then
      // counts it (backoff and cap) where a plain clean exit would start
      // again at once, forever.
      zeroEvidenceTurn: expected === null && !agent.modelOutput && held.length > 0,
      uptimeMs: agent.openedAtMs === null ? 0 : Math.max(0, now - agent.openedAtMs),
      crashStreak: this.exitStreaks.crashStreak(agentId),
      capStreak: this.exitStreaks.capStreak(agentId),
      backoff: {
        baseMs: this.providerLimitBackoff.baseMs,
        maxMs: this.providerLimitBackoff.maxMs,
        jitterRatio: this.providerLimitBackoff.jitterRatio,
        jitterUnit: this.providerLimitBackoff.jitterRandom(),
      },
    };
  }

  /**
   * Reconciler step 10b: plan a session's end (an exit, or the daemon's own
   * stop: `expected`), keep what the plan leaves in the shared exit streaks,
   * and trace it (`daemon.agent.exit.planned`, as the legacy host does). A
   * new session chosen for a resume failure is forgotten by the server too.
   */
  private planEnd(agent: HostedAgent, session: Session, expected: ExitExpectedTermination | null, code: number | null): { facts: ExitFacts; plan: ExitPlan } {
    const { agentId } = agent;
    const facts = this.exitFacts(agent, session, expected, code);
    const plan = planExit(facts);
    this.exitStreaks.recordPlan(agentId, plan);
    const launchId = agent.launchId ?? undefined;
    if (plan.earlyCrashCounted && facts.session.resumedSessionId) {
      const fellBackFresh = plan.session.kind === "new" && plan.session.reason === "resume_failed";
      this.deps.recordEvent("daemon.runtime.resume_failed", {
        ...this.stallTraceAttrs(agent),
        session_id: facts.session.resumedSessionId,
        consecutive_count: fellBackFresh ? plan.sessionFacts.resumeFailure?.earlyCrashes ?? 0 : plan.resumeFailures?.count ?? 0,
        threshold: RESUME_FAILURE_THRESHOLD,
        fell_back_fresh: fellBackFresh,
        exit_code: code,
        uptime_ms_bucket: bucketMs(facts.uptimeMs),
      }, "error");
    }
    if (plan.session.kind === "new" && plan.session.reason === "resume_failed") {
      this.deps.sendToServer({ type: "agent:session:invalidate", agentId, sessionId: plan.session.sessionId, ...(launchId ? { launchId } : {}), reason: plan.session.cause });
    }
    this.deps.recordEvent("daemon.agent.exit.planned", {
      agentId,
      launchId,
      runtime: agent.runtimeId,
      host: "oar",
      expected_termination: expected ?? undefined,
      exit_code: code,
      oar_failure: agent.lastFailure?.failure,
      held_count: facts.inbox.pending ? [...agent.carried, ...agent.pending].length : 0,
      plan_kind: plan.kind,
      plan_start: typeof plan.start === "string" ? plan.start : "after",
      plan_start_after_ms: typeof plan.start === "string" ? undefined : plan.start.afterMs,
      plan_hold: plan.hold ?? undefined,
      plan_session: plan.session.kind === "new" ? `new:${plan.session.reason}` : plan.session.kind,
      plan_session_cause: plan.session.kind === "new" && plan.session.reason === "resume_failed" ? plan.session.cause : undefined,
      early_crash_counted: plan.earlyCrashCounted || undefined,
      crash_streak: plan.crashStreak,
      cap_streak: plan.capStreak,
      hand_to_server: plan.handToServer || undefined,
      keep_snapshot: plan.keepSnapshot,
    }, plan.clean ? "ok" : "error");
    return { facts, plan };
  }

  /**
   * Reconciler steps 9 and 10b: start the agent again on this host after its
   * session ended (`end` ends it), on the session the plan chose, with the
   * same launch (`process_spawned` `respawn`) and a new runner credential.
   * The deliveries the ended session held never leave the daemon (a plain one
   * was acked on custody, so the server has nothing to send again) and go in
   * the new start's first input, once. The start is registered at once, so a
   * server start meanwhile rebinds onto it (one start; its launch is named
   * too) and a delivery is held for it; it launches once the ended session is
   * undone and `delayMs` (the crash streak's backoff) is over. A start OAR
   * cannot run (`fallback`) shows the agent stopped (`restartFailed`).
   */
  private restartAfterEnd(
    agent: HostedAgent,
    plan: Pick<ExitPlan, "session" | "crashStreak" | "hold"> & { kind: ExitPlan["kind"] | "session_replaced" },
    cause: OarRestartCause,
    delayMs: number,
    end: () => void,
  ): void {
    const { agentId } = agent;
    // Out of the session before its end, which would drop them. A first
    // input the launch still held (a credential hold at its commit) is its
    // own: the restart builds one from the same start, with what it named.
    // So does a new session after a resume failure (the legacy host's cold
    // start): what the old session took is not in the new one.
    const held = [...agent.carried.splice(0), ...agent.pending.splice(0)];
    const heldFirstInput = held.find((delivery) => delivery.firstInput);
    const carried = held.filter((delivery) => !delivery.firstInput);
    heldFirstInput?.settle(false);
    const sameStartInputs = Boolean(heldFirstInput) || plan.kind === "resume_failed";
    const config: AgentConfig = { ...agent.request.config, sessionId: plan.session.kind === "resume" ? plan.session.sessionId : null };
    // The ended launch's runner credential is revoked with it; the next launch mints its own.
    delete config.agentCredentialKey;
    delete config.agentCredentialId;
    const { wakeMessage, wakeMessageTransient, unreadSummary, resumePrompt, resumeMessages, catchupBatchId } = agent.request;
    end();
    this.deps.recordEvent("daemon.agent.oar.restart_scheduled", {
      agentId,
      launchId: agent.launchId ?? undefined,
      runtime: agent.runtimeId,
      cause,
      plan_kind: plan.kind,
      plan_session: plan.session.kind === "new" ? `new:${plan.session.reason}` : plan.session.kind,
      delay_ms: delayMs,
      carried_count: carried.length,
      crash_streak: plan.crashStreak,
      host: "oar",
    });
    const restart = this.startHosted({
      agentId,
      config,
      launchId: agent.launchId ?? undefined,
      wakeMessageTransient: false,
      recoveryGrant: null,
      claimedConnectionEpochId: null,
      ...(sameStartInputs ? { wakeMessage, wakeMessageTransient, unreadSummary, resumePrompt, resumeMessages, catchupBatchId } : {}),
    }, { carried, notBeforeMs: delayMs > 0 ? this.now() + delayMs : null, untilLimitReleased: plan.hold === "provider_limit" });
    void restart.then((outcome) => {
      if (outcome.kind === "fallback") this.restartFailed(agent, outcome, cause);
    });
  }

  /** A restart's backoff: resolves when it is over, or at once when the start is stopped. */
  private restartBackoff(agent: HostedAgent, delayMs: number): Promise<void> {
    const { signal } = agent.abort;
    return new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        if (agent.startWait) agent.startWait.end = null;
        resolve();
      };
      const timer = setTimeout(done, Math.max(0, delayMs));
      timer.unref?.();
      signal.addEventListener("abort", done, { once: true });
      if (agent.startWait) agent.startWait.end = done;
    });
  }

  /**
   * Reconciler step 10b, capped (the legacy host's `handCrashStreakToServer`):
   * CRASH_STREAK_CAP crashes in a row that the cap counts. This host does not
   * start the agent again: its held deliveries go (unread on the server; a
   * tracked mention is not handed back, the server's held cycle settles it,
   * as on the legacy host), the exit and a failed start
   * (`runtime_repeated_failure`, step 12; `runtime_spawn_failed` to an older
   * server) are reported for the server's early-exit and
   * start-failure breakers, which own the next start, and an error with no
   * required action shows (Restart ends the streak). Traced as
   * `daemon.agent.spawn.local_restart_stopped` with the last exit's sanitized
   * facts (never the error's text).
   */
  private handCrashStreakToServer(agent: HostedAgent, session: Session, plan: ExitPlan, facts: ExitFacts, code: number | null): void {
    const { agentId } = agent;
    const summary = typeof code === "number" ? `exit code ${code}` : "unknown exit";
    const dropped = [...agent.carried, ...agent.pending].filter((delivery) => !this.isTransient(delivery)).length;
    const lastError = agent.lastFailure?.reason || null;
    const lastErrorAttrs = buildRuntimeErrorDiagnosticEnvelope(lastError || summary).spanAttrs;
    logger.warn(`[Agent ${agentId}] Local restarts stopped after ${plan.capStreak} crashes in a row (${summary}); ${dropped} held delivery(ies) left to the Server`);
    this.deps.recordEvent("daemon.agent.spawn.local_restart_stopped", {
      agentId,
      launchId: agent.launchId ?? undefined,
      runtime: agent.runtimeId,
      host: "oar",
      source: "process_close",
      failure_reason: plan.kind,
      stop_cause: "attempts_exhausted",
      attempts: plan.capStreak,
      crash_streak: plan.crashStreak,
      dropped_count: dropped,
      exit_kind: plan.kind,
      exit_code: code,
      exit_uptime_ms_bucket: bucketMs(facts.uptimeMs),
      oar_failure: agent.lastFailure?.failure,
      runtime_error_reported: Boolean(lastError),
      runtime_error_class: lastErrorAttrs.runtime_error_class,
      runtime_error_fingerprint: lastErrorAttrs.runtime_error_fingerprint,
      runtime_error_http_status: lastErrorAttrs.runtime_error_http_status,
    }, "error");
    // The exit itself, as every crash reports it (the early-exit breaker, F1).
    this.sendStatus(agent, "inactive", { code, signal: null });
    this.sendProcessExited(agent, code);
    const label = runtimeDisplayName(agent.runtimeId);
    const detail = plan.kind === "zero_evidence_turn"
      ? formatZeroEvidenceStreakMessage(label, plan.capStreak)
      : formatCrashStreakExhaustedMessage(label, plan.capStreak, summary);
    // The failed start for the start-failure breaker (F2). Reconciler step
    // 12: counted by this host after the start was ready (whose readiness
    // ended the server's own count), so it pauses at this first report.
    this.reportStartFailure(agent, detail, reportedStickyFailureReason("runtime_repeated_failure", this.serverCountsStickyReasons));
    const { requiredAction: _requiredAction, ...runtimeError } = buildRuntimeErrorActivityDiagnostic(lastError || detail, { reasonProvenance: "daemon_fallback", nativeReasonPresent: false });
    this.publish(
      agent,
      "error",
      detail,
      "runtime_error",
      [{ kind: "text", text: `Error: ${detail}` }, ...(lastError ? [{ kind: "text" as const, text: `Last error: ${buildBoundedVisibleCrashDetail(lastError)}` }] : [])],
      runtimeError,
    );
    this.release(agent, "crash_streak_exhausted");
    this.trackUnwind(agentId, this.disposeSession(agent, session, "runtime_exited"));
  }

  /**
   * The legacy host's `reportStartFailure` frames: `inactive`, and the failed
   * start's activity with its typed reason, which the server's start-failure
   * breaker counts.
   */
  private reportStartFailure(agent: HostedAgent, detail: string, reason: SpawnFailureReason = "runtime_spawn_failed"): void {
    const report = startFailureActivity({ reason, detail, userMessage: detail }, this.agentConfig(agent).model);
    this.sendStatus(agent, "inactive");
    this.deps.sendToServer({
      type: "agent:activity",
      agentId: agent.agentId,
      detail: report.detail,
      detailKind: "runtime_unavailable",
      ...(agent.launchId ? { launchId: agent.launchId } : {}),
      observedAtMs: this.now(),
      isHeartbeat: false,
      spawnFailure: report.spawnFailure,
    });
  }

  /** Reconciler step 10b: model output ends the crash streaks and the early-crash record (the provider answers; the session resumed). */
  private noteModelOutput(agent: HostedAgent, kind: string): void {
    agent.modelOutput = true;
    this.exitStreaks.deleteResumeFailureRecord(agent.agentId);
    // Reconciler step 12: the runtime can use its model after all.
    this.exitStreaks.sticky.forgetUnusableModel(agent.agentId);
    this.endExitStreaks(agent, `runtime_progress:${kind}`);
  }

  /** Ends the agent's crash streak and its cap streak (traced when there was one). */
  private endExitStreaks(agent: HostedAgent, resetSource: string): void {
    const attempts = this.exitStreaks.crashStreak(agent.agentId);
    if (!this.exitStreaks.deleteStreaks(agent.agentId)) return;
    this.deps.recordEvent("daemon.agent.runtime_error_process_restart.reset", {
      agentId: agent.agentId,
      runtime: agent.runtimeId,
      launchId: agent.launchId ?? undefined,
      attempts,
      reset_source: resetSource,
      host: "oar",
    });
  }

  /** The config the agent's runtime runs with: its credential and model. */
  private agentConfig(agent: HostedAgent): AgentConfig {
    return agent.runtimeConfig ?? agent.request.config;
  }

  /** The provider credential the agent's runtime runs on (`providerLimitCredentialKey`). */
  private credentialKey(agent: HostedAgent): ProviderLimitCredentialKey {
    return providerLimitCredentialKey(agent.agentId, this.agentConfig(agent));
  }

  /**
   * What holds the agent's deliveries now: its credential's provider limit
   * while the wait runs, or an invalid record on its credential (for
   * `user_model_access` only while it runs that model). Null: nothing.
   */
  private deliveryHold(agent: HostedAgent):
    | { kind: "provider_limit"; key: ProviderLimitCredentialKey; record: ProviderLimitBackoffRecord }
    | { kind: "credential_invalid"; key: ProviderLimitCredentialKey; record: CredentialInvalidRecord }
    | null {
    const invalid = this.activeCredentialInvalid(agent);
    if (invalid) return { kind: "credential_invalid", ...invalid };
    const limit = this.activeProviderLimit(agent);
    return limit ? { kind: "provider_limit", ...limit } : null;
  }

  /** The invalid record on the agent's credential that applies to its model, or null. */
  private activeCredentialInvalid(agent: HostedAgent): { key: ProviderLimitCredentialKey; record: CredentialInvalidRecord } | null {
    if (!this.providerLimits.hasAnyInvalid()) return null;
    const key = this.credentialKey(agent);
    const record = this.providerLimits.invalidFor(key, this.agentConfig(agent).model);
    return record ? { key, record } : null;
  }

  /** Trace attrs of a delivery hold. */
  private holdTraceAttrs(hold: NonNullable<ReturnType<OarAgentHost["deliveryHold"]>>): Record<string, unknown> {
    return hold.kind === "provider_limit"
      ? {
        outcome: "held_for_provider_limit",
        credential_key_kind: providerLimitCredentialKeyKind(hold.key),
        provider_limit_kind: hold.record.providerLimitKind,
        remaining_ms_bucket: bucketMs(hold.record.untilMs - this.now()),
      }
      : {
        outcome: "held_for_credential_invalid",
        credential_key_kind: providerLimitCredentialKeyKind(hold.key),
        credential_invalid_reason: hold.record.invalidReason,
        host: "oar",
      };
  }

  /** Reconciler step 15: the account a runtime on `config` signs in as (never throws). */
  private credentialAccountOf(config: AgentConfig): CredentialAccount | null {
    try {
      return this.readCredentialAccount(config);
    } catch {
      return { kind: "unknown" };
    }
  }

  /** A failed turn said the agent's credential is invalid: recorded, and announced to both hosts. */
  private recordCredentialInvalid(agent: HostedAgent, reason: CredentialInvalidReason, failure: FailureClass): void {
    const key = this.credentialKey(agent);
    const config = this.agentConfig(agent);
    this.providerLimits.recordInvalid(key, {
      invalidReason: reason,
      ...(reason === "user_model_access" ? { model: config.model } : {}),
      recordedAtMs: this.now(),
    }, { host: "oar", agentId: agent.agentId }, config);
    this.deps.recordEvent("daemon.agent.credential_invalid.recorded", {
      agentId: agent.agentId,
      runtime: agent.runtimeId,
      model: config.model,
      launchId: agent.launchId ?? undefined,
      source: "failed_turn",
      failure,
      inbox_count: agent.pending.length,
      credential_invalid_reason: reason,
      credential_key_kind: providerLimitCredentialKeyKind(key),
      host: "oar",
    }, "error");
    logger.warn(`[Agent ${agent.agentId}] ${agent.runtimeId} credential invalid (${reason}); session kept, deliveries held until the credential changes`);
  }

  /** The provider limit on the agent's credential while its wait runs, or null. */
  private activeProviderLimit(agent: HostedAgent): { key: ProviderLimitCredentialKey; record: ProviderLimitBackoffRecord } | null {
    if (!this.providerLimits.hasAny()) return null;
    const key = this.credentialKey(agent);
    const now = this.now();
    const record = this.providerLimits.get(key, now);
    return record && record.untilMs > now ? { key, record } : null;
  }

  /**
   * A failed turn hit the provider limit `limit`: recorded on the agent's
   * credential, with the legacy host's wait (a valid reported reset, else
   * its exponential delivery backoff, at most QUOTA_RESET_BACKOFF_MAX_MS).
   * The attempts carry on from the credential's last limit, so a limit hit
   * again keeps growing the wait. The ledger announces it to both hosts:
   * this agent and the others on a shared sign-in hold their deliveries.
   */
  private recordProviderLimit(agent: HostedAgent, limit: RuntimeErrorProviderLimit, failure: FailureClass): void {
    const key = this.credentialKey(agent);
    const now = this.now();
    const attempts = (this.providerLimits.get(key, now)?.attempts ?? 0) + 1;
    const exponentialDelayMs = runtimeErrorDeliveryBackoffDelayMs(attempts, {
      baseMs: this.providerLimitBackoff.baseMs,
      maxMs: this.providerLimitBackoff.maxMs,
      jitterRatio: this.providerLimitBackoff.jitterRatio,
      jitterUnit: this.providerLimitBackoff.jitterRandom(),
    });
    const delayMs = providerLimitBackoffDelayMs({ providerLimit: limit, exponentialDelayMs, nowMs: now });
    const record: ProviderLimitBackoffRecord = {
      attempts,
      reason: OAR_PROVIDER_LIMIT_REASON,
      untilMs: now + delayMs,
      providerLimitKind: limit.kind,
      ...(limit.resetsAt ? { resetsAt: limit.resetsAt } : {}),
      recordedAtMs: now,
    };
    const config = agent.runtimeConfig ?? agent.request.config;
    // A longer limit still running on the credential stays (the ledger keeps its end).
    const stored = this.providerLimits.record(key, record, { host: "oar", agentId: agent.agentId });
    this.deps.recordEvent("daemon.agent.runtime_error_delivery_backoff", {
      agentId: agent.agentId,
      runtime: agent.runtimeId,
      model: config.model,
      launchId: agent.launchId ?? undefined,
      reason: record.reason,
      attempts,
      delay_ms: delayMs,
      until_ms: stored.untilMs,
      ...(stored.untilMs !== record.untilMs ? { kept_longer_limit: true } : {}),
      provider_limit_kind: limit.kind,
      provider_limit_source: limit.source,
      waits_for_reported_reset: delayMs !== Math.min(exponentialDelayMs, QUOTA_RESET_BACKOFF_MAX_MS),
      credential_key_kind: providerLimitCredentialKeyKind(key),
      failure,
      inbox_count: agent.pending.length,
      host: "oar",
    }, "ok", agent.turnTrace.traceContext);
  }

  /**
   * A limit recorded or released on either host. Recorded: every agent of
   * this host on that credential waits for it (the one that hit it
   * included); a delivery is held until the wait ends (`handOff`). Released
   * (credentials change, model output, explicit stop, on either host): the
   * waits end now, and held deliveries go to the runtime.
   */
  private onProviderLimitChange(change: ProviderLimitChange): void {
    if (change.kind === "invalid_recorded" || change.kind === "invalid_released") {
      this.onCredentialInvalidChange(change);
      return;
    }
    for (const agent of [...this.agents.values()]) {
      if (agent.stopping || this.credentialKey(agent) !== change.key) continue;
      const { record } = change;
      if (change.kind === "recorded") {
        const remainingMs = record.untilMs - this.now();
        if (remainingMs <= 0) continue;
        this.armProviderLimitWait(agent, record.untilMs);
        if (change.source.agentId === agent.agentId) continue;
        this.deps.recordEvent("daemon.agent.runtime_error_delivery_backoff.restored", {
          agentId: agent.agentId,
          runtime: agent.runtimeId,
          launchId: agent.launchId ?? undefined,
          reason: record.reason,
          attempts: record.attempts,
          provider_limit_kind: record.providerLimitKind,
          resets_at_reported: Boolean(record.resetsAt),
          remaining_ms_bucket: bucketMs(remainingMs),
          restore_point: "shared_credential_limit",
          restored_from_agent_record: true,
          credential_key_kind: providerLimitCredentialKeyKind(change.key),
          source_host: change.source.host,
          host: "oar",
        });
        continue;
      }
      // Reconciler step 10b: a restart waiting for this limit to end starts now.
      if (agent.startWait?.untilLimitReleased && agent.startWait.end) {
        this.deps.recordEvent("daemon.agent.oar.restart_wait_ended", { agentId: agent.agentId, launchId: agent.launchId ?? undefined, release_cause: change.cause, host: "oar" });
        agent.startWait.end();
        continue;
      }
      if (!agent.providerLimitWait) continue;
      this.deps.recordEvent("daemon.agent.runtime_error_delivery_backoff.reset", {
        agentId: agent.agentId,
        runtime: agent.runtimeId,
        launchId: agent.launchId ?? undefined,
        reason: record.reason,
        attempts: record.attempts,
        reset_source: "provider_limit_released",
        release_cause: change.cause,
        released: "held_deliveries",
        credential_key_kind: providerLimitCredentialKeyKind(change.key),
        source_host: change.source.host,
        held_count: agent.pending.length,
        host: "oar",
      });
      this.endProviderLimitWait(agent);
    }
  }

  /**
   * An invalid record recorded or released on either host. Recorded: every
   * agent of this host it applies to holds its deliveries (derived:
   * `handOff` reads the ledger); the others say so in a trace and show the
   * held notice (`publishCredentialInvalidHeldNotice`). Released (credentials
   * change, model output, explicit stop, model change): every agent it no
   * longer holds stops showing it (`endCredentialInvalidHeldNotice`) and gets
   * its held deliveries, in the same session.
   */
  private onCredentialInvalidChange(change: Extract<ProviderLimitChange, { kind: "invalid_recorded" | "invalid_released" }>): void {
    if (change.kind === "invalid_released") this.reportCredentialRestored(change);
    for (const agent of [...this.agents.values()]) {
      if (agent.stopping || this.credentialKey(agent) !== change.key) continue;
      if (!credentialInvalidAppliesToModel(change.record, this.agentConfig(agent).model)) continue;
      const attrs = {
        agentId: agent.agentId,
        runtime: agent.runtimeId,
        launchId: agent.launchId ?? undefined,
        credential_invalid_reason: change.record.invalidReason,
        credential_key_kind: providerLimitCredentialKeyKind(change.key),
        source_host: change.source.host,
        held_count: agent.pending.length,
        host: "oar",
      };
      if (change.kind === "invalid_recorded") {
        if (change.source.agentId !== agent.agentId) {
          this.deps.recordEvent("daemon.agent.credential_invalid.held", { ...attrs, restore_point: "shared_credential_invalid" });
          this.publishCredentialInvalidHeldNotice(agent, "recorded");
        }
        continue;
      }
      if (this.activeCredentialInvalid(agent)) continue;
      const account = change.cause === "credentials_changed" && agent.credentialAccount
        ? credentialAccountCheck(agent.credentialAccount, this.credentialAccountOf(this.agentConfig(agent)))
        : null;
      this.deps.recordEvent("daemon.agent.credential_invalid.released", {
        ...attrs,
        release_cause: change.cause,
        released: account?.restart ? "account_restart" : "held_deliveries",
        ...(account ? { account_check: account.check } : {}),
      });
      this.endCredentialInvalidHeldNotice(agent, change.cause);
      if (account?.restart) {
        // As on the legacy host (its restartForCredentialAccount): the live
        // session keeps the account it started with (for Claude verified by
        // a live test, task #48, Otter bfe2d441); it drifts, and ends once
        // idle to start again on the same session with the held deliveries.
        agent.credentialAccountChanged = true;
        this.deps.recordEvent("daemon.agent.credential_account.restart", {
          agentId: agent.agentId,
          runtime: agent.runtimeId,
          launchId: agent.launchId ?? undefined,
          release_cause: "credentials_changed",
          account_changed: account.check === "account_changed",
          account_unknown: account.check === "account_unknown",
          held_count: agent.pending.length,
          host: "oar",
        });
        this.reconcile(agent, "credentials_changed");
        continue;
      }
      if (this.isCurrent(agent) && agent.committed && agent.session) void this.flushPending(agent, agent.session);
    }
  }

  /**
   * Reconciler step 4b, as on the legacy host: the released record no longer
   * holds the agents of this host that showed it (own error or held notice):
   * the server is told, per agent and the reason it showed
   * (`agent:credential:restored`), and lifts only a wake block of that reason.
   */
  private reportCredentialRestored(change: Extract<ProviderLimitChange, { kind: "invalid_released" }>): void {
    for (const shown of change.shown) {
      if (shown.host !== "oar") continue;
      const agent = this.agents.get(shown.agentId);
      this.deps.sendToServer({
        type: "agent:credential:restored",
        agentId: shown.agentId,
        reason: shown.reason,
        releaseCause: change.cause,
        ...(agent?.launchId ? { launchId: agent.launchId } : {}),
      });
      this.deps.recordEvent("daemon.agent.credential_invalid.restored_reported", {
        agentId: shown.agentId,
        runtime: agent?.runtimeId,
        launchId: agent?.launchId ?? undefined,
        credential_invalid_reason: shown.reason,
        released_record_reason: change.record.invalidReason,
        release_cause: change.cause,
        shown_as: shown.shownAs,
        agent_live: Boolean(agent),
        credential_key_kind: providerLimitCredentialKeyKind(change.key),
        source_host: change.source.host,
        host: "oar",
      });
    }
  }

  /**
   * The held notice the agent shows while an invalid record it did not see
   * rejected itself holds it (another agent on its shared sign-in, on either
   * host, reported it): null when nothing holds it or it shows its own
   * error. Shown as its idle status (every "online"/"idle" frame while it is
   * held, `publish`), never as a runtime error: no `runtimeError` carrier, so
   * no `requiredAction` and no `AuthError` class, and not the `runtime_error`
   * detail kind, so the server neither stores it as the agent's runtime error
   * nor blocks its wakes.
   */
  private credentialInvalidHeldNotice(agent: HostedAgent): { text: string; noticeKey: string; record: CredentialInvalidRecord; key: ProviderLimitCredentialKey } | null {
    if (agent.credentialInvalidVisibility?.kind === "own_error") return null;
    const invalid = this.activeCredentialInvalid(agent);
    if (!invalid) return null;
    return {
      text: formatCredentialInvalidHeldNotice(agent.runtimeId, invalid.record, this.agentConfig(agent).model, providerLimitCredentialKeyKind(invalid.key) === "shared"),
      noticeKey: credentialInvalidNoticeKey(invalid.record),
      ...invalid,
    };
  }

  /** The agent now shows the held notice `notice`: remembered, and traced the first time for this record. */
  private noteCredentialInvalidHeldNoticeShown(
    agent: HostedAgent,
    notice: NonNullable<ReturnType<OarAgentHost["credentialInvalidHeldNotice"]>>,
    trigger: string,
  ): void {
    const current = agent.credentialInvalidVisibility;
    if (current?.kind === "notice" && current.noticeKey === notice.noticeKey) return;
    agent.credentialInvalidVisibility = { kind: "notice", noticeKey: notice.noticeKey };
    this.providerLimits.noteInvalidShown(notice.key, notice.record, {
      agentId: agent.agentId,
      host: "oar",
      reason: notice.record.invalidReason,
      shownAs: "notice",
    });
    this.deps.recordEvent("daemon.agent.credential_invalid.notice", {
      agentId: agent.agentId,
      runtime: agent.runtimeId,
      launchId: agent.launchId ?? undefined,
      notice: "shown",
      visible: true,
      trigger,
      credential_invalid_reason: notice.record.invalidReason,
      credential_key_kind: providerLimitCredentialKeyKind(notice.key),
      host: "oar",
    });
  }

  /**
   * Another agent's invalid record now holds this agent: it shows the held
   * notice now, once per record. A busy agent (or one in an error state)
   * shows it with its next idle status instead.
   */
  private publishCredentialInvalidHeldNotice(agent: HostedAgent, trigger: string): void {
    if (!this.isCurrent(agent) || !agent.committed || agent.last.activityKind !== "online") return;
    const notice = this.credentialInvalidHeldNotice(agent);
    if (!notice) return;
    const current = agent.credentialInvalidVisibility;
    if (current?.kind === "notice" && current.noticeKey === notice.noticeKey) return;
    this.noteCredentialInvalidHeldNoticeShown(agent, notice, trigger);
    this.publish(agent, "online", notice.text, "idle");
  }

  /**
   * The invalid record no longer holds the agent (`cause`): it stops showing
   * the held notice; an idle agent shows "Idle" again, a busy one's own frames
   * replace it. Its own error is left as it is: model output clears it.
   */
  private endCredentialInvalidHeldNotice(agent: HostedAgent, cause: string): void {
    const shown = agent.credentialInvalidVisibility;
    agent.credentialInvalidVisibility = null;
    if (shown?.kind !== "notice") return;
    this.deps.recordEvent("daemon.agent.credential_invalid.notice", {
      agentId: agent.agentId,
      runtime: agent.runtimeId,
      launchId: agent.launchId ?? undefined,
      notice: "cleared",
      visible: false,
      release_cause: cause,
      host: "oar",
    });
    if (this.isCurrent(agent) && agent.last.activityKind === "online") this.publish(agent, "online", "Idle", "idle");
  }

  /** Wait for the provider limit until `untilMs` (a later limit moves it); the wait's end flushes held deliveries. */
  private armProviderLimitWait(agent: HostedAgent, untilMs: number): void {
    const current = agent.providerLimitWait;
    if (current?.untilMs === untilMs) return;
    if (current) clearTimeout(current.timer);
    const timer = setTimeout(() => {
      if (agent.providerLimitWait?.timer === timer) this.endProviderLimitWait(agent);
    }, Math.max(1, untilMs - this.now()));
    timer.unref?.();
    agent.providerLimitWait = { untilMs, timer };
  }

  /** The wait is over: held deliveries go to the runtime (held again if a limit still runs). */
  private endProviderLimitWait(agent: HostedAgent): void {
    this.clearProviderLimitWait(agent);
    if (this.isCurrent(agent) && agent.committed && agent.session) void this.flushPending(agent, agent.session);
  }

  private clearProviderLimitWait(agent: HostedAgent): void {
    if (agent.providerLimitWait) clearTimeout(agent.providerLimitWait.timer);
    agent.providerLimitWait = null;
  }

  /**
   * Real model output (text, a tool call) from a turn that started at or
   * after the credential's limit was recorded: the account serves again, so
   * the limit ends for every agent on the credential, on both hosts. Output
   * from a turn already running when the limit was recorded proves nothing.
   */
  private releaseProviderLimitOnModelOutput(agent: HostedAgent, eventKind: string): void {
    this.releaseCredentialInvalidOnModelOutput(agent, eventKind);
    if (agent.turnStartedAtMs === null || !this.providerLimits.hasAny()) return;
    const key = this.credentialKey(agent);
    const record = this.providerLimits.get(key, this.now());
    if (!record || agent.turnStartedAtMs < record.recordedAtMs) return;
    this.deps.recordEvent("daemon.agent.runtime_error_delivery_backoff.reset", {
      agentId: agent.agentId,
      runtime: agent.runtimeId,
      launchId: agent.launchId ?? undefined,
      reason: record.reason,
      attempts: record.attempts,
      reset_source: eventKind,
      credential_key_kind: providerLimitCredentialKeyKind(key),
      provider_limit_cleared: true,
      release_cause: "model_output",
      host: "oar",
    });
    this.providerLimits.release(key, "model_output", { host: "oar", agentId: agent.agentId });
  }

  /**
   * Reconciler step 4a: model output from a turn started after the
   * credential was recorded invalid: it evidently works (for this model), so
   * it is valid again for every agent on it, on both hosts.
   */
  private releaseCredentialInvalidOnModelOutput(agent: HostedAgent, eventKind: string): void {
    const turnStartedAtMs = agent.turnStartedAtMs;
    if (turnStartedAtMs === null || !this.providerLimits.hasAnyInvalid()) return;
    const key = this.credentialKey(agent);
    const model = this.agentConfig(agent).model;
    const released = this.providerLimits.releaseInvalid(key, "model_output", { host: "oar", agentId: agent.agentId },
      (record) => credentialInvalidAppliesToModel(record, model) && turnStartedAtMs > record.recordedAtMs, turnStartedAtMs);
    if (released.length === 0) return;
    this.deps.recordEvent("daemon.agent.credential_invalid.cleared", {
      agentId: agent.agentId,
      runtime: agent.runtimeId,
      launchId: agent.launchId ?? undefined,
      reset_source: eventKind,
      release_cause: "model_output",
      credential_invalid_reason: released.map((each) => each.invalidReason).join(","),
      credential_key_kind: providerLimitCredentialKeyKind(key),
      host: "oar",
    });
  }

  /**
   * Reconciler step 4a: the agent now runs `config.model`; a
   * `user_model_access` record about another model on its own credential
   * applies to no one any more (`model_changed`). On a shared sign-in the
   * record stays for the agents still on that model.
   */
  private releaseCredentialInvalidForModelChange(agentId: string, config: AgentConfig): void {
    if (!this.providerLimits.hasAnyInvalid()) return;
    const key = providerLimitCredentialKey(agentId, config);
    if (providerLimitCredentialKeyKind(key) !== "agent") return;
    this.providerLimits.releaseInvalid(key, "model_changed", { host: "oar", agentId },
      (record) => record.invalidReason === "user_model_access" && !credentialInvalidAppliesToModel(record, config.model));
  }

  /**
   * task #379, as on the legacy host: an explicit stop (and so a manual
   * restart) is a human "try again". The limit on the agent's credential
   * ends, for every agent on a shared sign-in too, on both hosts; if the
   * account is still limited, the next request records it again.
   */
  private releaseProviderLimitForExplicitStop(agent: HostedAgent): void {
    const keys = new Set<ProviderLimitCredentialKey>([ownProviderLimitCredentialKey(agent.agentId), this.credentialKey(agent)]);
    // Reconciler step 4a, Q4: the manual Retry of an invalid credential.
    if (this.providerLimits.hasAnyInvalid()) {
      for (const key of keys) {
        const released = this.providerLimits.releaseInvalid(key, "explicit_stop", { host: "oar", agentId: agent.agentId });
        if (released.length === 0) continue;
        this.deps.recordEvent("daemon.agent.credential_invalid.cleared", {
          agentId: agent.agentId,
          runtime: agent.runtimeId,
          launchId: agent.launchId ?? undefined,
          reset_source: "explicit_stop",
          release_cause: "explicit_stop",
          credential_invalid_reason: released.map((each) => each.invalidReason).join(","),
          credential_key_kind: providerLimitCredentialKeyKind(key),
          host: "oar",
        });
      }
    }
    if (!this.providerLimits.hasAny()) return;
    for (const key of keys) {
      const record = this.providerLimits.release(key, "explicit_stop", { host: "oar", agentId: agent.agentId });
      if (!record) continue;
      this.deps.recordEvent("daemon.agent.runtime_error_delivery_backoff.reset", {
        agentId: agent.agentId,
        runtime: agent.runtimeId,
        launchId: agent.launchId ?? undefined,
        reason: record.reason,
        attempts: record.attempts,
        reset_source: "explicit_stop",
        release_cause: "explicit_stop",
        credential_key_kind: providerLimitCredentialKeyKind(key),
        provider_limit_cleared: true,
        host: "oar",
      });
    }
  }

  /** A server delivery: `true` once the host holds it (custody, as the legacy host acks what it queues). */
  deliverMessage(agentId: string, message: AgentMessage, context: AgentDeliveryContext = {}): boolean | Promise<boolean> {
    return this.hold(agentId, message, context, true);
  }

  /** `custody`: a server delivery, acked on hold; otherwise the result settles when the runtime takes it. */
  private hold(agentId: string, message: AgentMessage, context: AgentDeliveryContext, custody: boolean): boolean | Promise<boolean> {
    const agent = this.agents.get(agentId);
    if (!agent || agent.stopping) {
      context.onRejectedNoProcess?.();
      return false;
    }
    // task #26: held, written ahead of the next input; never a wake.
    if (isServerContextMessage(message)) return this.holdServerContext(agentId, message);
    // A server re-send is one delivery: matched by message id or, for one
    // without (a transient notice), by the server's delivery id.
    const id = message.message_id;
    const { deliveryId } = context;
    const now = this.now();
    const sameDelivery = Boolean(deliveryId && agent.delivered.has(deliveryId, now));
    if (sameDelivery || (id && agent.delivered.has(id, now))) {
      if (context.mentionDelivery && !sameDelivery) {
        // A new mention occurrence of a message the runtime already took: told.
        context.onMentionTransition?.("daemon_received", "accepted");
        context.onMentionTransition?.("daemon_drained", "accepted");
      }
      // The runtime already took it: ack again (the legacy host's
      // `duplicate_drained`), never send it again.
      context.onMentionAck?.();
      return true;
    }
    const held = [...agent.carried, ...agent.pending].find((delivery) =>
      (id && delivery.message.message_id === id) || (deliveryId && delivery.contexts.some((each) => each.deliveryId === deliveryId)));
    if (held) {
      if (context.mentionDelivery && !(deliveryId && held.contexts.some((each) => each.deliveryId === deliveryId))) {
        context.onMentionTransition?.("daemon_received", "accepted");
      }
      held.contexts.push(context);
      // The legacy host's `duplicate_pending`: the server stops re-sending.
      if (context.mentionDelivery) context.onMentionTransition?.("daemon_pending", "coalesced");
      return held.custody ? true : held.settled;
    }
    if (context.mentionDelivery) context.onMentionTransition?.("daemon_received", "accepted");
    const delivery = this.newDelivery(message, [context], { custody });
    // RFC 070 §6.5: a delivery inside the quiet period keeps the session.
    this.cancelWarmRecycle(agent, { reason: "delivery", senderKind: warmRecycleSenderKind(message.sender_type), triggerKind: String(messageTurnTriggerAttrs([message], now, () => undefined).trigger_kind) });
    agent.pending.push(delivery);
    if (agent.committed && agent.session) {
      void this.flushPending(agent, agent.session);
      // Reconciler step 9: a delivery held behind a turn makes the session's
      // health a question (stalled with work, `reconcileHealth`); a stall
      // replacement carries it to the next session.
      this.reconcile(agent, "delivery_arrived");
    } else {
      // Held for the launch in progress: the commit hands it over.
      this.reportHeld([delivery]);
    }
    return custody ? true : delivery.settled;
  }

  private newDelivery(message: AgentMessage, contexts: AgentDeliveryContext[], extra: Partial<Pick<Delivery, "custody" | "rawInput" | "firstInput" | "onAccepted" | "turnStart">> = {}): Delivery {
    let settle!: (accepted: boolean | Promise<boolean>) => void;
    const settled = new Promise<boolean>((resolve) => { settle = resolve; });
    return { message, contexts, custody: false, pendingReported: false, receivedAtMs: this.now(), settled, settle, ...extra };
  }

  /** The last context of a tracked mention: the server's newest re-send, which the transitions answer. */
  private mentionContext(delivery: Delivery): AgentDeliveryContext | undefined {
    return [...delivery.contexts].reverse().find((context) => context.mentionDelivery !== undefined);
  }

  /**
   * Deliveries that wait (for the commit or a turn end): a tracked mention
   * reports `daemon_pending` once, as the legacy host does when it queues
   * one, so the server stops re-sending it while it waits.
   */
  private reportHeld(deliveries: readonly Delivery[]): void {
    for (const delivery of deliveries) {
      if (delivery.pendingReported) continue;
      const mention = this.mentionContext(delivery);
      if (!mention) continue;
      delivery.pendingReported = true;
      mention.onMentionTransition?.("daemon_pending", "accepted");
    }
  }

  private pendingServerContext(agentId: string, sessionId: string): { body: string; writtenTo: Set<string> } | null {
    const context = this.heldServerContext.get(agentId);
    return context && !context.writtenTo.has(sessionId) ? context : null;
  }

  private holdServerContext(agentId: string, message: AgentMessage): true {
    const id = message.message_id ?? "server-context";
    const current = this.heldServerContext.get(agentId);
    if (current?.id !== id || current.body !== message.content) this.heldServerContext.set(agentId, { id, body: message.content, writtenTo: new Set() });
    this.deps.recordEvent("daemon.agent.server_context.held", { agentId, context_id: id, host: "oar" });
    return true;
  }

  /** One hand-off at a time; a request during one runs right after it. */
  private async flushPending(agent: HostedAgent, session: Session): Promise<void> {
    if (agent.flushing) {
      agent.flushAgain = true;
      return;
    }
    const held = agent.pending.length > 0;
    agent.flushing = true;
    try {
      do {
        agent.flushAgain = false;
        await this.handOff(agent, session);
      } while (agent.flushAgain && this.isCurrent(agent) && agent.session === session);
    } finally {
      agent.flushing = false;
    }
    // Server features: the held deliveries are gone (taken, or refused for good).
    if (held && agent.pending.length === 0) this.reconcile(agent, "delivery_consumed");
  }

  private isTransient(delivery: Delivery): boolean {
    return delivery.contexts.every((context) => context.transient === true);
  }

  /**
   * Hand held deliveries to the runtime as the legacy host formats them: a
   * transient or pre-rendered input alone; otherwise the run of ordinary
   * messages as rendered thread context and/or an inbox notice. Idle: a new
   * turn; busy: as the launch's `busyDelivery` says (`after_turn`: still
   * held until the turn end).
   */
  private async handOff(agent: HostedAgent, session: Session): Promise<void> {
    if (agent.pending.length === 0 || !this.isCurrent(agent) || agent.session !== session) return;
    const compaction = agent.turnEndCompaction.inFlight;
    if (compaction) {
      // Held behind the turn-end compaction, as behind a turn; handed over when it settles.
      compaction.heldSinceMs ??= this.now();
      return;
    }
    const hold = this.deliveryHold(agent);
    if (hold) {
      // #proj-raft-computer:#46: held (custody kept) until the credential's
      // limit ends or is released (the wait flushes them), or until its
      // invalid record is released (`onProviderLimitChange`).
      this.deps.recordEvent("daemon.agent.oar.delivery", {
        agentId: agent.agentId,
        launchId: agent.launchId ?? undefined,
        count: agent.pending.length,
        ...this.holdTraceAttrs(hold),
      });
      this.reportHeld(agent.pending);
      if (hold.kind === "provider_limit") this.armProviderLimitWait(agent, hold.record.untilMs);
      return;
    }
    if (this.drain.holds(agent.agentId)) {
      // Reconciler step 13: held (custody kept) until the drain ends (`releaseDrainHeld`).
      this.deps.recordEvent("daemon.agent.oar.delivery", {
        agentId: agent.agentId,
        launchId: agent.launchId ?? undefined,
        count: agent.pending.length,
        outcome: "held_for_drain",
      });
      this.reportHeld(agent.pending);
      return;
    }
    const first = agent.pending[0]!;
    const single = first.rawInput !== undefined || this.isTransient(first);
    const boundary = agent.pending.findIndex((delivery) => delivery.rawInput !== undefined || this.isTransient(delivery));
    const deliveries = single || agent.deliverSingly > 0 ? [first] : agent.pending.slice(0, boundary === -1 ? agent.pending.length : boundary);
    const messages = deliveries.map((delivery) => delivery.message);
    let input: AxSurfaceText | string;
    let rendered: AgentMessage[] = [];
    if (first.rawInput !== undefined) {
      input = first.rawInput;
    } else if (single) {
      input = formatSystemNoticeRuntimeInput(first.message, agent.driver);
    } else {
      const projection = this.projector(agent.agentId)(messages);
      rendered = projection.renderedContextMessages;
      const renderedSet = new Set(rendered);
      const noticeMessages = messages.filter((message) => !renderedSet.has(message));
      // The Server's latest `server:features` answer, else the start's config.
      const inboxOptions = inboxUpdateRenderOptions(agent.serverFeatures ?? agent.request.config);
      input = rendered.length > 0
        ? formatConcreteMessagesRuntimeInput(
          rendered,
          agent.driver,
          noticeMessages.length > 0 ? formatInboxUpdateRuntimeInput(noticeMessages, agent.driver, noticeMessages.length, inboxOptions) : undefined,
        )
        : formatInboxUpdateRuntimeInput(messages, agent.driver, messages.length, inboxOptions);
    }
    const serverContext = this.pendingServerContext(agent.agentId, session.id);
    const text = serverContext ? `${formatServerContextPrefix(serverContext.body)}${input}` : String(input);
    const idle = session.status().value.kind === "idle";
    const steers = agent.launch?.busyDelivery === "now" && session.steer !== undefined;
    const trace = (outcome: string, code?: RejectionCode, reason?: string | null, failure?: FailureClass) => this.deps.recordEvent("daemon.agent.oar.delivery", {
      agentId: agent.agentId,
      launchId: agent.launchId ?? undefined,
      count: deliveries.length,
      outcome,
      rendered_thread_context: rendered.length,
      ...(code ? { code } : {}),
      // The runtime's refusal as its class and fingerprint, never its text.
      ...(code ? refusalTraceAttrs(reason) : {}),
      // OAR's class of a refusal (`input_too_large`), where it gives one.
      ...(failure ? { oar_failure: failure } : {}),
    }, code ? "error" : "ok");
    if (!idle && !steers) {
      // `after_turn`: held here until the turn end flushes it as a new turn.
      // Never OAR's queue: grok's is held in this process only
      // (`queue.durable: false`), where the host can neither see nor
      // deduplicate it.
      trace("held_until_turn_end");
      this.reportHeld(agent.pending);
      return;
    }
    const steerHeld = !idle && steers ? this.steerHeldReason(agent) : null;
    if (steerHeld) {
      // Not into a compacting (or reviewing) turn, nor again after it refused
      // this turn's steers: the next tool start, compaction end or the turn
      // end hands it over.
      trace(steerHeld);
      this.reportHeld(agent.pending);
      return;
    }
    // The span of the turn this input starts (its `turn_started`): only an
    // idle session's; a steer into the running turn starts none.
    if (idle) agent.nextTurn = first.turnStart ?? this.turnStartFor("stdin-idle-delivery", messages, new Map(deliveries.map((delivery) => [delivery.message, delivery])));
    // Idle: a prompt, rejected `busy` if a turn started meanwhile (then held
    // like a busy delivery), never a steer into it.
    const inputId = randomUUID();
    let delivered: { landed: "prompted" | "steered" | "queued" } | { landed: "rejected"; code: RejectionCode; reason: string; failure?: FailureClass } = steers
      ? await session.deliver(text, { when: "now", origin: DELIVERY_ORIGIN, inputId })
      : await session.prompt(text, { origin: DELIVERY_ORIGIN }).then((outcome) => (outcome.kind === "accepted"
        ? { landed: "prompted" as const }
        : { landed: "rejected" as const, code: outcome.code, reason: outcome.reason, ...(outcome.failure ? { failure: outcome.failure } : {}) }));
    if (!this.isCurrent(agent) || agent.session !== session) return;
    // An `error` steer (e.g. OAR's 15 s deadline on grok's `_x.ai/interject`)
    // may have landed anyway: grok echoes an accepted interjection at once as
    // `_x.ai/session/interjection` carrying our inputId (Cindy, #oar-raft:#4).
    // With that echo it is delivered; resending would show it to the model twice.
    if (delivered.landed === "rejected" && delivered.code === "error" && steers && interjectionEchoed(session, inputId)) {
      delivered = { landed: "steered" };
    }
    // A refusal (or a steer after all) started no turn of its own.
    if (idle && delivered.landed !== "prompted") agent.nextTurn = null;
    const code: RejectionCode | null = delivered.landed === "rejected" ? delivered.code : null;
    const refusalReason = delivered.landed === "rejected" ? delivered.reason : null;
    trace(delivered.landed, code ?? undefined, refusalReason, delivered.landed === "rejected" ? delivered.failure : undefined);
    if (code === "busy" || code === "no_active_turn") {
      // Still held; the next turn end flushes it.
      this.reportHeld(deliveries);
      return;
    }
    if (code === "runtime_exited" || code === "disposed") {
      // Reconciler step 10b: the runtime is gone; its exit (`onExited`)
      // decides what becomes of them (the restart takes them, or the release
      // drops them), never this refusal.
      this.reportHeld(deliveries);
      return;
    }
    // Busy when it went in, or a turn opened while it did (a codex goal
    // continuation): a refusal then came from a steer.
    // An `error` steer with no echo (above): not delivered as far as the
    // runtime shows, so it is held like a refused steer and tried again, not
    // refused (handed back to be delivered again on the next start).
    if ((code === "runtime_refused" || code === "error") && steers && (!idle || session.status().value.kind !== "idle")) {
      // A steer the runtime refused (codex: "not steerable", e.g. mid-review)
      // is not a refusal of the message: it waits for the next tool start,
      // then for the turn end (the legacy host's
      // restoreRuntimeDeliveryAfterAsyncRejection).
      agent.steerHold.refusals += 1;
      this.reportHeld(deliveries);
      return;
    }
    if (code === "session_not_found") {
      // OAR 0.97 (#726): the runtime process no longer has this session
      // (codex `thread not found`); no later control on it can succeed. Its
      // native conversation may still resume, so this takes the idle-refusal
      // path: the deliveries stay held, the session ends and the agent starts
      // again on it once; a second time hands the agent to the Server.
      this.recoverIdleRefusal(agent, session, refusalReason ?? "session_not_found");
      return;
    }
    if (code === "runtime_refused") {
      // An idle session refused a prompt (codex: `turn/start` failed). Not a
      // refusal of the message: handing it back only has it offered again and
      // refused again, every few seconds, for as long as the session lives.
      this.recoverIdleRefusal(agent, session, refusalReason ?? "");
      return;
    }
    // OAR refused the input before sending it: longer than the runtime takes
    // at once (Antigravity's bound). Decided by OAR's `failure`, never its
    // code (`unsupported`) or its reason.
    const tooLong = delivered.landed === "rejected" && delivered.failure === "input_too_large";
    if (tooLong && deliveries.length > 1) {
      // Several held messages made it too long: still held, one at a time.
      agent.deliverSingly = deliveries.length;
      agent.flushAgain = true;
      return;
    }
    agent.pending = agent.pending.filter((delivery) => !deliveries.includes(delivery));
    if (agent.deliverSingly > 0) agent.deliverSingly -= 1;
    if (code) {
      for (const delivery of deliveries) this.refuse(delivery, code);
      if (tooLong) {
        this.publishMessageTooLarge(agent);
        // The messages after it were never offered.
        if (agent.pending.length > 0) agent.flushAgain = true;
      }
      return;
    }
    // Only a prompt an idle session took as a new turn shows the runtime takes
    // input again; a steer into a running turn does not (a session that keeps
    // refusing new turns could otherwise restart once per burst of messages).
    if (delivered.landed === "prompted") this.idleRefusalReopens.delete(agent.agentId);
    serverContext?.writtenTo.add(session.id);
    this.noteRendered(agent.agentId, rendered);
    const thirdPartyEventIds = thirdPartyEventIdsFromEvents(rendered);
    if (thirdPartyEventIds.length > 0) reportThirdPartyEventsDelivered(agent.agentId, thirdPartyEventIds);
    for (const delivery of deliveries) this.accept(agent, delivery);
    const ordinary = first.rawInput === undefined ? messages.filter((message) => !runtimeProfileNotificationFromMessage(message)) : [];
    if (ordinary.length > 0) this.publishMessageReceived(agent, ordinary, delivered.landed === "prompted");
    // More may have arrived while this input was in flight.
    if (agent.pending.length > 0) agent.flushAgain = true;
  }

  /**
   * An idle session refused a prompt with `runtime_refused`. The deliveries
   * stay held (custody kept). The first time, the session is ended and the
   * agent started again on it with them (as a stall replacement is); a
   * refusal again before any input is taken hands the agent to the server
   * (`runtime_repeated_failure`, reconciler step 12), whose start-failure
   * breaker pauses its wakes, so nothing offers the same input in a loop.
   */
  private recoverIdleRefusal(agent: HostedAgent, session: Session, reason: string): void {
    const { agentId } = agent;
    const label = runtimeDisplayName(agent.runtimeId);
    const again = this.idleRefusalReopens.has(agentId);
    this.deps.recordEvent("daemon.agent.oar.prompt_refused_recovery", {
      agentId,
      launchId: agent.launchId ?? undefined,
      runtime: agent.runtimeId,
      action: again ? "hand_to_server" : "reopen",
      held_count: agent.pending.length,
      host: "oar",
      ...refusalTraceAttrs(reason),
    }, "error");
    if (!again) {
      logger.warn(`[Agent ${agentId}] ${label} refused a prompt on an idle OAR session; ending it and starting again on it`);
      this.idleRefusalReopens.add(agentId);
      this.publish(agent, "working", `${label} refused a new message; restarting its session…`, "stalled_recovery");
      const { plan } = this.planEnd(agent, session, "stalled_recovery", null);
      this.restartAfterEnd(agent, plan, "prompt_refused", 0, () => { void this.endSession(agent, "spec_restart"); });
      return;
    }
    this.idleRefusalReopens.delete(agentId);
    logger.warn(`[Agent ${agentId}] ${label} refused a prompt again after its session was started again; handing the agent to the Server`);
    const detail = formatPromptRefusedAgainMessage(label, reason);
    const diagnostic = buildRuntimeErrorActivityDiagnostic(reason || detail);
    this.handStickyFailureToServer(agent, "runtime_repeated_failure", detail, "unknown", diagnostic);
  }

  /**
   * A message refused as too long for the runtime's one input: the agent's
   * people see what to do (shorten or split it), in Raft's words; the
   * session keeps running and takes the next message.
   */
  private publishMessageTooLarge(agent: HostedAgent): void {
    const detail = formatRuntimeMessageTooLargeMessage(agent.runtimeId);
    this.publish(agent, "error", detail, "runtime_error", [], buildRuntimeErrorActivityDiagnostic(detail, { errorClass: "MessageTooLargeError" }));
  }

  /** Why a steer into the running turn waits, or null to steer now. */
  private steerHeldReason(agent: HostedAgent): string | null {
    if (agent.steerHold.compacting) return "held_while_compacting";
    if (agent.codexActivity?.inReview) return "held_while_reviewing";
    if (agent.steerHold.refusals >= STEER_REFUSALS_PER_TURN) return "held_after_steer_refusals";
    return null;
  }

  /**
   * The runtime took it: remember it for dedup; a tracked mention is
   * `daemon_drained` and acked once (the legacy host's
   * `completeTrackedMentionDelivery`).
   */
  private accept(agent: HostedAgent, delivery: Delivery): void {
    const now = this.now();
    if (delivery.message.message_id) agent.delivered.remember(delivery.message.message_id, now);
    for (const context of delivery.contexts) if (context.deliveryId) agent.delivered.remember(context.deliveryId, now);
    const mention = this.mentionContext(delivery);
    if (mention) {
      mention.onMentionTransition?.("daemon_drained", "accepted");
      mention.onMentionAck?.();
    }
    delivery.onAccepted?.();
    delivery.settle(true);
  }

  /**
   * The runtime refused it for good (not busy), or it goes with the runtime.
   * A plain server delivery was acked on custody: it stays unread on the
   * server for the next start, with nothing to send. A tracked mention is
   * answered once (no process, or rejected), unless `answerMention` is false
   * (a stop: as on the legacy host, the server's held cycle settles it); the
   * host's own inputs settle false.
   */
  private refuse(delivery: Delivery, code: RejectionCode, { answerMention = true }: { answerMention?: boolean } = {}): void {
    const gone = code === "runtime_exited" || code === "disposed";
    const mention = this.mentionContext(delivery);
    if (mention && answerMention) {
      // An exit planned for the next wake: the rejection lets the server
      // wake the agent again (step 10b keeps this fallback; a restart of the
      // host's own took the delivery out before).
      if (gone) mention.onRejectedNoProcess?.();
      else mention.onMentionTerminalError?.("DELIVERY_REJECTED");
    }
    if (!delivery.custody && gone) {
      for (const context of delivery.contexts) if (!context.mentionDelivery) context.onRejectedNoProcess?.();
    }
    delivery.settle(false);
  }

  /** A daemon release notice, delivered as a system notice and acked once the runtime takes it. */
  deliverRuntimeProfileNotification(
    agentId: string,
    key: string,
    kind: "migration" | "daemon_release_notice",
    content: string,
    traceparent?: string,
    launchId?: string | null,
  ): boolean | Promise<boolean> {
    if (kind !== "daemon_release_notice") return false;
    const message: AgentMessage = {
      channel_id: "system",
      channel_name: "system",
      channel_type: "dm",
      sender_id: "system",
      sender_name: "system",
      sender_type: "system",
      content,
      timestamp: new Date(this.now()).toISOString(),
      message_id: `${RUNTIME_PROFILE_DAEMON_NOTICE_MESSAGE_PREFIX}${key}`,
      ...(traceparent ? { traceparent } : {}),
    };
    // Acked to the server once the runtime takes it, as the legacy host acks an injected notice.
    return Promise.resolve(this.hold(agentId, message, { transient: true }, false)).then((accepted) => {
      if (accepted) {
        this.deps.sendToServer({
          type: "agent:runtime_profile:daemon_release_notice:ack",
          agentId,
          noticeKey: key,
          ...(launchId ? { launchId } : {}),
          ...(traceparent ? { traceparent } : {}),
        });
      }
      return accepted;
    });
  }

  /** The app Inbox gained an item: tell the running session once per item, as the legacy host does. */
  async notifyAgentAppInbox(agentId: string, _item: AgentInboxAppItem, noticeOptions?: AgentAppInboxNoticeOptions): Promise<boolean> {
    const agent = this.agents.get(agentId);
    if (!agent || agent.stopping) return false;
    const items = this.deps.appInboxForAgent?.(agentId).list() ?? [];
    if (items.length === 0) return false;
    const undelivered = items.filter((item) => !appInboxItemNoticed(agent.appNoticedItems, item));
    if (undelivered.length === 0) return true;
    if (noticeOptions?.requireIdle && agent.session?.status().value.kind === "running") return true;
    const message: AgentMessage = {
      channel_id: "app-inbox",
      channel_name: "app-inbox",
      channel_type: "dm",
      sender_id: "system",
      sender_name: "system",
      sender_type: "system",
      content: "",
      timestamp: new Date(this.now()).toISOString(),
    };
    const delivery = this.newDelivery(message, [{}], {
      rawInput: appInboxNoticeText({
        items,
        undelivered,
        // The messages this host holds for the agent: what its message wake-ups count.
        pendingMessages: agent.pending.filter((pending) => pending.rawInput === undefined && !this.isTransient(pending)).length,
        driver: agent.driver,
        options: inboxUpdateRenderOptions(agent.serverFeatures ?? agent.request.config),
        inboxItemsLaunchAtMs: inboxItemsLaunchAtMs(agent.serverFeatures ?? agent.request.config),
        nowMs: this.now(),
      }),
      onAccepted: () => { for (const item of items) agent.appNoticedItems.set(item.itemId, item.createdAtMs); },
      turnStart: { reason: "app-inbox-notice", attrs: appInboxTurnTriggerAttrs(undelivered, this.now()) },
    });
    this.cancelWarmRecycle(agent, { reason: "delivery", senderKind: "app", triggerKind: String(appInboxTurnTriggerAttrs(undelivered, this.now()).trigger_kind) });
    agent.pending.push(delivery);
    if (agent.committed && agent.session) void this.flushPending(agent, agent.session);
    return delivery.settled;
  }

  /** Idle task reminder: the committed session, or null. Its running subagents are its background tasks; blocked while the credential is at a provider limit. */
  idleNoticeFacts(agentId: string): AgentIdleNoticeFacts | null {
    const agent = this.agents.get(agentId);
    if (!agent || agent.stopping || !agent.committed || !agent.session) return null;
    const sessionId = agent.session.id;
    const resumeSessionId = (agent.runtimeConfig ?? agent.request.config).sessionId ?? null;
    return {
      sessionId,
      launchId: agent.launchId,
      resumed: Boolean(resumeSessionId) && sessionId === resumeSessionId,
      backgroundTasks: agent.taskRows.runningCount(),
      blocked: this.deliveryHold(agent) !== null,
      deliveriesPending: agent.pending.length > 0 || agent.flushing,
    };
  }

  /**
   * Idle task reminder: handed over as a pre-rendered input only while the
   * session is idle with nothing held (held deliveries go first); otherwise
   * nothing is kept. Settles when the runtime takes it.
   */
  async deliverIdleNotice(agentId: string, text: string): Promise<AgentIdleNoticeDelivery> {
    const agent = this.agents.get(agentId);
    if (!agent || agent.stopping || !agent.committed || !agent.session) return "not_running";
    if (agent.session.status().value.kind !== "idle") return "busy";
    // Reconciler step 13: a drain starts no turn for a reminder; the end of the drain asks for it again.
    if (this.drain.holds(agentId)) {
      this.drainRefusedIdleNotices.add(agentId);
      return "busy";
    }
    if (agent.pending.length > 0 || agent.flushing) return "messages_pending";
    return (await this.deliverHostInput(agent, agent.session, "idle-task-reminder", text)) ? "written" : "write_failed";
  }

  /**
   * A pre-rendered input the host writes itself (an idle task reminder, the
   * sub-agents-finished wake), handed over alone as a delivery of its own.
   * Settles true when the runtime takes it.
   */
  private deliverHostInput(agent: HostedAgent, session: Session, channel: string, text: string): Promise<boolean> {
    const message: AgentMessage = {
      channel_id: channel,
      channel_name: channel,
      channel_type: "dm",
      sender_id: "system",
      sender_name: "system",
      sender_type: "system",
      content: "",
      timestamp: new Date(this.now()).toISOString(),
    };
    const delivery = this.newDelivery(message, [{}], { rawInput: text, turnStart: { reason: channel, attrs: { trigger_kind: "wake_hint" } } });
    this.cancelWarmRecycle(agent, { reason: "delivery", senderKind: "daemon", triggerKind: "wake_hint" });
    agent.pending.push(delivery);
    void this.flushPending(agent, session);
    return delivery.settled;
  }

  purgeInboxMessagesForChannels(agentId: string, channelIds: readonly string[], _reason?: string): { removedCount: number } {
    const agent = this.agents.get(agentId);
    if (!agent) return { removedCount: 0 };
    const channels = new Set(channelIds);
    const purged = agent.pending.filter((delivery) => channels.has(delivery.message.channel_id));
    agent.pending = agent.pending.filter((delivery) => !channels.has(delivery.message.channel_id));
    // The server asked for these to go: settle them so it stops redelivering.
    for (const delivery of purged) {
      for (const context of delivery.contexts) {
        if (context.mentionDelivery) context.onMentionTerminalError?.("DELIVERY_REJECTED");
      }
      delivery.settle(true);
    }
    // Server features: held deliveries went away untold.
    if (purged.length > 0) this.reconcileSpec(agent, "delivery_consumed");
    return { removedCount: purged.length };
  }

  /**
   * Reconciler step 6, row A2: the Server's current server features (the
   * router hands every answer to both hosts). Each agent here should now run
   * with them; a session that started on other values is ended once it is
   * idle (`reconcileSpec`). Nothing else changes here: this host never
   * restarts an agent itself, and the Server's next start carries its current
   * values (that start tells the agent nothing of the change; the legacy
   * host's notice is not wired here).
   */
  applyServerFeatures(features: AgentServerFeatures): void {
    for (const agent of [...this.agents.values()]) {
      agent.serverFeatures = features;
      this.reconcile(agent, "signal");
    }
  }

  /**
   * Reconciler steps 6 and 7 (rules 6 and 7), as the legacy host decides it
   * (its reconcileSpec): a committed session that started on a runtime spec
   * other than its request's config (runtimeSpecDrift), or on server
   * features its runtime would render differently than the ones it should
   * run with now (serverFeaturesDrift), is ended on purpose once it is idle
   * (agentIdle.ts), session kept on the server for the next start to resume
   * (unless it started on another runtime or Codex model: that start drops
   * it, SessionSpecMemory); not idle, it is left alone and the fact that
   * makes it idle calls this again (a turn end, held deliveries gone), with a
   * sweep while any is held as the backstop. Nothing is stored between
   * calls; `trigger` is only traced. Returns whether the session has drifted.
   */
  private reconcileSpec(agent: HostedAgent, trigger: RuntimeSpecReconcileTrigger): boolean {
    const featureKeys = agent.serverFeatures && agent.runtimeConfig
      ? serverFeaturesDrift(pickAgentServerFeatures(agent.runtimeConfig), agent.serverFeatures, {
        supportsSubagents: agent.driver.supportsSubagents === true,
        rotatesSessions: false,
      })
      : [];
    const drift: RuntimeSpecDriftKind[] = agent.startedSpec ? runtimeSpecDrift(agent.startedSpec, runtimeSpecOf(agent.request.config)) : [];
    if (featureKeys.length > 0) drift.push("features");
    if (agent.credentialAccountChanged) drift.push("credential_account");
    if (drift.length === 0) {
      this.idleHolds.forget(agent.agentId, "spec_restart");
      return false;
    }
    const session = agent.session;
    // Not started yet (its commit decides nothing: the first turn end does), or already ending.
    if (!this.isCurrent(agent) || !agent.committed || !session) return true;
    // Reconciler step 15: deliveries held for the old account wait for the next session, not this one;
    // so do those of a drift that drops the session (another runtime, or a Codex model), else a
    // delivery held for the old runtime's usage limit holds the switch until that limit resets (#triage:#263).
    const nextSessionTakesInbox = drift.includes("credential_account")
      || (agent.startedSpec !== null && agent.startedSpec !== undefined && sessionDropReason(agent.startedSpec, runtimeSpecOf(agent.request.config)) !== null);
    const notIdle = this.agentNotIdle(agent, session, nextSessionTakesInbox ? { ignoreUntoldInbox: true } : {});
    const long = this.idleHolds.observe(agent.agentId, agent.processInstanceId, "spec_restart", notIdle, this.now());
    if (long) {
      this.deps.recordEvent("daemon.agent.idle_hold_long", {
        agentId: agent.agentId,
        launchId: agent.launchId ?? undefined,
        runtime: agent.runtimeId,
        gate: long.gate,
        reason: long.reason,
        held_ms: long.heldMs,
        host: "oar",
      });
    }
    if (notIdle !== null) {
      this.armReconcileSweep();
      return true;
    }
    // Kinds only: never an env var's (or any other) key or value.
    this.deps.recordEvent("daemon.agent.spec_restart_stop", {
      agentId: agent.agentId,
      launchId: agent.launchId ?? undefined,
      session_id: session.id,
      drift: drift.join(","),
      ...(featureKeys.length > 0 ? { changed_keys: featureKeys.join(",") } : {}),
      trigger,
      host: "oar",
    });
    logger.info(`[Agent ${agent.agentId}] Ending idle OAR session for a new runtime spec (${drift.join(", ")}; session ${session.id}, ${trigger}); the next start runs on it`);
    // Reconciler step 10b: planned as the legacy host's spec (cold-idle) stop:
    // clean, and idle with nothing held, the next wake.
    const { plan } = this.planEnd(agent, session, "cold_idle_recycle", null);
    if (drift.includes("credential_account") && plan.start === "now" && (agent.pending.length > 0 || agent.carried.length > 0)) {
      // Reconciler step 15: held deliveries the old account could not run
      // start the agent again at once on the same session (the stall
      // replacement's restart), as the legacy host's close does.
      this.restartAfterEnd(agent, plan, "credential_account", 0, () => { void this.endSession(agent, "spec_restart"); });
      return true;
    }
    // As a stop that keeps the session: no status or activity; the next
    // delivery finds no process and the Server starts the agent again. That
    // refusal (the legacy host's) reports a start, not a runtime that needs
    // a restart (reconciler step 11c).
    this.specHandbacks.mark(agent.agentId);
    void this.endSession(agent, "spec_restart");
    return true;
  }

  /**
   * Reconciler step 8a (`chooseSession`): `config` without its session when
   * it started on another runtime, or is a Codex session that started on
   * another model (step 7, SessionSpecMemory, either host's): this start
   * opens a new one. Traced with the reason only. The OAR host has no
   * stuck-session refusal (task #10): no runtime it hosts keeps compaction
   * failures on the session.
   */
  private withoutSessionStartedOnOtherSpec(agent: HostedAgent, config: AgentConfig): AgentConfig {
    if (!config.sessionId) return config;
    const choice = chooseSession({
      sessionId: config.sessionId,
      // #oar-raft:#10: a Cursor CLI session cannot be resumed by the Cursor SDK.
      specDrop: this.sessionSpecs.sessionToDrop(agent.agentId, config.sessionId, runtimeSpecOf(config))
        ?? runtimeHostSessionDrop(config.runtime, config.sessionId, "oar"),
    });
    if (choice.kind !== "new" || choice.reason !== "spec_drop") return config;
    const reason = choice.dropReason;
    logger.info(`[Agent ${agent.agentId}] Not resuming session ${config.sessionId}: it started on ${sessionDropReasonText(reason)}; a new session starts`);
    this.deps.recordEvent("daemon.agent.session_dropped_for_spec", { agentId: agent.agentId, launchId: agent.launchId ?? undefined, reason, host: "oar" });
    if (reason === "runtime_host_changed") this.noteCursorSessionMigrated(agent, config.sessionId);
    return { ...config, sessionId: null };
  }

  /**
   * #oar-raft:#10: the agent's Cursor CLI session is left behind because
   * Cursor now runs through the SDK. Reported at the commit
   * (`reportCursorSessionMigrated`).
   */
  private noteCursorSessionMigrated(agent: HostedAgent, sessionId: string): void {
    agent.migratedFromSessionId = sessionId;
  }

  /**
   * #oar-raft:#10, at the commit of a session that replaced a Cursor CLI
   * session: not an error. The server forgets the old session, and the
   * agent's Activity Log says a new session started because of the move.
   * Once per old session in this daemon (a restart of the same start plans
   * it again); after that the server holds the SDK's session.
   */
  private reportCursorSessionMigrated(agent: HostedAgent): void {
    const notice = agent.sessionNotice;
    if (notice) {
      agent.sessionNotice = undefined;
      this.publish(agent, "working", "Starting a new session…", "starting", [notice]);
    }
    const sessionId = agent.migratedFromSessionId;
    if (!sessionId) return;
    agent.migratedFromSessionId = undefined;
    const key = `${agent.agentId}\u0000${sessionId}`;
    if (this.cursorMigrationsNoted.has(key)) return;
    this.cursorMigrationsNoted.add(key);
    if (this.cursorMigrationsNoted.size > CURSOR_MIGRATIONS_NOTED_MAX) {
      const oldest = this.cursorMigrationsNoted.values().next().value;
      if (oldest !== undefined) this.cursorMigrationsNoted.delete(oldest);
    }
    this.deps.recordEvent("daemon.agent.oar.cursor_session_migrated", { agentId: agent.agentId, launchId: agent.launchId ?? undefined, runtime: "cursor" });
    this.deps.sendToServer({ type: "agent:session:invalidate", agentId: agent.agentId, sessionId, ...(agent.launchId ? { launchId: agent.launchId } : {}), reason: "runtime_host_migration" });
    this.publish(agent, "working", "Starting a new Cursor session…", "starting", [{
      kind: "system",
      title: "New Cursor session",
      text: CURSOR_SESSION_MIGRATED_TEXT,
    }]);
  }

  /** The agentIdle.ts facts of a committed session: its running subagents are background tasks; a handover in flight is a delivery in flight. */
  private agentNotIdle(agent: HostedAgent, session: Session, options: AgentIdleOptions = {}): AgentNotIdleReason | null {
    const idle = this.agentIdleFacts(agent, session, options);
    return agentNotIdleReason(idle.facts, idle.options);
  }

  /** A stop-wait's predicate (agentStopWaitReason, a drain's quiet): idle, or not runnable with no turn in flight. */
  private agentStopWait(agent: HostedAgent, session: Session, options: AgentIdleOptions = {}): AgentStopWait {
    const idle = this.agentIdleFacts(agent, session, options);
    return agentStopWaitReason(idle.facts, this.agentRunnableFacts(agent, true), idle.options);
  }

  /**
   * agentNotRunnableReason's facts: an invalid record or an exhausted quota
   * on the agent's credential (the ledger both hosts share). This host has
   * no runtime binding fence: a runtime change ends its session (reconcileSpec).
   */
  private agentRunnableFacts(agent: HostedAgent, processAlive: boolean): AgentRunnableFacts {
    const limit = this.activeProviderLimit(agent);
    return {
      processAlive,
      credentialInvalid: this.activeCredentialInvalid(agent) !== null,
      // Hopeless only if it outlasts any drain; a short wait is merely slow.
      quotaExhausted: limit?.record.providerLimitKind === "quota_exhausted" && limit.record.untilMs - this.now() >= AGENT_DRAIN_MAX_DEADLINE_MS,
      runtimeMismatch: false,
    };
  }

  /** The agentIdle.ts facts of a committed session, and the options they are read with. */
  private agentIdleFacts(agent: HostedAgent, session: Session, options: AgentIdleOptions): { facts: AgentIdleFacts; options: AgentIdleOptions } {
    // A delivery held for the agent's credential (a provider limit's wait, an
    // invalid credential) is no work this session is doing or about to do;
    // counting it held every idle-gated step until the limit reset (#triage:#263).
    if (this.deliveryHold(agent) !== null) options = { ...options, ignoreUntoldInbox: true };
    return {
      facts: {
        turnEnded: session.status().value.kind === "idle",
        backgroundTasks: agent.taskRows.runningCount(),
        unconsumedStdin: agent.flushing ? 1 : 0,
        // Never written into a running turn behind OAR's back: an after_turn
        // launch holds it here, a steer goes into the turn OAR reports running.
        queuedInputPending: false,
        untoldInbox: agent.pending.length > 0 || agent.carried.length > 0,
        // A tracked mention is settled when the runtime takes it; one not taken is still held.
        trackedMentionOpen: false,
      },
      options,
    };
  }

  /**
   * Reconciler step 13 (agentDrain.ts): hold deliveries, reminders, notices
   * and spawns, and resolve once every committed session is quiet or the
   * deadline passed. Stops nothing.
   */
  beginDrain(options: AgentDrainOptions): Promise<AgentDrainSummary> {
    return this.drain.begin(options);
  }

  /** Reconciler step 13: stop holding; held deliveries are handed over, held starts spawn. Step 14: `agentId` ends that agent's drain only. */
  endDrain(agentId?: string): void {
    this.drain.end(agentId);
  }

  /** Reconciler step 13: the drain's progress now (the machine-wide one, or `agentId`'s); null when that drain does not hold. */
  drainProgress(agentId?: string): AgentDrainProgress | null {
    return this.drain.progress(agentId);
  }

  /**
   * Committed sessions that are not quiet (idle without the held deliveries;
   * one that cannot run with no turn in flight is quiet, agentStopWaitReason),
   * and launches past the drain's hold (spawning: their first turn comes,
   * unless the agent cannot run). A start held before its spawn, or one
   * being stopped, is not waited for.
   */
  private computeDrainProgress(only: string | null): AgentDrainProgress {
    const notQuiet: AgentDrainNotQuiet[] = [];
    const notRunnable: AgentDrainNotRunnable[] = [];
    let live = 0;
    for (const agent of this.agents.values()) {
      if (only !== null && agent.agentId !== only) continue;
      if (agent.stopping) continue;
      if (agent.committed && agent.session) {
        live += 1;
        const wait = this.agentStopWait(agent, agent.session, { ignoreUntoldInbox: true });
        if (wait.notIdle) notQuiet.push({ agentId: agent.agentId, reason: wait.notIdle });
        else if (wait.notRunnable && wait.settled) notRunnable.push({ agentId: agent.agentId, reason: wait.notRunnable, settled: wait.settled });
      } else if (agent.pastDrainHold) {
        live += 1;
        // No turn runs yet: a first turn that cannot run is not waited for.
        const reason = agentNotRunnableReason(this.agentRunnableFacts(agent, true));
        if (reason) notRunnable.push({ agentId: agent.agentId, reason, settled: "agent_busy" });
        else notQuiet.push({ agentId: agent.agentId, reason: "agent_busy" });
      }
    }
    return { live, notQuiet, notRunnable };
  }

  /**
   * The drain ended without a shutdown: the held deliveries are handed over
   * as at a turn end (the dedup by message id drops one the runtime already
   * took); the held starts go on by themselves (`startsReleased`).
   * Step 14 (`only`, a /migrate source): that agent's only; one the
   * migration stopped first has nothing left here to hand over.
   */
  private releaseDrainHeld(only: string | null): void {
    let flushed = 0;
    for (const agent of [...this.agents.values()]) {
      if (only !== null && agent.agentId !== only) continue;
      if (!this.isCurrent(agent) || !agent.committed || !agent.session || agent.pending.length === 0) continue;
      flushed += 1;
      void this.flushPending(agent, agent.session);
    }
    // An idle agent whose reminder the drain refused: one more idle edge
    // (notifyWorkingToIdle skips one that is no longer idle with nothing held).
    const refusedReminders = [...this.drainRefusedIdleNotices].filter((agentId) => only === null || agentId === only);
    for (const agentId of refusedReminders) this.drainRefusedIdleNotices.delete(agentId);
    let remindersAskedAgain = 0;
    for (const agentId of refusedReminders) {
      const agent = this.agents.get(agentId);
      if (!agent || !this.isCurrent(agent) || !agent.committed || !agent.session) continue;
      if (agent.pending.length > 0 || agent.flushing || agent.session.status().value.kind !== "idle") continue;
      remindersAskedAgain += 1;
      this.notifyWorkingToIdle(agent, agent.session);
    }
    this.deps.recordEvent("daemon.agent.drain.released", { host: "oar", flushed_agents: flushed, reminders_asked_again: remindersAskedAgain, ...(only === null ? {} : { agentId: only }) });
  }

  /**
   * The backstop for a held session whose idle edge was missed, for a
   * session with deliveries waiting whose stall deadline was missed, and for
   * a session that may turn cold idle (`coldIdleCandidate`: a session turns
   * cold with no event); runs only while one is.
   */
  private armReconcileSweep(): void {
    if (this.reconcileSweep) return;
    this.reconcileSweep = setInterval(() => {
      let held = false;
      for (const agent of [...this.agents.values()]) {
        const specHeld = this.reconcile(agent, "sweep");
        if (this.isCurrent(agent) && (specHeld || (agent.committed && agent.pending.length > 0) || this.coldIdleCandidate(agent))) held = true;
      }
      if (!held) this.clearReconcileSweep();
    }, Math.max(1, this.deps.featuresSweepMs ?? COLD_IDLE_SWEEP_MS));
    this.reconcileSweep.unref?.();
  }

  private clearReconcileSweep(): void {
    if (this.reconcileSweep) clearInterval(this.reconcileSweep);
    this.reconcileSweep = null;
  }

  /**
   * The one reconcile entry of a committed session (reconciler steps 6, 7
   * and 9): health first, then the runtime spec. A session stalled with
   * deliveries waiting is ended at once and started again for them
   * (`reconcileHealth`); one that drifted from its spec is ended once idle
   * (`reconcileSpec`). `trigger` is only traced. Returns whether the session
   * has drifted from its spec (the sweep keeps running for it).
   */
  private reconcile(agent: HostedAgent, trigger: RuntimeSpecReconcileTrigger): boolean {
    // Reconciler step 13: every edge that can make a session idle can make it quiet.
    this.drain.check();
    if (this.reconcileHealth(agent, trigger)) return false;
    const specHeld = this.reconcileSpec(agent, trigger);
    // RFC 070 step 8b on this host (#proj-runtime:#54): a spec stop goes first.
    if (!specHeld) this.reconcileColdIdle(agent, trigger);
    return specHeld;
  }

  /**
   * Wake recycle reaches a long-lived session only through a start, so a
   * cold session is ended (RFC 070 step 8b, the legacy host's cold-idle
   * stop): idle past the cold gap, context past the threshold, by the
   * session summary's facts, and idle as the legacy host reads it (no turn,
   * background task or sub-agent, delivery held or being written), never
   * while compacting. The session is kept: the next delivery finds no
   * process, the Server starts the agent, and the start's recycle decision
   * (planWakeSessionRecycle, from the same summary) starts it fresh with a
   * briefing. Only while the Server's `wake_recycle_oar` is on for the agent,
   * for the runtimes whose summary supplies the facts (Codex, Grok).
   */
  private reconcileColdIdle(agent: HostedAgent, trigger: RuntimeSpecReconcileTrigger): void {
    const session = agent.session;
    if (!session || !this.coldIdleCandidate(agent)) {
      this.idleHolds.forget(agent.agentId, "cold_idle");
      return;
    }
    // A session turns cold with no event: the sweep looks again while it may.
    this.armReconcileSweep();
    if (agent.steerHold.compacting) return;
    const config = this.agentConfig(agent);
    const facts = sessionSummaryResumeFacts(agent.summary?.current() ?? null, session.id);
    // Unknown facts (no context reported yet, a turn running) are never cold.
    if (!facts || facts.lastActivityAtMs === null) return;
    const nowMs = this.now();
    const gate = coldIdleGate({ config, liveSessionId: session.id, lastEventAtMs: facts.lastActivityAtMs, runtimeCliVersion: undefined, nowMs });
    if (!gate.pass) return;
    if (this.agentNotIdle(agent, session) !== null) return;
    // Ending the session kills its sub-agents, so a task with no end holds it
    // however long it has been silent (the idle reminder presumes a silent hour
    // ended; this host has no process-tree check to confirm it). A lost end
    // only costs this session its recycle.
    if (agent.taskRows.runningCount(Number.POSITIVE_INFINITY) > 0) return;
    const verdict = decideColdIdle(facts, { config: gate.config, lastEventAtMs: facts.lastActivityAtMs, nowMs });
    if (!verdict.cold) return;
    this.deps.recordEvent("daemon.agent.cold_idle_stop", {
      agentId: agent.agentId,
      launchId: agent.launchId ?? undefined,
      session_id: session.id,
      idle_ms: verdict.idleMs,
      prior_context_tokens: verdict.priorContextTokens,
      ...recycleThresholdTraceAttrs(verdict.thresholds),
      notified_unread_count: 0,
      trigger,
      host: "oar",
    });
    logger.info(`[Agent ${agent.agentId}] Ending cold idle OAR session (idle ${Math.round(verdict.idleMs / 60_000)}m, ~${Math.round(verdict.priorContextTokens / 1000)}k context, session ${session.id}, ${trigger}); the next wake decides resume vs fresh briefing`);
    // Planned as the spec stop is: clean, the session kept, and the next
    // delivery's start is the Server's (no status, no activity).
    this.planEnd(agent, session, "cold_idle_recycle", null);
    this.specHandbacks.mark(agent.agentId);
    void this.endSession(agent, "cold_idle_recycle");
  }

  /** Whether the sweep should keep looking at this session for cold idle (reconcileColdIdle's cheap half). */
  private coldIdleCandidate(agent: HostedAgent): boolean {
    if (!this.isCurrent(agent) || !agent.committed || !agent.session || agent.stopping) return false;
    if (!WAKE_RECYCLE_SUMMARY_FACTS_RUNTIMES.has(agent.runtimeId)) return false;
    const config = this.agentConfig(agent);
    const features = agent.serverFeatures ?? pickAgentServerFeatures(config);
    if (features.wakeRecycleOar !== true) return false;
    return resolveWakeRecycleConfig(config.envVars).enabled;
  }

  /**
   * Reconciler step 9 (rule 3, E2; rows C14 and D6): the session's health,
   * decided by the legacy host's own rule (stalledWithWork.ts) from OAR's
   * facts (`stalledWithWorkFacts`). Broken (stalled with deliveries waiting)
   * ends the session at once, whatever its turn, and starts the agent again
   * on it with those deliveries (`replaceStalledSession`). Not broken with
   * only time missing arms the one stall deadline; deliveries waiting keep
   * the sweep running. Returns whether a stall replacement began.
   */
  private reconcileHealth(agent: HostedAgent, trigger: RuntimeSpecReconcileTrigger): boolean {
    const session = agent.session;
    if (!this.isCurrent(agent) || !agent.committed || !session) {
      this.clearStallDeadline(agent);
      return false;
    }
    const facts = this.stalledWithWorkFacts(agent, session);
    const verdict = stalledWithWork(facts, this.stallThresholds);
    if (!verdict.broken) {
      if (verdict.deadlineInMs !== undefined) this.armStallDeadline(agent, session, verdict.deadlineInMs);
      else this.clearStallDeadline(agent);
      if (facts.inboxLength > 0) this.armReconcileSweep();
      return false;
    }
    this.clearStallDeadline(agent);
    const streak = this.stalledReplacements.get(agent.agentId);
    if (streak.count >= STALLED_REPLACEMENT_MAX_STREAK) {
      this.giveUpStalledReplacement(agent, trigger, streak, facts.staleForMs);
      return false;
    }
    this.replaceStalledSession(agent, session, trigger, facts.staleForMs, this.stalledReplacements.note(agent.agentId));
    return true;
  }

  /**
   * stalledWithWork's facts, read from OAR. A fact OAR cannot give counts as
   * not stalled (prefer holding a session longer over killing a long tool):
   * - inbox: the deliveries this host holds for the session (`pending`);
   *   nothing is ever written behind OAR's back (`after_turn` holds busy
   *   deliveries here, a steer that lands is taken).
   * - turn: OAR's status is `running`; a stop underway: this host ends the
   *   session, or a turn abort is in flight (OAR's `stop.pendingAbortIds`).
   * - holds: the credential's provider limit (and its wait) or invalid record.
   * - delivery mode: a launch that steers (`busyDelivery: "now"`) takes input
   *   into a running turn as a stdin runtime does (`direct`); `after_turn`
   *   holds it for the next turn, as a non-stdin runtime (alive: no exit seen,
   *   which would have released the agent), so the longer alive threshold
   *   applies and any open tool holds it.
   * - open tools: the root's tool calls started and not ended. No diagnostic
   *   snapshots and no stdin-broken evidence on OAR: an open tool is never
   *   proven idle.
   * - silence: since OAR status's `lastEventAt` (the receipt of the session's
   *   latest record, child agents' included, the same clock as the
   *   "No runtime output" report), never before the turn's start.
   */
  private stalledWithWorkFacts(agent: HostedAgent, session: Session): StalledWithWorkFacts {
    const status = session.status().value;
    const running = status.kind === "running";
    const steers = agent.launch?.busyDelivery === "now";
    const lastProgressAt = running ? Math.max(status.lastEventAt, agent.turnStartedAtMs ?? 0) : null;
    return {
      inboxLength: agent.pending.length,
      turnInProgress: running,
      recoveryUnderway: agent.stopping || (running && (status.stop?.pendingAbortIds.length ?? 0) > 0),
      deliveryHold: this.stalledWithWorkDeliveryHold(agent),
      supportsStdinNotification: steers,
      busyDeliveryMode: steers ? "direct" : "none",
      hasSession: Boolean(session.id),
      outstandingToolUses: agent.openToolCalls.size,
      hasDirectStdinRecoveryEvidence: false,
      openToolHoldsNoLiveWork: false,
      processAlive: true,
      runtimeProgressIsStale: false,
      staleForMs: lastProgressAt === null ? 0 : Math.max(0, this.now() - lastProgressAt),
    };
  }

  /** Why the session's deliveries wait on purpose (stalledWithWork's `deliveryHold`): the holds `handOff` holds them for. */
  private stalledWithWorkDeliveryHold(agent: HostedAgent): StalledWithWorkDeliveryHold | null {
    const hold = this.deliveryHold(agent);
    if (hold) return hold.kind;
    if (this.drain.holds(agent.agentId)) return "drain";
    return agent.providerLimitWait ? "provider_limit" : null;
  }

  /**
   * One timer per launch, at the moment its held deliveries would cross the
   * stall threshold (stalledWithWork's `deadlineInMs`). It only decides the
   * agent again (`stall_deadline`): after progress that decision finds it
   * recent and arms the next deadline; with nothing held it arms none.
   * Cleared at the release.
   */
  private armStallDeadline(agent: HostedAgent, session: Session, delayMs: number): void {
    this.clearStallDeadline(agent);
    const timer = setTimeout(() => {
      if (agent.stallDeadline !== timer) return;
      agent.stallDeadline = null;
      if (!this.isCurrent(agent) || agent.session !== session) return;
      this.reconcile(agent, "stall_deadline");
    }, Math.max(0, delayMs));
    timer.unref?.();
    agent.stallDeadline = timer;
  }

  private clearStallDeadline(agent: HostedAgent): void {
    if (agent.stallDeadline) clearTimeout(agent.stallDeadline);
    agent.stallDeadline = null;
  }

  /** The legacy host's process identity attrs, so one query finds both hosts' rows. */
  private stallTraceAttrs(agent: HostedAgent): Record<string, unknown> {
    const runtimeContext = this.agentConfig(agent).runtimeContext;
    return {
      agent_id: agent.agentId,
      server_id: runtimeContext?.serverId,
      machine_id: runtimeContext?.machineId,
      launch_id: agent.launchId ?? undefined,
      process_instance_id: agent.processInstanceId,
      session_id: agent.session?.id,
      session_id_present: Boolean(agent.session?.id),
      runtime: agent.runtimeId,
      host: "oar",
    };
  }

  /**
   * E2 for a stall: the session is ended now (the stop that keeps it on the
   * server, as a spec restart ends it) and the agent started again on it with
   * the held deliveries (the legacy host's `restart_stall`). The deliveries
   * never leave the daemon: a plain one was acked on custody, so the server
   * has nothing left to send again, and it starts no agent on an exit; the
   * next start takes them in its first input, once.
   */
  private replaceStalledSession(agent: HostedAgent, session: Session, trigger: RuntimeSpecReconcileTrigger, staleForMs: number, streak: number): void {
    const { agentId } = agent;
    const runtimeLabel = runtimeDisplayName(agent.runtimeId);
    const queued = agent.pending.length;
    logger.warn(
      `[Agent ${agentId}] ${runtimeLabel} OAR session stalled for ${Math.max(1, Math.floor(staleForMs / 60_000))}m with ${queued} held deliver${queued === 1 ? "y" : "ies"}; ending it and starting again on it (${trigger})`,
    );
    this.deps.recordEvent("daemon.runtime.stall.recovery_action", {
      ...this.stallTraceAttrs(agent),
      action: "terminate_for_restart",
      outcome: "initiated",
      delay_ms_bucket: bucketMs(staleForMs),
      queued_messages_count: queued,
      trigger,
      streak,
    });
    this.publish(agent, "working", `Restarting stalled ${runtimeLabel} runtime for queued message`, "stalled_recovery");
    // Reconciler step 10b: the daemon's own stop is planned as the legacy
    // host plans it (`stalled_recovery`: clean, start now with the held
    // work, on the same session). A stall replacement starts again even when
    // it held only transient notices (step 9).
    const { plan } = this.planEnd(agent, session, "stalled_recovery", null);
    this.restartAfterEnd(agent, plan, "stalled_recovery", 0, () => { void this.endSession(agent, "stalled_recovery"); });
  }

  /**
   * The start after a stall replacement or an exit (step 10b) could not run
   * on OAR (its resume was refused, the gate refused it, ...). Nothing runs
   * the agent: it is shown stopped, a held tracked mention is handed back so
   * the server wakes it (the router then picks the host), and the plain
   * deliveries stay unread on the server for that start, as after an exit.
   */
  private restartFailed(agent: HostedAgent, outcome: Extract<OarStartOutcome, { kind: "fallback" }>, cause: OarRestartCause): void {
    const stall = cause === "stalled_recovery";
    this.deps.recordEvent(stall ? "daemon.agent.oar.stall_restart_failed" : "daemon.agent.oar.exit_restart_failed", { agentId: agent.agentId, launchId: agent.launchId ?? undefined, reason: outcome.reason, held: outcome.held.length, cause, host: "oar" }, "error");
    for (const held of outcome.held) {
      if (held.context.mentionDelivery) held.context.onRejectedNoProcess?.();
      held.settle(false);
    }
    if (this.agents.has(agent.agentId)) return;
    this.sendStatus(agent, "inactive");
    const label = runtimeDisplayName(agent.runtimeId);
    this.publish(
      agent,
      "error",
      stall
        ? `${label} stalled with queued messages and could not be started again (${outcome.reason}); restart it to retry`
        : cause === "prompt_refused"
          ? `${label} refused new messages and could not be started again; restart it (Restart / Reset in the agent menu) to try again`
          : `${label} exited and could not be started again (${outcome.reason}); restart it to retry`,
      "runtime_error",
    );
  }

  /**
   * After STALLED_REPLACEMENT_MAX_STREAK replacements in a row with no model
   * output or turn end in between, a session judged stalled again is left as
   * it is: traced and shown once per streak. Model output, a turn end or a
   * person's stop ends the streak.
   */
  private giveUpStalledReplacement(agent: HostedAgent, trigger: RuntimeSpecReconcileTrigger, streak: { count: number; gaveUp: boolean }, staleForMs: number): void {
    if (streak.gaveUp) return;
    this.stalledReplacements.noteGaveUp(agent.agentId);
    const runtimeLabel = runtimeDisplayName(agent.runtimeId);
    logger.warn(`[Agent ${agent.agentId}] ${runtimeLabel} OAR session stalled again with ${agent.pending.length} held deliveries after ${streak.count} replacements in a row; not replacing it again`);
    this.deps.recordEvent("daemon.agent.stalled_recovery.gave_up", {
      ...this.stallTraceAttrs(agent),
      streak: streak.count,
      trigger,
      queued_messages_count: agent.pending.length,
      stale_for_ms_bucket: bucketMs(staleForMs),
    }, "error");
    this.publish(agent, "error", `${runtimeLabel} stalled repeatedly with queued messages; restart it to retry`, "runtime_error");
  }

  respondToActivityProbe(agentId: string, probeId: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;
    this.sink.respondToProbe({ agentId, ...agent.last, launchId: agent.launchId ?? undefined }, probeId, this.producer(agent));
  }

  /**
   * #proj-runtime:#41, #42: stop one sub-agent. `interrupted` means only that the
   * runtime took the request: its row ends on `task_ended`, or on Codex the child's
   * interrupted turn. Grok and Qwen have no `stopTask`.
   */
  async interruptSubagent(agentId: string, subagentTaskId: string): Promise<AgentSubagentInterruptOutcome> {
    const trace = (outcome: string) => this.deps.recordEvent("daemon.agent.subagent_interrupt", { agentId, outcome, host: "oar" });
    const agent = this.agents.get(agentId);
    const session = agent?.session;
    if (!agent || !session) {
      trace("not_running");
      return "not_running";
    }
    if (!session.stopTask) {
      trace("unsupported");
      return "unsupported";
    }
    if (!agent.taskRows.isRunning(subagentTaskId)) {
      trace("not_running");
      return "not_running";
    }
    agent.taskRows.noteStopRequested(subagentTaskId, true);
    try {
      const result = await session.stopTask(subagentTaskId);
      trace(result.kind === "rejected" ? `rejected_${result.code}` : result.kind);
      if (result.kind === "accepted") return "interrupted";
      agent.taskRows.noteStopRequested(subagentTaskId, false);
      return result.kind === "rejected" && result.code === "unsupported" ? "unsupported" : "not_running";
    } catch (error) {
      agent.taskRows.noteStopRequested(subagentTaskId, false);
      trace("threw");
      throw error;
    }
  }

  /** The Sub-agents view's row for a task event: it says nothing about the main turn. */
  private publishTaskRow(agent: HostedAgent, event: Event): void {
    let row: OarTaskRow | null = null;
    // A sub-agent's end was a person's stop only if it ended stopped: a stop
    // refused because it had just finished on its own still leaves a result.
    let stoppedByUser = false;
    const runningBefore = agent.taskRows.runningCount();
    if (event.kind === "task_started" || event.kind === "task_updated" || event.kind === "task_ended") {
      stoppedByUser = event.kind === "task_ended" && event.status === "stopped" && agent.taskRows.isStopRequested(event.taskId);
      row = agent.taskRows.onTaskEvent(event);
    } else if (event.kind === "turn_ended" && event.outcome.kind === "aborted" && event.sessionId !== agent.session?.id) {
      // Only a child a person asked to stop ends here.
      stoppedByUser = true;
      row = agent.taskRows.onChildTurnAborted(event.sessionId);
    }
    if (!row) return;
    if (row.subagent.phase === "notification") this.onSubagentEnded(agent, stoppedByUser);
    // The last subagent ended: idle may hold now (as the legacy host's background_tasks_done).
    if (runningBefore > 0 && agent.taskRows.runningCount() === 0) queueMicrotask(() => {
      if (this.agents.get(agent.agentId) === agent && !agent.stopping) this.reconcile(agent, "background_tasks_done");
    });
    // A system row, not a status one: a status row would disagree with the frame's own status, which it restates.
    this.sink.publishFact({
      agentId: agent.agentId,
      ...agent.last,
      entries: [{ kind: "system", title: row.detail, text: "", subagent: row.subagent }],
      launchId: agent.launchId ?? undefined,
    }, this.producer(agent));
    this.deps.recordEvent("daemon.runtime.subagent.progress", {
      agentId: agent.agentId,
      launchId: agent.launchId ?? undefined,
      runtime: agent.runtimeId,
      phase: row.subagent.phase,
      host: "oar",
    });
  }

  /**
   * #proj-runtime:#41, as the legacy host's sub-agent notification: on a
   * runtime that only queues sub-agent results for its next turn (Codex), the
   * last sub-agent's end while the main turn is over wakes the agent, if any
   * sub-agent ended on its own since the turn ended (stopping A after B
   * finished still leaves B's result). Only person-stopped ones: no wake.
   */
  private onSubagentEnded(agent: HostedAgent, stoppedByUser: boolean): void {
    if (!agent.driver.needsWakeAfterSubagents) return;
    const session = agent.session;
    // The main turn has ended and none has opened since; a delivery in flight
    // is still in `pending` until the runtime takes it (`messages_pending`).
    const quiet = agent.committed && session !== null && !agent.turnOpen && session.status().value.kind === "idle";
    if (!quiet) return;
    if (!stoppedByUser) agent.subagentWake.resultUnread = true;
    if (agent.taskRows.runningCount() > 0) return;
    const unread = agent.subagentWake.resultUnread;
    agent.subagentWake.resultUnread = false;
    if (!unread) {
      this.recordSubagentsFinishedWake(agent, "stopped_by_user");
      return;
    }
    this.wakeAfterSubagentsFinished(agent, session);
  }

  /**
   * The legacy host's wakeAfterSubagentsFinished: start the turn Claude Code
   * starts by itself, so the agent acts on the results instead of holding
   * them until its next message. Only into an idle session with nothing else
   * waiting: a held message starts the turn anyway and carries the results.
   */
  private wakeAfterSubagentsFinished(agent: HostedAgent, session: Session): void {
    const skip = ((): string | null => {
      // Being stopped on purpose (a Stop, a spec restart, a stall replacement).
      if (agent.stopping) return "stopping";
      if (!this.isCurrent(agent) || agent.session !== session) return "not_deliverable";
      // Someone stopped the agent's turn: finishing sub-agents do not undo that.
      if (agent.subagentWake.lastTurnAborted) return "turn_stopped";
      if (agent.pending.length > 0 || agent.carried.length > 0) return "messages_pending";
      // A failed last turn, or a credential hold: only a person or a message starts it.
      if (agent.lastFailure !== null || this.deliveryHold(agent) !== null) return "blocked";
      return null;
    })();
    if (skip) {
      this.recordSubagentsFinishedWake(agent, skip);
      return;
    }
    const endedAtMs = this.now();
    void this.deliverHostInput(agent, session, "subagents-finished", formatSubagentsFinishedRuntimeInput()).then((accepted) => {
      const outcome = accepted ? "written" : agent.stopping ? "stopping" : "write_failed";
      this.recordSubagentsFinishedWake(agent, outcome, { wake_delay_ms: Math.max(0, this.now() - endedAtMs) });
    });
  }

  private recordSubagentsFinishedWake(agent: HostedAgent, outcome: string, extra: Record<string, unknown> = {}): void {
    this.deps.recordEvent("daemon.runtime.subagent.finished_wake", {
      agentId: agent.agentId,
      launchId: agent.launchId ?? undefined,
      runtime: agent.runtimeId,
      host: "oar",
      outcome,
      ...extra,
    }, outcome === "write_failed" ? "error" : "ok");
  }

  /** task #25 step 2: end the running turn through OAR's typed abort; the session keeps running. */
  async interruptTurn(agentId: string): Promise<AgentTurnInterruptReport> {
    const agent = this.agents.get(agentId);
    const session = agent?.committed && !agent.stopping ? agent.session : null;
    if (!agent || !session || session.status().value.kind !== "running") {
      this.deps.recordEvent("daemon.agent.turn_interrupt", { agentId, outcome: "not_running", host: "oar" });
      return { outcome: "not_running" };
    }
    agent.abortRequested = true;
    const aborted = await session.abort();
    if (aborted.kind !== "accepted") agent.abortRequested = false;
    const outcome = aborted.kind === "accepted" ? "interrupted" : "not_running";
    this.deps.recordEvent("daemon.agent.turn_interrupt", { agentId, outcome, host: "oar", ...(aborted.kind === "rejected" ? { code: aborted.code } : {}) });
    return { outcome };
  }

  /**
   * Stop the agent. `wait`: resolve only once its launch is undone (an
   * uncommitted start's unwind: session disposed, open record closed as never
   * started, credential revoked), as the legacy host waits for the runtime's
   * exit; a migration and the daemon's shutdown rely on it.
   */
  async stopAgent(agentId: string, { wait = false, silent = false }: { wait?: boolean; silent?: boolean } = {}): Promise<void> {
    // RFC 070 §6.5: a stop ends a pending warm mark and its timer; an explicit
    // one (also how an agent leaves this computer) forgets everything kept for it.
    if (silent) this.warmRecycle.dropPending(agentId);
    else this.warmRecycle.forget(agentId);
    const agent = this.agents.get(agentId);
    if (!agent || agent.stopping) {
      if (wait) await this.unwound(agentId);
      return;
    }
    agent.stopping = true;
    if (!silent) {
      this.releaseProviderLimitForExplicitStop(agent);
      // Reconciler step 9: a person's stop (the Retry) ends the stalled-replacement streak.
      this.stalledReplacements.delete(agentId);
      // And the idle-refusal reopen: a person's Restart gets its one reopen again.
      this.idleRefusalReopens.delete(agentId);
      // Reconciler step 12: and the sticky-failure records (a session reset, an unusable model).
      this.exitStreaks.sticky.forget(agentId);
      // Reconciler step 10b: and the crash streaks and the early-crash record:
      // planned as the legacy host plans a stop (nothing starts), or, with no
      // session yet (a start, a restart waiting out its backoff), ended here.
      if (agent.committed && agent.session) {
        this.planEnd(agent, agent.session, "explicit_stop", null);
      } else {
        this.endExitStreaks(agent, "explicit_stop");
        this.exitStreaks.deleteResumeFailureRecord(agentId);
      }
    }
    if (!agent.committed) {
      // Nothing reported this start active, and the stop is synchronous here:
      // no later start of the agent exists yet.
      if (!silent) {
        this.sendStatus(agent, "inactive");
        this.publish(agent, "offline", "Stopped", "stopped");
      }
      // The start in progress notices the stop and cleans up (runStart).
      agent.capabilityWait?.cancel();
      agent.abort.abort();
      this.detachStopped(agent);
      this.deps.recordEvent("daemon.agent.oar.stopped", { agentId, launchId: agent.launchId ?? undefined, silent, committed: false });
      if (wait) await this.unwound(agentId);
      return;
    }
    const hosted = this.hostedSession(agentId);
    await this.endSession(agent, silent ? "silent_stop" : "explicit_stop", () => {
      if (silent) return;
      // As the legacy host: reported once the runtime is gone, unless a later
      // start of the agent is already under way (it reports its own state).
      if (this.agents.has(agentId)) {
        this.deps.recordEvent("daemon.agent.oar.stop_status_suppressed", { agentId, launchId: agent.launchId ?? undefined });
        return;
      }
      if (hosted) this.deps.sendRuntimeProfileReport?.(agentId, hosted, "stop");
      this.sendStatus(agent, "inactive");
      this.publish(agent, "offline", "Stopped", "stopped");
    });
    this.deps.recordEvent("daemon.agent.oar.stopped", { agentId, launchId: agent.launchId ?? undefined, silent, committed: true });
  }

  /**
   * The daemon stops: every agent silently, each awaited until its launch is
   * undone, so every exit (and every never-started open record) is stored
   * before the outbox stops.
   */
  async stopAll(): Promise<void> {
    // Task #17: these stops are silent (no closing frame), so a held empty
    // wake would go with the daemon; published first, as the legacy host does.
    for (const agent of this.agents.values()) if (agent.committed && !agent.stopping) this.publishReleasedTurn(agent);
    await Promise.all([...this.agents.keys()].map((agentId) => this.stopAgent(agentId, { wait: true, silent: true })));
    await Promise.all([...this.unwinding.keys()].map((agentId) => this.unwound(agentId)));
    this.clearReconcileSweep();
    this.warmRecycle.clear();
    this.drain.dispose();
  }

  /** The legacy host's `publishReleasedTurn`: a held empty wake re-stated on the current activity when that alone describes it. */
  private publishReleasedTurn(agent: HostedAgent): void {
    const entries = this.turnSummaries.release(agent.agentId);
    if (entries.length === 0) return;
    const { activityKind, detailKind } = agent.last;
    if (!((activityKind === "online" && detailKind === "idle") || isRuntimeProgressDetailKind(detailKind))) return;
    this.sink.publishFact({ agentId: agent.agentId, ...agent.last, entries, launchId: agent.launchId ?? undefined }, this.producer(agent));
  }

  /**
   * End a committed session: release the agent, dispose, report the exit
   * (RFC 071 `process_exited`), then `ended`. Tracked as an unwind: the next
   * start of the agent, on either host, begins after all of it.
   */
  private endSession(agent: HostedAgent, reason: string, ended?: () => void): Promise<void> {
    agent.stopping = true;
    const session = agent.session;
    // A caller that reports the end itself publishes the turn's end then.
    this.release(agent, reason, { keepTurnSummary: ended !== undefined });
    const done = (async () => {
      if (session) {
        await this.disposeSession(agent, session, reason);
        this.sendProcessExited(agent, exitCodeOf(session));
      }
      ended?.();
      if (ended) this.turnSummaries.release(agent.agentId);
    })();
    this.trackUnwind(agent.agentId, done);
    return done;
  }

  /**
   * Reconciler step 5: OAR's dispose is the runtime's stop. It sends SIGTERM
   * to the runtime's process group, and after its own grace (OAR's
   * KILL_GRACE_MS, the same 10 s as AGENT_STOP_KILL_GRACE_MS; pinned by a
   * test) SIGKILLs the group (`taskkill /T /F` on Windows), then waits for
   * the exit. OAR keeps the pid to itself, so the escalation is OAR's; this
   * host traces it when the dispose outlasts the grace, and releases the
   * agent anyway when no exit is confirmed within the confirmation window
   * after it (`kill_unconfirmed`), so a later start is never held forever.
   */
  private disposeSession(agent: HostedAgent, session: Session, path: string): Promise<void> {
    const graceMs = Math.max(0, this.deps.stopKill?.graceMs ?? AGENT_STOP_KILL_GRACE_MS);
    const confirmMs = Math.max(0, this.deps.stopKill?.confirmMs ?? AGENT_STOP_KILL_CONFIRM_MS);
    const attrs = { agentId: agent.agentId, launchId: agent.launchId ?? undefined, path: `oar_${path}`, grace_ms: graceMs, host: "oar" };
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(escalated);
        clearTimeout(unconfirmed);
        resolve();
      };
      const escalated = setTimeout(() => {
        // OAR's own SIGKILL of the group is due now.
        this.deps.recordEvent("daemon.agent.stop.escalated", { ...attrs, tree_killed_count: undefined, escalated_by: "oar_dispose" }, "error");
      }, graceMs);
      const unconfirmed = setTimeout(() => {
        this.deps.recordEvent("daemon.agent.stop.kill_unconfirmed", { ...attrs, confirm_ms: confirmMs, pid: undefined }, "error");
        logger.warn(`[Agent ${agent.agentId}] OAR session dispose (${path}) did not finish ${graceMs + confirmMs}ms after it began; releasing the agent anyway`);
        finish();
      }, graceMs + confirmMs);
      void Promise.resolve()
        .then(() => session.dispose())
        .catch(() => {})
        .then(() => {
          this.deps.runtimeProcesses?.closed(agent.agentId);
          finish();
        });
    });
  }

  /**
   * Give the agent up: listeners, timers, launch proxies, the runner
   * credential, ownership, and every delivery not handed over (`dropHeld`).
   * The caller disposes the session.
   */
  private release(agent: HostedAgent, reason: string, { keepTurnSummary = false }: { keepTurnSummary?: boolean } = {}): void {
    agent.stopping = true;
    this.endTurnTraceOnRelease(agent, reason);
    agent.nextTurn = null;
    // The session's last turn may not have ended: keep what it did so far.
    agent.summary?.flush();
    agent.summary = null;
    agent.activity = null;
    agent.codexActivity = null;
    for (const unsubscribe of agent.unsubscribe.splice(0)) unsubscribe();
    if (agent.heartbeat) clearInterval(agent.heartbeat);
    agent.heartbeat = null;
    this.clearProviderLimitWait(agent);
    this.clearStallDeadline(agent);
    cleanupLaunchProxies(agent.agentId);
    this.revokeCredential(agent);
    this.dropHeld(agent, reason);
    if (!keepTurnSummary) this.turnSummaries.release(agent.agentId);
    if (this.agents.get(agent.agentId) === agent) {
      this.agents.delete(agent.agentId);
      this.idleHolds.forget(agent.agentId);
      // RFC 070 §6.5: a mark this session never reached its stop for goes with it
      // (an exit, a crash, a stop, a spec restart); a warm stop it made is kept.
      this.warmRecycle.dropPending(agent.agentId);
    }
    // Reconciler step 7: the session it ran, for the next start's check (either host).
    if (agent.session && agent.startedSpec) this.sessionSpecs.remember(agent.agentId, agent.session.id, agent.startedSpec);
  }

  /**
   * Deliveries the runtime never took go with it (the legacy host's
   * `recordInboxDroppedOnExit`, task #353): the plain ones were acked on
   * custody and stay unread on the server for the next start's catch-up.
   * After a stop that is by design; after an exit planned for the next wake,
   * or a terminal failure, the agent waits for the server's next start (an
   * exit planned to start again took them out first: `restartAfterEnd`).
   */
  private dropHeld(agent: HostedAgent, reason: string): void {
    // A first input held for a provider limit still carries the deliveries it names.
    const held = [...agent.carried.splice(0), ...agent.pending.splice(0)];
    if (held.length === 0) return;
    const expected = OAR_STOP_REASONS.has(reason);
    // A hand-off at the crash cap (step 10b) leaves them to the server too:
    // its breakers decide the next start, as on the legacy host.
    const serverCarried = expected || reason === "crash_streak_exhausted";
    for (const delivery of held) this.refuse(delivery, "runtime_exited", { answerMention: !serverCarried });
    const unconsumed = held.filter((delivery) => delivery.custody && !this.isTransient(delivery)).length;
    this.deps.recordEvent("daemon.agent.oar.held_dropped", { agentId: agent.agentId, count: held.length, unconsumed_count: unconsumed, reason, expected }, expected ? "ok" : "error");
    if (unconsumed === 0) return;
    const line = `[Agent ${agent.agentId}] OAR runtime closed via ${reason} with ${unconsumed} unconsumed queued message(s); not carried by the daemon, they stay unread on the server`;
    if (expected) logger.info(line);
    else logger.warn(line);
  }

  /**
   * The launch's runner credential, and its start's when that is another (a
   * start whose launch minted its own at spawn, then took a rebound start's),
   * each revoked once.
   */
  private revokeCredential(agent: HostedAgent): void {
    if (agent.credentialReleased) return;
    const configs = this.distinctCredentials([agent.launchConfig, agent.request.config]);
    if (configs.length === 0) return;
    agent.credentialReleased = true;
    for (const config of configs) this.revokeRunnerCredential(agent, config);
  }

  /**
   * Handing a start back to the legacy host: its request carries its own
   * credential there; one the launch minted at spawn besides it is revoked.
   */
  private revokeLaunchOnlyCredential(agent: HostedAgent): void {
    const launchConfig = agent.launchConfig;
    if (!launchConfig?.agentCredentialId || launchConfig.agentCredentialKey === agent.request.config.agentCredentialKey) return;
    this.revokeRunnerCredential(agent, launchConfig);
  }

  /** #wg-rbac:#27: a rebound start runs on the credential the launch holds; its own, if another, is revoked here. */
  private carryRunnerCredential(agent: HostedAgent, request: AgentStartRequest): AgentConfig {
    const held = agent.launchConfig?.agentCredentialKey ? agent.launchConfig : agent.request.config;
    const { config, unused } = carryHeldRunnerCredential(held, request.config);
    if (unused) this.revokeRunnerCredential(agent, unused, request.launchId || null);
    return config;
  }

  private distinctCredentials(configs: Array<AgentConfig | null>): AgentConfig[] {
    const seen = new Set<string>();
    const distinct: AgentConfig[] = [];
    for (const config of configs) {
      const credentialId = config?.agentCredentialId;
      if (!config || !credentialId || seen.has(credentialId)) continue;
      seen.add(credentialId);
      distinct.push(config);
    }
    return distinct;
  }

  private revokeRunnerCredential(agent: HostedAgent, config: AgentConfig, launchId: string | null = agent.launchId): void {
    revokeManagedRunnerCredential({
      serverUrl: this.deps.serverUrl,
      daemonApiKey: this.deps.daemonApiKey,
      agentId: agent.agentId,
      config,
      launchId,
      fetchImpl: this.deps.fetchImpl ?? ((url, init) => fetch(url, init)),
      recordEvent: (name, attrs, status) => this.deps.recordEvent(name, attrs, status),
    });
  }

  private projector(agentId: string): ThreadJoinContextProjector {
    const seen = this.renderedThreadTargets.get(agentId);
    return (messages, renderContext = true) => projectThreadJoinContextsForRuntimeInput(
      messages,
      (target) => (seen?.has(target) ? 0 : undefined),
      renderContext,
    );
  }

  private noteRendered(agentId: string, rendered: readonly AgentMessage[]): void {
    if (rendered.length === 0) return;
    let seen = this.renderedThreadTargets.get(agentId);
    if (!seen) {
      seen = new Set();
      this.renderedThreadTargets.set(agentId, seen);
    }
    for (const message of rendered) {
      if (message.thread_join_context) seen.add(message.thread_join_context.thread_target);
    }
  }

  private recordStandingPrompt(agentId: string, sessionId: string, promptHash: string): void {
    try {
      const current = this.standingPromptLedger.read(agentId);
      if (current?.sessionId === sessionId && current.promptHash === promptHash) return;
      this.standingPromptLedger.write(agentId, sessionId, promptHash);
    } catch (error) {
      logger.warn(`[Agent ${agentId}] standing prompt record not written: ${errorMessage(error)}`);
    }
  }

  private publishMessageReceived(agent: HostedAgent, messages: readonly AgentMessage[], newTurn: boolean): void {
    // As the legacy host: a profile notice never names the turn's trigger.
    const trigger = newTurn ? turnTriggerFromMessages(messages.filter((message) => !runtimeProfileNotificationFromMessage(message))) : undefined;
    const previousTurn = newTurn
      ? this.turnSummaries.begin(agent.agentId, this.now(), trigger, agent.last.activityKind === "error" ? "failed" : "unknown")
      : [];
    // The frame that opens a turn names the message that woke it (the
    // legacy host's status entry), so readers can show where the agent works
    // before the turn's summary arrives (#proj-raft-computer:#40).
    const opening: TrajectoryEntry[] = trigger
      ? [{ kind: "status", activity: "working", detail: "Message received", detailKind: "model_request_started", trigger }]
      : [];
    this.publish(agent, "working", "Message received", "model_request_started", [...previousTurn, ...opening]);
  }

  private publish(
    agent: HostedAgent,
    activityKind: AgentActivityKind,
    detail: string,
    detailKind: AgentActivityDetailKind,
    entries: TrajectoryEntry[] = [],
    runtimeError?: RuntimeErrorActivityDiagnostic,
  ): void {
    // Reconciler step 4a: while an invalid record another agent reported
    // holds the agent, its idle status is the held notice. Step 4b: the frame
    // carries the reason typed (`credentialHold`), so the web can show it
    // without reading the text; every other frame omits it.
    let credentialHold: CredentialHoldActivityDiagnostic | undefined;
    if (activityKind === "online" && detailKind === "idle") {
      const notice = this.credentialInvalidHeldNotice(agent);
      if (notice) {
        detail = notice.text;
        credentialHold = { reason: notice.record.invalidReason };
        this.noteCredentialInvalidHeldNoticeShown(agent, notice, "idle");
      }
    }
    agent.last = { activityKind, detail, detailKind, ...(credentialHold ? { credentialHold } : {}), ...(runtimeError ? { runtimeError } : {}) };
    // Task #17: the turn summary rides the frames, as on the legacy host.
    const now = this.now();
    // As on the legacy host: only a progress frame's text is the runtime's output
    // (the turn's last text); a reconnect's or an error's text is a diagnostic.
    const isOutputFrame = detail === "" && (detailKind === "thinking_started" || detailKind === "model_response_started");
    const observed = isOutputFrame ? entries : entries.filter((entry) => entry.kind !== "text");
    const sent = [...this.turnSummaries.observe(agent.agentId, observed, now), ...entries];
    const turnOutcome = turnOutcomeForActivity(activityKind, detailKind);
    if (turnOutcome) sent.push(...this.turnSummaries.finish(agent.agentId, turnOutcome, now));
    this.sink.publishFact({
      agentId: agent.agentId,
      activityKind,
      detail,
      detailKind,
      entries: sent,
      launchId: agent.launchId ?? undefined,
      ...(runtimeError ? { runtimeError } : {}),
      ...(credentialHold ? { credentialHold } : {}),
    }, this.producer(agent));
  }

  /** A runtime's warning as a row in the activity log, on the current activity (the legacy host's `recordRuntimeDiagnosticActivity`). */
  private publishDiagnostic(agent: HostedAgent, diagnostic: RuntimeDiagnosticEvent): void {
    this.sink.publishFact({ agentId: agent.agentId, ...agent.last, entries: [runtimeDiagnosticTrajectoryEntry(diagnostic)], launchId: agent.launchId ?? undefined }, this.producer(agent));
    this.deps.recordEvent("daemon.runtime.diagnostic", { agentId: agent.agentId, launchId: agent.launchId ?? undefined, runtime: agent.runtimeId, host: "oar", ...runtimeDiagnosticTraceAttrs(diagnostic) });
  }

  /** RFC 069 §8: sequenced, on the shared counter, tagged with this daemon process. */
  private sendStatus(agent: HostedAgent, status: "active" | "inactive", exit?: { code: number | null; signal: string | null }): void {
    const daemonInstanceId = this.deps.daemonInstanceId();
    this.deps.recordEvent("daemon.agent.status.transition", { agentId: agent.agentId, status, launchId: agent.launchId, processInstanceId: agent.processInstanceId, runtime: agent.runtimeId, host: "oar" });
    this.deps.sendToServer({
      type: "agent:status",
      agentId: agent.agentId,
      status,
      ...(agent.launchId ? { launchId: agent.launchId } : {}),
      ...(exit ? { exit } : {}),
      ...(daemonInstanceId ? { daemonInstanceId } : {}),
      clientSeq: this.deps.nextClientSeq(agent.agentId),
    });
  }

  private sendRuntimeReady(agent: HostedAgent, again: boolean): void {
    agent.runtimeReadySent = true;
    if (!agent.launchId) return;
    if (!again) this.deps.recordEvent("daemon.agent.oar.runtime_ready", { agentId: agent.agentId, launchId: agent.launchId });
    this.deps.sendToServer({ type: "agent:runtime:ready", agentId: agent.agentId, launchId: agent.launchId });
  }

  /** The first turn end of this process, once (the server marks read what the agent owes nothing in). */
  private reportFirstTurnEnded(agent: HostedAgent, outcome: AgentTurnEndedOutcome): void {
    if (agent.turnEndedReported) return;
    agent.turnEndedReported = true;
    if (!this.serverReadsTurnEnded || !agent.launchId) return;
    this.deps.sendToServer({
      type: "agent:turn:ended",
      agentId: agent.agentId,
      launchId: agent.launchId,
      outcome,
      shownUnreadTargets: agent.shownUnreadTargets.slice(0, AGENT_TURN_ENDED_MAX_SHOWN_TARGETS),
    });
  }

  /** RFC 071 §7 `agent:runtime:outcome` v1; no launch or no daemon instance, no frame (as on the legacy host). */
  private sendRuntimeOutcome(agent: HostedAgent, outcome: AgentRuntimeOutcome): void {
    const daemonInstanceId = this.deps.daemonInstanceId();
    if (!agent.launchId || !daemonInstanceId) return;
    const sessionId = agent.session?.id ?? null;
    this.deps.sendToServer({
      type: "agent:runtime:outcome",
      v: 1,
      agentId: agent.agentId,
      launchId: agent.launchId,
      sessionId,
      daemonInstanceId,
      clientSeq: this.deps.nextClientSeq(agent.agentId),
      observedAtMs: this.now(),
      outcome,
    });
    this.deps.recordEvent("daemon.agent.runtime_outcome.sent", {
      agentId: agent.agentId,
      launchId: agent.launchId,
      kind: outcome.kind,
      host: "oar",
      ...(outcome.kind === "terminal_failure"
        ? { failure_kind: outcome.failureKind, fingerprint: outcome.fingerprint, runtime_error_class: outcome.errorClass }
        : { text_events_count: outcome.textEvents, tool_calls_count: outcome.toolCalls, catchup_batch_echoed: Boolean(outcome.catchupBatchId) }),
      session_id_present: Boolean(sessionId),
    });
  }

  /**
   * RFC 071 §4.3 rule 2: the process identity of this launch. Every accepted
   * launch still waiting is bound to it (its own and `supersededLaunchIds`).
   */
  private sendProcessSpawned(agent: HostedAgent): void {
    const waiting = this.deps.launches.take(agent.agentId);
    const daemonInstanceId = this.deps.daemonInstanceId();
    if (!agent.birthLaunchId || !daemonInstanceId) return;
    const supersededLaunchIds = waiting.filter((launchId) => launchId !== agent.birthLaunchId);
    this.deps.sendToServer({
      type: "agent:process_spawned",
      agentId: agent.agentId,
      daemonInstanceId,
      processInstanceId: agent.processInstanceId,
      launchId: agent.birthLaunchId,
      clientSeq: this.deps.nextClientSeq(agent.agentId),
      ...(supersededLaunchIds.length > 0 ? { supersededLaunchIds } : {}),
      ...(waiting.includes(agent.birthLaunchId) ? {} : { respawn: true }),
    });
  }

  /** RFC 071 §4.3 rule 3, once per process. */
  private sendProcessExited(agent: HostedAgent, code: number | null): void {
    if (agent.processExitedSent) return;
    agent.processExitedSent = true;
    const daemonInstanceId = this.deps.daemonInstanceId();
    const lastLaunchId = agent.launchId || agent.birthLaunchId;
    if (!lastLaunchId || !daemonInstanceId) {
      // A process no launch named has no frame; its open record closes here.
      if (this.deps.gate && daemonInstanceId && agent.processOpened) this.deps.gate.processExitedLocally(agent.agentId, agent.processInstanceId);
      return;
    }
    this.deps.sendToServer({
      type: "agent:process_exited",
      agentId: agent.agentId,
      daemonInstanceId,
      processInstanceId: agent.processInstanceId,
      spawnLaunchId: agent.birthLaunchId,
      launchId: lastLaunchId,
      clientSeq: this.deps.nextClientSeq(agent.agentId),
      code,
      signal: null,
    });
  }

  private producer(agent: HostedAgent): ActivityProducerContext {
    return {
      present: agent.committed,
      serverId: agent.request.config.runtimeContext?.serverId ?? null,
      machineId: agent.request.config.runtimeContext?.machineId ?? null,
      processInstanceId: agent.processInstanceId,
      sessionIdPresent: agent.session !== null,
      runtime: agent.runtimeId,
    };
  }
}

/** The process exit OAR recorded for this session (`exited` response), or null. */
function exitCodeOf(session: Session): number | null {
  const records = session.records();
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index]!;
    if (record.kind === "response" && record.body.kind === "exited") return record.body.code;
  }
  return null;
}

/** Daemon-local kill switch: `RAFT_DAEMON_OAR_HOST_DISABLED=1` neither advertises nor hosts OAR launches. */
export const OAR_HOST_DISABLED_ENV = "RAFT_DAEMON_OAR_HOST_DISABLED";

export function isOarHostEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[OAR_HOST_DISABLED_ENV]?.trim().toLowerCase();
  return raw === undefined || raw === "" || raw === "0" || raw === "false" || raw === "off";
}

/**
 * Reconciler step 11: a pushed config as a running launch's request takes
 * it: the launch keeps its own session and runner credential (the server's
 * push carries neither for it).
 */
function withPushedConfig(current: AgentConfig, pushed: AgentConfig): AgentConfig {
  return {
    ...pushed,
    sessionId: current.sessionId,
    agentCredentialKey: current.agentCredentialKey,
    agentCredentialId: current.agentCredentialId,
  };
}
