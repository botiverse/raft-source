// #raft-antiproton:#14, the OAR host's side of #15075: a delivery the host
// held on custody (acked to the core) and dropped at an end of the agent's
// session (a stop, an exit planned for the next wake, a restart that could not
// run, ...) comes back as chat with the next start's catch-up, but an app event
// has none and stays `delivering` on the Server until it expires. The host
// reports the dropped app events (`agent:inbox:dropped_app_events`), as the
// legacy host's `reportDroppedAppEvents` does, so the Server queues them for
// the next start. So is an app event a start brought as its wake (a refused
// push the server converted into the start), held in its first input. Chat,
// transient notices, idle hand-overs and deliveries carried into the next
// session send nothing.
//
// RED proof (reverse-verified): never call reportDroppedAppEvents from
// dropHeld and the stop, silent stop, exit, chat and cap cases find no frame;
// never call it from restartFailed and "a restart that cannot run" finds none;
// leave out the restart request's start inputs there and "a wake ... carried
// into a restart that cannot run" finds none;
// nor from the first input's refusal and "a refused held first input" finds
// none; nor from the flush's refusal and "a transport error" finds none; no
// `startEventIds` on the held first input and "an app event wake" finds none;
// drop the IDLE_HANDOVER_REASONS check and "an idle hand-over" sends a frame.
import assert from "node:assert/strict";
import type { Session } from "@botiverse/oar";
import { ProviderLimitLedger, providerLimitCredentialKey } from "../providerLimitLedger";
import { scriptedRuntime, type ScriptedTurn } from "@botiverse/oar/testing";
import type { AgentMessage } from "@botiverse/raft-shared";
import { AGENT_INBOX_DROPPED_APP_EVENTS_MAX_IDS } from "@botiverse/raft-shared";
import {
  codexShared,
  harness,
  limitEvents,
  limitHarness,
  makeConfig,
  message,
  request,
  sleep,
  startRequest,
  until,
  type Harness,
} from "../testing/oarAgentHostHarness";

const STALL = { stallMs: 100, nonStdinAliveStallMs: 250 };

const eventId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** An app event delivery (a `third_party_event`), as the Server pushes one. */
const appEvent = (messageId: string, id: string): AgentMessage => message(messageId, {
  third_party_event: {
    id,
    kind: "event",
    client_id: "app-1",
    client_name: "App",
    payload_hash: "0".repeat(64),
    payload: {},
    expires_at: "2026-12-01T00:00:00.000Z",
    source: { client_id: "app-1", client_name: "App", oauth_client_id: "oauth-1", resource: "agent" },
  },
});

const dropped = (h: Harness) => h.framesOf("agent:inbox:dropped_app_events");
const heldForLimit = (h: Harness) => h.events.filter((event) => event.name === "daemon.agent.oar.delivery" && event.attrs.outcome === "held_for_provider_limit");

/** A turn that says nothing until the host aborts it or ends its session. */
function hang(turn: ScriptedTurn): Promise<void> {
  return new Promise<void>((resolve) => {
    if (turn.signal.aborted) resolve();
    else turn.signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/** Agent 1 under a provider limit after its first turn: deliveries are held on custody, never handed over. */
async function heldUnderLimit(): Promise<Harness> {
  const { h } = await limitHarness("quota", { failing: ["agent-1"] });
  await h.host.start(startRequest("agent-1", codexShared()));
  await until(() => limitEvents(h, "agent-1").length > 0, "the provider limit recorded");
  return h;
}

for (const [stop, exitReason] of [["stopAgent", "explicit_stop"], ["stopAll", "silent_stop"]] as const) {
  test(`an app event held for a provider limit, then ${stop}: reported with its id and the end's reason`, async () => {
    const h = await heldUnderLimit();
    try {
      assert.equal(await h.host.deliverMessage("agent-1", appEvent("m-app", eventId(1))), true, "custody: acked while held");
      await until(() => heldForLimit(h).length > 0, "held for the limit");
      assert.deepEqual(dropped(h), []);
      if (stop === "stopAgent") await h.host.stopAgent("agent-1", { wait: true });
      else await h.host.stopAll();
      assert.deepEqual(dropped(h), [{
        type: "agent:inbox:dropped_app_events",
        agentId: "agent-1",
        launchId: "launch-agent-1",
        daemonInstanceId: "daemon-1",
        exitReason,
        eventIds: [eventId(1)],
      }]);
      // The server validates the reason against /^[a-z_]{1,48}$/.
      assert.match(exitReason, /^[a-z_]{1,48}$/);
    } finally {
      await h.cleanup();
    }
  });
}

test("an exit planned for the next wake with an app event held: reported as runtime_exited", async () => {
  const h = await harness({ turn: hang });
  try {
    await h.host.start(request());
    await until(() => h.inputs.length === 1, "the first turn running");
    assert.equal(await h.host.deliverMessage("agent-1", appEvent("m-app", eventId(2))), true, "acked on custody");
    // The runtime process ends on its own (a dispose the host did not ask for).
    await h.sessions[0]!.dispose();
    await until(() => h.framesOf("agent:process_exited").length > 0, "process_exited");
    assert.ok(h.events.some((event) => event.name === "daemon.agent.oar.held_dropped" && event.attrs.reason === "runtime_exited"));
    assert.deepEqual(dropped(h).map((frame) => [frame.exitReason, frame.launchId, frame.eventIds]), [["runtime_exited", "launch-1", [eventId(2)]]]);
  } finally {
    await h.cleanup();
  }
});

test("chat and transient notices are never reported; a stop holding only chat sends nothing", async () => {
  const h = await heldUnderLimit();
  try {
    await h.host.deliverMessage("agent-1", message("m-chat"));
    await until(() => heldForLimit(h).length > 0, "held for the limit");
    await h.host.deliverMessage("agent-1", appEvent("m-transient", eventId(3)), { transient: true });
    await h.host.deliverMessage("agent-1", appEvent("m-app", eventId(4)));
    await h.host.deliverMessage("agent-1", message("m-chat-2"));
    await h.host.stopAgent("agent-1", { wait: true });
    assert.deepEqual(dropped(h).map((frame) => frame.eventIds), [[eventId(4)]], "only the app event acked on custody");
  } finally {
    await h.cleanup();
  }

  const chatOnly = await heldUnderLimit();
  try {
    await chatOnly.host.deliverMessage("agent-1", message("m-chat"));
    await until(() => heldForLimit(chatOnly).length > 0, "held for the limit");
    await chatOnly.host.stopAgent("agent-1", { wait: true });
    assert.ok(chatOnly.events.some((event) => event.name === "daemon.agent.oar.held_dropped"), "the chat was dropped");
    assert.deepEqual(dropped(chatOnly), [], "chat comes back with the catch-up");
  } finally {
    await chatOnly.cleanup();
  }
});

test(`at most ${AGENT_INBOX_DROPPED_APP_EVENTS_MAX_IDS} ids, each once`, async () => {
  const h = await heldUnderLimit();
  try {
    for (let n = 0; n < 150; n += 1) await h.host.deliverMessage("agent-1", appEvent(`m-app-${n}`, eventId(n)));
    // The same event again under another delivery.
    await h.host.deliverMessage("agent-1", appEvent("m-app-again", eventId(0)));
    await h.host.stopAgent("agent-1", { wait: true });
    const frames = dropped(h);
    assert.equal(frames.length, 1);
    assert.deepEqual(frames[0]!.eventIds, Array.from({ length: AGENT_INBOX_DROPPED_APP_EVENTS_MAX_IDS }, (_, n) => eventId(n)));
  } finally {
    await h.cleanup();
  }
});

test("a restart that cannot run on OAR (restartFailed) reports the app events it held", async () => {
  const runtime = scriptedRuntime({ turn: hang });
  const sessions: Session[] = [];
  const h = await harness({
    openSession: async (launch) => {
      if (sessions.length > 0) {
        const error = new Error("session not found");
        error.name = "SessionNotFoundError";
        throw error;
      }
      const session = await runtime.session({ kind: "available", via: "bundled" }, launch.options);
      sessions.push(session);
      return session;
    },
    deps: { stalledWithWorkThresholds: STALL },
  });
  try {
    await h.host.start(request());
    await until(() => sessions[0]?.status().value.kind === "running", "the first turn running");
    await h.host.deliverMessage("agent-1", appEvent("m-app", eventId(5)));
    await h.host.deliverMessage("agent-1", message("m-chat"));
    await until(() => h.events.some((event) => event.name === "daemon.agent.oar.stall_restart_failed"), "the failed restart");
    assert.equal(h.host.owns("agent-1"), false);
    // The stall's own end carried them into the restart: reported once, by the failed restart.
    assert.deepEqual(dropped(h).map((frame) => [frame.exitReason, frame.launchId, frame.eventIds]), [["restart_failed", "launch-1", [eventId(5)]]]);
  } finally {
    await h.cleanup();
  }
});

test("an app event carried into the next session (restartAfterEnd) is not reported", async () => {
  let turns = 0;
  const h = await harness({
    turn: async (turn) => {
      turns += 1;
      if (turns === 1) await hang(turn);
      else turn.say("ok");
    },
    deps: { stalledWithWorkThresholds: STALL },
  });
  try {
    await h.host.start(request());
    await until(() => h.sessions[0]?.status().value.kind === "running" && h.inputs.length === 1, "the first turn running");
    await h.host.deliverMessage("agent-1", appEvent("m-app", eventId(6)));
    await until(() => h.inputs.length === 2, "the next session's first input");
    assert.equal(h.events.filter((event) => event.name === "daemon.agent.oar.first_input")[1]!.attrs.carried_deliveries, 1);
    await until(() => h.sessions[1]!.status().value.kind === "idle", "the next session idle");
    assert.deepEqual(dropped(h), []);
  } finally {
    await h.cleanup();
  }
});

test("an idle hand-over sends nothing: an idle process stop after an app event was taken, and the idle reasons themselves", async () => {
  const offset = { ms: 0 };
  const h = await harness({ deps: { now: () => Date.now() + offset.ms, featuresSweepMs: 10 } });
  try {
    const config = makeConfig({ runtime: "codex", sessionId: "sess-idle" });
    await h.host.start(request({ config, wakeMessage: message("m-1") }));
    await until(() => h.framesOf("agent:turn:ended").length > 0, "the first turn's end");
    await until(() => h.sessions[0]!.status().value.kind === "idle", "idle");
    await h.host.deliverMessage("agent-1", appEvent("m-app", eventId(7)));
    await until(() => h.inputs.length === 2, "the app event's turn");
    await until(() => h.sessions[0]!.status().value.kind === "idle", "idle again");
    offset.ms = 2 * 60 * 60_000;
    await until(() => h.events.some((event) => event.name === "daemon.agent.idle_process_stop"), "the idle process stop");
    await h.host.unwound("agent-1");
    assert.deepEqual(dropped(h), []);

    assert.equal(h.events.some((event) => event.name === "daemon.agent.oar.dropped_app_events"), false, "nothing held: nothing skipped either");

    // No idle path holds anything today; one that ever drops app events is traced, not sent.
    for (const reason of ["cold_idle_recycle", "idle_process_stop", "warm_recycle"]) {
      h.host.reportDroppedAppEvents("agent-1", "launch-1", reason, [eventId(8), eventId(9), eventId(8)]);
    }
    assert.deepEqual(dropped(h), [], "an idle hand-over is never reported");
    assert.deepEqual(
      h.events.filter((event) => event.name === "daemon.agent.oar.dropped_app_events").map((event) => event.attrs),
      ["cold_idle_recycle", "idle_process_stop", "warm_recycle"].map((reason) => ({ agentId: "agent-1", launchId: "launch-1", reason, count: 2, outcome: "skipped_idle_handover" })),
    );
  } finally {
    await h.cleanup();
  }
});

test("an app event that came as the start's wake, held in its first input for a provider limit, then a stop: reported", async () => {
  for (const transient of [false, true]) {
    const { h, ledger } = await limitHarness("quota", { failing: [] });
    try {
      const now = Date.now();
      ledger.record("shared:codex", { attempts: 1, reason: "rate_limited", untilMs: now + 30 * 60_000, providerLimitKind: "quota_exhausted", recordedAtMs: now }, { host: "legacy" });
      // The server's `converted_to_wake`: a refused push of the app event became this start.
      await h.host.start({ ...startRequest("agent-1", codexShared()), wakeMessage: appEvent("m-wake", eventId(10)), wakeMessageTransient: transient });
      assert.ok(h.events.some((event) => event.name === "daemon.agent.oar.first_input" && event.attrs.outcome === "held_for_provider_limit"));
      await h.host.stopAgent("agent-1", { wait: true });
      assert.deepEqual(
        dropped(h).map((frame) => [frame.exitReason, frame.eventIds]),
        transient ? [] : [["explicit_stop", [eventId(10)]]],
        transient ? "a transient wake is never reported" : "the wake's app event",
      );
    } finally {
      await h.cleanup();
    }
  }
});

/** Prompts after the first `allowed` are refused with `code`. */
function refusingAfter(allowed: number, control: { code: "error" | "unsupported" }) {
  let prompts = 0;
  return (session: Session): Session => new Proxy(session, {
    get(target, property, receiver) {
      if (property === "prompt") {
        return (input: string, options?: unknown) => {
          prompts += 1;
          if (prompts > allowed) return Promise.resolve({ kind: "rejected", code: control.code, reason: "adapter threw: socket hang up" });
          return (target.prompt as (input: string, options?: unknown) => Promise<unknown>)(input, options);
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

test("an app event whose prompt to an idle session fails with a transport error is reported; one the runtime cannot take (unsupported) is not", async () => {
  for (const code of ["error", "unsupported"] as const) {
    const h = await harness({ wrapSession: refusingAfter(1, { code }) });
    try {
      await h.host.start(request());
      await until(() => h.framesOf("agent:turn:ended").length > 0, "the first turn's end");
      await until(() => h.sessions[0]!.status().value.kind === "idle", "idle");
      assert.equal(await h.host.deliverMessage("agent-1", appEvent("m-app", eventId(11))), true);
      await until(() => h.events.some((event) => event.name === "daemon.agent.oar.delivery" && event.attrs.outcome === "rejected"), "the refusal");
      await sleep(20);
      assert.deepEqual(
        dropped(h).map((frame) => [frame.exitReason, frame.eventIds]),
        code === "error" ? [["refused_error", [eventId(11)]]] : [],
        code,
      );
      assert.equal(h.host.owns("agent-1"), true, "the session keeps running");
    } finally {
      await h.cleanup();
    }
  }
});

test("a refused held first input reports the app events it carried (first_input_refused)", async () => {
  const ledger = new ProviderLimitLedger();
  const key = providerLimitCredentialKey("agent-1", makeConfig());
  let opens = 0;
  let turns = 0;
  const h = await harness({
    turn: async (turn) => {
      turns += 1;
      if (turns === 1) await hang(turn);
      else turn.say("ok");
    },
    // The stall replacement's start finds the credential at its limit: its first input, naming the carried delivery, is held.
    openGate: (n) => {
      if (n === 2) ledger.record(key, { attempts: 1, reason: "rate_limited", untilMs: Date.now() + 30 * 60_000, providerLimitKind: "quota_exhausted", recordedAtMs: Date.now() }, { host: "legacy" });
      return undefined;
    },
    // The replacement session's every prompt fails in the adapter.
    wrapSession: (session) => {
      opens += 1;
      return opens === 2 ? refusingAfter(0, { code: "error" })(session) : session;
    },
    deps: { stalledWithWorkThresholds: STALL, providerLimits: ledger },
  });
  try {
    await h.host.start(request());
    await until(() => h.sessions[0]?.status().value.kind === "running" && h.inputs.length === 1, "the first turn running");
    await h.host.deliverMessage("agent-1", appEvent("m-app", eventId(12)));
    await until(() => h.events.some((event) => event.name === "daemon.agent.oar.first_input" && event.attrs.outcome === "held_for_provider_limit" && event.attrs.carried_deliveries === 1), "the replacement's held first input");
    assert.deepEqual(dropped(h), [], "held, not dropped");
    ledger.release(key, "credentials_changed", { host: "legacy" });
    await until(() => dropped(h).length > 0, "the report");
    await sleep(20);
    assert.deepEqual(dropped(h).map((frame) => [frame.exitReason, frame.launchId, frame.eventIds]), [["first_input_refused", "launch-1", [eventId(12)]]]);
  } finally {
    await h.cleanup();
  }
});

test("a wake held in the first input for a provider limit, carried into a restart that cannot run on OAR: reported by restartFailed", async () => {
  const ledger = new ProviderLimitLedger();
  const key = providerLimitCredentialKey("agent-1", makeConfig());
  const runtime = scriptedRuntime({ turn: (turn) => { turn.say("ok"); } });
  const sessions: Session[] = [];
  const h = await harness({
    openSession: async (launch) => {
      if (sessions.length > 0) {
        const error = new Error("session not found");
        error.name = "SessionNotFoundError";
        throw error;
      }
      const session = await runtime.session({ kind: "available", via: "bundled" }, launch.options);
      sessions.push(session);
      return session;
    },
    deps: { providerLimits: ledger },
  });
  try {
    ledger.record(key, { attempts: 1, reason: "rate_limited", untilMs: Date.now() + 30 * 60_000, providerLimitKind: "quota_exhausted", recordedAtMs: Date.now() }, { host: "legacy" });
    await h.host.start(request({ wakeMessage: appEvent("m-wake", eventId(13)) }));
    assert.ok(h.events.some((event) => event.name === "daemon.agent.oar.first_input" && event.attrs.outcome === "held_for_provider_limit"));
    // The runtime exits with the first input held: the restart rebuilds it from the same wake, after the limit.
    await sessions[0]!.dispose();
    await until(() => h.events.some((event) => event.name === "daemon.agent.oar.restart_scheduled"), "the restart scheduled");
    assert.deepEqual(dropped(h), [], "carried into the restart, not dropped");
    ledger.release(key, "credentials_changed", { host: "legacy" });
    await until(() => h.events.some((event) => event.name === "daemon.agent.oar.exit_restart_failed"), "the failed restart");
    assert.equal(h.host.owns("agent-1"), false);
    assert.deepEqual(dropped(h).map((frame) => [frame.exitReason, frame.launchId, frame.eventIds]), [["restart_failed", "launch-1", [eventId(13)]]]);
  } finally {
    await h.cleanup();
  }
});
