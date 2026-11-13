// Cursor on the OAR host (#oar-raft:#10), on OAR's scripted runtime: the
// standing prompt in the first input and the child's environment, the move off a Cursor
// CLI session, an SDK session that cannot be resumed, the starts that stay on
// the legacy driver (each with a traced reason) and busy delivery.
import assert from "node:assert/strict";
import path from "node:path";
import type { AuthStatus } from "@botiverse/oar";
import { scriptedRuntime } from "@botiverse/oar/testing";
import { getDriver } from "../drivers/index";
import { harness, makeConfig, message, request, until } from "../testing/oarAgentHostHarness";
import { CURSOR_SESSION_MIGRATED_TEXT, CURSOR_SIGN_IN_UNREADABLE_TEXT, type OarAgentHostDeps } from "./oarAgentHost";
import { cursorOarLaunch } from "./oarCursorLaunch";

const CHILD_ENV = { HOME: "/home/me", PATH: "/raft-home/cli-transport/agent-1/launch/raft:/usr/bin", SHELL: "/bin/sh", SLOCK_AGENT_ID: "agent-1" };
const SDK_SESSION = "agent-0b9e8f2a-5c1d-4e7f-9a3b-2d6c8e4f1a07";
const CLI_SESSION = "0b9e8f2a-5c1d-4e7f-9a3b-2d6c8e4f1a07";

const signedIn = async (): Promise<AuthStatus> => ({ kind: "logged_in", source: "Cursor.auth.status" });

/** The real Cursor launch shape, with a fixed child environment and no managed MCP. */
const CURSOR_DEPS: Partial<OarAgentHostDeps> = {
  prepareLaunch: async (ctx) => cursorOarLaunch(ctx, { env: CHILD_ENV }),
  cursorSdkAvailable: () => true,
  cursorAuthStatus: signedIn,
};

const cursorConfig = (overrides: Parameters<typeof makeConfig>[0] = {}) => makeConfig({ runtime: "cursor", ...overrides });

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("a fresh Cursor start: the standing prompt rides the first input, with no note before it; the session gets the child's env, no system prompt", async () => {
  const h = await harness({ deps: CURSOR_DEPS });
  try {
    assert.deepEqual(await h.host.start(request({ config: cursorConfig() })), { kind: "started" });
    await until(() => h.inputs.length > 0, "first input");
    const options = h.opened[0]!.options;
    assert.equal(options.systemPrompt, undefined);
    assert.deepEqual(options.env, CHILD_ENV);
    assert.equal(options.resume, undefined);
    const first = h.inputs[0]!;
    assert.equal(first.includes("<raft-runtime-note>"), false, "raft is on the child's PATH: no absolute-path note");
    const workspace = path.join(h.dataDir, "agent-1");
    const standing = String(getDriver("cursor").buildSystemPrompt({ ...cursorConfig(), runtimeContext: { agentId: "agent-1", workspacePath: workspace } }, "agent-1"));
    assert.ok(first.includes(standing), "the cursor driver's standing prompt is in the first input");
  } finally {
    await h.cleanup();
  }
});

test("a Cursor CLI session is left for a new SDK session: traced, forgotten by the server and told in the Activity Log, once", async () => {
  const h = await harness({ deps: CURSOR_DEPS });
  try {
    assert.deepEqual(await h.host.start(request({ config: cursorConfig({ sessionId: CLI_SESSION }) })), { kind: "started" });
    await until(() => h.inputs.length > 0, "first input");
    assert.equal(h.opened[0]!.options.resume, undefined, "never handed to the SDK");
    assert.ok(h.events.some((event) => event.name === "daemon.agent.session_dropped_for_spec" && event.attrs.reason === "runtime_host_changed" && event.attrs.host === "oar"));
    assert.ok(h.events.some((event) => event.name === "daemon.agent.oar.cursor_session_migrated"));
    const invalidates = h.framesOf("agent:session:invalidate");
    assert.deepEqual(invalidates.map((frame) => [frame.sessionId, frame.reason]), [[CLI_SESSION, "runtime_host_migration"]]);
    // Forgotten before the new session is reported.
    const types = h.frames.map((frame) => frame.type);
    assert.ok(types.indexOf("agent:session:invalidate") < types.indexOf("agent:session"));
    const rows = h.framesOf("agent:activity").flatMap((frame) => frame.entries ?? []).filter((entry) => entry.kind === "system");
    assert.deepEqual(rows.map((entry) => entry.kind === "system" ? entry.text : ""), [CURSOR_SESSION_MIGRATED_TEXT]);
    assert.ok(h.framesOf("agent:activity").every((frame) => frame.runtimeError === undefined), "not an error");
    // A fresh session: its first input carries the standing prompt.
    assert.ok(h.inputs[0]!.includes(String(getDriver("cursor").buildSystemPrompt({ ...cursorConfig(), runtimeContext: { agentId: "agent-1", workspacePath: path.join(h.dataDir, "agent-1") } }, "agent-1"))));

    // The same old session again (a server that had not taken the invalidate yet): no second report.
    await h.host.stopAgent("agent-1", { wait: true });
    h.waiting.set("agent-1", ["launch-2"]);
    assert.deepEqual(await h.host.start(request({ launchId: "launch-2", config: cursorConfig({ sessionId: CLI_SESSION }) })), { kind: "started" });
    await until(() => h.opened.length === 2, "second open");
    assert.equal(h.framesOf("agent:session:invalidate").length, 1);
  } finally {
    await h.cleanup();
  }
});

test("an SDK session the SDK will not resume starts a new SDK session here, never on the legacy driver", async () => {
  const opened: Array<string | undefined> = [];
  const inputs: string[] = [];
  const fresh = scriptedRuntime({ turn: (turn) => { inputs.push(turn.input); turn.say("ok"); } });
  const h = await harness({
    deps: {
      ...CURSOR_DEPS,
      openSession: async (launch) => {
        opened.push(launch.options.resume);
        if (launch.options.resume) {
          const error = new Error("agent not found");
          error.name = "SessionNotFoundError";
          throw error;
        }
        return fresh.session({ kind: "available", via: "bundled" }, launch.options);
      },
    },
  });
  try {
    const outcome = await h.host.start(request({ config: cursorConfig({ sessionId: SDK_SESSION }), wakeMessage: message("m-1") }));
    assert.deepEqual(outcome, { kind: "started" });
    assert.deepEqual(opened, [SDK_SESSION, undefined], "one refused resume, then a fresh open");
    assert.ok(h.events.some((event) => event.name === "daemon.agent.oar.resume_failed_new_session" && event.attrs.failure === "SessionNotFoundError"));
    assert.equal(h.events.some((event) => event.name === "daemon.agent.oar.fallback"), false, "not handed back");
    assert.deepEqual(h.framesOf("agent:session:invalidate").map((frame) => [frame.sessionId, frame.reason]), [[SDK_SESSION, "missing"]]);
    await until(() => inputs.length > 0, "the new session's first input");
    // A fresh session's first input: the standing prompt ahead of the wake.
    const standing = String(getDriver("cursor").buildSystemPrompt({ ...cursorConfig(), runtimeContext: { agentId: "agent-1", workspacePath: path.join(h.dataDir, "agent-1") } }, "agent-1"));
    assert.ok(inputs[0]!.includes(standing));
    await until(() => h.framesOf("agent:activity").some((frame) => frame.entries?.some((entry) => entry.kind === "system" && entry.text.includes(SDK_SESSION))), "the new session's Activity Log row");
  } finally {
    await h.cleanup();
  }
});

test("supports(): Cursor stays on the legacy driver off Linux and without the SDK, each with a reason; agent env vars run here", async () => {
  const h = await harness({ deps: CURSOR_DEPS });
  try {
    assert.deepEqual(h.host.supports(request({ config: cursorConfig() })), { ok: true });
    // OAR 0.101's child takes the session's env: the agent's env vars reach its tools.
    assert.deepEqual(h.host.supports(request({ config: cursorConfig({ envVars: { OPENAI_API_KEY: "x" } }) })), { ok: true });
  } finally {
    await h.cleanup();
  }
  for (const platform of ["darwin", "win32"] as const) {
    const off = await harness({ deps: { ...CURSOR_DEPS, platform } });
    try {
      assert.deepEqual(off.host.supports(request({ config: cursorConfig() })), { ok: false, reason: "platform_unsupported" }, platform);
    } finally {
      await off.cleanup();
    }
  }
  const noSdk = await harness({ deps: { ...CURSOR_DEPS, cursorSdkAvailable: () => false } });
  try {
    assert.deepEqual(noSdk.host.supports(request({ config: cursorConfig() })), { ok: false, reason: "cursor_sdk_unavailable" });
    // Other runtimes are not affected by the Cursor checks.
    assert.deepEqual(noSdk.host.supports(request({ config: makeConfig({ envVars: { A: "1" } }) })), { ok: true });
  } finally {
    await noSdk.cleanup();
  }
});

test("an SDK that is not signed in hands the start back silently before anything opens (cursor_sdk_signed_out)", async () => {
  const h = await harness({ deps: { ...CURSOR_DEPS, cursorAuthStatus: async () => ({ kind: "logged_out", source: "Cursor.auth.status" }) } });
  try {
    const outcome = await h.host.start(request({ config: cursorConfig({ sessionId: CLI_SESSION }) }));
    assert.equal(outcome.kind, "fallback");
    if (outcome.kind !== "fallback") return;
    assert.equal(outcome.reason, "cursor_sdk_signed_out");
    assert.equal(outcome.request.config.sessionId, CLI_SESSION, "the driver resumes its own session");
    assert.equal(h.opened.length, 0);
    assert.ok(h.events.some((event) => event.name === "daemon.agent.oar.fallback" && event.attrs.reason === "cursor_sdk_signed_out"));
    assert.deepEqual(h.framesOf("agent:session:invalidate"), [], "nothing moved: the CLI session is kept");
    assert.deepEqual(h.framesOf("agent:activity"), [], "silent");
  } finally {
    await h.cleanup();
  }
});

test("the sign-in is read in the agent's own environment: its CURSOR_API_KEY over the daemon's", async () => {
  const seen: Array<Record<string, string>> = [];
  const h = await harness({ deps: { ...CURSOR_DEPS, cursorAuthStatus: async (env) => { seen.push(env); return { kind: "unknown", configured: ["environment: CURSOR_API_KEY"], source: "Cursor.auth.status" }; } } });
  try {
    assert.deepEqual(await h.host.start(request({ config: cursorConfig({ envVars: { CURSOR_API_KEY: "agent-key" } }) })), { kind: "started" });
    assert.equal(seen[0]?.CURSOR_API_KEY, "agent-key");
    assert.equal(seen[0]?.SHELL, "/bin/sh");
    assert.equal("SLOCK_DAEMON_API_KEY_FILE" in seen[0]!, false);
  } finally {
    await h.cleanup();
  }
});

test("a delivery to a busy Cursor session is steered into the running turn", async () => {
  const gate = deferred();
  let turns = 0;
  const h = await harness({
    turn: async (turn) => { turns += 1; if (turns === 1) await gate.promise; turn.say("done"); },
    deps: CURSOR_DEPS,
  });
  try {
    await h.host.start(request({ config: cursorConfig() }));
    await until(() => h.inputs.length === 1, "first turn running");
    assert.equal(await h.host.deliverMessage("agent-1", message("m-busy"), { deliveryId: "d-busy" }), true);
    await until(() => h.events.some((event) => event.name === "daemon.agent.oar.delivery" && event.attrs.outcome === "steered"), "steered");
    gate.resolve();
    await until(() => h.steered().length === 1, "the turn took the steer");
    assert.equal(h.inputs.length, 1, "no turn of its own");
  } finally {
    gate.resolve();
    await h.cleanup();
  }
});

test("an unreadable SDK sign-in never hands back an agent on an SDK session: the start fails and keeps it", async () => {
  const unknown = async (): Promise<AuthStatus> => ({ kind: "unknown", detail: "Cursor.auth.status did not answer within 20000 ms" });
  const h = await harness({ deps: { ...CURSOR_DEPS, cursorAuthStatus: unknown } });
  try {
    const kept = await h.host.start(request({ config: cursorConfig({ sessionId: SDK_SESSION }) }));
    assert.equal(kept.kind, "fallback");
    if (kept.kind !== "fallback") return;
    assert.equal(kept.reason, "cursor_sdk_status_unknown");
    assert.equal(kept.failHere, CURSOR_SIGN_IN_UNREADABLE_TEXT, "the router fails it instead of the legacy host dropping the session");
    assert.equal(h.opened.length, 0);
    assert.deepEqual(h.framesOf("agent:session:invalidate"), []);
  } finally {
    await h.cleanup();
  }
  // No SDK session to lose: the driver runs it, traced apart from a definite sign-out.
  const fresh = await harness({ deps: { ...CURSOR_DEPS, cursorAuthStatus: unknown } });
  try {
    const outcome = await fresh.host.start(request({ config: cursorConfig({ sessionId: CLI_SESSION }) }));
    assert.equal(outcome.kind, "fallback");
    if (outcome.kind !== "fallback") return;
    assert.equal(outcome.reason, "cursor_sdk_status_unknown");
    assert.equal(outcome.failHere, undefined);
  } finally {
    await fresh.cleanup();
  }
});

test("an SDK session that failed to resume for another reason than not-found fails the start and is kept (no new session, no invalidate)", async () => {
  const opened: Array<string | undefined> = [];
  const h = await harness({
    deps: {
      ...CURSOR_DEPS,
      openSession: async (launch) => {
        opened.push(launch.options.resume);
        const error = new Error("503 Service Unavailable");
        error.name = "RuntimeFailureError";
        throw error;
      },
    },
  });
  try {
    const outcome = await h.host.start(request({ config: cursorConfig({ sessionId: SDK_SESSION }) }));
    assert.equal(outcome.kind, "fallback");
    if (outcome.kind !== "fallback") return;
    assert.equal(outcome.reason, "resume_failed:RuntimeFailureError");
    assert.ok(outcome.failHere);
    assert.equal(outcome.request.config.sessionId, SDK_SESSION);
    assert.deepEqual(opened, [SDK_SESSION], "no fresh open");
    assert.deepEqual(h.framesOf("agent:session:invalidate"), []);
    assert.equal(h.events.some((event) => event.name === "daemon.agent.oar.resume_failed_new_session"), false);
  } finally {
    await h.cleanup();
  }
});

test("a resumed Cursor session's first input carries no runtime note", async () => {
  const h = await harness({ deps: CURSOR_DEPS });
  try {
    assert.deepEqual(await h.host.start(request({ config: cursorConfig({ sessionId: SDK_SESSION }), wakeMessage: message("m-1") })), { kind: "started" });
    await until(() => h.inputs.length > 0, "first input");
    assert.equal(h.opened[0]!.options.resume, SDK_SESSION);
    assert.equal(h.inputs[0]!.includes("<raft-runtime-note>"), false);
  } finally {
    await h.cleanup();
  }
});
