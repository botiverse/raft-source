// The lifecycle surface the daemon core drives an agent through (RFC 060).
// AgentProcessManager (the legacy host) satisfies it as it is;
// AgentHostRouter puts the OAR host beside it.

import type {
  AgentConfig,
  AgentInboxAppItem,
  AgentServerFeatures,
  AgentMessage,
  AgentSubagentInterruptOutcome,
  AgentTurnInterruptOutcome,
  MentionDeliveryIdentitySnapshot,
  MentionDeliveryTerminalErrorCode,
  MentionDeliveryTransitionStage,
  TraceContext,
  Tracer,
} from "@botiverse/raft-shared";
import type { AgentAppInboxNoticeOptions } from "../agentAppInbox";
import type { AgentDrainOptions, AgentDrainProgress, AgentDrainSummary } from "../agentDrain";
import type { AgentStartAcceptance } from "../agentStartDispatchProjection";
import type { RecoveryGrant } from "../runtimeOutcomeOutbox";

/** How the core tracks one delivery through a host. */
export interface AgentDeliveryContext {
  deliveryId?: string;
  transient?: boolean;
  mentionDelivery?: MentionDeliveryIdentitySnapshot;
  onMentionTransition?: (stage: MentionDeliveryTransitionStage, outcome: "accepted" | "coalesced") => void;
  onMentionTerminalError?: (code: MentionDeliveryTerminalErrorCode) => void;
  onMentionAck?: () => void;
  /** No process to take it: the server must wake the agent with its config. */
  onRejectedNoProcess?: () => void;
}

export interface AgentTurnInterruptReport {
  outcome: AgentTurnInterruptOutcome;
  toolName?: string;
  stuckForMs?: number;
}

/** A session another host runs, as the legacy host's transcript and runtime-profile reads need it (RFC 060). */
export interface HostedAgentSession {
  config: AgentConfig;
  sessionId: string | null;
  launchId: string | null;
  processInstanceId: string;
}

/**
 * Idle task reminder (#wg-task-v2:#9): the agent's live session as the
 * reminder needs it on the agent's Working→Idle edge.
 */
export interface AgentIdleNoticeFacts {
  /** The runtime session the agent runs; null before the runtime reported one. */
  sessionId: string | null;
  launchId: string | null;
  /** This launch resumed `sessionId` (a new session, a wake recycle or a resume that fell back to a new session: false). */
  resumed: boolean;
  /** Background tasks the runtime reports running (Claude Code); 0 where the runtime reports none. */
  backgroundTasks: number;
  /** The agent cannot take a turn now (provider-limit backoff). */
  blocked: boolean;
  /** Messages or notices wait to be handed to the session (absent: the host cannot tell). */
  deliveriesPending?: boolean;
  /**
   * The model context the session is in (context-generation, RFC 072): a new
   * id on every new session, compaction and handoff. Null or absent when the
   * runtime does not report compaction or the id is unknown: then no notice
   * may count on an earlier one still being in the context.
   */
  contextId?: string | null;
}

/**
 * What became of an idle notice. It is written only into a running, idle
 * session with nothing else waiting for it; it is never queued, never
 * interrupts a turn and never starts an agent.
 */
export type AgentIdleNoticeDelivery =
  | "written"
  | "busy"
  | "messages_pending"
  | "not_running"
  | "unsupported"
  | "write_failed";

/** One server (or internal) start, with everything the start message carried. */
export interface AgentStartRequest {
  agentId: string;
  config: AgentConfig;
  wakeMessage?: AgentMessage;
  unreadSummary?: Record<string, number>;
  resumePrompt?: string;
  launchId?: string;
  wakeMessageTransient: boolean;
  resumeMessages?: AgentMessage[];
  startDispatchId?: string;
  traceParent?: TraceContext | null;
  catchupBatchId?: string;
  recoveryGrant: RecoveryGrant | null;
  claimedConnectionEpochId: string | null;
}

export interface AgentLifecycleHost {
  startAgent(
    agentId: string,
    config: AgentConfig,
    wakeMessage?: AgentMessage,
    unreadSummary?: Record<string, number>,
    resumePrompt?: string,
    launchId?: string,
    wakeMessageTransient?: boolean,
    resumeMessages?: AgentMessage[],
    startDispatchId?: string,
    traceParent?: TraceContext | null,
    catchupBatchId?: string,
    recoveryGrant?: RecoveryGrant | null,
    claimedConnectionEpochId?: string | null,
  ): Promise<void>;
  getAgentStartAcceptance(agentId: string): AgentStartAcceptance;
  stopAgent(agentId: string, options?: { wait?: boolean; silent?: boolean }): Promise<void>;
  stopAll(): Promise<void>;
  deliverMessage(agentId: string, message: AgentMessage, context?: AgentDeliveryContext): boolean | Promise<boolean>;
  purgeInboxMessagesForChannels(agentId: string, channelIds: readonly string[], reason?: string): { removedCount: number };
  respondToActivityProbe(agentId: string, probeId: string): void;
  interruptTurn(agentId: string): Promise<AgentTurnInterruptReport>;
  /** #proj-runtime:#41: stop one running sub-agent; the agent keeps running. */
  interruptSubagent(agentId: string, subagentTaskId: string): Promise<AgentSubagentInterruptOutcome>;
  notifyAgentAppInbox(agentId: string, item: AgentInboxAppItem, noticeOptions?: AgentAppInboxNoticeOptions): Promise<boolean>;
  /** Idle task reminder: the agent's live session, or null when none runs it. */
  idleNoticeFacts(agentId: string): AgentIdleNoticeFacts | null;
  /** Idle task reminder: write `text` as a new turn now, or not at all (AgentIdleNoticeDelivery). */
  deliverIdleNotice(agentId: string, text: string): Promise<AgentIdleNoticeDelivery>;
  deliverRuntimeProfileNotification(
    agentId: string,
    key: string,
    kind: "migration" | "daemon_release_notice",
    content: string,
    traceparent?: string,
    launchId?: string | null,
  ): boolean | Promise<boolean>;
  getRunningAgentIds(): string[];
  /**
   * #wg-rbac:#27: every runner credential id (`AgentConfig.agentCredentialId`)
   * this host's processes and starts hold now, deduplicated; the daemon's
   * `ready` lists them (DAEMON_CAPABILITY_RUNNER_CREDENTIAL_RECONCILE_V1).
   */
  getHeldRunnerCredentialIds(): string[];
  /**
   * A start of the agent now would be carried by a process or start this
   * host already holds (a rebind), never spawn one: the core mints no runner
   * credential for it (#wg-rbac:#27).
   */
  holdsAgentStart(agentId: string): boolean;
  getAgentSessionId(agentId: string): string | null;
  getAgentLaunchId(agentId: string): string | null;
  setTracer(tracer: Tracer): void;
  setCliTransportTraceDir(traceDir: string | null): void;
  setServerTurnEndedCapable(capable: boolean): void;
  /**
   * Reconciler step 12: the connected server advertises
   * SERVER_CAPABILITY_STICKY_FAILURE_REASONS_V1 (it counts `model_unsupported`
   * and `runtime_repeated_failure`; without it they are sent as
   * `runtime_spawn_failed`). Optional for test stand-ins.
   */
  setServerStickyFailureReasonsCapable?(capable: boolean): void;
  /**
   * The Server's current server features (`server:features`): every agent
   * the host holds should run with them; a running session that started on
   * other values is stopped once it is idle (reconciler step 6). Optional on
   * test stand-ins (the core calls it as `?.`).
   */
  applyServerFeatures?(features: AgentServerFeatures): void;
  /**
   * Reconciler step 11 (`agent:config`): the agent's current config, already
   * ordered by the core (AgentConfigRevisions). The host's process (or start)
   * of the agent takes it without waking; a session whose runtime spec
   * drifted is stopped once idle. Optional on test stand-ins (the core calls
   * it as `?.`).
   */
  applyConfig?(agentId: string, config: AgentConfig, revision: number): void;
  /**
   * Reconciler step 13 (agentDrain.ts): hold new message deliveries,
   * reminders, notices and agent starts, and resolve once every live process
   * is quiet (agentIdle.ts with `ignoreUntoldInbox`) or the deadline (clamped
   * to AGENT_DRAIN_MAX_DEADLINE_MS) passed. Control (stop, turn interrupt,
   * sub-agent stop) is never held. Stops nothing: the shutdown that follows
   * does. A drain already running returns its own wait. Optional for test
   * stand-ins. Step 14 (Q-H): with `options.agentId`, the same drain for that
   * agent only (a /migrate source stop): no other agent and no start is held.
   */
  beginDrain?(options: AgentDrainOptions): Promise<AgentDrainSummary>;
  /** Reconciler step 13: end the drain; what it held is delivered or started. `agentId`: that agent's drain only. */
  endDrain?(agentId?: string): void;
  /** Reconciler step 13: the drain's progress now (live processes, the ones not quiet); null when no drain holds. `agentId`: that agent's drain. */
  drainProgress?(agentId?: string): AgentDrainProgress | null;
}

/** The legacy host as the router needs it: the lifecycle plus what it holds for an agent. */
export interface LegacyAgentHost extends AgentLifecycleHost {
  /** "active": a process, a start in progress or queued; "idle": only a cached restart config. */
  agentHostState(agentId: string): "none" | "idle" | "active";
  /** Reconciler step 11c: any start of the agent ends the handback its refusals report as a start. */
  forgetSpecHandback(agentId: string): void;
}
