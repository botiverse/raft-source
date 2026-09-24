import type { AgentMessage } from "@botiverse/raft-shared";

export type AgentStartPendingDeliveryAllowedSnapshot = {
  queuedAgentIds: readonly string[];
  startingAgentIds: readonly string[];
  terminalRecoveryAgentIds?: readonly string[];
  cooldownAgentIds?: readonly string[];
};

/**
 * Owns messages accepted while an agent is between "wake accepted" and
 * "runtime can receive input".
 *
 * Invariant I1 (membership, point-in-time): every pending key must belong to the
 * current start-state snapshot: queued, starting, terminal recovery, or spawn
 * cooldown. Once an agent leaves those states, any remaining key is orphaned
 * pending delivery.
 *
 * Invariant I2 (exactly-once, temporal): during one start cycle, a buffered wake
 * must be delivered once: rebind appends the previous wake instead of replacing
 * the existing pending set, spawn drains and clears, and consume suppression
 * removes already-visible messages from this buffer.
 *
 * The owner deliberately exposes only counts, immutable snapshots, and
 * transition verbs so callers cannot mutate the internal arrays and bypass I1/I2.
 */
export class AgentStartPendingDeliveryBuffer {
  private readonly pending = new Map<string, AgentMessage[]>();

  count(agentId: string): number {
    return this.pending.get(agentId)?.length ?? 0;
  }

  has(agentId: string): boolean {
    return this.pending.has(agentId);
  }

  get size(): number {
    return this.pending.size;
  }

  agentIds(): string[] {
    return [...this.pending.keys()];
  }

  values(agentId: string): AgentMessage[] {
    return [...(this.pending.get(agentId) ?? [])];
  }

  bufferDuringStart(agentId: string, message: AgentMessage): number {
    return this.append(agentId, [message], "bufferDuringStart");
  }

  bufferMessagesDuringStart(agentId: string, messages: readonly AgentMessage[]): number {
    return this.append(agentId, messages, "bufferMessagesDuringStart");
  }

  rebindWake(
    agentId: string,
    previousWakeMessage: AgentMessage | undefined,
    nextWakeMessage: AgentMessage | undefined,
    sameWakeMessage: (left: AgentMessage, right: AgentMessage) => boolean,
  ): number {
    if (!previousWakeMessage || !nextWakeMessage || sameWakeMessage(previousWakeMessage, nextWakeMessage)) {
      return this.count(agentId);
    }
    return this.append(agentId, [previousWakeMessage], "rebindWake");
  }

  drainOnSpawn(agentId: string): AgentMessage[] {
    const messages = this.pending.get(agentId) ?? [];
    this.pending.delete(agentId);
    this.assertInternalInvariants("drainOnSpawn");
    return messages;
  }

  cancelStart(agentId: string): void {
    this.pending.delete(agentId);
    this.assertInternalInvariants("cancelStart");
  }

  cancelAllStarts(): void {
    this.pending.clear();
    this.assertInternalInvariants("cancelAllStarts");
  }

  suppressConsumed(agentId: string, predicate: (message: AgentMessage) => boolean): number {
    const messages = this.pending.get(agentId);
    if (!messages || messages.length === 0) return 0;

    let removed = 0;
    const retained = messages.filter((message) => {
      const matched = predicate(message);
      if (matched) removed += 1;
      return !matched;
    });
    if (retained.length === 0) {
      this.pending.delete(agentId);
    } else {
      this.pending.set(agentId, retained);
    }
    this.assertInternalInvariants("suppressConsumed");
    return removed;
  }

  purge(agentId: string, predicate: (message: AgentMessage) => boolean): number {
    return this.suppressConsumed(agentId, predicate);
  }

  assertInvariants(context: string, snapshot: AgentStartPendingDeliveryAllowedSnapshot): void {
    this.assertInternalInvariants(context);

    // I1: point-in-time membership.
    const allowed = new Set<string>([
      ...snapshot.queuedAgentIds,
      ...snapshot.startingAgentIds,
      ...(snapshot.terminalRecoveryAgentIds ?? []),
      ...(snapshot.cooldownAgentIds ?? []),
    ]);
    for (const agentId of this.pending.keys()) {
      if (!allowed.has(agentId)) {
        throw new Error(`Agent start pending delivery invariant violation after ${context}: pending messages for non-starting agent ${agentId}`);
      }
    }
  }

  private append(agentId: string, messages: readonly AgentMessage[], context: string): number {
    if (messages.length === 0) return this.count(agentId);
    const existing = this.pending.get(agentId);
    if (existing) {
      existing.push(...messages);
    } else {
      this.pending.set(agentId, [...messages]);
    }
    this.assertInternalInvariants(context);
    return this.count(agentId);
  }

  private assertInternalInvariants(context: string): void {
    for (const [agentId, messages] of this.pending) {
      if (!agentId) {
        throw new Error(`Agent start pending delivery invariant violation after ${context}: empty agent id`);
      }
      if (messages.length === 0) {
        throw new Error(`Agent start pending delivery invariant violation after ${context}: empty pending buffer for ${agentId}`);
      }
    }
  }
}
