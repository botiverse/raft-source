// Idle task reminder (#wg-task-v2:#9), Computer side: when it asks the
// Server, what it says, and what it delivers. The Server is a fake ask.
import assert from "node:assert/strict";

import type { AgentApiTaskIdleNudgeBody, AgentApiTaskIdleNudgeResponse } from "@botiverse/raft-shared";
import type { AgentIdleNoticeDelivery, AgentIdleNoticeFacts } from "../../agentHost/agentLifecycleHost";
import {
  IdleTaskReminderAskFailure,
  IdleTaskReminderRuntime,
  createIdleTaskReminderAsk,
} from "./runtime";

const AGENT = "agent-1";
const NOTICE = "[Raft task notice: 1 task is waiting on you.\n#proj:#4 [todo] Rollout — newly yours\nNo change → no reply needed.]";

function sent(overrides: Partial<AgentApiTaskIdleNudgeResponse> = {}): AgentApiTaskIdleNudgeResponse {
  return {
    send: true,
    items: [{ ref: "#proj:#4", taskNumber: 4, channel: "#proj", title: "Rollout", status: "todo", reason: "newly_assigned", why: "newly yours" }],
    backlog: [],
    text: NOTICE,
    ...overrides,
  };
}

function skipped(reason: NonNullable<AgentApiTaskIdleNudgeResponse["reason"]>): AgentApiTaskIdleNudgeResponse {
  return { send: false, reason, items: [], backlog: [], text: "" };
}

function facts(overrides: Partial<AgentIdleNoticeFacts> = {}): AgentIdleNoticeFacts {
  return { sessionId: "session-1", launchId: "launch-1", resumed: false, backgroundTasks: 0, blocked: false, ...overrides };
}

function harness(options: {
  answers?: Array<AgentApiTaskIdleNudgeResponse | Error | Promise<AgentApiTaskIdleNudgeResponse>>;
  facts?: () => AgentIdleNoticeFacts | null;
  delivery?: AgentIdleNoticeDelivery | (() => Promise<AgentIdleNoticeDelivery>);
  capable?: boolean;
} = {}) {
  const asks: AgentApiTaskIdleNudgeBody[] = [];
  const deliveries: string[] = [];
  const traces: Array<{ name: string; attrs: Readonly<Record<string, unknown>>; status?: string }> = [];
  const answers = [...(options.answers ?? [])];
  const runtime = new IdleTaskReminderRuntime({
    ask: async (agentId, body) => {
      assert.equal(agentId, AGENT);
      asks.push(body);
      const answer = answers.shift() ?? skipped("no_change");
      if (answer instanceof Error) throw answer;
      return answer;
    },
    agentFacts: (agentId) => {
      assert.equal(agentId, AGENT);
      return options.facts ? options.facts() : facts();
    },
    deliver: async (agentId, text) => {
      assert.equal(agentId, AGENT);
      deliveries.push(text);
      const delivery = options.delivery ?? "written";
      return typeof delivery === "function" ? delivery() : delivery;
    },
    trace: (name, attrs, status) => traces.push({ name, attrs, status }),
  });
  runtime.setServerCapable(options.capable ?? true);
  const idle = async () => {
    runtime.onAgentWorkingToIdle(AGENT);
    await runtime.waitForIdle();
  };
  const calls = () => traces.filter((trace) => trace.name === "daemon.idle_task_reminder.call");
  return { runtime, asks, deliveries, traces, calls, idle };
}

test("a Server without the capability is never asked", async () => {
  const h = harness({ capable: false });
  await h.idle();
  assert.deepEqual(h.asks, []);
  assert.deepEqual(h.deliveries, []);
  assert.deepEqual(h.traces, [], "nothing to trace for an older Server");

  h.runtime.setServerCapable(true);
  await h.idle();
  assert.equal(h.asks.length, 1, "asked once the Server advertises it");
  h.runtime.setServerCapable(false);
  await h.idle();
  assert.equal(h.asks.length, 1, "not after a disconnect");
});

test("an agent with no live session or a blocked one is not asked", async () => {
  let current: AgentIdleNoticeFacts | null = null;
  const h = harness({ facts: () => current });
  await h.idle();
  assert.deepEqual(h.asks, [], "stopped: not asked, never woken");

  current = facts({ blocked: true });
  await h.idle();
  assert.deepEqual(h.asks, [], "blocked: not asked, nothing queued");
  assert.equal(h.traces.at(-1)?.attrs.reason, "blocked");
});

test("send: false delivers nothing", async () => {
  const h = harness({ answers: [skipped("no_change")] });
  await h.idle();
  assert.equal(h.asks.length, 1);
  assert.deepEqual(h.deliveries, []);
  const [call] = h.calls();
  assert.equal(call?.attrs.send, false);
  assert.equal(call?.attrs.reason, "no_change");
  assert.equal(call?.attrs.delivered, "not_sent");
  assert.equal(call?.attrs.items, 0);
});

test("send: true delivers the Server's text once, as it is", async () => {
  const h = harness({ answers: [sent()] });
  await h.idle();
  assert.deepEqual(h.deliveries, [NOTICE]);
  const [call] = h.calls();
  assert.equal(call?.status, "ok");
  assert.equal(call?.attrs.app_id, "system.idle-task-reminder");
  assert.equal(call?.attrs.agentId, AGENT);
  assert.equal(call?.attrs.launchId, "launch-1");
  assert.equal(call?.attrs.send, true);
  assert.equal(call?.attrs.items, 1);
  assert.equal(call?.attrs.item_reasons, "newly_assigned:1");
  assert.equal(call?.attrs.backlog, 0);
  assert.equal(call?.attrs.delivered, "written");
  assert.equal(JSON.stringify(call?.attrs).includes("Rollout"), false, "no task content in the trace");
});

test("freshSession sticks until a reminder asked with it is delivered", async () => {
  let delivery: AgentIdleNoticeDelivery = "written";
  const h = harness({
    answers: [skipped("hourly_cap"), sent(), sent(), sent()],
    delivery: async () => delivery,
  });
  await h.idle();
  assert.equal(h.asks[0]?.freshSession, true, "a new session's first ask");

  delivery = "busy";
  await h.idle();
  assert.equal(h.asks[1]?.freshSession, true, "a capped ask records nothing: still fresh");

  delivery = "written";
  await h.idle();
  assert.equal(h.asks[2]?.freshSession, true, "an undelivered reminder does not count");

  await h.idle();
  assert.equal(h.asks[3]?.freshSession, false, "the first full listing reached the agent");
  assert.deepEqual(h.calls().map((call) => call.attrs.fresh_session), [true, true, true, false]);
});

test("a new session is fresh again; a resumed one never is", async () => {
  let current = facts();
  const h = harness({ answers: [sent(), skipped("no_change"), skipped("no_change"), skipped("no_change")], facts: () => current });
  await h.idle();
  await h.idle();
  assert.deepEqual(h.asks.map((ask) => ask.freshSession), [true, false]);

  current = facts({ sessionId: "session-2", launchId: "launch-2" });
  await h.idle();
  assert.equal(h.asks[2]?.freshSession, true, "a context reset (new session) lists everything once");

  current = facts({ sessionId: "session-3", resumed: true });
  await h.idle();
  assert.equal(h.asks[3]?.freshSession, false, "a resumed session already holds its reminders");
});

test("no open tasks or a disabled Server settles the fresh listing", async () => {
  const h = harness({ answers: [skipped("no_open_tasks"), skipped("no_change")] });
  await h.idle();
  await h.idle();
  assert.deepEqual(h.asks.map((ask) => ask.freshSession), [true, false]);

  const disabled = harness({ answers: [skipped("disabled"), skipped("disabled")] });
  await disabled.idle();
  await disabled.idle();
  assert.deepEqual(disabled.asks.map((ask) => ask.freshSession), [true, false]);
});

test("the background task count is passed through", async () => {
  const h = harness({ facts: () => facts({ backgroundTasks: 2 }) });
  await h.idle();
  assert.equal(h.asks[0]?.backgroundTasks, 2);
  assert.equal(h.calls()[0]?.attrs.background_tasks, 2);

  const none = harness();
  await none.idle();
  assert.equal(none.asks[0]?.backgroundTasks, 0, "0 for a runtime that reports none");
});

test("at most one ask per agent is in flight", async () => {
  let answer!: (response: AgentApiTaskIdleNudgeResponse) => void;
  const pending = new Promise<AgentApiTaskIdleNudgeResponse>((resolve) => { answer = resolve; });
  const h = harness({ answers: [pending, skipped("no_change")] });
  h.runtime.onAgentWorkingToIdle(AGENT);
  h.runtime.onAgentWorkingToIdle(AGENT);
  h.runtime.onAgentWorkingToIdle(AGENT);
  await Promise.resolve();
  assert.equal(h.asks.length, 1, "edges during an ask are dropped");
  assert.equal(h.traces.filter((trace) => trace.attrs.reason === "in_flight").length, 2);
  answer(sent());
  await h.runtime.waitForIdle();
  assert.deepEqual(h.deliveries, [NOTICE]);

  await h.idle();
  assert.equal(h.asks.length, 2, "the next edge asks again");
});

test("errors are swallowed and traced; the edge never throws", async () => {
  const h = harness({
    answers: [new IdleTaskReminderAskFailure("http_error", 503), new Error("boom")],
  });
  await h.idle();
  await h.idle();
  assert.deepEqual(h.deliveries, []);
  const calls = h.calls();
  assert.equal(calls[0]?.status, "error");
  assert.equal(calls[0]?.attrs.outcome, "ask_failed");
  assert.equal(calls[0]?.attrs.failure_reason, "http_error");
  assert.equal(calls[0]?.attrs.http_status, 503);
  assert.equal(calls[1]?.attrs.failure_reason, "unknown");

  const throwingFacts = harness({ facts: () => { throw new Error("store"); } });
  assert.doesNotThrow(() => throwingFacts.runtime.onAgentWorkingToIdle(AGENT));
  await throwingFacts.runtime.waitForIdle();
  assert.deepEqual(throwingFacts.asks, []);

  const throwingDelivery = harness({ answers: [sent()], delivery: async () => { throw new Error("write"); } });
  await throwingDelivery.idle();
  assert.equal(throwingDelivery.calls()[0]?.attrs.delivered, "write_failed");
  assert.equal(throwingDelivery.calls()[0]?.status, "error");
  await throwingDelivery.idle();
  assert.equal(throwingDelivery.asks[1]?.freshSession, true, "an undelivered fresh listing is asked for again");
});

test("the ask posts the route body as the agent and checks the answer", async () => {
  const requests: Array<{ agentId: string; pathname: string; body: unknown }> = [];
  let response: Response | null = new Response(JSON.stringify(sent()), { status: 200, headers: { "Content-Type": "application/json" } });
  const ask = createIdleTaskReminderAsk({
    fetchAsAgent: async (agentId, pathname, init) => {
      requests.push({ agentId, pathname, body: init.body });
      assert.equal(init.method, "POST");
      assert.ok(init.signal, "bounded by a timeout");
      return response;
    },
  });
  const answer = await ask(AGENT, { freshSession: true, backgroundTasks: 1 });
  assert.equal(answer.send, true);
  assert.equal(answer.text, NOTICE);
  assert.deepEqual(requests, [{ agentId: AGENT, pathname: "/internal/agent-api/tasks/idle-nudge", body: { freshSession: true, backgroundTasks: 1 } }]);

  response = null;
  await assert.rejects(ask(AGENT, {}), (error: unknown) => error instanceof IdleTaskReminderAskFailure && error.reason === "no_credential");

  response = new Response("{}", { status: 403 });
  await assert.rejects(ask(AGENT, {}), (error: unknown) => error instanceof IdleTaskReminderAskFailure && error.reason === "http_error" && error.httpStatus === 403);

  response = new Response(JSON.stringify({ send: "yes" }), { status: 200 });
  await assert.rejects(ask(AGENT, {}), (error: unknown) => error instanceof IdleTaskReminderAskFailure && error.reason === "invalid_response");

  const unreachable = createIdleTaskReminderAsk({ fetchAsAgent: async () => { throw new TypeError("fetch failed"); } });
  await assert.rejects(unreachable(AGENT, {}), (error: unknown) => error instanceof IdleTaskReminderAskFailure && error.reason === "network");
});

test("#wg-ax:#32: the rules come once per model context: a written notice with them sets rulesShown until the context id changes", async () => {
  let context: string | null = "ctx-1";
  const h = harness({
    answers: [sent({ rules: true }), sent({ rules: false }), sent({ rules: true }), sent({ rules: true })],
    facts: () => facts({ contextId: context }),
  });
  await h.idle();
  await h.idle();
  context = "ctx-2"; // a compaction, a new session or a handoff
  await h.idle();
  context = null; // a runtime that does not report compaction
  await h.idle();
  await h.idle();
  assert.deepEqual(h.asks.map((body) => body.rulesShown === true), [false, true, false, false, false]);
  assert.deepEqual(h.calls().map((call) => call.attrs.rules_shown), [false, true, false, false, false]);
});

test("#wg-ax:#32: a notice that was not written, or came without the rules (an older Server), never counts as shown", async () => {
  let delivery: AgentIdleNoticeDelivery = "busy";
  const h = harness({
    answers: [sent({ rules: true }), sent(), sent({ rules: true })],
    facts: () => facts({ contextId: "ctx-1" }),
    delivery: async () => delivery,
  });
  await h.idle();
  delivery = "written";
  await h.idle();
  await h.idle();
  assert.deepEqual(h.asks.map((body) => body.rulesShown === true), [false, false, false]);
});
