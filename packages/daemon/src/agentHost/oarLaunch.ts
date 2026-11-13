// What the OAR host needs to open one launch, per runtime (RFC 060). Adding a
// runtime to the OAR host is one `PrepareOarLaunch` in `OAR_LAUNCHES`
// (oarAgentHost.ts), a `loadOarRuntime` loader, and its server flag.

import type { AvailableInstallation, DeliverWhen, Session, SessionOptions } from "@botiverse/oar";
import type { OarOnlyRuntimeId } from "../drivers/index";
import type { SpawnContext } from "../drivers/types";

export interface OarLaunch {
  /** OAR runtime id (`@botiverse/oar/runtimes/<id>`, loaded through oarLoader). */
  runtimeId: "antigravity" | "codex" | "cursor" | "grok" | OarOnlyRuntimeId;
  installation: AvailableInstallation;
  /** `resume` is the native session this launch resumes, as the legacy driver would. */
  options: SessionOptions;
  /**
   * How a delivery to a busy session lands: `now` steers; `after_turn` is held
   * by the host and prompted as a new turn after the turn end (never OAR's
   * adapter-held queue, which is out of the host's sight).
   */
  busyDelivery: Extract<DeliverWhen, "now" | "after_turn">;
  /** Codex: the managed MCP server, whose startup its traces report (`oarCodexTraces.ts`). */
  managedMcpServerName?: string;
  /**
   * What the first input waits for once the session is open, as the legacy
   * driver waits (codex: its managed MCP server starting, so the first turn
   * has Raft's tools). Bounded by the launch; the first input goes in on any
   * outcome but `stopped` (the start's `signal`), which the host traces
   * (`daemon.agent.oar.first_input_ready`).
   */
  firstInputReady?: (session: Session, signal: AbortSignal) => Promise<FirstInputReadiness>;
}

export interface FirstInputReadiness {
  /** What was waited for, e.g. `managed_mcp`. */
  waitedFor: string;
  /** `exited`: the runtime process ended while it waited (the first input then fails as it would have). */
  outcome: "ready" | "failed" | "timeout" | "stopped" | "exited";
  waitedMs: number;
}

/** Turns a prepared Raft launch (the same `SpawnContext` a driver gets) into an OAR launch. */
export type PrepareOarLaunch = (ctx: SpawnContext) => Promise<OarLaunch>;
