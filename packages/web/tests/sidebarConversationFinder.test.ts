import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildFinderResults,
  finderSearchEntries,
  rankFinderResults,
} from "../src/components/layout/conversationFinderModel";
import type { BuildFinderResultsArgs } from "../src/components/layout/conversationFinderModel";
import type { Channel } from "../src/store/channelStore";
import type { Agent } from "../src/store/agentStore";
import type { ServerMember } from "../src/store/serverStore";

// Regression guard for the "Find a conversation…" sidebar jump box
// (#kabi-desktop). Pins the dedup / exclusion / ranking contract that the React
// component relies on, without needing a DOM.

const channel = (over: Partial<Channel>): Channel =>
  ({ id: "c", name: "channel", description: null, type: "channel", createdAt: "", ...over }) as Channel;
const dm = (over: Partial<Channel>): Channel =>
  ({ id: "d", name: "dm", type: "dm", createdAt: "", ...over }) as Channel;
const agent = (over: Partial<Agent>): Agent =>
  ({ id: "a", name: "agent", displayName: null, ...over }) as Agent;
const member = (over: Partial<ServerMember>): ServerMember =>
  ({ userId: "u", name: "user", displayName: null, ...over }) as ServerMember;

const AGENT_TAG = "Agent";

function build(over: Partial<BuildFinderResultsArgs>) {
  return buildFinderResults({
    channels: [],
    dmChannels: [],
    agents: [],
    members: [],
    currentUserId: null,
    agentTag: AGENT_TAG,
    ...over,
  });
}

test("channels of type dm/thread are excluded; real channels carry the private flag", () => {
  const results = build({
    channels: [
      channel({ id: "c1", name: "general", type: "channel" }),
      channel({ id: "c2", name: "secret", type: "private" }),
      channel({ id: "c3", name: "shadow-dm", type: "dm" }),
      channel({ id: "c4", name: "a-thread", type: "thread" }),
    ],
  });
  const kinds = results.map((r) => r.key);
  assert.deepEqual(kinds, ["channel:c1", "channel:c2"]);
  const priv = results.find((r) => r.key === "channel:c2");
  assert.equal(priv?.kind === "channel" && priv.private, true);
  const pub = results.find((r) => r.key === "channel:c1");
  assert.equal(pub?.kind === "channel" && pub.private, false);
});

test("agents and people that already have a DM are deduped away (represented by the DM)", () => {
  const results = build({
    dmChannels: [
      dm({ id: "d1", peerType: "agent", peerId: "a1", peerName: "grok", peerDisplayName: "grok bot" }),
      dm({ id: "d2", peerType: "user", peerId: "u1", peerName: "wawqaq", peerDisplayName: "WAWQAQ" }),
    ],
    agents: [agent({ id: "a1", name: "grok" }), agent({ id: "a2", name: "helper" })],
    members: [member({ userId: "u1", name: "wawqaq" }), member({ userId: "u2", name: "eric" })],
  });
  const keys = results.map((r) => r.key).sort();
  // a1/u1 appear only as DMs; a2/u2 appear as agent/human entries.
  assert.deepEqual(keys, ["agent:a2", "dm:d1", "dm:d2", "human:u2"].sort());
});

test("the current user is never listed", () => {
  const results = build({
    members: [member({ userId: "me", name: "me" }), member({ userId: "u2", name: "eric" })],
    currentUserId: "me",
  });
  assert.deepEqual(results.map((r) => r.key), ["human:u2"]);
});

test("agent conversations carry the localized agent tag; user DMs do not", () => {
  const results = build({
    dmChannels: [
      dm({ id: "d1", peerType: "agent", peerId: "a1", peerDisplayName: "grok bot" }),
      dm({ id: "d2", peerType: "user", peerId: "u1", peerDisplayName: "WAWQAQ" }),
    ],
    agents: [agent({ id: "a2", name: "helper" })],
  });
  const agentDm = results.find((r) => r.key === "dm:d1");
  const userDm = results.find((r) => r.key === "dm:d2");
  const bareAgent = results.find((r) => r.key === "agent:a2");
  assert.equal(agentDm?.sublabel, AGENT_TAG);
  assert.equal(userDm?.sublabel, null);
  assert.equal(bareAgent?.sublabel, AGENT_TAG);
});

test("ranking: empty query yields nothing; a name query matches by label", () => {
  const results = build({
    channels: [channel({ id: "c1", name: "general" }), channel({ id: "c2", name: "design-review", type: "private" })],
    agents: [agent({ id: "a1", name: "design-bot", displayName: "Design Bot" })],
  });
  const entries = finderSearchEntries(results);

  assert.deepEqual(rankFinderResults("", entries), []);
  assert.deepEqual(rankFinderResults("   ", entries), []);

  const design = rankFinderResults("design", entries).map((r) => r.key);
  assert.ok(design.includes("channel:c2"), "design-review channel matches");
  assert.ok(design.includes("agent:a1"), "Design Bot agent matches");
  assert.ok(!design.includes("channel:c1"), "general does not match 'design'");
});

test("ranking matches a channel description as a secondary field", () => {
  const results = build({
    channels: [channel({ id: "c1", name: "general", description: "Company-wide announcements" })],
  });
  const entries = finderSearchEntries(results);
  const hit = rankFinderResults("announcements", entries).map((r) => r.key);
  assert.deepEqual(hit, ["channel:c1"]);
});
