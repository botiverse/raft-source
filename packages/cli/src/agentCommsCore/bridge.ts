import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import {
  EXTERNAL_AGENT_ACTIVITY_DRAIN_SCHEMA,
  EXTERNAL_AGENT_ACTIVITY_EVENT_SCHEMA,
  EXTERNAL_AGENT_ACTIVITY_INGEST_SCHEMA,
  EXTERNAL_AGENT_ACTIVITY_TEXT_LIMIT,
  EXTERNAL_AGENT_ACTIVITY_TOOL_NAME_LIMIT,
  EXTERNAL_AGENT_WAKE_EVENT_SCHEMA,
  validateExternalAgentWakeEventEnvelope,
  type ExternalAgentActivityDrainResponse,
  type ExternalAgentActivityEvent,
  type ExternalAgentActivityIngestRequest,
  type ExternalAgentWakeAdapter,
  type ExternalAgentWakeAttemptInput,
  type ExternalAgentWakeEventEnvelope,
} from "@botiverse/raft-shared";

import type { AgentContext } from "../auth/env.js";
import { resolveProfileDir } from "../auth/env.js";

export const AGENT_COMMS_PROTOCOL_VERSION = "agent-comms-core.v1";
export const AGENT_PROOF_SCHEMA_VERSION = "agent-proof.v1";

export type AgentCommsLifecycleState =
  | "unbound"
  | "bound_stopped"
  | "starting"
  | "connected_replaying"
  | "listening_idle"
  | "handoff_pending"
  | "degraded_backoff"
  | "stopping"
  | "stopped"
  | "auth_revoked";

export type AgentCommsProofLevel =
  | "server_delivered"
  | "harness_accepted"
  | "wake_injected"
  | "model_seen";

export interface AgentCommsWakeHint {
  hintId?: string;
  hint_id?: string;
  eventId?: string;
  event_id?: string;
  messageId?: string | null;
  message_id?: string | null;
  seq?: number;
  id?: string;
  target?: string;
  targetType?: string;
  target_type?: string;
  reason?: string;
  wake_reason?: string;
  createdAt?: string;
  created_at?: string;
  [key: string]: unknown;
}

export interface AgentCommsWakeHintFetchResult {
  hints: AgentCommsWakeHint[];
  last_seen_hint_seq?: number | null;
  last_hint_seq?: number | null;
  has_more?: boolean;
}

export interface AgentCommsWakeHintSource {
  fetchWakeHints(input: { since: number | "latest"; limit: number }): Promise<AgentCommsWakeHintFetchResult>;
}

export interface AgentCommsActivityDrainSource {
  drainActivity(input: { max: number }): Promise<ExternalAgentActivityDrainResponse>;
}

export interface AgentCommsActivitySink {
  forwardActivity(input: ExternalAgentActivityIngestRequest): Promise<void>;
}

export interface AgentCommsBridgeIdentity {
  agentId: string;
  profileSlug: string;
  adapterInstance: string;
  coreSessionId: string;
}

export interface AgentCommsProofEvent {
  type: "agent_comms.proof";
  eventId: string;
  attemptId: string;
  protocolVersion: typeof AGENT_COMMS_PROTOCOL_VERSION;
  proofSchemaVersion: typeof AGENT_PROOF_SCHEMA_VERSION;
  timestamp: string;
  coreSessionId: string;
  agentId: string;
  profile: string;
  profileSlug: string;
  adapterInstance: string;
  runtimeSession: null;
  lifecycleState: "handoff_pending";
  source: "slock-agent-bridge";
  provenance: AgentCommsEventProvenance;
  wakeHintId: string | null;
  seq: number | null;
  proofLevel: Extract<AgentCommsProofLevel, "server_delivered" | "harness_accepted">;
  proof: {
    level: Extract<AgentCommsProofLevel, "server_delivered" | "harness_accepted">;
    wakeHintId: string | null;
    seq: number | null;
    target: string | null;
    cursorImpact: {
      wakeDedup: true;
      deliveryAck: false;
      modelSeen: false;
      read: false;
    };
  };
}

export interface AgentCommsLifecycleEvent {
  type: "agent_comms.lifecycle";
  eventId: string;
  protocolVersion: typeof AGENT_COMMS_PROTOCOL_VERSION;
  proofSchemaVersion: typeof AGENT_PROOF_SCHEMA_VERSION;
  timestamp: string;
  coreSessionId: string;
  agentId: string;
  profile: string;
  profileSlug: string;
  adapterInstance: string;
  runtimeSession: null;
  state: AgentCommsLifecycleState;
  lifecycleState: AgentCommsLifecycleState;
  source: "slock-agent-bridge";
  provenance: AgentCommsEventProvenance;
  commsMode: "spawn-core";
}

export interface AgentCommsHandoffEvent {
  type: "agent_comms.handoff";
  eventId: string;
  attemptId: string;
  protocolVersion: typeof AGENT_COMMS_PROTOCOL_VERSION;
  proofSchemaVersion: typeof AGENT_PROOF_SCHEMA_VERSION;
  timestamp: string;
  coreSessionId: string;
  agentId: string;
  profile: string;
  profileSlug: string;
  adapterInstance: string;
  runtimeSession: null;
  state: "handoff_pending";
  lifecycleState: "handoff_pending";
  source: "slock-agent-bridge";
  provenance: AgentCommsEventProvenance;
  replay: boolean;
  wakeHintId: string | null;
  seq: number | null;
  proofLevel: "harness_accepted";
  wakeHint: AgentCommsWakeHint;
  acceptedProof: {
    level: "harness_accepted";
    wakeHintId: string | null;
    seq: number | null;
  };
}

export interface AgentCommsActivityDrainEvent {
  type: "agent_comms.activity_drain";
  eventId: string;
  protocolVersion: typeof AGENT_COMMS_PROTOCOL_VERSION;
  timestamp: string;
  coreSessionId: string;
  agentId: string;
  profile: string;
  profileSlug: string;
  adapterInstance: string;
  runtimeSession: null;
  source: "slock-agent-bridge";
  provenance: AgentCommsEventProvenance;
  outcome: "forwarded" | "no_events" | "failed";
  drainedCount: number;
  forwardedCount: number;
  rejectedCount: number;
  droppedCount: number;
  errorClass?: string;
  errorMessage?: string;
}

export type AgentCommsBridgeOutput =
  | AgentCommsLifecycleEvent
  | AgentCommsProofEvent
  | AgentCommsHandoffEvent
  | AgentCommsActivityDrainEvent
  | ExternalAgentWakeEventEnvelope;

export interface AgentCommsEventProvenance {
  producer: "agent-comms-core";
  authority: "server_core" | "comms_core";
  source: "slock-agent-bridge";
}

export interface AgentCommsBridgeStatePaths {
  rootDir: string;
  sessionFile: string;
  wakeHintsFile: string;
  proofFile: string;
  lockFile: string;
  logFile: string;
}

export interface AgentCommsBridgeStore {
  paths: AgentCommsBridgeStatePaths;
  readSession(): { coreSessionId?: string; lastSeenHintSeq?: number } | null;
  writeSession(session: { coreSessionId: string; lastSeenHintSeq?: number }): void;
  readWakeHints(): AgentCommsWakeHint[];
  appendWakeHintIfAbsent(wakeHint: AgentCommsWakeHint): boolean;
  removeWakeHint(wakeHint: AgentCommsWakeHint): void;
  appendProof(proof: AgentCommsProofEvent | ExternalAgentWakeEventEnvelope): void;
  /**
   * Persistent operator-facing observability sink (task #87, xxchan):
   * NDJSON lifecycle/protocol events under the profile state dir so
   * "why didn't it wake" is answerable with one tail, independent of
   * --json stdout (which the plugin supervisor swallows into deep CC
   * MCP logs). Size-rotated; never throws (observability must not take
   * the bridge down).
   */
  appendLog(event: Record<string, unknown>): void;
}

export interface AgentCommsBridgeLock {
  path: string;
  ownerId: string;
  release(): void;
}

export class AgentCommsBridgeLockError extends Error {
  readonly code = "BRIDGE_ALREADY_RUNNING";

  constructor(readonly lockPath: string, readonly owner: unknown) {
    super("raft agent bridge is already running for this profile/agent/adapter state.");
  }
}

export interface RunBridgeOnceInput {
  agentContext: AgentContext;
  source: AgentCommsWakeHintSource;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  stateDir?: string;
  adapterInstance?: string;
  limit?: number;
  replayPending?: boolean;
  coreSessionId?: string;
  wakeAdapter?: ExternalAgentWakeAdapter;
  runtimeSession?: string | null;
  activitySource?: AgentCommsActivityDrainSource;
  activitySink?: AgentCommsActivitySink;
  activityDrainLimit?: number;
  /**
   * Optional hint-key -> inject-epoch-ms map shared with reconciliation so
   * its grace window can skip wakes the live path just injected. Keys are
   * wakeHintKey() — kept inside the core because the wake envelope's eventId
   * is the generated attempt id, not the hint identity.
   */
  recentInjections?: Map<string, number>;
}

export function resolveAgentCommsBridgeStateDir(input: {
  agentContext: AgentContext;
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
  adapterInstance?: string;
}): string {
  if (input.stateDir) return input.stateDir;
  const env = input.env ?? process.env;
  if (env.RAFT_AGENT_BRIDGE_STATE_DIR) return env.RAFT_AGENT_BRIDGE_STATE_DIR;
  const profileSlug = requireProfileSlug(input.agentContext);
  const adapterInstance = input.adapterInstance ?? "default";
  return path.join(
    resolveProfileDir(profileSlug, env),
    "agent-comms-core",
    safePathSegment(input.agentContext.agentId),
    safePathSegment(adapterInstance),
  );
}

export function createFileAgentCommsBridgeStore(input: {
  agentContext: AgentContext;
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
  adapterInstance?: string;
}): AgentCommsBridgeStore {
  const rootDir = resolveAgentCommsBridgeStateDir(input);
  const paths: AgentCommsBridgeStatePaths = {
    rootDir,
    sessionFile: path.join(rootDir, "session.json"),
    wakeHintsFile: path.join(rootDir, "wake-hints.jsonl"),
    proofFile: path.join(rootDir, "proofs.jsonl"),
    lockFile: path.join(rootDir, "bridge.lock"),
    logFile: path.join(rootDir, "bridge.log"),
  };
  fs.mkdirSync(rootDir, { recursive: true, mode: 0o700 });
  return {
    paths,
    readSession() {
      if (!fs.existsSync(paths.sessionFile)) return null;
      try {
        const parsed = JSON.parse(fs.readFileSync(paths.sessionFile, "utf-8")) as {
          coreSessionId?: unknown;
          lastSeenHintSeq?: unknown;
        };
        return {
          ...(typeof parsed.coreSessionId === "string" ? { coreSessionId: parsed.coreSessionId } : {}),
          ...(typeof parsed.lastSeenHintSeq === "number" ? { lastSeenHintSeq: parsed.lastSeenHintSeq } : {}),
        };
      } catch {
        return null;
      }
    },
    writeSession(session) {
      fs.writeFileSync(paths.sessionFile, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
    },
    readWakeHints() {
      return readJsonl<AgentCommsWakeHint>(paths.wakeHintsFile);
    },
    appendWakeHintIfAbsent(hint) {
      const key = wakeHintKey(hint);
      const pending = readJsonl<AgentCommsWakeHint>(paths.wakeHintsFile);
      if (pending.some((candidate) => wakeHintKey(candidate) === key)) return false;
      appendJsonl(paths.wakeHintsFile, stripContentFields(hint));
      return true;
    },
    appendProof(proof) {
      appendJsonl(paths.proofFile, proof);
    },
    appendLog(event) {
      try {
        rotateBridgeLogIfNeeded(paths.logFile);
        appendJsonl(paths.logFile, { ts: new Date().toISOString(), ...event });
      } catch {
        // Observability is best-effort by design.
      }
    },
    removeWakeHint(hint) {
      const key = wakeHintKey(hint);
      const pending = readJsonl<AgentCommsWakeHint>(paths.wakeHintsFile);
      const remaining = pending.filter((candidate) => wakeHintKey(candidate) !== key);
      if (remaining.length === pending.length) return;
      fs.writeFileSync(
        paths.wakeHintsFile,
        remaining.map((entry) => JSON.stringify(entry)).join("\n") + (remaining.length > 0 ? "\n" : ""),
        { mode: 0o600 },
      );
    },
  };
}

export function acquireAgentCommsBridgeLock(input: {
  agentContext: AgentContext;
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
  adapterInstance?: string;
  ownerId?: string;
}): AgentCommsBridgeLock {
  const store = createFileAgentCommsBridgeStore(input);
  const ownerId = input.ownerId ?? `owner_${randomUUID()}`;
  const owner = {
    ownerId,
    pid: process.pid,
    createdAt: new Date().toISOString(),
    profileSlug: requireProfileSlug(input.agentContext),
    agentId: input.agentContext.agentId,
    adapterInstance: input.adapterInstance ?? "default",
  };

  return acquireLockFile(store.paths.lockFile, ownerId, owner, false);
}

export async function runAgentCommsBridgeOnce(input: RunBridgeOnceInput): Promise<AgentCommsBridgeOutput[]> {
  if (input.agentContext.clientMode !== "self-hosted-runner") {
    throw new Error("raft agent bridge requires a self-hosted profile credential; run with `raft --profile <slug> agent bridge`.");
  }
  const profileSlug = requireProfileSlug(input.agentContext);
  const adapterInstance = input.adapterInstance ?? "default";
  const store = createFileAgentCommsBridgeStore({
    agentContext: input.agentContext,
    env: input.env,
    stateDir: input.stateDir,
    adapterInstance,
  });
  const existingSession = store.readSession();
  const coreSessionId = input.coreSessionId ?? existingSession?.coreSessionId ?? `core_${randomUUID()}`;
  const identity: AgentCommsBridgeIdentity = {
    agentId: input.agentContext.agentId,
    profileSlug,
    adapterInstance,
    coreSessionId,
  };
  const now = input.now ?? (() => new Date());
  const output: AgentCommsBridgeOutput[] = [
    lifecycle(identity, "starting", now),
  ];

  if (input.replayPending !== false) {
    const hints = store.readWakeHints();
    if (hints.length > 0) {
      output.push(lifecycle(identity, "connected_replaying", now));
      for (const hint of hints) {
        const attemptId = `attempt_${randomUUID()}`;
        output.push(handoff(identity, hint, attemptId, true, now));
        await maybeRunWakeAdapter({
          identity,
          hint,
          attemptId,
          wakeAdapter: input.wakeAdapter,
          runtimeSession: input.runtimeSession ?? null,
          now,
          output,
          store,
          recentInjections: input.recentInjections,
        });
      }
    }
  }

  const since = existingSession?.lastSeenHintSeq ?? "latest";
  const fetched = await input.source.fetchWakeHints({ since, limit: input.limit ?? 50 });
  let lastSeenHintSeq = existingSession?.lastSeenHintSeq;
  let processedHintCount = 0;
  for (const hint of fetched.hints) {
    const seq = wakeHintSeq(hint);
    if (
      typeof seq === "number" &&
      typeof lastSeenHintSeq === "number" &&
      seq <= lastSeenHintSeq
    ) {
      continue;
    }
    const attemptId = `attempt_${randomUUID()}`;
    const serverDelivered = proof(identity, hint, attemptId, "server_delivered", now);
    store.appendProof(serverDelivered);
    output.push(serverDelivered);

    store.appendWakeHintIfAbsent(hint);
    const accepted = proof(identity, hint, attemptId, "harness_accepted", now);
    store.appendProof(accepted);
    output.push(accepted);
    output.push(handoff(identity, hint, attemptId, false, now));
    await maybeRunWakeAdapter({
      identity,
      hint,
      attemptId,
      wakeAdapter: input.wakeAdapter,
      runtimeSession: input.runtimeSession ?? null,
      now,
      output,
      store,
      recentInjections: input.recentInjections,
    });

    if (typeof seq === "number") lastSeenHintSeq = Math.max(lastSeenHintSeq ?? 0, seq);
    processedHintCount += 1;
  }
  const fetchedLastSeq = typeof fetched.last_seen_hint_seq === "number"
    ? fetched.last_seen_hint_seq
    : typeof fetched.last_hint_seq === "number"
      ? fetched.last_hint_seq
      : undefined;
  if (typeof fetchedLastSeq === "number") lastSeenHintSeq = Math.max(lastSeenHintSeq ?? 0, fetchedLastSeq);

  if (input.activitySource && input.activitySink) {
    output.push(await drainAndForwardActivity({
      identity,
      source: input.activitySource,
      sink: input.activitySink,
      max: input.activityDrainLimit ?? input.limit ?? 50,
      now,
    }));
  }

  store.writeSession({
    coreSessionId,
    ...(typeof lastSeenHintSeq === "number" ? { lastSeenHintSeq } : {}),
  });
  output.push(lifecycle(identity, processedHintCount > 0 ? "handoff_pending" : "listening_idle", now));
  return output;
}

async function drainAndForwardActivity(input: {
  identity: AgentCommsBridgeIdentity;
  source: AgentCommsActivityDrainSource;
  sink: AgentCommsActivitySink;
  max: number;
  now: () => Date;
}): Promise<AgentCommsActivityDrainEvent> {
  let drained: ExternalAgentActivityDrainResponse;
  try {
    drained = await input.source.drainActivity({ max: input.max });
  } catch (err) {
    return activityDrainEvent(input.identity, input.now, {
      outcome: "failed",
      drainedCount: 0,
      forwardedCount: 0,
      rejectedCount: 0,
      droppedCount: 0,
      errorClass: err instanceof Error ? err.name : typeof err,
      errorMessage: errorMessage(err),
    });
  }

  if (drained.schema !== EXTERNAL_AGENT_ACTIVITY_DRAIN_SCHEMA || !Array.isArray(drained.events)) {
    return activityDrainEvent(input.identity, input.now, {
      outcome: "failed",
      drainedCount: 0,
      forwardedCount: 0,
      rejectedCount: 0,
      droppedCount: normalizeNonNegativeInteger(drained.dropped),
      errorClass: "ProtocolError",
      errorMessage: "activity drain response did not match raft-activity-drain.v1",
    });
  }

  const sanitized = sanitizeExternalAgentActivityEvents(drained.events, input.now);
  if (sanitized.events.length === 0) {
    return activityDrainEvent(input.identity, input.now, {
      outcome: "no_events",
      drainedCount: drained.events.length,
      forwardedCount: 0,
      rejectedCount: sanitized.rejectedCount,
      droppedCount: normalizeNonNegativeInteger(drained.dropped),
    });
  }

  try {
    await input.sink.forwardActivity({
      schema: EXTERNAL_AGENT_ACTIVITY_INGEST_SCHEMA,
      coreSessionId: input.identity.coreSessionId,
      adapterInstance: input.identity.adapterInstance,
      events: sanitized.events,
      dropped: normalizeNonNegativeInteger(drained.dropped),
    });
  } catch (err) {
    return activityDrainEvent(input.identity, input.now, {
      outcome: "failed",
      drainedCount: drained.events.length,
      forwardedCount: 0,
      rejectedCount: sanitized.rejectedCount,
      droppedCount: normalizeNonNegativeInteger(drained.dropped),
      errorClass: err instanceof Error ? err.name : typeof err,
      errorMessage: errorMessage(err),
    });
  }

  return activityDrainEvent(input.identity, input.now, {
    outcome: "forwarded",
    drainedCount: drained.events.length,
    forwardedCount: sanitized.events.length,
    rejectedCount: sanitized.rejectedCount,
    droppedCount: normalizeNonNegativeInteger(drained.dropped),
  });
}

export function sanitizeExternalAgentActivityEvents(
  rawEvents: ExternalAgentActivityEvent[],
  now: () => Date = () => new Date(),
): { events: ExternalAgentActivityEvent[]; rejectedCount: number } {
  const events: ExternalAgentActivityEvent[] = [];
  let rejectedCount = 0;
  for (const raw of rawEvents) {
    const hookEventName = stringField(raw.hookEventName ?? raw.hook_event_name, 80);
    if (!hookEventName) {
      rejectedCount += 1;
      continue;
    }

    const eventId = stringField(raw.eventId ?? raw.event_id, 160) ?? `event_${randomUUID()}`;
    const sessionId = stringField(raw.sessionId ?? raw.session_id, 200);
    const toolName = stringField(raw.toolName ?? raw.tool_name, EXTERNAL_AGENT_ACTIVITY_TOOL_NAME_LIMIT);
    const status = stringField(raw.status, 40);
    const errorClass = stringField(raw.errorClass ?? raw.error_class, 120);
    const occurredAt = validIsoDate(raw.occurredAt ?? raw.occurred_at) ?? now().toISOString();
    const durationMs = normalizeNonNegativeInteger(raw.durationMs ?? raw.duration_ms);
    const toolInput = truncateActivityText(
      raw.toolInput ?? raw.tool_input,
      raw.toolInputTruncated ?? raw.tool_input_truncated ?? raw.truncated,
    );
    const toolOutput = truncateActivityText(
      raw.toolOutput ?? raw.tool_output,
      raw.toolOutputTruncated ?? raw.tool_output_truncated ?? raw.truncated,
    );

    events.push({
      schema: EXTERNAL_AGENT_ACTIVITY_EVENT_SCHEMA,
      eventId,
      ...(sessionId ? { sessionId } : {}),
      hookEventName,
      ...(toolName ? { toolName } : {}),
      ...(status ? { status } : {}),
      occurredAt,
      ...(durationMs > 0 ? { durationMs } : {}),
      ...(errorClass ? { errorClass } : {}),
      ...(toolInput.text !== undefined ? { toolInput: toolInput.text, toolInputTruncated: toolInput.truncated } : {}),
      ...(toolOutput.text !== undefined ? { toolOutput: toolOutput.text, toolOutputTruncated: toolOutput.truncated } : {}),
    });
  }
  return { events, rejectedCount };
}

function activityDrainEvent(
  identity: AgentCommsBridgeIdentity,
  now: () => Date,
  result: Omit<AgentCommsActivityDrainEvent, "type" | "eventId" | "protocolVersion" | "timestamp" | "coreSessionId" | "agentId" | "profile" | "profileSlug" | "adapterInstance" | "runtimeSession" | "source" | "provenance">,
): AgentCommsActivityDrainEvent {
  return {
    type: "agent_comms.activity_drain",
    eventId: `event_${randomUUID()}`,
    protocolVersion: AGENT_COMMS_PROTOCOL_VERSION,
    timestamp: now().toISOString(),
    coreSessionId: identity.coreSessionId,
    agentId: identity.agentId,
    profile: identity.profileSlug,
    profileSlug: identity.profileSlug,
    adapterInstance: identity.adapterInstance,
    runtimeSession: null,
    source: "slock-agent-bridge",
    provenance: commsCoreProvenance("comms_core"),
    ...result,
  };
}

const BRIDGE_LOG_MAX_BYTES = 5 * 1024 * 1024;

function rotateBridgeLogIfNeeded(logFile: string): void {
  try {
    const stat = fs.statSync(logFile);
    if (stat.size < BRIDGE_LOG_MAX_BYTES) return;
    fs.renameSync(logFile, `${logFile}.1`);
  } catch {
    // Missing file or race: nothing to rotate.
  }
}

export interface AgentCommsBridgeReconcileResult {
  pendingCount: number;
  reinjectedCount: number;
  skippedRecentCount: number;
  events: AgentCommsBridgeOutput[];
}

/**
 * EAB invariant 7 (Kai, task #87): at-least-once-until-consumed wake
 * reconciliation. `wake_injected` is transport-written, NOT model-consumed —
 * a wake can be accepted by the runtime plugin and still be silently dropped
 * downstream (Claude Code channels allowlist, mid-turn drop, supervisor
 * crash). The server-side wake-hint peek is non-draining, so "still pending"
 * IS "not yet consumed": re-peek the full pending set periodically and
 * re-inject anything the agent has not drained.
 *
 * Contract pins:
 * - This complements, not replaces, the local ledger replay: the ledger
 *   covers crash-before-inject across bridge restarts; reconciliation covers
 *   injected-but-not-consumed against server-pending truth.
 * - Zero cursor movement: reuses the non-draining GET /wake-hints peek and
 *   never touches the session's lastSeenHintSeq or any consume state.
 * - `recentInjections` grace keeps a just-injected hint from being doubled
 *   when the reconcile timer lands right after a live wake.
 */
export async function runAgentCommsBridgeReconcile(input: RunBridgeOnceInput & {
  recentInjections?: Map<string, number>;
  graceMs?: number;
}): Promise<AgentCommsBridgeReconcileResult> {
  const profileSlug = requireProfileSlug(input.agentContext);
  const adapterInstance = input.adapterInstance ?? "default";
  const store = createFileAgentCommsBridgeStore({
    agentContext: input.agentContext,
    env: input.env,
    stateDir: input.stateDir,
    adapterInstance,
  });
  const existingSession = store.readSession();
  const sessionBefore = existingSession ? { ...existingSession } : null;
  const identity: AgentCommsBridgeIdentity = {
    agentId: input.agentContext.agentId,
    profileSlug,
    adapterInstance,
    coreSessionId: input.coreSessionId ?? existingSession?.coreSessionId ?? `core_${randomUUID()}`,
  };
  const now = input.now ?? (() => new Date());
  const events: AgentCommsBridgeOutput[] = [];
  const graceMs = input.graceMs ?? 30_000;
  const recent = input.recentInjections;

  // Full-pending peek: since=0 deliberately ignores lastSeenHintSeq — the
  // at-most-once seen-filter is exactly what reconciliation must bypass.
  const fetched = await input.source.fetchWakeHints({ since: 0, limit: input.limit ?? 50 });
  let reinjected = 0;
  let skippedRecent = 0;
  for (const hint of fetched.hints) {
    const key = wakeHintKey(hint);
    const injectedAt = recent?.get(key);
    if (typeof injectedAt === "number" && now().getTime() - injectedAt < graceMs) {
      skippedRecent += 1;
      continue;
    }
    const attemptId = `attempt_${randomUUID()}`;
    // No-drop ledger first, same as the live path: if this re-inject fails,
    // the hint must survive for crash replay (and the next reconcile retries
    // it — only a successful injection starts a grace window).
    store.appendWakeHintIfAbsent(hint);
    events.push(handoff(identity, hint, attemptId, true, now));
    await maybeRunWakeAdapter({
      identity,
      hint,
      attemptId,
      wakeAdapter: input.wakeAdapter,
      runtimeSession: input.runtimeSession ?? null,
      now,
      output: events,
      store,
      recentInjections: recent,
    });
    reinjected += 1;
  }

  // Cursor-orthogonality guard: reconciliation must leave the session file
  // exactly as it found it (lastSeenHintSeq untouched).
  const sessionAfter = store.readSession();
  if (JSON.stringify(sessionAfter) !== JSON.stringify(sessionBefore)) {
    throw new Error("bridge reconcile must not modify session state (cursor-orthogonality)");
  }

  return {
    pendingCount: fetched.hints.length,
    reinjectedCount: reinjected,
    skippedRecentCount: skippedRecent,
    events,
  };
}

async function maybeRunWakeAdapter(input: {
  identity: AgentCommsBridgeIdentity;
  hint: AgentCommsWakeHint;
  attemptId: string;
  wakeAdapter?: ExternalAgentWakeAdapter;
  runtimeSession: string | null;
  now: () => Date;
  output: AgentCommsBridgeOutput[];
  store: AgentCommsBridgeStore;
  recentInjections?: Map<string, number>;
}): Promise<void> {
  if (!input.wakeAdapter) return;

  const wakeInput = wakeAttemptInput({
    identity: input.identity,
    hint: input.hint,
    attemptId: input.attemptId,
    runtimeSession: input.runtimeSession,
    now: input.now,
  });
  const event = await wakeAdapterEvent(input.wakeAdapter, wakeInput);
  input.store.appendProof(event);
  input.output.push(event);
  // task #77 — at-most-once replay bookkeeping: a hint that reached
  // `wake_injected` has served its purpose; keeping it in wake-hints.jsonl
  // made EVERY bridge start replay the full history as stale wakes (field
  // hit by xxchan: hints for long-drained messages, check rightly empty).
  // NO-DROP rule (Kai, FH/CC2): prune ONLY after successful injection —
  // failed/no_session/busy attempts keep the hint so replay can retry it.
  if ((event as { proofLevel?: string }).proofLevel === "wake_injected") {
    input.store.removeWakeHint(input.hint);
    if (input.recentInjections) {
      input.recentInjections.set(wakeHintKey(input.hint), input.now().getTime());
      if (input.recentInjections.size > 1000) {
        const cutoff = input.now().getTime() - 600_000;
        for (const [key, ts] of input.recentInjections) {
          if (ts < cutoff) input.recentInjections.delete(key);
        }
      }
    }
  }
}

function wakeAttemptInput(input: {
  identity: AgentCommsBridgeIdentity;
  hint: AgentCommsWakeHint;
  attemptId: string;
  runtimeSession: string | null;
  now: () => Date;
}): ExternalAgentWakeAttemptInput {
  return {
    eventId: `event_${randomUUID()}`,
    attemptId: input.attemptId,
    messageId: wakeHintMessageId(input.hint),
    agentId: input.identity.agentId,
    profile: input.identity.profileSlug,
    coreSessionId: input.identity.coreSessionId,
    adapterInstance: input.identity.adapterInstance,
    runtimeSession: input.runtimeSession,
    occurredAt: input.now().toISOString(),
  };
}

async function wakeAdapterEvent(
  wakeAdapter: ExternalAgentWakeAdapter,
  input: ExternalAgentWakeAttemptInput,
): Promise<ExternalAgentWakeEventEnvelope> {
  try {
    return await wakeAdapter.wake(input);
  } catch (err) {
    const reason = err instanceof Error && err.message
      ? err.message
      : "Wake adapter failed before producing a proof event";
    return validateExternalAgentWakeEventEnvelope({
      ...input,
      schema: EXTERNAL_AGENT_WAKE_EVENT_SCHEMA,
      kind: "wake_attempt",
      outcome: "failed",
      lifecycleState: "degraded_backoff",
      failureMeta: { failureClass: "injection_failed" },
      reason,
      authority: {
        source: "wake_adapter",
        provenance: "adapter_observed",
      },
    });
  }
}

function lifecycle(
  identity: AgentCommsBridgeIdentity,
  state: AgentCommsLifecycleState,
  now: () => Date,
): AgentCommsLifecycleEvent {
  return {
    type: "agent_comms.lifecycle",
    eventId: `event_${randomUUID()}`,
    protocolVersion: AGENT_COMMS_PROTOCOL_VERSION,
    proofSchemaVersion: AGENT_PROOF_SCHEMA_VERSION,
    timestamp: now().toISOString(),
    coreSessionId: identity.coreSessionId,
    agentId: identity.agentId,
    profile: identity.profileSlug,
    profileSlug: identity.profileSlug,
    adapterInstance: identity.adapterInstance,
    runtimeSession: null,
    state,
    lifecycleState: state,
    source: "slock-agent-bridge",
    provenance: commsCoreProvenance("comms_core"),
    commsMode: "spawn-core",
  };
}

function proof(
  identity: AgentCommsBridgeIdentity,
  wakeHint: AgentCommsWakeHint,
  attemptId: string,
  level: Extract<AgentCommsProofLevel, "server_delivered" | "harness_accepted">,
  now: () => Date,
): AgentCommsProofEvent {
  const id = wakeHintId(wakeHint);
  const seq = wakeHintSeq(wakeHint) ?? null;
  return {
    type: "agent_comms.proof",
    eventId: `event_${randomUUID()}`,
    attemptId,
    protocolVersion: AGENT_COMMS_PROTOCOL_VERSION,
    proofSchemaVersion: AGENT_PROOF_SCHEMA_VERSION,
    timestamp: now().toISOString(),
    coreSessionId: identity.coreSessionId,
    agentId: identity.agentId,
    profile: identity.profileSlug,
    profileSlug: identity.profileSlug,
    adapterInstance: identity.adapterInstance,
    runtimeSession: null,
    lifecycleState: "handoff_pending",
    source: "slock-agent-bridge",
    provenance: commsCoreProvenance(level === "server_delivered" ? "server_core" : "comms_core"),
    wakeHintId: id,
    seq,
    proofLevel: level,
    proof: {
      level,
      wakeHintId: id,
      seq,
      target: wakeHintTarget(wakeHint),
      cursorImpact: {
        wakeDedup: true,
        deliveryAck: false,
        modelSeen: false,
        read: false,
      },
    },
  };
}

function handoff(
  identity: AgentCommsBridgeIdentity,
  wakeHint: AgentCommsWakeHint,
  attemptId: string,
  replay: boolean,
  now: () => Date,
): AgentCommsHandoffEvent {
  const id = wakeHintId(wakeHint);
  const seq = wakeHintSeq(wakeHint) ?? null;
  return {
    type: "agent_comms.handoff",
    eventId: `event_${randomUUID()}`,
    attemptId,
    protocolVersion: AGENT_COMMS_PROTOCOL_VERSION,
    proofSchemaVersion: AGENT_PROOF_SCHEMA_VERSION,
    timestamp: now().toISOString(),
    coreSessionId: identity.coreSessionId,
    agentId: identity.agentId,
    profile: identity.profileSlug,
    profileSlug: identity.profileSlug,
    adapterInstance: identity.adapterInstance,
    runtimeSession: null,
    state: "handoff_pending",
    lifecycleState: "handoff_pending",
    source: "slock-agent-bridge",
    provenance: commsCoreProvenance("comms_core"),
    replay,
    wakeHintId: id,
    seq,
    proofLevel: "harness_accepted",
    wakeHint: stripContentFields(wakeHint),
    acceptedProof: {
      level: "harness_accepted",
      wakeHintId: id,
      seq,
    },
  };
}

function commsCoreProvenance(authority: AgentCommsEventProvenance["authority"]): AgentCommsEventProvenance {
  return {
    producer: "agent-comms-core",
    authority,
    source: "slock-agent-bridge",
  };
}

function readJsonl<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf-8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

function appendJsonl(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

function acquireLockFile(lockPath: string, ownerId: string, owner: unknown, retried: boolean): AgentCommsBridgeLock {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  try {
    const fd = fs.openSync(lockPath, "wx", 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(owner, null, 2)}\n`);
    fs.closeSync(fd);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    const existing = readLockOwner(lockPath);
    if (!retried && isStaleLockOwner(existing)) {
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // Another process may have removed or replaced it; retry once and then fail closed.
      }
      return acquireLockFile(lockPath, ownerId, owner, true);
    }
    throw new AgentCommsBridgeLockError(lockPath, existing);
  }

  let released = false;
  return {
    path: lockPath,
    ownerId,
    release() {
      if (released) return;
      released = true;
      const existing = readLockOwner(lockPath) as { ownerId?: unknown } | null;
      if (existing?.ownerId === ownerId) {
        fs.unlinkSync(lockPath);
      }
    },
  };
}

function readLockOwner(lockPath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(lockPath, "utf-8"));
  } catch {
    return null;
  }
}

function isStaleLockOwner(owner: unknown): boolean {
  if (!owner || typeof owner !== "object") return false;
  const pid = (owner as { pid?: unknown }).pid;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "ESRCH";
  }
}

function requireProfileSlug(agentContext: AgentContext): string {
  if (!agentContext.profileSlug) {
    throw new Error("raft agent bridge requires RAFT_PROFILE / --profile so state is profile-scoped.");
  }
  return agentContext.profileSlug;
}

function wakeHintKey(wakeHint: AgentCommsWakeHint): string {
  const id = wakeHintId(wakeHint);
  if (id) return `id:${id}`;
  const seq = wakeHintSeq(wakeHint);
  if (typeof seq === "number") return `seq:${seq}`;
  return `hint:${JSON.stringify(stripContentFields(wakeHint))}`;
}

function wakeHintId(wakeHint: AgentCommsWakeHint): string | null {
  if (typeof wakeHint.hintId === "string" && wakeHint.hintId.length > 0) return wakeHint.hintId;
  if (typeof wakeHint.hint_id === "string" && wakeHint.hint_id.length > 0) return wakeHint.hint_id;
  if (typeof wakeHint.eventId === "string" && wakeHint.eventId.length > 0) return wakeHint.eventId;
  if (typeof wakeHint.event_id === "string" && wakeHint.event_id.length > 0) return wakeHint.event_id;
  if (typeof wakeHint.id === "string" && wakeHint.id.length > 0) return wakeHint.id;
  return null;
}

function wakeHintMessageId(wakeHint: AgentCommsWakeHint): string {
  if (typeof wakeHint.messageId === "string" && wakeHint.messageId.length > 0) return wakeHint.messageId;
  if (typeof wakeHint.message_id === "string" && wakeHint.message_id.length > 0) return wakeHint.message_id;
  const id = wakeHintId(wakeHint);
  if (id) return id;
  const seq = wakeHintSeq(wakeHint);
  if (typeof seq === "number") return `seq:${seq}`;
  const target = wakeHintTarget(wakeHint);
  if (target) return `target:${target}`;
  return `wake-hint:${JSON.stringify(stripContentFields(wakeHint))}`;
}

function wakeHintSeq(wakeHint: AgentCommsWakeHint): number | undefined {
  if (typeof wakeHint.seq !== "number" || !Number.isInteger(wakeHint.seq) || wakeHint.seq <= 0) return undefined;
  return wakeHint.seq;
}

function wakeHintTarget(wakeHint: AgentCommsWakeHint): string | null {
  if (typeof wakeHint.target === "string" && wakeHint.target.length > 0) return wakeHint.target;
  return null;
}

function stripContentFields(wakeHint: AgentCommsWakeHint): AgentCommsWakeHint {
  const clone: AgentCommsWakeHint = { ...wakeHint };
  delete (clone as { content?: unknown }).content;
  delete (clone as { body?: unknown }).body;
  delete (clone as { text?: unknown }).text;
  delete (clone as { message?: unknown }).message;
  return clone;
}

function stringField(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, maxLength);
}

function validIsoDate(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return undefined;
  return new Date(parsed).toISOString();
}

function normalizeNonNegativeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

function truncateActivityText(
  value: unknown,
  alreadyTruncated?: unknown,
): { text?: string; truncated: boolean } {
  if (value === undefined || value === null) return { truncated: Boolean(alreadyTruncated) };
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }

  const marker = "\n[truncated]";
  if (text.length > EXTERNAL_AGENT_ACTIVITY_TEXT_LIMIT) {
    return {
      text: `${text.slice(0, Math.max(0, EXTERNAL_AGENT_ACTIVITY_TEXT_LIMIT - marker.length))}${marker}`,
      truncated: true,
    };
  }
  return { text, truncated: Boolean(alreadyTruncated) };
}

function errorMessage(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 200);
}

function safePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "unknown";
}
