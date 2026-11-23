// Focus on the OAR host (docs/contracts/agent-focus.md, "What the Computer
// does"): a message the Server tagged `focused` is written in full while the
// agent's features have `agentFocus`, idle and busy; the notice covers only
// the rest; a focused body the runtime took is reported `agent:model-seen`
// (a steer when the turn it joined ends completed, a prompt at its turn's
// first model output), a refused, dropped or interrupted one never. With the
// flag off every input is what it was.
import assert from "node:assert/strict";
import type { Session } from "@botiverse/oar";
import type { AgentConfig, AgentMessage } from "@botiverse/raft-shared";
import { formatConcreteMessagesRuntimeInput, formatInboxUpdateRuntimeInput, inboxUpdateRenderOptions } from "../agentRuntimeInput";
import { getDriver } from "../drivers/index";
import { ProviderLimitLedger } from "../providerLimitLedger";
import { codexShared, harness, makeConfig, message, request, until, type Harness } from "../testing/oarAgentHostHarness";
import { OarAgentHost, type OarAgentHostDeps } from "./oarAgentHost";

// A launch that delivers into a running turn (`busyDelivery: "now"`), as
// Codex's OAR launch does. The session itself is the scripted fixture, opened
// as the harness opens it (`runtimeId: "grok"`); the agent's runtime, which
// the Codex notice hold reads, comes from its config (`focusOn()` is Codex).
/** The spawn context of the last launch: what the agent's proxy is registered with. */
let lastLaunchContext: Parameters<NonNullable<OarAgentHostDeps["prepareLaunch"]>>[0] | null = null;

const STEERING_LAUNCH: OarAgentHostDeps["prepareLaunch"] = async (ctx) => (lastLaunchContext = ctx, {
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

const focusOn = (overrides: Partial<AgentConfig> = {}) => codexShared({ agentFocus: true, ...overrides });
const outcomes = (h: Harness, outcome: string) =>
  h.events.filter((event) => event.name === "daemon.agent.oar.delivery" && event.attrs.outcome === outcome);
const seen = (h: Harness) => h.framesOf("agent:model-seen").flatMap((frame) => frame.items);
const dropped = (h: Harness) => h.events.filter((event) => event.name === "daemon.agent.model_seen.dropped");

/** A message of one thread conversation; `focused` unless `extra` says otherwise. */
const threadMessage = (id: string, seq: number, extra: Partial<AgentMessage> = {}): AgentMessage => message(id, {
  channel_id: "thread-1",
  channel_type: "thread",
  channel_name: "thread-aaaabbbb",
  parent_channel_name: "general",
  parent_channel_type: "channel",
  seq,
  content: `body of ${id}`,
  focused: true,
  ...extra,
});
const plainMessage = (id: string, seq: number, extra: Partial<AgentMessage> = {}): AgentMessage =>
  message(id, { channel_id: "channel-2", channel_name: "random", seq, content: `body of ${id}`, ...extra });

const MENTION = { occurrenceId: "occ-1", messageId: "m", machineId: "machine-1", launchId: "launch-1", sessionId: "s" } as never;

/** The turns in `gated` (from 1) wait for their gate before the model says anything. */
async function gatedHarness(options: {
  gated: number[];
  config?: AgentConfig;
  steers?: boolean;
  wrapSession?: (session: Session) => Session;
  start?: Parameters<typeof request>[0];
  silentTurns?: number[];
}) {
  const gates = new Map(options.gated.map((turn) => [turn, deferred()]));
  let turns = 0;
  const h = await harness({
    turn: async (turn) => {
      turns += 1;
      const mine = turns;
      await gates.get(mine)?.promise;
      if (!options.silentTurns?.includes(mine)) turn.say("done");
    },
    ...(options.wrapSession ? { wrapSession: options.wrapSession } : {}),
    ...(options.steers === false ? {} : { deps: { prepareLaunch: STEERING_LAUNCH } }),
  });
  await h.host.start(request({ config: options.config ?? focusOn(), ...options.start }));
  await until(() => h.inputs.length >= 1, "first turn running");
  const release = (turn: number) => gates.get(turn)?.resolve();
  const cleanup = async () => { for (const gate of gates.values()) gate.resolve(); await h.cleanup(); };
  return { h, release, cleanup };
}

const firstTurnOver = (h: Harness) => until(() => h.framesOf("agent:runtime:outcome").length > 0, "the first turn ended");

test("OAR focus, idle: a focused message is written in full and reported once the turn it opened shows model output", async () => {
  const { h, release, cleanup } = await gatedHarness({ gated: [2] });
  try {
    await firstTurnOver(h);
    const focused = threadMessage("m-idle", 100, { focus_change: { reason: "mentioned", focused: ["#general:aaaabbbb"], unfocused: [] } as AgentMessage["focus_change"] });
    assert.equal(await h.host.deliverMessage("agent-1", focused, { deliveryId: "d-idle" }), true);
    await until(() => h.inputs.length === 2, "the message opened a turn");
    assert.match(h.inputs[1]!, /^New message received:/);
    assert.match(h.inputs[1]!, /msg=m-idle [^\n]*body of m-idle/);
    assert.doesNotMatch(h.inputs[1]!, /Raft inbox notice/);
    assert.match(h.inputs[1]!, /\[Raft focused #general:aaaabbbb because you were @mentioned there\. New messages there now arrive in full\./);
    assert.doesNotMatch(h.inputs[1]!, /count as read|marked read/i);
    await until(() => outcomes(h, "prompted").length === 1, "the prompt was taken");
    const delivery = outcomes(h, "prompted")[0]!;
    assert.equal(delivery.attrs.focused_bodies, 1);
    assert.equal(delivery.attrs.focused_bytes_count, Buffer.byteLength("body of m-idle"));
    assert.deepEqual(seen(h), [], "taken, but the model has shown nothing yet");

    release(2);
    await until(() => seen(h).length === 1, "reported at the turn's model output");
    assert.deepEqual(seen(h), [{ channelId: "thread-1", seqs: [100] }]);
    const reported = h.events.filter((event) => event.name === "daemon.agent.model_seen.reported");
    assert.equal(reported.length, 1);
    assert.equal(reported[0]!.attrs.trigger, "model_output");
    assert.equal(h.framesOf("agent:model-seen")[0]!.launchId, "launch-1");
  } finally {
    await cleanup();
  }
});

test("OAR focus: a body reported as seen is booked for the agent's sends by its target, once it is reported and not before", async () => {
  const { h, release, cleanup } = await gatedHarness({ gated: [2] });
  try {
    await firstTurnOver(h);
    const seenFor = (target: string) => lastLaunchContext!.agentCredentialProxyExactSeenSeqs!(target);
    await h.host.deliverMessage("agent-1", threadMessage("m-seen", 100), { deliveryId: "d-seen" });
    await until(() => outcomes(h, "prompted").length === 1, "the prompt was taken");
    // Taken by the runtime is not shown to the model: a send now attests nothing.
    assert.deepEqual(seenFor("#general:aaaabbbb"), []);
    release(2);
    await until(() => seen(h).length === 1, "reported at the turn's model output");
    // The reply the agent sends next carries it, so the Server does not hold it for the message it answers.
    assert.deepEqual(seenFor("#general:aaaabbbb"), [100]);
    assert.deepEqual(seenFor("#general"), [], "only the conversation the message is in");
    assert.deepEqual(seenFor("#random"), []);
  } finally {
    await cleanup();
  }
});

test("OAR focus, busy: a focused message is steered in full; it is reported when the turn it joined ends completed, not at the accept; its mention is acked once", async () => {
  const { h, release, cleanup } = await gatedHarness({ gated: [1] });
  let acks = 0;
  try {
    await h.host.deliverMessage("agent-1", threadMessage("m-busy", 200, { mentioned: true }), { deliveryId: "d-busy", mentionDelivery: MENTION, onMentionAck: () => { acks += 1; } });
    await until(() => outcomes(h, "steered").length === 1, "the body steered");
    assert.equal(outcomes(h, "steered")[0]!.attrs.focused_bodies, 1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(seen(h), [], "an accepted steer is only in the turn's buffer: not reported yet");
    assert.equal(acks, 1);

    release(1);
    await firstTurnOver(h);
    await until(() => seen(h).length === 1, "reported at the clean turn end");
    assert.deepEqual(seen(h), [{ channelId: "thread-1", seqs: [200] }]);
    assert.equal(h.events.find((event) => event.name === "daemon.agent.model_seen.reported")?.attrs.trigger, "steer_turn_completed");
    assert.equal(h.steered().length, 1);
    assert.match(h.steered()[0]!, /^New message received:/);
    assert.match(h.steered()[0]!, /body of m-busy/);
    assert.equal(h.inputs.length, 1, "not delivered again as a new turn");
    assert.equal(seen(h).length, 1, "reported once");
    assert.equal(acks, 1, "acked once");
  } finally {
    await cleanup();
  }
});

test("OAR focus, busy: a refused steer reports nothing and acks nothing; the body is delivered again in full, then reported and acked once", async () => {
  let refusals = 1;
  const { h, release, cleanup } = await gatedHarness({
    gated: [1, 2],
    wrapSession: (session) => new Proxy(session, {
      get: (target, prop, receiver) => prop === "deliver"
        ? async (...args: Parameters<Session["deliver"]>) => {
          if (refusals > 0) { refusals -= 1; return { landed: "rejected", code: "runtime_refused", reason: "not_steerable: in review" }; }
          return target.deliver(...args);
        }
        : Reflect.get(target, prop, receiver),
    }),
  });
  let acks = 0;
  try {
    await h.host.deliverMessage("agent-1", threadMessage("m-refused", 300, { mentioned: true }), { deliveryId: "d-refused", mentionDelivery: MENTION, onMentionAck: () => { acks += 1; } });
    await until(() => h.events.some((event) => event.name === "daemon.agent.oar.delivery" && event.attrs.code === "runtime_refused"), "the steer refused");
    assert.deepEqual(seen(h), [], "a refused write is not reported");
    assert.equal(acks, 0, "nor acked");
    assert.equal(h.steered().length, 0);

    release(1);
    await until(() => h.inputs.length === 2, "the body opens the next turn");
    assert.match(h.inputs[1]!, /^New message received:/);
    assert.match(h.inputs[1]!, /body of m-refused/);
    assert.equal(h.inputs.filter((input) => input.includes("body of m-refused")).length, 1, "written once");
    await until(() => outcomes(h, "prompted").length === 1, "the prompt was taken");
    assert.equal(acks, 1);
    assert.deepEqual(seen(h), [], "taken, but the model has shown nothing yet");
    release(2);
    await until(() => seen(h).length === 1, "reported");
    assert.deepEqual(seen(h), [{ channelId: "thread-1", seqs: [300] }]);
    assert.equal(acks, 1, "acked once");
  } finally {
    await cleanup();
  }
});

/** Captures the input id of each steer or prompt-by-deliver the host makes. */
function capturingDeliver(inputIds: string[]) {
  return (session: Session): Session => new Proxy(session, {
    get: (target, prop, receiver) => prop === "deliver"
      ? async (...args: Parameters<Session["deliver"]>) => {
        inputIds.push(String((args[1] as { inputId?: string } | undefined)?.inputId));
        return target.deliver(...args);
      }
      : Reflect.get(target, prop, receiver),
  });
}

test("OAR focus, busy: a steer the runtime accepted into a turn that is then interrupted is not reported", async () => {
  const { h, cleanup } = await gatedHarness({ gated: [1] });
  try {
    await h.host.deliverMessage("agent-1", threadMessage("m-aborted", 250), { deliveryId: "d-aborted" });
    await until(() => outcomes(h, "steered").length === 1, "the body steered");
    await h.host.interruptTurn("agent-1");
    await until(() => dropped(h).length === 1, "the turn ended interrupted");
    assert.equal(dropped(h)[0]!.attrs.reason, "turn_not_completed");
    assert.equal(dropped(h)[0]!.attrs.messages_count, 1);

    // A later turn that completes does not report it after all.
    await h.host.deliverMessage("agent-1", plainMessage("m-next", 251), { deliveryId: "d-next" });
    await until(() => h.inputs.length === 2, "the next turn ran");
    await until(() => h.framesOf("agent:runtime:outcome").length >= 1, "it ended with output");
    assert.deepEqual(seen(h), []);
  } finally {
    await cleanup();
  }
});

test("OAR focus, busy: a steer the runtime accepted and then dropped (input_dropped) is not reported; its messages are written again, the mention acked once", async () => {
  const inputIds: string[] = [];
  const { h, release, cleanup } = await gatedHarness({ gated: [1, 2], wrapSession: capturingDeliver(inputIds) });
  let acks = 0;
  try {
    await h.host.deliverMessage("agent-1", threadMessage("m-dropped", 260, { mentioned: true }), { deliveryId: "d-dropped", mentionDelivery: MENTION, onMentionAck: () => { acks += 1; } });
    await until(() => outcomes(h, "steered").length === 1, "the body steered");
    assert.equal(acks, 1, "acked at the accept");

    // The runtime reports it discarded that input (Codex and Claude: `turn_interrupted`).
    const host = h.host as unknown as { agents: Map<string, { session: Session }>; onEvent(agent: unknown, session: Session, event: unknown): void };
    const agent = host.agents.get("agent-1")!;
    host.onEvent(agent, agent.session, { kind: "input_dropped", reason: "turn_interrupted", inputId: inputIds[0], sessionId: agent.session.id, agentPath: [], seq: 9_999, receivedAt: Date.now() });
    assert.equal(dropped(h).at(-1)?.attrs.reason, "input_dropped");
    const requeued = h.events.filter((event) => event.name === "daemon.agent.focus_body.requeued");
    assert.equal(requeued.length, 1);
    assert.equal(requeued[0]!.attrs.messages_count, 1);

    release(1);
    await until(() => h.inputs.length === 2, "the body is written again as the next turn's input");
    assert.match(h.inputs[1]!, /^New message received:/);
    assert.match(h.inputs[1]!, /body of m-dropped/);
    await until(() => outcomes(h, "prompted").length === 1, "taken");
    assert.deepEqual(seen(h), [], "the dropped steer was not reported at its turn's clean end");
    release(2);
    await until(() => seen(h).length === 1, "the second write is reported at its own turn's output");
    assert.deepEqual(seen(h), [{ channelId: "thread-1", seqs: [260] }]);
    assert.equal(acks, 1, "not acked a second time");
    assert.equal(h.inputs.filter((input) => input.includes("body of m-dropped")).length, 1, "written again once");
  } finally {
    await cleanup();
  }
});

/** The first steer lands `queued`; OAR gives it back (`withdrawn`) or keeps it. */
function queueingFirstDeliver(withdrawn: boolean) {
  let delivers = 0;
  return (session: Session): Session => new Proxy(session, {
    get: (target, prop, receiver) => {
      if (prop === "deliver") {
        return async (...args: Parameters<Session["deliver"]>) => {
          delivers += 1;
          return delivers === 1 ? { landed: "queued" } : target.deliver(...args);
        };
      }
      if (prop === "withdraw") {
        return async () => (withdrawn ? { kind: "accepted", seq: 0, requestId: "w-1" } : { kind: "rejected", code: "not_queued", reason: "already sent", seq: 0, requestId: "w-1" });
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

test("OAR focus: an input OAR queued and gave back stays held and is written again in full; nothing is acked or reported for the queued try", async () => {
  const { h, release, cleanup } = await gatedHarness({ gated: [1, 2], wrapSession: queueingFirstDeliver(true) });
  let acks = 0;
  try {
    await h.host.deliverMessage("agent-1", threadMessage("m-queued", 270, { mentioned: true }), { deliveryId: "d-queued", mentionDelivery: MENTION, onMentionAck: () => { acks += 1; } });
    await until(() => h.events.some((event) => event.name === "daemon.agent.oar.delivery" && event.attrs.code === "no_active_turn"), "queued, withdrawn, held");
    assert.equal(acks, 0);
    assert.deepEqual(dropped(h), []);

    release(1);
    await until(() => h.inputs.length === 2, "written again at the turn end");
    assert.match(h.inputs[1]!, /^New message received:/);
    assert.match(h.inputs[1]!, /body of m-queued/);
    await until(() => acks === 1, "acked when taken");
    release(2);
    await until(() => seen(h).length === 1, "reported at that turn's output");
    assert.deepEqual(seen(h), [{ channelId: "thread-1", seqs: [270] }]);
    assert.equal(acks, 1);
  } finally {
    await cleanup();
  }
});

test("OAR focus: an input OAR queued and would not give back is taken (mention acked once) and never reported", async () => {
  const { h, release, cleanup } = await gatedHarness({ gated: [1], wrapSession: queueingFirstDeliver(false) });
  let acks = 0;
  try {
    await h.host.deliverMessage("agent-1", threadMessage("m-kept", 280, { mentioned: true }), { deliveryId: "d-kept", mentionDelivery: MENTION, onMentionAck: () => { acks += 1; } });
    await until(() => outcomes(h, "queued").length === 1, "left with OAR as delivered");
    assert.equal(acks, 1);
    assert.deepEqual(dropped(h).map((event) => [event.attrs.reason, event.attrs.messages_count]), [["queued", 1]]);

    release(1);
    await firstTurnOver(h);
    await h.host.deliverMessage("agent-1", plainMessage("m-next", 281), { deliveryId: "d-next" });
    await until(() => h.inputs.length === 2, "the next turn ran");
    await until(() => h.framesOf("agent:runtime:outcome").length >= 2, "it ended with output");
    assert.deepEqual(seen(h), [], "neither turn's end reports it");
    assert.equal(acks, 1);
    assert.equal(h.inputs.filter((input) => input.includes("m-kept")).length, 0, "this host does not offer it again");
  } finally {
    await cleanup();
  }
});

test("OAR focus: a body whose turn ends with no model output is not reported", async () => {
  const { h, cleanup } = await gatedHarness({ gated: [], silentTurns: [2] });
  try {
    await firstTurnOver(h);
    await h.host.deliverMessage("agent-1", threadMessage("m-silent", 400), { deliveryId: "d-silent" });
    await until(() => dropped(h).length === 1, "the pending report dropped");
    assert.equal(dropped(h)[0]!.attrs.reason, "turn_ended_without_output");
    assert.equal(dropped(h)[0]!.attrs.messages_count, 1);
    assert.equal(dropped(h)[0]!.attrs.host, "oar");

    // The next turn's output does not report it after all.
    await h.host.deliverMessage("agent-1", plainMessage("m-next", 401), { deliveryId: "d-next" });
    await until(() => h.inputs.length === 3, "the next turn ran");
    // The first turn and this one each end with output (the silent turn sends no outcome frame).
    await until(() => h.framesOf("agent:runtime:outcome").length >= 2 && outcomes(h, "prompted").length === 2, "the next turn ended with output");
    assert.deepEqual(seen(h), []);
  } finally {
    await cleanup();
  }
});

/** From the second prompt on, the runtime takes the prompt at once but its answer reaches the host only when `gate` opens. */
function slowPromptAnswers(gate: Promise<void>) {
  let prompts = 0;
  return (session: Session): Session => new Proxy(session, {
    get: (target, prop, receiver) => prop === "prompt"
      ? async (...args: Parameters<Session["prompt"]>) => {
        prompts += 1;
        const outcome = await target.prompt(...args);
        if (prompts > 1) await gate;
        return outcome;
      }
      : Reflect.get(target, prop, receiver),
  });
}

test("OAR focus: a prompt whose accept reaches the host after its turn already ended registers nothing; a later turn does not report it", async () => {
  const answer = deferred();
  const { h, cleanup } = await gatedHarness({ gated: [], steers: false, wrapSession: slowPromptAnswers(answer.promise) });
  try {
    await firstTurnOver(h);
    await h.host.deliverMessage("agent-1", threadMessage("m-late", 450), { deliveryId: "d-late" });
    await until(() => h.framesOf("agent:runtime:outcome").length >= 2, "its turn ran and ended before the accept arrived");
    answer.resolve();
    await until(() => dropped(h).length === 1, "dropped, not registered");
    assert.equal(dropped(h)[0]!.attrs.reason, "turn_ended_without_output");
    await h.host.deliverMessage("agent-1", plainMessage("m-next", 451), { deliveryId: "d-next" });
    await until(() => h.framesOf("agent:runtime:outcome").length >= 3, "a later turn ended with output");
    assert.deepEqual(seen(h), []);
  } finally {
    answer.resolve();
    await cleanup();
  }
});

test("OAR focus: a prompt whose accept reaches the host after its turn has spoken, the turn still open, is reported then", async () => {
  const answer = deferred();
  const end = deferred();
  let turns = 0;
  const h = await harness({
    // A tool call: the scripted runtime records it at once (its text reaches the host later).
    turn: async (turn) => {
      turns += 1;
      if (turns === 2) {
        await turn.tool("Bash", JSON.stringify({ command: "ls" }), () => "ok");
        await end.promise;
      }
      turn.say("done");
    },
    wrapSession: slowPromptAnswers(answer.promise),
  });
  try {
    await h.host.start(request({ config: focusOn() }));
    await firstTurnOver(h);
    await h.host.deliverMessage("agent-1", threadMessage("m-spoken", 460), { deliveryId: "d-spoken" });
    await until(() => h.inputs.length === 2, "its turn runs");
    await until(() => h.framesOf("agent:activity").some((frame) => JSON.stringify(frame).includes("Bash")), "the turn's tool call reached the host");
    assert.deepEqual(seen(h), [], "the host does not know yet that the prompt was taken");
    answer.resolve();
    await until(() => seen(h).length === 1, "reported: that turn has already shown output");
    assert.deepEqual(seen(h), [{ channelId: "thread-1", seqs: [460] }]);
    end.resolve();
    await until(() => h.framesOf("agent:runtime:outcome").length >= 2, "the turn ended");
    assert.equal(seen(h).length, 1, "once");
  } finally {
    answer.resolve();
    end.resolve();
    await h.cleanup();
  }
});

test("OAR focus: a body written to a session that is replaced before any model output is not reported by the next session", async () => {
  const { h, cleanup } = await gatedHarness({ gated: [2] });
  try {
    await firstTurnOver(h);
    await h.host.deliverMessage("agent-1", threadMessage("m-old-session", 500), { deliveryId: "d-old" });
    await until(() => outcomes(h, "prompted").length === 1, "taken by the first session");
    assert.deepEqual(seen(h), []);

    // A stop while that turn still runs (its gate opens at cleanup), then a new session that speaks.
    await h.host.stopAgent("agent-1");
    await h.host.start(request({ launchId: "launch-2", config: focusOn() }));
    await until(() => h.sessions.length === 2 && h.inputs.length === 3, "the second session's first turn ran");
    await until(() => h.framesOf("agent:runtime:outcome").length >= 1, "it produced output");
    await h.host.deliverMessage("agent-1", plainMessage("m-after", 501), { deliveryId: "d-after" });
    await until(() => h.inputs.length === 4, "the new session takes input");
    assert.deepEqual(seen(h), [], "nothing reported for the earlier session's write");
  } finally {
    await cleanup();
  }
});

test("OAR focus, mixed batch: focused messages in full, the rest as the notice, left out by message and not by conversation", async () => {
  // `after_turn`: all three wait for the turn end and go as one input.
  const { h, release, cleanup } = await gatedHarness({ gated: [1], steers: false });
  try {
    const earlier = threadMessage("m-earlier", 600, { focused: undefined });
    const focused = threadMessage("m-focused", 601);
    const other = plainMessage("m-other", 602);
    for (const each of [earlier, focused, other]) await h.host.deliverMessage("agent-1", each, { deliveryId: `d-${each.message_id}` });
    release(1);
    await until(() => h.inputs.length === 2, "one input for the batch");
    const input = h.inputs[1]!;
    const driver = getDriver("codex");
    const options = inboxUpdateRenderOptions(focusOn());
    assert.equal(input, String(formatConcreteMessagesRuntimeInput(
      [focused],
      driver,
      String(formatInboxUpdateRuntimeInput([earlier, other], driver, 2, options)),
      { focus: true },
    )));
    // Message ids print as their first eight characters.
    assert.match(input, /msg=m-focuse time=[^\n]*body of m-focused/);
    assert.doesNotMatch(input, /msg=m-earlie time=/, "the unfocused message of the focused conversation is not in full");
    // Its conversation is still listed for it: one message pending there, not two.
    assert.match(input, /#general:aaaabbbb +pending: 1 message[^\n]*first msg=m-earlie /);
    assert.match(input, /#random +pending: 1 message/);
    assert.match(input, /2 messages pending your read/);
    await until(() => seen(h).length === 1, "reported");
    assert.deepEqual(seen(h), [{ channelId: "thread-1", seqs: [601] }], "only the focused body is reported");
    assert.equal(outcomes(h, "prompted")[0]!.attrs.count, 3);
    assert.equal(outcomes(h, "prompted")[0]!.attrs.focused_bodies, 1);
  } finally {
    await cleanup();
  }
});

test("OAR focus: a batch with a focused body goes past an outstanding Codex notice, tells what was held and settles it", async () => {
  const { h, release, cleanup } = await gatedHarness({ gated: [1] });
  try {
    await h.host.deliverMessage("agent-1", plainMessage("m-first", 700), { deliveryId: "d-first" });
    await until(() => outcomes(h, "steered").length === 1, "the first notice steered");
    await h.host.deliverMessage("agent-1", plainMessage("m-held", 701), { deliveryId: "d-held" });
    await until(() => outcomes(h, "held_notice_outstanding").length === 1, "held behind it");

    // A plain thread message: no mention, no DM. Only the tag takes it past the hold.
    await h.host.deliverMessage("agent-1", threadMessage("m-focused", 702), { deliveryId: "d-focused" });
    await until(() => outcomes(h, "steered").length === 2, "the focused batch steered");
    const breakthrough = outcomes(h, "steered")[1]!;
    assert.equal(breakthrough.attrs.notice_hold_breakthrough, true);
    assert.equal(breakthrough.attrs.held_count, 1);
    assert.equal(breakthrough.attrs.count, 2, "it told the held message too");
    assert.equal(breakthrough.attrs.focused_bodies, 1);

    // The earlier notice is still the outstanding one: a plain batch is held again.
    await h.host.deliverMessage("agent-1", plainMessage("m-after", 703), { deliveryId: "d-after" });
    await until(() => outcomes(h, "held_notice_outstanding").length === 2, "held again");
    assert.equal(outcomes(h, "steered").length, 2);

    release(1);
    await until(() => h.inputs.length === 2, "the turn end tells what is still held");
    assert.match(h.steered()[1]!, /^New message received:/);
    assert.match(h.steered()[1]!, /body of m-focused/);
    assert.match(h.steered()[1]!, /Raft inbox notice[\s\S]*first msg=m-held/);
    const released = h.events.filter((event) => event.name === "daemon.agent.notice_hold.released");
    assert.equal(released[0]?.attrs.held_count, 1, "only what was held after the body: the earlier count was settled");
    assert.doesNotMatch(h.inputs[1]!, /m-held|m-focused/, "what went with the body is not told again");
    assert.deepEqual(seen(h), [{ channelId: "thread-1", seqs: [702] }]);
  } finally {
    await cleanup();
  }
});

test("OAR focus: a write with a focused body arms no Codex notice hold", async () => {
  const { h, cleanup } = await gatedHarness({ gated: [1] });
  try {
    await h.host.deliverMessage("agent-1", threadMessage("m-focused", 720), { deliveryId: "d-focused" });
    await until(() => outcomes(h, "steered").length === 1, "the body steered");
    // Nothing is outstanding: the next plain batch is told, and that notice is the one that holds.
    await h.host.deliverMessage("agent-1", plainMessage("m-plain", 721), { deliveryId: "d-plain" });
    await until(() => outcomes(h, "steered").length === 2, "the notice steered");
    assert.equal(outcomes(h, "held_notice_outstanding").length, 0);
    await h.host.deliverMessage("agent-1", plainMessage("m-plain-2", 722), { deliveryId: "d-plain-2" });
    await until(() => outcomes(h, "held_notice_outstanding").length === 1, "held behind the notice");
  } finally {
    await cleanup();
  }
});

test("OAR focus: a focused body whose steer was refused is steered at the next tool start, though a Codex notice is outstanding", async () => {
  const toolGate = deferred();
  const endGate = deferred();
  let delivers = 0;
  let turns = 0;
  const h = await harness({
    turn: async (turn) => {
      turns += 1;
      if (turns === 1) {
        await toolGate.promise;
        await turn.tool("Bash", JSON.stringify({ command: "ls" }), () => "ok");
        await endGate.promise;
      }
      turn.say("done");
    },
    // The second steer (the focused body's first try) is refused.
    wrapSession: (session) => new Proxy(session, {
      get: (target, prop, receiver) => prop === "deliver"
        ? async (...args: Parameters<Session["deliver"]>) => {
          delivers += 1;
          if (delivers === 2) return { landed: "rejected", code: "runtime_refused", reason: "not_steerable" };
          return target.deliver(...args);
        }
        : Reflect.get(target, prop, receiver),
    }),
    deps: { prepareLaunch: STEERING_LAUNCH },
  });
  try {
    await h.host.start(request({ config: focusOn() }));
    await until(() => h.inputs.length === 1, "first turn running");
    await h.host.deliverMessage("agent-1", plainMessage("m-first", 750), { deliveryId: "d-first" });
    await until(() => outcomes(h, "steered").length === 1, "the first notice is outstanding");
    await h.host.deliverMessage("agent-1", threadMessage("m-focused", 751), { deliveryId: "d-focused" });
    await until(() => delivers === 2, "the body's steer refused");
    assert.deepEqual(seen(h), []);

    toolGate.resolve();
    await until(() => outcomes(h, "steered").length === 2, "steered at the tool start, inside the same turn");
    assert.equal(h.inputs.length, 1, "no new turn was needed");
    assert.deepEqual(seen(h), [], "not before the turn ends");
    endGate.resolve();
    await until(() => seen(h).length === 1, "reported at the clean turn end");
    assert.deepEqual(seen(h), [{ channelId: "thread-1", seqs: [751] }]);
  } finally {
    toolGate.resolve();
    endGate.resolve();
    await h.cleanup();
  }
});

test("OAR focus: focused messages too long together are handed over one at a time, each in full, each reported", async () => {
  const refused: string[] = [];
  const { h, release, cleanup } = await gatedHarness({
    gated: [1],
    steers: false,
    wrapSession: (session) => new Proxy(session, {
      get: (target, prop, receiver) => prop === "prompt"
        ? async (...args: Parameters<Session["prompt"]>) => {
          const input = String(args[0]);
          if (input.includes("m-big-a") && input.includes("m-big-b")) {
            refused.push(input);
            return { kind: "rejected", code: "unsupported", failure: "input_too_large", reason: "too long", seq: 0, requestId: `r-${refused.length}` };
          }
          return target.prompt(...args);
        }
        : Reflect.get(target, prop, receiver),
    }),
  });
  try {
    await h.host.deliverMessage("agent-1", threadMessage("m-big-a", 800), {});
    await h.host.deliverMessage("agent-1", threadMessage("m-big-b", 801), {});
    release(1);
    await until(() => h.inputs.some((input) => input.includes("body of m-big-b")), "the second delivered");
    assert.equal(refused.length, 1, "the batch was refused once");
    const delivered = h.inputs.slice(1);
    assert.equal(delivered.filter((input) => /^New message received:/.test(input) && input.includes("body of m-big-a")).length, 1);
    assert.equal(delivered.filter((input) => /^New message received:/.test(input) && input.includes("body of m-big-b")).length, 1);
    await until(() => seen(h).flatMap((item) => item.seqs).length === 2, "both reported");
    assert.deepEqual(seen(h).flatMap((item) => item.seqs).sort(), [800, 801]);
    assert.equal(h.framesOf("agent:activity").filter((frame) => frame.detailKind === "runtime_error").length, 0, "no error");
  } finally {
    await cleanup();
  }
});

/** Prompts `tooLong` says are over the runtime's bound are refused as OAR refuses them. */
function boundedPrompts(tooLong: (input: string, n: number) => boolean, refused: string[]) {
  let prompts = 0;
  return (session: Session): Session => new Proxy(session, {
    get: (target, prop, receiver) => prop === "prompt"
      ? async (...args: Parameters<Session["prompt"]>) => {
        prompts += 1;
        const input = String(args[0]);
        if (tooLong(input, prompts)) {
          refused.push(input);
          return { kind: "rejected", code: "unsupported", failure: "input_too_large", reason: "too long", seq: 0, requestId: `r-${refused.length}` };
        }
        return target.prompt(...args);
      }
      : Reflect.get(target, prop, receiver),
  });
}

test("OAR focus: a focused message too long to be written in full is told as a notice row, as it would be without the tag; it is not refused and not reported", async () => {
  const refused: string[] = [];
  let terminal = 0;
  let acks = 0;
  // In full it is over the bound; its notice row is not.
  const { h, cleanup } = await gatedHarness({
    gated: [],
    steers: false,
    wrapSession: boundedPrompts((input) => /^New message received:/.test(input) && input.includes("body of m-huge"), refused),
  });
  try {
    await firstTurnOver(h);
    const huge = threadMessage("m-huge", 850, { mentioned: true });
    await h.host.deliverMessage("agent-1", huge, { deliveryId: "d-huge", mentionDelivery: MENTION, onMentionAck: () => { acks += 1; }, onMentionTerminalError: () => { terminal += 1; } });
    await until(() => h.inputs.length === 2, "told after all");
    assert.equal(refused.length, 1, "tried in full once");
    assert.equal(h.inputs[1], String(formatInboxUpdateRuntimeInput([huge], getDriver("codex"), 1, inboxUpdateRenderOptions(focusOn()))), "the notice it would be without the tag");
    await until(() => h.framesOf("agent:runtime:outcome").length >= 2, "that turn ended with output");
    assert.equal(terminal, 0, "not refused");
    assert.equal(acks, 1);
    assert.equal(h.framesOf("agent:activity").filter((frame) => frame.detailKind === "runtime_error").length, 0, "no error shown");
    assert.deepEqual(seen(h), [], "a notice row is not a body: not reported");
    assert.equal(outcomes(h, "prompted")[0]!.attrs.focused_bodies, undefined);
  } finally {
    await cleanup();
  }
});

test("OAR focus, start: a first input too long with a focused wake starts without it; the wake follows in full and is reported", async () => {
  const refused: string[] = [];
  const wake = threadMessage("m-wake", 910);
  const { h, cleanup } = await gatedHarness({ gated: [], steers: false, start: { wakeMessage: wake }, wrapSession: boundedPrompts((_input, n) => n === 1, refused) });
  try {
    assert.equal(refused.length, 1);
    assert.match(refused[0]!, /body of m-wake/);
    assert.doesNotMatch(h.inputs[0]!, /m-wake/, "the session started without its messages");
    await until(() => h.inputs.length === 2, "the wake follows as a delivery");
    assert.match(h.inputs[1]!, /^New message received:/);
    assert.match(h.inputs[1]!, /body of m-wake/);
    await until(() => seen(h).length === 1, "reported at its own turn's output");
    assert.deepEqual(seen(h), [{ channelId: "thread-1", seqs: [910] }]);
  } finally {
    await cleanup();
  }
});

test("OAR focus, start: a first input held for a provider limit registers its focused bodies when it lands, and is reported at that turn's output", async () => {
  const ledger = new ProviderLimitLedger();
  const gate = deferred();
  const h = await harness({
    turn: async (turn) => { await gate.promise; turn.say("ok"); },
    deps: { providerLimits: ledger, providerLimitBackoff: { baseMs: 300, jitterRatio: 0 } },
  });
  try {
    const now = Date.now();
    ledger.record("shared:codex", { attempts: 1, reason: "rate_limited", untilMs: now + 30 * 60_000, providerLimitKind: "quota_exhausted", recordedAtMs: now }, { host: "legacy" });
    await h.host.start(request({ config: focusOn(), wakeMessage: threadMessage("m-held-wake", 920) }));
    const held = h.events.find((event) => event.name === "daemon.agent.oar.first_input" && event.attrs.outcome === "held_for_provider_limit");
    assert.ok(held, "the first input is held");
    assert.equal(held.attrs.focused_bodies, 1);
    assert.equal(h.inputs.length, 0);
    const host = h.host as unknown as { agents: Map<string, { pendingModelSeen: unknown[] }> };
    assert.deepEqual(host.agents.get("agent-1")!.pendingModelSeen, [], "nothing registered while it is held");

    ledger.release("shared:codex", "credentials_changed", { host: "legacy" });
    await until(() => h.inputs.length === 1, "the held first input landed");
    assert.match(h.inputs[0]!, /body of m-held-wake/);
    await until(() => outcomes(h, "prompted").length === 1, "taken as a prompt");
    assert.deepEqual(seen(h), [], "the model has shown nothing yet");
    gate.resolve();
    await until(() => seen(h).length === 1, "reported");
    assert.deepEqual(seen(h), [{ channelId: "thread-1", seqs: [920] }]);
  } finally {
    gate.resolve();
    await h.cleanup();
  }
});

test("OAR focus, start: a focused wake message is the first input in full and is reported at the first turn's model output", async () => {
  const wake = threadMessage("m-wake", 900);
  const { h, release, cleanup } = await gatedHarness({ gated: [1], start: { wakeMessage: wake } });
  try {
    assert.match(h.inputs[0]!, /New message received:/);
    assert.match(h.inputs[0]!, /body of m-wake/);
    assert.doesNotMatch(h.inputs[0]!, /Raft inbox notice/);
    await until(() => h.events.some((event) => event.name === "daemon.agent.oar.first_input" && event.attrs.outcome === "accepted"), "first input taken");
    assert.equal(h.events.find((event) => event.name === "daemon.agent.oar.first_input")!.attrs.focused_bodies, 1);
    assert.deepEqual(seen(h), [], "the model has shown nothing yet");
    release(1);
    await until(() => seen(h).length === 1, "reported");
    assert.deepEqual(seen(h), [{ channelId: "thread-1", seqs: [900] }]);
  } finally {
    await cleanup();
  }
});

/** One run of every delivery shape; returns each input the runtime got, in order. */
async function everyShape(config: AgentConfig, tag: boolean): Promise<{ inputs: string[]; steered: string[]; modelSeen: number; focusAttrs: number }> {
  const tagged = (id: string, seq: number, extra: Partial<AgentMessage> = {}) => threadMessage(id, seq, { focused: tag ? true : undefined, ...extra });
  const { h, release, cleanup } = await gatedHarness({ gated: [1, 2], config, start: { wakeMessage: tagged("p-wake", 1000) } });
  try {
    // Busy: a steer.
    await h.host.deliverMessage("agent-1", tagged("p-busy", 1001), { deliveryId: "d-1" });
    await until(() => outcomes(h, "steered").length === 1, "steered");
    release(1);
    await firstTurnOver(h);
    // Idle: a prompt; then a mixed batch behind that turn.
    await h.host.deliverMessage("agent-1", tagged("p-idle", 1002), { deliveryId: "d-2" });
    await until(() => h.inputs.length === 2, "prompted");
    release(2);
    await until(() => outcomes(h, "prompted").length === 1, "taken");
    await h.host.deliverMessage("agent-1", tagged("p-mixed-a", 1003, { mentioned: true }), { deliveryId: "d-3" });
    await h.host.deliverMessage("agent-1", plainMessage("p-mixed-b", 1004), { deliveryId: "d-4" });
    await until(() => [...h.inputs, ...h.steered()].some((input) => input.includes("p-mixed-b")), "the last one told");
    await until(() => h.framesOf("agent:runtime:outcome").length >= 2, "turns over");
    const focusAttrs = h.events.filter((event) => "focused_bodies" in event.attrs || "focused_bytes_count" in event.attrs).length;
    return { inputs: [...h.inputs], steered: [...h.steered()], modelSeen: h.framesOf("agent:model-seen").length, focusAttrs };
  } finally {
    await cleanup();
  }
}

test("OAR focus off: with no `agentFocus`, tagged messages give exactly the inputs untagged ones give, and nothing is reported", async () => {
  const off = codexShared();
  const untagged = await everyShape(off, false);
  for (const config of [off, codexShared({ agentFocus: false })]) {
    const tagged = await everyShape(config, true);
    assert.deepEqual(tagged.inputs.slice(0, 2), untagged.inputs.slice(0, 2));
    assert.deepEqual(tagged.steered.slice(0, 1), untagged.steered.slice(0, 1));
    assert.equal([...tagged.inputs, ...tagged.steered].join("\n\u0000\n"), [...untagged.inputs, ...untagged.steered].join("\n\u0000\n"));
    assert.equal(tagged.modelSeen, 0);
    assert.equal(tagged.focusAttrs, 0);
    for (const input of [...tagged.inputs, ...tagged.steered]) {
      assert.doesNotMatch(input, /New messages? received:|Raft focused/, "a notice, as before");
    }
  }
  // The same shapes with the flag on and no tag: nothing changes either.
  const onUntagged = await everyShape(focusOn(), false);
  assert.equal([...onUntagged.inputs, ...onUntagged.steered].join("\n\u0000\n"), [...untagged.inputs, ...untagged.steered].join("\n\u0000\n"));
  assert.equal(onUntagged.modelSeen, 0);
  assert.equal(onUntagged.focusAttrs, 0);
});

test("OAR focus off: the idle and busy notices are the notice formatter's bytes", async () => {
  const config = codexShared();
  const { h, release, cleanup } = await gatedHarness({ gated: [1], config });
  try {
    const driver = getDriver("codex");
    const options = inboxUpdateRenderOptions(config);
    const busy = threadMessage("b-1", 1100);
    await h.host.deliverMessage("agent-1", busy, { deliveryId: "d-b1" });
    await until(() => outcomes(h, "steered").length === 1, "steered");
    release(1);
    await firstTurnOver(h);
    assert.equal(h.steered()[0], String(formatInboxUpdateRuntimeInput([busy], driver, 1, options)));
    const idle = [threadMessage("i-1", 1101)];
    await h.host.deliverMessage("agent-1", idle[0]!, { deliveryId: "d-i1" });
    await until(() => h.inputs.length === 2, "prompted");
    assert.equal(h.inputs[1], String(formatInboxUpdateRuntimeInput(idle, driver, 1, options)));
    assert.equal(h.framesOf("agent:model-seen").length, 0);
  } finally {
    await cleanup();
  }
});

test("OAR focus: another runtime's config flag is read from the start's config (grok, flag on)", async () => {
  const { h, release, cleanup } = await gatedHarness({ gated: [2], config: makeConfig({ agentFocus: true }), steers: false });
  try {
    await firstTurnOver(h);
    await h.host.deliverMessage("agent-1", threadMessage("m-grok", 1200), { deliveryId: "d-grok" });
    await until(() => h.inputs.length === 2, "prompted");
    assert.match(h.inputs[1]!, /^New message received:/);
    release(2);
    await until(() => seen(h).length === 1, "reported");
  } finally {
    await cleanup();
  }
});

// --- Size limits (docs/contracts/agent-focus.md, "Size limits"): 16 KB a message, 32 KB of focused bodies a write ---

const KB = 1024;
/** A focused message whose content is `bytes` bytes; `channel` names its conversation. */
const sizedMessage = (id: string, seq: number, bytes: number, channel = "thread-1", extra: Partial<AgentMessage> = {}): AgentMessage =>
  threadMessage(id, seq, { channel_id: channel, channel_name: channel === "thread-1" ? "thread-aaaabbbb" : `thread-${channel}`, content: `${id}:`.padEnd(bytes, "x"), ...extra });
const inFull = (input: string, id: string) => new RegExp(`msg=${id.slice(0, 8)} time=`).test(input);
const capAttrs = (attrs: Record<string, unknown>) => [attrs.focused_bodies ?? 0, attrs.focused_rows_over_message_cap_count ?? 0, attrs.focused_rows_over_write_cap ?? 0];

test("OAR focus cap: a focused message over 16 KB at the head of its conversation makes it and the later ones rows; with nothing else focused the input is the plain notice and nothing is reported", async () => {
  const { h, release, cleanup } = await gatedHarness({ gated: [1], steers: false });
  try {
    const batch = [sizedMessage("c-big", 2000, 16 * KB + 1), sizedMessage("c-s1", 2001, 20), sizedMessage("c-s2", 2002, 20)];
    for (const each of batch) await h.host.deliverMessage("agent-1", each, { deliveryId: `d-${each.message_id}` });
    release(1);
    await until(() => h.inputs.length === 2, "one input for the batch");
    assert.equal(h.inputs[1], String(formatInboxUpdateRuntimeInput(batch, getDriver("codex"), 3, inboxUpdateRenderOptions(focusOn()))), "the notice it is without the tag");
    await until(() => h.framesOf("agent:runtime:outcome").length >= 2, "that turn ended with output");
    assert.deepEqual(seen(h), [], "rows are not reported");
    assert.deepEqual(capAttrs(outcomes(h, "prompted")[0]!.attrs), [0, 3, 0]);
    assert.equal(outcomes(h, "prompted")[0]!.attrs.focused_bytes_count, undefined);
  } finally {
    await cleanup();
  }
});

test("OAR focus cap: a message of exactly 16 KB is written in full and reported", async () => {
  const { h, release, cleanup } = await gatedHarness({ gated: [2], steers: false });
  try {
    await firstTurnOver(h);
    await h.host.deliverMessage("agent-1", sizedMessage("c-at", 2010, 16 * KB), { deliveryId: "d-at" });
    await until(() => h.inputs.length === 2, "prompted");
    assert.match(h.inputs[1]!, /^New message received:/);
    assert.ok(inFull(h.inputs[1]!, "c-at"));
    release(2);
    await until(() => seen(h).length === 1, "reported");
    assert.deepEqual(capAttrs(outcomes(h, "prompted")[0]!.attrs), [1, 0, 0]);
    assert.equal(outcomes(h, "prompted")[0]!.attrs.focused_bytes_count, 16 * KB);
  } finally {
    await cleanup();
  }
});

test("OAR focus cap: a large message in the middle; the earlier one is shown and reported, it and the later ones of that conversation are rows, another conversation is still shown", async () => {
  const { h, release, cleanup } = await gatedHarness({ gated: [1], steers: false });
  try {
    const early = sizedMessage("c-early", 2020, 30);
    const big = sizedMessage("c-big", 2021, 20 * KB);
    const other = sizedMessage("c-other", 2022, 30, "thread-2");
    const late = sizedMessage("c-late", 2023, 30);
    for (const each of [early, big, other, late]) await h.host.deliverMessage("agent-1", each, { deliveryId: `d-${each.message_id}` });
    release(1);
    await until(() => h.inputs.length === 2, "one input for the batch");
    const input = h.inputs[1]!;
    assert.equal(input, String(formatConcreteMessagesRuntimeInput(
      [early, other],
      getDriver("codex"),
      String(formatInboxUpdateRuntimeInput([big, late], getDriver("codex"), 2, inboxUpdateRenderOptions(focusOn()))),
      { focus: true },
    )));
    assert.ok(inFull(input, "c-early") && inFull(input, "c-other"));
    assert.ok(!inFull(input, "c-big") && !inFull(input, "c-late"));
    assert.match(input, /2 messages pending your read/);
    await until(() => seen(h).length === 2, "reported");
    assert.deepEqual(seen(h), [{ channelId: "thread-1", seqs: [2020] }, { channelId: "thread-2", seqs: [2022] }], "only what was shown in full");
    assert.deepEqual(capAttrs(outcomes(h, "prompted")[0]!.attrs), [2, 2, 0]);
  } finally {
    await cleanup();
  }
});

test("OAR focus cap: bodies of 32 KB together fit one write; the message that would pass it is a row, and its conversation's later one too", async () => {
  const { h, release, cleanup } = await gatedHarness({ gated: [1], steers: false });
  try {
    const a = sizedMessage("c-a", 2030, 16 * KB, "thread-a");
    const b = sizedMessage("c-b", 2031, 16 * KB - 100, "thread-b");
    const c = sizedMessage("c-c", 2032, 101, "thread-c");
    const d = sizedMessage("c-d", 2033, 50, "thread-b");
    const e = sizedMessage("c-e", 2034, 10, "thread-c");
    for (const each of [a, b, c, d, e]) await h.host.deliverMessage("agent-1", each, { deliveryId: `d-${each.message_id}` });
    release(1);
    await until(() => h.inputs.length === 2, "one input for the batch");
    const input = h.inputs[1]!;
    // a + b leave 100 bytes: c (101) does not fit and cuts thread-c; d (50) fits; e is after the cut in thread-c.
    assert.deepEqual(["c-a", "c-b", "c-c", "c-d", "c-e"].map((id) => inFull(input, id)), [true, true, false, true, false]);
    const attrs = outcomes(h, "prompted")[0]!.attrs;
    assert.deepEqual(capAttrs(attrs), [3, 0, 2]);
    assert.equal(attrs.focused_bytes_count, 16 * KB + 16 * KB - 100 + 50);
    await until(() => seen(h).length === 2, "reported");
    assert.deepEqual(seen(h).flatMap((item) => item.seqs).sort(), [2030, 2031, 2033]);
  } finally {
    await cleanup();
  }
});

test("OAR focus cap: a focused message that brings its thread context is shown whatever its size and spends none of the budget", async () => {
  const { h, release, cleanup } = await gatedHarness({ gated: [1], steers: false });
  try {
    const context = sizedMessage("c-ctx", 2040, 20 * KB, "thread-ctx", {
      thread_join_context: { reason: "mentioned", parent_target: "#general", thread_target: "#general:ctxctx00", suggested_read_history_target: "#general:ctxctx00", parent_message: { message_id: "ctxctx00-0000-0000-0000-000000000000", sender_name: "richard", sender_type: "human", content: "parent", timestamp: "2026-08-31T08:00:00.000Z", seq: 90 }, recent_messages: [], history_truncated: true } as AgentMessage["thread_join_context"],
    });
    const a = sizedMessage("c-a", 2041, 16 * KB, "thread-a");
    const b = sizedMessage("c-b", 2042, 16 * KB, "thread-b");
    for (const each of [context, a, b]) await h.host.deliverMessage("agent-1", each, { deliveryId: `d-${each.message_id}` });
    release(1);
    await until(() => h.inputs.length === 2, "one input for the batch");
    assert.deepEqual(["c-ctx", "c-a", "c-b"].map((id) => inFull(h.inputs[1]!, id)), [true, true, true]);
    assert.doesNotMatch(h.inputs[1]!, /Raft inbox notice/);
    assert.deepEqual(capAttrs(outcomes(h, "prompted")[0]!.attrs), [3, 0, 0]);
  } finally {
    await cleanup();
  }
});

test("OAR focus cap, busy Codex: a batch whose focused messages are all rows waits behind an outstanding notice as any notice does", async () => {
  const { h, release, cleanup } = await gatedHarness({ gated: [1] });
  try {
    await h.host.deliverMessage("agent-1", plainMessage("c-first", 2050), { deliveryId: "d-first" });
    await until(() => outcomes(h, "steered").length === 1, "the first notice is outstanding");
    await h.host.deliverMessage("agent-1", sizedMessage("c-big", 2051, 17 * KB), { deliveryId: "d-big" });
    await until(() => outcomes(h, "held_notice_outstanding").length === 1, "held: it is a notice, not a body");
    assert.equal(outcomes(h, "steered").length, 1);
    release(1);
    await until(() => h.inputs.length === 2, "told at the turn end");
    assert.doesNotMatch(h.inputs[1]!, /New messages? received:/);
    await until(() => h.framesOf("agent:runtime:outcome").length >= 2, "that turn ended with output");
    assert.deepEqual(seen(h), []);
  } finally {
    await cleanup();
  }
});

test("OAR focus cap, busy: a steer shows what fits and lists the rest; only what was shown is reported at the turn end", async () => {
  const { h, release, cleanup } = await gatedHarness({ gated: [1], config: makeConfig({ agentFocus: true }) });
  try {
    await h.host.deliverMessage("agent-1", sizedMessage("c-fits", 2060, 100), { deliveryId: "d-fits" });
    await until(() => outcomes(h, "steered").length === 1, "steered");
    await h.host.deliverMessage("agent-1", sizedMessage("c-big", 2061, 17 * KB), { deliveryId: "d-big" });
    await until(() => outcomes(h, "steered").length === 2, "the row steered as a notice");
    assert.deepEqual(capAttrs(outcomes(h, "steered")[1]!.attrs), [0, 1, 0]);
    release(1);
    await firstTurnOver(h);
    await until(() => seen(h).length === 1, "reported");
    assert.deepEqual(seen(h), [{ channelId: "thread-1", seqs: [2060] }]);
    assert.ok(inFull(h.steered()[0]!, "c-fits"));
    assert.ok(!inFull(h.steered()[1]!, "c-big"));
  } finally {
    await cleanup();
  }
});

test("OAR focus cap, start: a focused wake over the limit is a notice row of the first input and is not reported", async () => {
  const wake = sizedMessage("c-wake", 2070, 17 * KB);
  const { h, release, cleanup } = await gatedHarness({ gated: [1], steers: false, start: { wakeMessage: wake } });
  try {
    assert.doesNotMatch(h.inputs[0]!, /New messages? received:/);
    assert.match(h.inputs[0]!, /Raft inbox notice/);
    const firstInput = h.events.find((event) => event.name === "daemon.agent.oar.first_input")!;
    assert.deepEqual(capAttrs(firstInput.attrs), [0, 1, 0]);
    release(1);
    await firstTurnOver(h);
    assert.deepEqual(seen(h), []);
  } finally {
    await cleanup();
  }
});

test("OAR focus: a steer OAR turned into a prompt after the running turn ended is reported at the new turn's output, not dropped with the old turn", async () => {
  // The steer finds the turn over: OAR's `deliver` opens a new turn with it and answers `prompted`.
  const gates = [deferred(), deferred()];
  let turns = 0;
  let h!: Harness;
  h = await harness({
    turn: async (turn) => { turns += 1; await gates[turns - 1]?.promise; turn.say("done"); },
    wrapSession: (session) => new Proxy(session, {
      get: (target, prop, receiver) => prop === "deliver"
        ? async (...args: Parameters<Session["deliver"]>) => {
          if (target.status().value.kind !== "running") return target.deliver(...args);
          gates[0]!.resolve();
          await until(() => h.framesOf("agent:runtime:outcome").length >= 1, "the running turn ended while the steer was in flight");
          const outcome = await target.prompt(String(args[0]), { origin: (args[1] as { origin: never }).origin });
          return outcome.kind === "accepted" ? { landed: "prompted" as const } : { landed: "rejected" as const, code: outcome.code, reason: outcome.reason };
        }
        : Reflect.get(target, prop, receiver),
    }),
    deps: { prepareLaunch: STEERING_LAUNCH },
  });
  try {
    await h.host.start(request({ config: focusOn() }));
    await until(() => h.inputs.length === 1, "first turn running");
    await h.host.deliverMessage("agent-1", threadMessage("m-promoted", 2080), { deliveryId: "d-promoted" });
    await until(() => outcomes(h, "prompted").length === 1, "landed as a prompt");
    await until(() => h.inputs.length === 2, "the new turn runs");
    assert.match(h.inputs[1]!, /body of m-promoted/);
    assert.deepEqual(dropped(h), [], "the old turn's end does not drop it");
    assert.deepEqual(seen(h), [], "the new turn has shown nothing yet");
    gates[1]!.resolve();
    await until(() => seen(h).length === 1, "reported at the new turn's output");
    assert.deepEqual(seen(h), [{ channelId: "thread-1", seqs: [2080] }]);
  } finally {
    for (const gate of gates) gate.resolve();
    await h.cleanup();
  }
});

test("OAR focus, prompt-first: a prompt rejected as busy whose busy delivery then lands as a prompt is not attributed to any turn; delivered, not reported", async () => {
  // OpenCode's launch: the input goes as a prompt first; `busy` makes it a busy delivery.
  // OAR records a turn start for the rejected prompt too, so the turn counts cannot say which turn the delivery opened.
  const gates = [deferred(), deferred()];
  let turns = 0;
  let busyPrompts = 0;
  let h!: Harness;
  h = await harness({
    turn: async (turn) => { turns += 1; await gates[turns - 1]?.promise; turn.say("done"); },
    wrapSession: (session) => new Proxy(session, {
      get: (target, prop, receiver) => {
        if (prop === "prompt") {
          return async (...args: Parameters<Session["prompt"]>) => {
            const outcome = await target.prompt(...args);
            if (outcome.kind === "rejected" && outcome.code === "busy") busyPrompts += 1;
            return outcome;
          };
        }
        if (prop === "deliver") {
          return async (...args: Parameters<Session["deliver"]>) => {
            // The running turn ends while the delivery is in flight: OAR opens a new turn with it.
            gates[0]!.resolve();
            await until(() => h.framesOf("agent:runtime:outcome").length >= 1, "the running turn ended");
            const outcome = await target.prompt(String(args[0]), { origin: (args[1] as { origin: never }).origin });
            return outcome.kind === "accepted" ? { landed: "prompted" as const } : { landed: "rejected" as const, code: outcome.code, reason: outcome.reason };
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }),
    deps: { prepareLaunch: async (ctx) => ({ ...(await STEERING_LAUNCH!(ctx)), promptFirst: true }) },
  });
  try {
    await h.host.start(request({ config: focusOn() }));
    await until(() => h.inputs.length === 1, "first turn running");
    await h.host.deliverMessage("agent-1", threadMessage("m-busy-prompt", 2090), { deliveryId: "d-busy-prompt" });
    await until(() => outcomes(h, "prompted").length === 1, "the busy delivery landed as a prompt");
    assert.equal(busyPrompts, 1, "the prompt was rejected as busy first");
    await until(() => h.inputs.length === 2, "the new turn runs");
    assert.match(h.inputs[1]!, /body of m-busy-prompt/, "delivered in full");
    assert.deepEqual(dropped(h).map((event) => [event.attrs.reason, event.attrs.messages_count]), [["promoted_after_busy_prompt", 1]]);
    gates[1]!.resolve();
    await until(() => h.framesOf("agent:runtime:outcome").length >= 2, "the new turn ended with output");
    assert.deepEqual(seen(h), [], "not reported from either turn's output");
  } finally {
    for (const gate of gates) gate.resolve();
    await h.cleanup();
  }
});

test("OAR focus: a promoted steer is not reported on output the count already held before the write", () => {
  // Reached through the host's own method: the scripted runtime cannot produce model output outside a turn.
  const events: Harness["events"] = [];
  const frames: unknown[] = [];
  const host = { deps: { recordEvent: (name: string, attrs: Record<string, unknown>) => { events.push({ name, attrs }); }, sendToServer: (frame: unknown) => { frames.push(frame); } } };
  const agent = {
    agentId: "agent-1", launchId: "launch-1", runtimeId: "codex",
    pendingModelSeen: [] as Array<{ afterTurnStart: number | null }>,
    seenSeqsByTarget: new Map<string, Set<number>>(),
    turn: { textEvents: 2, toolCalls: 0, thinkingEvents: 0, runtimeErrors: 0 },
    turnStarts: 4, turnEnds: 3, turnOpen: true,
  };
  const session = { id: "s-1" };
  const body = threadMessage("m-baseline", 2095);
  const proto = (OarAgentHost as unknown as { prototype: Record<string, (...args: unknown[]) => unknown> }).prototype;
  const call = (taken: Record<string, unknown>) => proto.notePromptedFocusBodies!.call(Object.assign(Object.create(proto), host), agent, session, [body], taken);
  // No turn end since the write, and the count is what it was: the new turn has not spoken.
  call({ landed: "prompted", turnOpenBefore: true, turnStartsBefore: 3, turnEndsBefore: 3, turnOutputBefore: 2, afterBusyPrompt: false });
  assert.equal(frames.length, 0, "not reported at once");
  assert.deepEqual(agent.pendingModelSeen.map((entry) => entry.afterTurnStart), [3], "waits for that turn's output");
  // Output past the baseline reports.
  agent.pendingModelSeen = [];
  call({ landed: "prompted", turnOpenBefore: true, turnStartsBefore: 3, turnEndsBefore: 3, turnOutputBefore: 1, afterBusyPrompt: false });
  assert.equal(frames.length, 1);
  // A turn end since the write reset the count: any output is the new turn's.
  call({ landed: "prompted", turnOpenBefore: true, turnStartsBefore: 3, turnEndsBefore: 2, turnOutputBefore: 5, afterBusyPrompt: false });
  assert.equal(frames.length, 2);
});

test("OAR focus cap: the rows a limit made are counted on the write the runtime took, not on a refused try of the same batch", async () => {
  let refusals = 1;
  const { h, release, cleanup } = await gatedHarness({
    gated: [1],
    config: makeConfig({ agentFocus: true }),
    wrapSession: (session) => new Proxy(session, {
      get: (target, prop, receiver) => prop === "deliver"
        ? async (...args: Parameters<Session["deliver"]>) => {
          if (refusals > 0) { refusals -= 1; return { landed: "rejected", code: "runtime_refused", reason: "not_steerable" }; }
          return target.deliver(...args);
        }
        : Reflect.get(target, prop, receiver),
    }),
  });
  try {
    await h.host.deliverMessage("agent-1", sizedMessage("c-big", 2100, 17 * KB), { deliveryId: "d-big" });
    await until(() => h.events.some((event) => event.name === "daemon.agent.oar.delivery" && event.attrs.code === "runtime_refused"), "the first try refused");
    release(1);
    await until(() => outcomes(h, "prompted").length === 1, "taken at the turn end");
    const tries = h.events.filter((event) => event.name === "daemon.agent.oar.delivery" && event.attrs.count === 1);
    assert.deepEqual(tries.map((event) => [event.attrs.outcome, event.attrs.focused_rows_over_message_cap_count ?? 0]), [["rejected", 0], ["prompted", 1]]);
  } finally {
    await cleanup();
  }
});
