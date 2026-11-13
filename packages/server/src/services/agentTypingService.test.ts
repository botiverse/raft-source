/**
 * Agent typing line registry: what the server emits for `agent:send_intent`
 * frames. Pure (injected clock, emitter, resolver).
 */
import assert from "node:assert/strict";
import { AGENT_TYPING_SOCKET_EVENT, AGENT_TYPING_TTL_MS, type AgentTypingEvent } from "@botiverse/raft-shared";
import {
  AGENT_TYPING_MAX_CALLS_PER_AGENT,
  AGENT_TYPING_SWEEP_INTERVAL_MS,
  AgentTypingRegistry,
  parseAgentSendIntentFrame,
  type ValidAgentSendIntent,
} from "./agentTypingService";
import type { AgentPostTargetPreview } from "../routes/agentWritableTarget";

const AGENT = { id: "agent-1", serverId: "server-1", machineId: "machine-1" };

function harness(options: {
  /** Holds each target resolution until the returned promise settles. */
  hold?: () => Promise<void>;
  targets?: Record<string, AgentPostTargetPreview | null>;
} = {}) {
  let now = 1_000_000;
  const emits: Array<{ room: string; event: string; payload: AgentTypingEvent }> = [];
  const previews: string[] = [];
  const targets = options.targets ?? {
    "#general": { channelId: "chan-general", parentMessageId: null },
    "#general:abcd1234": { channelId: "chan-general", parentMessageId: "msg-root" },
    "dm:@alice": { channelId: "chan-dm-alice", parentMessageId: null },
  };
  const registry = new AgentTypingRegistry({
    now: () => now,
    emit: (room, event, payload) => emits.push({ room, event, payload }),
    previewTarget: async (_serverId, _agentId, target) => {
      previews.push(target);
      if (options.hold) await options.hold();
      return targets[target] ?? null;
    },
  });
  return {
    registry,
    emits,
    previews,
    advance: (ms: number) => { now += ms; },
    now: () => now,
  };
}

const start = (callId: string, target: string): ValidAgentSendIntent => ({ agentId: AGENT.id, callId, phase: "start", target });
const end = (callId: string): ValidAgentSendIntent => ({ agentId: AGENT.id, callId, phase: "end" });

test("start: one emit to the channel room with the contract payload", async () => {
  const h = harness();
  assert.equal(await h.registry.handle(AGENT, start("c1", "#general")), "emitted_start");
  assert.deepEqual(h.emits, [{
    room: "channel:chan-general",
    event: AGENT_TYPING_SOCKET_EVENT,
    payload: {
      agentId: AGENT.id,
      serverId: AGENT.serverId,
      channelId: "chan-general",
      parentMessageId: null,
      callId: "c1",
      state: "start",
      expiresAt: h.now() + AGENT_TYPING_TTL_MS,
    },
  }]);
});

test("a thread target emits to the PARENT channel room with the root message", async () => {
  const h = harness();
  await h.registry.handle(AGENT, start("c1", "#general:abcd1234"));
  assert.equal(h.emits.length, 1);
  assert.equal(h.emits[0]!.room, "channel:chan-general");
  assert.equal(h.emits[0]!.payload.parentMessageId, "msg-root");
});

test("refresh: a repeated start re-emits with a later expiry and does not resolve again", async () => {
  const h = harness();
  await h.registry.handle(AGENT, start("c1", "#general"));
  h.advance(8_000);
  assert.equal(await h.registry.handle(AGENT, start("c1", "#general")), "refreshed");
  assert.equal(h.emits.length, 2);
  assert.equal(h.emits[1]!.payload.state, "start");
  assert.equal(h.emits[1]!.payload.expiresAt, h.now() + AGENT_TYPING_TTL_MS);
  assert.deepEqual(h.previews, ["#general"], "resolved once");
  assert.equal(h.registry.size(), 1);
});

test("end: emits state end for the call and forgets it; a later start for it is ignored", async () => {
  const h = harness();
  await h.registry.handle(AGENT, start("c1", "dm:@alice"));
  assert.equal(await h.registry.handle(AGENT, end("c1")), "emitted_end");
  assert.equal(h.emits.length, 2);
  assert.equal(h.emits[1]!.room, "channel:chan-dm-alice");
  assert.equal(h.emits[1]!.payload.state, "end");
  assert.equal(h.emits[1]!.payload.callId, "c1");
  assert.equal(h.registry.size(), 0);
  // Reordered or late start of an ended call does not reopen the line.
  assert.equal(await h.registry.handle(AGENT, start("c1", "dm:@alice")), "ended_call");
  assert.equal(await h.registry.handle(AGENT, end("c1")), "unknown_call");
  assert.equal(h.emits.length, 2);
});

test("an end that overtakes an in-flight start wins", async () => {
  let release!: () => void;
  const h = harness({ hold: () => new Promise<void>((resolve) => { release = resolve; }) });
  const pending = h.registry.handle(AGENT, start("c1", "#general"));
  assert.equal(await h.registry.handle(AGENT, end("c1")), "unknown_call");
  release();
  assert.equal(await pending, "superseded");
  assert.deepEqual(h.emits, []);
  assert.equal(h.registry.size(), 0);
});

test("an unresolvable target emits nothing", async () => {
  const h = harness();
  assert.equal(await h.registry.handle(AGENT, start("c1", "#secret")), "unresolved_target");
  assert.deepEqual(h.emits, []);
});

test("never emits to the server room", async () => {
  const h = harness();
  await h.registry.handle(AGENT, start("c1", "#general"));
  await h.registry.handle(AGENT, start("c2", "dm:@alice"));
  await h.registry.handle(AGENT, start("c1", "#general"));
  await h.registry.handle(AGENT, end("c1"));
  h.registry.endForAgent(AGENT.id);
  assert.ok(h.emits.length >= 4);
  for (const emit of h.emits) assert.match(emit.room, /^channel:/);
  assert.ok(!h.emits.some((emit) => emit.room.startsWith("server:")));
});

test("agent stop and machine disconnect end the live lines; expired ones are swept silently", async () => {
  const h = harness();
  await h.registry.handle(AGENT, start("c1", "#general"));
  await h.registry.handle({ ...AGENT, id: "agent-2" }, { ...start("c9", "dm:@alice"), agentId: "agent-2" });
  assert.equal(h.registry.endForAgent(AGENT.id), 1);
  assert.equal(h.emits.at(-1)!.payload.state, "end");
  assert.equal(h.emits.at(-1)!.payload.agentId, AGENT.id);
  assert.equal(h.registry.endForMachine(AGENT.machineId), 1);
  assert.equal(h.emits.at(-1)!.payload.agentId, "agent-2");
  assert.equal(h.registry.size(), 0);

  await h.registry.handle(AGENT, start("c3", "#general"));
  const emitted = h.emits.length;
  h.advance(AGENT_TYPING_TTL_MS + 1);
  h.registry.sweep();
  assert.equal(h.registry.size(), 0);
  assert.equal(h.emits.length, emitted, "expiry emits nothing");
});

test("live calls per agent are capped", async () => {
  const h = harness();
  for (let i = 0; i < AGENT_TYPING_MAX_CALLS_PER_AGENT; i += 1) {
    assert.equal(await h.registry.handle(AGENT, start(`c${i}`, "#general")), "emitted_start");
  }
  assert.equal(await h.registry.handle(AGENT, start("one-too-many", "#general")), "too_many_calls");
});

test("the agent's message landing ends its line there; the call's later refreshes are ignored", async () => {
  const h = harness();
  await h.registry.handle(AGENT, start("c1", "#general"));
  await h.registry.handle(AGENT, start("c2", "dm:@alice"));
  await h.registry.handle({ ...AGENT, id: "agent-2" }, { ...start("c9", "#general"), agentId: "agent-2" });
  assert.equal(h.registry.endForPostedMessage(AGENT.id, { channelId: "chan-general", parentMessageId: null }, "#general"), 1);
  const last = h.emits.at(-1)!;
  assert.equal(last.payload.state, "end");
  assert.equal(last.payload.callId, "c1");
  assert.equal(last.payload.agentId, AGENT.id);
  assert.equal(h.registry.size(), 2, "the DM line and the other agent's line stay");

  const emitted = h.emits.length;
  h.advance(8_000);
  assert.equal(await h.registry.handle(AGENT, start("c1", "#general")), "ended_call");
  assert.equal(h.emits.length, emitted);
  assert.equal(await h.registry.handle(AGENT, start("c2", "dm:@alice")), "refreshed");
});

test("a thread reply ends the line by its root message, not the channel's own line", async () => {
  const h = harness();
  await h.registry.handle(AGENT, start("thread", "#general:abcd1234"));
  await h.registry.handle(AGENT, start("channel", "#general"));
  assert.equal(h.registry.endForPostedMessage(AGENT.id, { channelId: null, parentMessageId: "msg-root" }), 1);
  assert.equal(h.emits.at(-1)!.payload.callId, "thread");
  assert.equal(await h.registry.handle(AGENT, start("thread", "#general:abcd1234")), "ended_call");
  assert.equal(await h.registry.handle(AGENT, start("channel", "#general")), "refreshed");
});

test("a start still resolving when the message lands yields", async () => {
  let release!: () => void;
  const h = harness({ hold: () => new Promise<void>((resolve) => { release = resolve; }) });
  const pending = h.registry.handle(AGENT, start("c1", "#general"));
  h.registry.endForPostedMessage(AGENT.id, { channelId: "chan-general", parentMessageId: null }, "#general");
  release();
  assert.equal(await pending, "superseded");
  assert.equal(await h.registry.handle(AGENT, start("c1", "#general")), "ended_call");
  assert.deepEqual(h.emits, []);
});

for (const [name, endAll] of [
  ["agent stop", (registry: AgentTypingRegistry) => registry.endForAgent(AGENT.id)],
  ["machine disconnect", (registry: AgentTypingRegistry) => registry.endForMachine(AGENT.machineId)],
] as const) {
  test(`${name}: a start still resolving does not outlive it`, async () => {
    let release!: () => void;
    const h = harness({ hold: () => new Promise<void>((resolve) => { release = resolve; }) });
    const pending = h.registry.handle(AGENT, start("c1", "#general"));
    endAll(h.registry);
    release();
    assert.equal(await pending, "superseded");
    assert.equal(await h.registry.handle(AGENT, start("c1", "#general")), "ended_call");
    assert.deepEqual(h.emits, []);
    assert.equal(h.registry.size(), 0);
  });
}

test("an end for a call never seen writes no marker; markers are swept after their TTL", async () => {
  const h = harness();
  assert.equal(await h.registry.handle(AGENT, end("never-started")), "unknown_call");
  assert.equal(h.registry.endedMarkerCount(), 0);
  await h.registry.handle(AGENT, start("c1", "#general"));
  await h.registry.handle(AGENT, end("c1"));
  assert.equal(h.registry.endedMarkerCount(), 1);
  h.advance(AGENT_TYPING_TTL_MS + AGENT_TYPING_SWEEP_INTERVAL_MS);
  // The next frame sweeps (at most once per interval) and the call may start again.
  assert.equal(await h.registry.handle(AGENT, start("c1", "#general")), "emitted_start");
  assert.equal(h.registry.endedMarkerCount(), 0);
});

test("frame validation drops malformed frames", () => {
  const ok = { type: "agent:send_intent", agentId: "a", callId: "c", phase: "start", target: "#general", early: true };
  assert.deepEqual(parseAgentSendIntentFrame(ok), { agentId: "a", callId: "c", phase: "start", target: "#general" });
  assert.deepEqual(parseAgentSendIntentFrame({ ...ok, phase: "end", target: undefined }), { agentId: "a", callId: "c", phase: "end" });
  assert.equal(parseAgentSendIntentFrame(null), null);
  assert.equal(parseAgentSendIntentFrame({ ...ok, phase: "typing" }), null);
  assert.equal(parseAgentSendIntentFrame({ ...ok, callId: "" }), null);
  assert.equal(parseAgentSendIntentFrame({ ...ok, callId: "x".repeat(201) }), null);
  assert.equal(parseAgentSendIntentFrame({ ...ok, target: undefined }), null, "start needs a target");
  assert.equal(parseAgentSendIntentFrame({ ...ok, target: "#".repeat(513) }), null);
  assert.equal(parseAgentSendIntentFrame({ ...ok, target: 42 }), null);
  assert.equal(parseAgentSendIntentFrame({ ...ok, agentId: 7 }), null);
  assert.equal(parseAgentSendIntentFrame({ ...ok, launchId: 7 }), null);
});
