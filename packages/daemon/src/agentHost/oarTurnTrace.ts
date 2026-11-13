// The `daemon.runtime.turn` span of an OAR-hosted agent's turns (RFC 060).
//
// The legacy host opens one per turn (agentProcessManager.ts
// `startRuntimeTrace` / `endRuntimeTrace`) and the observability report reads
// turns, outcomes, tool calls, Raft sends and tokens from it. This is the same
// span for a turn the OAR host runs: the same name, counters
// (runtimeCommunicationTrace.ts), event cap (`addTurnSpanEvent`), outcome
// values and message attributes (runtimeTurnTrace.ts). The host decides when
// a turn starts and how it ended; this keeps the span and what the turn did.
// One per launch (`HostedAgent`): a restart's new launch has its own, and the
// old one's open span is ended when that launch is released.

import type { Event } from "@botiverse/oar";
import type { ActiveSpan, TraceContext, TraceStatus, Tracer } from "@botiverse/raft-shared";
import { getActiveTraceContext } from "@botiverse/raft-trace-client";
import type { ParsedEvent } from "../drivers/index";
import {
  addTurnSpanEvent,
  createRuntimeTraceCounters,
  noteRaftMessageSendAttempt,
  noteRaftMessageSendOutcome,
  noteRuntimeTraceCounter,
  runtimeTraceCounterAttrs,
  type RuntimeTraceCounters,
  type TurnSpanEventLimits,
} from "../runtimeCommunicationTrace";
import { buildRuntimeErrorDiagnosticEnvelope } from "../runtimeErrorDiagnostics";
import { noteTurnSessionTokenTotals, noteTurnTokenUsage, type TurnTokenCounts } from "../runtimeTurnTokens";
import type { RuntimeTurnTraceOutcome } from "../runtimeTurnTrace";
import type { OarActivityFact } from "./oarActivity";

/** Why a turn span opens (the legacy host's `reason`), and its start attributes. */
export interface OarTurnStart {
  reason: string;
  /** The messages or trigger of the turn (`messagesTraceAttrs`, the trigger attrs). */
  attrs: Record<string, unknown>;
}

/** One `ParsedEvent` an OAR event's activity stands for, as the legacy driver would have reported it. */
export interface OarTraceCounterKind {
  kind: ParsedEvent["kind"];
  /** A tool call's name as Raft displays it (`send_message` is a Raft send attempt). */
  toolName?: string;
}

/** The legacy host opens a span on these when no turn is open: the runtime started a turn itself. */
const MODEL_WORK_KINDS: ReadonlySet<ParsedEvent["kind"]> = new Set(["thinking", "text", "tool_call", "tool_output"]);

/**
 * The `ParsedEvent` kinds one root OAR event's activity facts stand for
 * (oarActivity.ts maps the event into the legacy driver's activity shapes):
 * a tool start each (a codex file change is one per file, as the driver
 * reports it), a tool end, visible text, readable reasoning, a compaction's
 * start and finish. Facts with no counterpart (a retry, a failed compaction)
 * count for nothing.
 */
export function oarTraceCounterKinds(facts: readonly OarActivityFact[]): OarTraceCounterKind[] {
  const kinds: OarTraceCounterKind[] = [];
  for (const fact of facts) {
    const entry = fact.entries[0];
    if (entry?.kind === "tool_start") kinds.push({ kind: "tool_call", toolName: entry.toolName });
    else if (fact.detailKind === "tool_end") kinds.push({ kind: "tool_output" });
    else if (fact.detailKind === "model_response_started") kinds.push({ kind: "text" });
    else if (fact.detailKind === "thinking_started") kinds.push({ kind: "thinking" });
    else if (fact.detailKind === "compacting_context") kinds.push({ kind: "compaction_started" });
    else if (fact.detailKind === "compaction_finished") kinds.push({ kind: "compaction_finished" });
  }
  return kinds;
}

export function isOarModelWork(kinds: readonly OarTraceCounterKind[]): boolean {
  return kinds.some((each) => MODEL_WORK_KINDS.has(each.kind));
}

type OarTokenTotals = NonNullable<Extract<Event, { kind: "usage" }>["usage"]["tokens"]>;

/** OAR's totals in the accumulator's split: OAR's `input` includes the cached parts, Raft's is uncached input only. */
function tokenCounts(tokens: OarTokenTotals): TurnTokenCounts {
  const cached = (tokens.cacheRead ?? 0) + (tokens.cacheWrite ?? 0);
  return {
    input: Math.max(0, tokens.input - cached),
    output: tokens.output,
    ...(tokens.cacheRead !== undefined ? { cacheRead: tokens.cacheRead } : {}),
    ...(tokens.cacheWrite !== undefined ? { cacheWrite: tokens.cacheWrite } : {}),
  };
}

/**
 * How long a turn cut short (an abort no one asked for, a `runtime_exited`
 * failure) waits for the process exit whose outcome it takes. The exit of a
 * runtime that ended follows its turn end within milliseconds; a turn whose
 * exit does not come by then was interrupted, and its span must not run on
 * through the idle time after it (a false long turn).
 */
export const OAR_TURN_EXIT_WAIT_MS = 5_000;

/**
 * A runtime's refusal on a trace: its class, fingerprint and HTTP status,
 * never its text. Nothing when there is no reason to classify.
 */
export function refusalTraceAttrs(reason: string | null | undefined): Record<string, unknown> {
  if (!reason) return {};
  const { runtime_error_class, runtime_error_fingerprint, runtime_error_http_status } = buildRuntimeErrorDiagnosticEnvelope(reason).spanAttrs;
  return { refusal_class: runtime_error_class, refusal_fingerprint: runtime_error_fingerprint, refusal_http_status: runtime_error_http_status };
}

export class OarTurnTrace {
  /** What the open turn did; `runtimeTraceCounterAttrs` reads it. */
  runtimeTraceCounters: RuntimeTraceCounters = createRuntimeTraceCounters();
  private span: ActiveSpan | null = null;
  /** The last turn's span once it ended, until the next opens: records of that turn's end join its trace. */
  private endedContext: TraceContext | null = null;
  /** The turn ended cut short (an abort no one asked for, a `runtime_exited` failure): the span waits for the exit's outcome. */
  private awaitingExit = false;
  /** Ends that wait after OAR_TURN_EXIT_WAIT_MS. */
  private exitWait: ReturnType<typeof setTimeout> | null = null;
  /** The prompt (`turn_started` request) that opened the span: a rejection of it means no turn ran. */
  private requestId: string | null = null;
  /** The session's root token totals so far; OAR counts them from the session's open. */
  private sessionTokens: TurnTokenCounts = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  /**
   * The turn ended (`endAtTurnEnd`) and the span ends once the rest of the
   * record that ended it is read: a runtime reports the turn's usage in the
   * same record, after the turn end (`seq`).
   */
  private pendingEnd: { status: TraceStatus; attrs: { outcome: RuntimeTurnTraceOutcome } & Record<string, unknown>; seq: number } | null = null;

  constructor(private readonly options: {
    /** Codex: tokens come from its `token_usage` telemetry, as on the legacy driver (`noteTelemetry`), not from OAR's usage. */
    tokensFromTelemetry: boolean;
    /** The span's event cap; the legacy host's by default (tests shrink it). */
    limits?: TurnSpanEventLimits;
    /** OAR_TURN_EXIT_WAIT_MS by default (tests change it). */
    exitWaitMs?: number;
  }) {}

  /**
   * The trace of the open turn, or of the last turn once it ended (the
   * records of its failure come after its end): their records join it, as
   * the legacy host's fence records do. Null before any turn.
   */
  get traceContext(): TraceContext | null {
    return this.span?.context ?? this.endedContext;
  }

  /** A turn's span is open and its turn has not ended. */
  get open(): boolean {
    return this.span !== null && this.pendingEnd === null;
  }

  /** A turn runs on the open span: its turn neither ended nor waits for the exit that cut it. */
  get turnRunning(): boolean {
    return this.open && !this.awaitingExit;
  }

  /**
   * Opens the turn's span. One already open stays the turn's (as the legacy
   * host's `startRuntimeTrace`), unless its turn already ended and it only
   * waited for an exit that did not come: that turn was interrupted (a new
   * turn, prompted or the runtime's own, shows the runtime is still there).
   */
  start(tracer: Tracer | undefined, spanAttrs: Record<string, unknown>, start: OarTurnStart, requestId: string | null): void {
    this.flushEnd();
    if (this.span && this.awaitingExit) this.endInterrupted("next_turn");
    if (this.span || !tracer) return;
    this.runtimeTraceCounters = createRuntimeTraceCounters();
    this.requestId = requestId;
    this.endedContext = null;
    this.span = tracer.startSpan("daemon.runtime.turn", {
      parent: getActiveTraceContext(),
      surface: "daemon",
      kind: "internal",
      attrs: { ...spanAttrs, reason: start.reason, ...start.attrs },
    });
    this.event("daemon.turn.started", { reason: start.reason, ...start.attrs });
  }

  /** Adds an event to the open span, within its cap. */
  event(name: string, attrs: Record<string, unknown>): void {
    if (this.span) addTurnSpanEvent(this.span, this.runtimeTraceCounters, name, attrs, this.options.limits);
  }

  /** One root event of the session, counted as the `ParsedEvent`s it stands for (or as an event only), and added to the span. */
  note(event: Event, kinds: readonly OarTraceCounterKind[]): void {
    if (this.pendingEnd && event.seq !== this.pendingEnd.seq) this.flushEnd();
    if (!this.span) return;
    const counters = this.runtimeTraceCounters;
    if (kinds.length === 0) noteRuntimeTraceCounter(counters, event);
    for (const each of kinds) {
      noteRuntimeTraceCounter(counters, each);
      if (each.toolName) noteRaftMessageSendAttempt(counters, each.toolName);
    }
    this.event("runtime.event.received", { kind: event.kind });
  }

  /** OAR's `usage`: the session's root running totals. Folded into the open turn unless the runtime's telemetry counts its tokens. */
  noteUsage(tokens: OarTokenTotals | undefined): void {
    if (!tokens) return;
    const before = this.sessionTokens;
    this.sessionTokens = tokenCounts(tokens);
    if (this.span && !this.options.tokensFromTelemetry) noteTurnSessionTokenTotals(this.runtimeTraceCounters.tokens, before, this.sessionTokens);
  }

  /** A runtime telemetry event (codex), as the legacy host adds it: an event of the span, counted, and its tokens. */
  noteTelemetry(event: Extract<ParsedEvent, { kind: "telemetry" }>, attrs: Record<string, unknown>): void {
    if (!this.span) return;
    this.event(`runtime.telemetry.${event.name}`, attrs);
    noteRuntimeTraceCounter(this.runtimeTraceCounters, event);
    if (this.options.tokensFromTelemetry) noteTurnTokenUsage(this.runtimeTraceCounters.tokens, event);
  }

  /** What the Server said about a message send through the agent's proxy. */
  noteSendOutcome(state: "sent" | "held"): void {
    if (this.span) noteRaftMessageSendOutcome(this.runtimeTraceCounters, state);
  }

  /** The turn ended cut short by the process's end: the exit ends the span (`end`), else the release does. */
  awaitExit(): void {
    if (!this.open || this.awaitingExit) return;
    this.awaitingExit = true;
    this.exitWait = setTimeout(() => {
      this.exitWait = null;
      if (this.awaitingExit) this.endInterrupted("exit_wait_elapsed");
    }, this.options.exitWaitMs ?? OAR_TURN_EXIT_WAIT_MS);
    this.exitWait.unref?.();
  }

  /** A cut turn whose exit did not come: interrupted, with what ended the wait. */
  private endInterrupted(endedBy: "next_turn" | "exit_wait_elapsed"): void {
    this.end("cancelled", { outcome: "turn-interrupted", exit_wait_ended_by: endedBy });
  }

  /**
   * The prompt that opened the span was rejected: no turn ran. The runtime's
   * reason is recorded as its class, fingerprint and HTTP status, never its text.
   */
  promptRejected(requestId: string, code: string, reason?: string): void {
    if (!this.open || this.requestId !== requestId) return;
    this.end("error", { outcome: "runtime-start-failed", turn_reason: "prompt_rejected", rejection_code: code, ...refusalTraceAttrs(reason) });
  }

  /**
   * The turn ended (OAR's `turn_ended`, record `seq`): the span ends with
   * `attrs` once the rest of that record is read (its usage), at the next
   * record, the next turn's start, or the next tick, whichever comes first.
   */
  endAtTurnEnd(status: TraceStatus, attrs: { outcome: RuntimeTurnTraceOutcome } & Record<string, unknown>, seq: number): void {
    if (!this.span || this.pendingEnd) return;
    this.pendingEnd = { status, attrs, seq };
    setImmediate(() => this.flushEnd());
  }

  /** A turn end waiting for the rest of its record ends now (a launch being released can't wait for the next tick). */
  flushPendingEnd(): void {
    this.flushEnd();
  }

  private flushEnd(): void {
    const pending = this.pendingEnd;
    if (!pending) return;
    this.pendingEnd = null;
    this.end(pending.status, pending.attrs);
  }

  /** Ends the open span once, with its outcome and the turn's counters; a turn that already ended keeps its own outcome. */
  end(status: TraceStatus, attrs: { outcome: RuntimeTurnTraceOutcome } & Record<string, unknown>): void {
    if (this.pendingEnd) {
      this.flushEnd();
      return;
    }
    const span = this.span;
    if (!span) return;
    this.span = null;
    this.endedContext = span.context;
    this.awaitingExit = false;
    if (this.exitWait) clearTimeout(this.exitWait);
    this.exitWait = null;
    this.requestId = null;
    span.end(status, { attrs: { ...attrs, ...runtimeTraceCounterAttrs(this) } });
  }
}
