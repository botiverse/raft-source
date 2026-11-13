import type { AgentConfig } from "@botiverse/raft-shared";

/** A pushed config held until the agent's process (or OAR start) registers. */
export interface HeldConfigPush {
  config: AgentConfig;
  revision: number;
}

/**
 * Reconciler step 11 (Tenny's decision 2): the order of the configs the
 * server sends an agent. Every `agent:config` carries a `revision` that grows
 * with each config the server sends the agent, and an `agent:start` may carry
 * its config's (`configRevision`). Frames can arrive out of order (a replica
 * hand-off, a reconnect), so a pushed config at or below the last one this
 * daemon applied is dropped.
 *
 * The latest push is held here for whichever host registers the agent next
 * (`takeHeldPush`): one that arrived before the process registered (a start
 * queued, spawning, minting its credential or waiting in the host router), or
 * one a live process took before a start older than it arrived. It is
 * applied only if it is newer than the start that host runs; when that start
 * names no revision, nothing says which is newer, so the held push is
 * dropped (the conservative choice: the start's config is the server's at
 * dispatch). A stop forgets it.
 *
 * The one rule, for rebinds and registrations alike: a config never replaces
 * a newer one. A start older than the applied revision rebinds its launch,
 * session and wake but keeps the running config; at an equal revision the
 * start's config is taken (the same config), so a held push of that revision
 * is dropped.
 *
 * In memory only, one per daemon, shared by both hosts. A restarted daemon
 * accepts the first push it sees.
 */
export class AgentConfigRevisions {
  /** The highest revision applied per agent (pushes and starts). */
  private readonly applied = new Map<string, number>();
  /** The revision of the agent's latest start (null: it named none). */
  private readonly lastStart = new Map<string, number | null>();
  private readonly held = new Map<string, HeldConfigPush>();

  /** Start configs older than a config already applied (`noteStart`): they never replace it. */
  private readonly staleStarts = new WeakSet<AgentConfig>();

  /**
   * An `agent:start` handed to a host, with the config object it hands over.
   * One whose revision is older than a config already applied is a stale
   * start: it still starts or rebinds the agent (launch, session, wake), but
   * its config replaces nothing (`isStaleStart`), and it is not the start a
   * held push is compared with. A start with no revision (an older server)
   * or an equal one is taken as today: its config is the server's.
   */
  noteStart(agentId: string, configRevision: number | undefined, config?: AgentConfig): void {
    const revision = validRevision(configRevision);
    const current = this.applied.get(agentId);
    if (revision !== null && current !== undefined && revision < current) {
      if (config) this.staleStarts.add(config);
      return;
    }
    this.lastStart.set(agentId, revision);
    if (revision !== null && (current === undefined || revision > current)) this.applied.set(agentId, revision);
  }

  /** Whether this start config is older than a config already applied: the running config stays. */
  isStaleStart(config: AgentConfig): boolean {
    return this.staleStarts.has(config);
  }

  /** A host copied a start's config (adding or dropping a credential): the copy keeps its mark. */
  carryStaleMark(from: AgentConfig, to: AgentConfig): void {
    if (this.staleStarts.has(from)) this.staleStarts.add(to);
  }

  /** Whether a pushed config is newer than every config applied so far; if so it now is the latest. */
  acceptPush(agentId: string, revision: number): boolean {
    if (validRevision(revision) === null) return false;
    const current = this.applied.get(agentId);
    if (current !== undefined && revision <= current) return false;
    this.applied.set(agentId, revision);
    return true;
  }

  /** The highest revision applied for the agent, if any. */
  current(agentId: string): number | undefined {
    return this.applied.get(agentId);
  }

  /**
   * The latest push for the agent, kept for the next registration on either
   * host (also after a live process took it: a start older than it may still
   * register a new process). The newest one wins (pushes arrive ordered by
   * `acceptPush`).
   */
  holdPush(agentId: string, push: HeldConfigPush): void {
    this.held.set(agentId, push);
  }

  /**
   * At registration: the held push, with whether it applies (newer than the
   * agent's latest start). Taken either way: it is decided once.
   */
  takeHeldPush(agentId: string): { push: HeldConfigPush; applies: boolean } | null {
    const push = this.held.get(agentId);
    if (!push) return null;
    this.held.delete(agentId);
    return { push, applies: this.heldPushApplies(agentId, push.revision) };
  }

  /** An explicit stop. */
  forgetHeldPush(agentId: string): void {
    this.held.delete(agentId);
  }

  /** Whether a push held until registration is newer than the agent's latest start. */
  heldPushApplies(agentId: string, revision: number): boolean {
    const start = this.lastStart.get(agentId);
    // No start seen (a test, or the push raced every start): nothing newer is known.
    if (start === undefined) return true;
    if (start === null) return false;
    return revision > start;
  }
}

function validRevision(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
