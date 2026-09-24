import type { AgentConfig, AgentMessage } from "@botiverse/raft-shared";
import type { AgentStartCoordinator } from "./agentStartCoordinator.js";

export type AgentStartAcceptance = {
  queueState: "queued" | "starting" | "running" | "rebound";
  queueDepth: number;
  queueAgeMs: number;
};

export class AgentStartDispatchProjection {
  constructor(
    private readonly starts: AgentStartCoordinator,
    private readonly clockNow: () => number,
    private readonly runtimePolicyAttrs: (config: AgentConfig) => Record<string, unknown>,
  ) {}

  acceptance(agentId: string, running: boolean): AgentStartAcceptance {
    const snapshot = this.starts.snapshot();
    if (this.starts.hasQueued(agentId)) {
      return {
        queueState: "queued",
        queueDepth: snapshot.queueDepth,
        queueAgeMs: this.starts.queueAgeMs(agentId, this.clockNow()),
      };
    }
    if (this.starts.hasStarting(agentId)) {
      return { queueState: "starting", queueDepth: snapshot.queueDepth, queueAgeMs: 0 };
    }
    return {
      queueState: running ? "running" : "rebound",
      queueDepth: snapshot.queueDepth,
      queueAgeMs: 0,
    };
  }

  traceAttrs(
    agentId: string,
    config: AgentConfig,
    wakeMessage?: AgentMessage,
    unreadSummary?: Record<string, number>,
    resumePrompt?: string,
    launchId?: string,
    wakeMessageTransient = false,
    resumeMessages?: AgentMessage[],
    startDispatchId?: string,
  ): Record<string, unknown> {
    const snapshot = this.starts.snapshot();
    return {
      agentId,
      launchId,
      start_dispatch_id: startDispatchId,
      runtime: config.runtime,
      model: config.model,
      session_id_present: Boolean(config.sessionId),
      launch_id_present: Boolean(launchId),
      wake_message_present: Boolean(wakeMessage),
      wake_message_transient: Boolean(wakeMessage && wakeMessageTransient),
      resume_messages_count: resumeMessages?.length ?? 0,
      unread_channels_count: unreadSummary ? Object.keys(unreadSummary).length : 0,
      resume_prompt_present: Boolean(resumePrompt),
      queue_depth: snapshot.queueDepth,
      queue_age_ms: this.starts.queueAgeMs(agentId, this.clockNow()),
      active_starts: snapshot.activeStarts,
      max_concurrent_starts: snapshot.maxConcurrentStarts,
      min_start_interval_ms: snapshot.minStartIntervalMs,
      ...this.runtimePolicyAttrs(config),
    };
  }
}
