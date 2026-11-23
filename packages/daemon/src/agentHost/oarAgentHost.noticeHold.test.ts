// Task #triage:#399 step 1 on the OAR host: at most one outstanding pure
// inbox notice per session (outstandingNoticeHold.ts), Codex only.
import assert from "node:assert/strict";
import type { Session } from "@botiverse/oar";
import type { AgentConfig } from "@botiverse/raft-shared";
import { codexShared, harness, makeConfig, message, request, until, type Harness } from "../testing/oarAgentHostHarness";
import { NOTICE_HOLD_DISABLED_ENV } from "../outstandingNoticeHold";
import type { OarAgentHostDeps } from "./oarAgentHost";

// Codex's OAR launch delivers as oarCodexLaunch.ts does: by OAR's status, a
// steer into a running turn.
const CODEX_LIKE_LAUNCH: OarAgentHostDeps["prepareLaunch"] = async (ctx) => ({
  runtimeId: "grok",
  installation: { kind: "available", via: "bundled" },
  options: { cwd: ctx.workingDirectory, systemPrompt: ctx.standingPrompt },
  busyDelivery: "now",
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const outcomes = (h: Harness, outcome: string) =>
  h.events.filter((event) => event.name === "daemon.agent.oar.delivery" && event.attrs.outcome === outcome);

/**
 * The first turn waits for `gate`; later turns end at once. The agent's
 * proxy-read hook is captured. A Codex agent unless `config` says otherwise.
 */
async function heldTurnHarness(options: { wrapSession?: (session: Session) => Session; config?: AgentConfig } = {}) {
  const gate = deferred();
  let turns = 0;
  let readInbox: (() => void) | undefined;
  const h = await harness({
    turn: async (turn) => { turns += 1; if (turns === 1) await gate.promise; turn.say("done"); },
    ...(options.wrapSession ? { wrapSession: options.wrapSession } : {}),
    deps: {
      prepareLaunch: async (ctx) => {
        readInbox = ctx.agentCredentialProxyInboxRead;
        return CODEX_LIKE_LAUNCH!(ctx);
      },
    },
  });
  await h.host.start(request({ config: options.config ?? codexShared() }));
  await until(() => h.inputs.length === 1, "first turn running");
  return { h, gate, readInbox: () => readInbox?.() };
}

/** Three busy batches after the first notice; returns how many notices went into the running turn. */
async function threeBusyBatches(h: Harness): Promise<number> {
  await h.host.deliverMessage("agent-1", message("m-a", { seq: 5000 }), { deliveryId: "d-a" });
  await until(() => outcomes(h, "steered").length === 1, "the first notice steered");
  for (const [i, id] of ["m-b", "m-c", "m-d"].entries()) {
    await h.host.deliverMessage("agent-1", message(id, { seq: 5001 + i }), { deliveryId: `d-${id}` });
    await until(() => outcomes(h, "steered").length + outcomes(h, "held_notice_outstanding").length >= i + 2, `${id} handed off or held`);
  }
  return outcomes(h, "steered").length;
}

test("OAR notice hold: 50 busy message batches between reads steer exactly one notice; the turn end tells the held ones once", async () => {
  const { h, gate } = await heldTurnHarness();
  try {
    assert.equal(await h.host.deliverMessage("agent-1", message("m-0", { seq: 1000 }), { deliveryId: "d-0" }), true);
    await until(() => outcomes(h, "steered").length === 1, "the first notice steered");
    for (let i = 1; i < 50; i += 1) {
      assert.equal(await h.host.deliverMessage("agent-1", message(`m-${i}`, { seq: 1000 + i }), { deliveryId: `d-${i}` }), true);
    }
    await until(() => outcomes(h, "held_notice_outstanding").length > 0, "later notices held");
    const held = outcomes(h, "held_notice_outstanding");
    assert.equal(outcomes(h, "steered").length, 1, "only one notice went into the running turn");
    assert.equal(held.at(-1)?.attrs.notice_held, true);
    assert.equal(held.at(-1)?.attrs.held_count, held.length);

    gate.resolve();
    await until(() => h.inputs.length === 2, "the held messages start the next turn");
    assert.equal(h.steered().length, 1);
    assert.match(h.inputs[1]!, /Inbox/);
    const released = h.events.filter((event) => event.name === "daemon.agent.notice_hold.released");
    assert.equal(released[0]?.attrs.release_reason, "turn_end");
    assert.equal(released[0]?.attrs.held_count, outcomes(h, "held_notice_outstanding").length);
    assert.equal(outcomes(h, "prompted").length, 1, "one notice for everything held");
  } finally {
    gate.resolve();
    await h.cleanup();
  }
});

test("OAR notice hold: a new @mention breaks through once, then the hold resumes", async () => {
  const { h, gate } = await heldTurnHarness();
  try {
    await h.host.deliverMessage("agent-1", message("m-first", { seq: 2000 }), { deliveryId: "d-first" });
    await until(() => outcomes(h, "steered").length === 1, "the first notice steered");
    await h.host.deliverMessage("agent-1", message("m-held", { seq: 2001 }), { deliveryId: "d-held" });
    await until(() => outcomes(h, "held_notice_outstanding").length === 1, "held");

    await h.host.deliverMessage("agent-1", message("m-mention", { seq: 2002, mentioned: true }), { deliveryId: "d-mention" });
    await until(() => outcomes(h, "steered").length === 2, "the mention broke through");
    const breakthrough = outcomes(h, "steered")[1]!;
    assert.equal(breakthrough.attrs.notice_hold_breakthrough, true);
    assert.equal(breakthrough.attrs.held_count, 1);
    assert.equal(breakthrough.attrs.count, 2, "it told the held message too");

    await h.host.deliverMessage("agent-1", message("m-after", { seq: 2003 }), { deliveryId: "d-after" });
    await until(() => outcomes(h, "held_notice_outstanding").length === 2, "held again");
    assert.equal(outcomes(h, "steered").length, 2);
  } finally {
    gate.resolve();
    await h.cleanup();
  }
});

test("OAR notice hold: the agent reading its inbox ends the hold and tells what was held once", async () => {
  const { h, gate, readInbox } = await heldTurnHarness();
  try {
    await h.host.deliverMessage("agent-1", message("m-first", { seq: 3000 }), { deliveryId: "d-first" });
    await until(() => outcomes(h, "steered").length === 1, "the first notice steered");
    await h.host.deliverMessage("agent-1", message("m-held", { seq: 3001 }), { deliveryId: "d-held" });
    await until(() => outcomes(h, "held_notice_outstanding").length === 1, "held");

    readInbox();
    await until(() => outcomes(h, "steered").length === 2, "the held message told after the read");
    const released = h.events.find((event) => event.name === "daemon.agent.notice_hold.released");
    assert.equal(released?.attrs.release_reason, "inbox_read");

    await h.host.deliverMessage("agent-1", message("m-after", { seq: 3002 }), { deliveryId: "d-after" });
    await until(() => outcomes(h, "held_notice_outstanding").length === 2, "that notice is outstanding now");
    assert.equal(outcomes(h, "steered").length, 2);
  } finally {
    gate.resolve();
    await h.cleanup();
  }
});

test("OAR notice hold: a refused steer does not set the hold", async () => {
  let refusals = 1;
  const { h, gate } = await heldTurnHarness({
    wrapSession: (session) => new Proxy(session, {
      get: (target, prop, receiver) => prop === "deliver"
        ? async (...args: Parameters<Session["deliver"]>) => {
          if (refusals > 0) { refusals -= 1; return { landed: "rejected", code: "runtime_refused", reason: "not_steerable: in review" }; }
          return target.deliver(...args);
        }
        : Reflect.get(target, prop, receiver),
    }),
  });
  try {
    await h.host.deliverMessage("agent-1", message("m-refused", { seq: 4000 }), { deliveryId: "d-refused" });
    await until(() => h.events.some((event) => event.name === "daemon.agent.oar.delivery" && event.attrs.code === "runtime_refused"), "the refused steer");
    await h.host.deliverMessage("agent-1", message("m-next", { seq: 4001 }), { deliveryId: "d-next" });
    await until(() => outcomes(h, "steered").length === 1, "the next hand-off steers");
    assert.equal(outcomes(h, "held_notice_outstanding").length, 0, "nothing was outstanding to hold it");
    assert.equal(outcomes(h, "steered")[0]!.attrs.count, 2, "the refused message went with it");
  } finally {
    gate.resolve();
    await h.cleanup();
  }
});

test("OAR notice hold: another runtime (grok) is told of each batch as before", async () => {
  const { h, gate } = await heldTurnHarness({ config: makeConfig() });
  try {
    assert.equal(await threeBusyBatches(h), 4);
    assert.equal(outcomes(h, "held_notice_outstanding").length, 0);
  } finally {
    gate.resolve();
    await h.cleanup();
  }
});

test("OAR notice hold: RAFT_DAEMON_NOTICE_HOLD_DISABLED=1 tells a Codex agent of each batch as before", async () => {
  const previous = process.env[NOTICE_HOLD_DISABLED_ENV];
  process.env[NOTICE_HOLD_DISABLED_ENV] = "1";
  const { h, gate } = await heldTurnHarness();
  try {
    assert.equal(await threeBusyBatches(h), 4);
    assert.equal(outcomes(h, "held_notice_outstanding").length, 0);
  } finally {
    if (previous === undefined) delete process.env[NOTICE_HOLD_DISABLED_ENV];
    else process.env[NOTICE_HOLD_DISABLED_ENV] = previous;
    gate.resolve();
    await h.cleanup();
  }
});

test("OAR notice hold: a new session (stop, then start again) has no outstanding notice", async () => {
  const gates = [deferred(), deferred()];
  let turns = 0;
  const h = await harness({
    turn: async (turn) => { turns += 1; if (turns <= 2) await gates[turns - 1]!.promise; turn.say("done"); },
    deps: { prepareLaunch: CODEX_LIKE_LAUNCH },
  });
  try {
    await h.host.start(request({ config: codexShared() }));
    await until(() => h.inputs.length === 1, "first session's turn running");
    await h.host.deliverMessage("agent-1", message("m-first", { seq: 6000 }), { deliveryId: "d-first" });
    await until(() => outcomes(h, "steered").length === 1, "the first notice steered");
    await h.host.deliverMessage("agent-1", message("m-held", { seq: 6001 }), { deliveryId: "d-held" });
    await until(() => outcomes(h, "held_notice_outstanding").length === 1, "held in the first session");

    // A stop while the turn still runs, as the existing stop tests do; its gate opens at cleanup.
    await h.host.stopAgent("agent-1");
    await h.host.start(request({ launchId: "launch-2", config: codexShared() }));
    await until(() => h.inputs.length === 2 && h.sessions.length === 2, "second session's turn running");
    const heldBefore = outcomes(h, "held_notice_outstanding").length;

    await h.host.deliverMessage("agent-1", message("m-new-session", { seq: 6002 }), { deliveryId: "d-new" });
    await until(() => outcomes(h, "steered").length === 2, "steered into the new session");
    assert.equal(outcomes(h, "held_notice_outstanding").length, heldBefore, "nothing outstanding carried over");
  } finally {
    for (const gate of gates) gate.resolve();
    await h.cleanup();
  }
});

test("OAR notice hold: batches that arrive while a notice's steer is in flight steer once", async () => {
  // Gates the next steer while set; counts steers and prompts so the test knows what was tried.
  let deliverGate: ReturnType<typeof deferred> | null = null;
  let deliverCalls = 0;
  let promptCalls = 0;
  const { h, gate } = await heldTurnHarness({
    wrapSession: (session) => new Proxy(session, {
      get: (target, prop, receiver) => {
        if (prop === "deliver") {
          return async (...args: Parameters<Session["deliver"]>) => {
            deliverCalls += 1;
            const waitFor = deliverGate;
            if (waitFor) await waitFor.promise;
            return target.deliver(...args);
          };
        }
        if (prop === "prompt") {
          return async (...args: Parameters<Session["prompt"]>) => {
            promptCalls += 1;
            return target.prompt(...args);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }),
  });
  try {
    // The first notice's steer is in flight while three batches arrive.
    const firstSteer = deferred();
    deliverGate = firstSteer;
    await h.host.deliverMessage("agent-1", message("m-0", { seq: 7000 }), { deliveryId: "d-0" });
    await until(() => deliverCalls === 1, "the first steer in flight");
    deliverGate = null;
    for (let i = 1; i <= 3; i += 1) {
      await h.host.deliverMessage("agent-1", message(`m-${i}`, { seq: 7000 + i }), { deliveryId: `d-${i}` });
    }
    firstSteer.resolve();
    await until(() => outcomes(h, "steered").length === 1 && outcomes(h, "held_notice_outstanding").length >= 1, "the steer landed, the rest held");

    // Later batches while the notice is still outstanding: held at once, nothing tried.
    const promptsBefore = promptCalls;
    const heldBefore = outcomes(h, "held_notice_outstanding").length;
    for (let i = 4; i <= 7; i += 1) {
      await h.host.deliverMessage("agent-1", message(`m-${i}`, { seq: 7000 + i }), { deliveryId: `d-${i}` });
    }
    await until(() => outcomes(h, "held_notice_outstanding").length >= heldBefore + 4, "all four held");
    assert.equal(promptCalls, promptsBefore, "no prompt was tried for a held notice");
    assert.equal(outcomes(h, "steered").length, 1, "one notice for all eight batches");
    assert.equal(deliverCalls, 1, "no second steer was even tried");
  } finally {
    gate.resolve();
    await h.cleanup();
  }
});
