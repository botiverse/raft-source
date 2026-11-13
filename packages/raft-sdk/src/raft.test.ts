import assert from "node:assert/strict";
import { createRaft } from "./index";

const credential = "sk_agent_raft_test";
const sample = { channel_type: "channel", channel_name: "general", message_id: "00000000-1111-2222-3333-444444444444", timestamp: "2026-08-31T08:00:00.000Z", sender_type: "human", sender_name: "richard", content: "hello everyone", seq: 1200 };

test("anonymous Slack search results cannot create a reply mention", async () => {
  const calls: Array<{ path: string; body: unknown }> = [];
  const row = { id: sample.message_id, seq: 1200, channelId: "c", threadId: null, parentMessageId: null,
    parentMessageContent: null, parentChannelId: "c", parentChannelName: "general", parentChannelType: "channel",
    parentChannelArchivedAt: null, senderId: "", senderType: "third_party_app", senderName: "Slack", channelName: "general",
    channelType: "channel", channelArchivedAt: null, content: "anonymous body", snippet: "anonymous body",
    createdAt: sample.timestamp };
  const raft = createRaft({ serverUrl: "https://raft.example", credential, fetch: async (input, init) => {
    const path = new URL(String(input)).pathname;
    calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (path.endsWith("/search")) return Response.json({ results: [row], hasMore: false });
    if (path.endsWith("/artifacts")) return Response.json({ error: "not allowed" }, { status: 403 });
    if (path.endsWith("/v2/send")) return Response.json({ ok: true, state: "sent", messageId: "m-1", messageSeq: 1201 });
    return Response.json({ error: "unexpected" }, { status: 500 });
  } });
  const searched = await raft.messages.search({ query: "anonymous" });
  assert.equal(searched.ok, true);
  if (!searched.ok) return;
  assert.equal(searched.data.results[0].senderId, "");
  await raft.messages.reply({ target: "#general:00000000" }, { content: "Thanks", idempotencyKey: "anon-reply" });
  const sent = calls.find(call => call.path.endsWith("/v2/send"));
  assert.ok(sent);
  assert.equal((sent.body as { content: string }).content, "Thanks");
  assert.equal("mentions" in (sent.body as object), false);
});

test("createRaft wires identity, inbox, read, send, and tasks over one credential with the contract's retry split", async () => {
  const calls: Array<{ method: string; path: string; init: RequestInit; body: unknown }> = [];
  const raft = createRaft({
    serverUrl: "https://raft.example/",
    credential,
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const path = `${url.pathname}${url.search}`;
      calls.push({ method: init?.method ?? "GET", path, init: init ?? {}, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${credential}`);
      if (path === "/internal/agent-api/context") {
        return Response.json({ agent: { id: "a", name: "grace", displayName: null, description: null, runtime: "external", external: true }, server: { id: "s", slug: "botiverse", name: "Botiverse" }, credential: { capabilities: ["read", "send"] }, prompt: { audience: "self-hosted-runner", text: "guide" } });
      }
      if (path.startsWith("/internal/agent-api/events")) {
        return Response.json({ events: [sample], last_seen_msgId: sample.message_id, last_seen_seq: 1200, reply_target: "#general", has_more: false, ack_mode: "cursor" });
      }
      if (path.startsWith("/internal/agent-api/history")) {
        return Response.json({ target: "#general", messages: [sample, { ...sample, seq: 1201, message_id: "55555555-6666-7777-8888-999999999999" }], has_more: false, has_older: false, has_newer: false, last_read_seq: 1199, model_seen_up_to_seq: 1201 });
      }
      if (path === "/internal/agent-api/v2/send") return Response.json({ ok: true, state: "sent", messageId: "m-1", messageSeq: 1202 });
      if (path === "/internal/agent-api/tasks/claim") return Response.json({ results: [{ messageId: sample.message_id, success: true }] });
      return new Response("unexpected", { status: 500 });
    },
  });

  const me = await raft.identity.whoami();
  assert.equal(me.ok && me.data.agent.name, "grace");

  const batch = await raft.inbox.check();
  assert.equal(batch.ok && batch.data.messages[0]?.text, `[target=#general msg=00000000 time=2026-08-31 08:00:00Z type=human] @richard: hello everyone`);
  const eventsCall = calls.find((c) => c.path.startsWith("/internal/agent-api/events"));
  assert.equal(eventsCall?.path, "/internal/agent-api/events?since=latest&ack=cursor");
  assert.equal(eventsCall?.init.cache, "no-store");
  assert.equal(eventsCall?.init.redirect, "error");

  // Before reading, a send attests only the exact seq the drain rendered.
  await raft.messages.reply(batch.ok ? batch.data.messages[0]! : { target: "#general" }, { content: "hi", idempotencyKey: "k-1" });
  assert.deepEqual(calls.at(-1)?.body, { target: "#general", content: "hi", idempotencyKey: "k-1", seenExactSeqs: [1200] });

  // After a contiguous read, the frontier carries the Server's model-seen boundary.
  const page = await raft.messages.read({ target: "#general" });
  assert.equal(page.ok && page.data.modelSeenUpToSeq, 1201);
  await raft.messages.send({ target: "#general", content: "again", idempotencyKey: "k-2" });
  assert.deepEqual(calls.at(-1)?.body, { target: "#general", content: "again", idempotencyKey: "k-2", seenUpToSeq: 1201 });
  assert.deepEqual(raft.frontier.snapshot().targets["#general"], { upTo: 1201 });

  const claim = await raft.tasks.claim({ target: "#general", messageIds: ["00000000"] });
  assert.equal(claim.ok && claim.state, "claimed");
  if (claim.ok && claim.state === "claimed") assert.equal(claim.next?.command, `raft message send --target "#general:00000000"`);
});

test("createRaft restores an exported frontier and rejects bad configuration before any request", () => {
  const raft = createRaft({ serverUrl: "https://raft.example", credential, frontier: { version: 1, targets: { "#general": { upTo: 7, exact: [9] } }, aliases: {} } });
  assert.deepEqual(raft.frontier.attestation("#general"), { seenUpToSeq: 7, seenExactSeqs: [9] });
  assert.match(raft.routes.manifestVersion, /^[0-9a-f]{16}$/);
  assert.throws(() => createRaft({ serverUrl: "ftp://raft.example", credential }), /HTTP or HTTPS/);
  assert.throws(() => createRaft({ serverUrl: "https://raft.example", credential: "nope" }), /External Agent credential/);
});

test("createRaft names itself on every request, the Manual included; a caller's header of the same name wins", async () => {
  const seen: Array<{ path: string; client: string | null; capabilities: string | null }> = [];
  const fetchStub = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    seen.push({ path: url.pathname, client: headers.get("x-raft-client"), capabilities: headers.get("x-raft-client-capabilities") });
    if (url.pathname === "/internal/agent-api/knowledge") {
      return Response.json({ ok: true, docId: "message", topicOrPath: "message", docVersion: "sha256:0", docState: "published", contentType: "text/markdown", content: "# Messages\n" });
    }
    if (url.pathname === "/internal/agent-api/knowledge/search") {
      return Response.json({ ok: true, query: "message link", scope: null, results: [{ slug: "message", title: "Messages", firstScreen: "Send and read" }] });
    }
    if (url.pathname.startsWith("/internal/agent-api/events")) {
      return Response.json({ events: [], last_seen_msgId: null, last_seen_seq: 0, reply_target: null, has_more: false, ack_mode: "cursor" });
    }
    return new Response("unexpected", { status: 500 });
  };
  const context = { intent: "Point a human at one message", reason: "Need the message link format" };

  const raft = createRaft({ serverUrl: "https://raft.example", credential, fetch: fetchStub });
  assert.equal((await raft.manual.get({ topic: "message", ...context })).ok, true);
  assert.equal((await raft.manual.search({ query: "message link", ...context })).ok, true);
  assert.equal((await raft.inbox.check()).ok, true);
  assert.deepEqual(seen.map((call) => call.path), [
    "/internal/agent-api/knowledge",
    "/internal/agent-api/knowledge/search",
    "/internal/agent-api/events",
  ]);
  for (const call of seen) {
    assert.equal(call.client, "sdk", call.path);
    assert.equal(call.capabilities, "manual-context-v1", call.path);
  }

  seen.length = 0;
  const named = createRaft({ serverUrl: "https://raft.example", credential, fetch: fetchStub, headers: { "X-Raft-Client": "my-runtime" } });
  assert.equal((await named.manual.get({ topic: "message", ...context })).ok, true);
  assert.deepEqual(seen, [{ path: "/internal/agent-api/knowledge", client: "my-runtime", capabilities: "manual-context-v1" }]);
});

test("actions.withdraw takes back a question card: one POST with the id as given, the CLI's receipt, the answers when answered first, and tool calls in tool style", async () => {
  const id = "1a2b3c4d-1111-4222-8333-444455556666";
  const action = { type: "question:ask", ref: "deploy-1", addressee: { kind: "user", userId: "00000000-0000-4000-8000-000000000001", handle: "tenny" }, questions: [{ id: "window", kind: "text", text: "Which window?" }] };
  const result = { kind: "question-answers", ref: "deploy-1", answeredBy: { userId: "00000000-0000-4000-8000-000000000001", handle: "tenny" }, answeredAt: "2026-10-30T09:12:00.000Z", answers: { window: { kind: "text", text: "Tuesday" } } };
  let answer: Response = Response.json({});
  const calls: Array<{ method: string; path: string }> = [];
  const make = (hints?: "tool") => createRaft({
    serverUrl: "https://raft.example",
    credential,
    ...(hints ? { hints } : {}),
    fetch: async (input, init) => {
      calls.push({ method: init?.method ?? "GET", path: new URL(String(input)).pathname });
      return answer.clone();
    },
  });

  answer = Response.json({ messageId: id, metadata: { kind: "action-card", state: "withdrawn", action } });
  const withdrawn = await make().actions.withdraw({ messageId: "1a2b3c4d" });
  assert.deepEqual(calls, [{ method: "POST", path: "/internal/agent-api/actions/1a2b3c4d/withdraw" }]);
  assert.equal(withdrawn.ok && withdrawn.state, "withdrawn");
  assert.equal(withdrawn.ok && withdrawn.data.messageId, id);
  assert.equal(withdrawn.ok && withdrawn.text, `Question card withdrawn: message ${id} (short 1a2b3c4d, ref: deploy-1). @tenny can no longer answer it. No reply is posted for a withdrawal; this is your receipt.\n`);

  // The same through invoke (the model's tool call), and again: already withdrawn.
  answer = Response.json({ messageId: id, metadata: { kind: "action-card", state: "withdrawn", action }, alreadyWithdrawn: true });
  const again = await make().invoke("actions.withdraw", { messageId: "1a2b3c4d" });
  assert.equal("ok" in again && again.ok && again.state, "already_withdrawn");

  // Answered first: a failure carrying the answers; a tool-mode next step names no CLI command.
  answer = Response.json({ error: "This question was answered before it could be withdrawn", errorCode: "ALREADY_ANSWERED", metadata: { kind: "action-card", state: "executed", action, result } }, { status: 409 });
  const answered = await make("tool").actions.withdraw({ messageId: "1a2b3c4d" });
  assert.ok(!answered.ok);
  if (answered.ok) return;
  assert.equal(answered.error.serverCode, "ALREADY_ANSWERED");
  assert.deepEqual(answered.next?.args, { messageId: "1a2b3c4d", result });
  assert.ok(answered.text.includes("1. window — Which window?\n   → Tuesday\n"), answered.text);
  assert.doesNotMatch(answered.error.nextAction, /\braft [a-z]/);
  // The Server's CLI step for a miss becomes the tool-mode step for the same thing, not a generic one.
  answer = Response.json({ error: "No question card with that message id", errorCode: "NOT_FOUND", suggestedNextAction: "Pass the card's message id, or its first 8 characters, as raft action prepare printed them." }, { status: 404 });
  const missing = await make("tool").actions.withdraw({ messageId: "ffffffff" });
  assert.equal(!missing.ok && missing.error.nextAction, "Pass the card's message id, or its first 8 characters, as actions_prepare returned them.");

  // An empty id is refused before any request.
  calls.length = 0;
  const empty = await make().invoke("actions.withdraw", { messageId: "" });
  assert.equal("ok" in empty && !empty.ok && empty.error.code, "INVALID_REQUEST");
  assert.deepEqual(calls, []);
});
