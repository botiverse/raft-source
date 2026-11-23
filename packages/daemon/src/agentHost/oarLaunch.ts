// What the OAR host needs to open one launch, per runtime (RFC 060). Adding a
// runtime to the OAR host is one `PrepareOarLaunch` in `OAR_LAUNCHES`
// (oarAgentHost.ts), a `loadOarRuntime` loader, and its server flag.

import type { AvailableInstallation, DeliverWhen, Session, SessionOptions } from "@botiverse/oar";
import type { OarOnlyRuntimeId } from "../drivers/index";
import type { SpawnContext } from "../drivers/types";

export interface OarLaunch {
  /** OAR runtime id (`@botiverse/oar/runtimes/<id>`, loaded through oarLoader). */
  runtimeId: "antigravity" | "claude" | "codex" | "cursor" | "grok" | "opencode" | "pi" | OarOnlyRuntimeId;
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
  /**
   * Every delivery is offered as a prompt first, whatever OAR's status
   * reads; only OAR's `busy` answer makes it a busy delivery (steered per
   * `busyDelivery` where the session can steer, else held for the turn end).
   * OpenCode: after background sub-agents OAR's status never reads idle
   * again (OAR #777), so a status-led delivery would wait forever.
   */
  promptFirst?: true;
  /**
   * Runs the session open (`open`) under a lock the runtime needs, given up
   * when `signal` aborts while it waits. OpenCode: one open at a time per
   * Computer, since first opens on a fresh OpenCode database race on its
   * table creation. None: opened at once.
   */
  openGate?: (open: () => Promise<Session>, signal: AbortSignal) => Promise<Session>;
  /**
   * Runs once the session is open, before its first input (OpenCode: records
   * the OpenCode major line that runs the session, the legacy driver's
   * provenance file). A throw fails the open, and the start is handed back.
   */
  sessionOpened?: (session: Session) => void | Promise<void>;
  /**
   * A resume OAR refuses because the session lives in another directory
   * (`UnsupportedOptionError` on `cwd`) starts a new session on the OAR host
   * instead of handing the start back, with an Activity Log row. OpenCode
   * 2.x: sessions made before #14872 ran with the daemon's `$PWD`, and OAR
   * resumes an OpenCode session only in its own directory.
   */
  newSessionOnResumeElsewhere?: true;
  /**
   * The same, but only when OAR could not find the session at all
   * (`ResumeCwdError` reason `not_listed`, OAR 0.108+). Antigravity: the
   * legacy driver's session id is its own (it resumes with `--continue`), so
   * `agy` never lists it, and handing back kept the agent on the driver for
   * good. Any other cwd refusal is handed back as before.
   */
  newSessionOnResumeNotListed?: true;
}

/**
 * A launch preparation that decides the OAR host should not run this start
 * (an OpenCode version outside the verified range, a session from another
 * OpenCode major): the start is handed back to the legacy host before
 * anything ran, traced with `reason`.
 */
export class OarLaunchDeclined extends Error {
  override readonly name = "OarLaunchDeclined";
  constructor(readonly reason: string, message: string = reason) {
    super(message);
  }
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
