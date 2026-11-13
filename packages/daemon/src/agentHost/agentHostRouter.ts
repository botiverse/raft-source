// Two agent hosts behind one lifecycle surface (RFC 060): the legacy host
// (AgentProcessManager + drivers) and the OAR host.
//
// - A start goes to the OAR host only when the server asked for it
//   (`config.runtimeHost === "oar"`), the OAR host supports the start, and
//   the legacy host holds no process or start for the agent; otherwise it
//   goes to the legacy host, with the reason traced
//   (`daemon.agent.host.selected`).
// - A start for an agent a host already runs or starts stays on that host
//   (a rebind): a flag change never moves a running session; the next start
//   after the session ends follows the flag.
// - The OAR host hands a start back (`fallback`) when it cannot run it after
//   all: its resume was refused, the session did not open, or the RFC 071
//   gate would refuse it. The legacy host then runs that same start, with the
//   deliveries the OAR host was holding; nothing was started on OAR.
// - A start the legacy host takes while an OAR launch of the agent is still
//   being undone (a stopped start whose grok may still be opening the same
//   session, an ended session still disposing) waits for that first, and
//   reads as starting meanwhile; a stop cancels it.
// - A runtime with no legacy driver (`RuntimeDriver.oarOnly`: Qwen Code,
//   Qoder) always asks for the OAR host, and never reaches the legacy host: a
//   start the OAR host cannot run fails with `OarOnlyStartError`, which the
//   core reports as the start's failure (core.ts `reportAgentStartFailure`).
// - Every other lifecycle call goes to whichever host owns the agent now.

import { getRuntimeDisplayName, redactDiagnosticText } from "@botiverse/raft-shared";
import type {
  AgentConfig,
  AgentInboxAppItem,
  AgentMessage,
  AgentServerFeatures,
  AgentStartNotSpawnedReason,
  AgentSubagentInterruptOutcome,
  TraceContext,
  Tracer,
} from "@botiverse/raft-shared";
import type { AgentAppInboxNoticeOptions } from "../agentAppInbox";
import { clampAgentDrainDeadlineMs, type AgentDrainOptions, type AgentDrainProgress, type AgentDrainSummary } from "../agentDrain";
import type { AgentStartAcceptance } from "../agentStartDispatchProjection";
import { logger } from "../logger";
import { getDriver, isOarOnlyRuntimeId, OAR_ONLY_RUNTIMES } from "../drivers/index";
import type { RecoveryGrant } from "../runtimeOutcomeOutbox";
import { RUNTIME_OUTCOME_STORAGE_BLOCKED_TEXT } from "../runtimeOutcomeOutbox";
import { OarOnlyStartError, spawnFailureCodeOf } from "../spawnFailureErrors";
import type {
  AgentDeliveryContext,
  AgentIdleNoticeDelivery,
  AgentIdleNoticeFacts,
  AgentLifecycleHost,
  AgentStartRequest,
  AgentTurnInterruptReport,
  LegacyAgentHost,
} from "./agentLifecycleHost";
import type { OarAgentHost, OarStartOutcome } from "./oarAgentHost";

export interface AgentHostRouterDeps {
  recordEvent(name: string, attrs: Record<string, unknown>, status?: "ok" | "error" | "cancelled"): void;
  /** RFC 071: the result of an accepted launch no host ran (the legacy host's ledger). */
  settleNotSpawned(agentId: string, launchId: string, reason: AgentStartNotSpawnedReason): void;
  /** #wg-rbac:#27: revoke, once, the runner credential of a start no host ran (unless a process holds it). */
  releaseUnusedCredential(agentId: string, config: AgentConfig, launchId: string | null): void;
}

/** A start for the legacy host waiting until a stopped OAR start of the agent is undone. */
interface WaitingLegacyStart {
  abort: AbortController;
  /** Settles once this start went to the legacy host or was cancelled; the next waiting start runs after it. */
  passed: Promise<void>;
  pass(): void;
  /** Its start's runner credential, held while it waits (#wg-rbac:#27). */
  config: AgentConfig;
}

/** Resolves when `promise` settles or `signal` aborts, whichever is first. */
function settledOrAborted(promise: Promise<unknown>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = () => { signal.removeEventListener("abort", done); resolve(); };
    signal.addEventListener("abort", done, { once: true });
    promise.then(done, done);
  });
}

export class AgentHostRouter implements AgentLifecycleHost {
  private readonly waitingForOarUnwind = new Map<string, Set<WaitingLegacyStart>>();

  constructor(
    private readonly legacy: LegacyAgentHost,
    private readonly oar: OarAgentHost,
    private readonly deps: AgentHostRouterDeps,
  ) {}

  private hostFor(agentId: string): AgentLifecycleHost | OarAgentHost {
    return this.oar.owns(agentId) ? this.oar : this.legacy;
  }

  /** As `startAgent` decides: OAR's session or start, or the legacy host's (or a start waiting for it). */
  holdsAgentStart(agentId: string): boolean {
    return this.oar.owns(agentId) || this.waitingForOarUnwind.has(agentId) || this.legacy.agentHostState(agentId) === "active";
  }

  async startAgent(
    agentId: string,
    config: AgentConfig,
    wakeMessage?: AgentMessage,
    unreadSummary?: Record<string, number>,
    resumePrompt?: string,
    launchId?: string,
    wakeMessageTransient = false,
    resumeMessages?: AgentMessage[],
    startDispatchId?: string,
    traceParent?: TraceContext | null,
    catchupBatchId?: string,
    recoveryGrant: RecoveryGrant | null = null,
    claimedConnectionEpochId: string | null = null,
  ): Promise<void> {
    const request: AgentStartRequest = {
      agentId, config, wakeMessage, unreadSummary, resumePrompt, launchId, wakeMessageTransient,
      resumeMessages, startDispatchId, traceParent, catchupBatchId, recoveryGrant, claimedConnectionEpochId,
    };
    const oarOnly = getDriver(config.runtime || "claude").oarOnly === true;
    const requested = config.runtimeHost === "oar" || oarOnly ? "oar" : "legacy";
    // A start on either host ends a legacy handback (a start moved to OAR never reaches the legacy host).
    this.legacy.forgetSpecHandback(agentId);
    if (this.oar.owns(agentId)) {
      // Running or starting on OAR: this start is carried by that session.
      this.traceSelection(request, requested, "oar", requested === "oar" ? undefined : "oar_holds_agent");
      await this.oar.start(request);
      return;
    }
    // A start waiting to run on the legacy host holds the agent there.
    const legacyState = this.waitingForOarUnwind.has(agentId) ? "active" : this.legacy.agentHostState(agentId);
    if (requested === "legacy") {
      this.traceSelection(request, requested, "legacy");
      return this.startOnLegacy(request);
    }
    if (legacyState === "active") {
      // Never two runtimes for one agent: the legacy process or start carries it.
      if (oarOnly) return this.failOarOnly(request, "legacy_holds_agent");
      this.traceSelection(request, requested, "legacy", "legacy_holds_agent");
      return this.startOnLegacy(request);
    }
    const support = this.oar.supports(request);
    if (!support.ok) {
      if (oarOnly) return this.failOarOnly(request, support.reason);
      this.traceSelection(request, requested, "legacy", support.reason);
      return this.startOnLegacy(request);
    }
    this.traceSelection(request, requested, "oar");
    // An idle restart config would let the legacy host restart the agent on
    // its own at the next message. Its stop runs synchronously for an agent
    // with no process, so the OAR host registers the start right after it,
    // before `getAgentStartAcceptance` is read.
    const releasedIdle = legacyState === "idle" ? this.legacy.stopAgent(agentId, { silent: true }) : Promise.resolve();
    const started = this.oar.start(request);
    await releasedIdle;
    const outcome = await started;
    if (outcome.kind !== "fallback") return;
    if (oarOnly) return this.failOarOnlyFallback(outcome);
    if (outcome.failHere) return this.failKeptOnOar(outcome, outcome.failHere);
    // Nothing runs on OAR: the legacy host runs this start, as it would have.
    logger.warn(`[Agent ${agentId}] OAR host handed the start back (${outcome.reason}); starting on the legacy host`);
    this.traceSelection(outcome.request, requested, "legacy", outcome.reason, "oar_fallback");
    const legacyStart = this.startOnLegacy(outcome.request);
    for (const held of outcome.held) held.settle(this.legacy.deliverMessage(agentId, held.message, held.context));
    await legacyStart;
  }

  /**
   * An OAR-only start the OAR host will not take (`supports`, or the legacy
   * host holding the agent): it fails with the reason, never reaching the
   * legacy host. Nothing was taken for it, so the core settles its launch.
   */
  private failOarOnly(request: AgentStartRequest, reason: string): never {
    this.traceSelection(request, "oar", "none", reason, "oar_only_refused");
    this.releaseCredential(request);
    const runtime = request.config.runtime;
    throw new OarOnlyStartError({
      runtimeId: runtime,
      hostReason: reason,
      userMessage: reason === "platform_unsupported"
        ? `${runtimeLabel(runtime)} does not run on Windows Computers yet. Move the agent to a macOS or Linux Computer.`
        : `${runtimeLabel(runtime)} could not start on this Computer (${reason}). Retry, or check the Computer's status.`,
    });
  }

  /**
   * #oar-raft:#10: a start the OAR host could not run whose session only it
   * can resume (a Cursor SDK session): the legacy host would drop that
   * session, so the start fails with the OAR host's sentence, as an OAR-only
   * one does, and the next start tries the OAR host again.
   */
  private failKeptOnOar(outcome: Extract<OarStartOutcome, { kind: "fallback" }>, userMessage: string): never {
    const { request, reason } = outcome;
    this.traceSelection(request, "oar", "none", reason, "oar_kept_failed");
    for (const held of outcome.held) held.settle(false);
    this.releaseCredential(request);
    throw new OarOnlyStartError({ runtimeId: request.config.runtime, hostReason: reason, userMessage });
  }

  /**
   * The OAR host handed back an OAR-only start: there is no legacy host to
   * run it, so it fails with the launch's own error where there is one (a
   * missing executable stays `runtime_not_found`), the RFC 071 gate's
   * refusal, or the reason. The deliveries the OAR host held are not taken;
   * the server delivers them again with the next start.
   */
  private failOarOnlyFallback(outcome: Extract<OarStartOutcome, { kind: "fallback" }>): never {
    const { request, reason } = outcome;
    this.traceSelection(request, "oar", "none", reason, "oar_only_failed");
    for (const held of outcome.held) held.settle(false);
    this.releaseCredential(request);
    const runtime = request.config.runtime;
    const label = runtimeLabel(runtime);
    if (outcome.refusal) {
      throw new OarOnlyStartError({
        runtimeId: runtime,
        hostReason: reason,
        userMessage: outcome.refusal.detail,
        notSpawnedReason: outcome.refusal.reason,
      });
    }
    if (reason === "outcome_storage_blocked") {
      throw new OarOnlyStartError({
        runtimeId: runtime,
        hostReason: reason,
        userMessage: RUNTIME_OUTCOME_STORAGE_BLOCKED_TEXT,
        notSpawnedReason: "terminal_failure_outcome_storage_blocked",
      });
    }
    const code = spawnFailureCodeOf(outcome.cause);
    // The refusal names the variables and the fix itself (agentEnvVarPolicy.ts).
    if (code === "env_var_not_allowed" && outcome.cause instanceof Error) throw outcome.cause;
    if (code === "runtime_not_found") {
      throw new OarOnlyStartError({
        runtimeId: runtime,
        hostReason: reason,
        spawnFailureCode: code,
        userMessage: `${label} is not installed on this Computer. Install its CLI there, then restart the agent.`,
      });
    }
    if (reason.startsWith("resume_failed:")) {
      throw new OarOnlyStartError({
        runtimeId: runtime,
        hostReason: reason,
        spawnFailureCode: "session_needs_reset",
        userMessage: `${label} could not resume this agent's saved session, and a new session is never started in its place. Reset the agent's session to start a new one.`,
      });
    }
    // The runtime's own words say what to fix (10-29: Qoder named the model
    // it was asked for and the one it reported); the reason alone said "Error".
    const detail = oarOpenFailureDetail(outcome.cause);
    throw new OarOnlyStartError({
      runtimeId: runtime,
      hostReason: reason,
      userMessage: detail
        ? `${label} failed to start on this Computer: ${detail}. Check the Computer logs for details and retry.`
        : `${label} failed to start on this Computer (${reason}). Check the Computer logs for details and retry.`,
    });
  }

  /**
   * An OAR launch the agent no longer holds may still be undone: a stopped
   * start may still be opening its session, an ended session may still be
   * disposing. Two runtimes never run one session on these hosts, so the
   * legacy start waits for that unwind (behind any start already waiting)
   * unless it is stopped first. (Reconciler step 5: the legacy host's own
   * next start waits for its stopped process's exit itself, and an OAR
   * launch waits for it through `legacyRuntimeExited`.)
   */
  private startOnLegacy(request: AgentStartRequest): Promise<void> {
    const { agentId } = request;
    if (!this.oar.isUnwinding(agentId) && !this.waitingForOarUnwind.has(agentId)) return this.runOnLegacy(request);
    const queue = this.waitingForOarUnwind.get(agentId) ?? new Set<WaitingLegacyStart>();
    const previous = [...queue].at(-1);
    let pass!: () => void;
    const passed = new Promise<void>((resolve) => { pass = resolve; });
    const waiting: WaitingLegacyStart = { abort: new AbortController(), passed, pass, config: request.config };
    queue.add(waiting);
    this.waitingForOarUnwind.set(agentId, queue);
    this.deps.recordEvent("daemon.agent.host.waiting_for_oar_unwind", { agentId, launchId: request.launchId });
    return this.runAfterOarUnwind(request, waiting, previous).finally(pass);
  }

  private async runAfterOarUnwind(request: AgentStartRequest, waiting: WaitingLegacyStart, previous: WaitingLegacyStart | undefined): Promise<void> {
    const { agentId } = request;
    const { signal } = waiting.abort;
    await this.oar.unwound(agentId, signal);
    if (previous) await settledOrAborted(previous.passed, signal);
    const queue = this.waitingForOarUnwind.get(agentId);
    queue?.delete(waiting);
    if (queue?.size === 0) this.waitingForOarUnwind.delete(agentId);
    if (signal.aborted) {
      if (request.launchId) this.deps.settleNotSpawned(agentId, request.launchId, "cancelled");
      this.deps.recordEvent("daemon.agent.host.start_cancelled", { agentId, launchId: request.launchId, stage: "oar_unwind" });
      this.releaseCredential(request);
      return;
    }
    const started = this.runOnLegacy(request);
    waiting.pass();
    await started;
  }

  /** A start no host runs: its runner credential is revoked (#wg-rbac:#27). */
  private releaseCredential(request: AgentStartRequest): void {
    this.deps.releaseUnusedCredential(request.agentId, request.config, request.launchId || null);
  }

  private runOnLegacy(request: AgentStartRequest): Promise<void> {
    return this.legacy.startAgent(
      request.agentId,
      request.config,
      request.wakeMessage,
      request.unreadSummary,
      request.resumePrompt,
      request.launchId,
      request.wakeMessageTransient,
      request.resumeMessages,
      request.startDispatchId,
      request.traceParent,
      request.catchupBatchId,
      request.recoveryGrant,
      request.claimedConnectionEpochId,
    );
  }

  private traceSelection(
    request: AgentStartRequest,
    requested: "oar" | "legacy",
    host: "oar" | "legacy" | "none",
    fallbackReason?: string,
    stage: "start" | "oar_fallback" | "oar_only_refused" | "oar_only_failed" | "oar_kept_failed" = "start",
  ): void {
    logger.info(`[Agent ${request.agentId}] Host ${host} (requested ${requested}${fallbackReason ? `, fallback ${fallbackReason}` : ""})`);
    this.deps.recordEvent("daemon.agent.host.selected", {
      agentId: request.agentId,
      launchId: request.launchId,
      runtime: request.config.runtime,
      requested,
      host,
      stage,
      session_id_present: Boolean(request.config.sessionId),
      ...(fallbackReason ? { fallback_reason: fallbackReason } : {}),
    });
  }

  getAgentStartAcceptance(agentId: string): AgentStartAcceptance {
    if (!this.oar.owns(agentId) && this.waitingForOarUnwind.has(agentId)) return { queueState: "starting", queueDepth: 0, queueAgeMs: 0 };
    return this.hostFor(agentId).getAgentStartAcceptance(agentId);
  }

  private cancelWaitingStarts(agentId?: string): void {
    const queues = agentId === undefined ? [...this.waitingForOarUnwind.values()] : [this.waitingForOarUnwind.get(agentId)];
    for (const queue of queues) for (const waiting of queue ?? []) waiting.abort.abort();
  }

  /**
   * Stop wherever the agent has state, so neither host restarts it
   * afterwards. `wait` also waits for an OAR launch of the agent still being
   * undone, even one an earlier stop already gave up (a migration uploads the
   * workspace next).
   */
  async stopAgent(agentId: string, options?: { wait?: boolean; silent?: boolean }): Promise<void> {
    this.cancelWaitingStarts(agentId);
    if (!this.oar.owns(agentId)) {
      await this.legacy.stopAgent(agentId, options);
    } else {
      await Promise.all([
        this.oar.stopAgent(agentId, options),
        this.legacy.agentHostState(agentId) === "none" ? Promise.resolve() : this.legacy.stopAgent(agentId, { ...options, silent: true }),
      ]);
    }
    if (options?.wait) await this.oar.unwound(agentId);
  }

  async stopAll(): Promise<void> {
    this.cancelWaitingStarts();
    await Promise.all([this.oar.stopAll(), this.legacy.stopAll()]);
  }

  deliverMessage(agentId: string, message: AgentMessage, context?: AgentDeliveryContext): boolean | Promise<boolean> {
    return this.hostFor(agentId).deliverMessage(agentId, message, context);
  }

  purgeInboxMessagesForChannels(agentId: string, channelIds: readonly string[], reason?: string): { removedCount: number } {
    return this.hostFor(agentId).purgeInboxMessagesForChannels(agentId, channelIds, reason);
  }

  respondToActivityProbe(agentId: string, probeId: string): void {
    this.hostFor(agentId).respondToActivityProbe(agentId, probeId);
  }

  interruptTurn(agentId: string): Promise<AgentTurnInterruptReport> {
    return this.hostFor(agentId).interruptTurn(agentId);
  }

  interruptSubagent(agentId: string, subagentTaskId: string): Promise<AgentSubagentInterruptOutcome> {
    return this.hostFor(agentId).interruptSubagent(agentId, subagentTaskId);
  }

  notifyAgentAppInbox(agentId: string, item: AgentInboxAppItem, noticeOptions?: AgentAppInboxNoticeOptions): Promise<boolean> {
    return this.hostFor(agentId).notifyAgentAppInbox(agentId, item, noticeOptions);
  }

  idleNoticeFacts(agentId: string): AgentIdleNoticeFacts | null {
    return this.hostFor(agentId).idleNoticeFacts(agentId);
  }

  deliverIdleNotice(agentId: string, text: string): Promise<AgentIdleNoticeDelivery> {
    return this.hostFor(agentId).deliverIdleNotice(agentId, text);
  }

  /** Release notices reach the runtime that runs the agent; deprecated migrations are completed by the legacy host. */
  deliverRuntimeProfileNotification(
    agentId: string,
    key: string,
    kind: "migration" | "daemon_release_notice",
    content: string,
    traceparent?: string,
    launchId?: string | null,
  ): boolean | Promise<boolean> {
    const host = kind === "daemon_release_notice" && this.oar.owns(agentId) ? this.oar : this.legacy;
    return host.deliverRuntimeProfileNotification(agentId, key, kind, content, traceparent, launchId);
  }

  getRunningAgentIds(): string[] {
    return [...this.legacy.getRunningAgentIds(), ...this.oar.getRunningAgentIds()];
  }

  /** Both hosts', and those of the starts waiting here for an OAR unwind. */
  getHeldRunnerCredentialIds(): string[] {
    const ids = new Set([...this.legacy.getHeldRunnerCredentialIds(), ...this.oar.getHeldRunnerCredentialIds()]);
    for (const queue of this.waitingForOarUnwind.values()) {
      for (const waiting of queue) if (waiting.config.agentCredentialId) ids.add(waiting.config.agentCredentialId);
    }
    return [...ids];
  }

  getAgentSessionId(agentId: string): string | null {
    return this.hostFor(agentId).getAgentSessionId(agentId);
  }

  getAgentLaunchId(agentId: string): string | null {
    return this.hostFor(agentId).getAgentLaunchId(agentId);
  }

  setTracer(tracer: Tracer): void {
    this.legacy.setTracer(tracer);
    this.oar.setTracer(tracer);
  }

  setCliTransportTraceDir(traceDir: string | null): void {
    this.legacy.setCliTransportTraceDir(traceDir);
    this.oar.setCliTransportTraceDir(traceDir);
  }

  setServerTurnEndedCapable(capable: boolean): void {
    // Optional on the process manager's test stand-ins (the core calls it as `?.`).
    this.legacy.setServerTurnEndedCapable?.(capable);
    this.oar.setServerTurnEndedCapable(capable);
  }

  setServerStickyFailureReasonsCapable(capable: boolean): void {
    this.legacy.setServerStickyFailureReasonsCapable?.(capable);
    this.oar.setServerStickyFailureReasonsCapable?.(capable);
  }

  /**
   * Reconciler step 11: to the host that owns the agent now, as every other
   * lifecycle call. Neither host restarts an agent for it; a spec stop that
   * needs another host is left to the server's next start, which this router
   * places (specChangeNeedsServerStart).
   */
  applyConfig(agentId: string, config: AgentConfig, revision: number): void {
    this.hostFor(agentId).applyConfig?.(agentId, config, revision);
  }

  /**
   * Reconciler step 13: both hosts drain with the same (clamped) deadline;
   * the drain is quiet only when both are. A host with no drain (a test
   * stand-in) is quiet at once.
   */
  async beginDrain(options: AgentDrainOptions): Promise<AgentDrainSummary> {
    const deadlineMs = clampAgentDrainDeadlineMs(options.deadlineMs);
    // Step 14: a drain of one agent goes to both hosts too (the agent may
    // have state in both while it moves between them); the host it does not
    // run on is quiet at once.
    const scoped = { deadlineMs, ...(options.agentId === undefined ? {} : { agentId: options.agentId }) };
    const [oar, legacy] = await Promise.all([
      this.oar.beginDrain(scoped),
      this.legacy.beginDrain ? this.legacy.beginDrain(scoped) : null,
    ]);
    return mergeDrainSummaries(legacy ? [legacy, oar] : [oar]);
  }

  endDrain(agentId?: string): void {
    this.legacy.endDrain?.(agentId);
    this.oar.endDrain(agentId);
  }

  /** Both hosts' progress joined; null when neither holds (a host whose drain expired on its own counts as not holding). */
  drainProgress(agentId?: string): AgentDrainProgress | null {
    const progresses = [this.legacy.drainProgress?.(agentId) ?? null, this.oar.drainProgress(agentId)].filter((each): each is AgentDrainProgress => each !== null);
    if (progresses.length === 0) return null;
    return {
      live: progresses.reduce((sum, each) => sum + each.live, 0),
      notQuiet: progresses.flatMap((each) => each.notQuiet),
      notRunnable: progresses.flatMap((each) => each.notRunnable ?? []),
    };
  }

  /** Both hosts: each decides its own sessions (reconciler step 6, rows A1 and A2). */
  applyServerFeatures(features: AgentServerFeatures): void {
    this.legacy.applyServerFeatures?.(features);
    this.oar.applyServerFeatures(features);
  }
}

/** One drain summary for both hosts: the worst ending (ended, then deadline, then quiet), the lists joined. */
function mergeDrainSummaries(summaries: readonly AgentDrainSummary[]): AgentDrainSummary {
  const rank = { quiet: 0, deadline: 1, ended: 2 } as const;
  return summaries.reduce((merged, each) => ({
    finished: rank[each.finished] > rank[merged.finished] ? each.finished : merged.finished,
    deadlineAtMs: Math.max(merged.deadlineAtMs, each.deadlineAtMs),
    durationMs: Math.max(merged.durationMs, each.durationMs),
    waitedFor: [...merged.waitedFor, ...each.waitedFor],
    notQuiet: [...merged.notQuiet, ...each.notQuiet],
    notRunnable: [...(merged.notRunnable ?? []), ...(each.notRunnable ?? [])],
    live: merged.live + each.live,
  }));
}

/** The runtime's user-facing name, OAR-only runtimes included. */
export function runtimeLabel(runtime: string): string {
  return isOarOnlyRuntimeId(runtime) ? OAR_ONLY_RUNTIMES[runtime].displayName : getRuntimeDisplayName(runtime);
}

/**
 * The first line of the error that ended an OAR-only start. It becomes the
 * agent's activity detail, which every member and agent of the server can
 * read, so credential shapes and URLs are masked (best effort, as for the
 * other diagnostic text that leaves a machine) and it is kept short.
 */
export function oarOpenFailureDetail(cause: unknown): string | undefined {
  if (!(cause instanceof Error)) return undefined;
  const line = cause.message.split("\n")[0]!.replace(/\s+/g, " ").trim();
  if (!line) return undefined;
  const redacted = redactDiagnosticText(line, { urls: "drop" });
  const chars = Array.from(redacted);
  return chars.length > 200 ? `${chars.slice(0, 199).join("")}…` : redacted;
}
