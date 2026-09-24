export interface AgentStatusTransitionInput {
  agentId: string;
  status: string;
  launchId: string | null;
  observedAtMs: number;
  processInstanceId?: string;
  runtime?: string;
  sessionIdPresent?: boolean;
}

interface AgentStatusSnapshot {
  status: string;
  launchId: string | null;
  processInstanceId?: string;
  runtime?: string;
  sessionIdPresent: boolean;
}

export class AgentStatusTransitionTrace {
  private seq = 0;
  private readonly snapshots = new Map<string, AgentStatusSnapshot>();

  record(input: AgentStatusTransitionInput): Record<string, unknown> {
    const previous = this.snapshots.get(input.agentId);
    const seq = ++this.seq;
    const sessionIdPresent = input.sessionIdPresent ?? previous?.sessionIdPresent ?? false;
    const processInstanceId = input.processInstanceId ?? previous?.processInstanceId;
    const runtime = input.runtime ?? previous?.runtime;
    this.snapshots.set(input.agentId, {
      status: input.status,
      launchId: input.launchId,
      processInstanceId,
      runtime,
      sessionIdPresent,
    });
    return {
      agentId: input.agentId,
      agent_id: input.agentId,
      status: input.status,
      previous_status: previous?.status ?? "unknown",
      previous_status_present: Boolean(previous),
      status_changed: previous ? previous.status !== input.status : true,
      launchId: input.launchId ?? undefined,
      launch_id: input.launchId ?? undefined,
      launch_id_present: Boolean(input.launchId),
      previous_launch_id_present: Boolean(previous?.launchId),
      launch_id_changed: previous ? previous.launchId !== input.launchId : Boolean(input.launchId),
      status_transition_seq: seq,
      observed_at_ms: input.observedAtMs,
      process_instance_id: processInstanceId,
      runtime,
      session_id_present: sessionIdPresent,
    };
  }
}
