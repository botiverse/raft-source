// OAR 0.103: a runtime with an input bound (Antigravity, 185,000 bytes)
// refuses one input over it before sending: `rejected`, code `unsupported`,
// `failure: "input_too_large"`. The host decides by `failure`: a batch of
// held messages too long together is handed over one at a time; a message too
// long on its own is refused with Raft's own hint (shorten or split it, a
// `MessageTooLargeError`), never OAR's reason, and the session keeps running.
// A first input refused so starts the session without its messages, never on
// the deprecated driver (which would cut it).
//
// RED proof (reverse-verified): without the `failure` check the batch is
// refused whole (neither message reaches the runtime), the too-long message
// is dropped with no error activity, and a too-long first input is handed
// back (`first_input_rejected:unsupported`).
import assert from "node:assert/strict";
import type { Session } from "@botiverse/oar";
import { harness, message, request, until } from "../testing/oarAgentHostHarness";

/** OAR's wording, which says "Antigravity" even for another runtime: never shown. */
const OAR_REASON = "input is 190000 bytes, over OAR's 185000-byte bound for one input to this runtime, reported by Antigravity";

/** Prompts `tooLong` says are over the bound are refused as OAR refuses them; the rest go through. */
function boundedPrompts(tooLong: (input: string) => boolean, refused: string[]) {
  return (session: Session): Session => new Proxy(session, {
    get: (target, prop, receiver) => prop === "prompt"
      ? async (...args: Parameters<Session["prompt"]>) => {
        const input = String(args[0]);
        if (tooLong(input)) {
          refused.push(input);
          return { kind: "rejected", code: "unsupported", failure: "input_too_large", reason: OAR_REASON, seq: 0, requestId: `r-${refused.length}` };
        }
        return target.prompt(...args);
      }
      : Reflect.get(target, prop, receiver),
  });
}

test("held messages too long together are handed over one at a time; nothing is refused", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let turns = 0;
  const refused: string[] = [];
  const h = await harness({
    turn: async (turn) => {
      turns += 1;
      if (turns === 1) await gate;
      turn.say("ok");
    },
    wrapSession: boundedPrompts((input) => input.includes("m-big-a") && input.includes("m-big-b"), refused),
  });
  try {
    await h.host.start(request());
    await until(() => h.inputs.length === 1, "the first turn runs");
    // Busy: both are held until the turn ends, then offered together.
    await h.host.deliverMessage("agent-1", message("m-big-a"), {});
    await h.host.deliverMessage("agent-1", message("m-big-b"), {});
    release();
    await until(() => h.inputs.some((input) => input.includes("m-big-b")), "the second message delivered");
    assert.equal(refused.length, 1, "the batch was refused once");
    const delivered = h.inputs.slice(1);
    assert.equal(delivered.filter((input) => input.includes("m-big-a")).length, 1, "the first alone, once");
    assert.equal(delivered.filter((input) => input.includes("m-big-b")).length, 1, "the second alone, once");
    assert.equal(h.framesOf("agent:activity").filter((frame) => frame.detailKind === "runtime_error").length, 0, "no error");
  } finally {
    await h.cleanup();
  }
});

test("a message too long on its own is refused with Raft's hint, never OAR's reason; the next one goes in on the same session", async () => {
  const refused: string[] = [];
  let terminal = 0;
  const h = await harness({ wrapSession: boundedPrompts((input) => input.includes("m-huge"), refused) });
  try {
    await h.host.start(request());
    await until(() => h.framesOf("agent:runtime:outcome").length > 0, "first turn");
    assert.equal(await h.host.deliverMessage("agent-1", message("m-huge"), {
      deliveryId: "d-huge",
      mentionDelivery: { occurrenceId: "occ-1", messageId: "m-huge", machineId: "machine-1", launchId: "launch-1", sessionId: "s" } as never,
      onMentionTerminalError: () => { terminal += 1; },
    }), true);
    await until(() => h.framesOf("agent:activity").some((frame) => frame.detailKind === "runtime_error"), "the error shown");
    const error = h.framesOf("agent:activity").find((frame) => frame.detailKind === "runtime_error")!;
    assert.match(error.detail, /too long for .+ to take in one message.*Shorten it, or split it into several messages/);
    assert.doesNotMatch(error.detail, /185000-byte|reported by Antigravity|unsupported/, "never OAR's reason or code");
    assert.equal(error.runtimeError?.errorClass, "MessageTooLargeError");
    assert.equal(error.runtimeError?.errorReason, "message_too_large");
    assert.equal(refused.length, 1, "offered once, never again");
    assert.equal(terminal, 1, "the mention is answered as not delivered");
    const delivery = h.events.find((event) => event.name === "daemon.agent.oar.delivery" && event.attrs.code === "unsupported");
    assert.equal(delivery?.attrs.oar_failure, "input_too_large");

    await h.host.deliverMessage("agent-1", message("m-next"), {});
    await until(() => h.inputs.some((input) => input.includes("m-next")), "the next message delivered");
    assert.equal(h.opened.length, 1, "the same session");
  } finally {
    await h.cleanup();
  }
});

test("a batch [ok, too long, ok] goes one at a time: only the long one is refused; later messages batch again", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let releaseLater!: () => void;
  const laterGate = new Promise<void>((resolve) => { releaseLater = resolve; });
  let turns = 0;
  const refused: string[] = [];
  const h = await harness({
    turn: async (turn) => {
      turns += 1;
      if (turns === 1) await gate;
      // The turn the last message of the split starts: held, so the next two wait together.
      if (turn.input.includes("m-ok-2")) await laterGate;
      turn.say("ok");
    },
    wrapSession: boundedPrompts((input) => input.includes("m-long") || (input.includes("m-ok-1") && input.includes("m-ok-2")), refused),
  });
  try {
    await h.host.start(request());
    await until(() => h.inputs.length === 1, "the first turn runs");
    // Each in its own channel: no thread context carries one into another's input.
    for (const id of ["m-ok-1", "m-long", "m-ok-2"]) await h.host.deliverMessage("agent-1", message(id, { channel_id: `ch-${id}` }), {});
    release();
    await until(() => h.inputs.some((input) => input.includes("m-ok-2")), "the last of the batch delivered");
    const delivered = h.inputs.slice(1);
    assert.deepEqual(delivered.map((input) => ["m-ok-1", "m-long", "m-ok-2"].filter((id) => input.includes(id))), [["m-ok-1"], ["m-ok-2"]]);
    assert.equal(h.framesOf("agent:activity").filter((frame) => frame.runtimeError?.errorClass === "MessageTooLargeError").length, 1, "the long one only");

    // The split is through: two later messages go in as one input again.
    await h.host.deliverMessage("agent-1", message("m-later-a", { channel_id: "ch-later-a" }), {});
    await h.host.deliverMessage("agent-1", message("m-later-b", { channel_id: "ch-later-b" }), {});
    releaseLater();
    const deliveries = () => h.events.filter((event) => event.name === "daemon.agent.oar.delivery" && event.attrs.outcome === "prompted").map((event) => event.attrs.count);
    await until(() => deliveries().length === 3, "the later messages delivered");
    assert.deepEqual(deliveries(), [1, 1, 2], "one at a time while split, then batched again");
  } finally {
    await h.cleanup();
  }
});

test("a first input too long with its wake message starts the session without it; the message is then refused with Raft's hint, never handed to the older driver", async () => {
  const refused: string[] = [];
  let prompts = 0;
  // OAR refuses the first input (with the wake) and then the wake alone; the input without it fits.
  const h = await harness({ wrapSession: boundedPrompts(() => { prompts += 1; return prompts === 1 || prompts === 3; }, refused) });
  try {
    assert.deepEqual(await h.host.start(request({ wakeMessage: message("m-wake-huge") })), { kind: "started" });
    await until(() => h.framesOf("agent:activity").some((frame) => frame.runtimeError?.errorClass === "MessageTooLargeError"), "the wake refused with the hint");
    assert.equal(h.opened.length, 1, "one session, on OAR");
    assert.ok(h.framesOf("agent:process_spawned").length > 0, "started here, not handed back");
    assert.equal(refused.length, 2, "the first input with the wake, then the wake alone");
    assert.notEqual(refused[0], h.inputs[0], "the session's first turn is another input: the one without the wake");
    const firstInputs = h.events.filter((event) => event.name === "daemon.agent.oar.first_input");
    assert.deepEqual(firstInputs.map((event) => [event.attrs.outcome, event.attrs.oar_failure ?? null, event.attrs.without_messages ?? false]), [["rejected", "input_too_large", false], ["accepted", null, true]]);

    await h.host.deliverMessage("agent-1", message("m-next", { channel_id: "ch-next" }), {});
    await until(() => h.inputs.some((input) => input.includes("m-next")), "the next message delivered");
  } finally {
    await h.cleanup();
  }
});

test("a startup input too long even without messages fails the start here, never on the older driver", async () => {
  const refused: string[] = [];
  const h = await harness({ wrapSession: boundedPrompts(() => true, refused) });
  try {
    const outcome = await h.host.start(request({ wakeMessage: message("m-wake") }));
    assert.equal(refused.length, 2, "with the wake, then without it");
    assert.equal(h.framesOf("agent:process_spawned").length, 0);
    // Failed here (the router fails the start with this sentence), never a fallback to the older driver.
    assert.equal((outcome as { reason?: string }).reason, "first_input_rejected:input_too_large");
    assert.match(String((outcome as { failHere?: string }).failHere), /startup input is too long for .+ to take in one message/);
  } finally {
    await h.cleanup();
  }
});
