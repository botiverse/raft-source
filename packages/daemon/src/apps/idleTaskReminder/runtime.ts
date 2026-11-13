// Idle task reminder (#wg-task-v2:#9), the Computer side.
//
// On the agent's Working→Idle edge the Computer asks the Server, as the agent,
// which open tasks assigned to it to remind it of now
// (`POST /internal/agent-api/tasks/idle-nudge`). The Server decides what to
// list, records it as reminded and builds the notice; the Computer delivers
// that text as it is, only into an idle session with nothing else waiting for
// it. Idle alone never sends anything: a stopped, blocked or busy agent is not
// asked about, and an undelivered notice is not kept (the next idle edge asks
// again). Asked only of a Server that advertises
// SERVER_CAPABILITY_IDLE_TASK_REMINDER_V1; the Server's own flag decides
// whether it reminds at all.

import {
  agentApiContract,
  type AgentApiTaskIdleNudgeBody,
  type AgentApiTaskIdleNudgeResponse,
} from "@botiverse/raft-shared";
import type { AgentIdleNoticeDelivery, AgentIdleNoticeFacts } from "../../agentHost/agentLifecycleHost";

/** The trace `app_id` of this built-in app (it has no config and no Inbox items). */
export const IDLE_TASK_REMINDER_TRACE_APP_ID = "system.idle-task-reminder";

/** One ask may take this long before it is given up (the edge is not retried). */
export const IDLE_TASK_REMINDER_ASK_TIMEOUT_MS = 15_000;

/** The route body's bound (agentApiTaskIdleNudgeBodySchema). */
const BACKGROUND_TASKS_MAX = 10_000;

/** Why an ask produced no answer; traced, never surfaced to the agent. */
export type IdleTaskReminderAskFailureReason =
  | "no_credential"
  | "http_error"
  | "network"
  | "timeout"
  | "invalid_response";

export class IdleTaskReminderAskFailure extends Error {
  constructor(readonly reason: IdleTaskReminderAskFailureReason, readonly httpStatus?: number) {
    super(`idle task reminder ask failed: ${reason}${httpStatus ? ` (HTTP ${httpStatus})` : ""}`);
    this.name = "IdleTaskReminderAskFailure";
  }
}

/** Asks the Server as the agent; throws IdleTaskReminderAskFailure. */
export type IdleTaskReminderAsk = (agentId: string, body: AgentApiTaskIdleNudgeBody) => Promise<AgentApiTaskIdleNudgeResponse>;

export type IdleTaskReminderTrace = (
  name: string,
  attrs: Readonly<Record<string, unknown>>,
  status?: "ok" | "error",
) => void;

export interface IdleTaskReminderRuntimeOptions {
  ask: IdleTaskReminderAsk;
  /** The agent's live session (AgentLifecycleHost.idleNoticeFacts); null: nothing runs it. */
  agentFacts(agentId: string): AgentIdleNoticeFacts | null;
  /** Writes the notice now or not at all (AgentLifecycleHost.deliverIdleNotice). */
  deliver(agentId: string, text: string): Promise<AgentIdleNoticeDelivery>;
  trace?: IdleTaskReminderTrace;
}

/** The answer's skip reasons after which a fresh session needs no first full listing any more. */
const FRESH_SESSION_SETTLED_SKIP_REASONS: ReadonlySet<string> = new Set(["no_open_tasks", "disabled"]);

/** Counts per item reason, `newly_assigned:1,stale:2` (closed reasons only). */
function itemReasonCounts(items: AgentApiTaskIdleNudgeResponse["items"]): string {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.reason, (counts.get(item.reason) ?? 0) + 1);
  return [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([reason, count]) => `${reason}:${count}`).join(",");
}

export class IdleTaskReminderRuntime {
  private capable = false;
  /** At most one ask per agent at a time; an edge during one is dropped. */
  private readonly inFlight = new Set<string>();
  private readonly pendingRuns = new Set<Promise<void>>();
  private readonly runByAgent = new Map<string, Promise<void>>();
  /**
   * Per agent, the session whose first full listing is done: a reminder asked
   * with `freshSession` was delivered, or the Server said there is nothing to
   * list. Until then every ask of a new session says `freshSession` (a capped
   * or undelivered one records nothing for it). Process-local: after a daemon
   * restart the agent's session is resumed, which is never fresh.
   */
  private readonly freshSessionDone = new Map<string, string>();
  /**
   * Per agent, the model context that got a notice with the rule blocks
   * (#wg-ax:#32). Asks in that context say `rulesShown`; a new session,
   * compaction or handoff has a new id, so its first notice is full again.
   */
  private readonly rulesShownIn = new Map<string, string>();
  private readonly trace: IdleTaskReminderTrace;

  constructor(private readonly options: IdleTaskReminderRuntimeOptions) {
    const trace = options.trace;
    this.trace = trace
      ? (name, attrs, status) => trace(name, { app_id: IDLE_TASK_REMINDER_TRACE_APP_ID, ...attrs }, status)
      : () => {};
  }

  /** The connected Server advertises SERVER_CAPABILITY_IDLE_TASK_REMINDER_V1 (false while disconnected). */
  setServerCapable(capable: boolean): void {
    this.capable = capable;
  }

  /**
   * The agent just went from Working to Idle. Never throws: the idle
   * transition it rides on must not break.
   */
  onAgentWorkingToIdle(agentId: string): void {
    if (!this.capable) return;
    if (this.inFlight.has(agentId)) {
      this.trace("daemon.idle_task_reminder.skipped", { agentId, reason: "in_flight" });
      return;
    }
    let facts: AgentIdleNoticeFacts | null;
    try {
      facts = this.options.agentFacts(agentId);
    } catch {
      this.trace("daemon.idle_task_reminder.skipped", { agentId, reason: "facts_failed" }, "error");
      return;
    }
    // Stopped (no live session) or blocked: no edge to remind on, nothing queued.
    if (!facts) return;
    if (facts.blocked) {
      this.trace("daemon.idle_task_reminder.skipped", { agentId, reason: "blocked" });
      return;
    }
    const sessionKey = facts.sessionId ?? `launch:${facts.launchId ?? ""}`;
    const freshSession = !facts.resumed && this.freshSessionDone.get(agentId) !== sessionKey;
    const backgroundTasks = Math.max(0, Math.min(BACKGROUND_TASKS_MAX, Math.floor(facts.backgroundTasks) || 0));
    this.inFlight.add(agentId);
    const contextId = facts.contextId ?? null;
    const rulesShown = contextId !== null && this.rulesShownIn.get(agentId) === contextId;
    const run = this.run(agentId, facts, sessionKey, freshSession, backgroundTasks, contextId, rulesShown)
      .catch(() => {
        // run() traces its own failures; this guards an injected seam bug.
        this.trace("daemon.idle_task_reminder.skipped", { agentId, reason: "runtime_failure" }, "error");
      })
      .finally(() => {
        this.inFlight.delete(agentId);
        this.pendingRuns.delete(run);
        if (this.runByAgent.get(agentId) === run) this.runByAgent.delete(agentId);
      });
    this.pendingRuns.add(run);
    this.runByAgent.set(agentId, run);
  }

  /** Settles once the agent's ask in flight (if any) is done: other idle work waits for it. */
  settled(agentId: string): Promise<void> {
    return this.runByAgent.get(agentId) ?? Promise.resolve();
  }

  async waitForIdle(): Promise<void> {
    while (this.pendingRuns.size > 0) {
      await Promise.all([...this.pendingRuns]);
    }
  }

  clear(): void {
    this.capable = false;
    this.freshSessionDone.clear();
    this.rulesShownIn.clear();
  }

  private async run(
    agentId: string,
    facts: AgentIdleNoticeFacts,
    sessionKey: string,
    freshSession: boolean,
    backgroundTasks: number,
    contextId: string | null,
    rulesShown: boolean,
  ): Promise<void> {
    const attrs = {
      agentId,
      ...(facts.launchId ? { launchId: facts.launchId } : {}),
      fresh_session: freshSession,
      background_tasks: backgroundTasks,
      rules_shown: rulesShown,
    };
    let response: AgentApiTaskIdleNudgeResponse;
    try {
      response = await this.options.ask(agentId, { freshSession, backgroundTasks, ...(rulesShown ? { rulesShown: true } : {}) });
    } catch (error) {
      const failure = error instanceof IdleTaskReminderAskFailure ? error : null;
      this.trace("daemon.idle_task_reminder.call", {
        ...attrs,
        outcome: "ask_failed",
        failure_reason: failure?.reason ?? "unknown",
        ...(failure?.httpStatus ? { http_status: failure.httpStatus } : {}),
      }, "error");
      return;
    }
    let delivered: AgentIdleNoticeDelivery | "not_sent" = "not_sent";
    if (response.send && response.text) {
      try {
        delivered = await this.options.deliver(agentId, response.text);
      } catch {
        delivered = "write_failed";
      }
    }
    if (freshSession && (delivered === "written" || FRESH_SESSION_SETTLED_SKIP_REASONS.has(response.reason ?? ""))) {
      this.freshSessionDone.set(agentId, sessionKey);
    }
    // Only a written notice that carried the rules puts them into the context.
    if (delivered === "written" && response.rules === true && contextId !== null) this.rulesShownIn.set(agentId, contextId);
    this.trace("daemon.idle_task_reminder.call", {
      ...attrs,
      outcome: "answered",
      send: response.send,
      ...(response.reason ? { reason: response.reason } : {}),
      items: response.items.length,
      ...(response.items.length > 0 ? { item_reasons: itemReasonCounts(response.items) } : {}),
      backlog: response.backlog.length,
      delivered,
    }, delivered === "write_failed" ? "error" : "ok");
  }
}

/**
 * The production ask: `fetchAsAgent` sends with the agent's own runner
 * credential (agentCredentialProxy.fetchAgentApiAsAgent) and returns null when
 * it has none. The answer is checked against the route's response contract.
 */
export function createIdleTaskReminderAsk(deps: {
  fetchAsAgent(agentId: string, pathname: string, init: { method: "POST"; body: unknown; signal?: AbortSignal }): Promise<Response | null>;
  timeoutMs?: number;
}): IdleTaskReminderAsk {
  const route = agentApiContract.taskIdleNudge;
  return async (agentId, body) => {
    const signal = AbortSignal.timeout(deps.timeoutMs ?? IDLE_TASK_REMINDER_ASK_TIMEOUT_MS);
    let res: Response | null;
    try {
      res = await deps.fetchAsAgent(agentId, route.fullPath, { method: "POST", body, signal });
    } catch (error) {
      throw new IdleTaskReminderAskFailure(signal.aborted || (error as { name?: string })?.name === "TimeoutError" ? "timeout" : "network");
    }
    if (!res) throw new IdleTaskReminderAskFailure("no_credential");
    if (!res.ok) {
      await res.arrayBuffer().catch(() => undefined);
      throw new IdleTaskReminderAskFailure("http_error", res.status);
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new IdleTaskReminderAskFailure(signal.aborted ? "timeout" : "invalid_response");
    }
    const parsed = route.response.body.safeParse(json);
    if (!parsed.success) throw new IdleTaskReminderAskFailure("invalid_response");
    return parsed.data;
  };
}
