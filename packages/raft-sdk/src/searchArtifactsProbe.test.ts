// A first-page text search also asks whether an artifact matches (shared
// searchMessages). Where Raft refuses that ask (Artifacts off for the Server,
// or a credential that can't reach it, such as a personal assistant's), the
// SDK client stops asking for a while instead of sending a refused request
// with every search.
import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { createRaft } from "./index";

const RESULT = { id: "abcdef12-0000-4000-8000-000000000000", seq: 10, channelId: "c", threadId: null, parentMessageId: null, parentMessageContent: null, parentChannelId: "c", parentChannelName: "ops", parentChannelType: "channel", parentChannelArchivedAt: null, senderId: "u", senderType: "human", senderName: "richard", channelName: "ops", channelType: "channel", channelArchivedAt: null, content: "deploy plan", snippet: "deploy plan", createdAt: "2026-10-27T08:00:00.000Z" };

const SUMMARY = { id: "pt_abc", url: "https://app.raft.build/artifacts/pt_abc", name: "deploy-plan", title: "Deploy plan", description: null, kind: "html", home: { kind: "server" }, currentVersion: 1, author: { type: "agent", name: "Remy" }, createdAt: "2026-10-20T08:00:00.000Z", updatedAt: "2026-10-22T14:02:00.000Z" };

function server(artifacts: () => Response) {
  const asked: string[] = [];
  const fetch = async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname.replace("/internal/agent-api", "");
    if (path === "/search") return Response.json({ results: [RESULT], hasMore: false });
    if (path === "/artifacts") {
      asked.push(path);
      return artifacts();
    }
    return Response.json({ error: "not in this fake" }, { status: 404 });
  };
  return { asked, raft: createRaft({ serverUrl: "https://raft.example", credential: "sk_agent_probe", fetch }) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

test("after Raft refuses the artifacts ask, searches skip it for 10 minutes, then ask again", async () => {
  let now = Date.parse("2026-10-27T13:00:00Z");
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const { asked, raft } = server(() => Response.json({ error: "not allowed", code: "assistant_route_not_allowed" }, { status: 403 }));

  const first = await raft.messages.search({ query: "deploy plan" });
  assert.ok(first.ok);
  assert.equal(asked.length, 1, "the first search asks");
  assert.ok(first.ok && !first.text.includes("Artifacts also match"));

  now += 9 * 60_000;
  const second = await raft.messages.search({ query: "deploy plan" });
  assert.ok(second.ok, "the search itself is unaffected");
  assert.equal(asked.length, 1, "within the pause: no ask");

  now += 2 * 60_000;
  await raft.messages.search({ query: "deploy plan" });
  assert.equal(asked.length, 2, "after the pause: asks again");
});

test("an answered ask keeps asking on every search and shows the line on a match; other failures don't pause it", async () => {
  let status = 200;
  const { asked, raft } = server(() => status === 200
    ? Response.json({ artifacts: [{ ...SUMMARY, matches: [] }], nextCursor: null, target: null })
    : Response.json({ error: "boom" }, { status }));

  const matched = await raft.messages.search({ query: "deploy plan" });
  assert.ok(matched.ok && matched.text.includes(`Artifacts also match "deploy plan"`), matched.ok ? matched.text : "");
  status = 500;
  await raft.messages.search({ query: "deploy plan" });
  status = 200;
  await raft.messages.search({ query: "deploy plan" });
  assert.equal(asked.length, 3, "a 500 is not a refusal: the next search asks again");
});
