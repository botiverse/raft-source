/**
 * Agent typing line, server half (see packages/shared/src/agentTyping.ts).
 *
 * The daemon reports `agent:send_intent` while an agent is generating a
 * `raft message send --target <T>` call. This registry resolves the target
 * read-only, emits `agent:typing` to that conversation's own room
 * (`channel:<id>`, never `server:<id>`: the server-wide room carries no
 * targets, so private channel and DM names cannot leak), and remembers the
 * live calls so an `end` (or the agent stopping / its Computer
 * disconnecting) closes the line.
 *
 * In-memory, per process: a machine's frames always arrive on the replica
 * that holds its socket, and the room emit itself crosses replicas through the
 * socket adapter. Losing the map (restart, failover) only means clients expire
 * their lines on `expiresAt`.
 */
import {
  AGENT_TYPING_SOCKET_EVENT,
  AGENT_TYPING_TTL_MS,
  type AgentSendIntentFrame,
  type AgentTypingEvent,
} from "@botiverse/raft-shared";
import type { AgentPostTargetPreview } from "../routes/agentWritableTarget";

/**
 * A typing line's resolved conversation: a message target's preview, or (task
 * v2, `raft task reply <ref>`) the task's own conversation plus its task id.
 */
export type AgentTypingTargetPreview = AgentPostTargetPreview & { taskId?: string };

export const AGENT_SEND_INTENT_CALL_ID_MAX_LENGTH = 200;
export const AGENT_SEND_INTENT_TARGET_MAX_LENGTH = 512;
/** Live typing calls kept per agent; a start beyond this is dropped. */
export const AGENT_TYPING_MAX_CALLS_PER_AGENT = 8;

export type ValidAgentSendIntent = {
  agentId: string;
  launchId?: string;
  callId: string;
  phase: "start" | "end";
  target?: string;
};

/** Shape check for an untrusted frame. Null: drop it. */
export function parseAgentSendIntentFrame(msg: unknown): ValidAgentSendIntent | null {
  if (!msg || typeof msg !== "object") return null;
  const frame = msg as Partial<Record<keyof AgentSendIntentFrame, unknown>>;
  if (typeof frame.agentId !== "string" || !frame.agentId) return null;
  if (frame.launchId !== undefined && typeof frame.launchId !== "string") return null;
  if (typeof frame.callId !== "string" || !frame.callId || frame.callId.length > AGENT_SEND_INTENT_CALL_ID_MAX_LENGTH) return null;
  if (frame.phase !== "start" && frame.phase !== "end") return null;
  if (frame.target !== undefined && (typeof frame.target !== "string" || frame.target.length > AGENT_SEND_INTENT_TARGET_MAX_LENGTH)) return null;
  if (frame.phase === "start" && !frame.target) return null;
  return {
    agentId: frame.agentId,
    ...(frame.launchId !== undefined ? { launchId: frame.launchId } : {}),
    callId: frame.callId,
    phase: frame.phase,
    ...(typeof frame.target === "string" ? { target: frame.target } : {}),
  };
}

export type AgentTypingAgent = { id: string; serverId: string; machineId: string };

export type AgentTypingDeps = {
  now(): number;
  emit(room: string, event: string, payload: AgentTypingEvent): void;
  previewTarget(serverId: string, agentId: string, target: string): Promise<AgentTypingTargetPreview | null>;
};

export type AgentSendIntentOutcome =
  | "emitted_start"
  | "refreshed"
  | "emitted_end"
  | "unresolved_target"
  | "unknown_call"
  | "ended_call"
  | "superseded"
  | "too_many_calls";

type TypingEntry = {
  agentId: string;
  machineId: string;
  callId: string;
  serverId: string;
  channelId: string;
  parentMessageId: string | null;
  /** Task v2: the line is in this task's conversation (`channelId`). */
  taskId?: string;
  target: string;
  expiresAt: number;
};

function entryKey(agentId: string, callId: string): string {
  return `${agentId}\u0000${callId}`;
}

/**
 * Where an agent's message landed: the channel itself, or the thread under
 * `parentMessageId`. A task v2 conversation is its own channel (its id,
 * `parentMessageId: null`), like the typing line's entry for it.
 */
export type AgentPostedConversation =
  | { channelId: string; parentMessageId: null }
  | { channelId: string | null; parentMessageId: string };

/** At most one full sweep per this window (frames arrive every few seconds per call). */
export const AGENT_TYPING_SWEEP_INTERVAL_MS = 1_000;
/** Past this many end markers a sweep runs regardless of the window. */
export const AGENT_TYPING_ENDED_MARKER_SOFT_CAP = 4_096;

type PendingStart = { token: symbol; agentId: string; machineId: string; target: string };

export class AgentTypingRegistry {
  private readonly entries = new Map<string, TypingEntry>();
  /** Calls that ended; a late or reordered `start` for one must not reopen its line. */
  private readonly ended = new Map<string, number>();
  /** The latest in-flight `start` per call; an older one finishing later yields. */
  private readonly pending = new Map<string, PendingStart>();
  private lastSweepAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly deps: AgentTypingDeps) {}

  async handle(agent: AgentTypingAgent, frame: ValidAgentSendIntent): Promise<AgentSendIntentOutcome> {
    const key = entryKey(agent.id, frame.callId);

    if (frame.phase === "end") {
      const entry = this.entries.get(key);
      // Nothing live or resolving for this call: no line to close and no
      // start that could still land, so no marker either.
      if (!entry && !this.pending.has(key)) return "unknown_call";
      const now = this.deps.now();
      this.maybeSweep(now);
      this.pending.delete(key);
      this.ended.set(key, now + AGENT_TYPING_TTL_MS);
      if (!entry) return "unknown_call";
      this.entries.delete(key);
      this.emitEntry(entry, "end", now);
      return "emitted_end";
    }

    const now = this.deps.now();
    this.maybeSweep(now);
    if (this.isEnded(key, now)) return "ended_call";
    const target = frame.target!;
    const token = Symbol(key);
    this.pending.set(key, { token, agentId: agent.id, machineId: agent.machineId, target });
    try {
      const existing = this.entries.get(key);
      // A refresh of the same call and target keeps its resolution: the
      // daemon re-sends `start` every few seconds while the body streams.
      // Post permission is NOT re-checked here: an agent removed from the
      // conversation mid-call keeps its line until the call ends, at most
      // the daemon's 2-minute send-intent cap (accepted in review: the line
      // carries no content, and the send itself is still checked).
      if (existing && existing.target === target && existing.machineId === agent.machineId) {
        existing.expiresAt = this.deps.now() + AGENT_TYPING_TTL_MS;
        this.emitEntry(existing, "start", this.deps.now());
        return "refreshed";
      }
      if (!existing && this.countForAgent(agent.id) >= AGENT_TYPING_MAX_CALLS_PER_AGENT) return "too_many_calls";
      const preview = await this.deps.previewTarget(agent.serverId, agent.id, target);
      if (this.pending.get(key)?.token !== token || this.isEnded(key, this.deps.now())) return "superseded";
      const previous = this.entries.get(key);
      if (previous) {
        this.entries.delete(key);
        this.emitEntry(previous, "end", this.deps.now());
      }
      if (!preview) return "unresolved_target";
      const entry: TypingEntry = {
        agentId: agent.id,
        machineId: agent.machineId,
        callId: frame.callId,
        serverId: agent.serverId,
        channelId: preview.channelId,
        parentMessageId: preview.parentMessageId,
        ...(preview.taskId ? { taskId: preview.taskId } : {}),
        target,
        expiresAt: this.deps.now() + AGENT_TYPING_TTL_MS,
      };
      this.entries.set(key, entry);
      this.emitEntry(entry, "start", this.deps.now());
      return "emitted_start";
    } finally {
      if (this.pending.get(key)?.token === token) this.pending.delete(key);
    }
  }

  /** The agent stopped or was deleted: close its lines. */
  endForAgent(agentId: string): number {
    return this.endWhere((agent) => agent.agentId === agentId);
  }

  /** The Computer disconnected: close the lines of every agent it ran. */
  endForMachine(machineId: string): number {
    return this.endWhere((agent) => agent.machineId === machineId);
  }

  /**
   * The agent's message landed in `conversation`: it is no longer about to
   * post there. Closes the agent's lines into that conversation (a thread is
   * matched by its root message, wherever the parent channel is) and marks
   * their calls ended, so the refreshes the daemon keeps sending while the
   * rest of the command runs (`send … && raft task update …`) are ignored.
   * A start for the same `target` that is still resolving is marked ended
   * too. Returns the lines closed.
   */
  endForPostedMessage(agentId: string, conversation: AgentPostedConversation, target?: string): number {
    if (this.entries.size === 0 && this.pending.size === 0) return 0;
    const now = this.deps.now();
    let closed = 0;
    for (const [key, entry] of this.entries) {
      if (entry.agentId !== agentId) continue;
      const sameConversation = conversation.parentMessageId !== null
        ? entry.parentMessageId === conversation.parentMessageId
        : entry.parentMessageId === null && entry.channelId === conversation.channelId;
      if (!sameConversation) continue;
      this.entries.delete(key);
      this.pending.delete(key);
      this.ended.set(key, now + AGENT_TYPING_TTL_MS);
      if (entry.expiresAt > now) {
        this.emitEntry(entry, "end", now);
        closed += 1;
      }
    }
    if (target !== undefined) {
      for (const [key, pending] of this.pending) {
        if (pending.agentId !== agentId || pending.target !== target) continue;
        this.pending.delete(key);
        this.ended.set(key, now + AGENT_TYPING_TTL_MS);
      }
    }
    return closed;
  }

  /** Drop expired lines (clients expire them on their own) and stale end markers. */
  sweep(now: number = this.deps.now()): void {
    this.lastSweepAt = now;
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
    for (const [key, until] of this.ended) {
      if (until <= now) this.ended.delete(key);
    }
  }

  /** Test/diagnostic view. */
  size(): number {
    return this.entries.size;
  }

  /** Test/diagnostic view: end markers held. */
  endedMarkerCount(): number {
    return this.ended.size;
  }

  private maybeSweep(now: number): void {
    if (now - this.lastSweepAt >= AGENT_TYPING_SWEEP_INTERVAL_MS || this.ended.size > AGENT_TYPING_ENDED_MARKER_SOFT_CAP) {
      this.sweep(now);
    }
  }

  /** Markers are swept at most once per interval, so an expired one may still be held. */
  private isEnded(key: string, now: number): boolean {
    const until = this.ended.get(key);
    return until !== undefined && until > now;
  }

  private endWhere(match: (agent: { agentId: string; machineId: string }) => boolean): number {
    const now = this.deps.now();
    let ended = 0;
    for (const [key, entry] of this.entries) {
      if (!match(entry)) continue;
      this.entries.delete(key);
      this.pending.delete(key);
      this.ended.set(key, now + AGENT_TYPING_TTL_MS);
      if (entry.expiresAt > now) {
        this.emitEntry(entry, "end", now);
        ended += 1;
      }
    }
    // A start still resolving would otherwise land after the stop/disconnect.
    for (const [key, pending] of this.pending) {
      if (!match(pending)) continue;
      this.pending.delete(key);
      this.ended.set(key, now + AGENT_TYPING_TTL_MS);
    }
    return ended;
  }

  private countForAgent(agentId: string): number {
    let count = 0;
    for (const entry of this.entries.values()) if (entry.agentId === agentId) count += 1;
    return count;
  }

  private emitEntry(entry: TypingEntry, state: "start" | "end", now: number): void {
    const payload: AgentTypingEvent = {
      agentId: entry.agentId,
      serverId: entry.serverId,
      channelId: entry.channelId,
      parentMessageId: entry.parentMessageId,
      ...(entry.taskId ? { taskId: entry.taskId } : {}),
      callId: entry.callId,
      state,
      expiresAt: state === "start" ? entry.expiresAt : now,
    };
    this.deps.emit(`channel:${entry.channelId}`, AGENT_TYPING_SOCKET_EVENT, payload);
  }
}
