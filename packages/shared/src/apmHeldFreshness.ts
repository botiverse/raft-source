export interface ApmFreshnessDecisionProducerInput {
  action: "send" | "task_claim" | "task_update";
  decision: "local_hold" | "syncing_hold" | "forward" | "bypass";
  freshnessContextMode?: "inline" | "withheld";
  target?: string;
  reason: string;
  pendingMaxSeq?: number;
  modelSeenSeq?: number;
  heldMessageCount?: number;
  omittedMessageCount?: number;
}

export type ApmFreshnessSideEffectAction = ApmFreshnessDecisionProducerInput["action"];
export type ApmFreshnessHeldDecision = Extract<ApmFreshnessDecisionProducerInput["decision"], "local_hold" | "syncing_hold">;

export interface ApmInlineHeldFreshnessEnvelopeBody<TMessage> {
  state: "held";
  outcome: "held";
  subtype: "freshness";
  reason: "newer_messages_available";
  decision: ApmFreshnessHeldDecision;
  producerFactId: string;
  available_actions: string[];
  heldMessages: TMessage[];
  newMessageCount: number;
  shownMessageCount: number;
  omittedMessageCount: number;
  seenUpToSeq: number;
  freshnessContextMode?: "inline";
  withheldMessageCount?: never;
}

export interface ApmWithheldFreshnessEnvelopeBody {
  state: "held";
  freshnessContextMode: "withheld";
  withheldMessageCount: number;
  outcome?: never;
  subtype?: never;
  reason?: never;
  decision?: never;
  producerFactId?: never;
  available_actions?: never;
  heldMessages?: never;
  newMessageCount?: never;
  shownMessageCount?: never;
  omittedMessageCount?: never;
  seenUpToSeq?: never;
}

export type ApmHeldFreshnessEnvelopeBody<TMessage> =
  | ApmInlineHeldFreshnessEnvelopeBody<TMessage>
  | ApmWithheldFreshnessEnvelopeBody;

export interface ApmHeldFreshnessEnvelopeProjection<TMessage> {
  clauseId: "SMR-006";
  projector: "held-envelope";
  surface: "agent-api-held-response";
  producerFactId: string;
  body: ApmHeldFreshnessEnvelopeBody<TMessage>;
}

export interface ApmHeldFreshnessActivityEntry {
  kind: "slock_action";
  producerFactId: string;
  title: string;
  text: string;
}

export interface ApmHeldFreshnessStatusEntry {
  kind: "status";
  activity: "working";
  activityKind: "working";
  detail: string;
  detailKind: "freshness_hold";
  producerFactId: string;
}

export interface ApmHeldFreshnessActivityProjection {
  clauseId: "SMR-006";
  projector: "held-envelope";
  surface: "agent:activity";
  producerFactId: string;
  statusEntry: ApmHeldFreshnessStatusEntry;
  entry: ApmHeldFreshnessActivityEntry;
  entries: [ApmHeldFreshnessStatusEntry, ApmHeldFreshnessActivityEntry];
}

export interface ApmFreshnessDecisionTraceProjection {
  clauseId: "SMR-006";
  projector: "held-envelope";
  surface: "daemon-trace";
  producerFactId: string;
  attrs: Record<string, unknown>;
}

export function buildApmFreshnessDecisionProducerFactId(
  agentId: string,
  input: ApmFreshnessDecisionProducerInput,
): string {
  const stableInput = {
    agentId,
    action: input.action,
    decision: input.decision,
    ...(input.freshnessContextMode === "withheld"
      ? { freshnessContextMode: input.freshnessContextMode }
      : {}),
    target: input.target ?? null,
    reason: input.reason,
    pendingMaxSeq: input.pendingMaxSeq ?? null,
    modelSeenSeq: input.modelSeenSeq ?? null,
    heldMessageCount: input.heldMessageCount ?? null,
    omittedMessageCount: input.omittedMessageCount ?? null,
  };
  return `freshness_decision_fact:${hashApmHeldFreshnessStable(stableInput)}`;
}

export function projectApmHeldFreshnessEnvelope<TMessage>(input: {
  producerFactId: string;
  action: ApmFreshnessSideEffectAction;
  decision?: ApmFreshnessHeldDecision;
  heldMessages: TMessage[];
  newMessageCount: number;
  omittedMessageCount: number;
  seenUpToSeq: number;
  freshnessContextMode?: "inline" | "withheld";
}): ApmHeldFreshnessEnvelopeProjection<TMessage> {
  const withholdContext = input.freshnessContextMode === "withheld";
  // Reviewer isolation is a strict public-surface allowlist. The lineage,
  // target, reason, message metadata, and recovery vocabulary remain
  // available to internal tracing, but the caller gets only the structural
  // held state and one content-free count.
  const body: ApmHeldFreshnessEnvelopeBody<TMessage> = withholdContext
    ? {
        state: "held",
        freshnessContextMode: "withheld",
        withheldMessageCount: input.newMessageCount,
      }
    : {
        state: "held",
        outcome: "held",
        subtype: "freshness",
        reason: "newer_messages_available",
        decision: input.decision ?? "local_hold",
        producerFactId: input.producerFactId,
        available_actions: apmHeldFreshnessAvailableActions(input.action),
        heldMessages: input.heldMessages,
        newMessageCount: input.newMessageCount,
        shownMessageCount: input.heldMessages.length,
        omittedMessageCount: input.omittedMessageCount,
        seenUpToSeq: input.seenUpToSeq,
      };

  return {
    clauseId: "SMR-006",
    projector: "held-envelope",
    surface: "agent-api-held-response",
    producerFactId: input.producerFactId,
    body,
  };
}

export function projectApmHeldFreshnessActivity(input: {
  producerFactId: string;
  action: ApmFreshnessSideEffectAction;
  decision: ApmFreshnessHeldDecision;
  target?: string;
  messageCount: number;
}): ApmHeldFreshnessActivityProjection {
  const messageNoun = input.messageCount === 1 ? "message" : "messages";
  const title = input.action === "send"
    ? "Send held by freshness check"
    : input.action === "task_claim"
      ? "Task claim held by freshness check"
      : "Task update held by freshness check";
  const countLine = input.decision === "syncing_hold"
    ? `unreviewed synced context for this target: ${input.messageCount} ${messageNoun}`
    : `new messages: ${input.messageCount} newer ${messageNoun}`;
  const decisionLines = input.decision === "syncing_hold"
    ? [
        "reason: this target's latest synced context was not yet in your reviewed context",
        input.action === "send"
          ? "action: review the synced context before sending"
          : "action: review the synced context, then retry this action",
      ]
    : ["decision: local hold; review the newer context before retrying"];
  const text = [
    input.target ? `target: ${input.target}` : null,
    countLine,
    ...decisionLines,
  ].filter((line): line is string => Boolean(line)).join("\n");

  const statusEntry: ApmHeldFreshnessStatusEntry = {
    kind: "status",
    activity: "working",
    activityKind: "working",
    detail: title,
    detailKind: "freshness_hold",
    producerFactId: input.producerFactId,
  };
  const entry: ApmHeldFreshnessActivityEntry = {
    kind: "slock_action",
    producerFactId: input.producerFactId,
    title,
    text,
  };

  return {
    clauseId: "SMR-006",
    projector: "held-envelope",
    surface: "agent:activity",
    producerFactId: input.producerFactId,
    statusEntry,
    entry,
    entries: [statusEntry, entry],
  };
}

export function projectApmFreshnessDecisionTrace(input: {
  producerFactId: string;
  decision: ApmFreshnessDecisionProducerInput & {
    inboxTrustState?: string;
    pendingCount?: number;
  };
}): ApmFreshnessDecisionTraceProjection {
  return {
    clauseId: "SMR-006",
    projector: "held-envelope",
    surface: "daemon-trace",
    producerFactId: input.producerFactId,
    attrs: {
      producer_fact_id: input.producerFactId,
      action: input.decision.action,
      decision: input.decision.decision,
      ...(input.decision.freshnessContextMode === "withheld"
        ? { freshness_context_mode: input.decision.freshnessContextMode }
        : {}),
      target: input.decision.target,
      inbox_trust_state: input.decision.inboxTrustState,
      reason: input.decision.reason,
      pending_count: input.decision.pendingCount,
      pending_max_seq: input.decision.pendingMaxSeq,
      model_seen_seq: input.decision.modelSeenSeq,
      held_message_count: input.decision.heldMessageCount,
      omitted_message_count: input.decision.omittedMessageCount,
    },
  };
}

function apmHeldFreshnessAvailableActions(action: ApmFreshnessSideEffectAction): string[] {
  return action === "send"
    ? ["check_messages", "send_draft", "send_anyway"]
    : ["check_messages", "retry_action"];
}

function hashApmHeldFreshnessStable(value: unknown): string {
  return sha256HexUtf8(stableStringifyApmHeldFreshness(value));
}

function stableStringifyApmHeldFreshness(value: unknown): string {
  return JSON.stringify(stableNormalizeApmHeldFreshness(value));
}

function stableNormalizeApmHeldFreshness(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => stableNormalizeApmHeldFreshness(item));
  if (!value || typeof value !== "object") return value;

  const record = value as Record<string, unknown>;
  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    const child = record[key];
    if (child === undefined) continue;
    normalized[key] = stableNormalizeApmHeldFreshness(child);
  }
  return normalized;
}

const SHA256_INITIAL_STATE = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
] as const;

const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const;

function sha256HexUtf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;

  const bitLength = bytes.length * 8;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000));
  view.setUint32(paddedLength - 4, bitLength >>> 0);

  const h: number[] = [...SHA256_INITIAL_STATE];
  const words = new Array<number>(64);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      words[i] = view.getUint32(offset + i * 4);
    }
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotateRight(words[i - 15], 7) ^ rotateRight(words[i - 15], 18) ^ (words[i - 15] >>> 3);
      const s1 = rotateRight(words[i - 2], 17) ^ rotateRight(words[i - 2], 19) ^ (words[i - 2] >>> 10);
      words[i] = (words[i - 16] + s0 + words[i - 7] + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i += 1) {
      const s1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + s1 + ch + SHA256_K[i] + words[i]) >>> 0;
      const s0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;

      hh = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }

  return h.map((part) => part.toString(16).padStart(8, "0")).join("");
}

function rotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}
