/**
 * Agent activity scoped to who is watching (#proj-frontend:#8): the coarse
 * state fanout's throttle, who receives what from emitActivity (capable vs
 * legacy clients), and the subscribe authorization.
 */
import assert from "node:assert/strict";
import type { Server as SocketServer } from "socket.io";
import {
  AGENT_ACTIVITY_STATE_EVENT,
  AGENT_ACTIVITY_SUBSCRIBED_EVENT,
  agentActivityCapableServerRoom,
  agentActivityRoom,
  type AgentActivityStatePayload,
} from "@botiverse/raft-shared";

import { AgentActivityStateFanout } from "./agentActivityStateFanout";
import { AgentOrchestrator } from "./agentOrchestrator";
import { parseAgentActivitySubscriptionIds, subscribeSocketToAgentActivity } from "../socket/index";

function fakeClock(start = 1_000_000) {
  let now = start;
  const timers: Array<{ at: number; fn: () => void; id: number }> = [];
  let nextId = 1;
  return {
    now: () => now,
    setTimeout: (fn: () => void, ms: number) => {
      const id = nextId++;
      timers.push({ at: now + ms, fn, id });
      return id;
    },
    clearTimeout: (id: unknown) => {
      const index = timers.findIndex((timer) => timer.id === id);
      if (index >= 0) timers.splice(index, 1);
    },
    advance(ms: number) {
      now += ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const due = timers[0];
        if (!due || due.at > now) break;
        timers.shift();
        due.fn();
      }
    },
  };
}

test("the coarse state goes out on a change, at most once per agent per 5 s, as the state it has at the end", () => {
  const clock = fakeClock();
  const sent: AgentActivityStatePayload[] = [];
  const fanout = new AgentActivityStateFanout((_serverId, payload) => sent.push(payload), clock);

  fanout.observe("s1", "a", "online", 1, 1);
  assert.deepEqual(sent.map((p) => p.state), ["online"], "first state: sent at once");
  fanout.observe("s1", "a", "online", 2, 2);
  assert.equal(sent.length, 1, "same coarse state: nothing");

  clock.advance(1_000);
  fanout.observe("s1", "a", "working", 3, 3);
  fanout.observe("s1", "a", "thinking", 4, 4);
  fanout.observe("s1", "a", "working", 5, 5);
  assert.equal(sent.length, 1, "a change inside the interval is held");
  clock.advance(4_000);
  assert.deepEqual(sent.map((p) => [p.state, p.serverSeq]), [["online", 1], ["busy", 5]], "sent at the interval's end, with the latest push");

  clock.advance(1_000);
  fanout.observe("s1", "a", "online", 6, 6);
  fanout.observe("s1", "a", "working", 7, 7);
  clock.advance(5_000);
  assert.equal(sent.length, 2, "back where it was by the end: nothing");

  fanout.observe("s1", "b", "error", 8, 8);
  assert.deepEqual(sent.at(-1), { agentId: "b", state: "error", activity: "error", timestamp: 8, serverSeq: 8 }, "agents are throttled apart");
});

test("a deleted agent's held coarse state is dropped, not sent", () => {
  const clock = fakeClock();
  const sent: AgentActivityStatePayload[] = [];
  const fanout = new AgentActivityStateFanout((_serverId, payload) => sent.push(payload), clock);

  fanout.observe("s1", "a", "online", 1, 1);
  clock.advance(1_000);
  fanout.observe("s1", "a", "working", 2, 2);
  fanout.forget("a");
  clock.advance(5_000);
  assert.deepEqual(sent.map((p) => p.state), ["online"], "the held busy state never goes out");

  fanout.observe("s1", "a", "working", 3, 3);
  assert.deepEqual(sent.map((p) => p.state), ["online", "busy"], "nothing left of it: a later state is sent as a first one");
});

type Emitted = { to: string; except: string | null; event: string; payload: Record<string, unknown> };

function recordingIo(emitted: Emitted[]): SocketServer {
  const operatorFor = (to: string, except: string | null = null): any => ({
    except: (room: string) => operatorFor(to, room),
    to: () => operatorFor(to, except),
    in: () => operatorFor(to, except),
    socketsJoin: () => undefined,
    emit: (event: string, payload: Record<string, unknown>) => {
      emitted.push({ to, except, event, payload });
      return true;
    },
  });
  return { to: (room: string) => operatorFor(room), in: (room: string) => operatorFor(room) } as unknown as SocketServer;
}

class EmitOnlyOrchestrator extends AgentOrchestrator {
  protected override async loadJointActivityProjectionChannelIdsForAgent(): Promise<string[]> {
    return [];
  }
}

test("a detailed push reaches legacy clients server-wide and capable ones only through the agent's room; capable ones get the coarse state", async () => {
  const emitted: Emitted[] = [];
  const orchestrator = new EmitOnlyOrchestrator();
  orchestrator.setIO(recordingIo(emitted));
  (orchestrator as any).getCachedAgent = async (id: string) => ({ id, serverId: "s1" });

  await (orchestrator as any).emitActivity("a", "working", "Editing file", "action", 100);
  await (orchestrator as any).emitActivity("a", "working", "Running command", "action", 101);

  const detailed = emitted.filter((e) => e.event === "agent:activity");
  assert.deepEqual(detailed.map((e) => [e.to, e.except]), [
    ["server:s1", agentActivityCapableServerRoom("s1")],
    [agentActivityRoom("a"), null],
    ["server:s1", agentActivityCapableServerRoom("s1")],
    [agentActivityRoom("a"), null],
  ], "legacy: the server room minus capable sockets; capable: only the agent's room");
  const states = emitted.filter((e) => e.event === AGENT_ACTIVITY_STATE_EVENT);
  assert.deepEqual(states.map((e) => [e.to, e.payload.state, e.payload.agentId]), [[agentActivityCapableServerRoom("s1"), "busy", "a"]], "one coarse state for two detail changes");
});

test("forgetAgentActivity on the orchestrator drops the agent's held coarse state", async () => {
  const emitted: Emitted[] = [];
  const orchestrator = new EmitOnlyOrchestrator();
  orchestrator.setIO(recordingIo(emitted));
  (orchestrator as any).getCachedAgent = async (id: string) => ({ id, serverId: "s1" });
  const fanout = (orchestrator as any).agentActivityStateFanout as AgentActivityStateFanout;
  let forgotten: string | null = null;
  const forget = fanout.forget.bind(fanout);
  fanout.forget = (agentId: string) => { forgotten = agentId; forget(agentId); };

  orchestrator.forgetAgentActivity("a");
  assert.equal(forgotten, "a");
});

function fakeSocket() {
  const joined: string[] = [];
  const emits: Array<[string, unknown]> = [];
  return {
    joined,
    emits,
    socket: { connected: true, join: (room: string) => { joined.push(room); }, emit: (event: string, payload: unknown) => { emits.push([event, payload]); return true; } } as any,
  };
}

test("a capable member socket subscribes only to agents of its own server; guests and legacy sockets get nothing", async () => {
  const inServer = async (_serverId: string, ids: readonly string[]) => new Set(ids.filter((id) => id.startsWith("own-")));

  const member = fakeSocket();
  const joined = await subscribeSocketToAgentActivity(member.socket, { userId: "u1", serverId: "s1", serverRole: "member", capable: true, body: { agentIds: ["own-a", "other-b", "own-a"] } }, inServer);
  assert.deepEqual(joined, ["own-a"]);
  assert.deepEqual(member.joined, [agentActivityRoom("own-a")], "another server's agent is not joined");
  assert.deepEqual(member.emits, [[AGENT_ACTIVITY_SUBSCRIBED_EVENT, { agentIds: ["own-a"] }]]);

  for (const input of [
    { serverId: "s1", serverRole: "guest", capable: true },
    { serverId: "s1", serverRole: "member", capable: false },
    { serverId: null, serverRole: "member", capable: true },
  ]) {
    const other = fakeSocket();
    assert.deepEqual(await subscribeSocketToAgentActivity(other.socket, { userId: "u1", ...input, body: { agentIds: ["own-a"] } }, inServer), [], JSON.stringify(input));
    assert.deepEqual(other.joined, []);
  }

  const failing = fakeSocket();
  assert.deepEqual(await subscribeSocketToAgentActivity(failing.socket, { userId: "u1", serverId: "s1", serverRole: "member", capable: true, body: { agentIds: ["own-a"] } }, async () => { throw new Error("db down"); }), [], "a failed read joins nothing");
});

test("subscribe bodies: strings only, deduped, bounded", () => {
  assert.deepEqual(parseAgentActivitySubscriptionIds({ agentIds: ["a", 1, "a", "", "b"] }), ["a", "b"]);
  assert.deepEqual(parseAgentActivitySubscriptionIds(null), []);
  assert.deepEqual(parseAgentActivitySubscriptionIds({ agentIds: "a" }), []);
  assert.equal(parseAgentActivitySubscriptionIds({ agentIds: Array.from({ length: 500 }, (_, i) => `id-${i}`) }).length, 200);
});
