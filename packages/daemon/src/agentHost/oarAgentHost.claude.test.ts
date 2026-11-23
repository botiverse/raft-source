import assert from "node:assert/strict";
import { harness, makeConfig, message, request, until } from "../testing/oarAgentHostHarness";
import { oarOpenFailureClass, type OarAgentHostDeps } from "./oarAgentHost";
import { OarLaunchDeclined } from "./oarLaunch";
import { WARM_RECYCLE_STOPPED_EVENT } from "../wakeRecycleWarm";

const claudeConfig = (overrides: Parameters<typeof makeConfig>[0] = {}) => makeConfig({
  runtime: "claude",
  model: "sonnet",
  ...overrides,
});

const claudeLaunchDeps = (extra: Partial<OarAgentHostDeps> = {}): Partial<OarAgentHostDeps> => ({
  platform: "linux",
  prepareLaunch: async (ctx) => ({
    runtimeId: "claude",
    installation: { kind: "available", via: "executable", command: "/usr/local/bin/claude" },
    options: {
      cwd: ctx.workingDirectory,
      env: {},
      appendSystemPrompt: ctx.standingPrompt,
      ...(ctx.config.sessionId ? { resume: ctx.config.sessionId } : {}),
      ...(ctx.config.model ? { model: ctx.config.model } : {}),
    },
    busyDelivery: "now",
  }),
  ...extra,
});

test("OarAgentHost.supports allows Claude on Linux and macOS and declines on Windows", async () => {
  const linux = await harness({ deps: { platform: "linux" } });
  const darwin = await harness({ deps: { platform: "darwin" } });
  const win32 = await harness({ deps: { platform: "win32" } });
  try {
    assert.deepEqual(linux.host.supports(request({ config: claudeConfig() })), { ok: true });
    assert.deepEqual(darwin.host.supports(request({ config: claudeConfig() })), { ok: true });
    assert.deepEqual(win32.host.supports(request({ config: claudeConfig() })), { ok: false, reason: "platform_unsupported" });
  } finally {
    await Promise.all([linux.cleanup(), darwin.cleanup(), win32.cleanup()]);
  }
});

test("oarOpenFailureClass classifies Claude fast_mode_state serviceTier refusal as settings_not_confirmed", () => {
  const err = new Error("claude reports fast_mode_state off although serviceTier fast was requested (cooldown)");
  assert.equal(oarOpenFailureClass(err), "settings_not_confirmed");
});

test("OarAgentHost runs a Claude turn end-to-end and hands back cleanly on claude_not_found", async () => {
  const h = await harness({
    turn: async (turn) => {
      turn.say("Claude on OAR ready.");
    },
    deps: claudeLaunchDeps(),
  });
  try {
    const started = await h.host.start(request({
      agentId: "agent-claude-1",
      launchId: "launch-1",
      config: claudeConfig(),
      wakeMessage: message("m-1"),
    }));
    assert.deepEqual(started, { kind: "started" });
    await until(() => h.inputs.length === 1, "first Claude turn input delivered");
    assert.equal(h.opened.length, 1);
    assert.equal(h.opened[0]!.options.model, "sonnet");
    assert.ok(h.opened[0]!.options.appendSystemPrompt, "standing prompt carried in appendSystemPrompt");
    await h.host.stopAgent("agent-claude-1", { wait: true });
  } finally {
    await h.cleanup();
  }

  const missing = await harness({
    deps: {
      platform: "linux",
      prepareLaunch: async () => {
        throw new OarLaunchDeclined("claude_not_found", "Claude Code CLI not found");
      },
    },
  });
  try {
    const declined = await missing.host.start(request({
      agentId: "agent-claude-2",
      launchId: "launch-missing",
      config: claudeConfig(),
      wakeMessage: message("m-2"),
    }));
    assert.equal(declined.kind, "fallback");
    if (declined.kind === "fallback") {
      assert.equal(declined.reason, "claude_not_found");
    }
  } finally {
    await missing.cleanup();
  }
});

test("OarAgentHost enforces Claude CLI version floor (2.1.220) on warm-recycle stop", async () => {
  for (const [label, version, expectStopped] of [
    ["unknown version", undefined, false],
    ["below floor 2.1.219", "2.1.219 (Claude Code)", false],
    ["at floor 2.1.220", "2.1.220 (Claude Code)", true],
  ] as const) {
    const h = await harness({
      turn: async (turn) => {
        turn.say("done");
      },
      deps: claudeLaunchDeps({
        detectedRuntimeCliVersion: () => version,
      }),
    });
    try {
      const started = await h.host.start(request({
        agentId: "agent-claude-floor",
        launchId: "launch-floor",
        config: claudeConfig({
          wakeRecycleOar: true,
          wakeRecycleWarm: true,
          envVars: {
            RAFT_WAKE_RECYCLE_WARM_MIN_CONTEXT_TOKENS: "50",
            RAFT_WAKE_RECYCLE_WARM_MIN_WINDOW_TOKENS: "100000",
            RAFT_WAKE_RECYCLE_WARM_CEILING_TOKENS: "100",
          },
        }),
        wakeMessage: message("m-floor"),
      }));
      assert.deepEqual(started, { kind: "started" }, label);
      await until(() => h.framesOf("agent:turn:ended").length > 0, `${label}: turn ended`);
      await until(() => h.sessions[0]!.status().value.kind === "idle", `${label}: idle`);
      if (expectStopped) {
        await until(() => h.events.some((e) => e.name === WARM_RECYCLE_STOPPED_EVENT), `${label}: warm recycle stopped`);
      } else {
        // Give any synchronous/microtask ceiling stop a chance to fire; it must not.
        await new Promise((r) => setTimeout(r, 30));
        assert.equal(h.events.some((e) => e.name === WARM_RECYCLE_STOPPED_EVENT), false, `${label}: must not stop below Claude 2.1.220 floor`);
      }
      await h.host.stopAgent("agent-claude-floor", { wait: true });
    } finally {
      await h.cleanup();
    }
  }
});
