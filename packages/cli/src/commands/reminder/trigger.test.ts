import assert from "node:assert/strict";
import { PassThrough, Readable } from "node:stream";
import { afterEach, beforeEach, test, vi } from "vitest";

import type { AgentContext } from "../../auth/env";
import { createCommandContext } from "../../core/context";
import { CliError, cliError } from "../../core/errors";
import type { CliIo } from "../../core/io";

const invokeAppAction = vi.hoisted(() => vi.fn());
vi.mock("../integration/invoke", () => ({ invokeAppAction }));

import { reminderTriggerCommand, type TriggerOpts } from "./trigger";

const NOW = "2026-08-31T08:00:00.000Z";

const agentContext: AgentContext = {
  agentId: "agent-1",
  serverUrl: "http://127.0.0.1:9898",
  serverId: "server-1",
  token: "proxy-token",
  clientMode: "managed-runner",
  secretSource: "agent-proxy-token-env",
  activeCapabilities: null,
};

function harness(stdin: NodeJS.ReadableStream = Object.assign(Readable.from([]), { isTTY: true })) {
  const stdout: string[] = [];
  const io: CliIo = {
    stdin,
    stdout: { write: (chunk: string | Uint8Array) => { stdout.push(String(chunk)); return true; } },
    stderr: { write: () => true },
  };
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => { throw new Error("the trigger goes through invokeAppAction"); },
  });
  return { ctx, stdout };
}

function answer(value: Record<string, unknown>) {
  invokeAppAction.mockResolvedValueOnce({ service: { clientId: "reminder" }, value });
}

async function run(opts: TriggerOpts, stdin?: NodeJS.ReadableStream): Promise<string> {
  const { ctx, stdout } = harness(stdin);
  await reminderTriggerCommand.handler(ctx, opts);
  return stdout.join("");
}

async function rejectsInvalid(opts: TriggerOpts, message: RegExp): Promise<void> {
  const { ctx } = harness();
  await assert.rejects(
    async () => reminderTriggerCommand.handler(ctx, opts),
    (error: unknown) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.code, "INVALID_ARG");
      assert.match(error.message, message);
      return true;
    },
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
  invokeAppAction.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

test("woke: sent, wakes you, and says until when later triggers are recorded", async () => {
  answer({ key: "slip_BTC", outcome: "woke", triggerCount: 1, firstTriggeredAt: NOW, lastTriggeredAt: NOW, nextWakeAllowedAt: "2026-08-31T08:10:00.000Z" });
  assert.equal(
    await run({ key: "slip_BTC", title: "BTC slipped 2%" }),
    "Triggered slip_BTC: sent; it wakes you. More triggers of slip_BTC until 08:10Z are recorded, not sent.\n"
      + "Next: raft reminder log --key slip_BTC lists its history.\n",
  );
});

test("the app's { ok, result, status } envelope is unwrapped (the live reminder.raft.build answer)", async () => {
  answer({ ok: true, status: 200, result: { key: "sage_cli_livetest", outcome: "woke", triggerCount: 1, firstTriggeredAt: NOW, lastTriggeredAt: NOW, nextWakeAllowedAt: "2026-08-31T08:10:00.000Z" } });
  assert.equal(
    await run({ key: "sage_cli_livetest", title: "live" }),
    "Triggered sage_cli_livetest: sent; it wakes you. More triggers of sage_cli_livetest until 08:10Z are recorded, not sent.\n"
      + "Next: raft reminder log --key sage_cli_livetest lists its history.\n",
  );
});

test("merged: recorded, not sent, with the count and when the next one is sent", async () => {
  answer({ key: "slip_BTC", outcome: "merged", triggerCount: 3, firstTriggeredAt: "2026-08-31T07:52:00.000Z", lastTriggeredAt: NOW, nextWakeAllowedAt: "2026-08-31T08:02:00.000Z" });
  assert.equal(
    await run({ key: "slip_BTC", title: "BTC slipped 2%" }),
    "Triggered slip_BTC: recorded, not sent (3 recorded since the last notice, the first at 07:52Z); the next one after 08:02Z is sent.\n"
      + "Next: raft reminder log --key slip_BTC lists its history.\n",
  );
});

test("recorded (level log): logged only, never wakes", async () => {
  answer({ key: "feed_down", outcome: "recorded", triggerCount: 2, firstTriggeredAt: NOW, lastTriggeredAt: NOW });
  assert.equal(
    await run({ key: "feed_down", title: "feed is down", level: "log" }),
    "Logged feed_down: recorded only; level log never wakes you.\n"
      + "Next: raft reminder log --key feed_down lists its history.\n",
  );
});

test("throttled: over the hourly cap, dated when the wake allowance is another UTC day", async () => {
  answer({ key: "feed_down", outcome: "throttled", triggerCount: 4, firstTriggeredAt: NOW, lastTriggeredAt: NOW, nextWakeAllowedAt: "2026-09-01T00:20:00.000Z" });
  assert.equal(
    await run({ key: "feed_down", title: "feed is down" }),
    "Triggered feed_down: recorded only, over this hour's wake cap; wakes are allowed again at 2026-09-01 00:20Z.\n"
      + "Next: raft reminder log --key feed_down lists its history.\n",
  );
});

test("payload: requestId per call, merge window in seconds, level, anchor from --channel and --message-id", async () => {
  answer({ key: "ci.main", outcome: "woke", triggerCount: 1, firstTriggeredAt: NOW, lastTriggeredAt: NOW, nextWakeAllowedAt: NOW });
  answer({ key: "ci.main", outcome: "woke", triggerCount: 1, firstTriggeredAt: NOW, lastTriggeredAt: NOW, nextWakeAllowedAt: NOW });
  await run({ key: "ci.main", title: "Build failed", level: "wake", mergeWindow: "1h", channel: "#ops:abcd1234", messageId: "deadbeef" });
  await run({ key: "ci.main", title: "Build failed", mergeWindow: "90s", channel: "dm:@alice", messageId: "cafebabe" });

  const [first, second] = invokeAppAction.mock.calls.map(([, input]) => input as { service: string; action: string; payload: Record<string, unknown> });
  assert.equal(first.service, "reminder");
  assert.equal(first.action, "trigger");
  assert.equal((first as { requireOfficial?: boolean }).requireOfficial, true, "only the platform-marked official Reminder app is called");
  const { requestId, ...rest } = first.payload;
  assert.match(String(requestId), /^[0-9a-f-]{36}$/);
  assert.deepEqual(rest, {
    key: "ci.main",
    title: "Build failed",
    level: "wake",
    mergeWindowSeconds: 3600,
    anchor: { channelType: "channel", channelName: "ops", threadId: "abcd1234", messageId: "deadbeef" },
  });
  assert.notEqual(second.payload.requestId, requestId);
  assert.equal(second.payload.mergeWindowSeconds, 90);
  assert.deepEqual(second.payload.anchor, { channelType: "dm", channelName: "alice", messageId: "cafebabe" });
  assert.equal("level" in second.payload, false);
  assert.equal("body" in second.payload, false);
});

test("details: --details text or --details - from stdin (trailing newline dropped); stdin is never read without -", async () => {
  for (let i = 0; i < 4; i++) answer({ key: "feed_down", outcome: "woke", triggerCount: 1, firstTriggeredAt: NOW, lastTriggeredAt: NOW, nextWakeAllowedAt: NOW });
  await run({ key: "feed_down", title: "feed is down", details: "-" }, Readable.from(["last tick 07:58Z\n", "source: binance\n"]));
  await run({ key: "feed_down", title: "feed is down", details: "-" }, Readable.from(["\n"]));
  await run({ key: "feed_down", title: "feed is down", details: "last tick 07:58Z" });
  // A loop's input on stdin stays the loop's: without --details - nothing is read from it.
  const loopInput = new PassThrough();
  loopInput.write("next line of the caller's loop\n");
  await run({ key: "feed_down", title: "feed is down" }, loopInput);
  assert.equal(loopInput.read()?.toString(), "next line of the caller's loop\n");
  const payloads = invokeAppAction.mock.calls.map(([, input]) => (input as { payload: Record<string, unknown> }).payload);
  assert.equal(payloads[0].body, "last tick 07:58Z\nsource: binance");
  assert.equal("body" in payloads[1], false);
  assert.equal(payloads[2].body, "last tick 07:58Z");
  assert.equal("body" in payloads[3], false);
});

test("details: --details - from a terminal, or more than 4 KB, is refused before any call", async () => {
  await rejectsInvalid({ key: "feed_down", title: "x", details: "-" }, /--details - reads the details from stdin, but stdin is a terminal/);
  const { ctx } = harness(Readable.from(["x".repeat(4097)]));
  await assert.rejects(async () => reminderTriggerCommand.handler(ctx, { key: "feed_down", title: "x", details: "-" }), /at most 4096 bytes; stdin had more/);
  await rejectsInvalid({ key: "feed_down", title: "x", details: "y".repeat(4097) }, /--details must be at most 4096 bytes; got 4097/);
  assert.equal(invokeAppAction.mock.calls.length, 0);
});

test("key, window, level, title and anchor are checked before any call, naming the rule and the bad value", async () => {
  await rejectsInvalid({ title: "x" }, /--key is required/);
  await rejectsInvalid({ key: "slip BTC", title: "x" }, /--key must be 1-64 characters of letters, digits, _ \. : or -, ending in a letter or digit; got "slip BTC"/);
  await rejectsInvalid({ key: "slip_", title: "x" }, /ending in a letter or digit; got "slip_"/);
  await rejectsInvalid({ key: "a".repeat(65), title: "x" }, /1-64 characters/);
  await rejectsInvalid({ key: "raft.throttled", title: "x" }, /must not start with "raft\." .*got "raft\.throttled"/);
  await rejectsInvalid({ key: "k1", title: "x", mergeWindow: "30s" }, /--merge-window must be a duration from 1m to 24h, like 90s, 10m or 1h; got "30s"/);
  await rejectsInvalid({ key: "k1", title: "x", mergeWindow: "2d" }, /got "2d"/);
  await rejectsInvalid({ key: "k1", title: "x", mergeWindow: "soon" }, /got "soon"/);
  await rejectsInvalid({ key: "k1", title: "x", level: "loud" }, /--level must be wake or log; got "loud"/);
  await rejectsInvalid({ key: "k1" }, /--title is required/);
  await rejectsInvalid({ key: "k1", title: "a\nb" }, /--title must be one line/);
  await rejectsInvalid({ key: "k1", title: "x".repeat(201) }, /at most 200 characters/);
  await rejectsInvalid({ key: "k1", title: "x", channel: "#ops" }, /--channel and --message-id go together/);
  await rejectsInvalid({ key: "k1", title: "x", messageId: "deadbeef" }, /--channel and --message-id go together/);
  await rejectsInvalid({ key: "k1", title: "x", channel: "@alice", messageId: "deadbeef" }, /--channel must be a channel, DM or thread .*got "@alice"/);
  assert.equal(invokeAppAction.mock.calls.length, 0);
});

test("no Reminder app on the server: REMINDER_APP_NOT_INSTALLED with where to look", async () => {
  invokeAppAction.mockRejectedValueOnce(cliError("INTEGRATION_NOT_FOUND", "No registered integration matched reminder"));
  const { ctx } = harness();
  await assert.rejects(
    async () => reminderTriggerCommand.handler(ctx, { key: "k1", title: "x" }),
    (error: unknown) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.code, "REMINDER_APP_NOT_INSTALLED");
      assert.equal(error.message, "The Reminder app isn't installed on this server, so nothing was triggered.");
      assert.equal(error.suggestedNextAction, "raft integration list shows what is installed; ask a server admin to install Reminder.");
      return true;
    },
  );
});

test("other invoke errors (login needed, the app's own answer) pass through unchanged", async () => {
  const appError = cliError("INTEGRATION_INVOKE_FAILED", "service action answered HTTP 403 FORBIDDEN:\nAgent-owned reminders are not enabled on this server.");
  invokeAppAction.mockRejectedValueOnce(appError);
  const { ctx } = harness();
  await assert.rejects(async () => reminderTriggerCommand.handler(ctx, { key: "k1", title: "x" }), (error: unknown) => error === appError);
});
