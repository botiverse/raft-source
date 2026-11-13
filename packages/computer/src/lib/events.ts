// `@botiverse/raft-computer/lib/events` — the unified Computer interactive
// event surface (event-sink convergence). ALL interactive ComputerApi methods
// (login / attach / start / stop) emit a single discriminated union
// `ComputerApiEvent`, discriminated on `kind: "<method>.<step>"`. The CLI
// presenter and a future menu-bar app consume this ONE surface via a single
// switch.
//
// Wire-naming (RFC v9.8 §5.5): the `kind` discriminator is the wire literal.
// We namespace each former per-method `type` token with a `<method>.` prefix;
// the step token's internal casing is preserved verbatim (kebab like
// `device-code`, snake like `already_attached`). The dotted/underscored shape
// is intentionally outside the kebab-only `kind`-literal naming-gate scope —
// the gate only flags pure-alphanumeric+hyphen wire literals.
//
// Field invariants carried over from the per-method unions (do NOT relax):
//   - login.device-code uses `expiresAt: ISO string` (clock-skew safe) plus a
//     raw server `expiresInSeconds` for the human "expires in Xs" line.
//   - attach.* events are SECRET-FREE: only the 8-char
//     `apiKeyRedactedPrefix` surfaces; the raw sk_computer_* never appears on
//     an event.
//   - start.ready / start.aborted carry the `ready` Map<serverId, pid>; the
//     adapter formats the user-visible summary (service stays env-pure).
//
// `log.line` is the fallback prose variant used by setup / upgrade, which emit
// pre-formatted human lines rather than structured per-step events. Wrapping
// them here keeps a single sink type across every interactive method without
// restructuring setup's internal sub-steps.
//
// Boundary: this union is a method-step/progress sink, by design. Final action
// results belong to each caller's result surface (CLI stdout/stderr, menu
// dialog/toast, onboarding UI state). Do not add action-result event variants
// just for symmetry; first identify a concrete machine-readable consumer
// (for example telemetry, automation, or shared app state) and then extend this
// closed union with that consumer's contract.

export type ComputerApiEvent =
  // --- login (LoginService) ---
  | {
      kind: "login.device-code";
      verifyUrl: string;
      userCode: string;
      // Renderer's source-of-truth for countdown — ISO so it's clock-skew
      // safe across the IPC boundary.
      expiresAt: string;
      // Server-provided integer seconds — kept for adapters that render a
      // human-style "expires in Xs" line (CLI's case).
      expiresInSeconds: number;
    }
  | { kind: "login.polling" }
  | { kind: "login.approved"; userId: string; sessionPath: string }

  // --- attach (AttachService) ---
  | { kind: "attach.attaching"; serverSlug: string }
  | { kind: "attach.preflight"; resumed: boolean }
  // The server is older than one-time attach approvals: it answered the
  // approval with a user session (written like `login` used to), and attach
  // carries on with that session.
  | { kind: "attach.session-fallback"; sessionPath: string }
  | {
      kind: "attach.attached";
      serverId: string;
      serverMachineId: string;
      serverSlug: string;
      attachmentPath: string;
      resumed: boolean;
      apiKeyRedactedPrefix: string;
    }

  // --- start (StartService) ---
  | { kind: "start.starting"; managedTargets: string[]; attachedCount: number; foreground: boolean }
  | { kind: "start.already_running"; servicePid: number; managedTargets: string[]; attachedCount: number }
  | { kind: "start.running"; managedTargets: string[]; attachedCount: number }
  // `supervisorUnit`: started through the systemd unit that owns the service (task #917), not spawned detached.
  | { kind: "start.spawned"; servicePid: number; managedTargets: string[]; attachedCount: number; supervisorUnit?: string }
  // Linux: the detached service will be stopped with the caller's login session (task #37).
  | { kind: "start.logind_session_risk"; risk: { sessionScope: string; user: string; linger: boolean | null } }
  | { kind: "start.ready"; ready: Map<string, number>; managedTargets: string[] }
  // Under the external installer: some runners were ready, the rest never came (acceptPartialReady).
  | { kind: "start.partial_ready"; ready: Map<string, number>; managedTargets: string[]; notReady: string[] }
  // Unscoped start left out attachments the server has unlinked.
  | { kind: "start.skipped_unlinked"; serverIds: string[] }
  | { kind: "start.aborted"; servicePid: number; managedTargets: string[]; ready: Map<string, number> }

  // Best-effort host lifecycle (macOS owner record / leftover LaunchAgent
  // cleanup) did not finish; the start/stop carried on.
  | { kind: "host_lifecycle.skipped"; operation: "start" | "stop"; code: string | null; message: string }

  // --- stop (StopService) ---
  | { kind: "stop.stopping"; pid: number | null }
  | { kind: "stop.not_running" }
  // `otherProgram`: the pid is alive but belongs to another program (reused); it was not signalled.
  | { kind: "stop.stale_pidfile_cleared"; pid: number; otherProgram?: true }
  | { kind: "stop.signaled"; pid: number }
  | { kind: "stop.stopped"; pid: number }

  // --- diagnostics push (DiagnosticsPush) ---
  | { kind: "diagnosticsPush.queued"; correlationId: string }

  // --- prose fallback (setup / upgrade line sinks) ---
  | { kind: "log.line"; line: string };
