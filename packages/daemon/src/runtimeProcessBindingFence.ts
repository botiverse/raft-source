import type {
  ParsedEvent,
  RuntimeSendResult,
  RuntimeSession,
} from "./drivers/index.js";

export interface RuntimeBindingProcess {
  readonly runtime: RuntimeSession;
  readonly driver: { readonly id: string };
  readonly config: {
    readonly runtime: string;
    readonly runtimeContext?: {
      readonly serverId?: string | null;
      readonly machineId?: string | null;
    } | null;
  };
  readonly launchId: string | null;
  readonly sessionId: string | null;
  readonly processInstanceId: string;
}

export interface RuntimeProcessBinding {
  readonly agentId: string;
  readonly serverId: string | null;
  readonly machineId: string | null;
  readonly configuredRuntimeId: string;
  readonly driverId: string;
  readonly initialLaunchId: string | null;
  readonly activeLaunchId: string | null;
  readonly startSessionId: string | null;
  readonly activeSessionId: string | null;
  readonly processInstanceId: string;
}

type RuntimeBindingMismatchReason =
  | "binding_missing"
  | "inactive_process_generation"
  | "runtime_reference_mismatch"
  | "agent_mismatch"
  | "server_mismatch"
  | "machine_mismatch"
  | "runtime_mismatch"
  | "launch_mismatch"
  | "session_mismatch"
  | "process_instance_mismatch";

type RuntimeBindingValidation =
  | { ok: true; binding: RuntimeProcessBinding }
  | {
      ok: false;
      reason: RuntimeBindingMismatchReason;
      binding: RuntimeProcessBinding | null;
      current: RuntimeBindingProcess | null;
    };

type RuntimeBindingTrace = (
  name: string,
  attrs?: Record<string, unknown>,
  status?: "ok" | "error" | "cancelled",
) => void;

export interface RuntimeProcessBindingFenceOptions {
  getCurrentProcess(agentId: string): RuntimeBindingProcess | null;
  recordTrace: RuntimeBindingTrace;
}

type RuntimeBindingRebindSource =
  | "server_start_rebind"
  | "session_init"
  | "turn_end";

function requireImmediateRuntimeSendResult(
  result: RuntimeSendResult | Promise<RuntimeSendResult>,
  context: string,
): RuntimeSendResult {
  if (typeof (result as Promise<RuntimeSendResult>).then === "function") {
    throw new Error(`RuntimeSession.send returned async result in synchronous APM path: ${context}`);
  }
  return result as RuntimeSendResult;
}

export class RuntimeProcessBindingFence {
  private readonly bindings = new WeakMap<RuntimeSession, RuntimeProcessBinding>();
  private readonly getCurrentProcess: RuntimeProcessBindingFenceOptions["getCurrentProcess"];
  private readonly recordTrace: RuntimeBindingTrace;

  constructor(options: RuntimeProcessBindingFenceOptions) {
    this.getCurrentProcess = options.getCurrentProcess;
    this.recordTrace = options.recordTrace;
  }

  bind(runtime: RuntimeSession, binding: RuntimeProcessBinding): void {
    if (this.bindings.has(runtime)) {
      throw new Error("RuntimeSession instance cannot be shared across process bindings");
    }
    this.bindings.set(runtime, Object.freeze({ ...binding }));
  }

  getBinding(runtime: RuntimeSession): RuntimeProcessBinding | null {
    return this.bindings.get(runtime) ?? null;
  }

  rebindLaunch(
    agentId: string,
    process: RuntimeBindingProcess,
    nextLaunchId: string | null,
  ): void {
    const binding = this.bindings.get(process.runtime);
    if (!binding) return;
    if (binding.agentId !== agentId || binding.processInstanceId !== process.processInstanceId) return;
    this.bindings.set(process.runtime, Object.freeze({
      ...binding,
      activeLaunchId: nextLaunchId,
    }));
    this.recordTrace("daemon.agent.runtime_binding.rebound", {
      agent_id: agentId,
      server_id: binding.serverId ?? undefined,
      machine_id: binding.machineId ?? undefined,
      initial_launch_id: binding.initialLaunchId ?? undefined,
      previous_active_launch_id: binding.activeLaunchId ?? undefined,
      next_active_launch_id: nextLaunchId ?? undefined,
      active_session_id: binding.activeSessionId ?? undefined,
      process_instance_id: binding.processInstanceId,
      configured_runtime: binding.configuredRuntimeId,
      driver: binding.driverId,
      source: "server_start_rebind",
    });
  }

  rebindSession(
    agentId: string,
    process: RuntimeBindingProcess,
    nextSessionId: string | null,
    source: RuntimeBindingRebindSource,
  ): void {
    const binding = this.bindings.get(process.runtime);
    if (!binding) return;
    if (binding.agentId !== agentId || binding.processInstanceId !== process.processInstanceId) return;
    if (binding.activeSessionId === nextSessionId) return;
    this.bindings.set(process.runtime, Object.freeze({
      ...binding,
      activeSessionId: nextSessionId,
    }));
    this.recordTrace("daemon.agent.runtime_binding.rebound", {
      agent_id: agentId,
      server_id: binding.serverId ?? undefined,
      machine_id: binding.machineId ?? undefined,
      initial_launch_id: binding.initialLaunchId ?? undefined,
      active_launch_id: binding.activeLaunchId ?? undefined,
      start_session_id: binding.startSessionId ?? undefined,
      previous_active_session_id: binding.activeSessionId ?? undefined,
      next_active_session_id: nextSessionId ?? undefined,
      process_instance_id: binding.processInstanceId,
      configured_runtime: binding.configuredRuntimeId,
      driver: binding.driverId,
      source,
    });
  }

  send(
    agentId: string,
    process: RuntimeBindingProcess,
    input: {
      mode: "idle" | "busy";
      text: string;
      sessionId?: string | null;
    },
    source: string,
  ): RuntimeSendResult {
    const validation = this.validate(agentId, process, process.runtime);
    if (!validation.ok) {
      this.recordRejection(
        agentId,
        process,
        process.runtime,
        validation,
        "input",
        source,
        input.sessionId,
      );
      return this.rejectedResult(validation.reason);
    }
    if ((input.sessionId ?? null) !== validation.binding.activeSessionId) {
      const sessionValidation = {
        ok: false as const,
        reason: "session_mismatch" as const,
        binding: validation.binding,
        current: process,
      };
      this.recordRejection(
        agentId,
        process,
        process.runtime,
        sessionValidation,
        "input",
        source,
        input.sessionId,
      );
      return this.rejectedResult("session_mismatch");
    }
    return requireImmediateRuntimeSendResult(process.runtime.send(input), source);
  }

  async start(
    agentId: string,
    process: RuntimeBindingProcess,
    input: { text: string; sessionId?: string | null },
  ): Promise<RuntimeSendResult> {
    const validation = this.validate(agentId, process, process.runtime);
    if (!validation.ok) {
      this.recordRejection(
        agentId,
        process,
        process.runtime,
        validation,
        "input",
        "spawn_prompt",
        input.sessionId,
      );
      return this.rejectedResult(validation.reason);
    }
    if ((input.sessionId ?? null) !== validation.binding.startSessionId) {
      const sessionValidation = {
        ok: false as const,
        reason: "session_mismatch" as const,
        binding: validation.binding,
        current: process,
      };
      this.recordRejection(
        agentId,
        process,
        process.runtime,
        sessionValidation,
        "input",
        "spawn_prompt",
        input.sessionId,
      );
      return this.rejectedResult("session_mismatch");
    }
    return process.runtime.start(input);
  }

  acceptOutput(
    agentId: string,
    process: RuntimeBindingProcess,
    runtime: RuntimeSession,
    source: string,
  ): boolean {
    const validation = this.validate(agentId, process, runtime);
    if (validation.ok) return true;
    this.recordRejection(agentId, process, runtime, validation, "output", source);
    return false;
  }

  recordMissingProcessEvent(
    agentId: string,
    event: ParsedEvent,
    runtimeId: string,
  ): void {
    if (this.getCurrentProcess(agentId)) return;
    this.recordTrace("daemon.agent.event.received_without_process", {
      agentId,
      event_kind: event.kind,
      runtime: runtimeId,
    });
    if (event.kind === "thinking" || event.kind === "text") {
      this.recordTrace("daemon.agent.activity.skipped", {
        agentId,
        event_kind: event.kind,
        reason: "agent_process_missing",
        text_length: event.text.length,
      });
    }
  }

  private validate(
    agentId: string,
    process: RuntimeBindingProcess,
    runtime: RuntimeSession,
  ): RuntimeBindingValidation {
    const binding = this.bindings.get(runtime) ?? null;
    const current = this.getCurrentProcess(agentId);
    if (!binding) {
      return { ok: false, reason: "binding_missing", binding, current };
    }
    if (current !== process) {
      return { ok: false, reason: "inactive_process_generation", binding, current };
    }
    if (process.runtime !== runtime) {
      return { ok: false, reason: "runtime_reference_mismatch", binding, current };
    }
    if (binding.agentId !== agentId) {
      return { ok: false, reason: "agent_mismatch", binding, current };
    }
    const runtimeContext = process.config.runtimeContext;
    if (binding.serverId !== (runtimeContext?.serverId ?? null)) {
      return { ok: false, reason: "server_mismatch", binding, current };
    }
    if (binding.machineId !== (runtimeContext?.machineId ?? null)) {
      return { ok: false, reason: "machine_mismatch", binding, current };
    }
    if (
      binding.configuredRuntimeId !== process.config.runtime
      || binding.driverId !== process.driver.id
    ) {
      return { ok: false, reason: "runtime_mismatch", binding, current };
    }
    if (binding.activeLaunchId !== process.launchId) {
      return { ok: false, reason: "launch_mismatch", binding, current };
    }
    if (binding.activeSessionId !== process.sessionId) {
      return { ok: false, reason: "session_mismatch", binding, current };
    }
    if (binding.processInstanceId !== process.processInstanceId) {
      return { ok: false, reason: "process_instance_mismatch", binding, current };
    }
    return { ok: true, binding };
  }

  private recordRejection(
    agentId: string,
    process: RuntimeBindingProcess,
    runtime: RuntimeSession,
    validation: Exclude<RuntimeBindingValidation, { ok: true }>,
    direction: "input" | "output",
    source: string,
    observedSessionId?: string | null,
  ): void {
    const expectedRuntimeContext = process.config.runtimeContext;
    this.recordTrace("daemon.agent.runtime_binding.rejected", {
      direction,
      source,
      reason: validation.reason,
      expected_agent_id: agentId,
      expected_server_id: expectedRuntimeContext?.serverId,
      expected_machine_id: expectedRuntimeContext?.machineId,
      expected_launch_id: process.launchId || undefined,
      expected_process_instance_id: process.processInstanceId,
      expected_session_id: process.sessionId || undefined,
      bound_agent_id: validation.binding?.agentId,
      bound_server_id: validation.binding?.serverId ?? undefined,
      bound_machine_id: validation.binding?.machineId ?? undefined,
      bound_configured_runtime: validation.binding?.configuredRuntimeId,
      bound_driver: validation.binding?.driverId,
      bound_initial_launch_id: validation.binding?.initialLaunchId ?? undefined,
      bound_active_launch_id: validation.binding?.activeLaunchId ?? undefined,
      bound_start_session_id: validation.binding?.startSessionId ?? undefined,
      bound_active_session_id: validation.binding?.activeSessionId ?? undefined,
      bound_process_instance_id: validation.binding?.processInstanceId,
      current_process_instance_id: validation.current?.processInstanceId,
      current_launch_id: validation.current?.launchId || undefined,
      current_session_id: validation.current?.sessionId || undefined,
      observed_session_id: observedSessionId || undefined,
      configured_runtime: process.config.runtime,
      driver: process.driver.id,
      runtime_transport: runtime.descriptor.transport,
      session_id_present: Boolean(process.sessionId),
      stdin_write_attempted: direction === "input" ? false : undefined,
      output_applied: direction === "output" ? false : undefined,
    }, "error");
  }

  private rejectedResult(reason: RuntimeBindingMismatchReason): RuntimeSendResult {
    return {
      ok: false,
      reason: "runtime_error",
      error: `runtime binding rejected (${reason})`,
    };
  }
}
