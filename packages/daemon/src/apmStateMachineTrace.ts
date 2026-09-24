import type { MachineToServerMessage } from "@botiverse/raft-shared";
import {
  createInitialApmDecisionState,
  hashApmStable,
  reduceAgentActivityProjection,
  stableStringifyApm,
} from "./apmStateMachine.js";
import type {
  AgentActivityMessage,
  AgentActivitySequenceSnapshot,
  ApmDecisionState,
  ApmGatedFlushReason,
  ApmTraceInputKind,
  ApmTraceInputRow,
  ApmTraceTransitionRow,
} from "./apmStateMachine.js";

export type {
  AgentActivityMessage,
  AgentActivitySequenceEntry,
  AgentActivitySequenceSnapshot,
  ApmActivityProjectionInput,
  ApmActivityProjectionReduction,
  ApmDecisionState,
  ApmGatedAssistantContinuationReduction,
  ApmGatedErrorReduction,
  ApmGatedFlushReason,
  ApmGatedSteeringDecisionState,
  ApmGatedCompactionReduction,
  ApmGatedTurnEndReduction,
  ApmToolUseReduction,
  ApmTraceEffectRow,
  ApmTraceInputKind,
  ApmTraceInputRow,
  ApmTraceProjectorOutputRow,
  ApmTraceTransitionRow,
} from "./apmStateMachine.js";

export type ApmObservedGatedStdinEffect =
  | {
    kind: "notify_stdin";
    reason: Exclude<ApmGatedFlushReason, "turn_end">;
    stdinMode: "busy";
    payload: unknown;
  }
  | {
    kind: "deliver_stdin";
    reason: "turn_end";
    stdinMode: "idle";
    payload: unknown;
  };

export interface ApmGatedEffectSequenceEntry {
  effectId: string;
  kind: ApmObservedGatedStdinEffect["kind"];
  reason: ApmGatedFlushReason;
  stdinMode: "busy" | "idle";
  payloadHash: string;
}

export interface ApmGatedEffectSequenceSnapshot {
  clauseId: "SMR-002";
  scenario: string;
  correlationId: string;
  sequence: ApmGatedEffectSequenceEntry[];
}

export interface ApmTraceWriterRow {
  seq: number;
  producerFactId: string;
  correlationId: string;
  sourceEffectIds: string[];
  sourceProjectorIds: string[];
  lifecycleTuple?: Record<string, string>;
  writes: Array<{
    surface: string;
    value?: string;
    payloadHash?: string;
    clauseId: "SMR-004";
  }>;
}

export interface ApmTraceArtifactBundle {
  inputs: ApmTraceInputRow[];
  transitionTrace: ApmTraceTransitionRow[];
  writerTrace: ApmTraceWriterRow[];
  surfaceSnapshots: {
    "agent-activity.sequence.json": AgentActivitySequenceSnapshot;
    "gated-effects.sequence.json": ApmGatedEffectSequenceSnapshot;
  };
  finalSnapshot: Record<string, unknown>;
}

export type BehaviorDeltaClassification =
  | "preserved"
  | "intentional correction"
  | "contract gap"
  | "regression";

export interface BehaviorDeltaRow {
  scenario: string;
  old_trace_hash: string;
  new_trace_hash: string;
  surface_snapshot_hash: string;
  classification: BehaviorDeltaClassification;
  clause_or_concept_anchor: string;
  reviewer_sign: string;
}

export interface ApmTraceSerializedArtifacts {
  "inputs.jsonl": string;
  "transition.trace.jsonl": string;
  "writer.trace.jsonl": string;
  "surface.snapshots/agent-activity.sequence.json": string;
  "surface.snapshots/gated-effects.sequence.json": string;
  "final.snapshot.json": string;
  "behavior-delta.table.json": string;
}

export interface PredicateFixtureResult {
  name:
    | "INV-NO-APM-DURABLE-WRITE"
    | "INV-NO-LIFECYCLE-STDIN-OR-KILL"
    | "INV-NO-INDEPENDENT-DOT-DERIVE";
  ok: boolean;
  violations: string[];
}

export class ApmTraceRecorder {
  private readonly inputs: ApmTraceInputRow[] = [];
  private readonly transitionTrace: ApmTraceTransitionRow[] = [];
  private readonly activitySnapshots: AgentActivitySequenceSnapshot["sequence"] = [];
  private readonly gatedEffectSnapshots: ApmGatedEffectSequenceSnapshot["sequence"] = [];
  private observedSentLength = 0;
  private observedEffectLength = 0;
  private nextInputSeq = 1;
  private nextTransitionSeq = 1;
  private apmState: ApmDecisionState = createInitialApmDecisionState();

  constructor(
    private readonly opts: {
      scenario: string;
      agentId: string;
      sent: MachineToServerMessage[];
      correlationId: string;
      observedGatedEffects?: () => readonly ApmObservedGatedStdinEffect[];
    },
  ) {}

  async step(
    input: Omit<ApmTraceInputRow, "seq" | "scenario" | "correlationId" | "inputId"> & {
      inputId?: string;
    },
    action: () => void | Promise<void>,
  ): Promise<void> {
    const inputRow: ApmTraceInputRow = {
      seq: this.nextInputSeq,
      scenario: this.opts.scenario,
      correlationId: this.opts.correlationId,
      inputId: input.inputId ?? `input-${String(this.nextInputSeq).padStart(3, "0")}`,
      inputKind: input.inputKind,
      driver: input.driver,
      summary: input.summary,
    };
    this.nextInputSeq += 1;
    this.inputs.push(inputRow);

    const before = this.opts.sent.length;
    const beforeEffects = this.observedEffectLength;
    await action();
    this.consumeNewMessages(inputRow, before);
    this.consumeNewGatedEffects(inputRow, beforeEffects);
  }

  buildFinal(finalSnapshot: Record<string, unknown>): ApmTraceArtifactBundle {
    this.consumeNewMessages(this.inputs[this.inputs.length - 1], this.observedSentLength);
    this.consumeNewGatedEffects(
      this.inputs[this.inputs.length - 1],
      this.observedEffectLength,
    );
    return {
      inputs: [...this.inputs],
      transitionTrace: [...this.transitionTrace],
      writerTrace: [],
      surfaceSnapshots: {
        "agent-activity.sequence.json": {
          clauseId: "SMR-003",
          scenario: this.opts.scenario,
          correlationId: this.opts.correlationId,
          producerFactIds: this.activitySnapshots.map((entry) => entry.producerFactId),
          sequence: [...this.activitySnapshots],
        },
        "gated-effects.sequence.json": {
          clauseId: "SMR-002",
          scenario: this.opts.scenario,
          correlationId: this.opts.correlationId,
          sequence: [...this.gatedEffectSnapshots],
        },
      },
      finalSnapshot,
    };
  }

  private consumeNewMessages(input: ApmTraceInputRow | undefined, startIndex: number): void {
    const effectiveInput = input ?? this.inputs[this.inputs.length - 1];
    if (!effectiveInput) return;

    const messages = this.opts.sent.slice(startIndex);
    this.observedSentLength = this.opts.sent.length;

    for (const message of messages) {
      if (message.type !== "agent:activity") continue;
      if (message.agentId !== this.opts.agentId) continue;
      this.recordActivityTransition(effectiveInput, message);
    }
  }

  private consumeNewGatedEffects(input: ApmTraceInputRow | undefined, startIndex: number): void {
    const effectiveInput = input ?? this.inputs[this.inputs.length - 1];
    if (!effectiveInput) return;
    const observed = this.opts.observedGatedEffects?.();
    if (!observed) return;

    const effects = observed.slice(startIndex);
    this.observedEffectLength = observed.length;
    for (const effect of effects) {
      this.recordGatedEffectTransition(effectiveInput, effect);
    }
  }

  private recordActivityTransition(input: ApmTraceInputRow, message: AgentActivityMessage): void {
    const traceSeq = this.nextTransitionSeq;
    this.nextTransitionSeq += 1;

    const reduction = reduceAgentActivityProjection(this.apmState, {
      transitionSeq: traceSeq,
      scenario: this.opts.scenario,
      correlationId: this.opts.correlationId,
      inputId: input.inputId,
      inputKind: input.inputKind,
      inputSummary: input.summary,
      message,
    });
    this.transitionTrace.push(reduction.transition);
    this.activitySnapshots.push(reduction.snapshotEntry);
    this.apmState = reduction.nextState;
  }

  private recordGatedEffectTransition(input: ApmTraceInputRow, effect: ApmObservedGatedStdinEffect): void {
    const traceSeq = this.nextTransitionSeq;
    this.nextTransitionSeq += 1;

    const effectId = `effect-${this.opts.scenario}-${traceSeq}`;
    const payloadHash = hashApmStable(effect.payload);
    const previousStateHash = this.apmState.stateHash;
    const nextStateHash = `apm:${hashApmStable({
      previousStateHash,
      observedEffect: {
        kind: effect.kind,
        reason: effect.reason,
        stdinMode: effect.stdinMode,
        payloadHash,
      },
    })}`;

    this.transitionTrace.push({
      seq: traceSeq,
      scenario: this.opts.scenario,
      correlationId: this.opts.correlationId,
      inputId: input.inputId,
      inputKind: input.inputKind,
      previousStateHash,
      nextStateHash,
      effects: [{
        effectId,
        kind: effect.kind,
        reason: effect.reason,
        target: "runtime-stdin",
        stdinMode: effect.stdinMode,
        payloadHash,
        clauseId: "SMR-002",
      }],
      projectorOutputs: [],
    });
    this.gatedEffectSnapshots.push({
      effectId,
      kind: effect.kind,
      reason: effect.reason,
      stdinMode: effect.stdinMode,
      payloadHash,
    });
    this.apmState = {
      ...this.apmState,
      stateHash: nextStateHash,
    };
  }
}

export function evaluateApmTracePredicateFixtures(bundle: ApmTraceArtifactBundle): PredicateFixtureResult[] {
  return [
    evaluateNoApmDurableWrite(bundle),
    evaluateNoLifecycleStdinOrKill(bundle),
    evaluateNoIndependentDotDerive(bundle),
  ];
}

export function buildBehaviorDeltaRow(input: {
  scenario: string;
  oldTrace: unknown;
  newTrace: unknown;
  surfaceSnapshots: unknown;
  classification: BehaviorDeltaClassification;
  clauseOrConceptAnchor: string;
  reviewerSign: string;
}): BehaviorDeltaRow {
  return {
    scenario: input.scenario,
    old_trace_hash: hashApmStable(input.oldTrace),
    new_trace_hash: hashApmStable(input.newTrace),
    surface_snapshot_hash: hashApmStable(input.surfaceSnapshots),
    classification: input.classification,
    clause_or_concept_anchor: input.clauseOrConceptAnchor,
    reviewer_sign: input.reviewerSign,
  };
}

export function serializeApmTraceArtifacts(
  bundle: ApmTraceArtifactBundle,
  behaviorDeltaRows: BehaviorDeltaRow[],
): ApmTraceSerializedArtifacts {
  return {
    "inputs.jsonl": toJsonl(bundle.inputs),
    "transition.trace.jsonl": toJsonl(bundle.transitionTrace),
    "writer.trace.jsonl": toJsonl(bundle.writerTrace),
    "surface.snapshots/agent-activity.sequence.json": stableStringifyApm(
      bundle.surfaceSnapshots["agent-activity.sequence.json"],
    ),
    "surface.snapshots/gated-effects.sequence.json": stableStringifyApm(
      bundle.surfaceSnapshots["gated-effects.sequence.json"],
    ),
    "final.snapshot.json": stableStringifyApm(bundle.finalSnapshot),
    "behavior-delta.table.json": stableStringifyApm(behaviorDeltaRows),
  };
}

function evaluateNoApmDurableWrite(bundle: ApmTraceArtifactBundle): PredicateFixtureResult {
  const forbidden = new Set(["db_status", "wake_eligibility", "live_activity", "activity_log", "durable_activity_log"]);
  const violations: string[] = [];

  for (const row of bundle.transitionTrace) {
    for (const output of row.projectorOutputs) {
      if (forbidden.has(output.surface)) {
        violations.push(`transition ${row.seq} projected directly to ${output.surface}`);
      }
    }
  }

  return {
    name: "INV-NO-APM-DURABLE-WRITE",
    ok: violations.length === 0,
    violations,
  };
}

function evaluateNoLifecycleStdinOrKill(bundle: ApmTraceArtifactBundle): PredicateFixtureResult {
  const forbidden = new Set(["stdin", "runtime_stdin", "kill", "process_kill", "restart", "process_restart"]);
  const violations: string[] = [];

  for (const row of bundle.writerTrace) {
    for (const write of row.writes) {
      if (forbidden.has(write.surface)) {
        violations.push(`writer row ${row.seq} wrote forbidden runtime-control surface ${write.surface}`);
      }
    }
  }

  return {
    name: "INV-NO-LIFECYCLE-STDIN-OR-KILL",
    ok: violations.length === 0,
    violations,
  };
}

function evaluateNoIndependentDotDerive(bundle: ApmTraceArtifactBundle): PredicateFixtureResult {
  const violations: string[] = [];
  const snapshot = bundle.surfaceSnapshots["agent-activity.sequence.json"];

  for (const [index, entry] of snapshot.sequence.entries()) {
    if (!entry.producerFactId) {
      violations.push(
        `activity sequence entry ${index + 1} (${entry.activity}:${entry.detail}) missing producerFactId`,
      );
    }
  }

  return {
    name: "INV-NO-INDEPENDENT-DOT-DERIVE",
    ok: violations.length === 0,
    violations,
  };
}

function toJsonl(rows: unknown[]): string {
  if (rows.length === 0) return "";
  return `${rows.map((row) => stableStringifyApm(row)).join("\n")}\n`;
}
