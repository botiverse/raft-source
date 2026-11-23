import assert from "node:assert/strict";
import { scriptedRuntime } from "@botiverse/oar/testing";
import { harness, makeConfig, message, request, until } from "../testing/oarAgentHostHarness";
import { codexResumeProviderMismatchNotice, parseCodexResumeProviderMismatch } from "./oarAgentHost";

test("parseCodexResumeProviderMismatch recognizes all Codex ModelProviderError variants and ignores unrelated errors", () => {
  assert.deepEqual(
    parseCodexResumeProviderMismatch(
      new Error("codex thread/resume failed: This chat uses openai, but your current provider is custom. Switch to openai to continue."),
    ),
    { reason: "provider_mismatch", sessionProvider: "openai", currentProvider: "custom" },
  );

  assert.deepEqual(
    parseCodexResumeProviderMismatch(
      new Error("codex thread/resume failed: serviceTier fast could not be confirmed (actual unreported): This chat uses openai, but Codex now uses azure-openai, so this chat is read-only."),
    ),
    { reason: "provider_mismatch", sessionProvider: "openai", currentProvider: "azure-openai" },
  );

  assert.deepEqual(
    parseCodexResumeProviderMismatch(
      new Error("codex thread/resume failed", {
        cause: {
          method: "thread/resume",
          native: {
            code: -32600,
            message: "This chat uses model provider custom_v1, which is no longer configured. Restore this provider's configuration to continue.",
          },
        },
      }),
    ),
    { reason: "provider_not_configured", sessionProvider: "custom_v1" },
  );

  assert.deepEqual(
    parseCodexResumeProviderMismatch(
      new Error("This chat uses model provider openai, but your organization requires enterprise_proxy. Contact your administrator or start a new chat using the required provider."),
    ),
    { reason: "provider_policy_conflict", sessionProvider: "openai", currentProvider: "enterprise_proxy" },
  );

  // Structured JSON-RPC native.data.type fallback when message wording differs.
  assert.deepEqual(
    parseCodexResumeProviderMismatch(
      new Error("codex thread/resume failed", {
        cause: {
          method: "thread/resume",
          native: { code: -32600, message: "provider conflict", data: { type: "modelProviderMismatch" } },
        },
      }),
    ),
    { reason: "provider_mismatch" },
  );

  // Unknown modelProvider* errors and non-resume RPC errors must NOT invalidate the session.
  assert.equal(
    parseCodexResumeProviderMismatch(
      new Error("codex thread/resume failed", {
        cause: {
          method: "thread/resume",
          native: { code: -32600, message: "provider temporarily unavailable", data: { type: "modelProviderUnavailable" } },
        },
      }),
    ),
    null,
  );
  assert.equal(
    parseCodexResumeProviderMismatch(
      new Error("codex thread/settings/update failed", {
        cause: {
          method: "thread/settings/update",
          native: { code: -32600, message: "provider conflict", data: { type: "modelProviderMismatch" } },
        },
      }),
    ),
    null,
  );

  // Notice copy covers all variants clearly.
  assert.match(codexResumeProviderMismatchNotice({ reason: "provider_not_configured", sessionProvider: "custom_v1" }), /custom_v1.*no longer configured/);
  assert.match(codexResumeProviderMismatchNotice({ reason: "provider_policy_conflict", sessionProvider: "openai", currentProvider: "enterprise_proxy" }), /openai.*enterprise_proxy/);
  assert.match(codexResumeProviderMismatchNotice({ reason: "provider_mismatch" }), /Codex's model provider on this machine changed/);

  assert.equal(parseCodexResumeProviderMismatch(new Error("codex thread/resume failed: thread not found: thr_123")), null);
  assert.equal(parseCodexResumeProviderMismatch(new Error("codex thread/resume failed: failed to load configuration: TOML parse error")), null);
  assert.equal(parseCodexResumeProviderMismatch(null), null);
});

test("OarAgentHost starts a fresh Codex session with a visible notice when resume fails due to model provider mismatch (#wg-ax:#3)", async () => {
  const runtime = scriptedRuntime({
    turn: (turn) => {
      turn.say("Started fresh.");
    },
  });
  let openAttempts = 0;
  const openedResumeIds: Array<string | undefined> = [];

  const h = await harness({
    deps: {
      prepareLaunch: async (ctx) => ({
        runtimeId: "codex",
        installation: { kind: "available", via: "bundled" },
        options: {
          cwd: ctx.workingDirectory,
          appendSystemPrompt: ctx.standingPrompt,
          ...(ctx.config.sessionId ? { resume: ctx.config.sessionId } : {}),
        },
        busyDelivery: "now",
      }),
      sessionCapabilities: async () => ({
        steer: true,
        queue: true,
        resume: true,
        compact: true,
        contextUsage: { tokens: true, contextWindow: true },
      }),
    },
    openSession: async (launch) => {
      openAttempts += 1;
      openedResumeIds.push(launch.options.resume);
      if (openAttempts === 1) {
        throw new Error(
          "codex thread/resume failed: This chat uses openai, but your current provider is custom. Switch to openai to continue.",
          {
            cause: {
              method: "thread/resume",
              native: {
                code: -32600,
                message: "This chat uses openai, but your current provider is custom. Switch to openai to continue.",
                data: { type: "modelProviderMismatch" },
              },
            },
          },
        );
      }
      const session = await runtime.session({ kind: "available", via: "bundled" }, launch.options);
      h.sessions.push(session);
      return session;
    },
  });

  try {
    const startReq = request({
      config: makeConfig({ runtime: "codex", sessionId: "thr_old_openai" }),
      wakeMessage: message("m-wake", { content: "please continue" }),
    });
    const outcome = await h.host.start(startReq);
    assert.equal(outcome.kind, "started");
    await until(() => h.framesOf("agent:runtime:outcome").length > 0, "fresh codex turn completed");

    // Attempt 1 tried to resume thr_old_openai; attempt 2 opened a fresh session without resume.
    assert.deepEqual(openedResumeIds, ["thr_old_openai", undefined]);

    // Old session was invalidated before the new session was reported.
    const invalidations = h.framesOf("agent:session:invalidate");
    assert.equal(invalidations.length, 1);
    assert.equal(invalidations[0]!.sessionId, "thr_old_openai");
    assert.equal(invalidations[0]!.reason, "provider_replay_rejected");
    const frameTypes = h.frames.map((frame) => frame.type);
    assert.ok(frameTypes.indexOf("agent:session:invalidate") < frameTypes.indexOf("agent:session"));

    // A visible Activity Log system notice explains why the session was replaced (not an error).
    const expectedText = codexResumeProviderMismatchNotice({
      reason: "provider_mismatch",
      sessionProvider: "openai",
      currentProvider: "custom",
    });
    const noticeFrame = h.framesOf("agent:activity").find((frame) =>
      frame.entries?.some((entry) => entry.kind === "system" && entry.title === "New Codex session" && entry.text === expectedText),
    );
    assert.ok(noticeFrame, "expected a visible New Codex session notice in agent:activity");
    assert.equal(noticeFrame.runtimeError, undefined);

    // Trace event recorded the provider transition.
    const ev = h.events.find((entry) => entry.name === "daemon.agent.oar.resume_provider_mismatch_new_session");
    assert.equal(ev?.attrs.runtime, "codex");
    assert.equal(ev?.attrs.mismatch_reason, "provider_mismatch");
    assert.equal(ev?.attrs.session_provider, "openai");
    assert.equal(ev?.attrs.current_provider, "custom");

    // No fallback event was emitted (recovery stayed in OarAgentHost).
    assert.equal(h.events.some((entry) => entry.name === "daemon.agent.oar.fallback"), false);
  } finally {
    await h.cleanup();
  }
});

test("OarAgentHost does not loop if a fresh Codex start fails after provider-mismatch recovery", async () => {
  let openAttempts = 0;

  const h = await harness({
    deps: {
      prepareLaunch: async (ctx) => ({
        runtimeId: "codex",
        installation: { kind: "available", via: "bundled" },
        options: {
          cwd: ctx.workingDirectory,
          appendSystemPrompt: ctx.standingPrompt,
          ...(ctx.config.sessionId ? { resume: ctx.config.sessionId } : {}),
        },
        busyDelivery: "now",
      }),
      sessionCapabilities: async () => ({
        steer: true,
        queue: true,
        resume: true,
        compact: true,
        contextUsage: { tokens: true, contextWindow: true },
      }),
    },
    openSession: async () => {
      openAttempts += 1;
      throw new Error("This chat uses openai, but your current provider is custom. Switch to openai to continue.");
    },
  });

  try {
    const outcome = await h.host.start(request({ config: makeConfig({ runtime: "codex", sessionId: "thr_old_openai" }) }));
    assert.equal(outcome.kind, "fallback");
    assert.equal(openAttempts, 2, "retries once without resume, never loops on fresh open failure");
  } finally {
    await h.cleanup();
  }
});
