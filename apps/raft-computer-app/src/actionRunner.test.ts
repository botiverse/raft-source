import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import {
  DESTRUCTIVE_ACTION_BLOCK_DETAIL,
  DIAGNOSTICS_REVIEW_DETAIL,
  runAction as runActionWithRisk,
  type Action,
  type ActionInvocation,
  type DiagnosticsReviewChoice,
  type RunnerDeps,
} from "./actionRunner.js";
import {
  ComputerError,
  getComputerActionConfirmation,
  type ComputerApi,
  type ComputerApiEvent,
  type ComputerSurfaceAction,
} from "@botiverse/raft-computer/lib";
import {
  noopTracer,
  type ActiveSpan,
  type EndSpanOptions,
  type StartSpanOptions,
  type TraceContext,
  type TraceStatus,
  type Tracer,
} from "@botiverse/raft-shared";

/** Records every span open/close so tests can assert the action trace shape:
 *  one "action" span per runAction, surface/kind/attrs at open, status +
 *  errorCode at close. Mirrors how lib's route-decision spans land in the same
 *  sink — the menu-bar click is the head of that trace. */
interface RecordedSpan {
  name: string;
  options: StartSpanOptions;
  ended: boolean;
  endStatus: TraceStatus | undefined;
  endOptions: EndSpanOptions | undefined;
}

class RecordingTracer implements Tracer {
  spans: RecordedSpan[] = [];
  startSpan(name: string, options: StartSpanOptions): ActiveSpan {
    const rec: RecordedSpan = {
      name,
      options,
      ended: false,
      endStatus: undefined,
      endOptions: undefined,
    };
    this.spans.push(rec);
    const context: TraceContext = {
      traceId: "0".repeat(32),
      spanId: "0".repeat(16),
      parentSpanId: null,
      traceFlags: "00",
    };
    return {
      context,
      addEvent: () => {},
      end: (status?: TraceStatus, options?: EndSpanOptions) => {
        rec.ended = true;
        rec.endStatus = status;
        rec.endOptions = options;
      },
    };
  }
}

interface RecordedNotify {
  kind: "info" | "error";
  message: string;
  detail: string | undefined;
}

function assertActionAttrs(attrs: Record<string, unknown> | undefined, action: string): void {
  assert.ok(attrs);
  assert.equal(attrs.action, action);
  assert.equal(typeof attrs.actionId, "string");
  assert.match(
    attrs.actionId as string,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
}

class StubApi {
  resetServiceCalls = 0;
  resetRunnerCalls: string[] = [];
  logoutCalls = 0;
  loginCalls = 0;
  startCalls = 0;
  startCallArgs: Array<{ foreground?: boolean; serverId?: string | null; serverLabel?: string | null }> = [];
  stopCalls = 0;
  tryUpgradeCalls: Array<string | undefined> = [];
  tryUpgradeTriggers: Array<"cli" | "web" | "tray" | undefined> = [];
  resetServiceImpl: () => Promise<{
    status: "ok";
    previousState: "running" | "degraded" | "stopped";
    clearedCrashCount: number;
  }> = async () => ({ status: "ok", previousState: "running", clearedCrashCount: 0 });
  resetRunnerImpl: (
    serverId: string,
  ) => Promise<
    | { status: "ok"; serverId: string; previousState: "running" | "degraded" | "stopped"; clearedCrashCount: number }
    | { status: "not-found"; serverId: string }
  > = async (serverId: string) => ({
    status: "ok",
    serverId,
    previousState: "running",
    clearedCrashCount: 0,
  });
  loginImpl: (
    onEvent?: (event: ComputerApiEvent) => void,
  ) => Promise<{ userId: string; sessionPath: string; serverUrl: string }> = async (onEvent) => {
    onEvent?.({
      kind: "login.device-code",
      // Realistic shape: lib emits the server's `verificationUriComplete`
      // which already has `?user_code=...` baked in (RFC 8628, server
      // pin: `packages/server/src/routes/deviceAuth.api.test.ts:151`).
      // The earlier fixture used a bare URL with no query string, which
      // hid bug 1 (#wg-raft-computer:f2a02081): actionRunner appended a
      // second `?user_code=...` producing a malformed URL on real
      // servers. Pinning the realistic shape here means the bug would
      // surface as a doubled `?user_code=` in the openUrls assertion.
      verifyUrl: "https://example.test/login/device?user_code=ABC-123",
      userCode: "ABC-123",
      expiresAt: "2026-06-20T05:00:00Z",
      expiresInSeconds: 600,
    });
    onEvent?.({ kind: "login.polling" });
    onEvent?.({ kind: "login.approved", userId: "user-12345-abcd-…", sessionPath: "/tmp/x" });
    return { userId: "user-12345-abcd-…", sessionPath: "/tmp/x", serverUrl: "https://api.example.test" };
  };
  startImpl: (
    opts?: { foreground?: boolean; serverId?: string | null; serverLabel?: string | null },
    onEvent?: (event: ComputerApiEvent) => void,
  ) => Promise<{ managedTargets: string[]; attachedCount: number }> = async (opts, onEvent) => {
    onEvent?.({
      kind: "start.spawned",
      servicePid: 4242,
      managedTargets: [opts?.serverId ?? "a"],
      attachedCount: 1,
    });
    return { managedTargets: [opts?.serverId ?? "a"], attachedCount: 1 };
  };
  stopImpl: (
    onEvent?: (event: ComputerApiEvent) => void,
  ) => Promise<{ status: "not_running" | "stale_pidfile_cleared" | "stopped"; pid?: number; pidfilePath: string }> = async (onEvent) => {
    onEvent?.({ kind: "stop.stopping", pid: 4242 });
    onEvent?.({ kind: "stop.signaled", pid: 4242 });
    onEvent?.({ kind: "stop.stopped", pid: 4242 });
    return { status: "stopped", pid: 4242, pidfilePath: "/tmp/service.pid" };
  };
  tryUpgradeImpl: (
    targetVersion: string | undefined,
    onEvent?: (event: ComputerApiEvent) => void,
  ) => Promise<{ routed: true } | { routed: false; reason: "no-service" | "unreachable" }> = async (_t, onEvent) => {
    onEvent?.({ kind: "log.line", line: "Upgrade started; the supervisor will swap and restart shortly." });
    return { routed: true };
  };
  doctorCalls: Array<{ serverId?: string }> = [];
  doctorImpl: (opts: { serverId?: string }) => Promise<{
    checks: { name: string; ok: boolean; detail: string }[];
    allOk: boolean;
    cleanup: null;
    crashes: { at: string; exitCode: number | null; signal: string | null }[];
  }> = async () => ({ checks: [{ name: "service", ok: true, detail: "" }], allOk: true, cleanup: null, crashes: [] });
  diagnosticsPushCalls = 0;
  logoutEventsDelivered: ComputerApiEvent[] = [];
  diagnosticsPushImpl: (
    onEvent?: (event: ComputerApiEvent) => void,
  ) => Promise<
    | { status: "queued"; correlationId: string; expectedWindowSec: number }
    | {
        status: "failed";
        reason: "OFFLINE" | "NO_TRACE_DIR" | "UPLOAD_DISABLED" | "NO_RUNNER";
        localBundle?: { bundleId: string; path: string; sizeBytes: number };
      }
  > = async (onEvent) => {
    onEvent?.({ kind: "diagnosticsPush.queued", correlationId: "corr-12345" });
    onEvent?.({
      kind: "log.line",
      line: "Diagnostics queued. Correlation id corr-12345. The next upload pass picks it up within ~300s.",
    });
    return { status: "queued", correlationId: "corr-12345", expectedWindowSec: 300 };
  };

  async resetService(): Promise<ReturnType<StubApi["resetServiceImpl"]>> {
    this.resetServiceCalls += 1;
    return this.resetServiceImpl();
  }
  async resetRunner(serverId: string): Promise<ReturnType<StubApi["resetRunnerImpl"]>> {
    this.resetRunnerCalls.push(serverId);
    return this.resetRunnerImpl(serverId);
  }
  async logout(
    onEvent?: (event: ComputerApiEvent) => void,
  ): Promise<{ status: "ok" } | { status: "not-signed-in" }> {
    this.logoutCalls += 1;
    const events: ComputerApiEvent[] = [
      { kind: "stop.stopping", pid: 4242 },
      { kind: "stop.signaled", pid: 4242 },
      { kind: "stop.stopped", pid: 4242 },
    ];
    for (const event of events) {
      onEvent?.(event);
      if (onEvent !== undefined) this.logoutEventsDelivered.push(event);
    }
    return { status: "ok" };
  }
  async login(
    _opts: { serverUrl?: string },
    onEvent?: (event: ComputerApiEvent) => void,
  ): Promise<ReturnType<StubApi["loginImpl"]>> {
    this.loginCalls += 1;
    return this.loginImpl(onEvent);
  }
  async start(
    opts: { foreground?: boolean; serverId?: string | null; serverLabel?: string | null },
    onEvent?: (event: ComputerApiEvent) => void,
  ): Promise<ReturnType<StubApi["startImpl"]>> {
    this.startCalls += 1;
    this.startCallArgs.push(opts);
    return this.startImpl(opts, onEvent);
  }
  async stop(
    onEvent?: (event: ComputerApiEvent) => void,
  ): Promise<ReturnType<StubApi["stopImpl"]>> {
    this.stopCalls += 1;
    return this.stopImpl(onEvent);
  }
  async doctor(opts: { cleanup?: boolean; serverId?: string; serverLabel?: string }): Promise<ReturnType<StubApi["doctorImpl"]>> {
    const c: { serverId?: string } = {};
    if (opts.serverId !== undefined) c.serverId = opts.serverId;
    this.doctorCalls.push(c);
    return this.doctorImpl(opts);
  }
  async tryUpgradeViaService(
    targetVersion: string | undefined,
    onEvent?: (event: ComputerApiEvent) => void,
    opts?: { trigger?: "cli" | "web" | "tray" },
  ): Promise<{ routed: true } | { routed: false; reason: "no-service" | "unreachable" }> {
    this.tryUpgradeCalls.push(targetVersion);
    this.tryUpgradeTriggers.push(opts?.trigger);
    return this.tryUpgradeImpl(targetVersion, onEvent);
  }
  async diagnosticsPush(
    _opts: {},
    onEvent?: (event: ComputerApiEvent) => void,
  ): Promise<ReturnType<StubApi["diagnosticsPushImpl"]>> {
    this.diagnosticsPushCalls += 1;
    return this.diagnosticsPushImpl(onEvent);
  }
  // Other methods unused in these tests; stubbed to throw so a stray call
  // surfaces as a real test failure.
  getStatus = (): never => {
    throw new Error("getStatus not stubbed");
  };
}

interface Recorder {
  /** Cross-cutting presenter order used to pin confirmation before banners. */
  callOrder: string[];
  notifies: RecordedNotify[];
  openUrls: string[];
  /** Text passed to `copyToClipboard`, in order (diagnosticsPush stashes the
   *  correlationId here). */
  clipboardWrites: string[];
  /** Diagnostics review prompts captured before a bundle can be queued. */
  diagnosticsReviews: { message: string; detail: string }[];
  /** What `reviewDiagnostics` should return next. Default send. */
  diagnosticsReviewAnswer: DiagnosticsReviewChoice;
  refreshes: number;
  /** In-flight labels in the order setInFlight was called. The runner
   *  always pairs `setInFlight(label)` at start with `setInFlight(null)`
   *  in finally, so the sequence pins both calls — no banner orphaned on
   *  error. */
  inFlightCalls: (string | null)[];
  /** Confirm prompts captured in order; tests can override `confirmAnswer`. */
  confirms: { message: string; detail: string }[];
  /** What `confirm` should return next. Default true (proceed). */
  confirmAnswer: boolean;
  openOnboardingCalls: number;
  openOnboardingTargets: Array<{ serverId: string; serverLabel?: string | null } | undefined>;
  quitCalls: number;
  launchAtLoginCalls: boolean[];
  deps: RunnerDeps;
  api: StubApi;
}

async function makeRecorder(tracer: Tracer = noopTracer): Promise<Recorder> {
  const stub = new StubApi();
  const r: Recorder = {
    callOrder: [],
    notifies: [],
    openUrls: [],
    clipboardWrites: [],
    diagnosticsReviews: [],
    diagnosticsReviewAnswer: "send",
    refreshes: 0,
    inFlightCalls: [],
    confirms: [],
    confirmAnswer: true,
    openOnboardingCalls: 0,
    openOnboardingTargets: [],
    quitCalls: 0,
    launchAtLoginCalls: [],
    api: stub,
    deps: {
      api: stub as unknown as ComputerApi,
      tracer,
      notify: (kind, message, detail) => {
        r.notifies.push({ kind, message, detail });
      },
      openUrl: (url) => {
        r.openUrls.push(url);
      },
      copyToClipboard: (text) => {
        r.clipboardWrites.push(text);
      },
      reviewDiagnostics: async (message, detail) => {
        r.callOrder.push("reviewDiagnostics");
        r.diagnosticsReviews.push({ message, detail });
        return r.diagnosticsReviewAnswer;
      },
      refresh: () => {
        r.refreshes += 1;
      },
      setInFlight: (label) => {
        r.callOrder.push(`inFlight:${label ?? "clear"}`);
        r.inFlightCalls.push(label);
      },
      confirm: async (message, detail) => {
        r.callOrder.push("confirm");
        r.confirms.push({ message, detail });
        return r.confirmAnswer;
      },
      openOnboarding: (target) => {
        r.openOnboardingCalls += 1;
        r.openOnboardingTargets.push(target);
      },
      quit: () => {
        r.quitCalls += 1;
      },
      setLaunchAtLogin: (enabled) => {
        r.launchAtLoginCalls.push(enabled);
      },
    },
  };
  return r;
}

async function runTestAction(action: Action, deps: RunnerDeps): Promise<void> {
  await runActionWithRisk(testInvocation(action), deps);
}

function testInvocation(action: Action): ActionInvocation {
  const confirmAction = confirmSurfaceAction(action);
  if (confirmAction === null) return { action, risk: "safe" };
  return {
    action,
    risk: "confirm",
    confirmation: getComputerActionConfirmation(confirmAction),
  };
}

function confirmSurfaceAction(action: Action): ComputerSurfaceAction | null {
  switch (action.kind) {
    case "signOut":
      return { kind: "sign-out", risk: "confirm" };
    case "restartService":
      return { kind: "restart-service", risk: "confirm" };
    case "restartRunner":
      return { kind: "restart-runner", risk: "confirm", serverId: action.serverId };
    case "upgrade":
      return { kind: "upgrade", risk: "confirm", targetVersion: action.targetVersion };
    case "diagnosticsPush":
      return { kind: "diagnostics-push", risk: "confirm" };
    case "quitApp":
      return { kind: "quit-app", risk: "confirm" };
    default:
      return null;
  }
}

describe("runAction — pure-result actions", () => {
  test("openUrl: forwards to deps.openUrl + refreshes; no in-flight banner (instantaneous)", async () => {
    const r = await makeRecorder();
    await runTestAction({ kind: "openUrl", url: "https://example.test/x" }, r.deps);
    assert.deepEqual(r.openUrls, ["https://example.test/x"]);
    assert.equal(r.refreshes, 1);
    assert.equal(r.notifies.length, 0);
    assert.deepEqual(r.inFlightCalls, [], "openUrl must not raise an in-flight banner");
  });

  test("refresh: triggers refresh exactly once (the noop action), no in-flight banner", async () => {
    const r = await makeRecorder();
    await runTestAction({ kind: "refresh" }, r.deps);
    assert.equal(r.refreshes, 1);
    assert.deepEqual(r.inFlightCalls, []);
  });

  test("signOut: confirms before logout; on OK logs out without a success dialog", async () => {
    const r = await makeRecorder();
    await runTestAction({ kind: "signOut" }, r.deps);
    assert.deepEqual(r.confirms, [{
      message: "Sign out of Raft Desktop?",
      detail:
        "This disconnects every workspace Computer on this device (they go offline). Your attachments are kept — sign in again to bring the same Computers back online.",
    }]);
    assert.equal(r.api.logoutCalls, 1);
    // Regression: signOut must pass the unified ComputerApiEvent sink into
    // api.logout, whose implementation stops the service and emits stop.*
    // method-step events. actionRunner keeps those quiet, but they must arrive.
    assert.deepEqual(
      r.api.logoutEventsDelivered.map((event) => event.kind),
      ["stop.stopping", "stop.signaled", "stop.stopped"],
    );
    assert.equal(r.notifies.length, 0);
    assert.deepEqual(r.inFlightCalls, ["Signing out…", null]);
    assert.equal(r.refreshes, 2);
  });

  test("signOut: confirm cancel → no logout, no notify", async () => {
    const r = await makeRecorder();
    r.confirmAnswer = false;
    await runTestAction({ kind: "signOut" }, r.deps);
    assert.equal(r.confirms.length, 1);
    assert.equal(r.api.logoutCalls, 0);
    assert.equal(r.notifies.length, 0);
    assert.deepEqual(r.inFlightCalls, [], "cancel must happen before the in-flight banner");
    assert.equal(r.refreshes, 1);
  });

  test("restartService: calls api.resetService + reports previousState/clearedCrashCount", async () => {
    const r = await makeRecorder();
    r.api.resetServiceImpl = async () => ({
      status: "ok",
      previousState: "degraded",
      clearedCrashCount: 3,
    });
    await runTestAction({ kind: "restartService" }, r.deps);
    assert.equal(r.api.resetServiceCalls, 1);
    assert.equal(r.notifies.length, 1);
    assert.equal(r.notifies[0]?.kind, "info");
    assert.equal(r.notifies[0]?.message, "Service restarted");
    assert.match(r.notifies[0]?.detail ?? "", /Was degraded/);
    assert.match(r.notifies[0]?.detail ?? "", /Cleared 3 crash entries/);
    // setInFlight(label) at start, refresh, then setInFlight(null) in
    // finally, then post-action refresh. Two refreshes total — one for
    // showing the banner, one for showing the post-mutation state.
    assert.deepEqual(r.inFlightCalls, ["Restarting service…", null]);
    assert.equal(r.refreshes, 2);
  });

  test("runtime action gate rejects unavailable actions before ComputerApi dispatch", async () => {
    const r = await makeRecorder();
    r.deps.getActionAvailability = () => ({
      id: "restartService",
      descriptor: {
        id: "restartService",
        route: "service-dispatch",
        steadyStateMutation: true,
        bootstrapException: false,
      },
      available: false,
      reason: "service-stopped",
      message: "The Raft Desktop service is not running.",
    });

    await runTestAction({ kind: "restartService" }, r.deps);

    assert.equal(r.api.resetServiceCalls, 0);
    assert.deepEqual(r.notifies, [{
      kind: "error",
      message: "Action unavailable",
      detail: "The Raft Desktop service is not running.",
    }]);
    assert.deepEqual(r.inFlightCalls, []);
    assert.deepEqual(r.confirms, [], "availability rejection must happen before confirmation");
    assert.equal(r.refreshes, 1);
  });

  test("restartRunner: calls api.resetRunner + reports success + banner", async () => {
    const r = await makeRecorder();
    r.api.resetRunnerImpl = async (serverId) => ({
      status: "ok",
      serverId,
      previousState: "degraded",
      clearedCrashCount: 5,
    });
    await runTestAction({ kind: "restartRunner", serverId: "11111111-1111-4111-8111-111111111111" }, r.deps);
    assert.deepEqual(r.confirms, [{
      message: "Restart this workspace runner?",
      detail:
        "Raft Desktop will restart the runner for server 11111111…. Agents on this workspace will briefly go offline until the connection recovers.",
    }]);
    assert.deepEqual(r.api.resetRunnerCalls, ["11111111-1111-4111-8111-111111111111"]);
    assert.equal(r.notifies[0]?.message, "Runner restarted");
    assert.match(r.notifies[0]?.detail ?? "", /Was degraded/);
    assert.deepEqual(r.inFlightCalls, ["Restarting runner…", null]);
    assert.deepEqual(r.callOrder.slice(0, 2), ["confirm", "inFlight:Restarting runner…"]);
  });

  test("restartRunner: confirm cancel → no reset and no in-flight banner", async () => {
    const r = await makeRecorder();
    r.confirmAnswer = false;

    await runTestAction({ kind: "restartRunner", serverId: "11111111-1111-4111-8111-111111111111" }, r.deps);

    assert.equal(r.confirms.length, 1);
    assert.deepEqual(r.api.resetRunnerCalls, []);
    assert.deepEqual(r.inFlightCalls, []);
    assert.equal(r.refreshes, 1);
  });

  test("restartRunner: not-found result surfaces as ERROR notify, banner still cleared", async () => {
    const r = await makeRecorder();
    r.api.resetRunnerImpl = async (serverId) => ({ status: "not-found", serverId });
    await runTestAction({ kind: "restartRunner", serverId: "77777777-7777-4777-8777-777777777777" }, r.deps);
    assert.equal(r.notifies[0]?.kind, "error");
    assert.equal(r.notifies[0]?.message, "Restart runner failed");
    assert.match(r.notifies[0]?.detail ?? "", /77777777…/);
    assert.deepEqual(r.inFlightCalls, ["Restarting runner…", null]);
  });

  test("api throws → error notify with code/message; in-flight banner still cleared, refresh still runs", async () => {
    const r = await makeRecorder();
    r.api.resetServiceImpl = async () => {
      throw new ComputerError("RESET_SERVICE_FAILED", "fake disk write failure");
    };
    await runTestAction({ kind: "restartService" }, r.deps);
    assert.equal(r.notifies.length, 1);
    assert.equal(r.notifies[0]?.kind, "error");
    assert.match(r.notifies[0]?.detail ?? "", /RESET_SERVICE_FAILED/);
    // Banner is cleared even on error — finally runs.
    assert.deepEqual(r.inFlightCalls, ["Restarting service…", null]);
    assert.equal(r.refreshes, 2);
  });
});

describe("runAction — shared risk adapter", () => {
  test("future confirm action uses shared generic copy and cancel fails safe", async () => {
    const r = await makeRecorder();
    r.confirmAnswer = false;
    const action: Action = { kind: "runDoctor" };

    await runActionWithRisk({
      action,
      risk: "confirm",
      confirmation: getComputerActionConfirmation({ kind: "run-doctor", risk: "safe" }),
    }, r.deps);

    assert.deepEqual(r.confirms, [{
      message: "Confirm this Raft Desktop action?",
      detail: "Raft Desktop requires confirmation before running “run-doctor”.",
    }]);
    assert.equal(r.api.doctorCalls.length, 0);
    assert.deepEqual(r.inFlightCalls, []);
    assert.equal(r.refreshes, 1);
  });

  test("destructive risk fails closed before confirmation, banner, or API dispatch", async () => {
    const r = await makeRecorder();

    await runActionWithRisk({
      action: { kind: "runDoctor" },
      risk: "destructive",
    }, r.deps);

    assert.deepEqual(r.confirms, []);
    assert.deepEqual(r.diagnosticsReviews, []);
    assert.equal(r.api.doctorCalls.length, 0);
    assert.deepEqual(r.inFlightCalls, []);
    assert.deepEqual(r.notifies, [{
      kind: "error",
      message: "Action unavailable",
      detail: DESTRUCTIVE_ACTION_BLOCK_DETAIL,
    }]);
    assert.equal(r.refreshes, 1);
  });
});

describe("runAction — event-y actions (post sink-converge)", () => {
  test("login: drives api.login + opens device-code URL + surfaces approve dialog + signed-in toast", async () => {
    const r = await makeRecorder();
    await runTestAction({ kind: "login" }, r.deps);
    assert.equal(r.api.loginCalls, 1);
    // device-code event opens the verify URL as-is (the lib emits
    // `verificationUriComplete` with `user_code` baked in by the server).
    assert.equal(r.openUrls.length, 1);
    assert.equal(r.openUrls[0], "https://example.test/login/device?user_code=ABC-123");
    // Regression pin for #wg-raft-computer:f2a02081 bug 1: the opened URL
    // must NOT have the `?user_code=` query parameter duplicated.
    assert.equal((r.openUrls[0]!.match(/[?&]user_code=/g) ?? []).length, 1,
      "verify URL must contain exactly one user_code param, never a doubled `?user_code=...?user_code=...` form");
    // First notify is the "Approve in your browser" dialog from device-code,
    // then the post-action "Signed in" toast.
    assert.equal(r.notifies[0]?.kind, "info");
    assert.match(r.notifies[0]?.message ?? "", /Approve in your browser/);
    assert.match(r.notifies[0]?.detail ?? "", /User code: ABC-123/);
    assert.equal(r.notifies[1]?.kind, "info");
    assert.equal(r.notifies[1]?.message, "Signed in");
    // login.polling and login.approved are intentionally quiet (action-level
    // toast covers the success path).
    assert.deepEqual(r.inFlightCalls, ["Signing in…", null]);
  });

  test("startService: drives api.start + reports managed-target summary", async () => {
    const r = await makeRecorder();
    await runTestAction({ kind: "startService" }, r.deps);
    assert.equal(r.api.startCalls, 1);
    assert.deepEqual(r.api.startCallArgs, [{ serverId: null, serverLabel: null }]);
    assert.equal(r.notifies[0]?.message, "Service started");
    assert.match(r.notifies[0]?.detail ?? "", /Managing 1 of 1/);
    // start.spawned is intentionally quiet — action-level summary covers it.
    assert.deepEqual(r.inFlightCalls, ["Starting service…", null]);
  });

  test("startService: scopes recovery to selected server when provided", async () => {
    const r = await makeRecorder();
    await runTestAction({ kind: "startService", serverId: "server-a", serverLabel: "alpha" }, r.deps);
    assert.equal(r.api.startCalls, 1);
    assert.deepEqual(r.api.startCallArgs, [{ serverId: "server-a", serverLabel: "alpha" }]);
    assert.equal(r.notifies[0]?.message, "Service started");
    assert.match(r.notifies[0]?.detail ?? "", /Managing 1 of 1/);
  });

  test("upgrade: routes through service when running, surfaces log.line as toast", async () => {
    const r = await makeRecorder();
    await runTestAction({ kind: "upgrade", targetVersion: "0.0.60" }, r.deps);
    assert.deepEqual(r.confirms, [{
      message: "Upgrade Raft Desktop to v0.0.60?",
      detail:
        "Raft Desktop will download and verify the update, replace the Computer binary, and restart its service. Connected workspaces may briefly go offline.",
    }]);
    assert.deepEqual(r.api.tryUpgradeCalls, ["0.0.60"]);
    assert.deepEqual(r.api.tryUpgradeTriggers, ["tray"]);
    // log.line from supervisor surfaces as info toast
    assert.equal(r.notifies[0]?.kind, "info");
    assert.match(r.notifies[0]?.message ?? "", /Upgrade started/);
    assert.deepEqual(r.inFlightCalls, ["Upgrading to v0.0.60…", null]);
    assert.deepEqual(r.callOrder.slice(0, 2), ["confirm", "inFlight:Upgrading to v0.0.60…"]);
  });

  test("upgrade: confirm cancel → no service upgrade and no banner", async () => {
    const r = await makeRecorder();
    r.confirmAnswer = false;

    await runTestAction({ kind: "upgrade", targetVersion: "0.0.60" }, r.deps);

    assert.equal(r.confirms.length, 1);
    assert.deepEqual(r.api.tryUpgradeCalls, []);
    assert.equal(r.api.startCalls, 0);
    assert.deepEqual(r.inFlightCalls, []);
    assert.equal(r.refreshes, 1);
  });

  test("upgrade: when no service is running, starts it and routes the exact target through K", async () => {
    const r = await makeRecorder();
    r.api.tryUpgradeImpl = async (_targetVersion, onEvent) => {
      if (r.api.startCalls === 0) return { routed: false, reason: "no-service" };
      onEvent?.({ kind: "log.line", line: "Upgrade started through the resident K service." });
      return { routed: true };
    };
    await runTestAction({ kind: "upgrade", targetVersion: "0.0.60" }, r.deps);
    assert.deepEqual(r.api.tryUpgradeCalls, ["0.0.60", "0.0.60"]);
    assert.deepEqual(r.api.tryUpgradeTriggers, ["tray", "tray"]);
    assert.equal(r.api.startCalls, 1);
    assert.deepEqual(r.api.startCallArgs, [{ serverId: null, serverLabel: null }]);
    assert.equal(r.notifies[0]?.kind, "info");
    assert.match(r.notifies[0]?.message ?? "", /resident K service/);
  });

  test("upgrade: live but unreachable service fails loud and refuses standalone swap", async () => {
    const r = await makeRecorder();
    r.api.tryUpgradeImpl = async () => ({ routed: false, reason: "unreachable" });
    await runTestAction({ kind: "upgrade", targetVersion: "0.0.60" }, r.deps);
    assert.equal(r.api.startCalls, 0);
    assert.equal(r.notifies[0]?.kind, "error");
    assert.equal(r.notifies[0]?.message, "Service unreachable");
    assert.match(r.notifies[0]?.detail ?? "", /couldn't be reached/);
  });
});

describe("runAction — destructive + diagnostic actions (V0)", () => {
  test("viewLog: forwards path as file:// URL; no in-flight banner", async () => {
    const r = await makeRecorder();
    await runTestAction({ kind: "viewLog", path: "/tmp/service.log" }, r.deps);
    assert.deepEqual(r.openUrls, ["file:///tmp/service.log"]);
    assert.deepEqual(r.inFlightCalls, []);
  });

  test("runDoctor: success → 'all checks passed' info toast", async () => {
    const r = await makeRecorder();
    await runTestAction({ kind: "runDoctor" }, r.deps);
    assert.equal(r.api.doctorCalls.length, 1);
    assert.equal(r.notifies[0]?.kind, "info");
    assert.equal(r.notifies[0]?.message, "Doctor: all checks passed");
    assert.deepEqual(r.inFlightCalls, ["Running doctor…", null]);
  });

  test("runDoctor: failing check → error toast with check summary", async () => {
    const r = await makeRecorder();
    r.api.doctorImpl = async () => ({
      checks: [
        { name: "service", ok: true, detail: "running" },
        { name: "attach /botiverse", ok: false, detail: "session expired" },
      ],
      allOk: false,
      cleanup: null,
      crashes: [],
    });
    await runTestAction({ kind: "runDoctor" }, r.deps);
    assert.equal(r.notifies[0]?.kind, "error");
    assert.equal(r.notifies[0]?.message, "Doctor: issues found");
    assert.match(r.notifies[0]?.detail ?? "", /✗ attach \/botiverse/);
    assert.match(r.notifies[0]?.detail ?? "", /session expired/);
  });

  test("diagnosticsPush: queued → copies the correlationId without a second success dialog", async () => {
    const r = await makeRecorder();
    await runTestAction({ kind: "diagnosticsPush" }, r.deps);
    assert.equal(r.diagnosticsReviews.length, 1);
    assert.equal(r.diagnosticsReviews[0]?.message, "Review diagnostics before sending");
    assert.equal(r.diagnosticsReviews[0]?.detail, DIAGNOSTICS_REVIEW_DETAIL);
    assert.match(r.diagnosticsReviews[0]?.detail ?? "", /redacted diagnostics bundle/i);
    assert.match(r.diagnosticsReviews[0]?.detail ?? "", /Not included:/);
    assert.doesNotMatch(r.diagnosticsReviews[0]?.detail ?? "", /sk_agent_|sk_machine_/);
    assert.equal(r.api.diagnosticsPushCalls, 1);
    // The correlationId is copied to the clipboard for the user to hand off.
    assert.deepEqual(r.clipboardWrites, ["corr-12345"]);
    // A successful send should return the user to the app after the review
    // dialog. The copied correlationId is enough for handoff; failures still
    // surface a blocking modal below.
    assert.equal(r.notifies.length, 0);
    // diagnosticsPush.queued and its fallback log.line are intentionally quiet
    // in the menu-bar.
    assert.deepEqual(r.inFlightCalls, ["Preparing diagnostics…", null]);
  });

  test("diagnosticsPush: review copy → copies the redacted envelope and does not queue upload", async () => {
    const r = await makeRecorder();
    r.diagnosticsReviewAnswer = "copy";
    await runTestAction({ kind: "diagnosticsPush" }, r.deps);
    assert.equal(r.diagnosticsReviews.length, 1);
    assert.equal(r.api.diagnosticsPushCalls, 0);
    assert.deepEqual(r.clipboardWrites, [DIAGNOSTICS_REVIEW_DETAIL]);
    assert.equal(r.notifies[0]?.kind, "info");
    assert.equal(r.notifies[0]?.message, "Diagnostics details copied");
    assert.deepEqual(r.inFlightCalls, []);
    assert.equal(r.refreshes, 1);
  });

  test("diagnosticsPush: review cancel → no queue, no notify, no clipboard write", async () => {
    const r = await makeRecorder();
    r.diagnosticsReviewAnswer = "cancel";
    await runTestAction({ kind: "diagnosticsPush" }, r.deps);
    assert.equal(r.diagnosticsReviews.length, 1);
    assert.equal(r.api.diagnosticsPushCalls, 0);
    assert.deepEqual(r.clipboardWrites, []);
    assert.deepEqual(r.notifies, []);
    assert.deepEqual(r.inFlightCalls, []);
    assert.equal(r.refreshes, 1);
  });

  test("diagnosticsPush: failed (OFFLINE) → error toast with the reason + 'Nothing was uploaded', no clipboard write (fail-closed, no fake id)", async () => {
    const r = await makeRecorder();
    r.api.diagnosticsPushImpl = async () => ({ status: "failed", reason: "OFFLINE" });
    await runTestAction({ kind: "diagnosticsPush" }, r.deps);
    assert.equal(r.diagnosticsReviews.length, 1);
    assert.equal(r.notifies[0]?.kind, "error");
    assert.equal(r.notifies[0]?.message, "Diagnostics sync unavailable");
    assert.match(r.notifies[0]?.detail ?? "", /OFFLINE/);
    assert.match(r.notifies[0]?.detail ?? "", /Nothing was uploaded/);
    // Fail-closed: no correlationId minted, so nothing is copied.
    assert.deepEqual(r.clipboardWrites, []);
    assert.deepEqual(r.inFlightCalls, ["Preparing diagnostics…", null]);
  });

  test("diagnosticsPush: failed (NO_RUNNER) with local bundle → copies bundle path and surfaces manual handoff", async () => {
    const r = await makeRecorder();
    r.api.diagnosticsPushImpl = async () => ({
      status: "failed",
      reason: "NO_RUNNER",
      localBundle: {
        bundleId: "local-123",
        path: "/tmp/raft-computer/local-diagnostics-local-123.json",
        sizeBytes: 1234,
      },
    });
    await runTestAction({ kind: "diagnosticsPush" }, r.deps);
    assert.equal(r.diagnosticsReviews.length, 1);
    assert.equal(r.notifies[0]?.kind, "error");
    assert.equal(r.notifies[0]?.message, "Diagnostics sync unavailable");
    assert.match(r.notifies[0]?.detail ?? "", /No running runner/);
    assert.match(r.notifies[0]?.detail ?? "", /local redacted diagnostics bundle was saved/);
    assert.match(r.notifies[0]?.detail ?? "", /local-diagnostics-local-123\.json/);
    assert.deepEqual(r.clipboardWrites, ["/tmp/raft-computer/local-diagnostics-local-123.json"]);
    assert.deepEqual(r.inFlightCalls, ["Preparing diagnostics…", null]);
  });
});

describe("runAction — error taxonomy (non-ComputerError surfaces clean)", () => {
  test("api throws a NON-ComputerError (e.g. raw ServiceClientError) → code falls back to UNKNOWN", async () => {
    // The dogfood path: a low-level IPC failure (ServiceClientError) escapes the
    // lib without being mapped to a ComputerError. isComputerError() is false, so
    // runAction must still surface a clean "Action failed" with a UNKNOWN code
    // rather than leaking a raw stack or crashing the menu. (This is the same
    // gap the api-boundary defense-in-depth wrap addresses; until then, the
    // runner's catch is the safety net.)
    const r = await makeRecorder();
    class ServiceClientError extends Error {
      readonly code = "IPC_PROTOCOL_HANDSHAKE_FAILED";
      constructor() {
        super("connect ENOENT /tmp/service.sock");
        this.name = "ServiceClientError";
      }
    }
    r.api.resetServiceImpl = async () => {
      throw new ServiceClientError();
    };
    await runTestAction({ kind: "restartService" }, r.deps);
    assert.equal(r.notifies.length, 1);
    assert.equal(r.notifies[0]?.kind, "error");
    assert.equal(r.notifies[0]?.message, "Action failed");
    // code is UNKNOWN (not the ServiceClientError's own `.code` — runAction only
    // trusts isComputerError-shaped codes), message preserved for the detail.
    assert.match(r.notifies[0]?.detail ?? "", /^UNKNOWN: connect ENOENT/);
    assert.deepEqual(r.inFlightCalls, ["Restarting service…", null]);
    assert.equal(r.refreshes, 2);
  });

  test("api throws a non-Error value (e.g. a thrown string) → stringified into the detail, UNKNOWN code", async () => {
    const r = await makeRecorder();
    r.api.resetServiceImpl = async () => {
      throw "boom";
    };
    await runTestAction({ kind: "restartService" }, r.deps);
    assert.equal(r.notifies[0]?.kind, "error");
    assert.match(r.notifies[0]?.detail ?? "", /^UNKNOWN: boom/);
  });
});

describe("runAction — action span (tracing keystone)", () => {
  test("success → exactly one 'action' span with actionId, ended status=ok no errorCode", async () => {
    const tracer = new RecordingTracer();
    const r = await makeRecorder(tracer);
    await runTestAction({ kind: "restartService" }, r.deps);
    assert.equal(tracer.spans.length, 1);
    const span = tracer.spans[0]!;
    assert.equal(span.name, "action");
    assert.equal(span.options.surface, "computer");
    assert.equal(span.options.kind, "internal");
    assertActionAttrs(span.options.attrs, "restartService");
    assert.equal(span.ended, true, "span must be ended (in finally)");
    assert.equal(span.endStatus, "ok");
    assert.equal(span.endOptions, undefined, "no errorCode attr on the success path");
  });

  test("ComputerError → span ends status=error with the ComputerError.code as the errorCode attr", async () => {
    const tracer = new RecordingTracer();
    const r = await makeRecorder(tracer);
    r.api.resetServiceImpl = async () => {
      throw new ComputerError("RESET_SERVICE_FAILED", "fake disk write failure");
    };
    await runTestAction({ kind: "restartService" }, r.deps);
    const span = tracer.spans[0]!;
    assert.equal(span.ended, true);
    assert.equal(span.endStatus, "error");
    assert.deepEqual(span.endOptions, { attrs: { errorCode: "RESET_SERVICE_FAILED" } });
  });

  test("non-ComputerError → span ends status=error with errorCode=UNKNOWN (matches the notify code)", async () => {
    const tracer = new RecordingTracer();
    const r = await makeRecorder(tracer);
    r.api.resetServiceImpl = async () => {
      throw new Error("connect ENOENT /tmp/service.sock");
    };
    await runTestAction({ kind: "restartService" }, r.deps);
    const span = tracer.spans[0]!;
    assert.equal(span.endStatus, "error");
    assert.deepEqual(span.endOptions, { attrs: { errorCode: "UNKNOWN" } });
  });

  test("the no-op refresh action still records exactly one ended action span", async () => {
    // Even instantaneous actions open + close a span — the trace shows every
    // click, including the ones that don't touch the lib.
    const tracer = new RecordingTracer();
    const r = await makeRecorder(tracer);
    await runTestAction({ kind: "refresh" }, r.deps);
    assert.equal(tracer.spans.length, 1);
    assertActionAttrs(tracer.spans[0]!.options.attrs, "refresh");
    assert.equal(tracer.spans[0]!.endStatus, "ok");
  });

});

describe("runAction — v14 new actions", () => {
  test("connectWorkspace: opens onboarding, no in-flight banner", async () => {
    const r = await makeRecorder();
    await runTestAction({ kind: "connectWorkspace" }, r.deps);
    assert.equal(r.openOnboardingCalls, 1);
    assert.deepEqual(r.openOnboardingTargets, [undefined]);
    assert.deepEqual(r.inFlightCalls, [], "connectWorkspace is instantaneous");
    assert.equal(r.refreshes, 1);
  });

  test("connectWorkspace: carries selected server target into onboarding", async () => {
    const r = await makeRecorder();
    await runTestAction(
      { kind: "connectWorkspace", serverId: "server-a", serverLabel: "alpha" },
      r.deps,
    );
    assert.equal(r.openOnboardingCalls, 1);
    assert.deepEqual(r.openOnboardingTargets, [{ serverId: "server-a", serverLabel: "alpha" }]);
    assert.deepEqual(r.inFlightCalls, [], "connectWorkspace is instantaneous");
  });

  test("quitApp: confirmed → stops Computer service before quit; cancelled → does neither", async () => {
    const r = await makeRecorder();
    r.confirmAnswer = true;
    await runTestAction({ kind: "quitApp" }, r.deps);
    assert.equal(r.api.stopCalls, 1);
    assert.equal(r.quitCalls, 1);
    assert.deepEqual(r.confirms, [{
      message: "Quit Raft Desktop?",
      detail: "Your connected workspaces will go offline on this Computer until you open Raft Desktop again.",
    }]);
    assert.deepEqual(r.inFlightCalls, ["Quitting…", null]);

    const r2 = await makeRecorder();
    r2.confirmAnswer = false;
    await runTestAction({ kind: "quitApp" }, r2.deps);
    assert.equal(r2.api.stopCalls, 0);
    assert.equal(r2.quitCalls, 0);
    assert.deepEqual(r2.inFlightCalls, []);
    assert.equal(r2.refreshes, 1);
  });

  test("toggleLaunchAtLogin: flips the current state", async () => {
    const r = await makeRecorder();
    await runTestAction({ kind: "toggleLaunchAtLogin", currentlyEnabled: false }, r.deps);
    assert.deepEqual(r.launchAtLoginCalls, [true]);

    const r2 = await makeRecorder();
    await runTestAction({ kind: "toggleLaunchAtLogin", currentlyEnabled: true }, r2.deps);
    assert.deepEqual(r2.launchAtLoginCalls, [false]);
  });

  test("toggleLaunchAtLogin: waits for durable readback before refreshing the menu", async () => {
    const r = await makeRecorder();
    let release!: () => void;
    r.deps.setLaunchAtLogin = async (enabled) => {
      r.launchAtLoginCalls.push(enabled);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    };

    const pending = runTestAction(
      { kind: "toggleLaunchAtLogin", currentlyEnabled: false },
      r.deps,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(r.launchAtLoginCalls, [true]);
    assert.equal(r.refreshes, 0, "the visible menu must not advance before carrier readback");

    release();
    await pending;
    assert.equal(r.refreshes, 1);
  });
});
