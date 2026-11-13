import assert from "node:assert/strict";

import { createAgentApiClient, type AgentApiClient } from "../agentApiClient";
import { formatAgentProfile } from "../agentText/index";
import {
  attachmentComments,
  formatAgentActionCardPosted,
  prepareActionCard,
  prepareActionCardRequestSchema,
  validateOpRequest,
  addMentions,
  getManualTopic,
  notifyMentions,
  pendingMentionActions,
  reactToMessage,
  resolveMessage,
  searchManual,
  searchMessages,
  uploadAttachment,
} from "./index";

type Scripted = (path: string, init: RequestInit) => Response | Promise<Response>;

function client(script: Scripted, calls: Array<{ method: string; path: string; body: unknown; init: RequestInit }> = []): AgentApiClient {
  return createAgentApiClient({
    fetch: {
      baseUrl: "https://raft.example",
      auth: { authorization: "Bearer sk_agent_test" },
      fetch: async (input, init) => {
        const url = new URL(String(input));
        const path = `${url.pathname}${url.search}`;
        calls.push({ method: init?.method ?? "GET", path, body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body, init: init ?? {} });
        return script(path, init ?? {});
      },
    },
  });
}

const T = "2026-08-31T08:00:00.000Z";
const UUID_A = "00000000-1111-2222-3333-444444444444";

test("attachments: upload resolves the target, posts multipart with file + channelId, and points at the send", async () => {
  const calls: Array<{ method: string; path: string; body: unknown; init: RequestInit }> = [];
  const uploads: Array<{ url: string; form: FormData; headers: Headers }> = [];
  const api = client((path) => {
    if (path === "/internal/agent-api/attachment-upload-capabilities") return Response.json({ directUploadEnabled: true, directUploadThresholdBytes: 1_000_000, maxBytes: 50_000_000, sessionExpiresInSeconds: 900 });
    if (path === "/internal/agent-api/resolve-channel") return Response.json({ channelId: "11111111-1111-4111-8111-111111111111" });
    return new Response("unexpected", { status: 500 });
  }, calls);
  const transport = {
    serverUrl: "https://raft.example",
    headers: { "x-test": "1", "content-type": "application/json" },
    authorization: "Bearer sk_agent_test",
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      uploads.push({ url: String(input), form: init?.body as FormData, headers: new Headers(init?.headers) });
      return Response.json({ id: UUID_A, filename: "spec.md", mimeType: "text/markdown", sizeBytes: 5, thumbnailUrl: null });
    }) as typeof fetch,
  };
  const outcome = await uploadAttachment(api, transport, { target: "#proj-sdk", filename: "spec.md", bytes: new TextEncoder().encode("hello") });
  assert.equal(outcome.ok && outcome.state, "uploaded");
  assert.deepEqual(calls.map((c) => c.path), ["/internal/agent-api/attachment-upload-capabilities", "/internal/agent-api/resolve-channel"]);
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0]?.url, "https://raft.example/internal/agent-api/upload");
  assert.equal(uploads[0]?.headers.get("content-type"), null, "fetch sets the multipart boundary");
  assert.equal(uploads[0]?.headers.get("authorization"), "Bearer sk_agent_test");
  const form = uploads[0]!.form;
  assert.equal(form.get("channelId"), "11111111-1111-4111-8111-111111111111");
  const file = form.get("file") as File;
  assert.equal(file.name, "spec.md");
  assert.equal(file.type, "text/markdown", "inferred from the filename");
  if (outcome.ok) {
    assert.equal(outcome.next?.command, `raft message send --target "#proj-sdk" --attachment-id ${UUID_A}`);
    assert.match(outcome.text, /^File uploaded: spec\.md \(0\.0KB\)\nAttachment ID: 00000000-1111-2222-3333-444444444444\n/);
  }

  const empty = await uploadAttachment(api, transport, { target: "#proj-sdk", filename: "e", bytes: new Uint8Array(0) });
  assert.equal(empty.ok ? null : empty.error.code, "INVALID_REQUEST");
});

test("attachments: comments render the CLI text", async () => {
  const api = client(() => Response.json({ comments: [{ id: "bbbb2222-0000-0000-0000-000000000000", channelId: "c", senderId: "u1", senderType: "user", senderName: "richard", content: "looks good", createdAt: T, reactions: [{ emoji: "✅", reactorType: "user", reactorId: "u1", createdAt: T }], anchor: { type: "lines", data: { start: 12, end: 18 } } }], threadChannelId: "thread-chan-1", viewer: { canComment: true, canResolve: false } }));
  const outcome = await attachmentComments(api, { attachmentId: UUID_A });
  assert.equal(outcome.ok && outcome.state, "comments");
  if (outcome.ok) {
    assert.equal(outcome.text, `## Comments on attachment 00000000 (1)\n[msg=bbbb2222 time=${T} type=user] ✅ [anchor: L12–18] @richard: looks good\n(full conversation lives in thread channel thread-chan-1)\n`);
  }
});

test("search: an incomplete recent page says it is not all the matches and continues by cursor, not offset", async () => {
  const calls: Array<{ method: string; path: string; body: unknown; init: RequestInit }> = [];
  const api = client(() => Response.json({ results: [], hasMore: false, incomplete: true, nextCursor: "CUR", searchedThrough: T, searchedMessages: 10_000 }), calls);
  const search = await searchMessages(api, { query: "invoice", sort: "recent", after: "2026-09-16T00:00:00Z", offset: 0 });
  assert.equal(search.ok && search.state, "incomplete", "nothing found yet is not empty");
  if (search.ok) {
    assert.equal(search.data.incomplete, true);
    assert.equal(search.data.nextCursor, "CUR");
    assert.equal(search.data.searchedMessages, 10_000);
    assert.doesNotMatch(search.text, /No search results/);
    assert.match(search.text, /^Search incomplete: no matches in the messages searched so far \(stopped after reading 10,000 messages, back to [^)]+\)\./);
    assert.match(search.text, /\nNext \(search older messages\): raft message search --query 'invoice' --after '2026-09-16T00:00:00Z' --sort recent --cursor 'CUR'\n/);
    assert.equal(search.next?.kind, "continue_search");
    assert.equal(search.next?.command, "raft message search --query 'invoice' --after '2026-09-16T00:00:00Z' --sort recent --cursor 'CUR'");
    assert.deepEqual(search.next?.args, { query: "invoice", sort: "recent", after: "2026-09-16T00:00:00Z", cursor: "CUR" });
  }
  const toolStyle = await searchMessages(api, { query: "invoice", sort: "recent" }, { hints: "tool" });
  if (toolStyle.ok) {
    assert.match(toolStyle.text, /\nNext \(search older messages\): messages_search\(\{ query: "invoice", sort: "recent", cursor: "CUR" \}\)\nOr narrow the search: add target or sender\.$/);
  }
  await searchMessages(api, { query: "invoice", sort: "recent", cursor: "CUR" });
  assert.equal(calls.at(-1)?.path, "/internal/agent-api/search?q=invoice&sort=recent&cursor=CUR");
});

test("search: a skipped any-word fallback says the empty page is not 'nothing matches' and how to narrow", async () => {
  const api = client(() => Response.json({ results: [], hasMore: false, relaxedSkipped: "too_broad" }));
  const search = await searchMessages(api, { query: "deploy search index test" });
  assert.equal(search.ok && search.state, "empty");
  if (search.ok) {
    assert.equal(search.data.relaxedSkipped, "too_broad");
    assert.doesNotMatch(search.text, /No search results/);
    assert.match(search.text, /^No message contains all of these words\. Matching any one of them was skipped: .*this does NOT mean no message matches\. \(relaxedSkipped=too_broad\)\n/);
    assert.match(search.text, /\nNext: search for fewer, more specific words, or add --target '#<channel>' or --sender <handle>\.$/);
  }
  const scoped = await searchMessages(api, { query: "deploy search", target: "#ops", sender: "alice" });
  if (scoped.ok) assert.match(scoped.text, /\nNext: search for fewer, more specific words\.$/);
  const plain = await searchMessages(client(() => Response.json({ results: [], hasMore: false })), { query: "deploy search" });
  if (plain.ok) assert.equal(plain.data.relaxedSkipped, null);
});

test("search: a relevance page answered newest first says it is not ranked by relevance and how to narrow", async () => {
  const hit = { id: UUID_A, seq: 1, channelId: "c", threadId: null, parentMessageId: null, parentMessageContent: null, parentChannelId: "c", parentChannelName: "billing", parentChannelType: "channel", parentChannelArchivedAt: null, senderId: "u", senderType: "human", senderName: "richard", channelName: "billing", channelType: "channel", channelArchivedAt: null, content: "the deploy", snippet: "deploy", createdAt: T };
  const api = client(() => Response.json({ results: [hit], hasMore: true, nextCursor: "CUR", relevanceFallback: "too_broad" }));
  const search = await searchMessages(api, { query: "deploy" });
  assert.equal(search.ok && search.state, "results");
  if (search.ok) {
    assert.equal(search.data.relevanceFallback, "too_broad");
    assert.match(search.text, /^Search results for: "deploy" \(1 result · [^\n]*\)\nSorted newest first, NOT by relevance: too many messages match these words to rank them\. For the most relevant matches, search for more specific words, or add --target '#<channel>' or --sender <handle>\. \(relevanceFallback=too_broad\)\n/);
    // The next page continues the newest-first walk.
    assert.deepEqual(search.next?.args, { query: "deploy", sort: "recent", cursor: "CUR" });
  }
  const plain = await searchMessages(client(() => Response.json({ results: [hit], hasMore: false })), { query: "deploy" });
  if (plain.ok) {
    assert.equal(plain.data.relevanceFallback, null);
    assert.doesNotMatch(plain.text, /relevanceFallback/);
  }
});

test("search: a page with results that stopped early stays results with data.incomplete; a complete empty page stays empty", async () => {
  const hit = { id: UUID_A, seq: 1, channelId: "c", threadId: null, parentMessageId: null, parentMessageContent: null, parentChannelId: "c", parentChannelName: "billing", parentChannelType: "channel", parentChannelArchivedAt: null, senderId: "u", senderType: "human", senderName: "richard", channelName: "billing", channelType: "channel", channelArchivedAt: null, content: "the invoice", snippet: "invoice", createdAt: T };
  const partial = await searchMessages(client(() => Response.json({ results: [hit], hasMore: false, incomplete: true, nextCursor: "CUR", searchedThrough: T, searchedMessages: 10_000 })), { query: "invoice", sort: "recent" });
  assert.equal(partial.ok && partial.state, "results");
  if (partial.ok) {
    assert.equal(partial.data.incomplete, true);
    assert.equal(partial.next?.kind, "continue_search");
    assert.match(partial.text, /\(1 result · incomplete=true · stopped after reading 10,000 messages, back to [^;]+; older messages were not searched, so these are NOT all the matches\)/);
  }
  // The state follows the data, never whether a next step could be built.
  const noQuery = await searchMessages(client(() => Response.json({ results: [], hasMore: false, incomplete: true, nextCursor: "CUR" })), { sender: "alice", sort: "recent" });
  assert.equal(noQuery.ok && noQuery.state, "incomplete");
  // A caller that left sort to the server still continues as a recent search (a cursor with relevance is rejected).
  const defaultSort = await searchMessages(client(() => Response.json({ results: [], hasMore: false, incomplete: true, nextCursor: "CUR" })), { query: "invoice" });
  assert.equal(defaultSort.ok && defaultSort.next?.kind, "continue_search");
  if (defaultSort.ok) assert.deepEqual(defaultSort.next?.args, { query: "invoice", sort: "recent", cursor: "CUR" });
  const empty = await searchMessages(client(() => Response.json({ results: [], hasMore: false })), { query: "invoice", sort: "recent" });
  assert.equal(empty.ok && empty.state, "empty");
  if (empty.ok) {
    assert.equal(empty.data.incomplete, false);
    assert.equal(empty.next, null);
    assert.equal(empty.text, "No search results. (truncated=false)");
  }
});

test("search/resolve/react: CLI text with neutralised refs, canonical resolve, reaction receipt", async () => {
  const calls: Array<{ method: string; path: string; body: unknown; init: RequestInit }> = [];
  const api = client((path) => {
    if (path.startsWith("/internal/agent-api/search")) {
      return Response.json({ results: [{ id: UUID_A, seq: 1200, channelId: "c", threadId: null, parentMessageId: null, parentMessageContent: null, parentChannelId: "c", parentChannelName: "general", parentChannelType: "channel", parentChannelArchivedAt: null, senderId: "u", senderType: "human", senderName: "richard", channelName: "general", channelType: "channel", channelArchivedAt: null, content: "we should deploy on tuesday, ping @alice in #ops", snippet: "deploy", createdAt: T }], hasMore: false });
    }
    if (path.includes("/resolve")) return Response.json({ message: { channel_type: "dm", channel_name: "richard", message_id: UUID_A, timestamp: T, sender_type: "human", sender_name: "richard", content: "hey", seq: 7 } });
    if (path.includes("/reactions")) return Response.json({ ok: true });
    return new Response("unexpected", { status: 500 });
  }, calls);

  const search = await searchMessages(api, { query: "deploy", limit: 10 });
  assert.equal(calls[0]?.path, "/internal/agent-api/search?q=deploy&limit=10");
  assert.equal(search.ok && search.state, "results");
  if (search.ok) {
    assert.match(search.text, /^Search results for: "deploy" \(1 result · truncated=false\)\n\n<result ref="msg:00000000-1111-2222-3333-444444444444">\nSource: channel:general\nSender: richard \(human\)\n/);
    assert.match(search.text, /<preview>\n  │ we should <match>deploy<\/match> on tuesday, ping user:alice in channel:ops\n<\/preview>/, "refs in previews cannot route attention");
    assert.equal(search.next, null);
  }
  const invalid = await searchMessages(api, {});
  assert.equal(invalid.ok, false);

  const resolved = await resolveMessage(api, { messageId: UUID_A });
  assert.equal(resolved.ok && resolved.state, "message");
  if (resolved.ok) {
    assert.equal(resolved.data.target, "dm:@richard");
    assert.equal(resolved.text, `[target=dm:@richard msg=00000000 time=2026-08-31 08:00:00Z type=human] @richard: hey`);
    assert.equal(resolved.next?.command, `raft message read --target "dm:@richard" --around 00000000`);
  }

  const reacted = await reactToMessage(api, { messageId: UUID_A, emoji: "✅" });
  assert.equal(reacted.ok && reacted.state, "added");
  assert.equal(calls.at(-1)?.method, "POST");
  assert.deepEqual(calls.at(-1)?.body, { emoji: "✅" });
  if (reacted.ok) assert.equal(reacted.text, "Reaction ✅ added to message 00000000.");
  const removed = await reactToMessage(api, { messageId: UUID_A, emoji: "✅" }, "remove");
  assert.equal(removed.ok && removed.state, "removed");
  assert.equal(calls.at(-1)?.method, "DELETE");
  const bad = await reactToMessage(api, { messageId: UUID_A, emoji: "two words" });
  assert.equal(bad.ok, false);
});

test("mentions: pending list carries the recovery command as next, notify / add / execute render results", async () => {
  const api = client((path, init) => {
    if (path.startsWith("/internal/agent-api/mention-actions/pending")) return Response.json({ pendingMentionActions: [{ resolutionId: "00000000-1111-2222-3333-444444444444", messageId: "m-1", targetType: "agent", targetHandle: "@bob", reason: "not_member", availableActions: ["notify", "add"], expiresAt: T }], has_more: false });
    if (path === "/internal/agent-api/mention-actions/execute") {
      const action = (JSON.parse(String(init.body)) as { action: string }).action;
      return Response.json({ ok: true, action, results: [{ resolutionId: "00000000-1111-2222-3333-444444444444", status: "queued", action, targetType: "agent", targetId: "a" }] });
    }
    return new Response("unexpected", { status: 500 });
  });
  const pending = await pendingMentionActions(api, {});
  assert.equal(pending.ok && pending.state, "pending");
  if (pending.ok) {
    assert.equal(pending.next?.command, "raft mention notify 00000000-1111-2222-3333-444444444444");
    assert.deepEqual(pending.next?.operation, { name: "mentions.notify", args: { resolutionIds: ["00000000-1111-2222-3333-444444444444"] } });
    assert.match(pending.text, /^Pending mention actions\n\(shown 1, server default 50 — truncated=false · this is the complete list\)\n\n- 00000000-1111-2222-3333-444444444444 — @bob \(agent\)\n/);
    assert.match(pending.text, /  notify: raft mention notify 00000000-1111-2222-3333-444444444444\n  add: raft mention add 00000000-1111-2222-3333-444444444444\n/);
  }
  const notified = await notifyMentions(api, { resolutionIds: ["00000000-1111-2222-3333-444444444444"] });
  assert.equal(notified.ok && notified.state, "executed");
  if (notified.ok) {
    assert.equal(notified.data.action, "notify");
    assert.match(notified.text, /^Mention notify results\n\n- 00000000-1111-2222-3333-444444444444: queued\n/);
  }
  const added = await addMentions(api, { resolutionIds: ["00000000-1111-2222-3333-444444444444"] });
  assert.equal(added.ok && added.data.action, "add");
  if (added.ok) assert.match(added.text, /^Mention add results\n/);
  const empty = await notifyMentions(api, { resolutionIds: [" "] });
  assert.equal(!empty.ok && empty.error.code, "INVALID_REQUEST");
});

test("manual: get and search require intent and reason and render the CLI text", async () => {
  const calls: Array<{ method: string; path: string; body: unknown; init: RequestInit }> = [];
  const api = client((path) => {
    if (path.startsWith("/internal/agent-api/knowledge/search")) return Response.json({ ok: true, query: "inbox", scope: null, results: [{ slug: "inbox", title: "Inbox", firstScreen: "Inbox is the attention queue.\n\nSecond line." }] });
    if (path.startsWith("/internal/agent-api/knowledge?")) return Response.json({ ok: true, docId: "inbox", topicOrPath: "inbox", docVersion: "1", docState: "published", contentType: "text/markdown", content: "# Inbox" });
    return new Response("unexpected", { status: 500 });
  }, calls);
  const missing = await getManualTopic(api, { topic: "inbox", intent: "", reason: "x" });
  assert.equal(missing.ok, false);
  const topic = await getManualTopic(api, { topic: "inbox", intent: "learn how inbox works", reason: "designing the SDK inbox op" });
  assert.equal(topic.ok && topic.text, "# Inbox\n");
  assert.match(calls.at(-1)?.path ?? "", /^\/internal\/agent-api\/knowledge\?topic=inbox&intent=/);
  const results = await searchManual(api, { query: "inbox", intent: "learn how inbox works", reason: "designing the SDK inbox op" });
  assert.equal(results.ok && results.state, "results");
  if (results.ok) {
    assert.equal(results.text, "1. inbox — Inbox\n   Inbox is the attention queue.\n   Second line.\n");
    assert.deepEqual(results.next?.args, { topic: "inbox" });
  }
});

test("profile card renders the CLI's runtime display name from the shared catalog", () => {
  const text = formatAgentProfile({ kind: "agent", id: "a", isSelf: true, name: "grace", displayName: null, description: null, avatarUrl: null, status: "active", serverRole: "member", runtime: "claude", model: "m", reasoningEffort: null, executionMode: null, computerId: null, computerName: null, computerHostname: null, daemonVersion: null, creator: null, createdAgents: [{ id: "b", name: "old", displayName: null, avatarUrl: null, runtime: "gemini", status: "stopped" }], createdAt: T, deletedAt: null } as never);
  assert.match(text, /- Runtime: Claude Code\n/);
  assert.match(text, /  - @old \(Gemini CLI \(deprecated\), stopped\)/);
});

const UPLOAD_ID = "33333333-3333-4333-8333-333333333333";
const ATTACHMENT_ID = "44444444-4444-4444-8444-444444444444";

function sessionFixture(put: (attempt: number) => Response | Promise<Response>, complete: (attempt: number) => Response) {
  const calls: Array<{ method: string; path: string; body: unknown; init: RequestInit }> = [];
  let completes = 0;
  const api = client((path) => {
    if (path === "/internal/agent-api/attachment-upload-capabilities") return Response.json({ directUploadEnabled: true, directUploadThresholdBytes: 1_000, maxBytes: 50_000_000, sessionExpiresInSeconds: 900 });
    if (path === "/internal/agent-api/resolve-channel") return Response.json({ channelId: "11111111-1111-4111-8111-111111111111" });
    if (path === "/internal/agent-api/attachment-upload-sessions") return Response.json({ uploadId: UPLOAD_ID, attachmentId: ATTACHMENT_ID, state: "pending", expiresAt: T, upload: { method: "PUT", url: "https://r2.example.test/upload", headers: { "Content-Type": "application/octet-stream", "If-None-Match": "*" } } });
    if (path === `/internal/agent-api/attachment-upload-sessions/${UPLOAD_ID}/complete`) return complete(completes++);
    if (path === `/internal/agent-api/attachment-upload-sessions/${UPLOAD_ID}`) return Response.json({ uploadId: UPLOAD_ID, state: "canceled", expiresAt: T, attachment: null, terminalReason: "Canceled." });
    return new Response(`unexpected ${path}`, { status: 500 });
  }, calls);
  const puts: Array<{ url: string; init: RequestInit }> = [];
  const transport = {
    serverUrl: "https://raft.example",
    headers: {},
    authorization: "Bearer sk_agent_test",
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      puts.push({ url: String(input), init: init ?? {} });
      return put(puts.length - 1);
    }) as typeof fetch,
  };
  return { api, transport, calls, puts };
}

const completed = () => Response.json({ uploadId: UPLOAD_ID, state: "completed", attachment: { id: ATTACHMENT_ID, filename: "big.bin", mimeType: "application/octet-stream", sizeBytes: 2000, thumbnailUrl: null } });
const bigFile = { target: "#proj-sdk", filename: "big.bin", bytes: new Uint8Array(2000).fill(7) };

test("attachments: files at the direct-upload threshold go through an upload session like the CLI", async () => {
  const f = sessionFixture(() => new Response(null, { status: 200 }), completed);
  const outcome = await uploadAttachment(f.api, f.transport, bigFile);
  assert.equal(outcome.ok && outcome.state, "uploaded");
  const create = f.calls.find((c) => c.path === "/internal/agent-api/attachment-upload-sessions");
  assert.deepEqual({ ...(create?.body as Record<string, unknown>), clientRequestId: "x" }, { channelId: "11111111-1111-4111-8111-111111111111", filename: "big.bin", mimeType: "application/octet-stream", sizeBytes: 2000, clientRequestId: "x" });
  assert.equal(f.puts.length, 1);
  assert.equal(f.puts[0]?.url, "https://r2.example.test/upload");
  assert.equal(f.puts[0]?.init.method, "PUT");
  assert.equal(new Headers(f.puts[0]?.init.headers).get("if-none-match"), "*", "the presigned headers are sent as signed");
  assert.equal(new Headers(f.puts[0]?.init.headers).get("authorization"), null, "no Raft credential goes to object storage");
  assert.equal((f.puts[0]?.init.body as ArrayBuffer).byteLength, 2000);
  if (outcome.ok) {
    assert.equal(outcome.data.id, ATTACHMENT_ID);
    assert.equal(outcome.next?.command, `raft message send --target "#proj-sdk" --attachment-id ${ATTACHMENT_ID}`);
  }
});

test("attachments: a 412 means the conditional PUT already landed; a lost PUT response is left for completion to verify", async () => {
  const already = sessionFixture(() => new Response(null, { status: 412 }), completed);
  assert.equal((await uploadAttachment(already.api, already.transport, bigFile)).ok, true);

  const lost = sessionFixture(() => { throw new Error("connection reset"); }, completed);
  const outcome = await uploadAttachment(lost.api, lost.transport, bigFile);
  assert.equal(lost.puts.length, 2, "one retry");
  assert.equal(outcome.ok, true, "completion verified the object");
  assert.equal(lost.calls.some((c) => c.method === "DELETE"), false, "the session is not cancelled when the write may exist");
});

test("attachments: a definite PUT failure cancels the session; completion retries while the Server verifies", async () => {
  const denied = sessionFixture(() => new Response(null, { status: 403 }), completed);
  const failed = await uploadAttachment(denied.api, denied.transport, bigFile);
  assert.equal(failed.ok ? null : failed.error.status, 403);
  assert.ok(denied.calls.some((c) => c.method === "DELETE" && c.path === `/internal/agent-api/attachment-upload-sessions/${UPLOAD_ID}`));
  assert.equal(denied.calls.some((c) => c.path.endsWith("/complete")), false);

  const verifying = sessionFixture(() => new Response(null, { status: 200 }), (n) => n < 2
    ? Response.json({ error: "verifying", errorCode: "UPLOAD_VERIFICATION_IN_PROGRESS" }, { status: 409 })
    : completed());
  const outcome = await uploadAttachment(verifying.api, verifying.transport, bigFile);
  assert.equal(outcome.ok, true);
  assert.equal(verifying.calls.filter((c) => c.path.endsWith("/complete")).length, 3);
});

test("actions: prepare posts an existing card type and returns the CLI text", async () => {
  const calls: Array<{ method: string; path: string; body: unknown; init: RequestInit }> = [];
  const api = client(() => Response.json({ messageId: "abcdef12-0000-4000-8000-000000000000", metadata: { kind: "action-card" } }), calls);
  const action = { type: "channel:create", name: "launch-room", visibility: "public" };
  const outcome = await prepareActionCard(api, { target: "#proj-sdk", action } as never);
  const generatedKey = (calls[0]?.body as { idempotencyKey?: string }).idempotencyKey;
  assert.match(generatedKey ?? "", /^[0-9a-f-]{36}$/, "a key is generated when the caller gives none");
  assert.deepEqual(calls[0]?.body, { target: "#proj-sdk", action, idempotencyKey: generatedKey });
  assert.equal(outcome.ok && outcome.state, "prepared");
  if (outcome.ok) {
    assert.equal(outcome.data.idempotencyKey, generatedKey, "the generated key is returned so the caller can retry with it");
    assert.equal(outcome.text, "Action card posted to #proj-sdk as message abcdef12-0000-4000-8000-000000000000 (short abcdef12). The human can click the action verb to commit.\n");
    assert.deepEqual(outcome.next, {
      kind: "await_confirmation",
      command: `raft message read --target "#proj-sdk:abcdef12"`,
      args: { target: "#proj-sdk:abcdef12", messageId: "abcdef12-0000-4000-8000-000000000000" },
      operation: { name: "messages.read", args: { target: "#proj-sdk:abcdef12" } },
      why: "A human must click the card to commit it. When it is executed (or fails), the outcome arrives as a reply in the card's thread that @mentions you; you do not need to poll.",
    });
  }
  // A card posted inside a thread has no thread of its own: the outcome reply lands in that thread.
  const inThread = await prepareActionCard(api, { target: "dm:@richard:1234abcd", action } as never);
  assert.deepEqual(inThread.ok && inThread.next, {
    kind: "await_confirmation",
    command: `raft message read --target "dm:@richard:1234abcd" --around abcdef12`,
    args: { target: "dm:@richard:1234abcd", around: "abcdef12-0000-4000-8000-000000000000", messageId: "abcdef12-0000-4000-8000-000000000000" },
    operation: { name: "messages.read", args: { target: "dm:@richard:1234abcd", around: "abcdef12-0000-4000-8000-000000000000" } },
    why: "A human must click the card to commit it. When it is executed (or fails), the outcome arrives as a reply in this thread that @mentions you; you do not need to poll.",
  });
});

test("actions: a plan:upgrade card has no outcome to wait for; a repeat points to the card already there", async () => {
  const id = "abcdef12-0000-4000-8000-000000000000";
  const action = { type: "plan:upgrade", reason: "You asked for messages from March, which are older than 30 days.", gate: "history_30d" };
  const posted = await prepareActionCard(
    client(() => Response.json({ messageId: id, metadata: { kind: "action-card" } }, { status: 201 })),
    { target: "#proj-sdk", action } as never,
  );
  assert.equal(posted.ok && posted.state, "prepared");
  if (posted.ok) {
    assert.equal(posted.data.existing, false);
    assert.equal(posted.text, `Upgrade card posted to #proj-sdk as message ${id} (short abcdef12). Its button only opens the upgrade dialog; no reply will follow, and you are not told whether they upgrade.\n`);
    // No await_confirmation: nothing executes, so no outcome reply ever comes.
    assert.deepEqual(posted.next, {
      kind: "continue_work",
      args: { target: "#proj-sdk", messageId: id },
      why: "The card's button only opens the upgrade dialog for whoever presses it; no reply will follow, so do not wait for one. Continue your work.",
    });
  }

  // Within a day the Server answers with the card already there (200, `existing`): read it to point the person to it.
  const existing = await prepareActionCard(
    client(() => Response.json({ messageId: id, metadata: { kind: "action-card" }, existing: true })),
    { target: "#proj-sdk", action } as never,
  );
  assert.equal(existing.ok && existing.state, "prepared");
  if (existing.ok) {
    assert.equal(existing.data.existing, true);
    assert.equal(existing.text, `This card is already in #proj-sdk as message ${id} (short abcdef12), posted in the last 24 hours; nothing new was posted.\n`);
    assert.deepEqual(existing.next, {
      kind: "read_existing_card",
      command: `raft message read --target "#proj-sdk" --around abcdef12`,
      args: { target: "#proj-sdk", around: id, messageId: id },
      operation: { name: "messages.read", args: { target: "#proj-sdk", around: id } },
      why: "Nothing new was posted: the same upgrade card is already in this conversation from the last 24 hours. Read it to point the person to it; its button only opens the upgrade dialog, and no reply will follow.",
    });
  }
  // A hosted agent calling operations as tools gets the tool call, same words.
  const tool = await prepareActionCard(
    client(() => Response.json({ messageId: id, metadata: { kind: "action-card" }, existing: true })),
    { target: "dm:@richard:1234abcd", action } as never,
    { hints: "tool" },
  );
  assert.equal(tool.ok && tool.next?.command, `messages_read({ target: "dm:@richard:1234abcd", around: "${id}" })`);

  // The CLI prints the shared formatter's words, so both kinds of agent read the same.
  assert.equal(formatAgentActionCardPosted("#proj-sdk", id, { type: "plan:upgrade", existing: true }), existing.ok ? existing.text : null);
  assert.equal(formatAgentActionCardPosted("#proj-sdk", id, { type: "plan:upgrade" }), posted.ok ? posted.text : null);
  assert.equal(
    formatAgentActionCardPosted("#proj-sdk", id),
    `Action card posted to #proj-sdk as message ${id} (short abcdef12). The human can click the action verb to commit.\n`,
  );
});

test("actions: a plan:upgrade reason still in its <…> placeholder: the documented schema refuses it, saying so; a direct call leaves it to the Server", async () => {
  const request = { target: "#general", action: { type: "plan:upgrade", gate: "history_30d", reason: "<one sentence: why they need the older messages>" } };
  // The manifest's schema (what `invoke` checks a tool call against) knows the card.
  const refused = validateOpRequest(prepareActionCardRequestSchema, request);
  assert.equal(refused?.error.code, "INVALID_REQUEST");
  assert.ok(
    refused?.error.message.startsWith('Invalid request: action.reason: plan:upgrade "reason" is still the placeholder: replace <…> with your own sentence on why this person needs Pro.'),
    refused?.error.message,
  );
  assert.ok(refused?.text.includes("is still the placeholder"), refused?.text);

  // The operation itself sends it: the Server checks the card, and its refusal is what the agent reads.
  const calls: Array<{ method: string; path: string; body: unknown; init: RequestInit }> = [];
  const why = 'plan:upgrade "reason" is still the placeholder: replace <…> with your own sentence on why this person needs Pro.';
  const sent = await prepareActionCard(client(() => Response.json({ error: why, code: "INVALID_ACTION" }, { status: 400 }), calls), request as never);
  assert.equal(calls.length, 1, "sent to the Server");
  assert.equal(!sent.ok && sent.error.message, why);
});

test("actions: prepare sends a card type this version does not know; only a missing type is refused here", async () => {
  const calls: Array<{ method: string; path: string; body: unknown; init: RequestInit }> = [];
  const api = client(() => Response.json({ messageId: "abcdef12-0000-4000-8000-000000000000", metadata: { kind: "action-card" } }, { status: 201 }), calls);
  const action = { type: "future:card", title: "Plan the offsite", attendees: ["@alice"] };
  const sent = await prepareActionCard(api, { target: "#proj-sdk", action });
  assert.equal(sent.ok && sent.state, "prepared");
  assert.deepEqual((calls[0]?.body as { action?: unknown }).action, action, "the card as written");
  assert.equal(sent.ok && sent.text, "Action card posted to #proj-sdk as message abcdef12-0000-4000-8000-000000000000 (short abcdef12). The human can click the action verb to commit.\n");

  for (const missing of [{ title: "no type" }, { type: "  " }, { type: 7 }]) {
    const refused = await prepareActionCard(api, { target: "#proj-sdk", action: missing } as never);
    assert.equal(!refused.ok && refused.error.code, "INVALID_REQUEST", JSON.stringify(missing));
    assert.equal(!refused.ok && refused.error.message, 'The action needs a "type": the card type, for example "channel:create"; nothing was sent.', JSON.stringify(missing));
  }
  assert.equal(calls.length, 1, "nothing sent for a card without a type");
});

test("actions: a refusal keeps the Server's sentence (what is wrong with the card) and its next step", async () => {
  const why = 'The card was refused: plan:upgrade takes only "reason" and an optional "gate". Remove the other fields.';
  const next = "Fix the fields named above and prepare the card again.";
  const refused = await prepareActionCard(
    client(() => Response.json({ error: why, code: "INVALID_ACTION", suggestedNextAction: next }, { status: 400 })),
    { target: "#general", action: { type: "plan:upgrade", reason: "You asked for older messages.", message: "Upgrade!" } } as never,
  );
  assert.equal(refused.ok, false);
  if (!refused.ok) {
    assert.equal(refused.error.message, why);
    assert.equal(refused.error.nextAction, next);
    assert.equal(refused.error.serverCode, "INVALID_ACTION");
    assert.equal(refused.error.status, 400);
    assert.equal(refused.error.retryable, false);
    assert.equal(refused.next?.kind, "recover", "a refusal is not retried with the same key");
    assert.ok(refused.text.startsWith(`Error: ${why}\n`), refused.text);
  }
  // A Server error (5xx) keeps the SDK's own words: its body is not written for agents.
  const down = await prepareActionCard(
    client(() => Response.json({ error: "db pool exhausted at 10.0.0.7" }, { status: 503 })),
    { target: "#general", action: { type: "channel:create", name: "x" } } as never,
  );
  assert.equal(!down.ok && down.error.message, "The Raft Server could not serve this operation right now.");
});

test("actions: a plan:upgrade refused in a shared channel tells the agent why and where to post instead", async () => {
  const why = "Upgrade cards can't be posted in a shared channel: upgrading is for this server's own people. Post it in one of this server's channels or a DM instead.";
  const refused = await prepareActionCard(
    client(() => Response.json({ error: why, errorCode: "JOINT_CHANNEL_NOT_ALLOWED", suggestedNextAction: why }, { status: 403 })),
    { target: "#partners", action: { type: "plan:upgrade", reason: "You asked for older messages." } } as never,
  );
  assert.equal(refused.ok, false);
  if (!refused.ok) {
    assert.equal(refused.error.serverCode, "JOINT_CHANNEL_NOT_ALLOWED");
    assert.equal(refused.error.nextAction, why);
    assert.ok(refused.text.includes(`Next action: ${why}`), refused.text);
  }
  // Tool-style hints keep it: it names no CLI command.
  const tool = await prepareActionCard(
    client(() => Response.json({ error: why, errorCode: "JOINT_CHANNEL_NOT_ALLOWED", suggestedNextAction: why }, { status: 403 })),
    { target: "#partners", action: { type: "plan:upgrade", reason: "You asked for older messages." } } as never,
    { hints: "tool" },
  );
  assert.equal(!tool.ok && tool.error.nextAction, why);
});

test("actions: prepare sends the caller's idempotencyKey, never retries by itself, and hands the key back on a retryable failure", async () => {
  const calls: Array<{ method: string; path: string; body: unknown; init: RequestInit }> = [];
  const action = { type: "channel:create", name: "launch-room", visibility: "public" };
  const ok = await prepareActionCard(
    client(() => Response.json({ messageId: "abcdef12-0000-4000-8000-000000000000", metadata: { kind: "action-card" } }), calls),
    { target: "#proj-sdk", action, idempotencyKey: " card-1 " } as never,
  );
  assert.equal((calls[0]?.body as { idempotencyKey?: string }).idempotencyKey, "card-1");
  assert.equal(ok.ok && ok.data.idempotencyKey, "card-1");

  let attempts = 0;
  const down = await prepareActionCard(client(() => { attempts += 1; throw new Error("down"); }), { target: "#proj-sdk", action } as never);
  assert.equal(attempts, 1, "no automatic retry: a Server without keyed prepare would post the card twice");
  assert.equal(down.ok, false);
  if (!down.ok) {
    assert.equal(down.error.code, "TRANSPORT_ERROR");
    assert.equal(down.next?.kind, "retry_same_key");
    assert.match(String(down.next?.args?.idempotencyKey), /^[0-9a-f-]{36}$/);
  }

  const reused = await prepareActionCard(
    client(() => Response.json({ error: "reused", code: "idempotency_key_reused", suggestedNextAction: "use a new idempotencyKey for a different request" }, { status: 409 })),
    { target: "#proj-sdk", action, idempotencyKey: "card-1" } as never,
  );
  assert.equal(reused.ok, false);
  if (!reused.ok) {
    assert.equal(reused.error.code, "IDEMPOTENCY_KEY_REUSED");
    assert.equal(reused.next?.kind, "recover", "a refused key is not retried with the same key");
  }
});
