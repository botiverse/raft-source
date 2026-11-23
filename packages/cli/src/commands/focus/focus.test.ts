import assert from "node:assert/strict";

import type { AgentApiResponseByRoute } from "@botiverse/raft-shared";

import type { ApiResponse } from "../../client";
import type { AgentContext } from "../../auth/env";
import { createCommandContext } from "../../core/context";
import { CliError } from "../../core/errors";
import type { CliIo } from "../../core/io";
import { renderError } from "../../core/renderer";
import { formatFocusList, formatFocusResult, formatUnfocusResult, focusTargetLabel } from "./_format";
import { focusCommand, unfocusCommand } from "./focus";

type Entry = AgentApiResponseByRoute["focusList"]["entries"][number];

function entry(target: string, source: Entry["source"] = "manual"): Entry {
  const kind: Entry["kind"] = /:#\d+$/.test(target) ? "task" : /^dm:@[^:]+$/.test(target) ? "dm" : "thread";
  return { target, kind, source, focusedAt: "2026-11-19T09:00:00.000Z", lastActiveAt: "2026-11-19T09:05:00.000Z" };
}

const THREAD = entry("#proj-chat:54a733de");
const TASK = entry("#wg-ax:#41");
const OTHER_THREAD = entry("#wg-ax:46e5169b", "auto");
const DM = entry("dm:@Tenny", "auto");

function memoryIo(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: { write: (chunk: string | Uint8Array) => { stdout.push(String(chunk)); return true; } },
      stderr: { write: (chunk: string | Uint8Array) => { stderr.push(String(chunk)); return true; } },
    },
  };
}

const agentContext: AgentContext = {
  agentId: "agent-1",
  serverUrl: "https://slock.example",
  serverId: "server-1",
  token: "secret-token",
  clientMode: "self-hosted-runner",
  secretSource: "profile-credential-file",
  activeCapabilities: null,
};

function harness(respond: () => ApiResponse<unknown>) {
  const { io, stdout, stderr } = memoryIo();
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (method: string, path: string, body?: unknown): Promise<ApiResponse<unknown>> => {
        requests.push({ method, path, body });
        return respond();
      },
    }) as any,
  });
  return { ctx, io, requests, stdout, stderr };
}

async function failure(run: () => Promise<void>): Promise<CliError> {
  try {
    await run();
  } catch (err) {
    assert.ok(err instanceof CliError, String(err));
    return err;
  }
  throw new Error("the command did not fail");
}

/** The error as the CLI prints it (stderr text). */
function rendered(err: CliError): string {
  const { io, stderr } = memoryIo();
  renderError(io, err);
  return stderr.join("");
}

test("a task conversation is labelled as the inbox labels it; the commands keep the bare target", () => {
  assert.equal(focusTargetLabel("#wg-ax:#41"), "task #wg-ax:#41");
  assert.equal(focusTargetLabel("#proj-chat:54a733de"), "#proj-chat:54a733de");
  assert.equal(focusTargetLabel("dm:@Tenny"), "dm:@Tenny");
});

test("focus: the receipt, the list, and the command that unfocuses it", () => {
  assert.equal(
    formatFocusResult({ ok: true, focused: THREAD, alreadyFocused: false, evicted: [], entries: [THREAD, TASK], limit: 3 }),
    [
      "Focused #proj-chat:54a733de.",
      "Focused (2 of 3): #proj-chat:54a733de, task #wg-ax:#41",
      "Unfocus: raft unfocus \"#proj-chat:54a733de\"",
    ].join("\n"),
  );
});

test("focus past the limit: one line per unfocused conversation, with the command that brings it back", () => {
  assert.equal(
    formatFocusResult({ ok: true, focused: THREAD, alreadyFocused: false, evicted: [DM], entries: [THREAD, TASK, OTHER_THREAD], limit: 3 }),
    [
      "Focused #proj-chat:54a733de.",
      "Unfocused dm:@Tenny (least recently active). Its updates go to your inbox again. To return: raft focus \"dm:@Tenny\"",
      "Focused (3 of 3): #proj-chat:54a733de, task #wg-ax:#41, #wg-ax:46e5169b",
      "Unfocus: raft unfocus \"#proj-chat:54a733de\"",
    ].join("\n"),
  );
  // Two unfocused: two lines, each with its own command; a task's command takes the bare ref.
  const two = formatFocusResult({ ok: true, focused: THREAD, alreadyFocused: false, evicted: [DM, TASK], entries: [THREAD, OTHER_THREAD], limit: 3 }).split("\n");
  assert.equal(two.length, 5);
  assert.equal(two[1], "Unfocused dm:@Tenny (least recently active). Its updates go to your inbox again. To return: raft focus \"dm:@Tenny\"");
  assert.equal(two[2], "Unfocused task #wg-ax:#41 (least recently active). Its updates go to your inbox again. To return: raft focus \"#wg-ax:#41\"");
});

test("focus a task conversation: labelled `task`, unfocused by its bare ref", () => {
  assert.equal(
    formatFocusResult({ ok: true, focused: TASK, alreadyFocused: false, evicted: [], entries: [TASK], limit: 3 }),
    [
      "Focused task #wg-ax:#41.",
      "Focused (1 of 3): task #wg-ax:#41",
      "Unfocus: raft unfocus \"#wg-ax:#41\"",
    ].join("\n"),
  );
});

test("focus something already focused: said so, then the list, and nothing else", () => {
  assert.equal(
    formatFocusResult({ ok: true, focused: THREAD, alreadyFocused: true, evicted: [], entries: [THREAD, TASK, OTHER_THREAD], limit: 3 }),
    [
      "Already focused on #proj-chat:54a733de.",
      "Focused (3 of 3): #proj-chat:54a733de, task #wg-ax:#41, #wg-ax:46e5169b",
    ].join("\n"),
  );
});

test("list: the entries and how to unfocus one; empty: how to focus", () => {
  assert.equal(
    formatFocusList({ entries: [THREAD, TASK], limit: 3 }),
    [
      "Focused (2 of 3): #proj-chat:54a733de, task #wg-ax:#41",
      "Unfocus one: raft unfocus \"<target>\"",
    ].join("\n"),
  );
  assert.equal(
    formatFocusList({ entries: [], limit: 3 }),
    "Nothing focused. Focus a thread, DM or task conversation: raft focus \"<target>\"",
  );
});

test("unfocus: the receipt, then what is still focused, or that nothing is; not focused: one line", () => {
  assert.equal(
    formatUnfocusResult({ ok: true, target: "dm:@Tenny", wasFocused: true, entries: [THREAD, TASK], limit: 3 }),
    [
      "Unfocused dm:@Tenny. Its updates go to your inbox.",
      "Focused (2 of 3): #proj-chat:54a733de, task #wg-ax:#41",
    ].join("\n"),
  );
  assert.equal(
    formatUnfocusResult({ ok: true, target: "#wg-ax:#41", wasFocused: true, entries: [], limit: 3 }),
    [
      "Unfocused task #wg-ax:#41. Its updates go to your inbox.",
      "Nothing focused.",
    ].join("\n"),
  );
  assert.equal(
    formatUnfocusResult({ ok: true, target: "dm:@Tenny", wasFocused: false, entries: [THREAD], limit: 3 }),
    "dm:@Tenny was not focused.",
  );
});

test("no output promises anything about delivery or read state yet", () => {
  const outputs = [
    formatFocusResult({ ok: true, focused: THREAD, alreadyFocused: false, evicted: [DM], entries: [THREAD, TASK, OTHER_THREAD], limit: 3 }),
    formatFocusResult({ ok: true, focused: THREAD, alreadyFocused: true, evicted: [], entries: [THREAD], limit: 3 }),
    formatFocusList({ entries: [THREAD], limit: 3 }),
    formatFocusList({ entries: [], limit: 3 }),
    formatUnfocusResult({ ok: true, target: "dm:@Tenny", wasFocused: true, entries: [], limit: 3 }),
  ];
  for (const output of outputs) assert.doesNotMatch(output, /full text|in full|as read|marked read|wake/i);
});

test("raft focus <target> POSTs /focus and writes the receipt", async () => {
  const data = { ok: true, focused: THREAD, alreadyFocused: false, evicted: [DM], entries: [THREAD, TASK, OTHER_THREAD], limit: 3 };
  const h = harness(() => ({ ok: true, status: 200, error: null, data }));
  await focusCommand.handler(h.ctx, " #proj-chat:54a733de ", {});
  assert.deepEqual(h.requests, [
    { method: "POST", path: "/internal/agent-api/focus", body: { target: "#proj-chat:54a733de" } },
  ]);
  assert.deepEqual(h.stderr, []);
  assert.equal(h.stdout.join(""), `${formatFocusResult(data as AgentApiResponseByRoute["focus"])}\n`);
});

test("raft focus with no target GETs /focus and lists", async () => {
  const data = { entries: [THREAD, TASK], limit: 3 };
  const h = harness(() => ({ ok: true, status: 200, error: null, data }));
  await focusCommand.handler(h.ctx, undefined, {});
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0]!.method, "GET");
  assert.equal(h.requests[0]!.path, "/internal/agent-api/focus");
  assert.equal(h.stdout.join(""), "Focused (2 of 3): #proj-chat:54a733de, task #wg-ax:#41\nUnfocus one: raft unfocus \"<target>\"\n");
});

test("raft unfocus <target> POSTs /unfocus; --peer-kind names which DM", async () => {
  const data = { ok: true, target: "dm:@Tenny~agent", wasFocused: true, entries: [], limit: 3 };
  const h = harness(() => ({ ok: true, status: 200, error: null, data }));
  await unfocusCommand.handler(h.ctx, "dm:@Tenny", { peerKind: "agent" });
  assert.deepEqual(h.requests, [
    { method: "POST", path: "/internal/agent-api/unfocus", body: { target: "dm:@Tenny~agent" } },
  ]);
  assert.equal(h.stdout.join(""), "Unfocused dm:@Tenny~agent. Its updates go to your inbox.\nNothing focused.\n");
});

test("raft unfocus with no target sends nothing and ends with the command that lists the focus", async () => {
  const h = harness(() => ({ ok: true, status: 200, error: null, data: {} }));
  const err = await failure(() => Promise.resolve(unfocusCommand.handler(h.ctx, undefined, {})));
  assert.equal(err.code, "INVALID_ARG");
  assert.equal(h.requests.length, 0);
  assert.equal(rendered(err).trimEnd().split("\n").at(-1), "Next action: See what is focused: raft focus");
});

test("a Server refusal is shown as sent, and ends with its next step: Focus off, a plain channel", async () => {
  const off = harness(() => ({
    ok: false,
    status: 404,
    error: "Focus is not switched on for this server yet: nothing was focused, and every conversation reaches your inbox as before.",
    errorCode: "AGENT_FOCUS_DISABLED",
    suggestedNextAction: "raft inbox check",
    data: null,
  }));
  const offErr = await failure(() => Promise.resolve(focusCommand.handler(off.ctx, "#proj-chat:54a733de", {})));
  assert.equal(offErr.code, "AGENT_FOCUS_DISABLED");
  assert.deepEqual(rendered(offErr).trimEnd().split("\n"), [
    "Error: Focus is not switched on for this server yet: nothing was focused, and every conversation reaches your inbox as before.",
    "Code: AGENT_FOCUS_DISABLED",
    "Next action: raft inbox check",
  ]);

  const channel = harness(() => ({
    ok: false,
    status: 400,
    error: "Channel focus is deliberately not available yet: focus a thread, a DM or a task conversation instead, as your inbox names them.",
    errorCode: "FOCUS_CHANNEL_UNAVAILABLE",
    suggestedNextAction: "raft inbox check",
    data: null,
  }));
  const channelErr = await failure(() => Promise.resolve(focusCommand.handler(channel.ctx, "#proj-chat", {})));
  assert.equal(channelErr.code, "FOCUS_CHANNEL_UNAVAILABLE");
  assert.equal(rendered(channelErr).trimEnd().split("\n").at(-1), "Next action: raft inbox check");
});

test("a refusal that came without a next step still ends with one", async () => {
  for (const [command, fallback] of [[focusCommand, "FOCUS_FAILED"], [unfocusCommand, "UNFOCUS_FAILED"]] as const) {
    const bare = harness(() => ({ ok: false, status: 409, error: "Something about that conversation changed.", data: null }));
    const err = await failure(() => Promise.resolve(command.handler(bare.ctx, "#proj-chat:54a733de", {})));
    assert.equal(err.code, fallback);
    assert.equal(rendered(err).trimEnd().split("\n").at(-1), "Next action: See what is focused: raft focus");

    const missing = harness(() => ({ ok: false, status: 404, error: "Not found, or you don't have access.", data: null }));
    assert.equal((await failure(() => Promise.resolve(command.handler(missing.ctx, "#proj-chat:deadbeef", {})))).code, "NOT_FOUND");
  }
});
