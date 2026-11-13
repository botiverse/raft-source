// View Context relay (agentContextView.ts in shared is the wire contract).
//
// Viewer side (`openView`, GET /api/agents/:id/messages/:messageId/context):
// records the attempt (a required audit row; on failure nothing below
// happens), stores a request record (Redis, any replica can read it), registers a local
// waiter for the viewer's HTTP response, and sends `agent:context_view_request`
// to the agent's Computer over the machine routing that works from any replica.
// The viewer waits at most AGENT_CONTEXT_VIEW_VIEWER_WAIT_MS for the answer to start;
// the whole request (the viewer's response, the daemon's upload and the hop
// between replicas) ends at its deadline, AGENT_CONTEXT_VIEW_REQUEST_TTL_MS
// after it was created, however slowly the body arrives.
//
// Result side (`receiveResult`, POST /internal/computer/agent-context/:requestId):
// the daemon's one POST may land on any replica. It is claimed (first POST
// wins), re-checked (agent, the viewer's access now), decoded (identity or
// gzip) and counted against the cap, then handed to the waiter: directly when
// the waiter is on this replica, else streamed to the viewer's replica
// (`receiveForward`, POST /internal/replica/agent-context/:requestId), signed
// with the replica replay scheme.
//
// Nothing here buffers a whole body. A body that ends within
// AGENT_CONTEXT_VIEW_PARSED_BODY_BYTES (every daemon failure body, small
// results) is parsed whole with parseAgentContextViewResultBody. A longer one
// is streamed through: the Server checks only the encoding, the decompressed
// size against the cap and that it starts with `{`; the web parses it
// (parseAgentContextView). Past the cap after bytes reached the viewer, the
// viewer's response is destroyed (never a valid-looking partial JSON).
//
// Nothing is stored, cached or logged except metadata (outcome, bytes,
// duration, runtime).
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { PassThrough, Readable, Transform, pipeline as pipelineCallback, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import type { Request, Response } from "express";
import {
  AGENT_CONTEXT_VIEW_MAX_BYTES,
  AGENT_CONTEXT_VIEW_REQUEST_TTL_MS,
  AGENT_CONTEXT_VIEW_VIEWER_WAIT_MS,
  AGENT_CONTEXT_VIEW_REQUEST_TYPE,
  AGENT_CONTEXT_VIEW_UNCOMPRESSED_BYTES_HEADER,
  AGENT_CONTEXT_SEARCH_REQUEST_TYPE,
  DAEMON_CAPABILITY_AGENT_CONTEXT_SEARCH_V0,
  parseAgentContextQueryAnswerBody,
  type AgentContextQuery,
  type AgentContextQueryAnswerBody,
  type AgentContextSearchRequestMessage,
  type AgentContextViewQueryRecord,
  DAEMON_CAPABILITY_AGENT_CONTEXT_VIEW_V0,
  agentContextViewRuntimeCapabilities,
  asAgentContextViewRequestId,
  clearClockTimeout,
  currentTimeMs,
  isAgentContextViewFailureReason,
  isAgentContextViewResultContentEncoding,
  isAgentContextViewTooLargeCause,
  mintAgentContextViewRequestId,
  parseAgentContextViewResultBody,
  setClockTimeout,
  type AgentContextViewFailureReason,
  type AgentContextViewGrantId,
  type AgentContextViewOutcome,
  type AgentContextViewRequestId,
  type AgentContextViewRequestMessage,
  type AgentContextViewStatusDetails,
  type AgentContextViewTooLargeCause,
  type MachineId,
} from "@botiverse/raft-shared";
import { signReplicaRequestHeaders, verifyReplicaRequestSignature } from "../machineLocalReplay";
import { recordTraceEvent } from "../tracing/semanticTrace";
import type { AgentContextViewRequestRecord, AgentContextViewRequestStore } from "./replicaStateStore";

/** A result body that ends within this many bytes (decompressed) is parsed whole; a longer one is streamed. */
export const AGENT_CONTEXT_VIEW_PARSED_BODY_BYTES = 64 * 1024;

/** The internal hop from the replica that received the result to the viewer's replica. */
export const AGENT_CONTEXT_VIEW_FORWARD_ROUTE = "/internal/replica/agent-context/:requestId";

/** Idle (and connect) timeout on the internal hop: no byte either way for this long ends it. */
export const AGENT_CONTEXT_VIEW_FORWARD_IDLE_TIMEOUT_MS = 15_000;

export function agentContextViewForwardPath(requestId: AgentContextViewRequestId): string {
  return `/internal/replica/agent-context/${encodeURIComponent(requestId)}`;
}

/** On the internal hop: the request ended without a body (`refused`, or a failure reason). */
const FORWARD_ANSWER_HEADER = "x-raft-context-view-answer";
const FORWARD_TOO_LARGE_CAUSE_HEADER = "x-raft-context-view-too-large-cause";

/** The body of every refusal on the View Context routes: the unknown-agent 404. */
export const AGENT_CONTEXT_VIEW_NOT_FOUND = { error: "Agent not found" } as const;

/** What the viewer is answered. `body` is the result JSON (identity), its start already checked. */
type ViewerAnswer =
  | { kind: "failure"; reason: AgentContextViewFailureReason; tooLargeCause?: AgentContextViewTooLargeCause }
  | { kind: "refused" }
  | { kind: "body"; body: Readable };

/**
 * - `delivered`: the viewer got the whole answer.
 * - `viewer_gone`: no viewer waits any more (timed out, left, replica gone).
 * - `stream_failed`: the body failed while streaming (the viewer's response was destroyed or answered a failure).
 * - `rejected`: the viewer was already answered (a second answer for one request).
 */
type DeliverResult = "delivered" | "viewer_gone" | "stream_failed" | "rejected";

/** The attempt, recorded before anything is stored or sent. Never anything from the context. */
export type AgentContextViewAttemptEntry = {
  requestId: AgentContextViewRequestId;
  viewerUserId: string;
  /** An agent's search or read: `viewerUserId` is the agent's id. */
  viewerKind?: "agent";
  query?: AgentContextViewQueryRecord;
  /** The grant an agent used to view another agent's context (whose grant: its granter). */
  grant?: AgentContextViewGrantUse;
  agentId: string;
  serverId: string;
  messageId: string;
  machineId: string | null;
};

/** A View Context grant as one request used it (agentContextViewGrantService.ts). */
export type AgentContextViewGrantUse = { id: AgentContextViewGrantId; granterUserId: string };

export type AgentContextViewAuditEntry = {
  requestId: AgentContextViewRequestId;
  viewerUserId: string;
  viewerKind?: "agent";
  query?: AgentContextViewQueryRecord;
  grant?: AgentContextViewGrantUse;
  agentId: string;
  serverId: string;
  messageId: string;
  machineId: string | null;
  outcome: AgentContextViewOutcome;
  bytes: number | null;
  runtime: string;
  durationMs: number;
};

export type AgentContextViewRecheck = "ok" | "agent_moved" | "refused";

export interface AgentContextViewRelayDeps {
  store: AgentContextViewRequestStore;
  replicaId: string;
  /** This replica's replay endpoint, recorded so a result on another replica can reach the viewer. */
  replicaEndpoint(): string | null;
  /** The agent and the viewer's access as they are now, when the result arrives. */
  recheck(record: AgentContextViewRequestRecord): Promise<AgentContextViewRecheck>;
  /** The Computer and owner a failure answer names (the status route's rule). */
  describeComputer(machineId: string, serverId: string): Promise<Pick<AgentContextViewStatusDetails, "computer" | "computerOwner">>;
  /**
   * Required: records the attempt (and throws when it could not). The view
   * goes ahead only once this resolved, so every context read has a record
   * even when the outcome below is never written (a failed write, or this
   * replica stopping mid-view).
   */
  recordAttempt(entry: AgentContextViewAttemptEntry): Promise<void>;
  /** Best-effort: the attempt's outcome, linked to it by `requestId`. */
  audit(entry: AgentContextViewAuditEntry): Promise<void>;
  /** Cap on the decompressed body; AGENT_CONTEXT_VIEW_MAX_BYTES unless a test lowers it. */
  maxBytes?: number;
  /** Cap on an agent's search or read answer; AGENT_CONTEXT_QUERY_MAX_BYTES unless a test lowers it. */
  queryMaxBytes?: number;
  waitMs?: number;
  ttlMs?: number;
  /** The whole request ends this long after it was created; `ttlMs` unless a test sets it apart. */
  deadlineMs?: number;
  forwardIdleTimeoutMs?: number;
}

export interface AgentContextViewOrchestrator {
  getMachineStatus(machineId: MachineId): Promise<string>;
  machineAdvertisesCapability(machineId: MachineId, capability: string): Promise<boolean>;
  sendAgentContextViewRequest(machineId: MachineId, message: AgentContextViewRequestMessage | AgentContextSearchRequestMessage): Promise<boolean>;
}

class ResultTooLargeError extends Error {}
class ResultReadError extends Error {}
/** The request's deadline passed while its body was still arriving. */
class ResultExpiredError extends Error {}

/** Counts bytes through; fails with ResultTooLargeError once past `maxBytes`. */
function byteCounter(maxBytes: number, onBytes: (total: number) => void = () => {}): Transform {
  let total = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback: TransformCallback) {
      total += chunk.length;
      onBytes(total);
      if (total > maxBytes) {
        callback(new ResultTooLargeError(`context view body over ${maxBytes} bytes`));
        return;
      }
      callback(null, chunk);
    },
  });
}

/** Yields `first`, then the rest of `rest`; `onError` sees a failure of `rest` before it is rethrown. */
async function* prepend(first: Buffer, rest: AsyncIterator<Buffer>, onError: (error: unknown) => void = () => {}): AsyncGenerator<Buffer> {
  yield first;
  for (;;) {
    let next: IteratorResult<Buffer>;
    try {
      next = await rest.next();
    } catch (error) {
      onError(error);
      throw error;
    }
    if (next.done) return;
    yield next.value;
  }
}

function startsWithObject(head: Buffer): boolean {
  for (const byte of head) {
    if (byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d) continue;
    return byte === 0x7b; // "{"
  }
  return false;
}

/** One viewer's HTTP response, waiting for its answer; answered once. */
class ViewWaiter {
  private state: "waiting" | "answering" | "done" = "waiting";
  private timer: unknown;
  private deadlineTimer: unknown;
  private deadlineHit = false;
  private body: Readable | null = null;
  private bytes: number | null = null;
  private resolveSettled!: (outcome: AgentContextViewOutcome) => void;
  readonly settled = new Promise<AgentContextViewOutcome>((resolve) => {
    this.resolveSettled = resolve;
  });

  constructor(
    private readonly res: Response,
    private readonly maxBytes: number,
    waitMs: number,
    deadlineMs: number,
    private readonly describe: () => Promise<Pick<AgentContextViewStatusDetails, "computer" | "computerOwner">>,
    private readonly onDone: () => void,
  ) {
    this.timer = setClockTimeout(() => {
      if (this.state !== "waiting") return;
      void this.writeFailure("expired");
    }, waitMs);
    // The whole answer, however slowly it streams, ends at the request's deadline.
    this.deadlineTimer = setClockTimeout(() => {
      if (this.state === "done") return;
      this.deadlineHit = true;
      if (this.state === "waiting") {
        void this.writeFailure("expired");
        return;
      }
      this.body?.destroy(new ResultExpiredError("context view request past its deadline"));
      if (this.res.headersSent) this.res.destroy();
    }, deadlineMs);
    res.on("close", () => {
      // The viewer left before an answer (a stream in flight fails on its own).
      if (this.state === "waiting") this.finish("cancelled");
    });
  }

  get answeredBytes(): number | null {
    return this.bytes;
  }

  async accept(answer: ViewerAnswer): Promise<DeliverResult> {
    // Already answered: the caller owns the body it offered (and may still answer on its socket).
    if (this.state !== "waiting") return "rejected";
    if (answer.kind === "failure") return (await this.writeFailure(answer.reason, answer.tooLargeCause)) ? "delivered" : "viewer_gone";
    if (answer.kind === "refused") {
      this.state = "answering";
      this.res.status(404).json(AGENT_CONTEXT_VIEW_NOT_FOUND);
      this.finish("refused");
      return "delivered";
    }
    return this.writeBody(answer.body);
  }

  async writeFailure(reason: AgentContextViewFailureReason, tooLargeCause?: AgentContextViewTooLargeCause): Promise<boolean> {
    this.state = "answering";
    const details = await this.describe().catch(() => ({ computer: null, computerOwner: null }));
    if (this.res.destroyed || this.res.headersSent) {
      this.finish("cancelled");
      return false;
    }
    this.res.setHeader("Cache-Control", "no-store");
    this.res.status(200).json({ ok: false, reason, ...(tooLargeCause ? { tooLargeCause } : {}), ...details });
    this.finish(reason);
    return true;
  }

  private async writeBody(body: Readable): Promise<DeliverResult> {
    this.state = "answering";
    this.body = body;
    const chunks = body[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
    let first: IteratorResult<Buffer>;
    try {
      first = await chunks.next();
    } catch (error) {
      body.destroy();
      if (this.deadlineHit || error instanceof ResultExpiredError) {
        await this.writeFailure("expired");
        return this.deadlineHit ? "viewer_gone" : "stream_failed";
      }
      await (error instanceof ResultTooLargeError ? this.writeFailure("too_large", "request") : this.writeFailure("read_failed"));
      return "stream_failed";
    }
    if (first.done || this.res.destroyed) {
      body.destroy();
      if (first.done) await this.writeFailure("read_failed");
      else this.finish("cancelled");
      return first.done ? "stream_failed" : "viewer_gone";
    }
    this.res.status(200);
    this.res.setHeader("Content-Type", "application/json; charset=utf-8");
    this.res.setHeader("Cache-Control", "no-store");
    let total = 0;
    let sourceError: unknown = null;
    try {
      await pipeline(
        Readable.from(prepend(first.value, chunks, (error) => {
          sourceError = error;
        }), { objectMode: false }),
        byteCounter(this.maxBytes, (bytes) => {
          total = bytes;
        }),
        this.res,
      );
      this.bytes = total;
      this.finish("ok");
      return "delivered";
    } catch (error) {
      body.destroy();
      // Bytes already went out: never leave a valid-looking partial JSON.
      this.res.destroy();
      // The viewer's own deadline: the producer is told the viewer is gone (410).
      if (this.deadlineHit) {
        this.finish("expired");
        return "viewer_gone";
      }
      const tooLarge = error instanceof ResultTooLargeError || sourceError instanceof ResultTooLargeError;
      if (sourceError instanceof ResultExpiredError) {
        this.finish("expired");
        return "stream_failed";
      }
      if (!tooLarge && !sourceError) {
        this.finish("cancelled");
        return "viewer_gone";
      }
      // On the viewer's replica, a body forwarded from another replica is the
      // hop's request: any failure the producing replica met mid-forward
      // (over the cap, its deadline, the daemon's upload cut) reaches here
      // only as an aborted hop, so it is answered and audited `read_failed`
      // here even when the producing replica answered the daemon `too_large`
      // or `expired`. No trailer carries the cause across; the viewer's
      // response is cut either way.
      this.finish(tooLarge ? "too_large" : "read_failed");
      return "stream_failed";
    }
  }

  private finish(outcome: AgentContextViewOutcome): void {
    if (this.state === "done") return;
    this.state = "done";
    clearClockTimeout(this.timer);
    clearClockTimeout(this.deadlineTimer);
    this.onDone();
    this.resolveSettled(outcome);
  }
}

/** An agent's search or read answer: entries, never a view (#wg-ax:#15). Read whole, then checked. */
export const AGENT_CONTEXT_QUERY_MAX_BYTES = 512 * 1024;

/** What an agent's search or read ends in. */
export type AgentContextQueryResult =
  | { kind: "answer"; body: AgentContextQueryAnswerBody }
  | { kind: "failure"; reason: AgentContextViewFailureReason; tooLargeCause?: AgentContextViewTooLargeCause } & Pick<AgentContextViewStatusDetails, "computer" | "computerOwner">
  | { kind: "refused" };

/**
 * The waiter for an agent's search or read. Unlike a person's view, nothing
 * is streamed: the answer is read whole (it is small), and only a body that
 * parses as an answer is handed on. A whole view, or anything else, is
 * `read_failed`, so an agent never gets a context whatever a daemon sends.
 */
class QueryWaiter {
  private state: "waiting" | "answering" | "done" = "waiting";
  private timer: unknown;
  private deadlineTimer: unknown;
  private bytes: number | null = null;
  private resolveResult!: (result: AgentContextQueryResult) => void;
  readonly result = new Promise<AgentContextQueryResult>((resolve) => {
    this.resolveResult = resolve;
  });
  private resolveSettled!: (outcome: AgentContextViewOutcome) => void;
  readonly settled = new Promise<AgentContextViewOutcome>((resolve) => {
    this.resolveSettled = resolve;
  });
  /** An answer's match count, for the audit row. */
  matches: number | null = null;

  constructor(
    private readonly maxBytes: number,
    waitMs: number,
    deadlineMs: number,
    private readonly describe: () => Promise<Pick<AgentContextViewStatusDetails, "computer" | "computerOwner">>,
    private readonly onDone: () => void,
  ) {
    this.timer = setClockTimeout(() => {
      if (this.state === "waiting") void this.fail("expired");
    }, waitMs);
    this.deadlineTimer = setClockTimeout(() => {
      if (this.state !== "done") void this.fail("expired");
    }, deadlineMs);
  }

  get answeredBytes(): number | null {
    return this.bytes;
  }

  async accept(answer: ViewerAnswer): Promise<DeliverResult> {
    if (this.state !== "waiting") {
      if (answer.kind === "body") answer.body.destroy();
      return "rejected";
    }
    if (answer.kind === "failure") {
      await this.fail(answer.reason, answer.tooLargeCause);
      return "delivered";
    }
    if (answer.kind === "refused") {
      this.finish("refused", { kind: "refused" });
      return "delivered";
    }
    this.state = "answering";
    let raw: Buffer;
    try {
      const chunks: Buffer[] = [];
      await pipeline(answer.body, byteCounter(this.maxBytes), async function* (source: AsyncIterable<Buffer>) {
        for await (const chunk of source) chunks.push(chunk);
      });
      raw = Buffer.concat(chunks);
    } catch (error) {
      answer.body.destroy();
      if (error instanceof ResultTooLargeError) await this.fail("too_large", "request");
      else await this.fail(error instanceof ResultExpiredError ? "expired" : "read_failed");
      return "stream_failed";
    }
    let json: unknown;
    try {
      json = JSON.parse(raw.toString("utf8"));
    } catch {
      await this.fail("read_failed");
      return "stream_failed";
    }
    if (typeof json === "object" && json !== null && (json as { ok?: unknown }).ok === false) {
      const failed = parseAgentContextViewResultBody(json);
      if (failed.ok && !failed.body.ok) {
        await this.fail(failed.body.reason, failed.body.tooLargeCause);
        return "delivered";
      }
      await this.fail("read_failed");
      return "stream_failed";
    }
    const body = parseAgentContextQueryAnswerBody(json);
    if (!body) {
      // Not an answer (a whole view among them): never handed on.
      recordTraceEvent("server.agent_context_view.query_answer_rejected", { bytes: raw.length });
      await this.fail("read_failed");
      return "stream_failed";
    }
    this.bytes = raw.length;
    this.matches = body.answer.kind === "search" ? body.answer.total : null;
    this.finish("ok", { kind: "answer", body });
    return "delivered";
  }

  private async fail(reason: AgentContextViewFailureReason, tooLargeCause?: AgentContextViewTooLargeCause): Promise<void> {
    if (this.state === "done") return;
    this.state = "answering";
    const details = await this.describe().catch(() => ({ computer: null, computerOwner: null }));
    this.finish(reason, { kind: "failure", reason, ...(tooLargeCause ? { tooLargeCause } : {}), ...details });
  }

  private finish(outcome: AgentContextViewOutcome, result: AgentContextQueryResult): void {
    if (this.state === "done") return;
    this.state = "done";
    clearClockTimeout(this.timer);
    clearClockTimeout(this.deadlineTimer);
    this.onDone();
    this.resolveResult(result);
    this.resolveSettled(outcome);
  }
}

/** The status answered to the daemon's POST; every one is final (the daemon never retries). */
type DaemonAnswer = { status: number; code: string };

const DAEMON_DELIVERED: DaemonAnswer = { status: 200, code: "delivered" };
const DAEMON_EXPIRED: DaemonAnswer = { status: 410, code: "expired" };

export class AgentContextViewRelay {
  private readonly waiters = new Map<string, ViewWaiter | QueryWaiter>();
  private readonly queryMaxBytes: number;
  private readonly maxBytes: number;
  private readonly waitMs: number;
  private readonly ttlMs: number;
  private readonly deadlineMs: number;
  private readonly forwardIdleTimeoutMs: number;

  constructor(private readonly deps: AgentContextViewRelayDeps) {
    this.maxBytes = deps.maxBytes ?? AGENT_CONTEXT_VIEW_MAX_BYTES;
    this.queryMaxBytes = deps.queryMaxBytes ?? AGENT_CONTEXT_QUERY_MAX_BYTES;
    this.waitMs = deps.waitMs ?? AGENT_CONTEXT_VIEW_VIEWER_WAIT_MS;
    this.ttlMs = deps.ttlMs ?? AGENT_CONTEXT_VIEW_REQUEST_TTL_MS;
    this.deadlineMs = deps.deadlineMs ?? this.ttlMs;
    this.forwardIdleTimeoutMs = deps.forwardIdleTimeoutMs ?? AGENT_CONTEXT_VIEW_FORWARD_IDLE_TIMEOUT_MS;
  }

  /**
   * Answer the viewer's request (permission already checked): record the
   * attempt first (required: if that fails the viewer gets read_failed and
   * nothing is stored or sent), then offline / old_daemon at once, else send
   * the request and wait for the result. The outcome is audited best-effort.
   */
  async openView(input: {
    res: Response;
    viewerUserId: string;
    agent: { id: string; serverId: string; runtime: string; machineId: MachineId | null };
    messageId: string;
    orchestrator: AgentContextViewOrchestrator;
  }): Promise<void> {
    const { res, viewerUserId, agent, messageId, orchestrator } = input;
    const startedAt = currentTimeMs();
    const machineId = agent.machineId;
    const describe = () => machineId
      ? this.deps.describeComputer(machineId, agent.serverId)
      : Promise.resolve({ computer: null, computerOwner: null });
    const requestId = mintAgentContextViewRequestId();
    const settle = async (outcome: AgentContextViewOutcome, bytes: number | null, attemptRecorded: boolean) => {
      const durationMs = currentTimeMs() - startedAt;
      recordTraceEvent("server.agent_context_view.answered", {
        outcome,
        bytes: bytes ?? undefined,
        duration_ms: durationMs,
        runtime: agent.runtime,
      });
      // No attempt row means nothing was read: no outcome row either (the
      // viewers list is built from attempts, so it would never show).
      if (!attemptRecorded) return;
      await this.deps.audit({ requestId, viewerUserId, agentId: agent.id, serverId: agent.serverId, messageId, machineId, outcome, bytes, runtime: agent.runtime, durationMs });
    };

    const waiter = new ViewWaiter(res, this.maxBytes, this.waitMs, this.deadlineMs, describe, () => {
      if (this.waiters.get(requestId) === waiter) this.waiters.delete(requestId);
    });
    try {
      await this.deps.recordAttempt({ requestId, viewerUserId, agentId: agent.id, serverId: agent.serverId, messageId, machineId });
    } catch (error) {
      // Not recorded, not read: the viewer gets read_failed and nothing is
      // stored or sent to the Computer.
      console.error("[agent-context-view] attempt record failed", error instanceof Error ? error.message : String(error));
      recordTraceEvent("server.agent_context_view.attempt_record_failed", { runtime: agent.runtime });
      await waiter.accept({ kind: "failure", reason: "read_failed" });
      await settle(await waiter.settled, null, false);
      return;
    }
    try {
      await this.dispatch(requestId, waiter, { viewerUserId, agent, messageId, orchestrator, startedAt, query: null });
    } catch (error) {
      // Any failure on our side after the access check still ends the attempt
      // once: the viewer is answered read_failed (unless already answered)
      // and the attempt is audited like every other.
      console.error("[agent-context-view] view request failed", error instanceof Error ? error.message : String(error));
      await waiter.accept({ kind: "failure", reason: "read_failed" });
    }
    const outcome = await waiter.settled;
    await settle(outcome, outcome === "ok" ? waiter.answeredBytes : null, true);
  }

  /**
   * An agent's search or read of one message's context (#wg-ax:#15),
   * permission already checked: as `openView`, but the agent gets a parsed
   * answer of entries, never the view, and the attempt names the agent and
   * what it asked. Viewing another agent's context, `grant` is the grant the
   * permission check found: the attempt and outcome rows name it, and the
   * request record carries its id so the result-arrival recheck checks that
   * same grant again.
   */
  async openQuery(input: {
    viewerAgentId: string;
    agent: { id: string; serverId: string; runtime: string; machineId: MachineId | null };
    messageId: string;
    query: AgentContextQuery;
    grant?: AgentContextViewGrantUse | null;
    orchestrator: AgentContextViewOrchestrator;
  }): Promise<AgentContextQueryResult> {
    const { viewerAgentId, agent, messageId, query, orchestrator } = input;
    const grant = input.grant ?? undefined;
    const startedAt = currentTimeMs();
    const machineId = agent.machineId;
    const describe = () => machineId
      ? this.deps.describeComputer(machineId, agent.serverId)
      : Promise.resolve({ computer: null, computerOwner: null });
    const requestId = mintAgentContextViewRequestId();
    const asked: AgentContextViewQueryRecord = query.kind === "search"
      ? { mode: "search", query: query.query, matches: null }
      : { mode: "read", around: query.around };
    const waiter = new QueryWaiter(this.queryMaxBytes, this.waitMs, this.deadlineMs, describe, () => {
      if (this.waiters.get(requestId) === waiter) this.waiters.delete(requestId);
    });
    const settle = async (outcome: AgentContextViewOutcome, attemptRecorded: boolean) => {
      recordTraceEvent("server.agent_context_view.answered", {
        outcome,
        mode: query.kind,
        bytes: waiter.answeredBytes ?? undefined,
        duration_ms: currentTimeMs() - startedAt,
        runtime: agent.runtime,
      });
      if (!attemptRecorded) return;
      const recorded = asked.mode === "search" ? { ...asked, matches: waiter.matches } : asked;
      await this.deps.audit({
        requestId, viewerUserId: viewerAgentId, viewerKind: "agent", query: recorded, ...(grant ? { grant } : {}), agentId: agent.id, serverId: agent.serverId,
        messageId, machineId, outcome, bytes: waiter.answeredBytes, runtime: agent.runtime, durationMs: currentTimeMs() - startedAt,
      }).catch(() => undefined);
    };
    try {
      await this.deps.recordAttempt({
        requestId, viewerUserId: viewerAgentId, viewerKind: "agent", query: asked, ...(grant ? { grant } : {}), agentId: agent.id, serverId: agent.serverId, messageId, machineId,
      });
    } catch (error) {
      console.error("[agent-context-view] query attempt record failed", error instanceof Error ? error.message : String(error));
      recordTraceEvent("server.agent_context_view.attempt_record_failed", { runtime: agent.runtime, mode: query.kind });
      await waiter.accept({ kind: "failure", reason: "read_failed" });
      await settle(await waiter.settled, false);
      return waiter.result;
    }
    try {
      await this.dispatch(requestId, waiter, { viewerUserId: viewerAgentId, agent, messageId, orchestrator, startedAt, query, grantId: grant?.id ?? null });
    } catch (error) {
      console.error("[agent-context-view] query request failed", error instanceof Error ? error.message : String(error));
      await waiter.accept({ kind: "failure", reason: "read_failed" });
    }
    await settle(await waiter.settled, true);
    return waiter.result;
  }

  /** offline / old_daemon at once, else record the request and send it; the waiter gets the answer. */
  private async dispatch(
    requestId: AgentContextViewRequestId,
    waiter: ViewWaiter | QueryWaiter,
    input: {
      viewerUserId: string;
      agent: { id: string; serverId: string; runtime: string | null; machineId: MachineId | null };
      messageId: string;
      orchestrator: AgentContextViewOrchestrator;
      startedAt: number;
      /** An agent's search or read (`viewerUserId` is that agent); null for a person's view. */
      query: AgentContextQuery | null;
      /** The grant an agent's query of another agent used; null otherwise. */
      grantId?: AgentContextViewGrantId | null;
    },
  ): Promise<void> {
    const { viewerUserId, agent, messageId, orchestrator, startedAt, query } = input;
    const machineId = agent.machineId;
    let reason: AgentContextViewFailureReason | null = null;
    if (!machineId) reason = "no_computer";
    else if (await orchestrator.getMachineStatus(machineId) !== "online") reason = "offline";
    // A search goes only to a daemon that answers it: one that knows only views would answer with the whole context.
    else if (!await orchestrator.machineAdvertisesCapability(machineId, query ? DAEMON_CAPABILITY_AGENT_CONTEXT_SEARCH_V0 : DAEMON_CAPABILITY_AGENT_CONTEXT_VIEW_V0)) reason = "old_daemon";
    // A runtime whose older daemons read more than its sessions (Codex before #13469).
    else {
      for (const capability of agentContextViewRuntimeCapabilities(agent.runtime)) {
        if (!await orchestrator.machineAdvertisesCapability(machineId, capability)) {
          reason = "old_daemon";
          break;
        }
      }
    }
    if (reason || !machineId) {
      await waiter.accept({ kind: "failure", reason: reason ?? "offline" });
      return;
    }

    await this.deps.store.create({
      requestId,
      viewerUserId,
      ...(query ? { viewerKind: "agent" as const, mode: "query" as const } : {}),
      ...(query && input.grantId ? { grantId: input.grantId } : {}),
      agentId: agent.id,
      serverId: agent.serverId,
      messageId,
      machineId,
      viewerReplicaId: this.deps.replicaId,
      viewerEndpoint: this.deps.replicaEndpoint(),
      createdAt: new Date(startedAt).toISOString(),
    }, this.ttlMs);
    // Registered before the request goes out: the result may arrive at once.
    this.waiters.set(requestId, waiter);
    const sent = await orchestrator.sendAgentContextViewRequest(machineId, query
      ? { type: AGENT_CONTEXT_SEARCH_REQUEST_TYPE, requestId, agentId: agent.id, messageId, maxBytes: this.queryMaxBytes, query }
      : { type: AGENT_CONTEXT_VIEW_REQUEST_TYPE, requestId, agentId: agent.id, messageId, maxBytes: this.maxBytes },
    ).catch(() => false);
    if (!sent) await waiter.accept({ kind: "failure", reason: "offline" });
  }

  /**
   * The daemon's result POST (Computer auth already ran; `callerMachineId` is
   * the machine its credential resolves to).
   */
  async receiveResult(req: Request, res: Response, callerMachineId: MachineId): Promise<void> {
    const startedAt = currentTimeMs();
    const answer = (result: DaemonAnswer, inBytes?: number) => {
      recordTraceEvent("server.agent_context_view.result", {
        outcome: result.code,
        bytes: inBytes,
        duration_ms: currentTimeMs() - startedAt,
      });
      if (res.headersSent) return;
      if (!req.complete) {
        // Answer now and stop reading: the connection closes after this
        // status, which is final, so the daemon does not retry.
        res.setHeader("Connection", "close");
        req.unpipe();
      }
      res.status(result.status).json({ ok: result.status === 200, code: result.code });
    };

    const requestId = asAgentContextViewRequestId(String(req.params.requestId ?? ""));
    if (!requestId) {
      answer({ status: 404, code: "not_found" });
      return;
    }
    const claim = await this.deps.store.claim(requestId, callerMachineId, this.ttlMs);
    if (claim.kind === "unknown") return answer(DAEMON_EXPIRED);
    // Another Computer's credential: as an unknown id, and the request stays open.
    if (claim.kind === "wrong_computer") return answer({ status: 404, code: "not_found" });
    if (claim.kind === "already_claimed") return answer({ status: 409, code: "already_claimed" });
    const { record } = claim;
    // The request's deadline (from its creation) bounds the upload, the decode
    // and the hop to the viewer's replica, however slowly bytes arrive.
    const deadline = new AbortController();
    const createdAtMs = Date.parse(record.createdAt);
    const deadlineTimer = setClockTimeout(
      () => deadline.abort(),
      Math.max(0, (Number.isFinite(createdAtMs) ? createdAtMs : startedAt) + this.deadlineMs - currentTimeMs()),
    );
    try {
      await this.receiveClaimed(req, record, deadline.signal, answer);
    } finally {
      clearClockTimeout(deadlineTimer);
    }
  }

  private async receiveClaimed(
    req: Request,
    record: AgentContextViewRequestRecord,
    deadline: AbortSignal,
    answer: (result: DaemonAnswer, inBytes?: number) => void,
  ): Promise<void> {
    const viewer = (viewerAnswer: ViewerAnswer) => this.deliver(record, viewerAnswer, deadline);

    const recheck = await this.deps.recheck(record);
    if (recheck === "refused") {
      await viewer({ kind: "refused" });
      return answer({ status: 403, code: "refused" });
    }
    if (recheck === "agent_moved") {
      await viewer({ kind: "failure", reason: "agent_moved" });
      return answer({ status: 409, code: "agent_moved" });
    }

    const encoding = (req.headers["content-encoding"] ?? "identity").toString().trim().toLowerCase() || "identity";
    if (!isAgentContextViewResultContentEncoding(encoding)) {
      await viewer({ kind: "failure", reason: "read_failed" });
      return answer({ status: 415, code: "unsupported_encoding" });
    }
    const hint = Number(req.headers[AGENT_CONTEXT_VIEW_UNCOMPRESSED_BYTES_HEADER]);
    if (Number.isFinite(hint) && hint > this.maxBytes) {
      await viewer({ kind: "failure", reason: "too_large", tooLargeCause: "request" });
      return answer({ status: 413, code: "too_large" });
    }

    // The upload is read through a PassThrough so a failure on our side can
    // still answer the daemon with a status instead of resetting its socket.
    let producerError: Error | null = null;
    let decodedBytes = 0;
    const source = new PassThrough();
    req.pipe(source);
    req.once("close", () => {
      if (!req.complete) source.destroy(new ResultReadError("result upload aborted"));
    });
    const onDeadline = () => {
      const expired = new ResultExpiredError("context view request past its deadline");
      producerError ??= expired;
      source.destroy(expired);
    };
    if (deadline.aborted) onDeadline();
    else deadline.addEventListener("abort", onDeadline, { once: true });
    const counter = byteCounter(this.maxBytes, (bytes) => {
      decodedBytes = bytes;
    });
    const onDecodeError = (error: Error | null | undefined) => {
      if (error && !producerError) {
        producerError = error instanceof ResultTooLargeError || error instanceof ResultExpiredError ? error : new ResultReadError(error.message);
      }
    };
    const decoded = encoding === "gzip"
      ? pipelineCallback(source, createGunzip(), counter, onDecodeError)
      : pipelineCallback(source, counter, onDecodeError);
    const failureAnswer = (): { reason: AgentContextViewFailureReason; daemon: DaemonAnswer } => {
      if (producerError instanceof ResultTooLargeError) return { reason: "too_large", daemon: { status: 413, code: "too_large" } };
      if (producerError instanceof ResultExpiredError) return { reason: "expired", daemon: DAEMON_EXPIRED };
      return { reason: "read_failed", daemon: { status: 400, code: "read_failed" } };
    };

    // The head: up to AGENT_CONTEXT_VIEW_PARSED_BODY_BYTES, or the whole body.
    const chunks = decoded[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
    const head: Buffer[] = [];
    let headBytes = 0;
    let ended = false;
    try {
      while (headBytes < AGENT_CONTEXT_VIEW_PARSED_BODY_BYTES) {
        const next = await chunks.next();
        if (next.done) {
          ended = true;
          break;
        }
        head.push(next.value);
        headBytes += next.value.length;
      }
    } catch (error) {
      onDecodeError(error as Error);
    }
    if (producerError) {
      decoded.destroy();
      const failed = failureAnswer();
      await viewer({ kind: "failure", reason: failed.reason, ...(failed.reason === "too_large" ? { tooLargeCause: "request" as const } : {}) });
      return answer(failed.daemon, decodedBytes);
    }
    const headBuffer = Buffer.concat(head);

    // An agent's query: its waiter reads the body whole and checks it is an answer.
    if (ended && record.mode !== "query") {
      let parsed: ReturnType<typeof parseAgentContextViewResultBody>;
      try {
        parsed = parseAgentContextViewResultBody(JSON.parse(headBuffer.toString("utf8")));
      } catch {
        parsed = { ok: false, error: "invalid json" };
      }
      if (!parsed.ok) {
        await viewer({ kind: "failure", reason: "read_failed" });
        return answer({ status: 400, code: "read_failed" }, decodedBytes);
      }
      // Valid: the daemon's own bytes go to the viewer, as for a streamed body.
      const delivered = parsed.body.ok
        ? await viewer({ kind: "body", body: Readable.from([headBuffer]) })
        : await viewer({ kind: "failure", reason: parsed.body.reason, ...(parsed.body.tooLargeCause ? { tooLargeCause: parsed.body.tooLargeCause } : {}) });
      return answer(delivered === "delivered" ? DAEMON_DELIVERED : DAEMON_EXPIRED, decodedBytes);
    }

    if (!startsWithObject(headBuffer)) {
      decoded.destroy();
      await viewer({ kind: "failure", reason: "read_failed" });
      return answer({ status: 400, code: "read_failed" }, decodedBytes);
    }
    const body = Readable.from(prepend(headBuffer, chunks), { objectMode: false });
    const delivered = await viewer({ kind: "body", body });
    decoded.destroy();
    if (producerError) return answer(failureAnswer().daemon, decodedBytes);
    return answer(delivered === "delivered" ? DAEMON_DELIVERED : DAEMON_EXPIRED, decodedBytes);
  }

  /** POST /internal/replica/agent-context/:requestId: a result for a viewer waiting on this replica. */
  async receiveForward(req: Request, res: Response): Promise<void> {
    const refuse = (status: number, code: string) => {
      if (!req.complete) res.setHeader("Connection", "close");
      res.status(status).json({ ok: false, code });
    };
    const requestId = asAgentContextViewRequestId(String(req.params.requestId ?? ""));
    if (!requestId) return refuse(404, "not_found");
    if (verifyReplicaRequestSignature(req, requestId) !== "valid") return refuse(401, "invalid_replica_signature");
    const entry = await this.deps.store.get(requestId);
    if (!entry) return refuse(410, "expired");
    if (entry.record.viewerReplicaId !== this.deps.replicaId) return refuse(409, "not_viewer_replica");
    if (!entry.claimed) return refuse(409, "not_claimed");
    const waiter = this.waiters.get(requestId);
    if (!waiter) return refuse(410, "expired");

    const header = req.headers[FORWARD_ANSWER_HEADER];
    let viewerAnswer: ViewerAnswer;
    if (typeof header === "string") {
      if (header === "refused") viewerAnswer = { kind: "refused" };
      else if (isAgentContextViewFailureReason(header)) {
        const cause = req.headers[FORWARD_TOO_LARGE_CAUSE_HEADER];
        viewerAnswer = { kind: "failure", reason: header, ...(isAgentContextViewTooLargeCause(cause) ? { tooLargeCause: cause } : {}) };
      }
      else return refuse(400, "invalid_answer");
    } else {
      viewerAnswer = { kind: "body", body: req };
    }
    const result = await waiter.accept(viewerAnswer);
    if (result === "delivered") {
      res.status(200).json({ ok: true, code: "delivered" });
      return;
    }
    if (res.destroyed) return;
    if (result === "rejected") return refuse(409, "already_answered");
    refuse(result === "viewer_gone" ? 410 : 502, result === "viewer_gone" ? "expired" : "stream_failed");
  }

  private async deliver(record: AgentContextViewRequestRecord, answer: ViewerAnswer, deadline: AbortSignal): Promise<DeliverResult> {
    if (record.viewerReplicaId === this.deps.replicaId) {
      const waiter = this.waiters.get(record.requestId);
      if (!waiter) {
        if (answer.kind === "body") answer.body.destroy();
        return "viewer_gone";
      }
      return waiter.accept(answer);
    }
    return this.forward(record, answer, deadline);
  }

  /** Stream the answer to the viewer's replica; any status but 200 means the viewer is gone. */
  private forward(record: AgentContextViewRequestRecord, answer: ViewerAnswer, deadline: AbortSignal): Promise<DeliverResult> {
    const { requestId } = record;
    if (!record.viewerEndpoint) {
      if (answer.kind === "body") answer.body.destroy();
      return Promise.resolve("viewer_gone");
    }
    const url = new URL(agentContextViewForwardPath(requestId), record.viewerEndpoint);
    const headers: Record<string, string> = {
      ...signReplicaRequestHeaders("POST", url.pathname, requestId),
      "content-type": "application/octet-stream",
    };
    if (answer.kind !== "body") headers[FORWARD_ANSWER_HEADER] = answer.kind === "refused" ? "refused" : answer.reason;
    if (answer.kind === "failure" && answer.tooLargeCause) headers[FORWARD_TOO_LARGE_CAUSE_HEADER] = answer.tooLargeCause;
    return new Promise<DeliverResult>((resolve) => {
      let settled = false;
      const done = (result: DeliverResult) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      // `timeout` covers the connect and any idle stretch; the deadline ends the hop outright.
      const outgoing = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
        method: "POST",
        headers,
        timeout: this.forwardIdleTimeoutMs,
        signal: deadline,
      });
      outgoing.once("timeout", () => outgoing.destroy(new Error("context view hop idle")));
      outgoing.once("response", (response: IncomingMessage) => {
        // The viewer's replica answered: anything but 200 means stop sending.
        if (response.statusCode !== 200 && answer.kind === "body") answer.body.destroy();
        response.resume();
        response.once("end", () => done(response.statusCode === 200 ? "delivered" : "viewer_gone"));
        response.once("error", () => done("viewer_gone"));
        response.once("close", () => done(response.statusCode === 200 && response.complete ? "delivered" : "viewer_gone"));
      });
      outgoing.once("error", () => done(answer.kind === "body" && answer.body.errored ? "stream_failed" : "viewer_gone"));
      if (answer.kind === "body") {
        pipeline(answer.body, outgoing).catch(() => {
          outgoing.destroy();
          done(answer.body.errored ? "stream_failed" : "viewer_gone");
        });
      } else {
        outgoing.end();
      }
    });
  }
}
