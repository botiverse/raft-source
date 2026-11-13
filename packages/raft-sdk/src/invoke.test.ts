import assert from "node:assert/strict";

import { createRaft, isInterrupted, RAFT_OPERATIONS, type Raft } from "./index";
import { OPERATION_SAMPLES } from "./operationSamples.testkit";

const credential = "sk_agent_invoke_test";
const sample = (seq: number) => ({ channel_type: "channel", channel_name: "general", message_id: `${String(seq).padStart(8, "0")}-1111-2222-3333-444444444444`, timestamp: "2026-08-31T08:00:00.000Z", sender_type: "human", sender_name: "richard", content: `m${seq}`, seq });

interface Call { method: string; path: string; body: unknown }

/** A Server that answers the common routes plausibly and records every request. */
function fakeServer(options: { holdSends?: boolean } = {}) {
  const calls: Call[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = `${url.pathname}${url.search}`;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : init?.body === undefined ? undefined : "<binary>";
    calls.push({ method: init?.method ?? "GET", path, body });
    const p = url.pathname.replace("/internal/agent-api", "");
    if (p === "/context") return Response.json({ agent: { id: "a", name: "grace", displayName: null, description: null, runtime: "external", external: true }, server: { id: "s", slug: "botiverse", name: "Botiverse" }, credential: { capabilities: ["read", "send"] }, prompt: { audience: "self-hosted-runner", text: "guide" } });
    if (p === "/events") {
      const acked = Number(url.searchParams.get("since")) >= 1200; // one row, acknowledged by a later pull
      return Response.json({ events: acked ? [] : [sample(1200)], last_seen_msgId: null, last_seen_seq: 1200, reply_target: "#general", has_more: false, ack_mode: "cursor" });
    }
    if (p === "/history") return Response.json({ target: "#general", messages: [sample(1200), sample(1201)], has_more: false, has_older: false, has_newer: false, last_read_seq: 1199, model_seen_up_to_seq: 1201 });
    if (p === "/server") return Response.json({ runtimeContext: { agentId: "a", serverId: "s" }, channels: [{ id: "c-1", name: "general", joined: true }], agents: [], humans: [] });
    if (p === "/v2/send") {
      if (options.holdSends) {
        return Response.json({ ok: true, state: "held", outcome: "held", subtype: "freshness", reason: "newer_messages_available", decision: "syncing_hold", producerFactId: "f", available_actions: [], heldMessages: [sample(1300)], newMessageCount: 1, shownMessageCount: 1, omittedMessageCount: 0, seenUpToSeq: 1300 });
      }
      return Response.json({ ok: true, state: "sent", messageId: "m-1", messageSeq: 1202 });
    }
    if (p === "/tasks/assign") return Response.json({ ok: true, revision: 2, assignee: (body as { assignee?: string | null } | undefined)?.assignee ?? null });
    return Response.json({ error: "not in this fake" }, { status: 500 });
  }) as typeof fetch;
  return { fetch, calls };
}

function raftOn(server: ReturnType<typeof fakeServer>, extra: Partial<Parameters<typeof createRaft>[0]> = {}): Raft {
  return createRaft({ serverUrl: "https://raft.example", credential, fetch: server.fetch, ...extra });
}

test("invoke dispatches every manifest operation to the typed implementation, request for request", async () => {
  assert.deepEqual(Object.keys(OPERATION_SAMPLES).sort(), RAFT_OPERATIONS.map((op) => op.name).sort());
  for (const op of RAFT_OPERATIONS) {
    const s = OPERATION_SAMPLES[op.name as keyof typeof OPERATION_SAMPLES];
    const typedServer = fakeServer();
    await s.typed(raftOn(typedServer));
    const invokeServer = fakeServer();
    const outcome = await raftOn(invokeServer).invoke(op.name, s.args);
    assert.deepEqual(invokeServer.calls, typedServer.calls, `${op.name}: same requests`);
    if (!outcome.ok) assert.notEqual(outcome.error.code, "INVALID_REQUEST", `${op.name}: the sample is valid (${outcome.error.message})`);
    if (op.name !== "inbox.commit") assert.ok(invokeServer.calls.length > 0, `${op.name}: reached the server`);
  }
});

test("invoke folds the non-outcome operations into outcomes", async () => {
  const raft = raftOn(fakeServer());
  const me = await raft.invoke("identity.whoami");
  assert.equal(me.ok && me.state, "identity");
  assert.match(me.text, /@grace on Botiverse\. Credential capabilities: read, send\.\n\nguide/);
  const checked = await raft.invoke("inbox.check");
  assert.equal(checked.ok && checked.state, "batch");
  const committed = await raft.invoke("inbox.commit", {});
  assert.equal(committed.ok && committed.state, "committed");
  assert.equal(committed.ok && (committed.data as { cursor: number }).cursor, 1200);
  const nothing = await raft.invoke("inbox.commit");
  assert.equal(nothing.ok && nothing.state, "nothing");
  const drained = await raftOn(fakeServer()).invoke("inbox.drain", {});
  assert.equal(drained.ok && drained.state, "batch");
  assert.equal(drained.ok && (drained.data as { messages: unknown[]; batches: number }).messages.length, 1);
  assert.match(drained.text, /m1200\nNo more new inbox messages\./);
});

test("invoke refuses unknown names and invalid arguments with INVALID_REQUEST, before any request", async () => {
  const server = fakeServer();
  const raft = raftOn(server);
  const unknown = await raft.invoke("messages.teleport", {});
  assert.equal(!unknown.ok && unknown.error.code, "INVALID_REQUEST");
  assert.match(unknown.text, /Unknown operation "messages\.teleport"/);
  const hostile = await raft.invoke("x".repeat(500), {});
  assert.equal(!hostile.ok && hostile.error.message, "Unknown operation; nothing was sent.");
  for (const name of ["toString", "constructor", "__proto__"]) {
    const inherited = await raft.invoke(name, {});
    assert.equal(!inherited.ok && inherited.error.code, "INVALID_REQUEST");
  }
  const bad = await raft.invoke("messages.send", { target: 42, content: "hi", secret: "sk_agent_leak" });
  assert.equal(!bad.ok && bad.error.code, "INVALID_REQUEST");
  assert.match(!bad.ok ? bad.error.message : "", /^Invalid request: target: .*Nothing was sent\.$/);
  assert.doesNotMatch(bad.text, /42|sk_agent_leak/);
  const badEnum = await raft.invoke("tasks.updateStatus", { target: "#general", taskNumber: 3, status: "finished" });
  assert.equal(!badEnum.ok && badEnum.error.code, "INVALID_REQUEST");
  const badOrigin = await raft.invoke("server.info", {}, { origin: "robot" as never });
  assert.equal(!badOrigin.ok && badOrigin.error.code, "INVALID_REQUEST");
  assert.equal(server.calls.length, 0);
});

test("from code, model-only operations are refused with MODEL_ONLY and send nothing", async () => {
  const server = fakeServer();
  const raft = raftOn(server);
  await raft.inbox.check(); // a pending batch exists
  const before = server.calls.length;
  for (const name of ["inbox.check", "inbox.drain", "inbox.commit"]) {
    const refused = await raft.invoke(name, {}, { origin: "code" });
    assert.equal(!refused.ok && refused.error.code, "MODEL_ONLY", name);
    assert.equal(!refused.ok && refused.error.retryable, false);
  }
  assert.equal(server.calls.length, before);
  assert.equal(raft.state.snapshot().cursor, null, "nothing was committed");
  assert.equal(raft.state.snapshot().pendingCursor, 1200);
  // Non-model-only operations run from code as usual.
  const info = await raft.invoke("server.info", {}, { origin: "code" });
  assert.equal(info.ok, true);
});

test("a read from code is forced to consume:false and records nothing in the frontier", async () => {
  const server = fakeServer();
  const raft = raftOn(server);
  const page = await raft.invoke("messages.read", { target: "#general", consume: true }, { origin: "code" });
  assert.equal(page.ok && page.state, "page");
  assert.equal(server.calls[0]?.path, "/internal/agent-api/history?channel=%23general&consume=false");
  assert.deepEqual(raft.frontier.snapshot(), { version: 1, targets: {}, aliases: {} });
  await raft.invoke("messages.send", { target: "#general", content: "hi", idempotencyKey: "k" });
  assert.deepEqual(server.calls.at(-1)?.body, { target: "#general", content: "hi", idempotencyKey: "k" }, "nothing to attest");
  // The same read from the model consumes and records.
  await raft.invoke("messages.read", { target: "#general" });
  assert.equal(server.calls.at(-1)?.path, "/internal/agent-api/history?channel=%23general");
  assert.deepEqual(raft.frontier.attestation("#general"), { seenUpToSeq: 1201, seenExactSeqs: [] });
});

test("the runtime treats the tool-schema spellings the same: a seq as a string", async () => {
  const asNumber = fakeServer();
  await raftOn(asNumber).invoke("messages.read", { target: "#general", around: 12345 });
  const asString = fakeServer();
  await raftOn(asString).invoke("messages.read", { target: "#general", around: "12345" });
  assert.deepEqual(asString.calls, asNumber.calls);
  assert.equal(asString.calls[0]?.path, "/internal/agent-api/history?channel=%23general&around=12345");
});

test("tasks.assign never clears by omission: a missing or null assignee is INVALID_REQUEST and sends nothing; tasks.unassign clears", async () => {
  for (const args of [{ target: "#general", taskNumber: 3 }, { target: "#general", taskNumber: 3, assignee: null }, { target: "#general", taskNumber: 3, assignee: "" }]) {
    const server = fakeServer();
    const outcome = await raftOn(server).invoke("tasks.assign", args);
    assert.equal(outcome.ok, false, JSON.stringify(args));
    if (!outcome.ok) assert.equal(outcome.error.code, "INVALID_REQUEST");
    assert.equal(server.calls.length, 0, "nothing was sent");
  }
  const server = fakeServer();
  const cleared = await raftOn(server).invoke("tasks.unassign", { target: "#general", taskNumber: 3 });
  assert.equal(cleared.ok, true);
  assert.equal(server.calls.length, 1);
  assert.equal((server.calls[0]?.body as { assignee: unknown }).assignee, null);
});

test("interrupts come back from invoke unchanged", async () => {
  const typed = await raftOn(fakeServer({ holdSends: true })).messages.send({ target: "#general", content: "hi", idempotencyKey: "k-held" });
  const invoked = await raftOn(fakeServer({ holdSends: true })).invoke("messages.send", { target: "#general", content: "hi", idempotencyKey: "k-held" });
  assert.equal(isInterrupted(invoked), true);
  assert.deepEqual(invoked, typed);
  assert.equal(isInterrupted(invoked) && invoked.interrupt.resume.idempotencyKey, "k-held");
});

test("contextId scopes attestation: a send attests only reads from the same model context", async () => {
  const server = fakeServer();
  const raft = raftOn(server);
  await raft.invoke("messages.read", { target: "#general" }, { contextId: "ctx-A" });
  const sendBody = async (caller?: { contextId?: string }) => {
    await raft.invoke("messages.send", { target: "#general", content: "hi", idempotencyKey: `k-${server.calls.length}` }, caller);
    const body = server.calls.at(-1)?.body as Record<string, unknown>;
    return { seenUpToSeq: body.seenUpToSeq, seenExactSeqs: body.seenExactSeqs };
  };
  assert.deepEqual(await sendBody({ contextId: "ctx-B" }), { seenUpToSeq: undefined, seenExactSeqs: undefined }, "another context attests nothing");
  assert.deepEqual(await sendBody({ contextId: "ctx-A" }), { seenUpToSeq: 1201, seenExactSeqs: undefined });
  // No context named and none set: today's behaviour, every booking attests.
  assert.deepEqual(await sendBody(), { seenUpToSeq: 1201, seenExactSeqs: undefined });
  // The frontier's own context applies to typed calls and to invoke without contextId.
  raft.frontier.setContext("ctx-B");
  assert.deepEqual(await sendBody(), { seenUpToSeq: undefined, seenExactSeqs: undefined });
  await raft.messages.send({ target: "#general", content: "typed", idempotencyKey: "k-typed" });
  assert.equal((server.calls.at(-1)?.body as Record<string, unknown>).seenUpToSeq, undefined);
  // A read in a new context replaces the old booking rather than merging into it.
  await raft.messages.read({ target: "#general" });
  assert.deepEqual(raft.frontier.snapshot(), {
    version: 1,
    targets: { "#general": { upTo: 1201, upToContextId: "ctx-B" } },
    aliases: {},
    contextId: "ctx-B",
    // The read order the thread-target check compares (glimpse G2-5); the latest read of the target wins.
    reads: [{ target: "#general", order: 2, seq: 1201, contextId: "ctx-B" }],
  });
  // Snapshot / restore keeps the scoping.
  const restored = createRaft({ serverUrl: "https://raft.example", credential, frontier: raft.frontier.snapshot() });
  assert.equal(restored.frontier.contextId, "ctx-B");
  assert.deepEqual(restored.frontier.attestation("#general"), { seenUpToSeq: 1201, seenExactSeqs: [] });
  assert.deepEqual(restored.frontier.inContext("ctx-A").attestation("#general"), { seenExactSeqs: [] });
});

test("artifacts.move with to: anyone-with-link, as a model calls it, is refused before any request: only a person can, and the move it can make; public is no value of to", async () => {
  const server = fakeServer();
  const outcome = await raftOn(server, { hints: "tool" }).invoke("artifacts.move", { artifact: "pt_abc", to: "anyone-with-link" });
  assert.ok(!outcome.ok);
  assert.deepEqual([outcome.error.code, outcome.error.serverCode, outcome.error.message, outcome.error.nextAction], [
    "INVALID_REQUEST",
    "FORBIDDEN",
    "Only a person can turn on link sharing (anyone with the link can then open it).",
    `Ask a person who manages it to choose "Anyone with the link" under "Who can see" in its ⋯ menu on the web. To let the whole server see it: artifacts_move({ artifact: "pt_abc", to: "server" })`,
  ]);
  // `public`, that home's name on the wire, is refused as any value `to` doesn't take.
  const wire = await raftOn(server, { hints: "tool" }).invoke("artifacts.move", { artifact: "pt_abc", to: "public" });
  assert.ok(!wire.ok && wire.error.code === "INVALID_REQUEST" && !wire.error.serverCode && /\bto\b/.test(wire.error.message), JSON.stringify(wire));
  assert.deepEqual(server.calls, []);
});
