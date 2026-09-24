import type { AgentConfig, AgentMessage } from "@botiverse/raft-shared";

export type AgentStartQueueItem = {
  agentId: string;
  startDispatchId?: string;
  enqueuedAtMs: number;
  config: AgentConfig;
  wakeMessage?: AgentMessage;
  wakeMessageTransient?: boolean;
  resumeMessages?: AgentMessage[];
  unreadSummary?: Record<string, number>;
  resumePrompt?: string;
  launchId?: string;
  resolve: () => void;
  reject: (err: unknown) => void;
};

export type PendingStartRebind = Omit<
  AgentStartQueueItem,
  "agentId" | "resolve" | "reject" | "enqueuedAtMs"
> & {
  stopEpochAtRebind?: number;
};

export type AgentStartCoordinatorSnapshot = {
  activeStarts: number;
  queueDepth: number;
  maxConcurrentStarts: number;
  minStartIntervalMs: number;
  startingAgentIds: string[];
  queuedAgentIds: string[];
  pumpTimerActive: boolean;
};

export type AgentStartPumpState =
  | { kind: "blocked"; reason: "timer_active" | "queue_empty" | "capacity_full" }
  | { kind: "rate_limited"; item: AgentStartQueueItem; waitMs: number }
  | { kind: "ready"; item: AgentStartQueueItem };

export type AgentStartDequeueResult =
  | { kind: "empty" }
  | { kind: "stale"; item: AgentStartQueueItem }
  | { kind: "item"; item: AgentStartQueueItem };

export class AgentStartCoordinator {
  private readonly starting = new Set<string>();
  private readonly queuedByAgent = new Map<string, AgentStartQueueItem>();
  private queue: AgentStartQueueItem[] = [];
  private activeStarts = 0;
  private pumpTimer: ReturnType<typeof setTimeout> | null = null;
  private lastStartAt = 0;
  private lastStartAgentId: string | null = null;
  private maxConcurrentStarts: number;
  private minStartIntervalMs: number;

  constructor(opts: { maxConcurrentStarts: number; minStartIntervalMs: number }) {
    this.maxConcurrentStarts = Math.max(1, Math.floor(opts.maxConcurrentStarts));
    this.minStartIntervalMs = Math.max(0, Math.floor(opts.minStartIntervalMs));
    this.assertInvariants("constructor");
  }

  snapshot(): AgentStartCoordinatorSnapshot {
    return {
      activeStarts: this.activeStarts,
      queueDepth: this.queue.length,
      maxConcurrentStarts: this.maxConcurrentStarts,
      minStartIntervalMs: this.minStartIntervalMs,
      startingAgentIds: [...this.starting],
      queuedAgentIds: [...this.queuedByAgent.keys()],
      pumpTimerActive: this.pumpTimer !== null,
    };
  }

  hasStarting(agentId: string): boolean {
    return this.starting.has(agentId);
  }

  hasQueued(agentId: string): boolean {
    return this.queuedByAgent.has(agentId);
  }

  getQueued(agentId: string): AgentStartQueueItem | undefined {
    return this.queuedByAgent.get(agentId);
  }

  queueAgeMs(agentId: string, now: number): number {
    const item = this.queuedByAgent.get(agentId);
    return item ? Math.max(0, now - item.enqueuedAtMs) : 0;
  }

  enqueue(item: AgentStartQueueItem): void {
    if (this.starting.has(item.agentId)) {
      throw new Error(`Agent start invariant violation after enqueue: ${item.agentId} is already starting`);
    }
    if (this.queuedByAgent.has(item.agentId)) {
      throw new Error(`Agent start invariant violation after enqueue: ${item.agentId} is already queued`);
    }
    this.queue.push(item);
    this.queuedByAgent.set(item.agentId, item);
    this.assertInvariants("enqueue");
  }

  markStarting(agentId: string): void {
    if (this.queuedByAgent.has(agentId)) {
      throw new Error(`Agent start invariant violation after markStarting: ${agentId} is still queued`);
    }
    this.starting.add(agentId);
    this.assertInvariants("markStarting");
  }

  clearStarting(agentId: string): void {
    this.starting.delete(agentId);
    this.assertInvariants("clearStarting");
  }

  getPumpState(now = Date.now()): AgentStartPumpState {
    if (this.pumpTimer) return { kind: "blocked", reason: "timer_active" };
    if (this.queue.length === 0) return { kind: "blocked", reason: "queue_empty" };
    if (this.activeStarts >= this.maxConcurrentStarts) return { kind: "blocked", reason: "capacity_full" };

    const item = this.queue[0];
    if (!item) return { kind: "blocked", reason: "queue_empty" };

    const shouldRateLimit = item.agentId !== this.lastStartAgentId;
    const elapsed = now - this.lastStartAt;
    const waitMs = shouldRateLimit ? Math.max(0, this.minStartIntervalMs - elapsed) : 0;
    if (waitMs > 0) return { kind: "rate_limited", item, waitMs };
    return { kind: "ready", item };
  }

  schedulePump(waitMs: number, callback: () => void): void {
    if (this.pumpTimer) return;
    this.pumpTimer = setTimeout(() => {
      this.pumpTimer = null;
      callback();
    }, waitMs);
    this.assertInvariants("schedulePump");
  }

  dequeue(): AgentStartDequeueResult {
    const item = this.queue.shift();
    if (!item) {
      this.assertInvariants("dequeue empty");
      return { kind: "empty" };
    }

    if (this.queuedByAgent.get(item.agentId) !== item) {
      this.assertInvariants("dequeue stale");
      return { kind: "stale", item };
    }

    this.queuedByAgent.delete(item.agentId);
    this.assertInvariants("dequeue");
    return { kind: "item", item };
  }

  claimStartSlot(agentId: string, now = Date.now()): void {
    this.activeStarts++;
    this.lastStartAt = now;
    this.lastStartAgentId = agentId;
    this.assertInvariants("claimStartSlot");
  }

  releaseStartSlot(): boolean {
    if (this.activeStarts <= 0) return false;
    this.activeStarts = Math.max(0, this.activeStarts - 1);
    this.assertInvariants("releaseStartSlot");
    return true;
  }

  cancelQueued(agentId: string): AgentStartQueueItem | undefined {
    const item = this.queuedByAgent.get(agentId);
    if (!item) return undefined;

    this.queuedByAgent.delete(agentId);
    this.queue = this.queue.filter((candidate) => candidate !== item);
    this.clearPumpTimerIfIdle();
    this.assertInvariants("cancelQueued");
    return item;
  }

  cancelAllQueued(onCancel?: (item: AgentStartQueueItem) => void): AgentStartQueueItem[] {
    const items: AgentStartQueueItem[] = [];
    for (const item of this.queue) {
      if (this.queuedByAgent.get(item.agentId) === item) {
        items.push(item);
        onCancel?.(item);
      }
    }
    this.queue = [];
    this.queuedByAgent.clear();
    this.clearPumpTimer();
    this.assertInvariants("cancelAllQueued");
    return items;
  }

  assertInvariants(context: string): void {
    if (this.activeStarts < 0) {
      throw new Error(`Agent start invariant violation after ${context}: activeStarts is negative`);
    }
    if (this.activeStarts > this.maxConcurrentStarts) {
      throw new Error(`Agent start invariant violation after ${context}: activeStarts exceeds maxConcurrentStarts`);
    }

    const queuedIds = new Set<string>();
    for (const item of this.queue) {
      if (queuedIds.has(item.agentId)) {
        throw new Error(`Agent start invariant violation after ${context}: duplicate queued agent ${item.agentId}`);
      }
      queuedIds.add(item.agentId);
      if (this.queuedByAgent.get(item.agentId) !== item) {
        throw new Error(`Agent start invariant violation after ${context}: queue/map mismatch for ${item.agentId}`);
      }
      if (this.starting.has(item.agentId)) {
        throw new Error(`Agent start invariant violation after ${context}: ${item.agentId} is queued and starting`);
      }
    }

    if (queuedIds.size !== this.queuedByAgent.size) {
      throw new Error(`Agent start invariant violation after ${context}: queue/map size mismatch`);
    }
    for (const [agentId, item] of this.queuedByAgent) {
      if (!queuedIds.has(agentId)) {
        throw new Error(`Agent start invariant violation after ${context}: map-only queued agent ${agentId}`);
      }
      if (item.agentId !== agentId) {
        throw new Error(`Agent start invariant violation after ${context}: map key/item agent mismatch for ${agentId}`);
      }
    }
  }

  setMaxConcurrentStartsForTesting(value: number): void {
    this.maxConcurrentStarts = Math.max(1, Math.floor(value));
    if (this.activeStarts > this.maxConcurrentStarts) {
      this.activeStarts = this.maxConcurrentStarts;
    }
    this.assertInvariants("setMaxConcurrentStartsForTesting");
  }

  setActiveStartsForTesting(value: number): void {
    this.activeStarts = Math.max(0, Math.floor(value));
    this.assertInvariants("setActiveStartsForTesting");
  }

  private clearPumpTimerIfIdle(): void {
    if (this.queue.length === 0) {
      this.clearPumpTimer();
    }
  }

  private clearPumpTimer(): void {
    if (this.pumpTimer) {
      clearTimeout(this.pumpTimer);
      this.pumpTimer = null;
    }
  }
}
