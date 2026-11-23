// The wake-up notice's rows ask (#wg-ax:#42), the Computer side.
//
// Before a wake-up notice lists conversations, the Computer asks the Server,
// as the agent, for the `inbox check` rows of those conversations
// (`POST /internal/agent-api/inbox/rows`), so the notice prints the Server's
// unread numbers. The notice itself is built in synchronous code that cannot
// wait, so the ask runs ahead of it (when a message is queued, while an idle
// delivery is held, before a start) and the notice builder takes whatever
// answer is here by then:
//
// - one request in flight per agent at most; messages that arrive meanwhile
//   fold into one follow-up ask after it settles;
// - the ask says `withBehind`: the Server's unread view trails a new message
//   by a second or more, so it answers each named conversation's row as far
//   as the view has got (`activitySeq`) and the notice adds the messages the
//   Computer holds after that (shared mergeAgentInboxNoticeRows). Such an
//   answer settles every conversation it was asked about: one without a row
//   has nothing unread the view knows of, and is not asked again for that seq;
// - an answer may number a row only by coverage, never by age: the seq asked
//   for that conversation is at least the newest seq about to be listed (an
//   older answer may predate a read). From a Server that does not know
//   `withBehind`, a conversation it answered no row for is not remembered as
//   asked (its view may not have seen the new message yet): it is asked once
//   more a moment later, and by any later ask;
// - a row that is not covered, and every row when the ask failed, prints
//   without a number. A failed request is not retried;
// - after a 403 or 404 the session is not asked again.
//
// Host independent: a host says which session it asks for and passes its
// projection rows; the legacy host (agentProcessManager) uses it today.

import {
  AGENT_API_INBOX_ROWS_MAX_TARGETS,
  agentApiContract,
  createTraceContext,
  formatTraceparent,
  type AgentApiInboxRowsBody,
  type AgentApiInboxRowsResponse,
} from "@botiverse/raft-shared";

/** One ask may take this long; then the notice lists its conversations without numbers. */
export const INBOX_ROWS_ASK_TIMEOUT_MS = 800;
/**
 * How long after an answer that left a conversation without a row the same
 * conversations are asked once more (for a busy agent only). The Server's unread view trails a new
 * message briefly; a busy agent's notice is written seconds after the message
 * was queued, so the second answer is usually there by then.
 */
export const INBOX_ROWS_REASK_DELAY_MS = 1_000;

export const INBOX_ROWS_CALL_EVENT = "daemon.inbox_rows.call";
export const INBOX_ROWS_NOTICE_EVENT = "daemon.inbox_rows.notice";

export type InboxRowsHost = "legacy" | "oar";

/** Where an ask was started: a message queued for a busy agent, an idle delivery held for it, an OAR hand-off, a start. */
export type InboxRowsCallSite = "queued" | "idle_hold" | "handoff" | "session_start";

/** Why an ask produced no answer; traced, never surfaced to the agent. */
export type InboxRowsFailureReason =
  | "timeout"
  | "http_403"
  | "http_404"
  | "http_4xx"
  | "http_5xx"
  | "network"
  | "contract"
  | "no_credential"
  | "aborted";

/** The fields of a notice row (AgentInboxTargetRow) the ask reads. */
export type InboxRowsListedRow = { channelId?: string; latestSeq?: number };

export type InboxRowsTarget = AgentApiInboxRowsBody["targets"][number];

/** What a notice builder gets: the answer cut down to what it may use for the rows it lists. */
export type InboxRowsCovered = {
  /** The answer without the rows of conversations it does not cover; null when it covers none (or there is none). */
  response: AgentApiInboxRowsResponse | null;
  /** The listed conversations the answer covers (channel ids, lower case): one not in it prints without a number even when the answer has no row for it. */
  ids: ReadonlySet<string>;
  /**
   * The answer's `otherUnread`, only when the answer was asked about exactly
   * the conversations listed and covers each: the number is relative to the
   * set that was asked. Null otherwise (no "Older unread" line).
   */
  older: AgentApiInboxRowsResponse["otherUnread"] | null;
};

export type InboxRowsFetchAsAgent = (
  agentId: string,
  pathname: string,
  init: { method: "POST"; body: unknown; signal?: AbortSignal; traceparent?: string },
) => Promise<Response | null>;

export type InboxRowsRecordEvent = (
  name: string,
  attrs: Record<string, unknown>,
  status?: "ok" | "error",
  parentTraceparent?: string | null,
) => void;

export interface InboxRowsAskOptions {
  host: InboxRowsHost;
  /** Sends with the agent's own runner credential (agentCredentialProxy.fetchAgentApiAsAgent); null when it has none. */
  fetchAsAgent: InboxRowsFetchAsAgent;
  recordEvent: InboxRowsRecordEvent;
  timeoutMs?: number;
  reaskDelayMs?: number;
}

const route = agentApiContract.inboxRows;

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** A conversation row (its channel id is a uuid), not the grouped third-party events row or an app item. */
export function isInboxRowsConversation(channelId: string | null | undefined): channelId is string {
  return typeof channelId === "string" && UUID_SHAPE.test(channelId);
}

/**
 * What to ask for the rows a notice is about to list: one target per
 * conversation, newest first, at most AGENT_API_INBOX_ROWS_MAX_TARGETS. A row
 * the route would refuse (a third-party events row, a row with no seq) is
 * left out: it prints as the Computer has it.
 */
export function inboxRowsTargets(rows: readonly InboxRowsListedRow[]): InboxRowsTarget[] {
  const newest = new Map<string, InboxRowsTarget>();
  for (const row of rows) {
    if (!isInboxRowsConversation(row.channelId) || typeof row.latestSeq !== "number") continue;
    const target = { channelId: row.channelId, newestSeq: row.latestSeq };
    // The route's own body schema decides, so a target it would answer 400 for is never sent.
    if (!route.request.body.safeParse({ targets: [target] }).success) continue;
    const key = target.channelId.toLowerCase();
    const known = newest.get(key);
    if (!known || known.newestSeq < target.newestSeq) newest.set(key, target);
  }
  return [...newest.values()].sort((a, b) => b.newestSeq - a.newestSeq).slice(0, AGENT_API_INBOX_ROWS_MAX_TARGETS);
}

/** Channel id (lower case) to the newest seq asked for it. */
type Asked = Map<string, number>;

type Flight = {
  asked: Asked;
  controller: AbortController;
  /** Why the controller was aborted: the hard timeout, or a stop / session change / shutdown. */
  abortReason: "timeout" | "aborted" | null;
  done: Promise<void>;
};

type FollowUp = {
  targets: Map<string, InboxRowsTarget>;
  callSite: InboxRowsCallSite;
  done: Promise<void>;
  settle: () => void;
};

type SessionState = {
  sessionKey: string;
  /** A 403 or 404 answered: this session is not asked again. */
  stopped: boolean;
  flight: Flight | null;
  followUp: FollowUp | null;
  /**
   * `asked` is everything the request named (the answer's `otherUnread` is
   * relative to it); `rowed` is the part that came back with a row, the only
   * part that counts as asked from then on.
   */
  answer: { asked: Asked; rowed: Asked; response: AgentApiInboxRowsResponse; callSite: InboxRowsCallSite } | null;
  /** The one second ask after an answer with a conversation left out. */
  reaskTimer: ReturnType<typeof setTimeout> | null;
  lastCallSite: InboxRowsCallSite | null;
};

type CallOutcome =
  | { ok: true; response: AgentApiInboxRowsResponse }
  | { ok: false; reason: InboxRowsFailureReason; httpStatus?: number };

function httpFailureReason(status: number): InboxRowsFailureReason {
  if (status === 403) return "http_403";
  if (status === 404) return "http_404";
  return status >= 500 ? "http_5xx" : "http_4xx";
}

const covers = (asked: Asked, target: InboxRowsTarget): boolean => (asked.get(target.channelId.toLowerCase()) ?? 0) >= target.newestSeq;

export class InboxRowsAsk {
  private readonly sessions = new Map<string, SessionState>();
  private readonly timeoutMs: number;
  private readonly reaskDelayMs: number;

  constructor(private readonly options: InboxRowsAskOptions) {
    this.timeoutMs = options.timeoutMs ?? INBOX_ROWS_ASK_TIMEOUT_MS;
    this.reaskDelayMs = options.reaskDelayMs ?? INBOX_ROWS_REASK_DELAY_MS;
  }

  /**
   * Ask about `rows` (what the next notice of this session would list).
   * Returns a promise that resolves, never rejects, once an ask that named
   * them has settled (answered or not); null when nothing is asked: no
   * conversation to ask about, the answer here already has a row for each, or
   * the session is not asked any more.
   *
   * While a request is in flight no second one starts: the rows fold into a
   * single follow-up ask sent when it settles.
   */
  ask(agentId: string, sessionKey: string, rows: readonly InboxRowsListedRow[], callSite: InboxRowsCallSite): Promise<void> | null {
    const state = this.sessionFor(agentId, sessionKey);
    if (state.stopped) return null;
    const targets = inboxRowsTargets(rows);
    if (targets.length === 0) return null;
    const answered = state.answer?.rowed;
    if (answered && targets.every((target) => covers(answered, target))) return null;
    if (!state.flight) return this.start(agentId, state, targets, callSite).done;
    const inFlight = state.flight.asked;
    if (targets.every((target) => covers(inFlight, target))) return state.flight.done;
    if (!state.followUp) {
      let settle = () => {};
      const done = new Promise<void>((resolve) => { settle = resolve; });
      state.followUp = { targets: new Map(), callSite, done, settle };
    }
    for (const target of targets) {
      const key = target.channelId.toLowerCase();
      const known = state.followUp.targets.get(key);
      if (!known || known.newestSeq < target.newestSeq) state.followUp.targets.set(key, target);
    }
    return state.followUp.done;
  }

  /** The session's latest answer, restricted to the conversations of `rows` it covers. */
  covered(agentId: string, sessionKey: string, rows: readonly InboxRowsListedRow[]): InboxRowsCovered {
    const state = this.sessions.get(agentId);
    const answer = state?.sessionKey === sessionKey ? state.answer : null;
    if (!answer) return { response: null, ids: new Set(), older: null };
    const listed = new Set<string>();
    const coveredIds = new Set<string>();
    let allCovered = true;
    for (const row of rows) {
      if (!isInboxRowsConversation(row.channelId)) continue;
      const key = row.channelId.toLowerCase();
      if (listed.has(key)) {
        // Two listed rows claim one channel id (a row with no id of its own falls back to its
        // parent's): the Server's row cannot be told to belong to either, so neither takes it.
        coveredIds.delete(key);
        allCovered = false;
        continue;
      }
      listed.add(key);
      // The same test for an answer that is added to (`withBehind`): there `rowed` is everything
      // asked, so a conversation without a row is covered too. The seq still has to cover the
      // newest message listed: an answer from before a read, or before an earlier notice took
      // some of what was held, must not be added to messages that came after it.
      if (typeof row.latestSeq === "number" && (answer.rowed.get(key) ?? 0) >= row.latestSeq) coveredIds.add(key);
      else allCovered = false;
    }
    if (coveredIds.size === 0) return { response: null, ids: new Set(), older: null };
    const askedOnlyListed = [...answer.asked.keys()].every((key) => listed.has(key));
    return {
      response: { ...answer.response, rows: answer.response.rows.filter((row) => coveredIds.has(row.channelId.toLowerCase())) },
      ids: coveredIds,
      older: allCovered && askedOnlyListed ? answer.response.otherUnread : null,
    };
  }

  /** The session answered 403 or 404 and is not asked again. */
  stopped(agentId: string, sessionKey: string): boolean {
    const state = this.sessions.get(agentId);
    return state?.sessionKey === sessionKey && state.stopped;
  }

  /**
   * One event per notice built with the Server's rows in mind. An ask made
   * when a message was queued cannot know whether its answer is used: that is
   * only known here, so the fallback rate is read from this event.
   */
  recordNotice(agentId: string, sessionKey: string, notice: { answerUsed: boolean; listedRows: number; numberlessRows: number }): void {
    const state = this.sessions.get(agentId);
    const session = state?.sessionKey === sessionKey ? state : null;
    this.record(INBOX_ROWS_NOTICE_EVENT, {
      agentId,
      host: this.options.host,
      call_site: session?.answer?.callSite ?? session?.lastCallSite ?? "none",
      answer_used: notice.answerUsed,
      listed_rows: notice.listedRows,
      numberless_rows: notice.numberlessRows,
    });
  }

  /** The agent's live session is `sessionKey` now: what belonged to another one is aborted and forgotten. */
  noteSession(agentId: string, sessionKey: string | null): void {
    const state = this.sessions.get(agentId);
    if (state && state.sessionKey !== sessionKey) this.reset(agentId);
  }

  /** The agent stopped or its session ended: abort what is in flight and forget the answer and the memo. */
  reset(agentId: string): void {
    const state = this.sessions.get(agentId);
    if (!state) return;
    this.sessions.delete(agentId);
    if (state.reaskTimer) clearTimeout(state.reaskTimer);
    state.reaskTimer = null;
    if (state.flight) {
      state.flight.abortReason ??= "aborted";
      state.flight.controller.abort();
    }
    state.followUp?.settle();
    state.followUp = null;
  }

  /** Shutdown. */
  resetAll(): void {
    for (const agentId of [...this.sessions.keys()]) this.reset(agentId);
  }

  /** Telemetry never decides an ask or a notice: a recorder that throws is not let through. */
  private record(...args: Parameters<InboxRowsRecordEvent>): void {
    try {
      this.options.recordEvent(...args);
    } catch {
      // Nothing to do with it here.
    }
  }

  private sessionFor(agentId: string, sessionKey: string): SessionState {
    const known = this.sessions.get(agentId);
    if (known?.sessionKey === sessionKey) return known;
    // Another session: what was asked, answered and refused belonged to the old one.
    if (known) this.reset(agentId);
    const state: SessionState = { sessionKey, stopped: false, flight: null, followUp: null, answer: null, reaskTimer: null, lastCallSite: null };
    this.sessions.set(agentId, state);
    return state;
  }

  private start(agentId: string, state: SessionState, targets: readonly InboxRowsTarget[], callSite: InboxRowsCallSite, reask = false): Flight {
    // A new ask takes over from a second ask that was still waiting.
    if (state.reaskTimer) clearTimeout(state.reaskTimer);
    state.reaskTimer = null;
    const flight: Flight = {
      asked: new Map(targets.map((target) => [target.channelId.toLowerCase(), target.newestSeq])),
      controller: new AbortController(),
      abortReason: null,
      done: Promise.resolve(),
    };
    state.flight = flight;
    state.lastCallSite = callSite;
    // `done` never rejects, and the flight is cleared whatever happened to the call: the next ask is never stuck behind it.
    flight.done = this.call(agentId, state, flight, targets, callSite, reask).catch(() => undefined).finally(() => {
      if (state.flight === flight) state.flight = null;
    }).then(() => {
      const followUp = state.followUp;
      if (!followUp) {
        this.scheduleReask(agentId, state, flight, targets, callSite, reask);
        return;
      }
      state.followUp = null;
      const current = this.sessions.get(agentId) === state && !state.stopped;
      const answered = state.answer?.rowed;
      const all = [...followUp.targets.values()];
      if (!current || (answered && all.every((target) => covers(answered, target)))) {
        followUp.settle();
        return;
      }
      // Everything that folded in, not only what is still uncovered: the new answer replaces the old one whole.
      const next = all.sort((a, b) => b.newestSeq - a.newestSeq).slice(0, AGENT_API_INBOX_ROWS_MAX_TARGETS);
      void this.start(agentId, state, next, followUp.callSite).done.then(followUp.settle);
    });
    return flight;
  }

  /**
   * After an answer that left a conversation without a row: ask the same
   * conversations once more, a moment later. Once only (a second ask never
   * schedules a third), and only while nothing newer was asked meanwhile. A
   * row can also be missing for good (nothing unread there, or nothing the
   * agent can see), so this is one try, not a loop.
   */
  private scheduleReask(agentId: string, state: SessionState, flight: Flight, targets: readonly InboxRowsTarget[], callSite: InboxRowsCallSite, wasReask: boolean): void {
    // Only for a message queued for a busy agent: its notice is written later. An idle delivery
    // or a hand-off writes at once, so a second answer would come after the notice it was for.
    if (wasReask || callSite !== "queued" || this.sessions.get(agentId) !== state || state.stopped) return;
    const answer = state.answer;
    if (!answer || answer.asked !== flight.asked || answer.rowed.size === answer.asked.size) return;
    const timer = setTimeout(() => {
      if (state.reaskTimer !== timer) return;
      state.reaskTimer = null;
      if (this.sessions.get(agentId) !== state || state.stopped || state.flight) return;
      void this.start(agentId, state, targets, callSite, true);
    }, this.reaskDelayMs);
    // Never keeps the process alive.
    timer.unref?.();
    state.reaskTimer = timer;
  }

  private async call(agentId: string, state: SessionState, flight: Flight, targets: readonly InboxRowsTarget[], callSite: InboxRowsCallSite, reask: boolean): Promise<void> {
    const startedAt = Date.now();
    const trace = createTraceContext();
    const traceparent = formatTraceparent(trace);
    const { signal } = flight.controller;
    // The hard limit of one ask. A timer of our own, not AbortSignal.timeout:
    // the same controller also aborts on a stop, and the two are told apart.
    const timer = setTimeout(() => {
      flight.abortReason ??= "timeout";
      flight.controller.abort();
    }, this.timeoutMs);
    // Settles at the abort even when the request underneath does not.
    const aborted = new Promise<CallOutcome>((resolve) => {
      signal.addEventListener("abort", () => resolve({ ok: false, reason: flight.abortReason ?? "aborted" }), { once: true });
    });
    let outcome: CallOutcome;
    try {
      outcome = signal.aborted
        ? { ok: false, reason: flight.abortReason ?? "aborted" }
        : await Promise.race([this.request(agentId, flight, targets, traceparent), aborted]);
    } finally {
      clearTimeout(timer);
    }
    const current = this.sessions.get(agentId) === state;
    if (outcome.ok && current) {
      // Only a conversation that came back with a row counts as asked. One left out may be one
      // the Server's view has not seen yet, so a later ask must be able to name it again.
      // (An answer that is added to settles every conversation it named: no row there means nothing unread the view knows of.)
      const withRow = new Set(outcome.response.rows.map((row) => row.channelId.toLowerCase()));
      const rowed: Asked = outcome.response.withBehind === true
        ? flight.asked
        : new Map([...flight.asked].filter(([key]) => withRow.has(key)));
      state.answer = { asked: flight.asked, rowed, response: outcome.response, callSite };
    }
    if (!outcome.ok && current && (outcome.reason === "http_403" || outcome.reason === "http_404")) state.stopped = true;
    const rows = outcome.ok ? outcome.response.rows.length : 0;
    // Counts only: no conversation id or name is recorded.
    this.record(INBOX_ROWS_CALL_EVENT, {
      agentId,
      host: this.options.host,
      call_site: callSite,
      outcome: outcome.ok ? "ok" : "fallback",
      ...(outcome.ok ? {} : { failure_reason: outcome.reason }),
      ...(!outcome.ok && outcome.httpStatus !== undefined ? { http_status: outcome.httpStatus } : {}),
      duration_ms: Date.now() - startedAt,
      timeout_ms: this.timeoutMs,
      targets: targets.length,
      rows,
      ...(outcome.ok && rows < targets.length ? { partial: true } : {}),
      // The Server's own count of named conversations its view is behind on; tells "view behind" from "nothing unread".
      ...(outcome.ok ? { behind: outcome.response.behind } : {}),
      // Whether the Server answered the rows that are behind too (the notice then adds what the Computer holds).
      ...(outcome.ok ? { with_behind_mode: outcome.response.withBehind === true ? "on" : "off" } : {}),
      ...(reask ? { reask: true } : {}),
      trace_id: trace.traceId,
    }, outcome.ok ? "ok" : "error", traceparent);
  }

  private async request(agentId: string, flight: Flight, targets: readonly InboxRowsTarget[], traceparent: string): Promise<CallOutcome> {
    const { signal } = flight.controller;
    const interrupted = (): CallOutcome => ({ ok: false, reason: flight.abortReason ?? "aborted" });
    let res: Response | null;
    try {
      res = await this.options.fetchAsAgent(agentId, route.fullPath, { method: "POST", body: { targets, withBehind: true }, signal, traceparent });
    } catch {
      return signal.aborted ? interrupted() : { ok: false, reason: "network" };
    }
    if (!res) return { ok: false, reason: "no_credential" };
    if (!res.ok) {
      await res.arrayBuffer().catch(() => undefined);
      return { ok: false, reason: httpFailureReason(res.status), httpStatus: res.status };
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      return signal.aborted ? interrupted() : { ok: false, reason: "contract" };
    }
    const parsed = route.response.body.safeParse(json);
    return parsed.success ? { ok: true, response: parsed.data } : { ok: false, reason: "contract" };
  }
}
