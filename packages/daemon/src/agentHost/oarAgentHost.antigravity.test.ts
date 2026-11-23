// Antigravity on the OAR host: a session OAR can't find (`ResumeCwdError`
// `not_listed`, a legacy driver id `agy` never lists) starts a new OAR session
// here; any other cwd refusal is handed back to the driver as before.
import assert from "node:assert/strict";
import { scriptedRuntime } from "@botiverse/oar/testing";
import { harness, makeConfig, message, request, until } from "../testing/oarAgentHostHarness";
import { ANTIGRAVITY_SESSION_NOT_LISTED_TEXT, modelConfirmationFailure, type OarAgentHostDeps } from "./oarAgentHost";
import { antigravityOarLaunch } from "./oarAntigravityLaunch";

/** The real Antigravity launch shape, with a fixed command and environment. */
const antigravityDeps: Partial<OarAgentHostDeps> = {
  prepareLaunch: async (ctx) => antigravityOarLaunch(ctx, { command: "/usr/local/bin/agy", env: {} }, {}),
};
const antigravityConfig = (overrides: Parameters<typeof makeConfig>[0] = {}) => makeConfig({ runtime: "antigravity", ...overrides });

/** OAR's `ResumeCwdError`: an `UnsupportedOptionError` on `cwd` (its name stays the base class's) with a reason. */
const resumeCwdError = (reason: string) => Object.assign(
  new Error(`cannot confirm the saved directory of session driver-1; this runtime resumes in its saved directory, so open a new session instead`),
  { name: "UnsupportedOptionError", option: "cwd", reason, sessionId: "driver-1", requestedCwd: "/work/agent-1" },
);

test("a session agy doesn't list (not_listed: the legacy driver's id) starts a new OAR session here, told in the Activity Log", async () => {
  const opened: Array<string | undefined> = [];
  const inputs: string[] = [];
  const fresh = scriptedRuntime({ turn: (turn) => { inputs.push(turn.input); turn.say("ok"); } });
  const h = await harness({
    deps: {
      ...antigravityDeps,
      openSession: async (launch) => {
        opened.push(launch.options.resume);
        if (launch.options.resume) throw resumeCwdError("not_listed");
        return fresh.session({ kind: "available", via: "bundled" }, launch.options);
      },
    },
  });
  try {
    const outcome = await h.host.start(request({ config: antigravityConfig({ sessionId: "driver-1" }), wakeMessage: message("m-1") }));
    assert.deepEqual(outcome, { kind: "started" });
    assert.deepEqual(opened, ["driver-1", undefined], "one refused resume, then a fresh open");
    const event = h.events.find((e) => e.name === "daemon.agent.oar.resume_elsewhere_new_session");
    assert.equal(event?.attrs.runtime, "antigravity");
    assert.equal(event?.attrs.resume_cwd_reason, "not_listed");
    assert.equal(h.events.some((e) => e.name === "daemon.agent.oar.fallback"), false, "not handed back");
    assert.deepEqual(h.framesOf("agent:session:invalidate").map((frame) => [frame.sessionId, frame.reason]), [["driver-1", "runtime_host_migration"]]);
    await until(() => inputs.length > 0, "the new session's first input");
    await until(() => h.framesOf("agent:activity").some((frame) => frame.entries?.some((entry) => entry.kind === "system" && entry.text === ANTIGRAVITY_SESSION_NOT_LISTED_TEXT)), "the Activity Log row");
    assert.ok(h.framesOf("agent:activity").every((frame) => frame.runtimeError === undefined), "not an error");
  } finally {
    await h.cleanup();
  }
});

test("any other cwd refusal (listing_unavailable, other_cwd, no reason) is handed back to the driver on the same session", async () => {
  for (const reason of ["listing_unavailable", "other_cwd", undefined]) {
    const opened: Array<string | undefined> = [];
    const h = await harness({
      deps: {
        ...antigravityDeps,
        openSession: async (launch) => {
          opened.push(launch.options.resume);
          throw reason ? resumeCwdError(reason) : Object.assign(new Error("cwd refused"), { name: "UnsupportedOptionError", option: "cwd" });
        },
      },
    });
    try {
      const outcome = await h.host.start(request({ config: antigravityConfig({ sessionId: "driver-1" }) }));
      assert.equal(outcome.kind, "fallback", String(reason));
      if (outcome.kind !== "fallback") continue;
      assert.equal(outcome.reason, "resume_failed:UnsupportedOptionError");
      assert.equal(outcome.request.config.sessionId, "driver-1");
      assert.deepEqual(opened, ["driver-1"]);
      assert.deepEqual(h.framesOf("agent:session:invalidate"), []);
      // The fallback says which option OAR refused and, for a cwd refusal, why.
      const fallback = h.events.find((e) => e.name === "daemon.agent.oar.fallback");
      assert.equal(fallback?.attrs.refused_option, "cwd");
      assert.equal(fallback?.attrs.resume_cwd_reason, reason);
      assert.equal(fallback?.attrs.requestedCwd, undefined, "no path in the trace");
      assert.equal(fallback?.attrs.sessionId, undefined);
    } finally {
      await h.cleanup();
    }
  }
});

// #oar-raft:#25: the agent's model left the agy account (OAR `ModelConfirmationError`).
test("a model agy no longer confirms fails the start here as an unusable model, naming the models agy offers", async () => {
  const modelGone = Object.assign(new Error("agy reported a different model"), {
    name: "ModelConfirmationError",
    requested: "gemini-4-hydrogen",
    reported: "gemini-3.8-flash",
    catalogSelectorIds: ["gemini-3.8-flash", "gemini-4-carbon-medium"],
  });
  const h = await harness({ deps: { ...antigravityDeps, openSession: async () => { throw modelGone; } } });
  try {
    const outcome = await h.host.start(request({ config: antigravityConfig({ model: "gemini-4-hydrogen" }) }));
    assert.equal(outcome.kind, "fallback");
    if (outcome.kind !== "fallback") return;
    assert.equal(outcome.reason, "open_failed:ModelConfirmationError");
    assert.equal(outcome.failHereReason, "model_unsupported", "not handed to the legacy driver, which passes the same model");
    assert.equal(
      outcome.failHere,
      "Antigravity CLI on this Computer no longer offers the model \"gemini-4-hydrogen\". Choose another model in the agent's settings. Available: gemini-3.8-flash, gemini-4-carbon-medium.",
    );
  } finally {
    await h.cleanup();
  }
});

test("only a gone model with a catalog that does not name it is a model-gone failure (any OAR runtime, e.g. Antigravity or Qoder)", () => {
  const gone = (details: Record<string, unknown>) => Object.assign(new Error("x"), { name: "ModelConfirmationError", ...details });
  assert.match(modelConfirmationFailure("antigravity", "m-1", gone({ requested: "m-1", catalogSelectorIds: [] }))!, /listed no models\.$/);
  // Qoder also populates catalogSelectorIds on ModelConfirmationError (#oar-raft:#50 D8).
  const qoderGone = modelConfirmationFailure("qoder", "old-model", gone({ requested: "old-model", catalogSelectorIds: ["ultimate", "qfmodel"] }));
  assert.ok(qoderGone?.includes('no longer offers the model "old-model"'), String(qoderGone));
  assert.ok(qoderGone?.includes("Available: ultimate, qfmodel."), String(qoderGone));
  // No catalog read (e.g. Codex keeping its own model), or one that still lists the model (or the model a level-suffixed id names): not evidence it is gone.
  assert.equal(modelConfirmationFailure("antigravity", "m-1", gone({ requested: "m-1" })), null);
  assert.equal(modelConfirmationFailure("codex", "gpt-x", gone({ requested: "gpt-x", reported: "gpt-y" })), null);
  assert.equal(modelConfirmationFailure("antigravity", "m-1", gone({ requested: "m-1", catalogSelectorIds: ["m-1", "m-2"] })), null);
  assert.equal(modelConfirmationFailure("antigravity", "m-1-xhigh", gone({ requested: "m-1-xhigh", catalogSelectorIds: ["m-1"] })), null);
  assert.equal(modelConfirmationFailure("antigravity", "m-1", new Error("boom")), null);
});
