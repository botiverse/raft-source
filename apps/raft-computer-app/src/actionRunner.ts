// Action runner for the Raft Computer menu-bar app.
//
// The menuModel emits an Action discriminated union when the user clicks
// a MenuNode. This module owns the catalog of actions and the side-effect
// dispatch — given an Action and RunnerDeps (a ComputerApi instance + a
// presenter `notify`/`openUrl` pair), it runs the right `api.method()` and
// surfaces success/failure via the deps. The model never imports lib;
// the runner never imports Electron.
//
// The shape mirrors the CLI's `present()` layer: same ComputerApi calls,
// same `ComputerError` catch, just rendered to dialogs/notifications/menu
// labels instead of stdout. (See CLI presenter in
// `packages/computer/src/output.ts` + `present()`.)
//
// Boundary: `ComputerApiEvent` carries method-step/progress events for
// interactive API methods. Final action results stay on this presenter result
// surface unless there is a named machine-readable consumer for a new event
// family. Reset/doctor/log/open-url style actions are intentionally pure-result
// or local-presenter actions, not missed event-sink cases.

import {
  COMPUTER_DIAGNOSTICS_REVIEW_DETAIL,
  isComputerError,
} from "@botiverse/raft-computer/lib";
import { randomUUID } from "node:crypto";
import type {
  ComputerActionConfirmation,
  ComputerActionAvailability,
  ComputerApi,
  ComputerApiEvent,
  ComputerError,
} from "@botiverse/raft-computer/lib";
import type { Tracer } from "@botiverse/raft-shared";

/**
 * The menu items the user can click. Each variant carries everything the
 * runner needs — no implicit ambient state. New menu items must add a
 * variant here, then handle it in `runAction` (TS exhaustiveness will
 * catch missing handlers).
 */
export type Action =
  | { kind: "login" }
  | { kind: "signOut" }
  | { kind: "startService"; serverId?: string; serverLabel?: string }
  | { kind: "restartService" }
  | { kind: "restartRunner"; serverId: string }
  | { kind: "upgrade"; targetVersion: string }
  | { kind: "viewLog"; path: string }
  | { kind: "runDoctor" }
  | { kind: "diagnosticsPush" }
  | { kind: "openUrl"; url: string }
  | { kind: "refresh" }
  | { kind: "connectWorkspace"; serverId?: string; serverLabel?: string }
  | { kind: "quitApp" }
  | { kind: "toggleLaunchAtLogin"; currentlyEnabled: boolean };

export type ActionInvocation =
  | { action: Action; risk: "safe" }
  | {
      action: Action;
      risk: "confirm";
      confirmation: ComputerActionConfirmation;
    }
  | { action: Action; risk: "destructive" };

export interface OnboardingTarget {
  serverId: string;
  serverLabel?: string | null;
}

export interface RunnerDeps {
  /** ComputerApi bound to this Computer's SLOCK_HOME. */
  api: ComputerApi;
  /** Source-bound trace client (source = "computer.menu-bar"). Action spans
   *  emit through this; created once in main.ts via createComputerTracer. */
  tracer: Tracer;
  /** Presenter — show user-facing message + optional detail body
   *  (e.g. macOS dialog.showMessageBox in the Electron main process). */
  notify: (kind: "info" | "error", message: string, detail?: string) => void;
  /** Open a URL in the user's default browser. */
  openUrl: (url: string) => void;
  /** Write text to the system clipboard (e.g. clipboard.writeText in the
   *  Electron main process). Used to stash the diagnostics correlation id so
   *  the user can paste it to the team. */
  copyToClipboard: (text: string) => void;
  /** Review the redacted diagnostics envelope before any upload is queued.
   *  The presenter lets the user cancel, copy the envelope, or send it. */
  reviewDiagnostics: (message: string, detail: string) => Promise<DiagnosticsReviewChoice>;
  /** Force a state refresh (re-reads `getStatus()` + rebuilds the menu).
   *  Called after every successful mutation so the user sees the new
   *  state immediately without waiting for the polling tick. */
  refresh: () => void | Promise<void>;
  /** Update `AppState.inFlight` so `menuModel`'s service-status row shows
   *  in-progress feedback ("Restarting service…") for the duration of the
   *  action. Called with a label at start, with `null` when the action
   *  completes (success or failure). */
  setInFlight: (label: string | null) => void;
  /** Confirm a kernel `confirm`-risk action. Returns true when the user
   *  approves, false when they cancel. The presenter uses
   *  `dialog.showMessageBox` with two buttons. */
  confirm: (message: string, detail: string) => Promise<boolean>;
  /** Open the onboarding window (Connect workspace / setup flow). */
  openOnboarding: (target?: OnboardingTarget) => void;
  /** Quit the app. */
  quit: () => void;
  /** Toggle macOS launch-at-login. */
  setLaunchAtLogin: (enabled: boolean) => void | Promise<void>;
  /** Runtime action gate from the shared Computer action model. Presenters
   *  pass the current state snapshot so stale menu entries cannot bypass
   *  availability checks. */
  getActionAvailability?: (action: Action) => ComputerActionAvailability;
}

export type DiagnosticsReviewChoice = "cancel" | "copy" | "send";

export const DIAGNOSTICS_REVIEW_DETAIL = COMPUTER_DIAGNOSTICS_REVIEW_DETAIL;

export const DESTRUCTIVE_ACTION_BLOCK_DETAIL =
  "This action requires a stronger confirmation flow that Raft Desktop does not support yet. Nothing was changed.";

/**
 * Short user-visible label for the in-flight banner shown in the service
 * status row while an action is mid-execution. `null` means the action is
 * instantaneous and shouldn't surface a banner (e.g. `openUrl`, `refresh`).
 */
function inFlightLabelFor(action: Action): string | null {
  switch (action.kind) {
    case "signOut":
      return "Signing out…";
    case "restartService":
      return "Restarting service…";
    case "restartRunner":
      return "Restarting runner…";
    case "login":
      return "Signing in…";
    case "startService":
      return "Starting service…";
    case "upgrade":
      return `Upgrading to v${action.targetVersion}…`;
    case "runDoctor":
      return "Running doctor…";
    case "diagnosticsPush":
      return "Preparing diagnostics…";
    case "quitApp":
      return "Quitting…";
    case "openUrl":
    case "viewLog":
    case "refresh":
    case "connectWorkspace":
    case "toggleLaunchAtLogin":
      return null;
  }
}

/**
 * Run a risk-carrying click invocation. Returns when side effects are complete (network round-trip
 * for IPC mutations, browser-launch fork-and-forget for openUrl). Never
 * throws — `ComputerError` is caught and rendered via `deps.notify`.
 *
 * Opens a single `action` span per invocation (surface `computer`, kind
 * `internal`) with `{action, actionId}` attrs, ended in `finally` with the
 * `ok`/`error` outcome (+ `errorCode` on failure) so both success and failure
 * record. The span lands in the same sink as lib's route-decision spans, so
 * the trace shows the click→route→service chain in one stream.
 */
export async function runAction(invocation: ActionInvocation, deps: RunnerDeps): Promise<void> {
  const action = invocation.action;
  const availability = deps.getActionAvailability?.(action);
  if (availability !== undefined && !availability.available) {
    deps.notify(
      "error",
      "Action unavailable",
      availability.message ?? `Action ${availability.id} is not available in the current state.`,
    );
    await deps.refresh();
    return;
  }

  const actionId = randomUUID();
  const span = deps.tracer.startSpan("action", {
    surface: "computer",
    kind: "internal",
    attrs: { action: action.kind, actionId },
  });
  const inFlight = inFlightLabelFor(action);
  let inFlightStarted = false;
  let outcome: "ok" | "error" = "ok";
  let errorCode: string | undefined;
  try {
    if (!(await authorizeActionRisk(invocation, deps))) return;
    if (inFlight !== null) {
      inFlightStarted = true;
      deps.setInFlight(inFlight);
      // Refresh immediately so the menu picks up the new banner before the
      // action's network round-trip completes — otherwise the banner would
      // only appear in the post-action refresh and the user sees nothing
      // during the (possibly multi-second) action.
      await deps.refresh();
    }
    await dispatch(action, deps);
  } catch (err) {
    const e = err as ComputerError | Error;
    const code = isComputerError(e) ? e.code : "UNKNOWN";
    const message = e instanceof Error ? e.message : String(e);
    outcome = "error";
    errorCode = code;
    deps.notify("error", `Action failed`, `${code}: ${message}`);
  } finally {
    if (inFlightStarted) deps.setInFlight(null);
    // End the action span with the outcome (`ok`/`error` is a valid
    // TraceStatus). The span tracks its own duration; `errorCode` rides as an
    // end-time attr on failure.
    span.end(outcome, errorCode !== undefined ? { attrs: { errorCode } } : undefined);
    // Always refresh after an attempt — success and failure both leave the
    // user wanting to see the current state.
    await deps.refresh();
  }
}

async function authorizeActionRisk(
  invocation: ActionInvocation,
  deps: RunnerDeps,
): Promise<boolean> {
  switch (invocation.risk) {
    case "safe":
      return true;
    case "destructive":
      deps.notify("error", "Action unavailable", DESTRUCTIVE_ACTION_BLOCK_DETAIL);
      return false;
    case "confirm": {
      const { action, confirmation } = invocation;
      if (action.kind !== "diagnosticsPush") {
        return deps.confirm(confirmation.message, confirmation.detail);
      }

      const reviewChoice = await deps.reviewDiagnostics(
        confirmation.message,
        confirmation.detail,
      );
      if (reviewChoice === "send") return true;
      if (reviewChoice === "copy") {
        deps.copyToClipboard(confirmation.detail);
        deps.notify("info", "Diagnostics details copied");
      }
      return false;
    }
  }
}

async function dispatch(action: Action, deps: RunnerDeps): Promise<void> {
  switch (action.kind) {
    case "openUrl":
      deps.openUrl(action.url);
      return;
    case "refresh":
      // Refresh is the no-op action — `runAction`'s finally already
      // refreshes. Fall through.
      return;
    case "signOut":
      await deps.api.logout((event) => onApiEvent(event, deps));
      return;
    case "restartService": {
      const result = await deps.api.resetService();
      deps.notify(
        "info",
        "Service restarted",
        `Was ${result.previousState}. Cleared ${result.clearedCrashCount} crash entries.`,
      );
      return;
    }
    case "restartRunner": {
      const result = await deps.api.resetRunner(action.serverId);
      if (result.status === "not-found") {
        deps.notify("error", "Restart runner failed", `Server ${result.serverId.slice(0, 8)}… is not attached.`);
        return;
      }
      deps.notify(
        "info",
        "Runner restarted",
        `Was ${result.previousState}. Cleared ${result.clearedCrashCount} crash entries.`,
      );
      return;
    }
    case "login": {
      const result = await deps.api.login({}, (event) => onApiEvent(event, deps));
      deps.notify("info", "Signed in", `User ${result.userId.slice(0, 8)}…`);
      return;
    }
    case "startService": {
      const result = await deps.api.start(
        { serverId: action.serverId ?? null, serverLabel: action.serverLabel ?? null },
        (event) => onApiEvent(event, deps),
      );
      deps.notify(
        "info",
        "Service started",
        `Managing ${result.managedTargets.length} of ${result.attachedCount} attached server(s).`,
      );
      return;
    }
    case "viewLog": {
      // file:// URLs let the user's default text editor open the path on
      // double-click; no need to embed log contents in a dialog.
      deps.openUrl(`file://${action.path}`);
      return;
    }
    case "runDoctor": {
      const report = await deps.api.doctor({});
      const summary = report.checks
        .map((c) => `${c.ok ? "✓" : "✗"} ${c.name}${c.detail ? `\n   ${c.detail}` : ""}`)
        .join("\n");
      deps.notify(
        report.allOk ? "info" : "error",
        report.allOk ? "Doctor: all checks passed" : "Doctor: issues found",
        summary,
      );
      return;
    }
    case "diagnosticsPush": {
      const result = await deps.api.diagnosticsPush({}, (event) => onApiEvent(event, deps));
      if (result.status === "queued") {
        // HONESTY CONTRACT: the bundle is QUEUED, not uploaded — the real
        // upload happens later on the worker's periodic cycle. Never say
        // "synced"/"uploaded"/"done". Copy the correlationId so the user can
        // hand the team a lookup id even though the upload is still pending.
        // Do not show a second modal after the review dialog; a successful send
        // should return the user to the app.
        deps.copyToClipboard(result.correlationId);
      } else {
        // Fail-closed: an honest closed reason, NOT a fake/dead id. Nothing
        // was queued, so nothing will upload. NO_RUNNER is the common case
        // (no running runner = no uploader to carry the bundle) — give it an
        // actionable line instead of the raw enum.
        const baseDetail =
          result.reason === "NO_RUNNER"
            ? "No running runner to carry the upload. Start the service (so a runner is online), then try Sync diagnostics again. Nothing was uploaded."
            : `Could not queue diagnostics (${result.reason}). Nothing was uploaded.`;
        const detail = result.localBundle
          ? `${baseDetail}\n\nA local redacted diagnostics bundle was saved and its path was copied to the clipboard:\n${result.localBundle.path}`
          : baseDetail;
        if (result.localBundle) deps.copyToClipboard(result.localBundle.path);
        deps.notify("error", "Diagnostics sync unavailable", detail);
      }
      return;
    }
    case "connectWorkspace":
      deps.openOnboarding(
        action.serverId === undefined
          ? undefined
          : { serverId: action.serverId, serverLabel: action.serverLabel ?? null },
      );
      return;
    case "quitApp": {
      await deps.api.stop((event) => onApiEvent(event, deps));
      deps.quit();
      return;
    }
    case "toggleLaunchAtLogin":
      await deps.setLaunchAtLogin(!action.currentlyEnabled);
      return;
    case "upgrade": {
      // Prefer routing through a live service (single-writer): the service
      // drives K's download/verify/promote/restart transaction. When the
      // service is stopped, start it before retrying the same exact target;
      // the deleted legacy standalone executor must not re-enter the graph.
      // A live-but-unreachable service still fails loud because swapping
      // under the running process would strand it on old bytes.
      let routed = await deps.api.tryUpgradeViaService(
        action.targetVersion,
        (event) => onApiEvent(event, deps),
        { trigger: "tray" },
      );
      if (!routed.routed && routed.reason === "no-service") {
        // The legacy standalone Computer executor is gone: K owns the
        // transaction and must run in the resident service. Bring a stopped
        // service online, then retry the exact target through the same IPC
        // seam used by an already-running service.
        await deps.api.start(
          { serverId: null, serverLabel: null },
          (event) => onApiEvent(event, deps),
        );
        routed = await deps.api.tryUpgradeViaService(
          action.targetVersion,
          (event) => onApiEvent(event, deps),
          { trigger: "tray" },
        );
      }
      if (!routed.routed) {
        deps.notify(
          "error",
          "Service unreachable",
          "A Computer service is running but its control socket couldn't be reached, so the " +
            "upgrade couldn't be applied. Restart the service (Restart Service) and try again.",
        );
        return;
      }
      // The service emits a `log.line` "started" / "already-running" via
      // onEvent; the actual self-swap completes asynchronously inside the
      // supervisor and the menu-bar discovers the new version on the next
      // status poll. No blocking dialog here.
      return;
    }
  }
  // Exhaustiveness check — TS will fail compilation if a new Action
  // variant is added without a case above.
  const _exhaustive: never = action;
  void _exhaustive;
}

/**
 * Render a `ComputerApiEvent` (the unified sink Yingjun's #3212 lands —
 * `<method>.<step>` discriminator covering login/attach/start/stop
 * + `log.line` for setup/upgrade prose). The presenter maps each kind to
 * the menu-bar's surface — a system dialog for blocking choices (the
 * device-code approve URL), a transient notify for progress steps, and an
 * `openUrl` for the verify URL so the user can approve in their browser
 * without leaving the menu.
 *
 * Safe-default unknown kinds: any future-added event kind that this
 * switch doesn't handle yet falls through silently — adding a new kind
 * shouldn't break older menu-bar builds.
 */
function onApiEvent(event: ComputerApiEvent, deps: RunnerDeps): void {
  switch (event.kind) {
    case "login.device-code":
      // Open the verify URL. The lib prefers `verificationUriComplete`
      // (RFC 8628), which already has `user_code` baked in by the server,
      // so we must NOT append another `?user_code=` — doing so produced
      // a malformed URL like `device?user_code=ABC?user_code=ABC`
      // (#wg-raft-computer:f2a02081 bug 1 RCA). Surface a dialog with
      // the literal code in case the URL launch fails (corp browser
      // intercept etc.).
      deps.openUrl(event.verifyUrl);
      deps.notify(
        "info",
        "Approve in your browser",
        `If a browser tab didn't open, visit:\n${event.verifyUrl}\nUser code: ${event.userCode}`,
      );
      return;
    case "login.polling":
      // Quiet step — the device-code dialog already told the user to
      // approve in browser; no need to spam a second toast.
      return;
    case "login.approved":
      // Success toast happens at the action level (login: "Signed in") —
      // don't double-emit here.
      return;
    case "start.starting":
    case "start.already_running":
    case "start.running":
    case "start.spawned":
    case "start.aborted":
      // Start sub-steps are intermediate and the action-level summary
      // ("Service started: managing N of M") is the user-visible payload.
      // Quiet sub-steps to avoid toast pile-up.
      return;
    case "start.ready":
      // Same — action-level summary covers it.
      return;
    case "diagnosticsPush.queued":
      // Quiet step — diagnostics success is intentionally modal-free after the
      // user confirms the review dialog.
      return;
    case "log.line":
      if (event.line.startsWith("Diagnostics queued.")) {
        // diagnosticsPush emits both a typed diagnosticsPush.queued event and
        // this prose fallback for non-menu presenters. Surfacing this line here
        // creates two dialogs for one click.
        return;
      }
      // setup / upgrade prose. The supervisor-driven upgrade emits
      // started / already-running here; surface as a transient info toast
      // so the user sees progress without blocking.
      deps.notify("info", event.line);
      return;
    default:
      // Attach / stop variants don't have menu-bar v0 actions
      // (attach is dashboard-redirect; stop has no menu entry yet).
      // Future-add events fall through silently.
      return;
  }
}
