import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";
import type { ReminderSummary } from "@botiverse/raft-shared";

import type { ApiResponse } from "../../client";
import type { AgentContext } from "../../auth/env";
import { createCommandContext } from "../../core/context";
import { CliError, type CliErrorCode } from "../../core/errors";
import type { CliIo } from "../../core/io";

const invokeAppAction = vi.hoisted(() => vi.fn());
vi.mock("../integration/invoke", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../integration/invoke")>()),
  invokeAppAction,
}));

import { AppReplyTextError } from "../integration/invoke";
import { reminderCancelCommand } from "./cancel";
import { appListWidenedNote, reminderListCommand } from "./list";
import { reminderScheduleCommand, type ScheduleOpts } from "./schedule";
import { reminderShowCommand } from "./show";
import { reminderSnoozeCommand } from "./snooze";
import { reminderUpdateCommand } from "./update";

const NOW = "2026-08-31T08:00:00.000Z";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const agentContext: AgentContext = {
  agentId: "agent-1",
  serverUrl: "http://127.0.0.1:9898",
  serverId: "server-1",
  token: "proxy-token",
  clientMode: "self-hosted-runner",
  secretSource: "profile-credential-file",
  activeCapabilities: null,
};

function ok<T>(data: T): ApiResponse<T> {
  return { ok: true, status: 200, error: null, data };
}

function fail(status: number, error: string, errorCode?: string): ApiResponse<unknown> {
  return { ok: false, status, error, data: null, ...(errorCode ? { errorCode } : {}) };
}

function legacyReminder(overrides: Partial<ReminderSummary> = {}): ReminderSummary {
  return {
    reminderId: "aaaabbbb-0000-0000-0000-000000000000",
    ownerAgentId: "agent-1",
    title: "old follow-up",
    fireAt: "2026-08-31T09:00:00.000Z",
    firedAt: null,
    createdAt: "2026-08-30T09:00:00.000Z",
    status: "scheduled",
    msgRef: "#general:00000000",
    msgPermalink: null,
    recurrence: null,
    ...overrides,
  };
}

type Route = (method: string, path: string, body?: unknown) => ApiResponse<unknown> | undefined;

/** Messages the fake Server resolves (`raft message resolve`), by the id the command passes. */
const MESSAGES: Record<string, Record<string, unknown>> = {
  "7c41e2a0-aaaa-bbbb-cccc-000000000000": { message_id: "7c41e2a0-aaaa-bbbb-cccc-000000000000", channel_type: "channel", channel_name: "ops" },
  deadbeef: { message_id: "deadbeef-0000-0000-0000-000000000000", channel_type: "dm", channel_name: "alice" },
  // A reply in the thread of #ops whose first message is abcd1234.
  cafebabe1: { message_id: "cafebabe-1000-0000-0000-000000000000", channel_type: "thread", channel_name: "thread-abcd1234", parent_channel_type: "channel", parent_channel_name: "ops" },
  "11112222": { message_id: "11112222-0000-0000-0000-000000000000", channel_type: "channel", channel_name: "general" },
  // A reply in a DM thread.
  "33334444": { message_id: "33334444-0000-0000-0000-000000000000", channel_type: "thread", channel_name: "thread-55556666", parent_channel_type: "dm", parent_channel_name: "bob~agent" },
};

const resolveRoute: Route = (method, path) => {
  const id = /\/messages\/([^/]+)\/resolve/.exec(path)?.[1];
  if (method !== "GET" || !id) return undefined;
  const message = MESSAGES[decodeURIComponent(id)];
  return message ? ok({ message }) : fail(404, "Message not found", "NOT_FOUND");
};

/** A command run against a fake Server (`routes`, first match wins) and the mocked app call. */
function harness(opts: { reminderApp: boolean | "unreadable"; routes?: Route[] }) {
  const stdout: string[] = [];
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];
  const io: CliIo = {
    stdout: { write: (chunk: string | Uint8Array) => { stdout.push(String(chunk)); return true; } },
    stderr: { write: () => true },
  };
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (method: string, path: string, body?: unknown): Promise<ApiResponse<unknown>> => {
        requests.push({ method, path, body });
        if (/\/context$/.test(path)) {
          if (opts.reminderApp === "unreadable") return fail(503, "unavailable");
          return ok({
            agent: { id: "agent-1", name: "pilot", displayName: "Pilot", description: null, runtime: "claude", external: false },
            server: { id: "server-1", slug: "pilot", name: "Pilot" },
            credential: { capabilities: ["read", "send"] },
            prompt: null,
            features: { reminderApp: opts.reminderApp, vaultApp: false, enabledApps: [] },
          });
        }
        for (const route of [...(opts.routes ?? []), resolveRoute]) {
          const res = route(method, path, body);
          if (res) return res;
        }
        throw new Error(`unexpected request ${method} ${path}`);
      },
    }) as any,
  });
  return { ctx, stdout: () => stdout.join(""), requests };
}

function appAnswers(...values: unknown[]) {
  for (const value of values) invokeAppAction.mockResolvedValueOnce({ service: { clientId: "reminder" }, value });
}

function appCalls(): Array<{ action: string; payload: Record<string, unknown>; requireOfficial?: boolean }> {
  return invokeAppAction.mock.calls.map(([, input]) => input);
}

/** The app's error answer as invoke.ts raises it (status, code, reply text). */
function appError(status: number, code: string, text: string): AppReplyTextError {
  return new AppReplyTextError(
    { code: "INTEGRATION_INVOKE_FAILED" as CliErrorCode, message: `service action answered HTTP ${status} ${code}:\n  │ ${text}` },
    { httpStatus: status, appCode: code, reply: { text } },
  );
}

const scheduled = (text: string) => ({ ok: true, status: 200, result: { reminder: { id: "0191c135-1111-2222-3333-444444444444" } }, text });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
  invokeAppAction.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

test("gate on: schedule maps the flags to create-reminder's flat parameters and prints the app's text quoted", async () => {
  const text = "Scheduled 0191c135: check deploy, 08-31 08:30Z, in #ops:7c41e2a0. Details: raft reminder show --id 0191c135";
  appAnswers(scheduled(text), scheduled(text), scheduled(text));
  const runs: ScheduleOpts[] = [
    { title: "check deploy", delaySeconds: "1800", channel: "#ops", messageId: "7c41e2a0-aaaa-bbbb-cccc-000000000000" },
    { title: "standup", fireAt: "2026-09-01T09:00:00Z", tz: "Asia/Shanghai", channel: "dm:@alice", msgId: "deadbeef" },
    { title: "weekly", repeat: "weekly:mon,fri@10:00", channel: "#ops:abcd1234", messageId: "cafebabe1" },
  ];
  const outputs: string[] = [];
  for (const opts of runs) {
    const h = harness({ reminderApp: true });
    await reminderScheduleCommand.handler(h.ctx, opts);
    outputs.push(h.stdout());
    assert.equal(h.requests.some((r) => /\/reminders$/.test(r.path)), false, "no legacy create when the gate is on");
  }
  assert.equal(outputs[0], `  │ ${text}\n`, "the app's text, quoted like an app's, not JSON");

  const [first, second, third] = appCalls();
  assert.equal(first.action, "create-reminder");
  assert.equal(first.requireOfficial, true);
  const strip = ({ requestId, ...rest }: Record<string, unknown>) => {
    assert.match(String(requestId), UUID);
    return rest;
  };
  assert.deepEqual(strip(first.payload), { title: "check deploy", in: "1800s", anchor: "#ops:7c41e2a0" });
  assert.deepEqual(strip(second.payload), { title: "standup", at: "2026-09-01T09:00:00Z", timezone: "Asia/Shanghai", anchor: "dm:@alice:deadbeef" });
  const weekly = strip(third.payload);
  assert.equal(weekly.anchor, "#ops:abcd1234", "a thread reply anchors to its thread");
  assert.equal(weekly.repeat, "weekly:mon,fri@10:00");
  assert.equal(weekly.timezone, Intl.DateTimeFormat().resolvedOptions().timeZone, "--repeat without --tz takes this host's zone");
  assert.notEqual(first.payload.requestId, second.payload.requestId, "a fresh request id per command");
});

test("gate on: the anchor is where the message is, from the resolve route (a thread reply anchors to its thread)", async () => {
  appAnswers(scheduled("Scheduled 0191c135."), scheduled("Scheduled 0191c135."));
  for (const id of ["11112222", "33334444"]) {
    const h = harness({ reminderApp: true });
    await reminderScheduleCommand.handler(h.ctx, { title: "t", delaySeconds: "60", messageId: id });
    assert.ok(h.requests.some((r) => r.path.includes(`/messages/${id}/resolve`)));
  }
  assert.deepEqual(appCalls().map((c) => c.payload.anchor), ["#general:11112222", "dm:@bob~agent:55556666"]);

  const missing = harness({ reminderApp: true });
  await assert.rejects(
    async () => reminderScheduleCommand.handler(missing.ctx, { title: "t", delaySeconds: "60", messageId: "99990000" }),
    (error: unknown) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.code, "INVALID_ARG");
      assert.match(error.message, /Could not find message 99990000.*nothing was scheduled/);
      return true;
    },
  );
  assert.equal(invokeAppAction.mock.calls.length, 2, "nothing reaches the app without an anchor");
});

test("gate on: --channel naming another conversation than the message's is refused, saying where the message is", async () => {
  for (const [channel, messageId, where] of [
    ["#general", "7c41e2a0-aaaa-bbbb-cccc-000000000000", "#ops:7c41e2a0"],
    ["#ops:99998888", "cafebabe1", "#ops:abcd1234"],
    ["dm:@bob", "deadbeef", "dm:@alice:deadbeef"],
  ] as const) {
    const h = harness({ reminderApp: true });
    await assert.rejects(
      async () => reminderScheduleCommand.handler(h.ctx, { title: "t", delaySeconds: "60", channel, messageId }),
      (error: unknown) => {
        assert.ok(error instanceof CliError);
        assert.equal(error.code, "INVALID_ARG");
        assert.equal(error.message, `Message ${messageId} is in ${where}, not ${channel}; nothing was scheduled.`);
        assert.equal(error.suggestedNextAction, `Pass --channel ${where}, or leave --channel out.`);
        return true;
      },
    );
  }
  assert.equal(invokeAppAction.mock.calls.length, 0);
});

test("gate on: schedule keeps the legacy checks before any request", async () => {
  const h = harness({ reminderApp: true });
  for (const [opts, message] of [
    [{ title: "t", messageId: "11112222" }, /Provide --delay-seconds, --fire-at, or --repeat/],
    [{ title: "t", delaySeconds: "60", fireAt: "2026-09-01T00:00:00Z", messageId: "11112222" }, /not both/],
    [{ title: "t", delaySeconds: "60" }, /anchor msgId/],
    [{ title: "t", delaySeconds: "60", messageId: "a", msgId: "b" }, /--msg-id is a deprecated alias/],
  ] as const) {
    await assert.rejects(async () => reminderScheduleCommand.handler(h.ctx, opts as ScheduleOpts), message);
  }
  assert.equal(h.requests.length, 0);
});

test("gate off (and unreadable): schedule, snooze and list keep the legacy API and its output", async () => {
  for (const reminderApp of [false, "unreadable"] as const) {
    const h = harness({
      reminderApp,
      routes: [
        (method, path) => (method === "POST" && /\/reminders$/.test(path) ? ok({ reminder: legacyReminder() }) : undefined),
        (method, path) => (method === "POST" && /\/snooze$/.test(path) ? ok({ reminder: legacyReminder() }) : undefined),
        (method, path) => (method === "GET" && /\/reminders(\?|$)/.test(path) ? ok({ reminders: [legacyReminder()] }) : undefined),
      ],
    });
    await reminderScheduleCommand.handler(h.ctx, { title: "old follow-up", delaySeconds: "60", messageId: "11112222" });
    await reminderSnoozeCommand.handler(h.ctx, { id: "aaaabbbb-0000-0000-0000-000000000000", by: "30m" });
    await reminderListCommand.handler(h.ctx, {});
    assert.match(h.stdout(), /^Reminder scheduled: #aaaabbbb \(one-time\) "old follow-up"\nNext: /);
    assert.equal(
      h.stdout().includes("Reminders in the Reminder app: not checked"),
      reminderApp === "unreadable",
      "only a gate that could not be read says the app's reminders were not checked",
    );
    assert.equal(h.requests.filter((r) => /\/context$/.test(r.path)).length, reminderApp === "unreadable" ? 2 : 1, "one more read when the first gets no answer");
    assert.match(h.stdout(), /Reminder snoozed: #aaaabbbb/);
    assert.match(h.stdout(), /#aaaabbbb \[scheduled\]/);
    const create = h.requests.find((r) => r.method === "POST" && /\/reminders$/.test(r.path));
    assert.deepEqual(create?.body, { title: "old follow-up", msgId: "11112222", delaySeconds: 60 });
  }
  assert.equal(invokeAppAction.mock.calls.length, 0);
});

test("a legacy write refused with reminders_moved_to_app (nothing changed) is redone through the app", async () => {
  appAnswers(
    scheduled("Scheduled 0191c135: t, 08-31 08:01Z, in #ops:11112222."),
    { ok: true, status: 200, result: {}, text: "Snoozed 0191c135 by 30m: fires at 08-31 08:30Z." },
    { ok: true, status: 200, result: {}, text: "Updated 0191c135 (revision 2): title. Next 08-31 08:30Z." },
  );
  const moved = () => fail(409, "Reminders on this server moved to the Reminder app", "reminders_moved_to_app");
  const h = harness({
    reminderApp: false,
    routes: [
      (method, path) => (method === "GET" && /\/reminders(\?|$)/.test(path) ? ok({ reminders: [legacyReminder({ reminderId: "0191c135-1111-2222-3333-444444444444" })] }) : undefined),
      (method) => (method === "POST" || method === "PATCH" ? moved() : undefined),
    ],
  });
  await reminderScheduleCommand.handler(h.ctx, { title: "t", delaySeconds: "60", channel: "#general", messageId: "11112222" });
  await reminderSnoozeCommand.handler(h.ctx, { id: "0191c135", by: "30m" });
  await reminderUpdateCommand.handler(h.ctx, { id: "reminder:0191c135", title: "new" });
  assert.deepEqual(appCalls().map((c) => c.action), ["create-reminder", "snooze-reminder", "update-reminder"]);
  assert.deepEqual(appCalls()[1].payload, { id: "0191c135", by: "30m" });
  assert.deepEqual(appCalls()[2].payload, { id: "0191c135", title: "new" });
  assert.equal(
    h.stdout(),
    "  │ Scheduled 0191c135: t, 08-31 08:01Z, in #ops:11112222.\n"
      + "  │ Snoozed 0191c135 by 30m: fires at 08-31 08:30Z.\n"
      + "  │ Updated 0191c135 (revision 2): title. Next 08-31 08:30Z.\n",
  );
});

test("gate on: update sends several fields, --in as given, --cadence with this host's zone, --notes and --tz", async () => {
  appAnswers({ ok: true, status: 200, result: {}, text: "Updated 0191c135 (revision 3): schedule, notes." });
  const h = harness({ reminderApp: true });
  await reminderUpdateCommand.handler(h.ctx, { id: "0191c135", in: "2h", cadence: "daily@10:00", notes: "check the dashboard" });
  assert.deepEqual(appCalls()[0], {
    service: "reminder",
    action: "update-reminder",
    payload: { id: "0191c135", in: "2h", repeat: "daily@10:00", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, notes: "check the dashboard" },
    requireOfficial: true,
  });
  await assert.rejects(async () => reminderUpdateCommand.handler(h.ctx, { id: "0191c135" }), /Pass at least one of/);
});

test("an app error becomes the command's error: a fixed code, the app's code in details, its text quoted, 'Nothing was changed.' only for a refused write", async () => {
  invokeAppAction.mockRejectedValueOnce(appError(409, "reminder_paused", "This reminder is paused (see pause.reason). Update it to resume, or cancel it."));
  const h = harness({ reminderApp: true });
  await assert.rejects(
    async () => reminderSnoozeCommand.handler(h.ctx, { id: "0191c135", by: "30m" }),
    (error: unknown) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.code, "REMINDER_APP_REFUSED");
      assert.equal(error.details?.app_code, "reminder_paused");
      assert.equal(error.retryable, false);
      assert.equal(
        error.message,
        "The Reminder app refused it (HTTP 409 reminder_paused):\n"
          + "  │ This reminder is paused (see pause.reason). Update it to resume, or cancel it.\n"
          + "Nothing was changed.",
      );
      return true;
    },
  );

  invokeAppAction.mockRejectedValueOnce(appError(404, "reminder_not_found", "You have no reminder 0191c135. List yours: raft reminder list"));
  await assert.rejects(
    async () => reminderShowCommand.handler(h.ctx, { id: "0191c135" }),
    (error: unknown) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.code, "REMINDER_APP_REFUSED");
      assert.equal(
        error.message,
        "The Reminder app refused it (HTTP 404 reminder_not_found):\n  │ You have no reminder 0191c135. List yours: raft reminder list",
        "a read changes nothing anyway: no note",
      );
      return true;
    },
  );

  invokeAppAction.mockRejectedValueOnce(appError(500, "", "Operation failed. Please retry."));
  await assert.rejects(
    async () => reminderShowCommand.handler(h.ctx, { id: "0191c135" }),
    (error: unknown) => error instanceof CliError && error.code === "REMINDER_APP_FAILED" && error.retryable === true,
    "a read that failed on the app's side can simply run again",
  );
});

test("a create that failed on the app's side says it may have been applied, and is not retryable", async () => {
  invokeAppAction.mockRejectedValueOnce(appError(500, "", "Operation failed. Please retry."));
  const h = harness({ reminderApp: true });
  await assert.rejects(
    async () => reminderScheduleCommand.handler(h.ctx, { title: "t", delaySeconds: "60", messageId: "11112222" }),
    (error: unknown) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.code, "REMINDER_APP_FAILED");
      assert.equal(error.retryable, false);
      assert.match(error.message, /\nIt may or may not have been applied: check with raft reminder list \(or raft reminder show --id <id>\) before running it again\.$/);
      return true;
    },
  );
  assert.equal(invokeAppAction.mock.calls.length, 1, "a 500 is an answer: not sent again");
});

const cancelRoutes: Route[] = [
  (method, path) => (method === "GET" && path.includes("/inbox") ? ok({ items: [], seals: [] }) : undefined),
  (method, path) => (method === "GET" && /\/reminders(\?|$)/.test(path) ? ok({ reminders: [legacyReminder()] }) : undefined),
  (method, path) => (method === "DELETE" && path.includes("/reminders/aaaabbbb-") ? ok({ reminder: legacyReminder({ status: "canceled" }) }) : undefined),
];

test("gate on: cancel goes to the app; an id it does not know is canceled as a reminder from before the move", async () => {
  appAnswers({ ok: true, status: 200, result: {}, text: "Cancelled 0191c135: t. It will not fire again. Your reminders: raft reminder list" });
  const h = harness({ reminderApp: true, routes: cancelRoutes });
  await reminderCancelCommand.handler(h.ctx, { id: "0191c135" });
  assert.equal(h.stdout(), "  │ Cancelled 0191c135: t. It will not fire again. Your reminders: raft reminder list\n");
  assert.equal(h.requests.some((r) => r.method === "DELETE"), false);

  invokeAppAction.mockRejectedValueOnce(appError(404, "reminder_not_found", "You have no reminder aaaabbbb. List yours: raft reminder list"));
  const fallback = harness({ reminderApp: true, routes: cancelRoutes });
  await reminderCancelCommand.handler(fallback.ctx, { id: "aaaabbbb" });
  assert.equal(fallback.stdout(), 'Reminder canceled: #aaaabbbb [canceled] "old follow-up"\n');

  invokeAppAction.mockRejectedValueOnce(appError(404, "reminder_not_found", "You have no reminder ffff0000. List yours: raft reminder list"));
  const neither = harness({ reminderApp: true, routes: cancelRoutes });
  await assert.rejects(
    async () => reminderCancelCommand.handler(neither.ctx, { id: "ffff0000" }),
    (error: unknown) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.code, "REMINDER_APP_REFUSED");
      assert.equal(
        error.message,
        "The Reminder app refused it (HTTP 404 reminder_not_found):\n  │ You have no reminder ffff0000. List yours: raft reminder list\nNothing was changed.",
      );
      return true;
    },
  );
  assert.equal(neither.requests.some((r) => r.method === "DELETE"), false);
});

test("gate on: a short id the app does not know never cancels a reminder from before the move by prefix", async () => {
  invokeAppAction.mockRejectedValueOnce(appError(404, "reminder_not_found", "You have no reminder aaaa. List yours: raft reminder list"));
  const h = harness({ reminderApp: true, routes: cancelRoutes });
  await assert.rejects(
    async () => reminderCancelCommand.handler(h.ctx, { id: "aaaa" }),
    (error: unknown) => error instanceof CliError && error.code === "REMINDER_APP_REFUSED" && /You have no reminder aaaa/.test(error.message),
  );
  assert.equal(h.requests.some((r) => r.method === "DELETE" || /\/reminders(\?|$)/.test(r.path)), false, "the legacy list is not even read");
});

test("gate unreadable: an id the legacy API does not know is asked of the app with the same id", async () => {
  appAnswers({ ok: true, status: 200, result: {}, text: "Snoozed 0191c135 by 30m: fires at 08-31 08:30Z." });
  const h = harness({
    reminderApp: "unreadable",
    routes: [(method, path) => (method === "GET" && /\/reminders(\?|$)/.test(path) ? ok({ reminders: [legacyReminder()] }) : undefined)],
  });
  await reminderSnoozeCommand.handler(h.ctx, { id: "0191c135", by: "30m" });
  assert.deepEqual(appCalls().map((c) => [c.action, c.payload]), [["snooze-reminder", { id: "0191c135", by: "30m" }]]);
  assert.equal(h.stdout(), "  │ Snoozed 0191c135 by 30m: fires at 08-31 08:30Z.\n");

  // Not in the app either: the legacy answer stands.
  invokeAppAction.mockRejectedValueOnce(appError(404, "reminder_not_found", "You have no reminder ffff0000."));
  const neither = harness({ reminderApp: "unreadable", routes: cancelRoutes });
  await assert.rejects(
    async () => reminderCancelCommand.handler(neither.ctx, { id: "ffff0000" }),
    (error: unknown) => error instanceof CliError && error.code === "NOT_FOUND" && /ffff0000/.test(error.message),
  );
});

test("gate unreadable: show says it could not tell, with the next step, and asks nothing of the app", async () => {
  const h = harness({ reminderApp: "unreadable" });
  await assert.rejects(
    async () => reminderShowCommand.handler(h.ctx, { id: "0191c135" }),
    (error: unknown) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.code, "REMINDER_APP_UNKNOWN");
      assert.match(error.message, /^Could not tell whether this server's reminders are in the Reminder app/);
      assert.match(error.suggestedNextAction ?? "", /raft reminder show again/);
      return true;
    },
  );
  assert.equal(invokeAppAction.mock.calls.length, 0);
});

test("gate on: list prints the app's list, then the scheduled reminders from before the move under their heading", async () => {
  const appList = { ok: true, status: 200, result: { reminders: [] }, text: "0191c135 active  08-31 09:00Z  once  check deploy  #ops:7c41e2a0" };
  appAnswers(appList, appList, appList);
  const legacy = (reminders: ReminderSummary[]): Route => (method, path) =>
    (method === "GET" && /\/reminders(\?|$)/.test(path) ? ok({ reminders }) : undefined);

  const h = harness({ reminderApp: true, routes: [legacy([legacyReminder()])] });
  await reminderListCommand.handler(h.ctx, {});
  assert.equal(
    h.stdout(),
    "  │ 0191c135 active  08-31 09:00Z  once  check deploy  #ops:7c41e2a0\n\n"
      + "Made before the move (still fire; cancel with raft reminder cancel --id <id>):\n"
      + '#aaaabbbb [scheduled] (one-time) next=2026-08-31T09:00:00.000Z "old follow-up" ref=#general:00000000\n',
  );
  const legacyList = h.requests.find((r) => /\/reminders(\?|$)/.test(r.path));
  assert.match(legacyList!.path, /status=scheduled(&|$)/);
  assert.doesNotMatch(legacyList!.path, /includeMigrated/);
  assert.deepEqual(appCalls()[0].payload, {}, "the default view is the app's default");

  const none = harness({ reminderApp: true, routes: [legacy([])] });
  await reminderListCommand.handler(none.ctx, { status: "scheduled,fired" });
  assert.equal(
    none.stdout(),
    `  │ ${appList.text}\nListed every status: the Reminder app takes one at a time.\n`,
    "no heading without reminders from before the move; the widened view is said",
  );
  assert.deepEqual(appCalls()[1].payload, { status: "all" }, "several statuses read as all");

  const cancelled = harness({ reminderApp: true });
  await reminderListCommand.handler(cancelled.ctx, { status: "canceled" });
  assert.deepEqual(appCalls()[2].payload, { status: "cancelled" });
  assert.equal(cancelled.requests.some((r) => /\/reminders(\?|$)/.test(r.path)), false, "no leftovers when active ones are not asked for");
  assert.doesNotMatch(cancelled.stdout(), /Listed every status/, "one status: no note");
});

test("appListWidenedNote: only for several different statuses, none of them all or migrated", () => {
  assert.equal(appListWidenedNote(["scheduled"]), null);
  assert.equal(appListWidenedNote(["scheduled", "active"]), null, "two words for one status");
  assert.equal(appListWidenedNote(["all", "fired"]), null);
  assert.equal(appListWidenedNote(["migrated", "fired"]), null);
  assert.match(appListWidenedNote(["scheduled", "fired"]) ?? "", /^Listed every status/);
});

test("gate off: show says the reminders are not in the app and points at raft reminder list", async () => {
  const h = harness({ reminderApp: false });
  await assert.rejects(
    async () => reminderShowCommand.handler(h.ctx, { id: "0191c135" }),
    (error: unknown) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.code, "UNSUPPORTED_BY_SERVER");
      assert.match(error.suggestedNextAction ?? "", /raft reminder list/);
      return true;
    },
  );
  assert.equal(invokeAppAction.mock.calls.length, 0);
});

test("an app answer without text prints a short line from its fields, never the JSON", async () => {
  appAnswers({ ok: true, status: 200, result: { reminder: { id: "0191c135-1111-2222-3333-444444444444", status: "active", title: "check\ndeploy", nextFireAt: "2026-08-31T09:00:00.000Z" } } });
  const h = harness({ reminderApp: true });
  await reminderShowCommand.handler(h.ctx, { id: "0191c135" });
  assert.equal(h.stdout(), 'Reminder 0191c135 active, next 2026-08-31T09:00:00.000Z "check deploy"\n');
});
