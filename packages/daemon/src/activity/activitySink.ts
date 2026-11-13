// Activity sink (RFC 069 §7, phase 2).
//
// The process manager decides WHAT an agent is doing and hands each fact to an
// `ActivitySink`, which decides how it travels. `LegacyActivitySink` is the V1
// implementation: the legacy `agent:activity` frame with its per-agent client
// sequence, producer fact id, observation time, heartbeat and probe-reply
// frames, and the `daemon.agent.activity.produced` trace. The activity sync V2
// sink (numbered log with ack and resume) implements the same interface.
//
// Extracted without behavior change: every frame and trace below is built in
// the same order and with the same fields as before the extraction.

import type {
  AgentActivityDetailKind,
  CredentialHoldActivityDiagnostic,
  AgentActivityKind,
  DeliveryConsumptionActivityDiagnostic,
  MachineToServerMessage,
  ProviderRequestActivity,
  RuntimeErrorActivityDiagnostic,
  ToolStuckActivityDiagnostic,
  TrajectoryEntry,
} from "@botiverse/raft-shared";
import {
  buildDaemonActivityMessage,
  daemonActivityDropTraceAttrs,
  type DaemonActivityInput,
} from "./agentActivityProducer";

/** What the produced trace records about the agent process a frame belongs to. */
export interface ActivityProducerContext {
  present: boolean;
  serverId?: string | null;
  machineId?: string | null;
  processInstanceId?: string | null;
  sessionIdPresent: boolean;
  runtime?: string | null;
}

export interface LegacyActivitySinkDeps {
  sendToServer(msg: MachineToServerMessage): void;
  /** Per-agent monotonic client sequence; owned by the lifecycle records. */
  nextClientSeq(agentId: string): number;
  /** This daemon process's generation; null when unknown. Read on every frame. */
  daemonInstanceId(): string | null;
  recordEvent(name: string, attrs: Record<string, unknown>, status?: "ok" | "error" | "cancelled"): void;
  now(): number;
}

/** A new activity fact as the process manager produced it. */
export interface ActivityFact {
  agentId: string;
  activityKind: AgentActivityKind;
  detail: string;
  detailKind: AgentActivityDetailKind | undefined;
  entries: TrajectoryEntry[];
  launchId: string | undefined;
  runtimeError?: RuntimeErrorActivityDiagnostic;
  providerRequest?: ProviderRequestActivity;
  deliveryConsumption?: DeliveryConsumptionActivityDiagnostic;
  /** task #25: present on every frame while the agent is stuck on a tool call. */
  toolStuck?: ToolStuckActivityDiagnostic;
  /**
   * Reconciler step 4b: present only on the idle frame whose detail is the
   * credential-invalid held notice; every other frame omits it.
   */
  credentialHold?: CredentialHoldActivityDiagnostic;
}

/** The last known activity, re-sent by a heartbeat or a probe reply. */
export interface ActivitySnapshot {
  agentId: string;
  activityKind: AgentActivityKind;
  detail: string;
  detailKind: AgentActivityDetailKind;
  launchId: string | undefined;
  providerRequest?: ProviderRequestActivity;
  /** task #25: the stuck state is current truth, so re-sent frames carry it too. */
  toolStuck?: ToolStuckActivityDiagnostic;
  /** Reconciler step 4b: a re-sent held notice carries its reason too. */
  credentialHold?: CredentialHoldActivityDiagnostic;
}

/** Where the process manager hands activity facts. */
export interface ActivitySink {
  /** Next per-agent client sequence, for callers that frame their own message. */
  nextClientSeq(agentId: string): number;
  /** A pre-framed activity message (diagnostic, recovery, freshness hold). */
  send(input: Omit<DaemonActivityInput, "daemonInstanceId">): AgentActivityDetailKind | false;
  /** A new fact. Returns the detail kind sent, or false when it was dropped. */
  publishFact(fact: ActivityFact, producer: ActivityProducerContext): AgentActivityDetailKind | false;
  /** Periodic re-assertion of a busy state; a sink with reliable delivery may ignore it. */
  publishHeartbeat(snapshot: ActivitySnapshot, producer: ActivityProducerContext): void;
  /** Answer a server `agent:activity_probe`. */
  respondToProbe(snapshot: Omit<ActivitySnapshot, "providerRequest">, probeId: string, producer: ActivityProducerContext): void;
}

export class LegacyActivitySink implements ActivitySink {
  constructor(private readonly deps: LegacyActivitySinkDeps) {}

  nextClientSeq(agentId: string): number {
    return this.deps.nextClientSeq(agentId);
  }

  /**
   * Frame and send one activity message. Returns the detail kind that was
   * sent, or false when the frame was dropped (unknown or non-fact kind).
   */
  send(input: Omit<DaemonActivityInput, "daemonInstanceId">): AgentActivityDetailKind | false {
    const result = buildDaemonActivityMessage({ ...input, daemonInstanceId: this.deps.daemonInstanceId() || undefined });
    if (result.ok) {
      this.deps.sendToServer(result.message);
      return result.message.detailKind as AgentActivityDetailKind;
    }
    this.deps.recordEvent("daemon.agent.activity.dropped", daemonActivityDropTraceAttrs(result.drop), "error");
    return false;
  }

  /** A new fact: stamped with the next client sequence, a producer fact id and its observation time. */
  publishFact(fact: ActivityFact, producer: ActivityProducerContext): AgentActivityDetailKind | false {
    // Bump the per-agent monotonic clientSeq so the server can dedupe
    // out-of-order ingest. Manager-level + never-reset-on-respawn so a
    // self-restart's reused launchId can't collide. (#proj-o11y:a1e54b59)
    const clientSeq = this.deps.nextClientSeq(fact.agentId);
    const producerFactId = this.producerFactId(fact.agentId, fact.launchId, clientSeq);
    const observedAtMs = this.deps.now();
    const sentDetailKind = this.send({
      agentId: fact.agentId,
      activityKind: fact.activityKind,
      detail: fact.detail,
      detailKind: fact.detailKind,
      entries: fact.entries,
      launchId: fact.launchId,
      clientSeq,
      producerFactId,
      observedAtMs,
      isHeartbeat: false,
      runtimeError: fact.runtimeError,
      providerRequest: fact.providerRequest,
      deliveryConsumption: fact.deliveryConsumption,
      toolStuck: fact.toolStuck,
      credentialHold: fact.credentialHold,
    });
    if (!sentDetailKind) return false;
    this.recordProduced(fact.agentId, fact.activityKind, fact.detail, sentDetailKind, fact.entries, producer, fact.launchId, clientSeq, producerFactId, false);
    return sentDetailKind;
  }

  /**
   * Re-send the last activity so the server's stale-activity sweep does not
   * reset a long-running busy state.
   */
  publishHeartbeat(snapshot: ActivitySnapshot, producer: ActivityProducerContext): void {
    // TODO(lifecycle-v2/daemon-protocol): heartbeat should become a
    // structured progress heartbeat event, not another generic
    // `agent:activity` that the server must reinterpret.
    const clientSeq = this.deps.nextClientSeq(snapshot.agentId);
    const producerFactId = this.producerFactId(snapshot.agentId, snapshot.launchId, clientSeq);
    const observedAtMs = this.deps.now();
    this.send({
      agentId: snapshot.agentId,
      activityKind: snapshot.activityKind,
      providerRequest: snapshot.providerRequest,
      detail: snapshot.detail,
      detailKind: snapshot.detailKind,
      launchId: snapshot.launchId,
      clientSeq,
      producerFactId,
      observedAtMs,
      // The one knowing site: this timer re-broadcasts stale
      // lastActivity, so it declares its replay provenance.
      isHeartbeat: true,
      toolStuck: snapshot.toolStuck,
      credentialHold: snapshot.credentialHold,
    });
    this.recordProduced(snapshot.agentId, snapshot.activityKind, snapshot.detail, snapshot.detailKind, [], producer, snapshot.launchId, clientSeq, producerFactId, true);
  }

  /** Answer a server `agent:activity_probe` with the given current activity. */
  respondToProbe(snapshot: Omit<ActivitySnapshot, "providerRequest">, probeId: string, producer: ActivityProducerContext): void {
    // TODO(lifecycle-v2/daemon-protocol): probe responses should be a dedicated
    // activity_snapshot/probe_response event. Reusing `agent:activity` keeps the
    // legacy server path working but forces the reducer to distinguish actual
    // lifecycle changes from read-only ground-truth probes.
    const clientSeq = this.deps.nextClientSeq(snapshot.agentId);
    const producerFactId = this.producerFactId(snapshot.agentId, snapshot.launchId, clientSeq);
    this.send({
      agentId: snapshot.agentId,
      activityKind: snapshot.activityKind,
      detail: snapshot.detail,
      detailKind: snapshot.detailKind,
      launchId: snapshot.launchId,
      probeId,
      clientSeq,
      producerFactId,
      isHeartbeat: false,
      toolStuck: snapshot.toolStuck,
      credentialHold: snapshot.credentialHold,
    });
    this.recordProduced(snapshot.agentId, snapshot.activityKind, snapshot.detail, snapshot.detailKind, [], producer, snapshot.launchId, clientSeq, producerFactId, false);
  }

  private producerFactId(agentId: string, launchId: string | undefined, clientSeq: number): string {
    const daemonInstanceId = this.deps.daemonInstanceId();
    const daemonGeneration = daemonInstanceId ? `:${daemonInstanceId}` : "";
    return `daemon_activity:${agentId}:${launchId ?? "legacy"}${daemonGeneration}:${clientSeq}`;
  }

  private recordProduced(
    agentId: string,
    activityKind: AgentActivityKind,
    detail: string,
    detailKind: AgentActivityDetailKind,
    entries: TrajectoryEntry[],
    producer: ActivityProducerContext,
    launchId: string | undefined,
    clientSeq: number | undefined,
    producerFactId: string,
    isHeartbeat: boolean,
  ): void {
    this.deps.recordEvent("daemon.agent.activity.produced", {
      agentId,
      agent_id: agentId,
      server_id: producer.serverId,
      machine_id: producer.machineId,
      process_instance_id: producer.processInstanceId,
      activity: activityKind,
      activity_kind: activityKind,
      detail_present: Boolean(detail),
      detail_kind: detailKind,
      entry_kinds: entries.map((e) => e.kind).join(","),
      ap_present: producer.present,
      launchId,
      launch_id: launchId,
      launch_id_present: Boolean(launchId),
      clientSeq,
      client_seq: clientSeq,
      client_seq_present: typeof clientSeq === "number",
      producerFactId,
      producer_fact_id: producerFactId,
      // #460 V1: the wire's producer-declared replay-provenance bit must be
      // independently verifiable from daemon-side evidence (L2<->L3 seam);
      // closed boolean, mirrors the agent:activity isHeartbeat field exactly.
      isHeartbeat,
      is_heartbeat: isHeartbeat,
      correlation_id: `agent:${agentId}:daemonActivity:${launchId ?? "legacy"}:${clientSeq ?? "unsequenced"}`,
      session_id_present: producer.sessionIdPresent,
      runtime: producer.runtime,
    });
  }
}
