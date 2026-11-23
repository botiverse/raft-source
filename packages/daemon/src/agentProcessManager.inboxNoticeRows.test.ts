// The wake-up notice with the Server's unread numbers on the legacy host
// (#wg-ax:#42, inboxRowsAsk.ts). With the flag off, the capability missing or
// inbox items off, nothing is asked and the notice is today's, byte for byte.
// With all three on: a message for an idle agent is held, the agent still
// idle, until the rows ask settles or the hold's one 800 ms timer fires; a
// message for a busy agent starts the ask and its notice takes the answer
// that is here. A hold that cannot deliver (stop, session reset or switch,
// busy by another route) writes nothing and leaves the messages queued.
//
// RED proof: drop `holdIdleInboxDelivery` from deliverMessage and "held until
// the ask settles" writes at once without a number; let a later arrival
// restart the timer and "does not extend" writes nothing at 800 ms; drop the
// session check in releaseIdleInboxHold and the reset/switch tests write to
// the old session; commit busy before the wait and "stays idle" fails.
// Helpers are slimmed copies per this repo's APM test convention (see
// agentProcessManager.drain.test.ts).

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { afterEach, test, vi } from "vitest";
import { asAxSurfaceText, type AgentApiInboxRowsResponse, type AgentConfig, type AgentMessage, type AxSurfaceText, type MachineToServerMessage } from "@botiverse/raft-shared";
import { AgentProcessManager } from "./agentProcessManager";
import { exampleThirdPartyEvent } from "./axExampleFixtures";
import { setDaemonFetchImplForTests } from "./daemonFetch";
import { INBOX_ROWS_CALL_EVENT, INBOX_ROWS_NOTICE_EVENT, type InboxRowsFetchAsAgent, type InboxRowsTarget } from "./inboxRowsAsk";
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
  readonly id = "claude";
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

  constructor(options: { liveSessionReadyAt?: "session_init" | "turn_end" } = {}) {
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
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-inbox-notice-rows-test-"));
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
/**
 * A cancelled hold leaves its messages as queued ones: notice debt and the
 * busy notice timer (STDIN_NOTIFICATION_INITIAL_DELAY_MS). Fired at once here.
 */
function fireOrdinaryDelivery(ctx: Ctx, ap: any, owed: number): void {
  assert.equal(ap.notifications.pendingCount, owed, "owed as a queued message is");
  assert.equal(ap.notifications.hasTimer, true, "and its timer runs");
  (ctx.manager as any).sendStdinNotification("agent-1");
}

// Rendered by the code before this change (inbox items on), pinned byte for byte.
const TODAY_ITEMS_NOTICE = [
  "[Raft inbox notice:",
  "Inbox update: 1 message pending your read across all conversations; 1 changed target",
  "#general · 1 unread · latest @someone",
  "  \"hello 1\" (preview)",
  "  read: raft inbox read --target \"#general\"",
  "]",
].join("\n");

// Rendered by the code before inbox items existed, pinned byte for byte.
const TODAY_PLAIN_NOTICE = [
  "[Raft inbox notice:",
  "Inbox update: 1 message pending your read across all conversations; 1 changed target",
  "#general  pending: 1 message · first msg=msg-1 · latest sender @someone · latest msg=msg-1",
  "  latest @someone: \"hello 1\" (preview; still unread, full text: raft message read --target \"#general\" --unread)",
  "]",
  "These messages have not been read. Choose when to read them: `raft message read --target <target> --unread` reads one conversation's unread messages; `raft inbox check` lists every conversation with unread messages.",
].join("\n");

for (const [title, config, capable, expected] of [
  ["flag off", { inboxItems: true }, true, TODAY_ITEMS_NOTICE],
  ["the Server does not advertise the rows route", ROWS_ON, false, TODAY_ITEMS_NOTICE],
  ["inbox items off", { inboxNoticeServerRows: true }, true, TODAY_PLAIN_NOTICE],
] as const) {
  test(`${title}: nothing is asked, nothing is held, and the notice is today's byte for byte (idle and busy)`, async () => {
    await withManager(async (ctx) => {
      const { ap, child, written } = await startIdle(ctx, config, { capable });
      assert.equal(await ctx.manager.deliverMessage("agent-1", message(1)), true);
      assert.equal(ap.pendingIdleInboxHold, null);
      assert.deepEqual(writes(child, written).map((write) => write.text), [expected], "written at once, as before");
      assert.equal(routed(ctx, "stdin_idle_delivery").length, 1);

      // Busy now (the write started a turn): a second message is queued and told by the busy notice.
      assert.equal(await ctx.manager.deliverMessage("agent-1", message(2)), true);
      (ctx.manager as any).sendStdinNotification("agent-1");
      const busy = writes(child, written)[1]!.text;
      assert.equal(busy, expected.replace("1 message pending", "2 messages pending").replaceAll("hello 1", "hello 2").replaceAll("msg-1", "msg-2"));

      assert.equal(ctx.rowsCalls.length, 0, "no request");
      assert.equal(named(ctx, INBOX_ROWS_CALL_EVENT).length + named(ctx, INBOX_ROWS_NOTICE_EVENT).length, 0);
    });
  });
}

test("idle, flag on: the delivery is held (the agent stays idle) until the ask settles, then the notice prints the Server's number", async () => {
  await withManager(async (ctx) => {
    const { ap, child, written } = await startIdle(ctx, ROWS_ON);
    assert.equal(await ctx.manager.deliverMessage("agent-1", message(1)), true);
    assert.equal(ctx.rowsCalls.length, 1);
    assert.deepEqual(ctx.rowsCalls[0]!.targets, [{ channelId: GENERAL, newestSeq: 1 }]);
    assert.equal(writes(child, written).length, 0, "nothing written while the ask is out");
    assert.equal(isIdle(ctx, ap), true, "not marked busy during the hold");
    assert.ok(ap.pendingIdleInboxHold, "an explicit hold");
    assert.deepEqual(ap.inbox.map((m: AgentMessage) => m.message_id), ["msg-1"], "the message waits in the inbox");
    assert.equal(routed(ctx, "held_idle_inbox_rows").length, 1);

    ctx.rowsCalls[0]!.respond(answer([serverRow(GENERAL, "#general", 7)]));
    await flush();
    assert.deepEqual(writes(child, written), [{
      sessionId: SESSION,
      text: [
        "[Raft inbox notice: new since your last notice, in 1 target",
        "#general · 7 unread · latest @someone",
        "  \"the Server's preview\" (preview)",
        "  read: raft inbox read --target \"#general\"",
        "Older unread: 9 messages in 2 targets. List everything: raft inbox check",
        "]",
      ].join("\n"),
    }]);
    assert.equal(isIdle(ctx, ap), false, "the write claimed the turn");
    assert.equal(ap.pendingIdleInboxHold, null);
    assert.equal(routed(ctx, "stdin_idle_delivery").length, 1);
    assert.deepEqual(named(ctx, INBOX_ROWS_CALL_EVENT).map((attrs) => [attrs.outcome, attrs.call_site, attrs.host, attrs.targets, attrs.rows]), [["ok", "idle_hold", "legacy", 1, 1]]);
    assert.deepEqual(named(ctx, INBOX_ROWS_NOTICE_EVENT), [{ agentId: "agent-1", host: "legacy", call_site: "idle_hold", answer_used: true, listed_rows: 1, numberless_rows: 0 }]);
    // The older-unread count is remembered for the session only once written.
    assert.equal(ap.notifications.previousOlderMessages(SESSION), 9);
  });
});

test("idle, flag on, the ask fails: the row prints without a number and there is no Older unread line", async () => {
  await withManager(async (ctx) => {
    const { ap, child, written } = await startIdle(ctx, ROWS_ON);
    assert.equal(await ctx.manager.deliverMessage("agent-1", message(1)), true);
    ctx.rowsCalls[0]!.respond(failure(503));
    await flush();
    assert.deepEqual(writes(child, written).map((write) => write.text), [[
      "[Raft inbox notice: new since your last notice, in 1 target",
      "#general · latest @someone",
      "  \"hello 1\" (preview)",
      "  read: raft inbox read --target \"#general\"",
      "]",
    ].join("\n")]);
    assert.equal(ctx.rowsCalls.length, 1, "no retry");
    assert.deepEqual(named(ctx, INBOX_ROWS_CALL_EVENT).map((attrs) => [attrs.outcome, attrs.failure_reason]), [["fallback", "http_5xx"]]);
    assert.deepEqual(named(ctx, INBOX_ROWS_NOTICE_EVENT).map((attrs) => [attrs.answer_used, attrs.listed_rows, attrs.numberless_rows]), [[false, 1, 1]]);
    assert.equal(ap.notifications.previousOlderMessages(SESSION), null);
  });
});

test("idle hold: with no answer the delivery goes, numberless, when the hold's 800 ms timer fires", async () => {
  await withManager(async (ctx) => {
    const { ap, child, written } = await startIdle(ctx, ROWS_ON);
    fakeTimers();
    assert.equal(await ctx.manager.deliverMessage("agent-1", message(1)), true);
    await vi.advanceTimersByTimeAsync(799);
    assert.equal(writes(child, written).length, 0);
    assert.equal(isIdle(ctx, ap), true);
    await vi.advanceTimersByTimeAsync(1);
    const out = writes(child, written);
    assert.equal(out.length, 1, "written once");
    assert.ok(out[0]!.text.includes("\n#general · latest @someone\n"), "no number");
    assert.equal(out[0]!.text.includes("Older unread"), false);
    assert.equal(ap.pendingIdleInboxHold, null);
    assert.deepEqual(named(ctx, INBOX_ROWS_CALL_EVENT).map((attrs) => [attrs.failure_reason, attrs.duration_ms]), [["timeout", 800]]);
  });
});

test("idle hold: a second message joins the hold and does not extend it; one write tells the whole batch", async () => {
  await withManager(async (ctx) => {
    const { ap, child, written } = await startIdle(ctx, ROWS_ON);
    fakeTimers();
    assert.equal(await ctx.manager.deliverMessage("agent-1", message(1)), true);
    const hold = ap.pendingIdleInboxHold;
    await vi.advanceTimersByTimeAsync(500);
    assert.equal(await ctx.manager.deliverMessage("agent-1", message(2, RANDOM_CHANNEL)), true);
    assert.equal(ap.pendingIdleInboxHold, hold, "the same hold");
    assert.equal(isIdle(ctx, ap), true, "the second message did not take the busy path");
    assert.equal(ap.notifications.pendingCount, 0, "no busy notice debt");
    assert.equal(ctx.rowsCalls.length, 1, "it folds into a follow-up, not a second request");
    assert.equal(routed(ctx, "held_idle_inbox_rows").length, 2);
    await vi.advanceTimersByTimeAsync(299);
    assert.equal(writes(child, written).length, 0, "799 ms after the FIRST message: still held");
    await vi.advanceTimersByTimeAsync(1);
    const out = writes(child, written);
    assert.equal(out.length, 1, "800 ms after the first message, not 800 ms after the second");
    assert.ok(out[0]!.text.startsWith("[Raft inbox notice: new since your last notice, in 2 targets\n"));
    assert.ok(out[0]!.text.includes("#general · latest @someone"));
    assert.ok(out[0]!.text.includes("#random · latest @someone"));
    // Nothing more is written when the second message's own 800 ms would have passed.
    await vi.advanceTimersByTimeAsync(1_000);
    assert.equal(writes(child, written).length, 1);
    assert.equal(routed(ctx, "stdin_idle_delivery").length, 2, "both messages are routed as delivered");
  });
});

test("idle hold: a second message's follow-up answer is waited for, inside the same timer", async () => {
  await withManager(async (ctx) => {
    const { child, written } = await startIdle(ctx, ROWS_ON);
    fakeTimers();
    assert.equal(await ctx.manager.deliverMessage("agent-1", message(1)), true);
    await vi.advanceTimersByTimeAsync(100);
    assert.equal(await ctx.manager.deliverMessage("agent-1", message(2, RANDOM_CHANNEL)), true);
    ctx.rowsCalls[0]!.respond(answer([serverRow(GENERAL, "#general", 7)]));
    await vi.advanceTimersByTimeAsync(10);
    assert.equal(writes(child, written).length, 0, "the first answer does not cover the second message: still held");
    assert.equal(ctx.rowsCalls.length, 2, "one follow-up");
    assert.deepEqual(ctx.rowsCalls[1]!.targets, [{ channelId: RANDOM, newestSeq: 2 }, { channelId: GENERAL, newestSeq: 1 }]);
    ctx.rowsCalls[1]!.respond(answer([serverRow(RANDOM, "#random", 2), serverRow(GENERAL, "#general", 7)]));
    await vi.advanceTimersByTimeAsync(10);
    const out = writes(child, written);
    assert.equal(out.length, 1);
    assert.ok(out[0]!.text.includes("#general · 7 unread"));
    assert.ok(out[0]!.text.includes("#random · 2 unread"));
  });
});

test("idle hold: the agent counts as having work while it holds (no idle notice, no quiet stop), and a transient notice is not held", async () => {
  await withManager(async (ctx) => {
    const { ap, child, written } = await startIdle(ctx, ROWS_ON);
    assert.equal(await ctx.manager.deliverMessage("agent-1", message(1)), true);
    assert.equal((ctx.manager as any).hasUntoldInboxWork(ap), true);
    // Even if the held message were already told, the hold itself is pending work.
    ap.inbox.length = 0;
    assert.equal((ctx.manager as any).hasUntoldInboxWork(ap), true);
    assert.equal(ctx.manager.idleNoticeFacts("agent-1")?.deliveriesPending, true);
    assert.equal(await ctx.manager.deliverIdleNotice("agent-1", "[Raft task notice: 1 task is waiting on you.]"), "messages_pending");
    // What the warm-recycle quiet stop, the cold-idle check and the idle reminder all read.
    assert.equal((ctx.manager as any).agentNotIdle("agent-1", ap), "delivery_in_flight");
    ap.config = { ...ap.config, wakeRecycleWarm: true };
    assert.equal((ctx.manager as any).warmRecycleStoppable("agent-1", ap), false);
    assert.equal(writes(child, written).length, 0);

    // A transient notice lists no unread rows: it goes at once, ahead of the hold.
    const transient = { ...message(50), sender_type: "system", sender_name: "System", content: "a transient notice" } as AgentMessage;
    assert.equal(await ctx.manager.deliverMessage("agent-1", transient, { transient: true } as any), true);
    assert.equal(writes(child, written).length, 1, "written without waiting");
    assert.equal(routed(ctx, "stdin_idle_transient_delivery").length, 1);
  });
});

test("idle hold: the agent became busy by another route; nothing is written for the hold, and the messages go by the ordinary busy notice", async () => {
  await withManager(async (ctx) => {
    const { ap, child, written } = await startIdle(ctx, ROWS_ON);
    fakeTimers();
    assert.equal(await ctx.manager.deliverMessage("agent-1", message(1)), true);
    // Another route starts a turn while the ask is out.
    (ctx.manager as any).commitApmIdleState("agent-1", ap, false);
    ctx.rowsCalls[0]!.respond(answer([serverRow(GENERAL, "#general", 7)]));
    await vi.advanceTimersByTimeAsync(10);
    assert.equal(writes(child, written).length, 0, "the held delivery did not write into the other turn");
    assert.equal(ap.pendingIdleInboxHold, null);
    assert.deepEqual(ap.inbox.map((m: AgentMessage) => m.message_id), ["msg-1"], "still queued");
    assert.equal(named(ctx, "daemon.agent.idle_inbox_hold.cancelled")[0]!.reason, "not_deliverable_at_answer");
    // Queued as a message for a busy agent is: the busy notice tells it, with the answer that is here.
    fireOrdinaryDelivery(ctx, ap, 1);
    const out = writes(child, written);
    assert.equal(out.length, 1);
    assert.ok(out[0]!.text.includes("#general · 7 unread"));
  });
});

test("idle hold: a drain that begins during the hold; nothing is written under it, and its end hands the message over", async () => {
  await withManager(async (ctx) => {
    const { ap, child, written } = await startIdle(ctx, ROWS_ON);
    assert.equal(await ctx.manager.deliverMessage("agent-1", message(1)), true);
    // A drain's quiet ignores the untold inbox by design (it holds deliveries itself): the held message does not keep it waiting.
    const summary = await ctx.manager.beginDrain({ deadlineMs: 60_000 });
    assert.equal(summary.finished, "quiet");
    ctx.rowsCalls[0]!.respond(answer([serverRow(GENERAL, "#general", 7)]));
    await flush();
    assert.equal(writes(child, written).length, 0, "the hold does not start a turn under a drain");
    assert.equal(ap.pendingIdleInboxHold, null);
    assert.deepEqual(ap.inbox.map((m: AgentMessage) => m.message_id), ["msg-1"], "kept, as a delivery the drain holds");
    (ctx.manager as any).sendStdinNotification("agent-1");
    assert.equal(writes(child, written).length, 0, "the ordinary delivery is held by the drain too");
    ctx.manager.endDrain();
    await flush();
    const out = writes(child, written);
    assert.equal(out.length, 1, "the end of the drain hands it over");
    assert.ok(out[0]!.text.includes("#general · 7 unread"));
  });
});

test("idle hold: a stop during the hold writes nothing, cancels the timer and the ask, and the message goes where a stop sends any queued message", async () => {
  await withManager(async (ctx) => {
    const { ap, child, written } = await startIdle(ctx, ROWS_ON);
    fakeTimers();
    assert.equal(await ctx.manager.deliverMessage("agent-1", message(1)), true);
    assert.ok(ap.pendingIdleInboxHold);
    // The timers stay fake through the stop, so the hold's own timer would be seen firing.
    const stopped = ctx.manager.stopAgent("agent-1", { silent: true });
    assert.equal(ap.pendingIdleInboxHold, null, "the hold's timer is cancelled");
    assert.equal(ctx.rowsCalls[0]!.signal?.aborted, true, "the ask is aborted");
    await vi.advanceTimersByTimeAsync(1_000);
    await stopped;
    assert.equal(writes(child, written).length, 0, "past the hold's 800 ms: nothing written to the stopped session");
    assert.deepEqual(named(ctx, INBOX_ROWS_CALL_EVENT).map((attrs) => attrs.failure_reason), ["aborted"]);
    // The hold took nothing out of the inbox: the stop found the message there and handed it on as it
    // does every queued message (never written, so it stays unread on the Server for the next start).
    assert.deepEqual(named(ctx, "daemon.agent.inbox.dropped_on_exit").map((attrs) => [attrs.exit_reason, attrs.dropped_count]), [["silent_stop", 1]]);
    // A late answer does nothing.
    ctx.rowsCalls[0]!.respond(answer([serverRow(GENERAL, "#general", 7)]));
    await vi.advanceTimersByTimeAsync(1_000);
    assert.equal(writes(child, written).length, 0);
  });
});

test("idle hold: the session is reset during the hold; nothing is written to the old session, and the new session starts with the message", async () => {
  await withManager(async (ctx) => {
    const { ap, child, written } = await startIdle(ctx, ROWS_ON);
    assert.equal(await ctx.manager.deliverMessage("agent-1", message(1)), true);
    assert.ok(ap.pendingIdleInboxHold);
    // The session no longer fits the model: the daemon drops it and starts a new one with what was
    // queued (the reset a runtime's "input too large" error leads to, entered here directly).
    (ctx.manager as any).actOnStickyFailure(
      "agent-1",
      ap,
      { kind: "input_too_large", detail: "the session no longer fits the model's input limit" },
      { failureKind: "sticky_runtime_error", fingerprint: "test-fingerprint" },
    );
    await waitFor(() => ctx.driver.processes.length > 1, "the new session's process");
    assert.equal(named(ctx, "daemon.agent.session_replaced").length, 1);
    assert.equal(ap.pendingIdleInboxHold, null, "the hold's timer is cancelled");
    assert.equal(ctx.rowsCalls[0]!.signal?.aborted, true, "the old session's ask is aborted");
    assert.equal(writes(child, written).length, 0, "nothing written to the old session");
    const start = ctx.driver.spawnCalls.at(-1)!;
    assert.equal(start.config.sessionId, null, "a new session");
    assert.ok(String(start.prompt).includes("#general"), "the held message is in the new session's first input");
    // A late answer for the old session writes nothing anywhere.
    ctx.rowsCalls[0]!.respond(answer([serverRow(GENERAL, "#general", 7)]));
    await flush();
    assert.equal(writes(child, written).length, 0);
    assert.equal(ctx.driver.processes.at(-1)!.stdinWrites.some((write) => write.includes("7 unread")), false);
  });
});

test("idle hold: the session switches during the hold; the release writes nothing though the new session takes deliveries, and the ordinary delivery tells the message there", async () => {
  // A runtime whose session takes deliveries from its `session_init`: at the release the process is
  // idle and deliverable on the NEW session, so only the hold's own session check keeps the write back.
  await withManager(async (ctx) => {
    const { ap, child, written } = await startIdle(ctx, ROWS_ON);
    fakeTimers();
    assert.equal(await ctx.manager.deliverMessage("agent-1", message(1)), true);
    const hold = ap.pendingIdleInboxHold;
    ctx.driver.parsedLines.set("session-switch", [{ kind: "session_init", sessionId: "session-other" }]);
    child.stdout.emit("data", Buffer.from("session-switch\n"));
    assert.equal(ap.sessionId, "session-other");
    // Everything else the release checks holds for the new session.
    assert.equal(isIdle(ctx, ap), true);
    assert.equal((ctx.manager as any).canDeliverToRuntimeSession(ap), true);
    assert.equal(ctx.rowsCalls[0]!.signal?.aborted, true, "the old session's ask is aborted");
    // The aborted ask releases the hold; were it not for the session, this would write.
    await vi.advanceTimersByTimeAsync(10);
    assert.notEqual(ap.pendingIdleInboxHold, hold);
    assert.equal(ap.pendingIdleInboxHold, null);
    assert.equal(writes(child, written).length, 0, "no write at the release");
    assert.deepEqual(named(ctx, "daemon.agent.idle_inbox_hold.cancelled").map((attrs) => [attrs.reason, attrs.requeued_notification_count]), [["not_deliverable_at_answer", 1]]);
    assert.equal(routed(ctx, "stdin_idle_delivery").length, 0);
    assert.deepEqual(ap.inbox.map((m: AgentMessage) => m.message_id), ["msg-1"], "still queued");
    // Past the hold's own timer, and with the old session's answer arriving late: still nothing.
    ctx.rowsCalls[0]!.respond(answer([serverRow(GENERAL, "#general", 7)]));
    await vi.advanceTimersByTimeAsync(1_000);
    assert.equal(writes(child, written).length, 0);
    fireOrdinaryDelivery(ctx, ap, 1);
    const out = writes(child, written);
    assert.equal(out.length, 1, "told once, by the ordinary delivery");
    assert.equal(out[0]!.sessionId, "session-other");
    assert.ok(out[0]!.text.includes("#general"));
    assert.equal(out[0]!.text.includes("7 unread"), false, "the old session's answer is not the new session's");
  }, new FakeClaudeDriver({ liveSessionReadyAt: "session_init" }));
});

test("idle hold: a replaced config ends the hold without a write; the message goes by the ordinary delivery", async () => {
  await withManager(async (ctx) => {
    const { ap, child, written } = await startIdle(ctx, ROWS_ON);
    fakeTimers();
    assert.equal(await ctx.manager.deliverMessage("agent-1", message(1)), true);
    ctx.manager.applyConfig("agent-1", makeConfig({ sessionId: SESSION, ...ROWS_ON, description: "edited" }), 7);
    assert.equal(ap.pendingIdleInboxHold, null);
    assert.equal(named(ctx, "daemon.agent.idle_inbox_hold.cancelled")[0]!.reason, "config_applied");
    await vi.advanceTimersByTimeAsync(800);
    assert.equal(writes(child, written).length, 0, "the hold's timer is gone");
    assert.deepEqual(ap.inbox.map((m: AgentMessage) => m.message_id), ["msg-1"]);
    fireOrdinaryDelivery(ctx, ap, 1);
    assert.equal(writes(child, written).filter((write) => write.text.includes("#general")).length, 1, "told by the ordinary delivery");
  });
});

test("idle hold: a tracked mention is pending while held and acked only when the write runs", async () => {
  await withManager(async (ctx) => {
    const { ap, child, written } = await startIdle(ctx, ROWS_ON);
    const transitions: string[] = [];
    let acks = 0;
    const mention = { ...message(1), mentioned: true } as AgentMessage;
    assert.equal(await ctx.manager.deliverMessage("agent-1", mention, {
      deliveryId: "occ-1",
      mentionDelivery: { occurrenceId: "occ-1", messageId: "msg-1", launchId: ap.launchId, sessionId: ap.sessionId },
      onMentionTransition: (stage: string) => { transitions.push(stage); },
      onMentionAck: () => { acks += 1; },
      onMentionTerminalError: (code: string) => { transitions.push(`error:${code}`); },
    } as any), true);
    const tracked = (ctx.manager as any).trackedMentionDeliveries.get("occ-1");
    assert.equal(tracked.state, "pending", "never left `received` across the hold");
    assert.deepEqual(transitions, ["daemon_received", "daemon_pending"]);
    assert.equal(acks, 0, "not acked before the write");
    assert.equal(writes(child, written).length, 0);

    ctx.rowsCalls[0]!.respond(answer([serverRow(GENERAL, "#general", 7)]));
    await flush();
    assert.equal(writes(child, written).length, 1);
    assert.deepEqual(transitions, ["daemon_received", "daemon_pending", "daemon_drained"]);
    assert.equal(acks, 1, "acked with the write");
  });
});

test("idle hold: a tracked mention whose hold is cancelled stays pending, unacked, with its message queued", async () => {
  await withManager(async (ctx) => {
    const { ap, child, written } = await startIdle(ctx, ROWS_ON);
    let acks = 0;
    const errors: string[] = [];
    const mention = { ...message(1), mentioned: true } as AgentMessage;
    assert.equal(await ctx.manager.deliverMessage("agent-1", mention, {
      deliveryId: "occ-1",
      mentionDelivery: { occurrenceId: "occ-1", messageId: "msg-1", launchId: ap.launchId, sessionId: ap.sessionId },
      onMentionAck: () => { acks += 1; },
      onMentionTerminalError: (code: string) => { errors.push(code); },
    } as any), true);
    (ctx.manager as any).commitApmIdleState("agent-1", ap, false);
    ctx.rowsCalls[0]!.respond(failure(503));
    await flush();
    assert.equal(writes(child, written).length, 0);
    assert.equal((ctx.manager as any).trackedMentionDeliveries.get("occ-1").state, "pending");
    assert.equal(acks, 0);
    assert.deepEqual(errors, []);
    assert.deepEqual(ap.inbox.map((m: AgentMessage) => m.message_id), ["msg-1"]);
  });
});

test("busy, flag on: a queued message starts one ask, more messages fold into one follow-up, and the busy notice prints what the answer covers", async () => {
  await withManager(async (ctx) => {
    const { ap, child, written } = await startIdle(ctx, ROWS_ON);
    (ctx.manager as any).commitApmIdleState("agent-1", ap, false);
    assert.equal(await ctx.manager.deliverMessage("agent-1", message(1)), true);
    assert.equal(ap.pendingIdleInboxHold, null, "a busy agent holds nothing");
    assert.equal(ctx.rowsCalls.length, 1);
    for (const seq of [2, 3, 4]) assert.equal(await ctx.manager.deliverMessage("agent-1", message(seq)), true);
    assert.equal(ctx.rowsCalls.length, 1, "never one request per message");
    ctx.rowsCalls[0]!.respond(answer([serverRow(GENERAL, "#general", 1)]));
    await flush();
    assert.equal(ctx.rowsCalls.length, 2, "one follow-up for what arrived meanwhile");
    assert.deepEqual(ctx.rowsCalls[1]!.targets, [{ channelId: GENERAL, newestSeq: 4 }]);

    // The notice is due before the follow-up answered: the first answer is older than message 4, so no number.
    (ctx.manager as any).sendStdinNotification("agent-1");
    const first = writes(child, written)[0]!.text;
    assert.ok(first.startsWith("[Raft inbox notice: new since your last notice, in 1 target\n#general · latest @someone\n"), first);
    assert.equal(first.includes("Older unread"), false);
    assert.deepEqual(named(ctx, INBOX_ROWS_NOTICE_EVENT).map((attrs) => [attrs.call_site, attrs.answer_used, attrs.numberless_rows]), [["queued", false, 1]]);

    // The follow-up answers; the next message's notice finds an answer that covers it only once its own ask did.
    ctx.rowsCalls[1]!.respond(answer([serverRow(GENERAL, "#general", 4)]));
    await flush();
    assert.equal(await ctx.manager.deliverMessage("agent-1", message(5)), true);
    assert.equal(ctx.rowsCalls.length, 3);
    ctx.rowsCalls[2]!.respond(answer([serverRow(GENERAL, "#general", 5)], { conversations: 1, messages: 3, mentions: 0, dms: 0 }));
    await flush();
    (ctx.manager as any).releaseNoticeHold("agent-1", ap, "inbox_read");
    (ctx.manager as any).sendStdinNotification("agent-1");
    const second = writes(child, written).at(-1)!.text;
    assert.ok(second.includes("#general · 5 unread"), second);
    assert.deepEqual(named(ctx, INBOX_ROWS_NOTICE_EVENT).at(-1), { agentId: "agent-1", host: "legacy", call_site: "queued", answer_used: true, listed_rows: 1, numberless_rows: 0 });
  });
});

test("after a 404 the session is not asked again and its notices are today's", async () => {
  await withManager(async (ctx) => {
    const { child, written } = await startIdle(ctx, ROWS_ON);
    assert.equal(await ctx.manager.deliverMessage("agent-1", message(1)), true);
    ctx.rowsCalls[0]!.respond(failure(404));
    await flush();
    assert.deepEqual(writes(child, written).map((write) => write.text), [TODAY_ITEMS_NOTICE], "the Server has no inbox items: today's notice");
    assert.equal(await ctx.manager.deliverMessage("agent-1", message(2)), true);
    (ctx.manager as any).sendStdinNotification("agent-1");
    assert.equal(ctx.rowsCalls.length, 1, "no more asks for this session");
    assert.equal(writes(child, written).length, 2);
  });
});

const trackedContext = (ap: any, occurrenceId: string, messageId: string, seen: { acks: number; errors: string[] }) => ({
  deliveryId: occurrenceId,
  mentionDelivery: { occurrenceId, messageId, launchId: ap.launchId, sessionId: ap.sessionId },
  onMentionAck: () => { seen.acks += 1; },
  onMentionTerminalError: (code: string) => { seen.errors.push(code); },
}) as any;

test("busy, flag on, a tracked mention: exactly one request, and its notice row has the Server's number", async () => {
  await withManager(async (ctx) => {
    const { ap, child, written } = await startIdle(ctx, ROWS_ON);
    (ctx.manager as any).commitApmIdleState("agent-1", ap, false);
    const seen = { acks: 0, errors: [] as string[] };
    const mention = { ...message(1), mentioned: true } as AgentMessage;
    assert.equal(await ctx.manager.deliverMessage("agent-1", mention, trackedContext(ap, "occ-1", "msg-1", seen)), true);
    assert.equal(routed(ctx, "queued_busy_mention").length + routed(ctx, "queued_busy_notification").length, 1, "queued as a busy mention is");
    assert.equal(ctx.rowsCalls.length, 1, "exactly one request");
    assert.deepEqual(ctx.rowsCalls[0]!.targets, [{ channelId: GENERAL, newestSeq: 1 }]);
    ctx.rowsCalls[0]!.respond(answer([{ ...serverRow(GENERAL, "#general", 3), mentions: 1 }]));
    await flush();
    (ctx.manager as any).sendStdinNotification("agent-1");
    const out = writes(child, written);
    assert.equal(out.length, 1);
    assert.ok(out[0]!.text.includes("#general · 3 unread · mentions you"), out[0]!.text);
    assert.equal(ctx.rowsCalls.length, 1);
    assert.deepEqual(named(ctx, INBOX_ROWS_CALL_EVENT).map((attrs) => attrs.call_site), ["queued"]);
  });
});

test("queued while a drain holds deliveries, or the runtime backs off after an error: asked about too; while the process is stopping: not", async () => {
  await withManager(async (ctx) => {
    const { ap } = await startIdle(ctx, ROWS_ON);
    await ctx.manager.beginDrain({ deadlineMs: 60_000 });
    assert.equal(await ctx.manager.deliverMessage("agent-1", message(1)), true);
    assert.equal(routed(ctx, "held_for_drain").length, 1);
    assert.equal(ctx.rowsCalls.length, 1, "held for the drain: its end's notice finds the rows");
    ctx.rowsCalls[0]!.respond(answer([serverRow(GENERAL, "#general", 1)]));
    await flush();
    ctx.manager.endDrain();
    await flush();
    (ctx.manager as any).commitApmIdleState("agent-1", ap, false);

    // The process is being stopped: this session prints no further notice.
    ap.gatedSteering = { ...ap.gatedSteering, expectedTerminationReason: "explicit_stop" };
    assert.equal(await ctx.manager.deliverMessage("agent-1", message(2)), true);
    assert.equal(routed(ctx, "queued_while_stopping").length, 1);
    assert.equal(ctx.rowsCalls.length, 1, "no request for a stopping process");
    ap.gatedSteering = { ...ap.gatedSteering, expectedTerminationReason: null };
  });
});

test("idle hold: a re-sent delivery whose copy is already pending under another seq still ends in one write and a settled mention", async () => {
  await withManager(async (ctx) => {
    const { ap, child, written } = await startIdle(ctx, ROWS_ON);
    // The first copy is already queued and untold (it arrived while deliveries were held).
    const copy = message(1);
    ap.inbox.push(copy);
    const seen = { acks: 0, errors: [] as string[] };
    const resent = { ...message(1), seq: 2, mentioned: true } as AgentMessage;
    assert.equal(await ctx.manager.deliverMessage("agent-1", resent, trackedContext(ap, "occ-1", "msg-1", seen)), true);
    const hold = ap.pendingIdleInboxHold;
    assert.ok(hold, "held");
    assert.equal(ap.inbox.length, 1, "the queue coalesced it (same message id)");
    assert.deepEqual(hold.messages, [copy], "the hold tells the copy that is pending");
    ctx.rowsCalls[0]!.respond(answer([serverRow(GENERAL, "#general", 4)]));
    await flush();
    const out = writes(child, written);
    assert.equal(out.length, 1, "one write");
    assert.ok(out[0]!.text.includes("#general · 4 unread"));
    assert.equal(seen.acks, 1, "the mention is settled by that write");
    assert.deepEqual(seen.errors, []);
    assert.equal((ctx.manager as any).trackedMentionDeliveries.get("occ-1")?.state, "drained");
  });
});

test("idle hold: of two tracked mentions held, the one the agent read before the release is not settled again by it", async () => {
  await withManager(async (ctx) => {
    const { ap, child, written } = await startIdle(ctx, ROWS_ON);
    const first = { acks: 0, errors: [] as string[] };
    const second = { acks: 0, errors: [] as string[] };
    const m1 = { ...message(1), mentioned: true } as AgentMessage;
    const m2 = { ...message(2, RANDOM_CHANNEL), mentioned: true } as AgentMessage;
    assert.equal(await ctx.manager.deliverMessage("agent-1", m1, trackedContext(ap, "occ-1", "msg-1", first)), true);
    assert.equal(await ctx.manager.deliverMessage("agent-1", m2, trackedContext(ap, "occ-2", "msg-2", second)), true);
    assert.equal(ap.pendingIdleInboxHold.tracked.length, 2);
    // The agent reads the first itself (`raft message check` through this daemon): that read acks it.
    (ctx.manager as any).consumeVisibleMessages("agent-1", { messages: [m1], source: "agent_api_check" });
    assert.deepEqual(ap.inbox.map((m: AgentMessage) => m.message_id), ["msg-2"]);
    const acksAfterRead = first.acks;
    assert.equal(acksAfterRead, 1, "acked by the read");

    ctx.rowsCalls[0]!.respond(answer([serverRow(GENERAL, "#general", 7)]));
    await flush();
    ctx.rowsCalls[1]?.respond(answer([serverRow(RANDOM, "#random", 2)]));
    await flush();
    const out = writes(child, written);
    assert.equal(out.length, 1);
    assert.ok(out[0]!.text.includes("#random"));
    assert.equal(out[0]!.text.includes("#general"), false, "the read message is not told");
    assert.equal(first.acks, acksAfterRead, "not acked a second time by the release");
    assert.deepEqual(first.errors, []);
    assert.equal(second.acks, 1, "the one the write told is settled by it");
  });
});

test("idle hold: a tracked mention purged during the hold is never acked; with nothing left to tell there is no write and it ends refused", async () => {
  await withManager(async (ctx) => {
    const { ap, child, written } = await startIdle(ctx, ROWS_ON);
    const seen = { acks: 0, errors: [] as string[] };
    const mention = { ...message(1), mentioned: true } as AgentMessage;
    assert.equal(await ctx.manager.deliverMessage("agent-1", mention, trackedContext(ap, "occ-1", "msg-1", seen)), true);
    assert.equal(ctx.manager.purgeInboxMessagesForChannels("agent-1", [GENERAL]).removedCount, 1);
    ctx.rowsCalls[0]!.respond(answer([serverRow(GENERAL, "#general", 7)]));
    await flush();
    assert.equal(writes(child, written).length, 0, "nothing to tell");
    assert.equal(isIdle(ctx, ap), true, "no turn was claimed");
    assert.equal(ap.pendingIdleInboxHold, null);
    assert.equal(seen.acks, 0, "never acked: it was never written");
    assert.deepEqual(seen.errors, ["DELIVERY_REJECTED"], "and not left pending on an idle agent");
    assert.equal((ctx.manager as any).trackedMentionDeliveries.has("occ-1"), false);
  });
});

test("idle hold: a message that starts no ask of its own (the rows route went away mid-hold) joins the hold and goes with the batch", async () => {
  await withManager(async (ctx) => {
    const { ap, child, written } = await startIdle(ctx, ROWS_ON);
    fakeTimers();
    assert.equal(await ctx.manager.deliverMessage("agent-1", message(1)), true);
    const hold = ap.pendingIdleInboxHold;
    // The connection dropped: nothing more is asked.
    ctx.manager.setServerInboxRowsCapable(false);
    assert.equal(await ctx.manager.deliverMessage("agent-1", message(2, RANDOM_CHANNEL)), true);
    assert.equal(ctx.rowsCalls.length, 1, "no ask for the second message");
    assert.equal(ap.pendingIdleInboxHold, hold, "it joined the hold");
    assert.equal(hold.messages.length, 2);
    assert.equal(isIdle(ctx, ap), true);
    assert.equal(writes(child, written).length, 0, "not delivered on its own ahead of the held one");
    await vi.advanceTimersByTimeAsync(800);
    const out = writes(child, written);
    assert.equal(out.length, 1, "one write for both, at the hold's timer");
    assert.ok(out[0]!.text.includes("#general") && out[0]!.text.includes("#random"));
  });
});

test("a notice that is not written records nothing: no older-unread memory, no notice event", async () => {
  await withManager(async (ctx) => {
    const { ap, child, written } = await startIdle(ctx, ROWS_ON);
    assert.equal(await ctx.manager.deliverMessage("agent-1", message(1)), true);
    ctx.driver.refuseInput = true;
    ctx.rowsCalls[0]!.respond(answer([serverRow(GENERAL, "#general", 7)]));
    await flush();
    assert.equal(writes(child, written).length, 0, "the write failed");
    assert.equal(ap.notifications.previousOlderMessages(SESSION), null, "the 9 older messages were composed, not shown");
    assert.equal(named(ctx, INBOX_ROWS_NOTICE_EVENT).length, 0);
    assert.deepEqual(ap.inbox.map((m: AgentMessage) => m.message_id), ["msg-1"], "still queued");
  });
});

test("a numberless notice does not wipe the older-unread memory: the next notice with the same number does not repeat the line", async () => {
  await withManager(async (ctx) => {
    const { ap, child, written } = await startIdle(ctx, ROWS_ON);
    assert.equal(await ctx.manager.deliverMessage("agent-1", message(1)), true);
    ctx.rowsCalls[0]!.respond(answer([serverRow(GENERAL, "#general", 1)]));
    await flush();
    assert.ok(writes(child, written)[0]!.text.includes("Older unread: 9 messages in 2 targets."));
    assert.equal(ap.notifications.previousOlderMessages(SESSION), 9);

    // Busy now. The next message's ask fails: its notice has no numbers and no older-unread line.
    assert.equal(await ctx.manager.deliverMessage("agent-1", message(2)), true);
    ctx.rowsCalls[1]!.respond(failure(503));
    await flush();
    (ctx.manager as any).releaseNoticeHold("agent-1", ap, "inbox_read");
    (ctx.manager as any).sendStdinNotification("agent-1");
    assert.equal(writes(child, written).length, 2);
    assert.equal(writes(child, written)[1]!.text.includes("Older unread"), false);
    assert.equal(ap.notifications.previousOlderMessages(SESSION), 9, "what the last numbered notice showed stands");

    // The Server answers again with the same older unread: it was already shown, so it is not repeated.
    assert.equal(await ctx.manager.deliverMessage("agent-1", message(3)), true);
    ctx.rowsCalls[2]!.respond(answer([serverRow(GENERAL, "#general", 3)]));
    await flush();
    (ctx.manager as any).releaseNoticeHold("agent-1", ap, "inbox_read");
    (ctx.manager as any).sendStdinNotification("agent-1");
    const third = writes(child, written)[2]!.text;
    assert.ok(third.includes("#general · 3 unread"), third);
    assert.equal(third.includes("Older unread"), false, "unchanged since it was last shown");
  });
});

test("an app item whose channel id is a uuid is neither asked about nor counted as a listed conversation", async () => {
  await withManager(async (ctx) => {
    const { ap, child, written } = await startIdle(ctx, ROWS_ON);
    (ctx.manager as any).commitApmIdleState("agent-1", ap, false);
    const APP_CHANNEL = "11111111-aaaa-4bbb-8ccc-000000000009";
    const appItem = { ...exampleThirdPartyEvent(5, "app:stamp/pr-13754"), channel_id: APP_CHANNEL } as AgentMessage;
    assert.equal(await ctx.manager.deliverMessage("agent-1", appItem), true);
    assert.equal(ctx.rowsCalls.length, 0, "an app item alone asks nothing");
    assert.equal(await ctx.manager.deliverMessage("agent-1", message(6)), true);
    assert.equal(ctx.rowsCalls.length, 1);
    assert.deepEqual(ctx.rowsCalls[0]!.targets, [{ channelId: GENERAL, newestSeq: 6 }], "the conversation only");
    // Even if the Server answered a row under the app item's channel id, the app row is the Computer's own.
    ctx.rowsCalls[0]!.respond(answer([serverRow(GENERAL, "#general", 7), serverRow(APP_CHANNEL, "#not-the-app-item", 99)]));
    await flush();
    (ctx.manager as any).sendStdinNotification("agent-1");
    const text = writes(child, written)[0]!.text;
    assert.ok(text.startsWith("[Raft inbox notice: new since your last notice, in 2 targets\n"), text);
    assert.ok(text.includes("#general · 7 unread"), text);
    assert.equal(text.includes("99 unread"), false, text);
    assert.equal(text.includes("#not-the-app-item"), false, text);
    assert.ok(text.includes("app:stamp/pr-13754"), text);
    // Every listed CONVERSATION is covered and was the whole ask: the older-unread line is passed on.
    assert.ok(text.includes("Older unread: 9 messages in 2 targets."), text);
    assert.deepEqual(named(ctx, INBOX_ROWS_NOTICE_EVENT).map((attrs) => [attrs.listed_rows, attrs.numberless_rows]), [[1, 0]]);
  });
});

test("two listed rows under one channel id: neither prints the Server's number, and there is no Older unread line", async () => {
  await withManager(async (ctx) => {
    const { ap, child, written } = await startIdle(ctx, ROWS_ON);
    (ctx.manager as any).commitApmIdleState("agent-1", ap, false);
    assert.equal(await ctx.manager.deliverMessage("agent-1", message(1)), true);
    // A thread message that carries no channel id of its own: its row falls back to the parent's.
    const threadReply = {
      ...message(2),
      channel_id: undefined,
      channel_type: "thread",
      channel_name: "thread-aaaabbbb",
      parent_channel_id: GENERAL,
      parent_channel_name: "general",
      parent_channel_type: "channel",
    } as unknown as AgentMessage;
    assert.equal(await ctx.manager.deliverMessage("agent-1", threadReply), true);
    ctx.rowsCalls[0]!.respond(answer([serverRow(GENERAL, "#general", 1)]));
    await flush();
    ctx.rowsCalls[1]?.respond(answer([serverRow(GENERAL, "#general", 7)]));
    await flush();
    (ctx.manager as any).sendStdinNotification("agent-1");
    const text = writes(child, written)[0]!.text;
    assert.ok(text.startsWith("[Raft inbox notice: new since your last notice, in 2 targets\n"), text);
    assert.ok(text.includes("\n#general · latest @someone\n"), text);
    assert.ok(text.includes("\n#general:aaaabbbb · latest @someone\n"), text);
    assert.equal(text.includes("7 unread"), false, text);
    assert.equal(text.includes("Older unread"), false, text);
    assert.deepEqual(named(ctx, INBOX_ROWS_NOTICE_EVENT).map((attrs) => [attrs.answer_used, attrs.listed_rows, attrs.numberless_rows]), [[false, 2, 2]]);
  });
});

test("idle hold: a tracked mention purged during the hold and then cancelled (config replaced) is not left pending on the idle agent", async () => {
  await withManager(async (ctx) => {
    const { ap, child, written } = await startIdle(ctx, ROWS_ON);
    const seen = { acks: 0, errors: [] as string[] };
    const mention = { ...message(1), mentioned: true } as AgentMessage;
    assert.equal(await ctx.manager.deliverMessage("agent-1", mention, trackedContext(ap, "occ-1", "msg-1", seen)), true);
    assert.equal(ctx.manager.purgeInboxMessagesForChannels("agent-1", [GENERAL]).removedCount, 1);
    ctx.manager.applyConfig("agent-1", makeConfig({ sessionId: SESSION, ...ROWS_ON, description: "edited" }), 7);
    assert.equal(ap.pendingIdleInboxHold, null);
    const cancelled = named(ctx, "daemon.agent.idle_inbox_hold.cancelled")[0]!;
    assert.equal(cancelled.reason, "config_applied");
    assert.equal(cancelled.requeued_notification_count, 0);
    assert.equal(writes(child, written).length, 0);
    assert.equal(seen.acks, 0, "never acked: it was never written");
    assert.deepEqual(seen.errors, ["DELIVERY_REJECTED"], "settled at the cancel: no turn end is coming");
    assert.equal((ctx.manager as any).trackedMentionDeliveries.has("occ-1"), false);
    assert.equal(isIdle(ctx, ap), true);
  });
});

test("idle hold: a provider-limit backoff that reached the process during the hold; the release writes nothing and the backoff's timer owns the delivery", async () => {
  await withManager(async (ctx) => {
    const { ap, child, written } = await startIdle(ctx, ROWS_ON);
    fakeTimers();
    assert.equal(await ctx.manager.deliverMessage("agent-1", message(1)), true);
    assert.notEqual(ap.pendingIdleInboxHold, null);
    // Shared from another agent on the same sign-in while this one was held.
    ap.runtimeErrorDeliveryBackoff = { kind: "backing_off", attempts: 1, untilMs: Date.now() + 60_000, timer: null, reason: "rate_limited" };
    ctx.rowsCalls[0]!.respond(answer([serverRow(GENERAL, "#general", 7)]));
    await flush();
    assert.equal(writes(child, written).length, 0, "nothing is written into the limited account");
    assert.equal(ap.pendingIdleInboxHold, null);
    assert.equal(named(ctx, "daemon.agent.idle_inbox_hold.cancelled")[0]!.reason, "not_deliverable_at_answer");
    assert.equal(ap.notifications.hasTimer, false, "the busy notice timer is not started under the backoff");
    assert.notEqual(ap.runtimeErrorDeliveryBackoff.timer, null, "the backoff's own timer will tell the message");
    assert.deepEqual(ap.inbox.map((m: AgentMessage) => m.message_id), ["msg-1"]);
    await vi.advanceTimersByTimeAsync(3_500);
    assert.equal(writes(child, written).length, 0, "still nothing while the limit holds");
    clearTimeout(ap.runtimeErrorDeliveryBackoff.timer);
  });
});

test("idle hold: an interrupting config push stops the process; the hold ends with it and nothing is requeued", async () => {
  await withManager(async (ctx) => {
    const { ap, child, written } = await startIdle(ctx, ROWS_ON);
    assert.equal(await ctx.manager.deliverMessage("agent-1", message(1)), true);
    assert.notEqual(ap.pendingIdleInboxHold, null);
    ctx.manager.applyConfig("agent-1", makeConfig({ sessionId: SESSION, ...ROWS_ON, description: "edited" }), 7, { interrupt: true });
    await flush();
    assert.equal(named(ctx, "daemon.agent.idle_inbox_hold.cancelled").filter((attrs) => attrs.reason === "config_applied").length, 0, "no requeue right before the stop");
    assert.equal(ap.notifications.hasTimer, false);
    assert.equal(writes(child, written).length, 0);
  });
});
