/**
 * Agent typing line (packages/shared/src/agentTyping.ts), daemon side: the
 * life of each `agent:send_intent` the daemon sends.
 *
 * A send intent starts when a driver finds a `raft message send` target in a
 * main-agent shell call's streaming arguments (`early`), or, for a runtime
 * that only reports the finished call, when the complete `tool_call` arrives.
 * While live it re-sends `start` every AGENT_SEND_INTENT_REFRESH_MS. It ends
 * (one `end` frame) when that call's tool output arrives, or on turn end,
 * interrupt, stop or process exit. Frames go only to a server that
 * advertised SERVER_CAPABILITY_AGENT_SEND_INTENT_V1.
 */
import {
  AGENT_SEND_INTENT_REFRESH_MS,
  findRaftSendTarget,
  resolveToolSemantic,
  type AgentSendIntentFrame,
} from "@botiverse/raft-shared";

/** Live intents per agent; more at once (parallel sends) are dropped. */
const MAX_LIVE_INTENTS_PER_AGENT = 4;
/** A call that never reports output stops refreshing after this long. */
const MAX_INTENT_LIFETIME_MS = 2 * 60_000;
/** Call ids already announced per agent, so a later complete call is not announced twice. */
const MAX_SEEN_CALL_IDS = 64;

type Timer = ReturnType<typeof setInterval>;

export interface AgentSendIntentTrackerOptions {
  send: (frame: AgentSendIntentFrame) => void;
  now?: () => number;
  setInterval?: (fn: () => void, ms: number) => Timer;
  clearInterval?: (timer: Timer) => void;
  refreshMs?: number;
  maxLifetimeMs?: number;
}

interface LiveIntent {
  callId: string;
  target: string;
  early: boolean;
  launchId?: string;
  startedAtMs: number;
  timer: Timer;
}

interface AgentLane {
  /** In start order (Map iteration order), so "oldest" is the first entry. */
  live: Map<string, LiveIntent>;
  seen: Set<string>;
}

export class AgentSendIntentTracker {
  private capable = false;
  private readonly lanes = new Map<string, AgentLane>();
  private mintedSeq = 0;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => Timer;
  private readonly clearTimer: (timer: Timer) => void;
  private readonly refreshMs: number;
  private readonly maxLifetimeMs: number;

  constructor(private readonly options: AgentSendIntentTrackerOptions) {
    this.now = options.now ?? Date.now;
    this.setTimer = options.setInterval ?? ((fn, ms) => {
      const timer = setInterval(fn, ms);
      timer.unref?.();
      return timer;
    });
    this.clearTimer = options.clearInterval ?? ((timer) => clearInterval(timer));
    this.refreshMs = options.refreshMs ?? AGENT_SEND_INTENT_REFRESH_MS;
    this.maxLifetimeMs = options.maxLifetimeMs ?? MAX_INTENT_LIFETIME_MS;
  }

  /**
   * From `machine:context` (and false on disconnect). Turning it off drops
   * every live intent without `end` frames: there is no server to tell, and
   * the server's typing TTL clears what it showed.
   */
  setCapable(capable: boolean): void {
    this.capable = capable;
    if (capable) return;
    for (const lane of this.lanes.values()) {
      for (const intent of lane.live.values()) this.clearTimer(intent.timer);
    }
    this.lanes.clear();
  }

  /** A driver found the target (`send_intent` event). */
  start(agentId: string, intent: { callId: string; target: string; early: boolean; launchId?: string }): void {
    this.begin(agentId, intent);
  }

  /**
   * A complete tool call (late fallback): announces a `raft message send`
   * the driver did not already announce while it streamed.
   */
  noteToolCall(agentId: string, call: { callId?: string; name: string; input: unknown; launchId?: string }): void {
    if (!this.capable) return;
    if (call.callId && this.lanes.get(agentId)?.seen.has(call.callId)) return;
    const target = sendTargetOfCompleteCall(call.name, call.input);
    if (!target) return;
    // A runtime without call ids gets a daemon-minted one; its output (also
    // without an id) ends the oldest live intent.
    const callId = call.callId || `daemon-send-${++this.mintedSeq}`;
    this.begin(agentId, { callId, target, early: false, launchId: call.launchId });
  }

  /**
   * A tool's output: ends that call's intent. Without a call id (runtimes
   * that report none) the oldest live intent ends.
   */
  noteToolOutput(agentId: string, callId: string | undefined): void {
    const lane = this.lanes.get(agentId);
    if (!lane || lane.live.size === 0) return;
    if (callId) {
      if (lane.live.has(callId)) this.end(agentId, lane, callId);
      return;
    }
    const oldest = lane.live.keys().next().value;
    if (oldest !== undefined) this.end(agentId, lane, oldest);
  }

  /** Turn end, interrupt, stop, process exit: end every live intent of the agent. */
  endAll(agentId: string): void {
    const lane = this.lanes.get(agentId);
    if (!lane) return;
    for (const callId of [...lane.live.keys()]) this.end(agentId, lane, callId);
  }

  liveCount(agentId: string): number {
    return this.lanes.get(agentId)?.live.size ?? 0;
  }

  private begin(
    agentId: string,
    intent: { callId: string; target: string; early: boolean; launchId?: string },
  ): void {
    if (!this.capable || !intent.callId || !intent.target) return;
    let lane = this.lanes.get(agentId);
    if (!lane) {
      lane = { live: new Map(), seen: new Set() };
      this.lanes.set(agentId, lane);
    }
    if (lane.seen.has(intent.callId)) return;
    lane.seen.add(intent.callId);
    if (lane.seen.size > MAX_SEEN_CALL_IDS) {
      const oldest = lane.seen.values().next().value;
      if (oldest !== undefined) lane.seen.delete(oldest);
    }
    if (lane.live.size >= MAX_LIVE_INTENTS_PER_AGENT) return;

    const boundLane = lane;
    const live: LiveIntent = {
      callId: intent.callId,
      target: intent.target,
      early: intent.early,
      ...(intent.launchId ? { launchId: intent.launchId } : {}),
      startedAtMs: this.now(),
      timer: this.setTimer(() => this.refresh(agentId, boundLane, intent.callId), this.refreshMs),
    };
    lane.live.set(intent.callId, live);
    this.sendFrame(agentId, live, "start");
  }

  private refresh(agentId: string, lane: AgentLane, callId: string): void {
    const live = lane.live.get(callId);
    if (!live || this.lanes.get(agentId) !== lane) return;
    if (this.now() - live.startedAtMs >= this.maxLifetimeMs) {
      this.end(agentId, lane, callId);
      return;
    }
    this.sendFrame(agentId, live, "start");
  }

  private end(agentId: string, lane: AgentLane, callId: string): void {
    const live = lane.live.get(callId);
    if (!live) return;
    lane.live.delete(callId);
    this.clearTimer(live.timer);
    this.sendFrame(agentId, live, "end");
  }

  private sendFrame(agentId: string, live: LiveIntent, phase: "start" | "end"): void {
    if (!this.capable) return;
    const frame: AgentSendIntentFrame = {
      type: "agent:send_intent",
      agentId,
      ...(live.launchId ? { launchId: live.launchId } : {}),
      callId: live.callId,
      phase,
      ...(phase === "start" ? { target: live.target, early: live.early } : {}),
    };
    try {
      this.options.send(frame);
    } catch {
      // A display hint must never break event handling.
    }
  }
}

/** The send target of a complete tool call: a shell `raft message send`, or a chat `send_message` tool. */
export function sendTargetOfCompleteCall(toolName: string, input: unknown): string | null {
  const semantic = resolveToolSemantic(toolName);
  const value = input && typeof input === "object" ? input as { command?: unknown; target?: unknown } : null;
  if (!value) return null;
  if (semantic === "bash") {
    return typeof value.command === "string" ? findRaftSendTarget(value.command, { partial: false }) : null;
  }
  if (semantic === "send_message") {
    return typeof value.target === "string" && value.target.trim() ? value.target.trim() : null;
  }
  return null;
}
