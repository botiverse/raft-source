import assert from "node:assert/strict";
import { formatAgentInboxReadText } from "@botiverse/raft-shared/src/agentCliSurface";
import { createRaft } from "./index";

// RFC 081 D15 (#wg-ax:#20): inbox.read is `raft inbox read` for the SDK. One
// page of one item, sent once and never retried (the Server consumes what it
// returns), the same text as the CLI, and what it gives out booked as seen.

const credential = "sk_agent_raft_test";
const entry = { channel_type: "channel", channel_name: "general", message_id: "00000000-1111-2222-3333-444444444444", timestamp: "2026-11-09T08:00:00.000Z", sender_type: "human", sender_name: "richard", content: "deploy is green", seq: 1201 };
const page = { target: "#general", kind: "conversation", entries: [entry], unreadBefore: 3, remaining: 2, remainingCapped: false, consumed: false, nextCursor: null };

function fakeServer(respond: (body: unknown) => Response) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const raft = createRaft({
    serverUrl: "https://raft.example",
    credential,
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method: init?.method ?? "GET", path: url.pathname, body });
      if (url.pathname.endsWith("/inbox/read")) return respond(body);
      return Response.json({ error: "unexpected" }, { status: 500 });
    },
  });
  return { raft, calls };
}

test("inbox.read posts one page's request and returns the CLI's page text", async () => {
  const { raft, calls } = fakeServer(() => Response.json(page));
  const read = await raft.inbox.read({ target: "#general", limit: 5 });
  assert.equal(read.ok, true);
  if (!read.ok) return;
  assert.deepEqual(calls.map((c) => [c.method, c.path.replace(/^.*\/agent-api/, "")]), [["POST", "/inbox/read"]]);
  assert.deepEqual(calls[0]!.body, { target: "#general", limit: 5 });
  assert.equal(read.state, "read");
  assert.equal(read.data.remaining, 2);
  assert.equal(read.data.consumed, false);
  assert.equal(read.data.entries.length, 1);
  assert.equal(read.text, formatAgentInboxReadText({ response: page as never, entries: [entry] as never }), "the same page the CLI prints");
  assert.match(read.text.split("\n")[0]!, /^Showing 1 of 3 unread on #general; 2 left\.$/);
  assert.equal(read.next?.kind, "read_inbox_item", "more is left: read the same item again");
});

test("inbox.read is sent once: a failed answer is not retried (it would consume again)", async () => {
  const { raft, calls } = fakeServer(() => Response.json({ error: "boom" }, { status: 503 }));
  const read = await raft.inbox.read({ target: "#general" });
  assert.equal(read.ok, false);
  assert.equal(calls.filter((c) => c.path.endsWith("/inbox/read")).length, 1);
});

test("a page that empties the item points back to the list; nothing to read is `empty`", async () => {
  const done = fakeServer(() => Response.json({ ...page, remaining: 0, consumed: true }));
  const last = await done.raft.inbox.read({ target: "#general" });
  assert.ok(last.ok);
  assert.equal(last.next?.kind, "list_inbox");
  const none = fakeServer(() => Response.json({ ...page, entries: [], unreadBefore: 0, remaining: 0, consumed: true }));
  const empty = await none.raft.inbox.read({ target: "#general" });
  assert.ok(empty.ok);
  assert.equal(empty.state, "empty");
});

test("in tool style the next step is the inbox_read tool, not a CLI command", async () => {
  const raft = createRaft({
    serverUrl: "https://raft.example",
    credential,
    hints: "tool",
    fetch: async () => Response.json(page),
  });
  const read = await raft.inbox.read({ target: "#general" });
  assert.ok(read.ok);
  assert.match(read.text, /inbox_read\(/);
  assert.doesNotMatch(read.text, /raft inbox read/);
});

test("a request outside the contract is refused before anything is sent", async () => {
  const { raft, calls } = fakeServer(() => Response.json(page));
  const read = await raft.inbox.read({ target: "#general", limit: 21 });
  assert.equal(read.ok, false);
  assert.equal(calls.length, 0);
});

test("410 EXPIRED on a reaction item says its reactions were removed (the CLI's sentence); another item keeps the Server's", async () => {
  const target = "app:system.reaction-notices/msg/3f2a1c9e-1111-4222-8333-444455556666";
  const expired = () => Response.json({ code: "EXPIRED", error: "Every notice in this item has expired and is no longer kept." }, { status: 410 });
  const { raft } = fakeServer(expired);
  const read = await raft.inbox.read({ target });
  assert.equal(read.ok, false);
  if (read.ok) return;
  assert.equal(read.error.message, "There is nothing to read here: the reactions on this message were removed before you read them, or the notice expired (notices are kept 7 days).");
  assert.equal(read.error.serverCode, "EXPIRED");
  assert.equal(read.error.nextAction, "raft inbox check");

  const tool = createRaft({ serverUrl: "https://raft.example", credential, hints: "tool", fetch: async () => expired() });
  const toolRead = await tool.inbox.read({ target });
  assert.ok(!toolRead.ok);
  assert.equal(toolRead.error.nextAction, "inbox_list({})");

  const other = await fakeServer(expired).raft.inbox.read({ target: "app:stamp/pr-9" });
  assert.ok(!other.ok);
  assert.equal(other.error.message, "Every notice in this item has expired and is no longer kept.");
});
