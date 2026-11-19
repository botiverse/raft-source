// OpenCode on the OAR host, on OAR's scripted runtime: the starts that stay
// on the legacy driver (version, platform, a declined session), prompt-first
// delivery (OAR #777: a status that never reads idle again), busy delivery
// with and without a steer, a 2.x session that lives outside the workspace
// (a new session, never the driver), any other open failure (the driver,
// never a new session), the open gate and the session record hook.
import assert from "node:assert/strict";
import type { Session } from "@botiverse/oar";
import { scriptedRuntime } from "@botiverse/oar/testing";
import { harness, makeConfig, message, request, until } from "../testing/oarAgentHostHarness";
import { OPENCODE_SESSION_ELSEWHERE_TEXT, type OarAgentHostDeps } from "./oarAgentHost";
import { OarLaunchDeclined, type OarLaunch } from "./oarLaunch";
import { opencodeOarLaunch, type OpencodeRelease } from "./oarOpencodeLaunch";

const V2: OpencodeRelease = { major: 2, minor: 3, patch: 0 };
const V1: OpencodeRelease = { major: 1, minor: 18, patch: 35 };

/** The real OpenCode launch shape, with a fixed environment, no managed MCP and no record file. */
function opencodeDeps(release: OpencodeRelease = V2, extra: (launch: OarLaunch) => OarLaunch = (launch) => launch): Partial<OarAgentHostDeps> {
  return {
    detectedRuntimeCliVersion: (runtimeId) => (runtimeId === "opencode" ? `opencode v${release.major}.${release.minor}.${release.patch}` : undefined),
    prepareLaunch: async (ctx) => extra(opencodeOarLaunch(ctx, {
      command: "/usr/local/bin/opencode",
      release,
      env: { PWD: ctx.workingDirectory },
      resume: ctx.config.sessionId ?? null,
      record: null,
    }, {})),
  };
}

const opencodeConfig = (overrides: Parameters<typeof makeConfig>[0] = {}) => makeConfig({ runtime: "opencode", ...overrides });

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

/** A session whose status reads `running` once `stuck()` says so (OAR #777), whatever the runtime does; `steer` removed when `noSteer`. */
function wrap(stuck: () => boolean, options: { noSteer?: boolean; onDispose?: () => void } = {}) {
  return (session: Session): Session => new Proxy(session, {
    get(target, prop) {
      if (prop === "steer" && options.noSteer) return undefined;
      if (prop === "status") {
        return () => {
          const real = target.status();
          return stuck() ? { ...real, value: { kind: "running", sinceSeq: 0, phase: "waiting_model", lastEventAt: Date.now() } } : real;
        };
      }
      if (prop === "dispose" && options.onDispose) return async () => { options.onDispose!(); await target.dispose(); };
      const value: unknown = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Session;
}

const deliveryOutcomes = (h: Awaited<ReturnType<typeof harness>>) => h.events.filter((event) => event.name === "daemon.agent.oar.delivery").map((event) => event.attrs.outcome);

test("supports(): OpenCode runs here from 1.18.30 (1.x) and 2.0.27 (2.x), below 3; any other version, or Windows, keeps the driver", async () => {
  for (const version of ["1.18.30", "opencode v2.0.27", "opencode v2.3.0"]) {
    const h = await harness({ deps: { detectedRuntimeCliVersion: (id) => (id === "opencode" ? version : undefined) } });
    try {
      assert.deepEqual(h.host.supports(request({ config: opencodeConfig() })), { ok: true }, version);
    } finally {
      await h.cleanup();
    }
  }
  for (const version of ["1.18.29", "1.14.30", "opencode v2.0.26", "3.0.0", undefined]) {
    const h = await harness({ deps: { detectedRuntimeCliVersion: (id) => (id === "opencode" ? version : undefined) } });
    try {
      assert.deepEqual(h.host.supports(request({ config: opencodeConfig() })), { ok: false, reason: "opencode_version_unsupported" }, String(version));
    } finally {
      await h.cleanup();
    }
  }
  const windows = await harness({ deps: { ...opencodeDeps(), platform: "win32" } });
  try {
    assert.deepEqual(windows.host.supports(request({ config: opencodeConfig() })), { ok: false, reason: "platform_unsupported" });
  } finally {
    await windows.cleanup();
  }
});

test("a fresh OpenCode start: no OAR prompt options (the standing prompt is in Raft's config), prompt-first and steer launch", async () => {
  const h = await harness({ deps: opencodeDeps() });
  try {
    assert.deepEqual(await h.host.start(request({ config: opencodeConfig() })), { kind: "started" });
    await until(() => h.inputs.length > 0, "first input");
    const launch = h.opened[0]!;
    assert.equal(launch.runtimeId, "opencode");
    assert.equal(launch.options.systemPrompt, undefined);
    assert.equal(launch.options.appendSystemPrompt, undefined);
    assert.equal(launch.promptFirst, true);
    assert.equal(launch.busyDelivery, "now");
  } finally {
    await h.cleanup();
  }
});

test("prompt first (OAR #777): with OAR's status stuck on running after a turn, a delivery still goes in as a new turn", async () => {
  let stuck = false;
  const h = await harness({ deps: opencodeDeps(), wrapSession: wrap(() => stuck) });
  try {
    await h.host.start(request({ config: opencodeConfig() }));
    await until(() => h.inputs.length === 1 && h.sessions[0]?.status().value.kind === "idle", "the first turn ended");
    stuck = true;
    assert.equal(await h.host.deliverMessage("agent-1", message("m-after-subagents"), { deliveryId: "d-1" }), true);
    await until(() => h.inputs.length === 2, "the delivery's own turn");
    assert.ok(deliveryOutcomes(h).includes("prompted"));
    assert.equal(deliveryOutcomes(h).includes("held_until_turn_end"), false);
  } finally {
    await h.cleanup();
  }
});

test("prompt first is OpenCode's only: another runtime with the same stuck status still holds the delivery for the turn end", async () => {
  let stuck = false;
  // The harness's default launch: grok-shaped, `after_turn`, no promptFirst.
  const h = await harness({ wrapSession: wrap(() => stuck) });
  try {
    await h.host.start(request());
    await until(() => h.inputs.length === 1 && h.sessions[0]?.status().value.kind === "idle", "the first turn ended");
    stuck = true;
    assert.equal(await h.host.deliverMessage("agent-1", message("m-held"), { deliveryId: "d-1" }), true);
    await until(() => deliveryOutcomes(h).includes("held_until_turn_end"), "held");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(h.inputs.length, 1);
  } finally {
    await h.cleanup();
  }
});

test("busy, with a steer (1.x; 2.x from 2.2.7): OAR answers busy to the prompt, and the delivery is steered into the running turn", async () => {
  const gate = deferred();
  let turns = 0;
  const h = await harness({
    turn: async (turn) => { turns += 1; if (turns === 1) await gate.promise; turn.say("done"); },
    deps: opencodeDeps(V1),
  });
  try {
    await h.host.start(request({ config: opencodeConfig() }));
    await until(() => h.inputs.length === 1, "first turn running");
    assert.equal(await h.host.deliverMessage("agent-1", message("m-busy"), { deliveryId: "d-busy" }), true);
    await until(() => deliveryOutcomes(h).includes("steered"), "steered");
    gate.resolve();
    await until(() => h.steered().length === 1, "the turn took the steer");
    assert.equal(h.inputs.length, 1, "no turn of its own");
  } finally {
    gate.resolve();
    await h.cleanup();
  }
});

test("busy, without a steer (2.x before 2.2.7): held after OAR's busy answer, and handed over as a new turn at the turn end", async () => {
  const gate = deferred();
  let turns = 0;
  const h = await harness({
    turn: async (turn) => { turns += 1; if (turns === 1) await gate.promise; turn.say("done"); },
    deps: opencodeDeps({ major: 2, minor: 0, patch: 27 }),
    wrapSession: wrap(() => false, { noSteer: true }),
  });
  try {
    await h.host.start(request({ config: opencodeConfig() }));
    await until(() => h.inputs.length === 1, "first turn running");
    assert.equal(await h.host.deliverMessage("agent-1", message("m-busy"), { deliveryId: "d-busy" }), true);
    await until(() => deliveryOutcomes(h).includes("held_until_turn_end"), "held on busy");
    assert.equal(h.inputs.length, 1);
    gate.resolve();
    await until(() => h.inputs.length === 2, "handed over at the turn end");
    assert.equal(h.steered().length, 0);
  } finally {
    gate.resolve();
    await h.cleanup();
  }
});

const cwdRefusal = () => Object.assign(new Error("session ses_old lives in /home/me/raft-daemon and this runtime resumes it only there; the resume names /work/agent-1"), { name: "UnsupportedOptionError", option: "cwd" });

test("2.x: a session OAR will not resume in the workspace (made before #14872) starts a new session here, told in the Activity Log", async () => {
  const opened: Array<string | undefined> = [];
  const inputs: string[] = [];
  const fresh = scriptedRuntime({ turn: (turn) => { inputs.push(turn.input); turn.say("ok"); } });
  const h = await harness({
    deps: {
      ...opencodeDeps(V2),
      openSession: async (launch) => {
        opened.push(launch.options.resume);
        if (launch.options.resume) throw cwdRefusal();
        return fresh.session({ kind: "available", via: "bundled" }, launch.options);
      },
    },
  });
  try {
    const outcome = await h.host.start(request({ config: opencodeConfig({ sessionId: "ses_old" }), wakeMessage: message("m-1") }));
    assert.deepEqual(outcome, { kind: "started" });
    assert.deepEqual(opened, ["ses_old", undefined], "one refused resume, then a fresh open");
    assert.ok(h.events.some((event) => event.name === "daemon.agent.oar.resume_elsewhere_new_session"));
    assert.equal(h.events.some((event) => event.name === "daemon.agent.oar.fallback"), false, "not handed back");
    assert.deepEqual(h.framesOf("agent:session:invalidate").map((frame) => [frame.sessionId, frame.reason]), [["ses_old", "runtime_host_migration"]]);
    await until(() => inputs.length > 0, "the new session's first input");
    await until(() => h.framesOf("agent:activity").some((frame) => frame.entries?.some((entry) => entry.kind === "system" && entry.text === OPENCODE_SESSION_ELSEWHERE_TEXT)), "the Activity Log row");
    assert.ok(h.framesOf("agent:activity").every((frame) => frame.runtimeError === undefined), "not an error");
  } finally {
    await h.cleanup();
  }
});

test("1.x: the same refusal is handed back to the driver on the same session, never a new session", async () => {
  const opened: Array<string | undefined> = [];
  const h = await harness({
    deps: {
      ...opencodeDeps(V1),
      openSession: async (launch) => { opened.push(launch.options.resume); throw cwdRefusal(); },
    },
  });
  try {
    const outcome = await h.host.start(request({ config: opencodeConfig({ sessionId: "ses_old" }) }));
    assert.equal(outcome.kind, "fallback");
    if (outcome.kind !== "fallback") return;
    assert.equal(outcome.reason, "resume_failed:UnsupportedOptionError");
    assert.equal(outcome.request.config.sessionId, "ses_old");
    assert.deepEqual(opened, ["ses_old"]);
    assert.deepEqual(h.framesOf("agent:session:invalidate"), []);
  } finally {
    await h.cleanup();
  }
});

test("any other open failure hands the start back on the same session (never a new empty session)", async () => {
  const opened: Array<string | undefined> = [];
  const h = await harness({
    deps: {
      ...opencodeDeps(V2),
      openSession: async (launch) => {
        opened.push(launch.options.resume);
        throw Object.assign(new Error("opencode acp exited"), { name: "AcpError" });
      },
    },
  });
  try {
    const outcome = await h.host.start(request({ config: opencodeConfig({ sessionId: "ses_1" }) }));
    assert.equal(outcome.kind, "fallback");
    if (outcome.kind !== "fallback") return;
    assert.equal(outcome.reason, "resume_failed:AcpError");
    assert.equal(outcome.failHere, undefined, "the driver runs it");
    assert.equal(outcome.request.config.sessionId, "ses_1");
    assert.deepEqual(opened, ["ses_1"]);
    assert.deepEqual(h.framesOf("agent:session:invalidate"), []);
  } finally {
    await h.cleanup();
  }
});

test("a declined launch (another OpenCode major's session) is handed back before anything opens, with the launch's reason", async () => {
  const h = await harness({
    deps: {
      ...opencodeDeps(V2),
      prepareLaunch: async () => { throw new OarLaunchDeclined("opencode_session_refused:major_mismatch"); },
    },
  });
  try {
    const outcome = await h.host.start(request({ config: opencodeConfig({ sessionId: "ses_1x" }) }));
    assert.equal(outcome.kind, "fallback");
    if (outcome.kind !== "fallback") return;
    assert.equal(outcome.reason, "opencode_session_refused:major_mismatch");
    assert.equal(outcome.request.config.sessionId, "ses_1x", "the driver shows its own refusal");
    assert.equal(h.opened.length, 0);
  } finally {
    await h.cleanup();
  }
});

test("the open goes through the launch's open gate, and the session is recorded before its first input", async () => {
  const calls: string[] = [];
  const h = await harness({
    deps: opencodeDeps(V2, (launch) => ({
      ...launch,
      openGate: async (open) => { calls.push("gate"); return open(); },
      sessionOpened: (session) => { calls.push(`recorded:${session.id}:inputs=${h.inputs.length}`); },
    })),
  });
  try {
    await h.host.start(request({ config: opencodeConfig() }));
    await until(() => h.inputs.length > 0, "first input");
    assert.equal(calls[0], "gate");
    assert.match(calls[1] ?? "", /^recorded:.+:inputs=0$/);
  } finally {
    await h.cleanup();
  }
});

test("a session whose OpenCode major could not be recorded is disposed and handed back (open_failed:session_record)", async () => {
  let disposed = 0;
  const h = await harness({
    deps: opencodeDeps(V2, (launch) => ({ ...launch, sessionOpened: () => { throw new Error("EACCES"); } })),
    wrapSession: wrap(() => false, { onDispose: () => { disposed += 1; } }),
  });
  try {
    const outcome = await h.host.start(request({ config: opencodeConfig() }));
    assert.equal(outcome.kind, "fallback");
    if (outcome.kind !== "fallback") return;
    assert.equal(outcome.reason, "open_failed:session_record");
    assert.equal(disposed, 1);
    assert.equal(h.inputs.length, 0);
  } finally {
    await h.cleanup();
  }
});
