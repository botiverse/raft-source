// Hints as operations: every hint the shared formatters can produce names a
// manifest operation (or a typed-only method) and carries arguments its
// request schema accepts; `createRaft({ hints: "tool" })` renders text and
// `next.command` as tool calls, while the default stays the CLI's text.
import assert from "node:assert/strict";

import {
  AGENT_API_ATTACHMENT_DOWNLOAD_UNAVAILABLE_RESPONSE,
  AGENT_API_ATTACHMENT_DOWNLOAD_URL_UNAVAILABLE_RESPONSE,
} from "@botiverse/raft-shared/src/agentApiContract";
import { RAFT_HINT_SAMPLES } from "@botiverse/raft-shared/src/agentOps/hint.testkit";
import type { z } from "zod";

import { OPERATION_SAMPLES } from "./operationSamples.testkit";
import { lookupRaftOperation, RAFT_OPERATIONS } from "./operations";
import { createRaft, type Raft, type RaftNextOperation } from "./index";

/** Typed methods outside the manifest (binary results) that a hint may point at as a code call. */
const TYPED_ONLY: Record<string, (raft: Raft) => unknown> = {
  "attachments.download": (raft) => raft.attachments.download,
  "artifacts.commentImage": (raft) => raft.artifacts.commentImage,
};

/**
 * `operation.args` is valid for the operation's schema; a partial call may
 * only be missing the arguments it leaves to the caller (`fill`).
 */
function assertValidOperation(operation: RaftNextOperation, fill: readonly string[] | undefined, where: string): void {
  const found = lookupRaftOperation(operation.name);
  assert.ok(found, `${where}: ${operation.name} is a manifest operation`);
  const parsed = (found.schema as z.ZodType).safeParse(operation.args);
  // A placeholder may also stand for an optional argument (`server.info`'s `query`): still valid.
  if (parsed.success) return;
  assert.equal(operation.partial, true, `${where}: invalid args ${JSON.stringify(operation.args)} for a complete call: ${parsed.error.message}`);
  for (const issue of parsed.error.issues) {
    const key = issue.path[0];
    assert.ok(issue.path.length === 1 && typeof key === "string" && !(key in operation.args), `${where}: only missing arguments may fail (${issue.path.join(".")}: ${issue.message})`);
    assert.ok(fill?.includes(key), `${where}: ${key} is missing but not in fill`);
  }
}

test("every hint builder names an operation and passes it arguments its schema accepts", () => {
  const raft = createRaft({ serverUrl: "https://raft.example", credential: "sk_agent_hints" });
  for (const [builder, samples] of Object.entries(RAFT_HINT_SAMPLES)) {
    for (const [index, { hint }] of samples.entries()) {
      const where = `${builder}[${index}]`;
      if (!hint.op) continue; // admin writes: no operation by policy
      if (hint.codeOnly) {
        assert.equal(typeof TYPED_ONLY[hint.op.name]?.(raft), "function", `${where}: ${hint.op.name} is a typed method`);
        continue;
      }
      assertValidOperation(hint.op, hint.fill, where);
      assert.notEqual(lookupRaftOperation(hint.op.name)?.spec.deprecated, true, `${where}: ${hint.op.name} is deprecated; point at its replacement`);
    }
  }
});

const MSG = "abcdef12-0000-4000-8000-000000000000";
const line = (seq: number, attachments: Array<{ id: string; filename: string }> = []) => ({
  channel_type: "channel", channel_name: "ops", message_id: `${String(seq).padStart(8, "0")}-1111-2222-3333-444444444444`,
  timestamp: "2026-10-04T08:00:00.000Z", sender_type: "human", sender_name: "richard", content: `m${seq}`, seq, attachments,
});

function fakeServer() {
  return (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const p = url.pathname.replace("/internal/agent-api", "");
    if (p === "/history") {
      return Response.json({ target: "#ops", messages: [line(10, [{ id: "att-1", filename: "a.png" }]), line(11)], has_more: true, has_older: false, has_newer: true, last_read_seq: 9, model_seen_up_to_seq: 11 });
    }
    if (p === "/attachments/att-ok/url") return Response.json({ url: "https://files.example/x?sig=1", expiresAt: "2026-10-04T08:05:00.000Z", filename: "a.png", mimeType: "image/png" });
    if (p === "/attachments/att-stream/url") return Response.json(AGENT_API_ATTACHMENT_DOWNLOAD_URL_UNAVAILABLE_RESPONSE, { status: 409 });
    if (p.startsWith("/messages/") && p.endsWith("/resolve")) return Response.json({ error: "missing" }, { status: 404 });
    if (p === "/search") return Response.json({ results: [{ id: MSG, seq: 10, channelId: "c", threadId: null, parentMessageId: null, parentMessageContent: null, parentChannelId: "c", parentChannelName: "ops", parentChannelType: "channel", parentChannelArchivedAt: null, senderId: "u", senderType: "human", senderName: "richard", channelName: "ops", channelType: "channel", channelArchivedAt: null, content: "deploy done", snippet: "deploy", createdAt: "2026-10-04T08:00:00.000Z" }], hasMore: true });
    if (p === "/server") return Response.json({ runtimeContext: { agentId: "a", serverId: "s" }, channels: [{ id: "c-1", name: "general", joined: true }], agents: [], humans: [] });
    return Response.json({ error: `not in this fake: ${p}` }, { status: 500 });
  }) as typeof fetch;
}

const raftWith = (hints?: "cli" | "tool") => createRaft({ serverUrl: "https://raft.example", credential: "sk_agent_hints", fetch: fakeServer(), ...(hints ? { hints } : {}) });

test("hints: \"tool\" renders text and next.command as tool calls; the default stays the CLI's", async () => {
  const cli = await raftWith().messages.read({ target: "#ops" });
  const tool = await raftWith("tool").messages.read({ target: "#ops" });
  assert.ok(cli.ok && tool.ok);
  if (!cli.ok || !tool.ok) return;
  assert.equal(cli.next?.command, `raft message read --target "#ops" --after 11`);
  assert.equal(tool.next?.command, `messages_read({ target: "#ops", after: 11 })`);
  for (const outcome of [cli, tool]) {
    assert.deepEqual(outcome.next?.operation, { name: "messages.read", args: { target: "#ops", after: 11 } });
    assert.deepEqual(outcome.next?.args, { target: "#ops", after: 11 });
  }
  assert.ok(cli.text.includes("— use raft attachment view to download]"));
  assert.ok(cli.text.endsWith(`Newer: raft message read --target "#ops" --after 11`));
  assert.ok(tool.text.includes(`— use attachments_download_url({ attachmentId: "att-1" }) to download]`));
  assert.ok(tool.text.endsWith(`Newer: messages_read({ target: "#ops", after: 11 })`));
  assert.ok(tool.data.messages[0]!.text.includes("attachments_download_url"), "message.text follows the style too");
  assert.ok(!/\braft [a-z]/.test(tool.text));

  // A step without a CLI command still carries its operation (search paging).
  const search = await raftWith("tool").messages.search({ query: "deploy", limit: 1 });
  assert.ok(search.ok && search.next?.operation);
  if (search.ok && search.next?.operation) {
    assert.deepEqual(search.next.operation, { name: "messages.search", args: { query: "deploy", limit: 1, offset: 1 } });
    assertValidOperation(search.next.operation, undefined, "messages.search next");
    assert.ok(search.text.includes("more results exist, page with offset 1"));
  }

  const summary = await raftWith("tool").server.info();
  assert.ok(summary.ok && summary.next?.command === `server_info({ view: "channels" })`);
  assert.ok(summary.ok && !/\braft [a-z]/.test(summary.text));
});

test("the SDK's default NOT_FOUND next action is rendered in the configured style", async () => {
  const cli = await raftWith().messages.resolve({ messageId: MSG });
  const tool = await raftWith("tool").messages.resolve({ messageId: MSG });
  assert.ok(!cli.ok && !tool.ok);
  if (cli.ok || tool.ok) return;
  assert.equal(cli.error.nextAction, "Check the target spelling with `raft server info --channels` or resolve the message id first.");
  assert.equal(tool.error.nextAction, "Check the target spelling with `server_info({ view: \"channels\" })` or resolve the message id first.");
  assert.equal(tool.next?.why, tool.error.nextAction);
  assert.ok(tool.text.endsWith(`Next action: ${tool.error.nextAction}`));
  const invoked = await createRaft({ serverUrl: "https://raft.example", credential: "sk_agent_hints", fetch: fakeServer(), hints: "tool" }).invoke("messages.resolve", { messageId: MSG });
  assert.deepEqual(invoked, tool);
});

test("attachments.downloadUrl returns the URL; a Server that cannot presign points next at attachments.download", async () => {
  const minted = await raftWith().attachments.downloadUrl({ attachmentId: "att-ok" });
  assert.ok(minted.ok);
  if (minted.ok) {
    assert.equal(minted.state, "url");
    assert.deepEqual(minted.data, { url: "https://files.example/x?sig=1", expiresAt: "2026-10-04T08:05:00.000Z", filename: "a.png", mimeType: "image/png" });
    assert.equal(minted.next, null);
  }
  const invoked = await raftWith().invoke("attachments.downloadUrl", { attachmentId: "att-ok" });
  assert.deepEqual(invoked, minted);

  const cli = await raftWith().attachments.downloadUrl({ attachmentId: "att-stream" });
  const tool = await raftWith("tool").attachments.downloadUrl({ attachmentId: "att-stream" });
  assert.ok(!cli.ok && !tool.ok);
  if (cli.ok || tool.ok) return;
  assert.equal(cli.error.code, "CONFLICT");
  assert.equal(cli.error.serverCode, "download_url_unavailable");
  assert.equal(cli.error.retryable, false);
  for (const failure of [cli, tool]) {
    assert.equal(failure.next?.kind, "download_bytes");
    assert.deepEqual(failure.next?.operation, { name: "attachments.download", args: { attachmentId: "att-stream" } });
    assert.deepEqual(failure.next?.args, { attachmentId: "att-stream" });
  }
  assert.equal(cli.next?.command, "raft attachment view att-stream --output <path>");
  assert.equal(tool.next?.command, `raft.attachments.download({ attachmentId: "att-stream" })`);
  assert.ok(tool.text.includes(tool.next!.command!));

  const invalid = await raftWith().invoke("attachments.downloadUrl", {});
  assert.ok(!invalid.ok && invalid.error.code === "INVALID_REQUEST");
});

test("createRaft rejects an unknown hints style", () => {
  assert.throws(() => createRaft({ serverUrl: "https://raft.example", credential: "sk_agent_hints", hints: "shell" as never }), /hints must be "cli" or "tool"/);
});

/**
 * Failure bodies a tool-mode model may meet: the SDK's own defaults per status,
 * and real Server bodies whose `suggestedNextAction` was written for the CLI.
 */
/** A `raft` command or a `--flag`: what a tool-mode next step must never contain. */
const CLI_NEXT_ACTION_PATTERN = /\braft [a-z]|(^|[\s`'"(])--[a-z]/;

const FAILURE_RESPONSES: ReadonlyArray<{ label: string; status: number; body: Record<string, unknown> }> = [
  ...[400, 401, 403, 404, 409, 429, 500, 503].map((status) => ({ label: `bare ${status}`, status, body: { error: "nope" } })),
  { label: "attachment unavailable", status: 404, body: { ...AGENT_API_ATTACHMENT_DOWNLOAD_UNAVAILABLE_RESPONSE } },
  { label: "download url unavailable", status: 409, body: { ...AGENT_API_ATTACHMENT_DOWNLOAD_URL_UNAVAILABLE_RESPONSE } },
  { label: "access denial", status: 403, body: { error: "denied", code: "channel_access_denied", suggestedNextAction: "Check the message id, or list recent messages with: raft message read --target '#ops'" } },
  { label: "bare CLI next action", status: 404, body: { error: "missing", suggestedNextAction: "raft message read --target 'agent-event:<full-event-id>'" } },
];

test("hints: \"tool\": no failure's sentence or next step names a CLI command or flag", async () => {
  let failures = 0;
  for (const response of FAILURE_RESPONSES) {
    const fetch = (async () => Response.json(response.body, { status: response.status })) as typeof globalThis.fetch;
    const raft = createRaft({ serverUrl: "https://raft.example", credential: "sk_agent_hints", fetch, hints: "tool" });
    for (const op of RAFT_OPERATIONS) {
      const outcome = await raft.invoke(op.name, OPERATION_SAMPLES[op.name as keyof typeof OPERATION_SAMPLES].args);
      if (!("ok" in outcome) || outcome.ok) continue;
      failures += 1;
      const where = `${op.name} on ${response.label}`;
      for (const [field, value] of [["error.message", outcome.error.message], ["error.nextAction", outcome.error.nextAction], ["next.why", outcome.next?.why], ["next.command", outcome.next?.command]] as const) {
        if (typeof value === "string") assert.doesNotMatch(value, CLI_NEXT_ACTION_PATTERN, `${where}: ${field} = ${value}`);
      }
      assert.doesNotMatch(outcome.text.split("\n").filter((line) => line.startsWith("Next action:") || line.startsWith("Error:")).join("\n"), CLI_NEXT_ACTION_PATTERN, `${where}: text`);
    }
  }
  assert.ok(failures > FAILURE_RESPONSES.length * 10, `the fake failed enough calls (${failures})`);
});

test("attachment unavailable: the CLI style keeps the Server's Feedback Admin step; the tool style gets a neutral one", async () => {
  const fetch = (async () => Response.json(AGENT_API_ATTACHMENT_DOWNLOAD_UNAVAILABLE_RESPONSE, { status: 404 })) as typeof globalThis.fetch;
  const open = (hints: "cli" | "tool") => createRaft({ serverUrl: "https://raft.example", credential: "sk_agent_hints", fetch, hints }).attachments.downloadUrl({ attachmentId: "att-gone" });
  const cli = await open("cli");
  const tool = await open("tool");
  assert.ok(!cli.ok && !tool.ok);
  if (cli.ok || tool.ok) return;
  assert.equal(cli.error.nextAction, AGENT_API_ATTACHMENT_DOWNLOAD_UNAVAILABLE_RESPONSE.suggestedNextAction);
  assert.equal(tool.error.serverCode, "ATTACHMENT_UNAVAILABLE");
  assert.equal(tool.error.nextAction, "This id is not an attachment you can read. Use an attachment id from a message you can see.");
  assert.equal(tool.next?.why, tool.error.nextAction);
  assert.doesNotMatch(tool.text, /Feedback|raft /);
});

// Cindy 10-30: an `around` (or `before`) window with messages on both sides
// named only one side; it names both, like the CLI's window header.
test("a window with older and newer messages names both, each with the read that continues there", async () => {
  const fetch = (async (input: RequestInfo | URL) => {
    const p = new URL(String(input)).pathname.replace("/internal/agent-api", "");
    if (p === "/history") return Response.json({ target: "#ops", messages: [line(10), line(11)], has_more: true, has_older: true, has_newer: true });
    return Response.json({ error: `not in this fake: ${p}` }, { status: 500 });
  }) as typeof fetch;
  const raft = createRaft({ serverUrl: "https://raft.example", credential: "sk_agent_hints", fetch, hints: "tool" });
  const read = await raft.messages.read({ target: "#ops", around: 10 });
  assert.ok(read.ok);
  if (!read.ok) return;
  assert.ok(read.text.endsWith(
    `Older: messages_read({ target: "#ops", before: 10 })\nNewer: messages_read({ target: "#ops", after: 11 })`,
  ), read.text);
});

// A before read pages backward: with older and newer messages around it, its
// next step is the older page, not the newer side it came from.
test("a before read's next step continues to the older page while there is one", async () => {
  const fetch = (async (input: RequestInfo | URL) => {
    const p = new URL(String(input)).pathname.replace("/internal/agent-api", "");
    if (p === "/history") return Response.json({ target: "#ops", messages: [line(10), line(11)], has_more: true, has_older: true, has_newer: true });
    return Response.json({ error: `not in this fake: ${p}` }, { status: 500 });
  }) as typeof fetch;
  const raft = createRaft({ serverUrl: "https://raft.example", credential: "sk_agent_hints", fetch, hints: "tool" });
  const back = await raft.messages.read({ target: "#ops", before: 12 });
  assert.ok(back.ok);
  if (!back.ok) return;
  assert.deepEqual(back.next?.args, { target: "#ops", before: 10 });
  const around = await raft.messages.read({ target: "#ops", around: 10 });
  assert.ok(around.ok);
  if (!around.ok) return;
  assert.deepEqual(around.next?.args, { target: "#ops", after: 11 }, "other reads still prefer the newer page");
});
