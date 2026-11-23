// Focus on the older host (docs/contracts/agent-focus.md, "What the Computer
// does"). A delivery the Server tagged `focused` is written into the model in
// full while the agent's current config has `agentFocus`: at once for an idle
// agent, in the busy notice's own write for a busy one, and at a hold release
// or a turn end. A write that starts a turn is reported (`agent:model-seen`)
// on the first model event after it. A write into a turn in flight has no
// accept signal: its body stays queued, unconfirmed, and is consumed,
// acknowledged and reported only once that turn has ended with no rejection.
// With `agentFocus` not true the tag is ignored and every output is today's,
// byte for byte.
//
// RED proof: drop the union in deliverInboxUpdateViaStdin and "idle" writes a
// notice; drop the body branch in sendStdinNotification and "busy" writes a
// notice only; drop `focusedBodies.length > 0` from the breakthrough and the
// Codex test writes nothing; drop the filter in askInboxRows and the ask names
// the focused message; consume a busy body at the write and "a rejection
// before the turn end" loses it; confirm at the turn end without the wait and
// "a rejection just after the turn end" reports it.
// Helpers are slimmed copies per this repo's APM test convention (see
// agentProcessManager.inboxNoticeRows.test.ts).

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { afterEach, test, vi } from "vitest";
import { ATTENTION_HINT_COPY_VERSION, ATTENTION_HINT_SCHEMA, asAxSurfaceText, type AgentApiInboxRowsResponse, type AgentConfig, type AgentMessage, type AxSurfaceText, type MachineToServerMessage } from "@botiverse/raft-shared";
import { AgentProcessManager, FOCUS_BODY_CONFIRM_GRACE_MS } from "./agentProcessManager";
import { setDaemonFetchImplForTests } from "./daemonFetch";
import type { InboxRowsFetchAsAgent, InboxRowsTarget } from "./inboxRowsAsk";
import type { RuntimeDriver, SpawnContext, SpawnResult, ParsedEvent } from "./drivers/index";
import { releaseAgentManagerForTests } from "./testing/agentManagerTeardown";

class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  readonly stdinWrites: string[] = [];
  stdin = { write: (chunk: string) => { this.stdinWrites.push(chunk); return true; } };
  kills = 0;

  get killed(): boolean {
    return this.kills > 0;
  }

  kill(): boolean {
    this.kills += 1;
    this.emit("exit", 143, "SIGTERM");
    this.emit("close", 143, "SIGTERM");
    return true;
  }
}

class FakeClaudeDriver implements RuntimeDriver {
  readonly acceptsStdinDuringCompaction = true;
  readonly id: string;
  readonly lifecycle = { kind: "persistent", stdin: "direct", inFlightWake: "steer" } as const;
  readonly communication = { chat: "slock_cli", runtimeControl: "none" } as const;
  readonly session = { recovery: "resume_or_fresh", compaction: "reported", compactionFailure: "does_not_stick" } as const;
  readonly model = { detectedModelsVerifiedAs: "launchable" } as const;
  readonly supportsStdinNotification = true;
  readonly busyDeliveryMode = "direct" as const;
  readonly liveSessionReadyAt: "session_init" | "turn_end";
  readonly supportsNativeStandingPrompt = true;
  readonly terminateProcessOnTurnEnd = false;
  readonly supportsSubagents = false;
  readonly spawnCalls: SpawnContext[] = [];
  readonly processes: FakeChildProcess[] = [];
  readonly parsedLines = new Map<string, ParsedEvent[]>();
  /** The runtime refuses every input (the write fails). */
  refuseInput = false;

  constructor(options: { liveSessionReadyAt?: "session_init" | "turn_end"; id?: string } = {}) {
    this.id = options.id ?? "claude";
    this.liveSessionReadyAt = options.liveSessionReadyAt ?? "turn_end";
  }

  spawn(ctx: SpawnContext): SpawnResult {
    this.spawnCalls.push(ctx);
    const child = new FakeChildProcess();
    this.processes.push(child);
    return { process: child as unknown as ChildProcess };
  }

  parseLine(line: string): ParsedEvent[] {
    return this.parsedLines.get(line) ?? [];
  }

  /** The session each input was written to rides along, so a test can tell which session got it. */
  encodeStdinMessage(text: string, sessionId: string | null): string | null {
    return text && !this.refuseInput ? JSON.stringify({ text, sessionId }) : null;
  }

  buildSystemPrompt(): AxSurfaceText {
    return asAxSurfaceText("claude standing prompt");
  }
}

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "claude-agent",
    displayName: "Claude Agent",
    description: "test agent",
    model: "sonnet",
    runtime: "claude",
    reasoningEffort: null,
    envVars: null,
    sessionId: null,
    serverUrl: "http://localhost:3001",
    authToken: "sk_machine_test",
    agentCredentialKey: "sk_agent_test",
    // No credential id: a stop would revoke it over the network.
    agentCredentialId: null,
    enabledApps: [],
    ...overrides,
  };
}

type RowsCall = { agentId: string; targets: InboxRowsTarget[]; signal: AbortSignal | undefined; respond: (response: Response | null) => void };
type Ctx = {
  driver: FakeClaudeDriver;
  manager: AgentProcessManager;
  events: Array<{ name: string; attrs: Record<string, unknown> }>;
  sent: MachineToServerMessage[];
  homeDir: string;
  /** Every `POST /inbox/rows` the manager made, answered by the test. */
  rowsCalls: RowsCall[];
};

/** A restart mints the new launch's runner credential; nothing else may leave the process. */
async function runnerCredentialFetch(target: unknown, init?: RequestInit): Promise<Response> {
  const input = String(target);
  const method = init?.method ?? "GET";
  if (input.includes("/internal/computer/runners/") && method === "POST") return Response.json({ apiKey: "sk_agent_test_2", credentialId: "test-credential" }, { status: 201 });
  if (input.includes("/internal/computer/runners/") && method === "DELETE") return new Response(null, { status: 204 });
  throw new Error(`Unexpected request: ${method} ${input}`);
}

async function withManager(fn: (ctx: Ctx) => Promise<void>, driver = new FakeClaudeDriver()): Promise<void> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-focus-test-"));
  const sent: MachineToServerMessage[] = [];
  const rowsCalls: RowsCall[] = [];
  const inboxRowsFetchAsAgent: InboxRowsFetchAsAgent = (agentId, _pathname, init) => new Promise((resolve) => {
    rowsCalls.push({ agentId, targets: (init.body as { targets: InboxRowsTarget[] }).targets, signal: init.signal, respond: resolve });
  });
  const manager = new AgentProcessManager(
    (msg) => sent.push(msg),
    "sk_machine_test",
    { dataDir, serverUrl: "https://daemon.example.com", driverResolver: () => driver, runtimeSessionHomeDir: dataDir, inboxRowsFetchAsAgent },
  );
  setDaemonFetchImplForTests(runnerCredentialFetch as never);
  const events: Ctx["events"] = [];
  const recordDaemonEvent = (manager as any).recordDaemonEvent.bind(manager);
  (manager as any).recordDaemonEvent = (name: string, attrs: Record<string, unknown> = {}, ...rest: unknown[]) => {
    events.push({ name, attrs });
    return recordDaemonEvent(name, attrs, ...rest);
  };
  try {
    await fn({ driver, manager, events, sent, homeDir: dataDir, rowsCalls });
  } finally {
    vi.useRealTimers();
    await releaseAgentManagerForTests(manager);
    setDaemonFetchImplForTests(undefined);
    await rm(dataDir, { recursive: true, force: true });
  }
}

afterEach(() => { vi.useRealTimers(); });

const flush = () => new Promise((resolve) => setImmediate(resolve));
async function waitFor(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
/** Only the timers the hold, the ask and the busy notice use; the rest of the manager keeps real time. */
const fakeTimers = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });

const SESSION = "session-agent-1";
const ROWS_ON = { inboxItems: true, inboxNoticeServerRows: true } as const;

/** An idle agent on a session that takes deliveries; the Server advertises the rows route unless told otherwise. */
async function startIdle(ctx: Ctx, config: Partial<AgentConfig>, options: { capable?: boolean } = {}) {
  const dir = path.join(ctx.homeDir, ".claude", "projects", "-workspace-agent");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${SESSION}.jsonl`), `${JSON.stringify({ type: "assistant", timestamp: new Date().toISOString() })}\n`);
  ctx.manager.setServerInboxRowsCapable(options.capable ?? true);
  await ctx.manager.startAgent("agent-1", makeConfig({ sessionId: SESSION, ...config }), undefined, undefined, undefined, "launch-1");
  const ap = (ctx.manager as any).agents.get("agent-1");
  ap.sessionId = SESSION;
  ap.sessionReadyForDelivery = true;
  (ctx.manager as any).commitApmIdleState("agent-1", ap, true);
  const child = ctx.driver.processes.at(-1)!;
  return { ap, child, written: child.stdinWrites.length };
}

const GENERAL = "11111111-aaaa-4bbb-8ccc-000000000001";
const RANDOM = "11111111-aaaa-4bbb-8ccc-000000000002";

function message(seq: number, channel: { id: string; name: string } = { id: GENERAL, name: "general" }): AgentMessage {
  return {
    seq,
    message_id: `msg-${seq}`,
    channel_id: channel.id,
    channel_name: channel.name,
    channel_type: "channel",
    sender_name: "someone",
    sender_type: "human",
    content: `hello ${seq}`,
    timestamp: "2026-11-20T00:00:00.000Z",
  } as AgentMessage;
}
const RANDOM_CHANNEL = { id: RANDOM, name: "random" };

type ServerRow = AgentApiInboxRowsResponse["rows"][number];
const serverRow = (channelId: string, target: string, unread: number): ServerRow => ({
  channelId,
  target,
  kind: "conversation",
  unread,
  latestSender: { name: "someone", type: "user" },
  preview: "the Server's preview",
  previewTruncated: false,
  firstUnreadAt: null,
  latestAt: null,
  preLaunch: false,
});
const answer = (rows: ServerRow[], otherUnread = { conversations: 2, messages: 9, mentions: 0, dms: 0 }) =>
  new Response(JSON.stringify({ rows, behind: 0, otherUnread } satisfies AgentApiInboxRowsResponse), { status: 200, headers: { "content-type": "application/json" } });
const failure = (status: number) => new Response(JSON.stringify({ error: "no" }), { status, headers: { "content-type": "application/json" } });

/** The inputs written to the agent's process since `from`, with the session each was written to. */
const writes = (child: FakeChildProcess, from: number) => child.stdinWrites.slice(from).map((write) => JSON.parse(write) as { text: string; sessionId: string | null });
const named = (ctx: Ctx, name: string) => ctx.events.filter((event) => event.name === name).map((event) => event.attrs);
const routed = (ctx: Ctx, outcome: string) => named(ctx, "daemon.agent.delivery.routed").filter((attrs) => attrs.outcome === outcome);
const isIdle = (ctx: Ctx, ap: unknown) => (ctx.manager as any).isApmIdle(ap) as boolean;

const THREAD = "11111111-aaaa-4bbb-8ccc-000000000003";
const OTHER_THREAD = "11111111-aaaa-4bbb-8ccc-000000000004";
const FOCUS_ON = { inboxItems: true, agentFocus: true } as const;

/** A reply in the thread `#general:abcd1234` (or another one), as the Server delivers it. */
function threadMessage(seq: number, overrides: Partial<AgentMessage> = {}): AgentMessage {
  return {
    ...message(seq),
    channel_id: THREAD,
    channel_name: "thread-abcd1234",
    channel_type: "thread",
    parent_channel_name: "general",
    parent_channel_type: "channel",
    ...overrides,
  } as AgentMessage;
}
const focused = (seq: number, overrides: Partial<AgentMessage> = {}) => threadMessage(seq, { focused: true, ...overrides });
const otherThread = { channel_id: OTHER_THREAD, channel_name: "thread-eeee5555" } as const;

const bodyLine = (seq: number, target = "#general:abcd1234") => `[target=${target} msg=msg-${seq} time=2026-11-20 00:00:00Z type=human] @someone: hello ${seq}`;
const TRAILER = "\n\nRespond as appropriate. Complete all your work before stopping.\n";
const modelSeen = (ctx: Ctx) => ctx.sent.filter((msg) => msg.type === "agent:model-seen") as Array<Extract<MachineToServerMessage, { type: "agent:model-seen" }>>;
/** The bodies written into a turn in flight and not confirmed yet. */
const unconfirmed = (ap: any) => (ap.unconfirmedFocusBodies ?? []).map((entry: { message: AgentMessage }) => entry.message.message_id) as string[];
const steerRejected: ParsedEvent = { kind: "delivery_error", message: "steer refused", requestMethod: "turn/steer", source: "pi_sdk_response", code: "runtime.delivery_error" };
const busy = (ctx: Ctx, ap: unknown) => (ctx.manager as any).commitApmIdleState("agent-1", ap, false);
const fireBusyNotice = (ctx: Ctx) => (ctx.manager as any).sendStdinNotification("agent-1") as boolean;
let lineNo = 0;
/** The runtime reports these events on its output, as one line. */
function emit(ctx: Ctx, child: FakeChildProcess, events: ParsedEvent[]): void {
  const line = `line-${lineNo += 1}`;
  ctx.driver.parsedLines.set(line, events);
  child.stdout.emit("data", Buffer.from(`${line}\n`));
}
const trackedContext = (ap: any, occurrenceId: string, messageId: string, seen: { acks: number; errors: string[] }) => ({
  deliveryId: occurrenceId,
  mentionDelivery: { occurrenceId, messageId, launchId: ap.launchId, sessionId: ap.sessionId },
  onMentionAck: () => { seen.acks += 1; },
  onMentionTerminalError: (code: string) => { seen.errors.push(code); },
}) as any;

test("idle: a focused message is written in full at once, leaves the inbox, and is reported after the first model event", async () => {
  await withManager(async (ctx) => {
    const { ap, child, written } = await startIdle(ctx, FOCUS_ON);
    assert.equal(await ctx.manager.deliverMessage("agent-1", focused(1)), true);
    const out = writes(child, written);
    assert.equal(out.length, 1);
    assert.ok(out[0]!.text.startsWith(`New message received:\n\n${bodyLine(1)}${TRAILER}`), out[0]!.text);
    assert.equal(out[0]!.text.includes("[Raft inbox notice"), false, "no notice: nothing else waits");
    assert.equal(out[0]!.sessionId, SESSION);
    assert.deepEqual(ap.inbox, [], "shown, so not offered again");
    assert.equal(isIdle(ctx, ap), false, "the write started a turn");
    assert.equal(routed(ctx, "stdin_idle_delivery").length, 1);
    assert.equal((ctx.manager as any).isVisibleMessageModelSeen("agent-1", "#general:abcd1234", focused(1)), true);

    assert.equal(modelSeen(ctx).length, 0, "not reported before the runtime shows it took the input");
    emit(ctx, child, [{ kind: "text", text: "on it" }]);
    emit(ctx, child, [{ kind: "text", text: "again" }]);
    assert.deepEqual(modelSeen(ctx).map((report) => [report.agentId, report.launchId, report.items]), [["agent-1", "launch-1", [{ channelId: THREAD, seqs: [1] }]]], "reported once");

    const [event] = named(ctx, "daemon.agent.stdin_delivery").filter((attrs) => attrs.outcome === "written");
    assert.equal(event!.focused_bodies, 1);
    assert.equal(event!.focused_bytes_count, Buffer.byteLength("hello 1", "utf8"));
    assert.equal(ap.notifications.isNoticeHoldArmed, false, "a body is no pure notice");
  });
});

// Rendered by the code before this change for the same message without the tag, pinned byte for byte.
const TODAY_THREAD_NOTICE = (seq: number, pending = 1) => [
  "[Raft inbox notice:",
  `Inbox update: ${pending} message${pending === 1 ? "" : "s"} pending your read across all conversations; 1 changed target`,
  "#general:abcd1234 · 1 unread · latest @someone",
  `  "hello ${seq}" (preview)`,
  "  read: raft inbox read --target \"#general:abcd1234\"",
  "]",
].join("\n");

for (const [title, config] of [
  ["agentFocus absent", { inboxItems: true }],
  ["agentFocus false", { inboxItems: true, agentFocus: false }],
] as const) {
  test(`${title}: the tag is ignored, idle and busy, and the output is today's notice byte for byte`, async () => {
    await withManager(async (ctx) => {
      const { ap, child, written } = await startIdle(ctx, config);
      const tagged = focused(1, { focus_change: { reason: "mentioned", focused: ["#general:abcd1234"], unfocused: [] } });
      assert.equal(await ctx.manager.deliverMessage("agent-1", tagged), true);
      assert.deepEqual(writes(child, written).map((write) => write.text), [TODAY_THREAD_NOTICE(1)]);
      assert.deepEqual(ap.inbox.map((m: AgentMessage) => m.message_id), ["msg-1"], "still unread, as any noticed message");

      assert.equal(await ctx.manager.deliverMessage("agent-1", focused(2)), true);
      assert.equal(fireBusyNotice(ctx), true);
      assert.equal(writes(child, written)[1]!.text, TODAY_THREAD_NOTICE(2, 2));

      emit(ctx, child, [{ kind: "text", text: "on it" }]);
      assert.equal(modelSeen(ctx).length, 0, "a notice is not a body: nothing reported");
      for (const name of ["daemon.agent.stdin_delivery", "daemon.agent.stdin_notification", "daemon.agent.inbox_update.pushed"]) {
        for (const attrs of named(ctx, name)) {
          assert.equal("focused_bodies" in attrs || "focused_bytes_count" in attrs, false, `${name} keeps its shape`);
        }
      }
    });
  });
}

test("idle: the same bytes as today for an untagged message while agentFocus is on", async () => {
  await withManager(async (ctx) => {
    const { child, written } = await startIdle(ctx, FOCUS_ON);
    assert.equal(await ctx.manager.deliverMessage("agent-1", threadMessage(1)), true);
    assert.deepEqual(writes(child, written).map((write) => write.text), [TODAY_THREAD_NOTICE(1)]);
  });
});

test("idle: the focus_change line is printed above the message that carries it", async () => {
  await withManager(async (ctx) => {
    const { child, written } = await startIdle(ctx, FOCUS_ON);
    const change = { reason: "mentioned", focused: ["#general:abcd1234"], unfocused: ["#random:11112222"] } as const;
    assert.equal(await ctx.manager.deliverMessage("agent-1", focused(1, { mentioned: true, focus_change: { ...change, focused: [...change.focused], unfocused: [...change.unfocused] } })), true);
    const text = writes(child, written)[0]!.text;
    assert.ok(text.startsWith([
      "New message received:",
      "",
      "[Raft focused #general:abcd1234 because you were @mentioned there. New messages there now arrive in full. To make room, Raft unfocused #random:11112222. To undo: raft unfocus \"#general:abcd1234\"]",
      "",
      "[target=#general:abcd1234 msg=msg-1 time=2026-11-20 00:00:00Z type=human] @someone: hello 1",
    ].join("\n")), text);
  });
});

test("busy: a mixed batch goes as one write, the focused message in full and the rest as its notice", async () => {
  await withManager(async (ctx) => {
    const { ap, child, written } = await startIdle(ctx, FOCUS_ON);
    busy(ctx, ap);
    assert.equal(await ctx.manager.deliverMessage("agent-1", message(1)), true);
    assert.equal(await ctx.manager.deliverMessage("agent-1", focused(2)), true);
    assert.equal(writes(child, written).length, 0, "batched, not written on arrival");
    assert.equal(ap.notifications.pendingCount, 2);
    assert.equal(fireBusyNotice(ctx), true);

    const out = writes(child, written);
    assert.equal(out.length, 1, "one write");
    assert.equal(out[0]!.text.startsWith([
      "New message received:",
      "",
      bodyLine(2),
      "",
      "[Raft inbox notice:",
      "Inbox update: 1 message pending your read across all conversations; 1 changed target",
      "#general · 1 unread · latest @someone",
      "  \"hello 1\" (preview)",
      "  read: raft inbox read --target \"#general\"",
      "]",
      "",
      "Respond as appropriate. Complete all your work before stopping.",
      "",
    ].join("\n")), true, out[0]!.text);
    assert.deepEqual(ap.inbox.map((m: AgentMessage) => m.message_id), ["msg-1", "msg-2"], "the body waits in the inbox until it is confirmed");
    assert.deepEqual(unconfirmed(ap), ["msg-2"]);
    assert.equal(ap.notifications.hasContributedMessage(message(1), SESSION), true, "the rest was told by the notice");
    assert.equal(ap.notifications.hasContributedMessage(focused(2), SESSION), true, "and the body is told too: not written or listed again");
    assert.equal(ap.notifications.isNoticeHoldArmed, false);
    assert.equal(ap.notifications.pendingCount, 0, "no notice debt while it waits");

    // The turn in flight goes on: its events say nothing about a write it may not have taken.
    emit(ctx, child, [{ kind: "text", text: "still on the earlier work" }]);
    assert.equal(modelSeen(ctx).length, 0, "not reported by an event of the turn in flight");
    assert.equal(fireBusyNotice(ctx), false, "and not written again");
    fakeTimers();
    emit(ctx, child, [{ kind: "turn_end", sessionId: SESSION }]);
    assert.equal(modelSeen(ctx).length, 0, "not at the turn end itself: a rejection may still arrive");
    assert.equal(writes(child, written).length, 1, "the turn end's flush does not deliver it a second time");
    await vi.advanceTimersByTimeAsync(FOCUS_BODY_CONFIRM_GRACE_MS);
    assert.deepEqual(modelSeen(ctx).map((report) => report.items), [[{ channelId: THREAD, seqs: [2] }]], "only the body is reported, once the turn ended with no rejection");
    assert.deepEqual(ap.inbox.map((m: AgentMessage) => m.message_id), ["msg-1"], "confirmed: out of the inbox; the noticed one stays");
    assert.deepEqual(unconfirmed(ap), []);
    assert.deepEqual(named(ctx, "daemon.agent.focus_body.confirmed").map((attrs) => [attrs.trigger, attrs.messages_count]), [["turn_end", 1]]);
    await vi.advanceTimersByTimeAsync(5_000);
    emit(ctx, child, [{ kind: "text", text: "later" }]);
    assert.equal(modelSeen(ctx).length, 1, "reported once");
    assert.equal(writes(child, written).length, 1);
    const [event] = named(ctx, "daemon.agent.stdin_notification").filter((attrs) => attrs.outcome === "written");
    assert.deepEqual([event!.focused_bodies, event!.focused_bytes_count], [1, 7]);
  });
});

test("busy: after a write that was only bodies, nothing more is written (no empty notice now or at the turn end)", async () => {
  await withManager(async (ctx) => {
    const { ap, child, written } = await startIdle(ctx, FOCUS_ON);
    busy(ctx, ap);
    assert.equal(await ctx.manager.deliverMessage("agent-1", focused(1)), true);
    assert.equal(await ctx.manager.deliverMessage("agent-1", focused(2, otherThread)), true);
    assert.equal(fireBusyNotice(ctx), true);
    const out = writes(child, written);
    assert.equal(out.length, 1);
    assert.ok(out[0]!.text.startsWith(`New messages received:\n\n${bodyLine(1)}\n${bodyLine(2, "#general:eeee5555")}${TRAILER}`), out[0]!.text);
    assert.equal(out[0]!.text.includes("[Raft inbox notice"), false);
    assert.deepEqual(unconfirmed(ap), ["msg-1", "msg-2"]);
    assert.equal(ap.notifications.pendingCount, 0);

    assert.equal(fireBusyNotice(ctx), false);
    fakeTimers();
    emit(ctx, child, [{ kind: "text", text: "on it" }, { kind: "turn_end", sessionId: SESSION }]);
    assert.equal(writes(child, written).length, 1, "the turn end's flush finds them told: not delivered twice, no empty notice");
    await vi.advanceTimersByTimeAsync(FOCUS_BODY_CONFIRM_GRACE_MS);
    assert.equal(writes(child, written).length, 1, "nothing after it");
    assert.deepEqual(ap.inbox, []);
    assert.deepEqual(modelSeen(ctx).flatMap((report) => report.items), [{ channelId: THREAD, seqs: [1] }, { channelId: OTHER_THREAD, seqs: [2] }]);
  });
});

test("busy, Codex: a batch with a focused body goes past an outstanding notice and tells what it held", async () => {
  await withManager(async (ctx) => {
    const { ap, child, written } = await startIdle(ctx, FOCUS_ON);
    busy(ctx, ap);
    assert.equal(await ctx.manager.deliverMessage("agent-1", message(1)), true);
    assert.equal(fireBusyNotice(ctx), true);
    assert.equal(ap.notifications.isNoticeHoldArmed, true, "a pure notice is outstanding");
    assert.equal(await ctx.manager.deliverMessage("agent-1", message(2, RANDOM_CHANNEL)), true);
    assert.equal(fireBusyNotice(ctx), false, "an ordinary message waits behind it");
    assert.equal(writes(child, written).length, 1);

    // A plain thread reply (no mention, no DM): it goes because it is shown in full.
    assert.equal(await ctx.manager.deliverMessage("agent-1", focused(3)), true);
    assert.equal(fireBusyNotice(ctx), true);
    const out = writes(child, written);
    assert.equal(out.length, 2);
    assert.ok(out[1]!.text.startsWith(`New message received:\n\n${bodyLine(3)}\n\n[Raft inbox notice:`), out[1]!.text);
    assert.ok(out[1]!.text.includes("#random · 1 unread"), "the held message is told in the same write");
    assert.equal(out[1]!.text.includes("#general ·"), false, "the one already told is not repeated");
    const event = named(ctx, "daemon.agent.stdin_notification").filter((attrs) => attrs.outcome === "written").at(-1)!;
    assert.equal(event.notice_hold_breakthrough, true);
    assert.equal(event.held_notice_debt, 1, "the event says what the write covered");
    assert.equal(event.focused_bodies, 1);
    // Afterwards: the earlier pure notice is still outstanding, and nothing is owed behind it.
    assert.equal(ap.notifications.isNoticeHoldArmed, true);
    assert.equal(ap.notifications.heldNoticeDebt, 0, "what was held has been told");
    assert.equal(ap.notifications.pendingCount, 0);
    assert.equal(ap.notifications.hasContributedMessage(message(2, RANDOM_CHANNEL), SESSION), true);
    assert.equal(fireBusyNotice(ctx), false, "nothing left to tell");
    // The hold ends (the agent read): no debt comes back for rows already told.
    assert.equal((ctx.manager as any).releaseNoticeHold("agent-1", ap, "inbox_read"), 0);
    assert.equal(ap.notifications.pendingCount, 0);
  }, new FakeClaudeDriver({ id: "codex" }));
});

test("busy, Codex: with agentFocus off the same tagged thread reply waits behind the outstanding notice, as today", async () => {
  await withManager(async (ctx) => {
    const { ap, child, written } = await startIdle(ctx, { inboxItems: true });
    busy(ctx, ap);
    assert.equal(await ctx.manager.deliverMessage("agent-1", message(1)), true);
    assert.equal(fireBusyNotice(ctx), true);
    assert.equal(await ctx.manager.deliverMessage("agent-1", focused(3)), true);
    assert.equal(fireBusyNotice(ctx), false);
    assert.equal(writes(child, written).length, 1);
    assert.equal(named(ctx, "daemon.agent.stdin_notification").at(-1)!.outcome, "suppressed_notice_outstanding");
  }, new FakeClaudeDriver({ id: "codex" }));
});

test("busy: a tracked mention written in full is not acked at the write; it is acked once, when its turn has ended", async () => {
  await withManager(async (ctx) => {
    const { ap, child, written } = await startIdle(ctx, FOCUS_ON);
    busy(ctx, ap);
    const seen = { acks: 0, errors: [] as string[] };
    assert.equal(await ctx.manager.deliverMessage("agent-1", focused(1, { mentioned: true }), trackedContext(ap, "occ-1", "msg-1", seen)), true);
    assert.equal(routed(ctx, "queued_busy_mention").length, 1);
    assert.equal(fireBusyNotice(ctx), true);
    assert.ok(writes(child, written)[0]!.text.includes(bodyLine(1)), "in full");
    assert.equal((ctx.manager as any).trackedMentionDeliveries.get("occ-1").state, "pending", "the write alone settles nothing");
    assert.equal(seen.acks, 0);

    fakeTimers();
    emit(ctx, child, [{ kind: "text", text: "on it" }, { kind: "turn_end", sessionId: SESSION }]);
    assert.equal(seen.acks, 1, "acked at the turn end, as a mention told by a notice is");
    await vi.advanceTimersByTimeAsync(FOCUS_BODY_CONFIRM_GRACE_MS);
    assert.equal((ctx.manager as any).trackedMentionDeliveries.get("occ-1").state, "drained");
    assert.deepEqual([seen.acks, seen.errors], [1, []], "exactly one ack");
    assert.deepEqual(modelSeen(ctx).flatMap((report) => report.items), [{ channelId: THREAD, seqs: [1] }]);
  });
});

test("turn end: a focused message still queued is flushed in full with the notice of the rest", async () => {
  await withManager(async (ctx) => {
    const { ap, child, written } = await startIdle(ctx, FOCUS_ON);
    busy(ctx, ap);
    assert.equal(await ctx.manager.deliverMessage("agent-1", message(1)), true);
    assert.equal(await ctx.manager.deliverMessage("agent-1", focused(2)), true);
    // The turn ends before the busy notice's timer fires.
    emit(ctx, child, [{ kind: "turn_end", sessionId: SESSION }]);
    await flush();
    const out = writes(child, written);
    assert.equal(out.length, 1);
    assert.equal(named(ctx, "daemon.agent.stdin_notification").filter((attrs) => attrs.outcome === "written").length, 0, "not the busy notice: the turn-end flush");
    assert.ok(out[0]!.text.startsWith(`New message received:\n\n${bodyLine(2)}\n\n[Raft inbox notice:\nInbox update: 1 message pending`), out[0]!.text);
    assert.ok(out[0]!.text.includes("#general · 1 unread"));
    assert.deepEqual(ap.inbox.map((m: AgentMessage) => m.message_id), ["msg-1"]);
    assert.equal(modelSeen(ctx).length, 0, "the turn that ended did not see it");
    emit(ctx, child, [{ kind: "text", text: "reading" }]);
    assert.deepEqual(modelSeen(ctx).flatMap((report) => report.items), [{ channelId: THREAD, seqs: [2] }]);
  });
});

test("rows ask, idle: a batch that is only focused messages asks nothing and skips the hold", async () => {
  await withManager(async (ctx) => {
    const { ap, child, written } = await startIdle(ctx, { ...ROWS_ON, agentFocus: true });
    assert.equal(await ctx.manager.deliverMessage("agent-1", focused(1)), true);
    assert.equal(ctx.rowsCalls.length, 0, "nothing to ask: no row is printed");
    assert.equal(ap.pendingIdleInboxHold, null, "not held");
    assert.equal(routed(ctx, "held_idle_inbox_rows").length, 0);
    const out = writes(child, written);
    assert.equal(out.length, 1, "written at once");
    assert.ok(out[0]!.text.startsWith(`New message received:\n\n${bodyLine(1)}${TRAILER}`), out[0]!.text);
  });
});

test("rows ask, idle: the same tagged message is held and asked about while agentFocus is off", async () => {
  await withManager(async (ctx) => {
    const { ap, child, written } = await startIdle(ctx, ROWS_ON);
    assert.equal(await ctx.manager.deliverMessage("agent-1", focused(1)), true);
    assert.deepEqual(ctx.rowsCalls.map((call) => call.targets), [[{ channelId: THREAD, newestSeq: 1 }]]);
    assert.ok(ap.pendingIdleInboxHold);
    assert.equal(writes(child, written).length, 0);
  });
});

test("rows ask, idle hold: a focused message joins a hold that exists; the release writes it in full with the numbered notice of the rest", async () => {
  await withManager(async (ctx) => {
    const { ap, child, written } = await startIdle(ctx, { ...ROWS_ON, agentFocus: true });
    assert.equal(await ctx.manager.deliverMessage("agent-1", message(1)), true);
    const hold = ap.pendingIdleInboxHold;
    assert.ok(hold);
    const seen = { acks: 0, errors: [] as string[] };
    assert.equal(await ctx.manager.deliverMessage("agent-1", focused(2, { mentioned: true }), trackedContext(ap, "occ-2", "msg-2", seen)), true);
    assert.equal(ap.pendingIdleInboxHold, hold, "joined, not delivered past it");
    assert.equal(writes(child, written).length, 0);
    assert.deepEqual(ctx.rowsCalls.map((call) => call.targets), [[{ channelId: GENERAL, newestSeq: 1 }]], "the focused message adds no ask");
    assert.equal(seen.acks, 0);

    ctx.rowsCalls[0]!.respond(answer([serverRow(GENERAL, "#general", 7)]));
    await flush();
    const out = writes(child, written);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.text.startsWith([
      "New message received:",
      "",
      bodyLine(2),
      "",
      "[Raft inbox notice: new since your last notice, in 1 target",
      "#general · 7 unread · latest @someone",
      "  \"the Server's preview\" (preview)",
      "  read: raft inbox read --target \"#general\"",
      "Older unread: 9 messages in 2 targets. List everything: raft inbox check",
      "]",
      "",
      "Respond as appropriate.",
    ].join("\n")), true, out[0]!.text);
    assert.deepEqual(ap.inbox.map((m: AgentMessage) => m.message_id), ["msg-1"]);
    assert.equal(seen.acks, 1, "the mention is acked with the write, exactly once (the consume and the release both settle it)");
    assert.deepEqual(seen.errors, []);
    emit(ctx, child, [{ kind: "text", text: "on it" }]);
    assert.deepEqual(modelSeen(ctx).flatMap((report) => report.items), [{ channelId: THREAD, seqs: [2] }]);
  });
});

test("rows ask, busy: across a focus change the unfocused message of the conversation is still asked about and numbered", async () => {
  await withManager(async (ctx) => {
    const { ap, child, written } = await startIdle(ctx, { ...ROWS_ON, agentFocus: true });
    busy(ctx, ap);
    // The thread was focused between the two messages: the first prints as a row, the second in full.
    assert.equal(await ctx.manager.deliverMessage("agent-1", threadMessage(5)), true);
    assert.equal(await ctx.manager.deliverMessage("agent-1", focused(6)), true);
    assert.equal(await ctx.manager.deliverMessage("agent-1", focused(7, otherThread)), true);
    assert.deepEqual(ctx.rowsCalls.map((call) => call.targets), [[{ channelId: THREAD, newestSeq: 5 }]], "by message: seq 5 only, and not the other thread at all");
    ctx.rowsCalls[0]!.respond(answer([serverRow(THREAD, "#general:abcd1234", 1)]));
    await flush();
    assert.equal(ctx.rowsCalls.length, 1, "no follow-up for the focused ones");

    assert.equal(fireBusyNotice(ctx), true);
    const text = writes(child, written)[0]!.text;
    assert.equal(text.startsWith([
      "New messages received:",
      "",
      bodyLine(6),
      bodyLine(7, "#general:eeee5555"),
      "",
      "[Raft inbox notice: new since your last notice, in 1 target",
      "#general:abcd1234 · 1 unread · latest @someone",
    ].join("\n")), true, text);
    assert.ok(text.includes("Older unread: 9 messages in 2 targets."), "the asked set is the listed set, so the answer covers the notice");
    assert.deepEqual(unconfirmed(ap), ["msg-6", "msg-7"]);
  });
});

test("read report: a body written to a session the process then leaves is not reported", async () => {
  await withManager(async (ctx) => {
    const { ap, child, written } = await startIdle(ctx, FOCUS_ON);
    assert.equal(await ctx.manager.deliverMessage("agent-1", focused(1)), true);
    assert.equal(writes(child, written)[0]!.sessionId, SESSION);
    emit(ctx, child, [{ kind: "session_init", sessionId: "session-other" }]);
    assert.equal(ap.sessionId, "session-other");
    emit(ctx, child, [{ kind: "text", text: "a new session" }]);
    assert.equal(modelSeen(ctx).length, 0);
    assert.deepEqual(named(ctx, "daemon.agent.model_seen.dropped").map((attrs) => [attrs.reason, attrs.messages_count]), [["session_changed", 1]]);
  });
});

test("read report: the same session reported again keeps the pending report", async () => {
  await withManager(async (ctx) => {
    const { child } = await startIdle(ctx, FOCUS_ON);
    assert.equal(await ctx.manager.deliverMessage("agent-1", focused(1)), true);
    emit(ctx, child, [{ kind: "session_init", sessionId: SESSION }]);
    emit(ctx, child, [{ kind: "text", text: "on it" }]);
    assert.deepEqual(modelSeen(ctx).flatMap((report) => report.items), [{ channelId: THREAD, seqs: [1] }]);
    assert.equal(named(ctx, "daemon.agent.model_seen.dropped").length, 0);
  });
});

// A write into a turn in flight: confirmed only once that turn has ended with no rejection.

test("busy confirm: a rejection before the turn end puts the body back in the queue, reports nothing, and the turn end tells it again", async () => {
  await withManager(async (ctx) => {
    const { ap, child, written } = await startIdle(ctx, FOCUS_ON);
    busy(ctx, ap);
    const seen = { acks: 0, errors: [] as string[] };
    assert.equal(await ctx.manager.deliverMessage("agent-1", focused(1, { mentioned: true }), trackedContext(ap, "occ-1", "msg-1", seen)), true);
    assert.equal(fireBusyNotice(ctx), true);
    assert.deepEqual(unconfirmed(ap), ["msg-1"]);

    emit(ctx, child, [steerRejected]);
    assert.deepEqual(unconfirmed(ap), [], "no longer waiting to be confirmed");
    assert.deepEqual(ap.inbox.map((m: AgentMessage) => m.message_id), ["msg-1"], "still queued: the body is not lost");
    assert.equal(ap.notifications.hasContributedMessage(focused(1), SESSION), false, "an ordinary queued message again");
    assert.equal(ap.notifications.pendingCount, 1, "with notice debt");
    assert.equal(seen.acks, 0, "the mention is not acknowledged");
    assert.equal((ctx.manager as any).isVisibleMessageModelSeen("agent-1", "#general:abcd1234", focused(1)), false, "not recorded as seen");
    assert.equal(named(ctx, "daemon.agent.stdin_delivery.async_rejected")[0]!.focus_bodies_requeued_count, 1);
    assert.deepEqual(named(ctx, "daemon.agent.focus_body.unconfirmed_released").map((attrs) => [attrs.reason, attrs.messages_count]), [["async_rejected", 1]]);

    fakeTimers();
    emit(ctx, child, [{ kind: "turn_end", sessionId: SESSION }]);
    await vi.advanceTimersByTimeAsync(FOCUS_BODY_CONFIRM_GRACE_MS);
    const out = writes(child, written);
    assert.equal(out.length, 2, "told again, by the turn end's delivery");
    assert.ok(out[1]!.text.startsWith(`New message received:\n\n${bodyLine(1)}${TRAILER}`), out[1]!.text);
    assert.equal(modelSeen(ctx).length, 0, "nothing is reported for the rejected write");
    assert.equal(named(ctx, "daemon.agent.focus_body.confirmed").length, 0);
    // The second write started a turn: it is reported as any such write, on that turn's first model event.
    emit(ctx, child, [{ kind: "text", text: "reading it now" }]);
    assert.deepEqual(modelSeen(ctx).flatMap((report) => report.items), [{ channelId: THREAD, seqs: [1] }]);
    assert.equal(seen.acks, 1);
  });
});

test("busy confirm: a rejection that arrives just after the turn end still cancels the confirm; the body is told again and nothing is reported for the rejected write", async () => {
  await withManager(async (ctx) => {
    const { ap, child, written } = await startIdle(ctx, FOCUS_ON);
    busy(ctx, ap);
    assert.equal(await ctx.manager.deliverMessage("agent-1", focused(1)), true);
    assert.equal(fireBusyNotice(ctx), true);
    fakeTimers();
    emit(ctx, child, [{ kind: "turn_end", sessionId: SESSION }]);
    assert.equal(writes(child, written).length, 1);
    assert.equal(isIdle(ctx, ap), true, "the turn is over");
    await vi.advanceTimersByTimeAsync(FOCUS_BODY_CONFIRM_GRACE_MS - 1);
    assert.equal(modelSeen(ctx).length, 0, "still inside the wait");

    emit(ctx, child, [steerRejected]);
    assert.deepEqual(unconfirmed(ap), []);
    assert.deepEqual(ap.inbox.map((m: AgentMessage) => m.message_id), ["msg-1"]);
    assert.equal(ap.notifications.pendingCount, 1);
    await vi.advanceTimersByTimeAsync(FOCUS_BODY_CONFIRM_GRACE_MS);
    assert.equal(modelSeen(ctx).length, 0, "the wait's timer confirms nothing");
    assert.equal(named(ctx, "daemon.agent.focus_body.confirmed").length, 0);
    assert.deepEqual(ap.inbox.map((m: AgentMessage) => m.message_id), ["msg-1"], "not consumed");

    // The agent is idle and no turn end is left to tell it: the notice timer does (fired here).
    assert.equal(ap.notifications.hasTimer, true, "a re-tell is scheduled");
    fireBusyNotice(ctx);
    const out = writes(child, written);
    assert.equal(out.length, 2);
    assert.ok(out[1]!.text.startsWith(`New message received:\n\n${bodyLine(1)}${TRAILER}`), out[1]!.text);
    assert.equal(modelSeen(ctx).length, 0, "and that write is reported only when its own turn shows a model event");
  });
});

test("busy confirm: the first model event of the next turn confirms before the wait is over", async () => {
  await withManager(async (ctx) => {
    const { ap, child } = await startIdle(ctx, FOCUS_ON);
    busy(ctx, ap);
    assert.equal(await ctx.manager.deliverMessage("agent-1", focused(1)), true);
    assert.equal(fireBusyNotice(ctx), true);
    fakeTimers();
    emit(ctx, child, [{ kind: "turn_end", sessionId: SESSION }]);
    assert.equal(modelSeen(ctx).length, 0);
    // The runtime opens a turn with the queued input (named by its session, so it is this process's turn).
    emit(ctx, child, [{ kind: "tool_call", name: "bash", input: {}, sessionId: SESSION } as ParsedEvent]);
    assert.deepEqual(modelSeen(ctx).flatMap((report) => report.items), [{ channelId: THREAD, seqs: [1] }]);
    assert.deepEqual(named(ctx, "daemon.agent.focus_body.confirmed").map((attrs) => attrs.trigger), ["next_turn_model_event"]);
    await vi.advanceTimersByTimeAsync(FOCUS_BODY_CONFIRM_GRACE_MS * 4);
    assert.equal(modelSeen(ctx).length, 1, "the wait's timer adds nothing");
  });
});

test("busy confirm: a turn the daemon interrupted decides nothing; the body is released, and a later turn opened by another message does not report it", async () => {
  await withManager(async (ctx) => {
    const { ap, child } = await startIdle(ctx, FOCUS_ON);
    busy(ctx, ap);
    assert.equal(await ctx.manager.deliverMessage("agent-1", focused(1)), true);
    assert.equal(fireBusyNotice(ctx), true);
    fakeTimers();
    emit(ctx, child, [{ kind: "turn_end", sessionId: SESSION, interrupted: true }]);
    await vi.advanceTimersByTimeAsync(FOCUS_BODY_CONFIRM_GRACE_MS * 4);
    assert.equal(modelSeen(ctx).length, 0, "an interrupted turn's end is no evidence");
    assert.deepEqual(unconfirmed(ap), [], "released: no later event can confirm it");
    assert.deepEqual(named(ctx, "daemon.agent.focus_body.unconfirmed_released").map((attrs) => attrs.reason), ["turn_not_decidable"]);
    assert.deepEqual(ap.inbox.map((m: AgentMessage) => m.message_id), ["msg-1"], "still queued, for a read or the next start");
    // The runtime may have dropped the steer with the interrupted turn. A turn opened later by
    // something else shows model events; they say nothing about this body.
    emit(ctx, child, [{ kind: "text", text: "back", sessionId: SESSION } as ParsedEvent]);
    emit(ctx, child, [{ kind: "turn_end", sessionId: SESSION }]);
    await vi.advanceTimersByTimeAsync(FOCUS_BODY_CONFIRM_GRACE_MS * 4);
    assert.equal(modelSeen(ctx).length, 0, "never reported unseen");
    assert.equal(named(ctx, "daemon.agent.focus_body.confirmed").length, 0);
    assert.deepEqual(ap.inbox.map((m: AgentMessage) => m.message_id), ["msg-1"]);
  });
});

test("busy confirm: a body the agent read itself before the confirm is not reported by the confirm", async () => {
  await withManager(async (ctx) => {
    const { ap, child } = await startIdle(ctx, FOCUS_ON);
    busy(ctx, ap);
    assert.equal(await ctx.manager.deliverMessage("agent-1", focused(1)), true);
    assert.equal(fireBusyNotice(ctx), true);
    // A read through the proxy consumes it (and moves the read position on its own path).
    (ctx.manager as any).consumeVisibleMessages("agent-1", { messages: [focused(1)], source: "agent_api_history" });
    assert.deepEqual(ap.inbox, []);
    fakeTimers();
    emit(ctx, child, [{ kind: "turn_end", sessionId: SESSION }]);
    await vi.advanceTimersByTimeAsync(FOCUS_BODY_CONFIRM_GRACE_MS);
    assert.equal(modelSeen(ctx).length, 0);
    assert.deepEqual(named(ctx, "daemon.agent.focus_body.confirmed").map((attrs) => [attrs.messages_count, attrs.not_waiting_count]), [[0, 1]]);
  });
});

test("busy confirm: a session change puts an unconfirmed body back as an ordinary queued message; it is written again in the new session and the old write is never reported", async () => {
  await withManager(async (ctx) => {
    const { ap, child, written } = await startIdle(ctx, FOCUS_ON);
    busy(ctx, ap);
    assert.equal(await ctx.manager.deliverMessage("agent-1", focused(1)), true);
    assert.equal(fireBusyNotice(ctx), true);
    fakeTimers();
    emit(ctx, child, [{ kind: "session_init", sessionId: "session-other" }]);
    assert.deepEqual(unconfirmed(ap), []);
    assert.deepEqual(ap.inbox.map((m: AgentMessage) => m.message_id), ["msg-1"], "still queued");
    assert.equal(ap.notifications.hasContributedMessage(focused(1), "session-other"), false, "untold in the new session");
    assert.deepEqual(named(ctx, "daemon.agent.focus_body.unconfirmed_released").map((attrs) => [attrs.reason, attrs.messages_count]), [["session_changed", 1]]);

    emit(ctx, child, [{ kind: "turn_end", sessionId: "session-other" }]);
    await vi.advanceTimersByTimeAsync(FOCUS_BODY_CONFIRM_GRACE_MS * 4);
    assert.equal(named(ctx, "daemon.agent.focus_body.confirmed").length, 0, "the old session's write confirms nothing");
    assert.equal(modelSeen(ctx).length, 0, "and nothing is reported for it");
    const again = writes(child, written).filter((write) => write.text.includes(bodyLine(1)));
    assert.deepEqual(again.map((write) => write.sessionId), [SESSION, "session-other"], "written again, in full, in the new session");
    assert.ok(again[1]!.text.startsWith(`New message received:\n\n${bodyLine(1)}${TRAILER}`), again[1]!.text);
    // That write started a turn in the new session: reported on its first model event, once.
    emit(ctx, child, [{ kind: "text", text: "reading it" }]);
    assert.deepEqual(modelSeen(ctx).flatMap((report) => report.items), [{ channelId: THREAD, seqs: [1] }]);
  });
});

test("busy confirm: a stop leaves an unconfirmed body unreported", async () => {
  await withManager(async (ctx) => {
    const { ap, child } = await startIdle(ctx, FOCUS_ON);
    busy(ctx, ap);
    assert.equal(await ctx.manager.deliverMessage("agent-1", focused(1)), true);
    assert.equal(fireBusyNotice(ctx), true);
    fakeTimers();
    emit(ctx, child, [{ kind: "turn_end", sessionId: SESSION }]);
    assert.ok(ap.focusBodyConfirmTimer, "the wait runs");
    await ctx.manager.stopAgent("agent-1");
    assert.equal(ap.focusBodyConfirmTimer, undefined);
    assert.deepEqual(unconfirmed(ap), []);
    await vi.advanceTimersByTimeAsync(FOCUS_BODY_CONFIRM_GRACE_MS * 4);
    assert.equal(modelSeen(ctx).length, 0);
  });
});

// A write that fails, and the guards that hold a busy notice back.

test("a write the runtime refuses: the focused body stays queued with its debt and nothing is reported (busy and idle)", async () => {
  await withManager(async (ctx) => {
    const { ap, child, written } = await startIdle(ctx, FOCUS_ON);
    busy(ctx, ap);
    assert.equal(await ctx.manager.deliverMessage("agent-1", focused(1)), true);
    ctx.driver.refuseInput = true;
    assert.equal(fireBusyNotice(ctx), false);
    assert.equal(writes(child, written).length, 0);
    assert.deepEqual(ap.inbox.map((m: AgentMessage) => m.message_id), ["msg-1"]);
    assert.deepEqual(unconfirmed(ap), [], "nothing was written, so nothing waits to be confirmed");
    assert.equal(ap.notifications.pendingCount, 1, "the debt is back");
    assert.equal(ap.notifications.hasContributedMessage(focused(1), SESSION), false);
    assert.equal(named(ctx, "daemon.agent.stdin_notification").at(-1)!.outcome, "encode_failed");
    emit(ctx, child, [{ kind: "text", text: "working" }]);
    assert.equal(modelSeen(ctx).length, 0);

    // Idle: the refused delivery leaves the message queued and the agent idle.
    ap.notifications.clear();
    ap.inbox.length = 0;
    (ctx.manager as any).commitApmIdleState("agent-1", ap, true);
    assert.equal(await ctx.manager.deliverMessage("agent-1", focused(2)), true);
    assert.equal(writes(child, written).length, 0);
    assert.deepEqual(ap.inbox.map((m: AgentMessage) => m.message_id), ["msg-2"]);
    assert.equal(isIdle(ctx, ap), true);
    assert.equal((ctx.manager as any).isVisibleMessageModelSeen("agent-1", "#general:abcd1234", focused(2)), false);
    assert.equal((ap.pendingModelSeen ?? []).length, 0);

    // The runtime takes input again: the queued body goes in full.
    ctx.driver.refuseInput = false;
    (ctx.manager as any).commitApmIdleState("agent-1", ap, false);
    ap.notifications.add(1);
    assert.equal(fireBusyNotice(ctx), true);
    assert.ok(writes(child, written)[0]!.text.startsWith(`New message received:\n\n${bodyLine(2)}${TRAILER}`));
  });
});

for (const [title, close, open, outcome] of [
  [
    "the session does not take deliveries yet",
    (ap: any) => { ap.sessionReadyForDelivery = false; },
    (ap: any) => { ap.sessionReadyForDelivery = true; },
    "suppressed_session_not_ready",
  ],
  [
    "a review boundary is open",
    (ap: any) => { ap.gatedSteering = { ...ap.gatedSteering, reviewing: true }; },
    (ap: any) => { ap.gatedSteering = { ...ap.gatedSteering, reviewing: false }; },
    null,
  ],
] as const) {
  test(`busy guard, ${title}: a queued focused body is not written, keeps its debt, and goes in full once the guard lifts`, async () => {
    await withManager(async (ctx) => {
      const { ap, child, written } = await startIdle(ctx, FOCUS_ON);
      busy(ctx, ap);
      assert.equal(await ctx.manager.deliverMessage("agent-1", focused(1)), true);
      close(ap);
      assert.equal(fireBusyNotice(ctx), false);
      assert.equal(writes(child, written).length, 0, "the guard holds a body as it holds a notice");
      assert.deepEqual(ap.inbox.map((m: AgentMessage) => m.message_id), ["msg-1"]);
      assert.deepEqual(unconfirmed(ap), []);
      assert.equal(ap.notifications.pendingCount, 1, "still owed");
      if (outcome) assert.equal(named(ctx, "daemon.agent.stdin_notification").at(-1)!.outcome, outcome);
      assert.equal((ap.pendingModelSeen ?? []).length, 0, "nothing noted for a report");

      open(ap);
      assert.equal(fireBusyNotice(ctx), true);
      assert.ok(writes(child, written)[0]!.text.startsWith(`New message received:\n\n${bodyLine(1)}${TRAILER}`));
      assert.deepEqual(unconfirmed(ap), ["msg-1"]);
    });
  });
}

// Thread-context bodies (written in full since before Focus).

const threadContext = (seq: number) => ({
  reason: "mentioned",
  parent_target: "#general",
  thread_target: "#general:abcd1234",
  suggested_read_history_target: "#general:abcd1234",
  parent_message: { message_id: "aaaabbbb-0000-0000-0000-000000000000", sender_name: "richard", sender_type: "human", content: "the plan", timestamp: "2026-11-20T00:00:00.000Z", seq: seq - 1 },
  recent_messages: [],
  history_truncated: false,
}) as NonNullable<AgentMessage["thread_join_context"]>;

const ATTENTION_HINT = {
  schema: ATTENTION_HINT_SCHEMA,
  trigger: "M2",
  scope: "#general:abcd1234",
  suggested_command: "raft thread unfollow --target \"#general:abcd1234\"",
  copy: "You've received 12 updates from #general:abcd1234 with no action taken.",
  copy_version: ATTENTION_HINT_COPY_VERSION,
  epoch_ms: 123,
  thresholds: { K: 12, window_ms: 604800000 },
} as NonNullable<AgentMessage["attention_hint"]>;

// Rendered by the code before Focus (commit 5a8f24b722) for this message, pinned byte for byte.
const TODAY_THREAD_CONTEXT_BODY = [
  "New message received:",
  "",
  "[Raft thread context: you were mentioned in a thread without model-visible context.]",
  "parent: #general",
  "thread: #general:abcd1234",
  "suggested next step: raft message read --target \"#general:abcd1234\"",
  "",
  "Parent message:",
  "- [msg=aaaabbbb seq=4 time=2026-11-20 00:00:00Z type=human] @richard: the plan",
  "",
  "Recent thread context:",
  "- (no earlier thread replies)",
  "",
  "[target=#general:abcd1234 msg=msg-5 time=2026-11-20 00:00:00Z type=human] @someone: hello 5",
  "",
  "Respond as appropriate. Complete all your work before stopping.",
  "",
].join("\n");

for (const [title, config] of [
  ["agentFocus absent", { inboxItems: true }],
  ["agentFocus on, the message untagged", FOCUS_ON],
] as const) {
  test(`a thread-context body, ${title}: today's text, consumed under today's source, and still reported`, async () => {
    await withManager(async (ctx) => {
      const { ap, child, written } = await startIdle(ctx, config);
      const mention = threadMessage(5, { mentioned: true, thread_join_context: threadContext(5), attention_hint: ATTENTION_HINT, ...(config === FOCUS_ON ? {} : { focused: true }) } as Partial<AgentMessage>);
      assert.equal(await ctx.manager.deliverMessage("agent-1", mention), true);
      const text = writes(child, written)[0]!.text;
      assert.ok(text.startsWith(TODAY_THREAD_CONTEXT_BODY), text);
      assert.deepEqual(ap.inbox, []);
      assert.deepEqual(
        named(ctx, "daemon.agent.inbox.visible_consumed").map((attrs) => attrs.consume_source),
        ["thread_join_context_rendered", "stdin_thread_context_delivery"],
      );
      // The event stream is the one before Focus: the hint of a message written in full is still recorded.
      assert.deepEqual(named(ctx, "attention_hint_shown").map((attrs) => [attrs.trigger, attrs.scope]), [["M2", "#general:abcd1234"]]);
      assert.deepEqual(ap.pendingModelSeen.map((entry: { kind: string; sessionId: string }) => [entry.kind, entry.sessionId]), [["live", SESSION]]);
      emit(ctx, child, [{ kind: "text", text: "on it" }]);
      assert.deepEqual(modelSeen(ctx).flatMap((report) => report.items), [{ channelId: THREAD, seqs: [5] }]);
      assert.equal("focused_bodies" in named(ctx, "daemon.agent.stdin_delivery").at(-1)!, false);
    });
  });
}

test("idle: a batch of a thread-context body and a focused body writes both in full, in delivery order, with the notice of the rest", async () => {
  await withManager(async (ctx) => {
    const { ap, child, written } = await startIdle(ctx, FOCUS_ON);
    const batch = [
      message(1),
      threadMessage(5, { mentioned: true, thread_join_context: threadContext(5) }),
      focused(6, otherThread),
    ];
    ap.inbox.push(...batch);
    (ctx.manager as any).commitApmIdleState("agent-1", ap, false);
    assert.equal((ctx.manager as any).deliverInboxUpdateViaStdin("agent-1", ap, batch, "idle", "stdin_idle_delivery"), true);
    const text = writes(child, written)[0]!.text;
    const lines = text.split("\n");
    assert.equal(lines[0], "New messages received:");
    const context = lines.indexOf("[Raft thread context: you were mentioned in a thread without model-visible context.]");
    const first = lines.indexOf(bodyLine(5));
    const second = lines.indexOf(bodyLine(6, "#general:eeee5555"));
    const notice = lines.indexOf("[Raft inbox notice:");
    assert.ok(context > 0 && context < first && first + 1 === second && second < notice, text);
    // The total still counts the thread-context body, as it did before Focus (those bytes are kept); the focused body is not counted.
    assert.ok(text.includes("Inbox update: 2 messages pending your read across all conversations; 1 changed target\n#general · 1 unread"), text);
    assert.deepEqual(ap.inbox.map((m: AgentMessage) => m.message_id), ["msg-1"], "both bodies are shown; the noticed one waits");
    assert.deepEqual(unconfirmed(ap), [], "a write that starts a turn shows its bodies at once");
    assert.equal(named(ctx, "daemon.agent.inbox.visible_consumed").at(-1)!.consume_source, "stdin_focus_body_delivery");
    assert.equal(named(ctx, "daemon.agent.stdin_delivery").at(-1)!.focused_bodies, 1, "the thread-context body is not counted as a focused one");
    emit(ctx, child, [{ kind: "text", text: "on it" }]);
    assert.deepEqual(modelSeen(ctx).flatMap((report) => report.items), [{ channelId: THREAD, seqs: [5] }, { channelId: OTHER_THREAD, seqs: [6] }]);
  });
});

// The read report's own rules.

test("read report: a session change keeps a start's first input and a live write of no known session; a body written to the session that was left goes", async () => {
  await withManager(async (ctx) => {
    const { ap, child } = await startIdle(ctx, FOCUS_ON);
    (ctx.manager as any).notePushedModelBodies(ap, [message(9)], { kind: "start" });
    (ctx.manager as any).notePushedModelBodies(ap, [message(8, RANDOM_CHANNEL)], { kind: "live", sessionId: null });
    assert.equal(await ctx.manager.deliverMessage("agent-1", focused(1)), true);
    assert.deepEqual(ap.pendingModelSeen.map((entry: { kind: string }) => entry.kind), ["start", "live", "live"]);
    emit(ctx, child, [{ kind: "session_init", sessionId: "session-other" }]);
    assert.deepEqual(ap.pendingModelSeen.map((entry: { message: AgentMessage }) => entry.message.seq), [9, 8]);
    emit(ctx, child, [{ kind: "text", text: "a new session" }]);
    assert.deepEqual(modelSeen(ctx).flatMap((report) => report.items), [{ channelId: GENERAL, seqs: [9] }, { channelId: RANDOM, seqs: [8] }]);
  });
});

test("read report: a body written as a prompt is not reported after a steer is rejected (a runtime may send an accepted prompt as a steer)", async () => {
  await withManager(async (ctx) => {
    const { ap, child, written } = await startIdle(ctx, FOCUS_ON);
    // Idle write: the runtime accepts it as a prompt, the body is consumed and noted for the report.
    assert.equal(await ctx.manager.deliverMessage("agent-1", focused(1)), true);
    assert.equal(writes(child, written).length, 1);
    assert.equal(named(ctx, "daemon.agent.stdin_delivery").at(-1)!.accepted_as, "prompt");
    assert.equal(ap.pendingModelSeen.length, 1);
    // The runtime was still streaming and sent it as a steer, which it then refused.
    emit(ctx, child, [steerRejected]);
    assert.deepEqual(ap.pendingModelSeen, []);
    emit(ctx, child, [{ kind: "text", text: "still on the earlier work" }]);
    assert.equal(modelSeen(ctx).length, 0, "the refused body is never reported");
    assert.deepEqual(named(ctx, "daemon.agent.model_seen.dropped").map((attrs) => [attrs.reason, attrs.request_method, attrs.messages_count]), [["async_rejected", "turn/steer", 1]]);
  });
});

test("read report: any rejection drops every live entry; a start's first input goes only with a rejected turn start", async () => {
  await withManager(async (ctx) => {
    const { ap, child } = await startIdle(ctx, FOCUS_ON);
    const note = (seq: number, write: unknown) => (ctx.manager as any).notePushedModelBodies(ap, [message(seq)], write);
    const pending = () => ap.pendingModelSeen.map((entry: { message: AgentMessage }) => entry.message.seq);
    busy(ctx, ap);
    note(1, { kind: "start" });
    note(2, { kind: "live", sessionId: SESSION });
    note(3, { kind: "live", sessionId: null });
    emit(ctx, child, [steerRejected]);
    assert.deepEqual(pending(), [1], "a rejected steer: every live entry, not the start's");
    note(2, { kind: "live", sessionId: SESSION });
    emit(ctx, child, [{ ...steerRejected, requestMethod: "turn/start" } as ParsedEvent]);
    assert.deepEqual(pending(), [], "a rejected turn start: the start's first input too");
  });
});

test("busy confirm: a turn that ended through an error is no evidence; the body is released and a later turn does not report it", async () => {
  for (const fail of [
    (ap: any) => { ap.turnOutcome.runtimeErrors = 1; },
    (ap: any) => { ap.recentStderr = [...(ap.recentStderr ?? [])]; ap.turnOutcome.runtimeErrors = 2; },
  ]) {
    await withManager(async (ctx) => {
      const { ap, child } = await startIdle(ctx, FOCUS_ON);
      busy(ctx, ap);
      assert.equal(await ctx.manager.deliverMessage("agent-1", focused(1)), true);
      assert.equal(fireBusyNotice(ctx), true);
      fakeTimers();
      // The turn hit a runtime error (a provider limit, an API error) and then ended.
      fail(ap);
      emit(ctx, child, [{ kind: "turn_end", sessionId: SESSION }]);
      assert.equal(ap.focusBodyConfirmTimer, undefined, "no wait is started");
      await vi.advanceTimersByTimeAsync(FOCUS_BODY_CONFIRM_GRACE_MS * 4);
      assert.equal(modelSeen(ctx).length, 0, "a failed turn's end confirms nothing");
      assert.deepEqual(unconfirmed(ap), []);
      assert.deepEqual(named(ctx, "daemon.agent.focus_body.unconfirmed_released").map((attrs) => attrs.reason), ["turn_not_decidable"]);
      assert.deepEqual(ap.inbox.map((m: AgentMessage) => m.message_id), ["msg-1"]);
      emit(ctx, child, [{ kind: "text", text: "back", sessionId: SESSION } as ParsedEvent]);
      assert.equal(modelSeen(ctx).length, 0, "a later turn's model event does not report it");
      assert.equal(named(ctx, "daemon.agent.focus_body.confirmed").length, 0);
    });
  }
});

test("busy: a body the runtime rejected is not steered in full again before the turn ends, however many model events follow", async () => {
  await withManager(async (ctx) => {
    const { ap, child, written } = await startIdle(ctx, FOCUS_ON);
    busy(ctx, ap);
    assert.equal(await ctx.manager.deliverMessage("agent-1", focused(1)), true);
    assert.equal(fireBusyNotice(ctx), true);
    const inFull = () => writes(child, written).filter((write) => write.text.startsWith("New message received:") && write.text.includes(bodyLine(1))).length;
    assert.equal(inFull(), 1);

    emit(ctx, child, [steerRejected]);
    assert.equal(ap.notifications.pendingCount, 1, "queued again, with debt");
    // This runtime takes busy input directly: every model event tells its debt again.
    emit(ctx, child, [{ kind: "text", text: "one" }]);
    emit(ctx, child, [{ kind: "tool_call", name: "bash", input: {} }]);
    emit(ctx, child, [{ kind: "text", text: "two" }]);
    assert.equal(inFull(), 1, "not written in full a second time inside the turn");
    const afterRejection = writes(child, written).slice(1);
    assert.deepEqual(afterRejection.map((write) => write.text), [TODAY_THREAD_NOTICE(1)], "told once, as a notice lists any queued message");
    assert.deepEqual(unconfirmed(ap), [], "a notice row is not a body: nothing waits to be confirmed");

    // A second rejection of that notice, then more events: still no body before the turn end.
    emit(ctx, child, [steerRejected]);
    emit(ctx, child, [{ kind: "text", text: "three" }]);
    assert.equal(inFull(), 1);
    emit(ctx, child, [steerRejected]);

    fakeTimers();
    emit(ctx, child, [{ kind: "turn_end", sessionId: SESSION }]);
    await vi.advanceTimersByTimeAsync(FOCUS_BODY_CONFIRM_GRACE_MS);
    assert.equal(inFull(), 2, "the turn end writes what is still untold, in full");
    assert.equal(ap.focusBodiesRejectedInTurn, undefined);
    assert.equal(modelSeen(ctx).length, 0, "nothing reported for the rejected writes");
  });
});

// --- Start path (Focus Computer part B): focused messages present at a start ---

/** A start with a wake message and, optionally, messages buffered while it starts; returns the first input. */
async function startWith(ctx: Ctx, config: Partial<AgentConfig>, wake: AgentMessage, starting: AgentMessage[] = []) {
  if (starting.length > 0) (ctx.manager as any).startingInboxes.bufferMessagesDuringStart("agent-1", starting);
  await ctx.manager.startAgent("agent-1", makeConfig({ sessionId: SESSION, ...config }), wake, undefined, undefined, "launch-1");
  const ap = (ctx.manager as any).agents.get("agent-1");
  const child = ctx.driver.processes.at(-1)!;
  return { ap, child, prompt: String(ctx.driver.spawnCalls.at(-1)!.prompt) };
}

test("start: a focused wake message is the first input in full and is reported as a start entry after the first model event", async () => {
  await withManager(async (ctx) => {
    const wake = focused(1, { focus_change: { reason: "mentioned", focused: ["#general:abcd1234"], unfocused: [] } });
    const { ap, child, prompt } = await startWith(ctx, FOCUS_ON, wake);
    assert.ok(prompt.includes(`New message received:\n\n[Raft focused #general:abcd1234 because you were @mentioned there.`), prompt);
    assert.ok(prompt.includes(bodyLine(1)), prompt);
    assert.equal(prompt.includes("[Raft inbox notice"), false);
    assert.deepEqual(ap.pendingModelSeen.map((entry: { kind: string; message: AgentMessage }) => [entry.kind, entry.message.seq]), [["start", 1]]);
    assert.deepEqual(ap.inbox, [], "shown, so not offered again");
    assert.equal((ctx.manager as any).isVisibleMessageModelSeen("agent-1", "#general:abcd1234", wake), true);

    assert.equal(modelSeen(ctx).length, 0, "not reported before the runtime shows it took the input");
    emit(ctx, child, [{ kind: "text", text: "on it" }]);
    assert.deepEqual(modelSeen(ctx).flatMap((report) => report.items), [{ channelId: THREAD, seqs: [1] }]);
  });
});

test("start: under an unfocused wake, a focused message buffered during the start is in full, leaves the inbox and is a start entry; the wake stays a notice row", async () => {
  await withManager(async (ctx) => {
    const wake = message(1);
    const buffered = focused(2);
    const { ap, child, prompt } = await startWith(ctx, FOCUS_ON, wake, [buffered]);
    assert.ok(prompt.includes(`New message received:\n\n${bodyLine(2)}\n\n[Raft inbox notice`), prompt);
    assert.equal(prompt.includes(bodyLine(1, "#general")), false, "the wake is listed, not written in full");
    assert.deepEqual(ap.inbox.map((each: AgentMessage) => each.message_id), ["msg-1"], "the noticed wake still waits; the body does not");
    assert.deepEqual(ap.pendingModelSeen.map((entry: { kind: string; message: AgentMessage }) => [entry.kind, entry.message.seq]), [["start", 2]]);
    emit(ctx, child, [{ kind: "text", text: "on it" }]);
    assert.deepEqual(modelSeen(ctx).flatMap((report) => report.items), [{ channelId: THREAD, seqs: [2] }]);
  });
});

test("start: under a focused wake, a focused message buffered during the start is in full too and both are start entries", async () => {
  await withManager(async (ctx) => {
    const { ap, prompt } = await startWith(ctx, FOCUS_ON, focused(1), [message(3), focused(2, otherThread)]);
    assert.ok(prompt.includes(`New messages received:\n\n${bodyLine(1)}\n${bodyLine(2, "#general:eeee5555")}\n\n[Raft inbox notice`), prompt);
    assert.deepEqual(ap.inbox.map((each: AgentMessage) => each.message_id), ["msg-3"]);
    assert.deepEqual(ap.pendingModelSeen.map((entry: { kind: string; message: AgentMessage }) => [entry.kind, entry.message.seq]), [["start", 1], ["start", 2]]);
  });
});

for (const [title, config] of [
  ["agentFocus absent", { inboxItems: true }],
  ["agentFocus false", { inboxItems: true, agentFocus: false }],
] as const) {
  test(`start, ${title}: tagged wake and buffered messages give the first input untagged ones give, and nothing is noted for a report`, async () => {
    let untaggedPrompt = "";
    await withManager(async (ctx) => {
      ({ prompt: untaggedPrompt } = await startWith(ctx, config, threadMessage(1), [threadMessage(2, otherThread), message(3)]));
    });
    await withManager(async (ctx) => {
      const wake = focused(1, { focus_change: { reason: "mentioned", focused: ["#general:abcd1234"], unfocused: [] } });
      const { ap, child, prompt } = await startWith(ctx, config, wake, [focused(2, otherThread), message(3)]);
      assert.equal(prompt, untaggedPrompt);
      assert.equal(prompt.includes("New message"), false, "a notice, as before");
      assert.deepEqual(ap.pendingModelSeen ?? [], []);
      assert.deepEqual(ap.inbox.map((each: AgentMessage) => each.message_id), ["msg-1", "msg-2", "msg-3"]);
      emit(ctx, child, [{ kind: "text", text: "on it" }]);
      assert.equal(modelSeen(ctx).length, 0);
    });
  });
}

test("start: under a focused wake, an unfocused message the first input's notice lists is told once; the turn end does not announce it again", async () => {
  await withManager(async (ctx) => {
    const { ap, child, prompt } = await startWith(ctx, FOCUS_ON, focused(1), [message(3)]);
    assert.ok(prompt.includes(`New message received:\n\n${bodyLine(1)}\n\n[Raft inbox notice`), prompt);
    assert.ok(prompt.includes("#general · 1 unread"), prompt);
    ap.sessionId = SESSION;
    ap.sessionReadyForDelivery = true;
    const written = child.stdinWrites.length;
    emit(ctx, child, [{ kind: "text", text: "on it" }]);
    emit(ctx, child, [{ kind: "turn_end", sessionId: SESSION }]);
    await flush();
    assert.deepEqual(writes(child, written), [], "told by the first input: not announced again");
    assert.deepEqual(ap.inbox.map((each: AgentMessage) => each.message_id), ["msg-3"], "still unread, as any noticed message");
  });
});

// --- Size limits (docs/contracts/agent-focus.md, "Size limits"): 16 KB a message, 32 KB of focused bodies a write ---

const KB = 1024;
/** A focused thread reply whose content is `bytes` bytes. */
const sized = (seq: number, bytes: number, overrides: Partial<AgentMessage> = {}) => focused(seq, { content: `m${seq}:`.padEnd(bytes, "x"), ...overrides });
const thirdThread = { channel_id: "11111111-aaaa-4bbb-8ccc-000000000005", channel_name: "thread-ffff6666" } as const;
const shownInFull = (text: string, seq: number) => text.includes(` msg=msg-${seq} time=`);
const capAttrs = (attrs: Record<string, unknown>) => [attrs.focused_bodies ?? 0, attrs.focused_rows_over_message_cap_count ?? 0, attrs.focused_rows_over_write_cap ?? 0];

test("cap, idle: a focused message over 16 KB is the notice an unfocused one is; it stays in the inbox and is not reported", async () => {
  let untagged = "";
  await withManager(async (ctx) => {
    const { child, written } = await startIdle(ctx, FOCUS_ON);
    assert.equal(await ctx.manager.deliverMessage("agent-1", { ...sized(1, 16 * KB + 1), focused: undefined }), true);
    untagged = writes(child, written)[0]!.text;
  });
  await withManager(async (ctx) => {
    const { ap, child, written } = await startIdle(ctx, FOCUS_ON);
    assert.equal(await ctx.manager.deliverMessage("agent-1", sized(1, 16 * KB + 1)), true);
    const out = writes(child, written);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.text, untagged);
    assert.ok(out[0]!.text.startsWith("[Raft inbox notice:"), "a notice, not a body");
    assert.deepEqual(ap.inbox.map((m: AgentMessage) => m.message_id), ["msg-1"], "still unread, as any noticed message");
    emit(ctx, child, [{ kind: "text", text: "on it" }]);
    assert.equal(modelSeen(ctx).length, 0, "a row is not reported");
    const [event] = named(ctx, "daemon.agent.stdin_delivery").filter((attrs) => attrs.outcome === "written");
    assert.deepEqual(capAttrs(event!), [0, 1, 0]);
    assert.equal("focused_bytes_count" in event!, false);
  });
});

test("cap, idle: a focused message of exactly 16 KB is written in full", async () => {
  await withManager(async (ctx) => {
    const { ap, child, written } = await startIdle(ctx, FOCUS_ON);
    assert.equal(await ctx.manager.deliverMessage("agent-1", sized(1, 16 * KB)), true);
    const out = writes(child, written);
    assert.ok(out[0]!.text.startsWith("New message received:"), out[0]!.text.slice(0, 80));
    assert.deepEqual(ap.inbox, []);
    const [event] = named(ctx, "daemon.agent.stdin_delivery").filter((attrs) => attrs.outcome === "written");
    assert.deepEqual([...capAttrs(event!), event!.focused_bytes_count], [1, 0, 0, 16 * KB]);
  });
});

test("cap, rows ask: an idle delivery of a focused message over the limit is asked about and held, as an unfocused one is", async () => {
  await withManager(async (ctx) => {
    const { ap, child, written } = await startIdle(ctx, { ...ROWS_ON, agentFocus: true });
    assert.equal(await ctx.manager.deliverMessage("agent-1", sized(1, 17 * KB)), true);
    assert.deepEqual(ctx.rowsCalls.map((call) => call.targets), [[{ channelId: THREAD, newestSeq: 1 }]]);
    assert.ok(ap.pendingIdleInboxHold);
    assert.equal(writes(child, written).length, 0);
  });
});

test("cap, busy: a large message in the middle; the earlier one and another conversation's are in full, it and the later ones of its conversation are rows of the same write", async () => {
  await withManager(async (ctx) => {
    const { ap, child, written } = await startIdle(ctx, FOCUS_ON);
    busy(ctx, ap);
    for (const each of [sized(1, 40), sized(2, 20 * KB), sized(3, 40, otherThread), sized(4, 40)]) {
      assert.equal(await ctx.manager.deliverMessage("agent-1", each), true);
    }
    assert.equal(fireBusyNotice(ctx), true);
    const out = writes(child, written);
    assert.equal(out.length, 1, "one write");
    assert.ok(out[0]!.text.startsWith("New messages received:"));
    assert.deepEqual([1, 2, 3, 4].map((seq) => shownInFull(out[0]!.text, seq)), [true, false, true, false]);
    assert.ok(out[0]!.text.includes("Inbox update: 2 messages pending your read"), "the notice counts the rows, not the bodies");
    assert.deepEqual(unconfirmed(ap), ["msg-1", "msg-3"], "only what was written in full waits to be confirmed");
    const event = named(ctx, "daemon.agent.stdin_notification").filter((attrs) => attrs.outcome === "written").at(-1)!;
    assert.deepEqual(capAttrs(event), [2, 2, 0]);
    assert.deepEqual(capAttrs(named(ctx, "daemon.agent.inbox_update.pushed").at(-1)!), [2, 2, 0]);

    fakeTimers();
    emit(ctx, child, [{ kind: "turn_end", sessionId: SESSION }]);
    await vi.advanceTimersByTimeAsync(FOCUS_BODY_CONFIRM_GRACE_MS);
    assert.deepEqual(modelSeen(ctx).flatMap((report) => report.items), [{ channelId: THREAD, seqs: [1] }, { channelId: OTHER_THREAD, seqs: [3] }], "the rows are not reported");
    assert.deepEqual(ap.inbox.map((m: AgentMessage) => m.message_id), ["msg-2", "msg-4"], "the rows stay unread");
  });
});

test("cap, busy: the write limit; bodies of 32 KB together fit, the next one is a row, and a later write has its own budget", async () => {
  await withManager(async (ctx) => {
    const { ap, child, written } = await startIdle(ctx, FOCUS_ON);
    busy(ctx, ap);
    for (const each of [sized(1, 16 * KB), sized(2, 16 * KB, otherThread), sized(3, 1, thirdThread)]) {
      assert.equal(await ctx.manager.deliverMessage("agent-1", each), true);
    }
    assert.equal(fireBusyNotice(ctx), true);
    const first = writes(child, written)[0]!.text;
    assert.deepEqual([1, 2, 3].map((seq) => shownInFull(first, seq)), [true, true, false]);
    assert.deepEqual(capAttrs(named(ctx, "daemon.agent.stdin_notification").filter((attrs) => attrs.outcome === "written").at(-1)!), [2, 0, 1]);
    assert.deepEqual(unconfirmed(ap), ["msg-1", "msg-2"]);

    // The first write's bodies are still unconfirmed in the inbox: they take nothing from this write's 32 KB.
    for (const each of [sized(4, 16 * KB), sized(5, 16 * KB, otherThread)]) {
      assert.equal(await ctx.manager.deliverMessage("agent-1", each), true);
    }
    assert.equal(fireBusyNotice(ctx), true);
    const second = writes(child, written)[1]!.text;
    assert.deepEqual([4, 5].map((seq) => shownInFull(second, seq)), [true, true]);
    assert.deepEqual(capAttrs(named(ctx, "daemon.agent.stdin_notification").filter((attrs) => attrs.outcome === "written").at(-1)!), [2, 0, 0]);
    assert.deepEqual(unconfirmed(ap), ["msg-1", "msg-2", "msg-4", "msg-5"]);
  });
});

test("cap, busy, Codex: a batch whose focused messages are all rows waits behind an outstanding notice, as a notice does", async () => {
  await withManager(async (ctx) => {
    const { ap, child, written } = await startIdle(ctx, FOCUS_ON);
    busy(ctx, ap);
    assert.equal(await ctx.manager.deliverMessage("agent-1", message(1)), true);
    assert.equal(fireBusyNotice(ctx), true);
    assert.equal(await ctx.manager.deliverMessage("agent-1", sized(3, 17 * KB)), true);
    assert.equal(fireBusyNotice(ctx), false);
    assert.equal(writes(child, written).length, 1);
    assert.equal(named(ctx, "daemon.agent.stdin_notification").at(-1)!.outcome, "suppressed_notice_outstanding");
    assert.deepEqual(unconfirmed(ap), []);
  }, new FakeClaudeDriver({ id: "codex" }));
});

test("cap, busy: a pure notice of demoted messages arms the Codex hold like any pure notice", async () => {
  await withManager(async (ctx) => {
    const { ap, child, written } = await startIdle(ctx, FOCUS_ON);
    busy(ctx, ap);
    assert.equal(await ctx.manager.deliverMessage("agent-1", sized(1, 17 * KB)), true);
    assert.equal(fireBusyNotice(ctx), true);
    assert.ok(writes(child, written)[0]!.text.startsWith("[Raft inbox notice:"));
    assert.equal(ap.notifications.isNoticeHoldArmed, true);
  }, new FakeClaudeDriver({ id: "codex" }));
});

test("cap, start: a focused wake over the limit gives the first input an unfocused wake gives; nothing is noted for a report and it stays in the inbox", async () => {
  let untaggedPrompt = "";
  await withManager(async (ctx) => {
    ({ prompt: untaggedPrompt } = await startWith(ctx, FOCUS_ON, { ...sized(1, 17 * KB), focused: undefined }, [sized(2, 30, otherThread)]));
  });
  await withManager(async (ctx) => {
    const { ap, prompt } = await startWith(ctx, FOCUS_ON, sized(1, 17 * KB), [sized(2, 30, otherThread)]);
    assert.equal(prompt, untaggedPrompt, "the wake is a row; the message that fits is in full either way");
    assert.equal(shownInFull(prompt, 1), false);
    assert.equal(shownInFull(prompt, 2), true);
    assert.deepEqual(ap.inbox.map((each: AgentMessage) => each.message_id), ["msg-1"]);
    assert.deepEqual(ap.pendingModelSeen.map((entry: { kind: string; message: AgentMessage }) => [entry.kind, entry.message.seq]), [["start", 2]]);
  });
});

test("cap, idle: a focused message that brings its thread context is in full whatever its size and takes nothing from the budget", async () => {
  await withManager(async (ctx) => {
    const { ap, child, written } = await startIdle(ctx, FOCUS_ON);
    busy(ctx, ap);
    for (const each of [sized(2, 20 * KB, { thread_join_context: threadContext(2), mentioned: true }), sized(3, 16 * KB, otherThread), sized(4, 16 * KB, thirdThread)]) {
      assert.equal(await ctx.manager.deliverMessage("agent-1", each), true);
    }
    // The turn ends before the busy notice's timer fires: the flush is a write that starts a turn.
    emit(ctx, child, [{ kind: "turn_end", sessionId: SESSION }]);
    await flush();
    const out = writes(child, written);
    assert.equal(out.length, 1);
    assert.deepEqual([2, 3, 4].map((seq) => shownInFull(out[0]!.text, seq)), [true, true, true]);
    assert.equal(out[0]!.text.includes("[Raft inbox notice"), false);
    const [event] = named(ctx, "daemon.agent.stdin_delivery").filter((attrs) => attrs.outcome === "written");
    assert.deepEqual(capAttrs(event!), [3, 0, 0]);
  });
});

test("cap, busy: after a body the runtime rejected in this turn became a row, later focused messages of its conversation are rows of that write too; another conversation is still in full", async () => {
  await withManager(async (ctx) => {
    const { ap, child, written } = await startIdle(ctx, FOCUS_ON);
    busy(ctx, ap);
    assert.equal(await ctx.manager.deliverMessage("agent-1", focused(1)), true);
    assert.equal(fireBusyNotice(ctx), true);
    emit(ctx, child, [steerRejected]);
    assert.ok(ap.focusBodiesRejectedInTurn?.has(ap.inbox[0]), "the rejected body is held back for this turn");

    assert.equal(await ctx.manager.deliverMessage("agent-1", focused(2)), true);
    assert.equal(await ctx.manager.deliverMessage("agent-1", focused(3, otherThread)), true);
    assert.equal(fireBusyNotice(ctx), true);
    const out = writes(child, written).at(-1)!.text;
    assert.deepEqual([1, 2, 3].map((seq) => shownInFull(out, seq)), [false, false, true], "the conversation is not shown with the rejected message missing");
    assert.ok(out.includes("#general:abcd1234 · 2 unread"), out);
    assert.deepEqual(unconfirmed(ap), ["msg-3"]);
    // Neither row was made by a size limit.
    assert.deepEqual(capAttrs(named(ctx, "daemon.agent.stdin_notification").filter((attrs) => attrs.outcome === "written").at(-1)!), [1, 0, 0]);
  });
});
