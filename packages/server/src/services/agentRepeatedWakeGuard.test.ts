/**
 * #proj-runtime:#62: the repeated-wake guard's rule, without a server.
 * Turns are driven the way the activity ingest drives them: working (or
 * thinking) frames open a turn, an idle (`online`) frame ends it cleanly.
 */
import assert from "node:assert/strict";

import { REPEATED_WAKE_MAX_GAP_MS, REPEATED_WAKE_THRESHOLD, RepeatedWakeGuard } from "./agentRepeatedWakeGuard";
import { agentRepeatedWakeStoppedNoticeText } from "./agentActionRequiredNoticeService";

const AGENT = "agent-1";

function harness(threshold = REPEATED_WAKE_THRESHOLD) {
  let now = 1_000;
  let progressAt: number | null = null;
  const guard = new RepeatedWakeGuard({ threshold, progressAtMs: async () => progressAt });
  return {
    guard,
    offer(...ids: string[]) {
      guard.noteOffered(AGENT, ids.map((id) => ({ message_id: id, channel_id: "chan-1" })), { drivesLoop: true });
    },
    progress() {
      now += 1;
      progressAt = now;
    },
    tick(ms = 1_000) {
      now += ms;
    },
    /** One turn: working (with `tools` tool starts), then the given end. */
    async turn(opts: { tools?: number; progress?: boolean; end?: "online" | "error" | "offline" } = {}) {
      now += 1_000;
      guard.noteActivity(AGENT, "working", "model_request_started", now);
      for (let i = 0; i < (opts.tools ?? 0); i += 1) guard.noteActivity(AGENT, "working", "tool_started", now);
      if (opts.progress) { now += 1; progressAt = now; }
      now += 1_000;
      const ended = guard.noteActivity(AGENT, opts.end ?? "online", "idle", now);
      return ended ? guard.completeTurn(AGENT, ended) : null;
    },
  };
}

test("trips once, at the threshold, on clean empty turns with the same input (the Grok retry shape)", async () => {
  const h = harness();
  h.offer("m1");
  for (let i = 1; i < REPEATED_WAKE_THRESHOLD; i += 1) assert.equal(await h.turn(), null, `turn ${i}`);
  const trip = await h.turn({ tools: 2 });
  assert.ok(trip);
  assert.equal(trip.emptyTurns, REPEATED_WAKE_THRESHOLD);
  assert.equal(trip.input.messageId, "m1");
  assert.equal(trip.input.excludeId, "m1", "a delivered message drives the loop");
  assert.equal(trip.input.channelId, "chan-1");
  assert.equal(trip.toolStarts, 2);
  assert.equal(await h.turn(), null, "not again in the same streak");
});

test("progress (a write or a read that moved) clears the count", async () => {
  const h = harness(3);
  h.offer("m1");
  await h.turn();
  await h.turn();
  assert.equal(await h.turn({ progress: true }), null);
  await h.turn();
  await h.turn();
  assert.ok(await h.turn(), "counts again from zero after progress");
});

test("progress between two turns counts for the next turn", async () => {
  const h = harness(2);
  h.offer("m1");
  await h.turn();
  h.progress();
  assert.equal(await h.turn(), null, "progress since the previous turn ended clears");
  assert.equal(await h.turn(), null);
  assert.ok(await h.turn());
});

test("a different message starts the count again; the same id again does not (rule B)", async () => {
  const h = harness(3);
  h.offer("m1");
  await h.turn();
  await h.turn();
  h.offer("m1");
  assert.ok(await h.turn(), "re-offering the same id is not new input");

  const quiet = harness(3);
  for (let i = 0; i < 10; i += 1) {
    quiet.offer(`m${i}`);
    assert.equal(await quiet.turn(), null, "an agent ignoring a stream of different messages never accumulates");
  }
});

test("a batch is one input: the same ids in any order are the same, a grown backlog is new", async () => {
  const h = harness(2);
  h.offer("a", "b");
  await h.turn();
  h.offer("b", "a");
  assert.ok(await h.turn());

  const grown = harness(2);
  grown.offer("a", "b");
  await grown.turn();
  grown.offer("a", "b", "c");
  assert.equal(await grown.turn(), null);
  const trip = await grown.turn();
  assert.equal(trip?.input.messageId, "c", "the newest offered message is the one named");
});

test("turns ending in an error or an exit neither count nor clear (rate limits, quota)", async () => {
  const h = harness(3);
  h.offer("m1");
  await h.turn();
  await h.turn();
  for (let i = 0; i < 5; i += 1) assert.equal(await h.turn({ end: "error" }), null);
  assert.equal(await h.turn({ end: "offline" }), null);
  assert.ok(await h.turn(), "the third clean empty turn trips");
});

test("turns before this replica offered anything still count, named by no message (a daemon looping on its own inbox)", async () => {
  const h = harness();
  for (let i = 1; i < REPEATED_WAKE_THRESHOLD; i += 1) assert.equal(await h.turn(), null, `turn ${i}`);
  const trip = await h.turn();
  assert.ok(trip, "trips at the threshold with no frame from this replica");
  assert.equal(trip.input.messageId, null);

  const offered = harness(2);
  await offered.turn();
  offered.offer("m1");
  assert.equal(await offered.turn(), null, "the first real offer starts the count over");
  assert.equal((await offered.turn())?.input.messageId, "m1");
});

test("forget starts over", async () => {
  const h = harness(2);
  h.offer("m1");
  await h.turn();
  h.guard.forget(AGENT);
  h.offer("m1");
  assert.equal(await h.turn(), null, "forgotten: the count restarted");
  assert.ok(await h.turn());
});

test("an idle frame with no open turn, and thinking frames, are handled as turns should be", async () => {
  const h = harness(1);
  h.offer("m1");
  assert.equal(h.guard.noteActivity(AGENT, "online", "idle", 5_000), null, "ready/idle without a turn ends nothing");
  h.guard.noteActivity(AGENT, "thinking", "thinking_started", 6_000);
  const ended = h.guard.noteActivity(AGENT, "online", "idle", 7_000);
  assert.deepEqual(ended, { startedAtMs: 6_000, endedAtMs: 7_000, toolStarts: 0 });
  assert.ok(await h.guard.completeTurn(AGENT, ended!));
});

test("an input offered while the progress mark is read voids that turn's verdict", async () => {
  let release: (value: number | null) => void = () => {};
  const guard = new RepeatedWakeGuard({ threshold: 1, progressAtMs: () => new Promise((resolve) => { release = resolve; }) });
  guard.noteOffered(AGENT, [{ message_id: "m1" }], { drivesLoop: true });
  guard.noteActivity(AGENT, "working", "model_request_started", 1_000);
  const ended = guard.noteActivity(AGENT, "online", "idle", 2_000)!;
  const verdict = guard.completeTurn(AGENT, ended);
  // Verdicts run one at a time (chained), so the mark is read a tick later.
  await new Promise((resolve) => setTimeout(resolve, 0));
  guard.noteOffered(AGENT, [{ message_id: "m2" }], { drivesLoop: true });
  release(null);
  assert.equal(await verdict, null);
});

test("a frame that names no message is always new input; a catch-up backlog is named but not excluded", async () => {
  const h = harness(2);
  h.guard.noteOffered(AGENT, [], { drivesLoop: false });
  await h.turn();
  h.guard.noteOffered(AGENT, [], { drivesLoop: false });
  assert.equal(await h.turn(), null, "a second unnamed wake started the count over");
  const unnamed = await h.turn();
  assert.equal(unnamed?.input.messageId, null);

  const backlog = harness(2);
  backlog.guard.noteOffered(AGENT, [{ message_id: "a" }, { message_id: "b" }], { drivesLoop: false });
  await backlog.turn();
  const trip = await backlog.turn();
  assert.equal(trip?.input.messageId, "b");
  assert.equal(trip?.input.excludeId, null, "an unread backlog keeps flowing (Archer, #62)");
});

test("only an idle frame ends a turn cleanly; a start or a reconnect opens none", async () => {
  const h = harness(1);
  h.offer("m1");
  h.guard.noteActivity(AGENT, "working", "model_request_started", 1_000);
  assert.equal(h.guard.noteActivity(AGENT, "online", "ready", 2_000), null, "ready ends it as neutral");
  h.guard.noteActivity(AGENT, "working", "model_request_started", 3_000);
  assert.equal(h.guard.noteActivity(AGENT, "online", "computer_restarted", 4_000), null, "a Computer restart too");
  h.guard.noteActivity(AGENT, "working", "starting", 5_000);
  h.guard.noteActivity(AGENT, "working", "runtime_starting", 5_500);
  assert.equal(h.guard.noteActivity(AGENT, "online", "idle", 6_000), null, "a start with no work is no turn");
  h.guard.noteActivity(AGENT, "working", "other", 7_000);
  assert.ok(h.guard.noteActivity(AGENT, "online", "other", 8_000), "a legacy daemon's detail-less idle is a clean end");
});

test("a turn long after the previous one starts a new streak (wakes the server does not see, like an hourly reminder)", async () => {
  const h = harness(3);
  h.offer("m1");
  await h.turn();
  await h.turn();
  h.tick(REPEATED_WAKE_MAX_GAP_MS + 1);
  assert.equal(await h.turn(), null, "counts 1, not 3");
  assert.equal(await h.turn(), null);
  assert.ok(await h.turn());
});

test("rearm: a trip whose stop was not delivered trips again on the next empty turn", async () => {
  const h = harness(2);
  h.offer("m1");
  await h.turn();
  assert.ok(await h.turn());
  assert.equal(await h.turn(), null);
  h.guard.rearm(AGENT);
  assert.ok(await h.turn());
});

test("turn verdicts are decided one at a time, in order", async () => {
  const releases: Array<(value: number | null) => void> = [];
  const guard = new RepeatedWakeGuard({ threshold: 2, progressAtMs: () => new Promise((resolve) => { releases.push(resolve); }) });
  guard.noteOffered(AGENT, [{ message_id: "m1" }], { drivesLoop: true });
  guard.noteActivity(AGENT, "working", "other", 1_000);
  const first = guard.completeTurn(AGENT, guard.noteActivity(AGENT, "online", "idle", 2_000)!);
  guard.noteActivity(AGENT, "working", "other", 3_000);
  const second = guard.completeTurn(AGENT, guard.noteActivity(AGENT, "online", "idle", 4_000)!);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(releases.length, 1, "the second waits for the first");
  releases[0]!(null);
  assert.equal(await first, null);
  await new Promise((resolve) => setTimeout(resolve, 0));
  releases[1]!(null);
  assert.ok(await second);
});

test("the owner notice names the message, says it stays unread and how to hand it back", () => {
  const text = agentRepeatedWakeStoppedNoticeText({
    agentName: "grok-bot",
    emptyTurns: 10,
    messageRef: "#general msg=abcd1234",
    excluded: true,
    agentUrl: "https://app.example/s/x/agent/1",
  });
  assert.match(text, /^Raft stopped @grok-bot: it was woken 10 times in a row by the same message and did nothing with it\./);
  assert.match(text, /That message \(#general msg=abcd1234\) stays unread/);
  assert.match(text, /until you start the agent from its page\. New messages still wake it as usual\./);
  assert.match(text, /Agent page: https:\/\/app\.example\/s\/x\/agent\/1$/);
  assert.match(agentRepeatedWakeStoppedNoticeText({ agentName: "a", emptyTurns: 12, messageRef: null, excluded: true, agentUrl: null }), /^Raft stopped @a: .*\nThat message stays unread, /);
  const backlog = agentRepeatedWakeStoppedNoticeText({ agentName: "a", emptyTurns: 12, messageRef: null, excluded: false, agentUrl: null });
  assert.match(backlog, /\nThat message stays unread\. New messages still wake it as usual; if it keeps getting stuck, start it again from its page\.$/);
  assert.doesNotMatch(backlog, /no longer offers/);
});
