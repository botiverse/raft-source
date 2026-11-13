// The one idle definition (reconciler design §2.3, #proj-raft-computer:#46).
// Every "may this process be replaced or rotated now" gate asks this, and
// nothing else: no last runtime error, no transcript scan, and no blind
// settle timer. The one wait after a turn end (`queuedInputPending`) applies
// only when input is known to have been written into the turn that ended,
// so the runtime may run it next; a turn end with no such write is idle at
// once. A gate that needs more than idle (a stale spec, a broken process)
// adds its own reason on top; it never redefines idle.

/** What the daemon knows about one live process, read in one tick. */
export interface AgentIdleFacts {
  /** The runtime ended its turn (APM's gated idle). */
  turnEnded: boolean;
  /** Background tasks or subagents the turn started that have not ended. */
  backgroundTasks: number;
  /** Deliveries written to stdin that no turn has consumed yet. */
  unconsumedStdin: number;
  /**
   * Input written while the last turn ran, which the runtime may run as a
   * turn of its own right after that turn end (Claude Code queues it): from
   * that turn end until a turn starts, at most QUEUED_INPUT_SETTLE_MS, and
   * while the turn that started on it runs, until its own end
   * (DeliveryConsumptionWatch.queuedInputPending). The ended turn's own
   * events cannot tell: they count it consumed either way.
   */
  queuedInputPending: boolean;
  /** A delivery the session has not been told about yet, or one waiting to be retried. */
  untoldInbox: boolean;
  /** A tracked mention occurrence told to the session but not yet settled by a turn end. */
  trackedMentionOpen: boolean;
}

/**
 * Why the agent is not idle, or null when it is. The names are the ones pi
 * rotation already reports in `pi.session.rotation_skipped`.
 */
export type AgentNotIdleReason = "agent_busy" | "background_tasks" | "delivery_in_flight" | "mention_in_flight";

/** The one option of the idle definition. */
export interface AgentIdleOptions {
  /**
   * Reconciler step 13 (decision Q-H): a drain (agentDrain.ts) holds new
   * input on purpose, and that input stays unread on the server, so it asks
   * whether the process is quiet: idle with only the `untoldInbox` clause
   * dropped. A host that builds the facts for it also leaves out of
   * `trackedMentionOpen` a mention still held untold (it is untold inbox).
   * Every other clause stays: background tasks, unconsumed stdin, queued
   * input and a told mention keep a process busy.
   */
  ignoreUntoldInbox?: boolean;
}

export function agentNotIdleReason(facts: AgentIdleFacts, options: AgentIdleOptions = {}): AgentNotIdleReason | null {
  if (!facts.turnEnded) return "agent_busy";
  // task #1260: the turn ends while its background tasks still run.
  if (facts.backgroundTasks > 0) return "background_tasks";
  // A delivery written near the turn end can still sit unread in stdin.
  if ((facts.untoldInbox && !options.ignoreUntoldInbox) || facts.unconsumedStdin > 0 || facts.queuedInputPending) return "delivery_in_flight";
  if (facts.trackedMentionOpen) return "mention_in_flight";
  return null;
}

// "Not runnable" (tygg, #14554 follow-up): an agent that cannot run a model
// turn now. A stop-wait (a drain: a /migrate source stop, a web upgrade)
// that waits for a clause only a model turn settles would wait for a turn
// that never comes, until its deadline (up to 10 min). Only facts the
// daemon already holds count; each makes a turn before the deadline
// hopeless, not merely slow.

/** What the daemon knows about whether an agent's runtime can run a model turn, read in one tick. */
export interface AgentRunnableFacts {
  /** A runtime process exists and has not exited (its spawn did not fail). */
  processAlive: boolean;
  /**
   * An invalid record on the agent's credential key (ProviderLimitLedger,
   * mirrored by the RuntimeReadinessStore): verification_required, a sign-in
   * to redo, billing, no access to its model.
   */
  credentialInvalid: boolean;
  /** Its credential's quota is exhausted (a provider-limit record still running). */
  quotaExhausted: boolean;
  /** Its config names another runtime than the process runs: the binding fence refuses its input and output. */
  runtimeMismatch: boolean;
}

export type AgentNotRunnableReason = "process_not_alive" | "runtime_mismatch" | "credential_invalid" | "quota_exhausted";

/** Why the agent cannot run a model turn now, or null when it can. */
export function agentNotRunnableReason(facts: AgentRunnableFacts): AgentNotRunnableReason | null {
  if (!facts.processAlive) return "process_not_alive";
  if (facts.runtimeMismatch) return "runtime_mismatch";
  if (facts.credentialInvalid) return "credential_invalid";
  if (facts.quotaExhausted) return "quota_exhausted";
  return null;
}

/** A stop-wait's answer for one process: why it still waits, or why it need not although it is not idle. */
export interface AgentStopWait {
  /** The idle clause the wait still waits for; null: it may be stopped now. */
  notIdle: AgentNotIdleReason | null;
  /** Set only when the agent is not idle and is let go because it cannot run: the reason. */
  notRunnable: AgentNotRunnableReason | null;
  /** With `notRunnable`: the clause that would have kept it (agentNotIdleReason). */
  settled: AgentNotIdleReason | null;
}

/**
 * The one stop-wait predicate (a drain's quiet): the idle definition, except
 * that an agent that cannot run (agentNotRunnableReason) with no turn in
 * flight has the clauses only a model turn settles taken as settled:
 * unconsumed stdin, queued input, an open mention, the untold inbox. Nothing
 * is read or acknowledged for them: what the process was given and never
 * took stays unread on the server, for the target (or the next process).
 *
 * A turn in flight still waits (a deadline bounds it), and so do background
 * tasks: they end without a model turn. Without a live process neither can
 * run, and nothing is waited for.
 */
export function agentStopWaitReason(facts: AgentIdleFacts, runnable: AgentRunnableFacts, options: AgentIdleOptions = {}): AgentStopWait {
  const notIdle = agentNotIdleReason(facts, options);
  if (notIdle === null) return { notIdle, notRunnable: null, settled: null };
  const notRunnable = agentNotRunnableReason(runnable);
  if (notRunnable === null) return { notIdle, notRunnable: null, settled: null };
  if (notRunnable !== "process_not_alive" && (notIdle === "agent_busy" || notIdle === "background_tasks")) {
    return { notIdle, notRunnable: null, settled: null };
  }
  return { notIdle: null, notRunnable, settled: notIdle };
}
