import { agentApiHistoryConsumptionScopeSchema, formatAgentMessageTaskRef, thirdPartyEventShortId, type AgentApiHistoryConsumptionScope, type AgentMessage } from "@botiverse/raft-shared";
import type { AgentProxyVisibleMessage } from "./agentCredentialProxy";

export type AgentVisibleDeliveryConsumeSource =
  | "spawn_wake_message"
  | "agent_api_events_local"
  | "agent_api_events_server"
  | "agent_api_history"
  | "agent_api_inbox_read"
  | "agent_api_send_commit"
  | "server_held_context"
  | "side_effect_preflight_context"
  | "spawn_starting_inbox_update"
  | "thread_join_context_rendered"
  | "thread_join_context_rendered_truncated"
  | "verified_contiguous_content_consumption"
  | string;

type VisibleBucket = {
  maxSeq: number;
  boundarySeq: number;
  seqs: Set<number>;
  ids: Set<string>;
};

export type AgentVisibleDeliveryConsumption = {
  targets: string[];
  messagesCount: number;
  /**
   * Messages in this batch whose exact id the model had already been shown,
   * judged in the current context when one was given (a compaction resets
   * it), else process-wide. Telemetry only: tells a re-read that fills a gap from one
   * that prints already-delivered content again.
   */
  alreadySeenCount: number;
  shouldSuppress(message: AgentMessage): boolean;
};

type SeenMessage = { seq?: number; message_id?: string; id?: string };

/**
 * Model-seen facts as a freshness decision may use them: what the model has in
 * front of it now, as evidence for a send's `seenUpToSeq` / `seenExactSeqs`
 * and the task-claim preflight. Delivery suppression keeps using the
 * process-wide queries; this view only narrows what counts as evidence.
 */
export type AgentVisibleFreshnessView = {
  getBoundary(target: string): number | undefined;
  isModelSeen(target: string, message: SeenMessage): boolean;
  getExactSeenSeqs(target: string): number[];
};

/** Facts recorded while one RFC 072 context id was current. */
type ContextScope = {
  contextId: string;
  boundaries: Map<string, number>;
  ids: Map<string, Set<string>>;
  exactSeqs: Map<string, Set<number>>;
  /** Whole notice previews (recordWholePreviewSeen): freshness evidence only. */
  previews: PreviewFacts;
};

/**
 * Messages an inbox notice showed whole, per target. Only the freshness view
 * reads them: a reply is not held for such a message, but it is not consumed,
 * so delivery dedup and suppression (isModelSeen, getMessageIdSet) never see
 * them, it stays pending, and a redelivery is not dropped as consumed.
 */
type PreviewFacts = {
  ids: Map<string, Set<string>>;
  seqs: Map<string, Set<number>>;
};

function emptyPreviewFacts(): PreviewFacts {
  return { ids: new Map(), seqs: new Map() };
}

/**
 * Held task writes' spans (recordHeldWriteSpan), keyed by the landing and
 * the write's identity (`agentTaskWriteKey`), with the context they were
 * shown in. Read only for that write's own rerun (getHeldWriteSpan): never
 * by the freshness view, the send planner or delivery.
 */
type HeldWriteSpans = { contextId: string | null | undefined; spans: Map<string, number> };

function heldWriteSpanKey(target: string, writeKey: string): string {
  return `${canonicalVisibleTarget(target)}\u0000${writeKey}`;
}

function addPreviewFacts(facts: PreviewFacts, target: string, id: string, seq: number): void {
  if (id.length > 0) {
    let ids = facts.ids.get(target);
    if (!ids) {
      ids = new Set<string>();
      facts.ids.set(target, ids);
    }
    ids.add(id);
  }
  if (seq > 0) addCappedExactSeqs(facts.seqs, target, [seq]);
}

function unionSortedSeqs(...sets: Array<ReadonlySet<number> | undefined>): number[] {
  const all = new Set<number>();
  for (const set of sets) for (const seq of set ?? []) all.add(seq);
  return sortedSeqs(all);
}

const NO_FRESHNESS_EVIDENCE: AgentVisibleFreshnessView = {
  getBoundary: () => undefined,
  isModelSeen: () => false,
  getExactSeenSeqs: () => [],
};

function getMessageShortId(messageId: string): string {
  return messageId.startsWith("thread-") ? messageId.slice(7) : messageId.slice(0, 8);
}

// History accepts short or full event IDs, including uppercase hex. Keep the
// existing visible key, but validate a full address against the full event ID
// before collapsing it; two different UUIDs may share the same short prefix.
function eventIdFromTarget(target: string): string | undefined {
  return /^agent-event:([0-9a-f]{8}(?:-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?)$/i
    .exec(target)?.[1].toLowerCase();
}

function canonicalVisibleTarget(target: string): string {
  const eventId = eventIdFromTarget(target);
  return eventId ? `agent-event:${getMessageShortId(eventId)}` : target;
}

// Single source for the agent-visible target key (project-from-single-source, FM2
// discipline). Both pending-message suppression and visible-message consumption
// delegate here so the two sides cannot disagree on the key for the same message.
function computeTarget(
  channelType: string | undefined,
  channelName: string | undefined,
  parentChannelName: string | undefined,
  parentChannelType: string | undefined,
): string {
  if (channelType === "thread" && parentChannelName) {
    const shortId = getMessageShortId(String(channelName ?? ""));
    if (parentChannelType === "dm") {
      return `dm:@${parentChannelName}:${shortId}`;
    }
    return `#${parentChannelName}:${shortId}`;
  }
  if (channelType === "dm") {
    return `dm:@${channelName}`;
  }
  return `#${channelName}`;
}

/** True for a thread key from computeTarget (`#parent:short`, `dm:@peer:short`); task refs (`#ch:#7`) are not threads. */
export function isThreadVisibleTarget(target: string): boolean {
  const separator = target.startsWith("#") ? target.indexOf(":") : target.startsWith("dm:@") ? target.indexOf(":", 3) : -1;
  return separator > 0 && target[separator + 1] !== "#";
}

export function formatAgentMessageVisibleTarget(message: AgentMessage): string {
  return formatProxyVisibleMessageTarget(message);
}

export function formatProxyVisibleMessageTarget(message: AgentProxyVisibleMessage): string {
  // Third-party events retain synthetic DM metadata for transport, but their
  // visible scope is the event. Use the same key for consumption and suppression.
  if (message.third_party_event) {
    return `agent-event:${thirdPartyEventShortId(message.third_party_event)}`;
  }
  // Task v2: a message in a task's own conversation is addressed by the task
  // ref (`#channel:#7`), the same key `raft task read` reports as its target.
  const taskRef = formatAgentMessageTaskRef(message);
  if (taskRef) return taskRef;
  return computeTarget(message.channel_type, message.channel_name, message.parent_channel_name, message.parent_channel_type);
}

function hasTargetMetadata(message: AgentProxyVisibleMessage): boolean {
  if (message.third_party_event) return true;
  if (message.channel_type === "thread") return Boolean(message.parent_channel_name && message.channel_name);
  return Boolean(message.channel_type && message.channel_name);
}

function visibleMessageId(message: AgentProxyVisibleMessage | AgentMessage): string {
  if (typeof (message as AgentProxyVisibleMessage).message_id === "string") return String((message as AgentProxyVisibleMessage).message_id);
  if (typeof (message as AgentProxyVisibleMessage).id === "string") return String((message as AgentProxyVisibleMessage).id);
  return "";
}

function isSeenIn(boundary: number | undefined, ids: ReadonlySet<string> | undefined, message: SeenMessage): boolean {
  const seq = Number(message.seq ?? 0);
  if (Number.isFinite(seq) && seq > 0 && typeof boundary === "number" && boundary >= Math.floor(seq)) return true;
  const id = visibleMessageId(message);
  return id.length > 0 && ids?.has(id) === true;
}

function sortedSeqs(seqs: ReadonlySet<number> | undefined): number[] {
  return seqs ? [...seqs].sort((a, b) => a - b) : [];
}

function addCappedExactSeqs(map: Map<string, Set<number>>, target: string, seqs: Iterable<number>): void {
  let targetSeqs = map.get(target);
  if (!targetSeqs) {
    targetSeqs = new Set<number>();
    map.set(target, targetSeqs);
  }
  for (const seq of seqs) targetSeqs.add(seq);
  if (targetSeqs.size > MAX_EXACT_SEEN_SEQS_PER_TARGET) {
    const kept = [...targetSeqs].sort((a, b) => a - b).slice(-MAX_EXACT_SEEN_SEQS_PER_TARGET);
    map.set(target, new Set(kept));
  }
}

function canAdvanceBoundaryForTarget(source: string, target: string): boolean {
  // Model-seen boundary contract: daemon delivery/queue/wake signals prove
  // attention, not contiguous content consumption. A sparse high-seq mention
  // must never advance the high-water boundary and hide older unseen rows.
  if (source === "verified_contiguous_content_consumption") return true;
  if (source === "thread_join_context_rendered") {
    // A rendered thread-join package shows the parent/root message and recent
    // thread replies. The recent replies are contiguous only within the thread
    // target; the parent message is an exact visible row, not proof that the
    // parent channel prefix was consumed. A truncated package arrives as
    // `thread_join_context_rendered_truncated` instead and stays exact-id-only
    // (`threadJoinContextReceipts`).
    return target.includes(":");
  }
  return false;
}

/**
 * Owns the daemon's agent-visible delivery ledger.
 *
 * The ledger is the single boundary where APM turns "the model has seen this"
 * into durable process-local facts. It owns both forms of model-seen state:
 * target high-water boundaries for verified rendered/contiguous content
 * consumption, and exact message-id sets for weaker visibility sources such as
 * delivery signals, history/context reads, and self-authored commits. APM
 * should ask this component whether a message is model-seen; it should not
 * infer meaning from raw boundary/id maps or mutate those maps directly.
 *
 * Invariants:
 * - I1 boundary/id synchronization: only verified rendered/contiguous content
 *   consume sources may advance a target boundary, and boundary advancement is
 *   recorded alongside the exact message ids observed in the same target scope.
 *   Current daemon attention/delivery sources can add exact ids but must never
 *   advance a boundary.
 * - I2 visibility authorization: a visible message may enter the ledger only
 *   for the current authorized target projection. Explicit target mismatches
 *   are rejected before any state is written, keeping parent/thread/DM/channel
 *   scopes isolated.
 * - I3 consume/suppress contract: consume returns a suppression matcher for
 *   the just-consumed batch. APM applies that matcher to active inbox and
 *   start-pending buffers; the ledger does not reach out and mutate those
 *   external queues itself.
 * - No raw mutable state leak: callers get read-only boundary/id-set queries
 *   and must route every write through recordConsumed().
 */
/**
 * Cap on exact model-seen seqs kept per target (task #360). Matches the Server's
 * per-send cap on `seenExactSeqs`; the newest seqs are kept.
 */
export const MAX_EXACT_SEEN_SEQS_PER_TARGET = 2_500;

export class AgentVisibleDeliveryLedger {
  private readonly boundaryByAgent = new Map<string, Map<string, number>>();
  private readonly messageIdsByAgent = new Map<string, Map<string, Set<string>>>();
  private readonly exactSeqsByAgent = new Map<string, Map<string, Set<number>>>();
  private readonly contextScopeByAgent = new Map<string, ContextScope>();
  private readonly previewsByAgent = new Map<string, PreviewFacts>();
  private readonly heldWriteSpansByAgent = new Map<string, HeldWriteSpans>();

  clearAgent(agentId: string): void {
    this.heldWriteSpansByAgent.delete(agentId);
    this.boundaryByAgent.delete(agentId);
    this.messageIdsByAgent.delete(agentId);
    this.exactSeqsByAgent.delete(agentId);
    this.contextScopeByAgent.delete(agentId);
    this.previewsByAgent.delete(agentId);
  }

  /**
   * Freshness evidence for `agentId` (glimpse G0). `context` is the RFC 072
   * context signal the CLI honours (present when the launch has passive AX
   * on), so the daemon and the CLI scope evidence identically. With a signal,
   * only facts recorded under its id count — none when the id is unknown — so
   * after a compaction what the model saw before it no longer vouches for a
   * send or a claim. Without one, the facts stay process-wide, as before.
   * Delivery suppression never reads this view: those facts must outlive a
   * compaction.
   */
  freshnessView(agentId: string, context: { contextId: string | null } | undefined): AgentVisibleFreshnessView {
    if (!context) {
      const previews = this.previewsByAgent.get(agentId);
      return {
        getBoundary: (target) => this.getBoundary(agentId, target),
        isModelSeen: (target, message) => this.isModelSeen(agentId, target, message)
          || isSeenIn(undefined, previews?.ids.get(canonicalVisibleTarget(target)), message),
        getExactSeenSeqs: (target) => unionSortedSeqs(
          this.exactSeqsByAgent.get(agentId)?.get(canonicalVisibleTarget(target)),
          previews?.seqs.get(canonicalVisibleTarget(target)),
        ),
      };
    }
    const scope = this.contextScopeByAgent.get(agentId);
    if (!context.contextId || scope?.contextId !== context.contextId) return NO_FRESHNESS_EVIDENCE;
    return {
      getBoundary: (target) => scope.boundaries.get(canonicalVisibleTarget(target)),
      isModelSeen: (target, message) => {
        const key = canonicalVisibleTarget(target);
        return isSeenIn(scope.boundaries.get(key), scope.ids.get(key), message)
          || isSeenIn(undefined, scope.previews.ids.get(key), message);
      },
      getExactSeenSeqs: (target) => {
        const key = canonicalVisibleTarget(target);
        return unionSortedSeqs(scope.exactSeqs.get(key), scope.previews.seqs.get(key));
      },
    };
  }

  /**
   * Exact seqs this target's model has seen (task #360), ascending. They never
   * advance the boundary; the send preflight hands the ones above the boundary
   * to the Server as `seenExactSeqs`, which excludes exactly those rows from
   * the unread count without assuming the gaps were read.
   */
  getExactSeenSeqs(agentId: string, target: string): number[] {
    return sortedSeqs(this.exactSeqsByAgent.get(agentId)?.get(canonicalVisibleTarget(target)));
  }

  hasAgentState(agentId: string): boolean {
    return this.boundaryByAgent.has(agentId) || this.messageIdsByAgent.has(agentId);
  }

  getBoundary(agentId: string, target: string): number | undefined {
    return this.boundaryByAgent.get(agentId)?.get(canonicalVisibleTarget(target));
  }

  getMessageIdSet(agentId: string, target: string): Set<string> | undefined {
    return this.messageIdsByAgent.get(agentId)?.get(canonicalVisibleTarget(target));
  }

  isModelSeen(agentId: string, target: string, message: SeenMessage): boolean {
    return isSeenIn(this.getBoundary(agentId, target), this.getMessageIdSet(agentId, target), message);
  }

  /**
   * `contextId` is the RFC 072 context id current when the content reached the
   * model under passive AX (see freshnessView); without one the facts are
   * process-wide only.
   */
  recordConsumed(
    agentId: string,
    input: { historyScope?: AgentApiHistoryConsumptionScope; target?: string; messages: AgentProxyVisibleMessage[]; boundarySeq?: number; source: AgentVisibleDeliveryConsumeSource; contextId?: string | null },
  ): AgentVisibleDeliveryConsumption | null {
    if (input.messages.length === 0 && (!input.target || typeof input.boundarySeq !== "number")) return null;
    const explicitTarget = input.target ? canonicalVisibleTarget(input.target) : undefined;
    const explicitEventId = input.target ? eventIdFromTarget(input.target) : undefined;
    const scopeResult = agentApiHistoryConsumptionScopeSchema.safeParse(input.historyScope);
    const historyScope = input.source === "agent_api_history" && scopeResult.success
      && scopeResult.data.agent_id === agentId && scopeResult.data.target === input.target
      ? scopeResult.data : undefined;
    const legacyDmIds = new Set<string>();
    if (historyScope) {
      for (const message of input.messages) {
        // The scope alone is insufficient: each returned body must belong to
        // the authorized channel. No sequence-based fallback across targets.
        if (message.channel_id === historyScope.channel_id && visibleMessageId(message)) {
          legacyDmIds.add(visibleMessageId(message));
        }
      }
    }
    // Measured before any write below, so the batch never counts itself. Only
    // exact ids count: a boundary can cover rows that were never shown (a
    // truncated thread-join package still advances its thread boundary).
    const seenIdsBefore = this.exactSeenIds(agentId, input.contextId);
    let alreadySeenCount = 0;
    for (const message of input.messages) {
      const target = explicitTarget ?? formatProxyVisibleMessageTarget(message);
      const id = visibleMessageId(message);
      if (target && id.length > 0 && seenIdsBefore(target)?.has(id)) alreadySeenCount += 1;
    }
    const byTarget = new Map<string, VisibleBucket>();
    const ensureBucket = (target: string): VisibleBucket => {
      let bucket = byTarget.get(target);
      if (!bucket) {
        bucket = { maxSeq: 0, boundarySeq: 0, seqs: new Set<number>(), ids: new Set<string>() };
        byTarget.set(target, bucket);
      }
      return bucket;
    };

    for (const message of input.messages) {
      const messageTarget = formatProxyVisibleMessageTarget(message);
      const fullEventMismatch = explicitEventId?.length === 36
        && message.third_party_event?.id.toLowerCase() !== explicitEventId;
      if (input.target && hasTargetMetadata(message) && (messageTarget !== explicitTarget || fullEventMismatch)) {
        throw new Error(`AgentVisibleDeliveryLedger target mismatch: explicit target ${input.target} does not match visible message target ${messageTarget}`);
      }
      const target = explicitTarget ?? messageTarget;
      if (!target) continue;
      const bucket = ensureBucket(target);
      const seq = Number(message.seq ?? 0);
      if (Number.isFinite(seq) && seq > 0) {
        const normalizedSeq = Math.floor(seq);
        bucket.maxSeq = Math.max(bucket.maxSeq, normalizedSeq);
        bucket.seqs.add(normalizedSeq);
      }
      const id = visibleMessageId(message);
      if (id.length > 0) bucket.ids.add(id);
    }

    if (explicitTarget && typeof input.boundarySeq === "number" && Number.isFinite(input.boundarySeq) && input.boundarySeq > 0) {
      const bucket = ensureBucket(explicitTarget);
      bucket.boundarySeq = Math.max(bucket.boundarySeq, Math.floor(input.boundarySeq));
    }
    if (byTarget.size === 0) return null;

    const boundaryAdvancingTargets = new Set<string>();
    for (const [target, bucket] of byTarget) {
      const previousBoundary = this.getBoundary(agentId, target);
      const advancesBoundary = canAdvanceBoundaryForTarget(input.source, target);
      if (advancesBoundary) {
        boundaryAdvancingTargets.add(target);
        const highWaterSeq = Math.max(bucket.maxSeq, bucket.boundarySeq);
        const boundaryMap = this.boundaryMap(agentId);
        boundaryMap.set(target, Math.max(previousBoundary ?? 0, highWaterSeq));
      }
      if (bucket.ids.size > 0) {
        const targetIds = this.messageIdSet(agentId, target);
        for (const id of bucket.ids) targetIds.add(id);
      }
      if (bucket.seqs.size > 0) this.recordExactSeqs(agentId, target, bucket.seqs);
      this.assertConsumedInvariants("recordConsumed", agentId, target, bucket, {
        advancesBoundary,
        previousBoundary,
      });
    }
    if (input.contextId) this.recordContextScope(agentId, input.contextId, byTarget, boundaryAdvancingTargets);

    return {
      targets: [...byTarget.keys()],
      messagesCount: input.messages.length,
      alreadySeenCount,
      shouldSuppress(message: AgentMessage): boolean {
        const target = formatAgentMessageVisibleTarget(message);
        const bucket = byTarget.get(target);
        if (historyScope) {
          return Boolean(!message.third_party_event
            && message.channel_id === historyScope.channel_id
            && message.channel_type === historyScope.channel_type
            && (message.channel_type === "dm" || message.parent_channel_type === "dm")
            && legacyDmIds.has(visibleMessageId(message)));
        }
        if (!bucket) return false;
        const seq = typeof message.seq === "number" ? Math.floor(message.seq) : 0;
        const id = visibleMessageId(message);
        const advancesBoundary = boundaryAdvancingTargets.has(target);
        return (advancesBoundary && seq > 0 && bucket.boundarySeq > 0 && seq <= bucket.boundarySeq)
          || (seq > 0 && bucket.seqs.has(seq))
          || (id.length > 0 && bucket.ids.has(id));
      },
    };
  }

  /**
   * An inbox notice the runtime accepted showed these messages whole. Recorded
   * as freshness evidence only (see PreviewFacts): never a boundary, never a
   * consumption. `contextId` scopes it as in recordConsumed.
   */
  recordWholePreviewSeen(agentId: string, input: { messages: readonly AgentMessage[]; contextId?: string | null }): void {
    if (input.messages.length === 0) return;
    let facts = this.previewsByAgent.get(agentId);
    if (!facts) {
      facts = emptyPreviewFacts();
      this.previewsByAgent.set(agentId, facts);
    }
    const scope = input.contextId ? this.contextScope(agentId, input.contextId) : undefined;
    for (const message of input.messages) {
      const target = formatProxyVisibleMessageTarget(message);
      if (!target) continue;
      const seq = Number(message.seq ?? 0);
      const normalizedSeq = Number.isFinite(seq) && seq > 0 ? Math.floor(seq) : 0;
      const id = visibleMessageId(message);
      addPreviewFacts(facts, target, id, normalizedSeq);
      if (scope) addPreviewFacts(scope.previews, target, id, normalizedSeq);
    }
  }

  /**
   * The Server showed the model a held task write's context and said it
   * covers `target` up to `seenUpToSeq`. Booked for that write only
   * (`writeKey`, the Server's `agentTaskWriteKey`), so its identical rerun
   * attests the whole span and passes the Server's one hold per catch-up, as
   * the CLI books a held send's `seenUpToSeq` for its draft. Nothing else
   * reads it: not the freshness view (a send, another write), not delivery;
   * the `server_held_context` consume stays set-only (CC2), and rows the hold
   * left out stay pending. `contextId` scopes it as in recordConsumed (under
   * passive AX), so a compaction drops it.
   */
  recordHeldWriteSpan(agentId: string, input: { target: string; writeKey: string; seenUpToSeq: number; contextId?: string | null }): void {
    if (!Number.isFinite(input.seenUpToSeq) || input.seenUpToSeq <= 0) return;
    let held = this.heldWriteSpansByAgent.get(agentId);
    if (!held || held.contextId !== input.contextId) {
      held = { contextId: input.contextId, spans: new Map() };
      this.heldWriteSpansByAgent.set(agentId, held);
    }
    const key = heldWriteSpanKey(input.target, input.writeKey);
    held.spans.set(key, Math.max(held.spans.get(key) ?? 0, Math.floor(input.seenUpToSeq)));
  }

  /**
   * The span a hold of this same write booked (recordHeldWriteSpan), when
   * shown in `context` (the freshnessView signal: undefined without passive
   * AX, else only the current context id counts).
   */
  getHeldWriteSpan(agentId: string, context: { contextId: string | null } | undefined, target: string, writeKey: string): number | undefined {
    const held = this.heldWriteSpansByAgent.get(agentId);
    if (!held) return undefined;
    if (context && (!context.contextId || held.contextId !== context.contextId)) return undefined;
    return held.spans.get(heldWriteSpanKey(target, writeKey));
  }

  /**
   * The thread (`#ch:<root short>`) under `parentTarget` in which the model
   * was shown the message `messageId` (full or short id), when that is not
   * the message's own thread: a reply in a thread. A task created from such a
   * reply lands in that thread (the Server hangs it under the root), so its
   * freshness is attested there. Identity, not evidence: any context counts.
   */
  threadTargetOfMessage(agentId: string, parentTarget: string, messageId: string): string | undefined {
    const id = messageId.trim().toLowerCase();
    if (id.length < 8) return undefined;
    const prefix = `${parentTarget}:`;
    const ownThread = `${prefix}${getMessageShortId(id)}`;
    const shown = [this.messageIdsByAgent.get(agentId), this.previewsByAgent.get(agentId)?.ids];
    // An exact (full) id wins; a short id matches only when one thread has it.
    const byPrefix = new Set<string>();
    for (const byTarget of shown) {
      for (const [target, ids] of byTarget ?? []) {
        if (!target.startsWith(prefix) || target === ownThread || !isThreadVisibleTarget(target)) continue;
        for (const seen of ids) {
          const normalized = seen.toLowerCase();
          if (normalized === id) return target;
          if (normalized.startsWith(id)) byPrefix.add(target);
        }
      }
    }
    return byPrefix.size === 1 ? [...byPrefix][0] : undefined;
  }

  /** The scope for `contextId`; a new context id starts an empty one. */
  private contextScope(agentId: string, contextId: string): ContextScope {
    let scope = this.contextScopeByAgent.get(agentId);
    if (scope?.contextId !== contextId) {
      scope = { contextId, boundaries: new Map(), ids: new Map(), exactSeqs: new Map(), previews: emptyPreviewFacts() };
      this.contextScopeByAgent.set(agentId, scope);
    }
    return scope;
  }

  /** Exact model-seen ids per target: the current context's when one is given, else process-wide. */
  private exactSeenIds(agentId: string, contextId: string | null | undefined): (target: string) => ReadonlySet<string> | undefined {
    if (contextId === undefined) return (target) => this.getMessageIdSet(agentId, target);
    const scope = this.contextScopeByAgent.get(agentId);
    if (!contextId || scope?.contextId !== contextId) return () => undefined;
    return (target) => scope.ids.get(canonicalVisibleTarget(target));
  }

  private boundaryMap(agentId: string): Map<string, number> {
    let map = this.boundaryByAgent.get(agentId);
    if (!map) {
      map = new Map<string, number>();
      this.boundaryByAgent.set(agentId, map);
    }
    return map;
  }

  private recordExactSeqs(agentId: string, target: string, seqs: Iterable<number>): void {
    let map = this.exactSeqsByAgent.get(agentId);
    if (!map) {
      map = new Map<string, Set<number>>();
      this.exactSeqsByAgent.set(agentId, map);
    }
    addCappedExactSeqs(map, target, seqs);
  }

  /** A new context id starts an empty scope: the previous context's facts are gone from the model. */
  private recordContextScope(
    agentId: string,
    contextId: string,
    byTarget: ReadonlyMap<string, VisibleBucket>,
    boundaryAdvancingTargets: ReadonlySet<string>,
  ): void {
    const scope = this.contextScope(agentId, contextId);
    for (const [target, bucket] of byTarget) {
      if (boundaryAdvancingTargets.has(target)) {
        scope.boundaries.set(target, Math.max(scope.boundaries.get(target) ?? 0, bucket.maxSeq, bucket.boundarySeq));
      }
      if (bucket.ids.size > 0) {
        let ids = scope.ids.get(target);
        if (!ids) {
          ids = new Set<string>();
          scope.ids.set(target, ids);
        }
        for (const id of bucket.ids) ids.add(id);
      }
      if (bucket.seqs.size > 0) addCappedExactSeqs(scope.exactSeqs, target, bucket.seqs);
    }
  }

  private messageIdMap(agentId: string): Map<string, Set<string>> {
    let map = this.messageIdsByAgent.get(agentId);
    if (!map) {
      map = new Map<string, Set<string>>();
      this.messageIdsByAgent.set(agentId, map);
    }
    return map;
  }

  private messageIdSet(agentId: string, target: string): Set<string> {
    const map = this.messageIdMap(agentId);
    let ids = map.get(target);
    if (!ids) {
      ids = new Set<string>();
      map.set(target, ids);
    }
    return ids;
  }

  private assertConsumedInvariants(
    context: string,
    agentId: string,
    target: string,
    bucket: VisibleBucket,
    options: { advancesBoundary: boolean; previousBoundary: number | undefined },
  ): void {
    const boundary = this.getBoundary(agentId, target);
    if (!options.advancesBoundary && boundary !== options.previousBoundary) {
      throw new Error(`Agent visible delivery ledger invariant violation after ${context}: set-only source advanced boundary for ${agentId} ${target}`);
    }

    if (options.advancesBoundary) {
      const highWaterSeq = Math.max(bucket.maxSeq, bucket.boundarySeq);
      const normalizedBoundary = boundary ?? 0;
      if (normalizedBoundary < (options.previousBoundary ?? 0)) {
        throw new Error(`Agent visible delivery ledger invariant violation after ${context}: boundary regressed for ${agentId} ${target}`);
      }
      if (highWaterSeq > 0 && normalizedBoundary < highWaterSeq) {
        throw new Error(`Agent visible delivery ledger invariant violation after ${context}: boundary below consumed high-water for ${agentId} ${target}`);
      }
    }

    if (bucket.ids.size > 0) {
      const targetIds = this.getMessageIdSet(agentId, target);
      for (const id of bucket.ids) {
        if (targetIds?.has(id) !== true) {
          throw new Error(`Agent visible delivery ledger invariant violation after ${context}: missing consumed message id for ${agentId} ${target}`);
        }
      }
    }
  }
}
