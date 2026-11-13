// Reconciler step 11a on the OAR host: `agent:config` replaces the agent's
// request config (keeping the launch's session and credential), never wakes
// it, and the one reconcile entry ends a drifted session once idle. As every
// spec stop here, the host never starts it again itself: the next delivery
// finds no agent and the server's start (on the host the router picks) runs
// on the new config. A push held before the start reached this host is
// applied when it registers, if newer than that start. A session whose
// config drops it is never reported again (#13295 residual).
//
// Push vs a rebound start with a wake (step 7): a rebind carries a launch and
// a wake, which keeps the session busy until that wake's turn ends; a push
// carries neither, so it only waits for the current turn and held deliveries.
//
// RED proof: drop the reconcile call in applyConfig and the idle session is
// never ended; drop the held-push take in startHosted and the launch plans on
// the start's model; guard nothing in reportSession and the Codex rebind
// reports the old thread.

import assert from "node:assert/strict";
import { AgentConfigRevisions } from "../agentConfigRevisions";
import { codexShared, harness, limitEvents, limitHarness, makeConfig, message, request, sleep, startRequest, until, type Harness } from "../testing/oarAgentHostHarness";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const specStops = (h: Harness) => h.events.filter((event) => event.name === "daemon.agent.spec_restart_stop").map((event) => event.attrs);
const pushEvents = (h: Harness) => h.events.filter((event) => event.name === "daemon.agent.config_push").map((event) => event.attrs);

test("OAR: a push while busy ends nothing; the session is ended at its turn end, and nothing starts it again here", async () => {
  const release = deferred();
  const h = await harness({ turn: async (t) => { await release.promise; t.say("done"); } });
  try {
    assert.deepEqual(await h.host.start(request()), { kind: "started" });
    await until(() => h.sessions[0]?.status().value.kind === "running", "the first turn running");
    const sessionId = h.sessions[0]!.id;
    h.host.applyConfig("agent-1", makeConfig({ model: "grok-other", sessionId: "server-session" }), 4);
    await sleep(20);
    assert.equal(h.host.owns("agent-1"), true, "not under a running turn");
    assert.deepEqual(specStops(h), []);
    assert.equal(h.host.hostedSession("agent-1")!.config.model, "default", "the runtime profile still reads the launch's config");
    assert.deepEqual(pushEvents(h), [{ agentId: "agent-1", revision: 4, outcome: "applied", stage: "running", launchId: "launch-1", drift: "model", host: "oar" }]);

    release.resolve();
    await until(() => specStops(h).length > 0, "the stop at the turn end");
    assert.deepEqual(specStops(h).map((stop) => [stop.drift, stop.trigger, stop.session_id]), [["model", "turn_end", sessionId]]);
    assert.equal(h.host.owns("agent-1"), false);
    await h.host.unwound("agent-1");
    await sleep(20);
    assert.equal(h.opened.length, 1, "no local restart");
    assert.equal(h.inputs.length, 1, "never woken");
  } finally {
    release.resolve();
    await h.cleanup();
  }
});

test("OAR: a push with the same spec ends nothing and wakes nothing", async () => {
  const h = await harness();
  try {
    await h.host.start(request());
    await until(() => h.sessions[0]?.status().value.kind === "idle", "idle");
    h.host.applyConfig("agent-1", makeConfig({ description: "another role" }), 2);
    await sleep(20);
    assert.equal(h.host.owns("agent-1"), true);
    assert.deepEqual(specStops(h), []);
    assert.equal(h.inputs.length, 1);
  } finally {
    await h.cleanup();
  }
});

test("OAR: a runtime change ends the idle session; the agent leaves the host for the server's next start", async () => {
  const h = await harness();
  try {
    await h.host.start(request());
    await until(() => h.sessions[0]?.status().value.kind === "idle", "idle");
    h.host.applyConfig("agent-1", makeConfig({ runtime: "codex", model: "gpt-5.5" }), 2);
    assert.equal(specStops(h).length, 1);
    assert.ok(String(specStops(h)[0]!.drift).split(",").includes("runtime"));
    assert.equal(specStops(h)[0]!.trigger, "signal");
    assert.equal(h.host.owns("agent-1"), false);
    await h.host.unwound("agent-1");
    await sleep(20);
    assert.equal(h.opened.length, 1, "nothing started here");
  } finally {
    await h.cleanup();
  }
});

test("OAR: a delivery right after the idle stop is refused to the server, whose start delivers it to the next session once", async () => {
  const h = await harness();
  try {
    await h.host.start(request());
    await until(() => h.sessions[0]?.status().value.kind === "idle", "idle");
    h.host.applyConfig("agent-1", makeConfig({ model: "grok-other" }), 2);
    assert.equal(h.host.owns("agent-1"), false, "the idle stop began");

    let rejected = 0;
    const delivered = message("m-race", { content: "race-unique-body" });
    assert.equal(await h.host.deliverMessage("agent-1", delivered, { onRejectedNoProcess: () => { rejected += 1; } }), false);
    assert.equal(rejected, 1, "the server converts it into its start");

    // The server's start carries it as its wake.
    assert.deepEqual(await h.host.start(request({ launchId: "launch-2", config: makeConfig({ model: "grok-other", sessionId: h.sessions[0]!.id }), wakeMessage: delivered })), { kind: "started" });
    await until(() => h.inputs.length === 2, "the next session's first input");
    await sleep(20);
    assert.equal(h.inputs.length, 2);
    assert.equal(h.inputs[1]!.split("race-unique-body").length - 1, 1, "delivered once");
    assert.equal(h.opened[1]!.options.resume, h.sessions[0]!.id, "another grok model resumes the session");
  } finally {
    await h.cleanup();
  }
});

test("OAR: a push held before the start reached the host is applied at registration when newer, dropped when not", async () => {
  for (const [startRevision, expected] of [[1, "grok-other"], [3, "default"], [undefined, "default"]] as const) {
    const revisions = new AgentConfigRevisions();
    const h = await harness({ deps: { configRevisions: revisions } });
    try {
      revisions.noteStart("agent-1", startRevision);
      revisions.holdPush("agent-1", { config: makeConfig({ model: "grok-other" }), revision: 2 });
      await h.host.start(request());
      assert.equal(h.host.hostedSession("agent-1")!.config.model, expected, `start revision ${String(startRevision)}`);
      assert.equal(revisions.takeHeldPush("agent-1"), null, "decided once");
    } finally {
      await h.cleanup();
    }
  }
});

test("OAR: a pushed runtime change before the launch is planned waits for the plan, then ends the session as drift", async () => {
  const gate = deferred();
  const h = await harness({ firstOpenGate: gate.promise });
  try {
    const started = h.host.start(request());
    h.host.applyConfig("agent-1", makeConfig({ runtime: "codex", model: "gpt-5.5" }), 2);
    gate.resolve();
    assert.deepEqual(await started, { kind: "started" });
    await until(() => specStops(h).length > 0, "the drift ends it at the first idle moment");
    assert.ok(String(specStops(h)[0]!.drift).split(",").includes("runtime"));
  } finally {
    gate.resolve();
    await h.cleanup();
  }
});

test("OAR: after a Codex model push the old thread is never reported (rebind, getAgentSessionId)", async () => {
  const release = deferred();
  const h = await harness({ turn: async (t) => { await release.promise; t.say("done"); } });
  try {
    assert.deepEqual(await h.host.start(startRequest("agent-1", codexShared({ model: "gpt-5.5" }))), { kind: "started" });
    await until(() => h.sessions[0]?.status().value.kind === "running", "busy");
    const thread = h.sessions[0]!.id;
    assert.equal(h.framesOf("agent:session").length, 1, "precondition: reported at its commit");
    assert.equal(h.host.getAgentSessionId("agent-1"), thread);

    h.host.applyConfig("agent-1", codexShared({ model: "gpt-5.4" }), 2);
    assert.equal(h.host.getAgentSessionId("agent-1"), null);
    await h.host.start(request({ launchId: "launch-2", config: codexShared({ model: "gpt-5.4" }) }));
    assert.equal(h.framesOf("agent:session").length, 1, "the rebind reports no session");
  } finally {
    release.resolve();
    await h.cleanup();
  }
});

// Reconciler step 11 (review of #13355): as on the legacy host. RED proof:
// ignore isStaleStart in `rebind` and the request goes back to the r5 model.
test("OAR: a start older than the applied push rebinds the launch and delivers its wake, but keeps the pushed config", async () => {
  const revisions = new AgentConfigRevisions();
  const gate = deferred();
  let turns = 0;
  const h = await harness({
    deps: { configRevisions: revisions },
    turn: async (turn) => { turns += 1; if (turns === 1) await gate.promise; turn.say("done"); },
  });
  try {
    revisions.noteStart("agent-1", 4, undefined);
    assert.deepEqual(await h.host.start(request()), { kind: "started" });
    await until(() => h.inputs.length === 1, "first turn running");
    const sessionId = h.sessions[0]!.id;

    assert.equal(revisions.acceptPush("agent-1", 6), true);
    h.host.applyConfig("agent-1", makeConfig({ model: "grok-other" }), 6);
    const r5 = makeConfig({ model: "default", sessionId });
    revisions.noteStart("agent-1", 5, r5);
    h.waiting.set("agent-1", ["launch-5"]);
    const wake = message("m-wake", { content: "stale-start-wake-body" });
    assert.deepEqual(await h.host.start(request({ launchId: "launch-5", config: r5, wakeMessage: wake })), { kind: "rebound" });

    const agent = (h.host as any).agents.get("agent-1");
    assert.equal(agent.request.config.model, "grok-other", "the newer config stays");
    assert.equal(h.host.getAgentLaunchId("agent-1"), "launch-5", "the launch rebinds");
    assert.deepEqual(h.rebound.map((each) => each.launchId), ["launch-5"]);
    assert.equal(h.framesOf("agent:session").at(-1)?.launchId, "launch-5");
    assert.ok(pushEvents(h).some((event) => event.outcome === "stale_start_config_kept"));

    gate.resolve();
    await until(() => h.inputs.length === 2, "the wake's turn");
    assert.equal(h.inputs[1]!.split("stale-start-wake-body").length - 1, 1, "the wake is delivered once");
  } finally {
    gate.resolve();
    await h.cleanup();
  }
});

// #triage:#263, the general rule: a delivery held for the agent's provider
// limit cannot reach the session until the wait ends, so it holds no
// idle-gated step. Here a change that keeps the session (an env var).
test("OAR: a delivery held for a provider limit does not hold a session-keeping config change", async () => {
  const resetsAt = new Date(Date.now() + 30 * 60_000).toISOString();
  const { h, turnInputs } = await limitHarness("quota", { extra: { resetsAt }, backoff: { jitterRatio: 0 } });
  try {
    await h.host.start(startRequest("agent-1", codexShared()));
    await until(() => limitEvents(h, "agent-1").length > 0, "the provider limit recorded");
    assert.equal(await h.host.deliverMessage("agent-1", message("m-held")), true);
    await sleep(50);
    assert.equal(turnInputs.get("agent-1")?.length, 1, "held");
    h.host.applyConfig("agent-1", codexShared({ envVars: { EXTRA: "1" } }), 2);
    await until(() => specStops(h).length > 0, "the spec stop");
    assert.equal(specStops(h).at(-1)!.drift, "env");
  } finally {
    await h.cleanup();
  }
});
