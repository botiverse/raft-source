import assert from "node:assert/strict";
import { isAgentInMemberLists, isRemovedAppBot, reconcileAgentsList } from "../src/store/agentStore";
import { isSearchableAgent } from "../src/store/searchableAgent";
import type { Agent } from "../src/store/agentStore";

// The agent directory (`GET /agents`) keeps agents member lists leave out, so
// old messages still resolve their sender: deleted agents, and App Bots
// removed from their App, which the server marks `inMemberLists: false` with
// its one member-list condition. Member lists, mention candidates and member
// pickers read that through isAgentInMemberLists.

function agent(id: string, over: Partial<Agent> = {}): Agent {
  return {
    id,
    name: id,
    displayName: null,
    avatarUrl: null,
    description: null,
    status: "active",
    model: "external",
    runtime: "external",
    reasoningEffort: null,
    executionMode: "cloud",
    envVars: null,
    machineId: null,
    creatorType: null,
    creatorId: null,
    creator: null,
    createdAgents: [],
    deletedAt: null,
    createdAt: "1970-01-01T00:00:00.000Z",
    ...over,
  } as Agent;
}

test("isAgentInMemberLists: ordinary and listed Bots are members; deleted agents and removed Bots are not", () => {
  assert.equal(isAgentInMemberLists(agent("plain")), true, "an ordinary agent carries no flag and is listed");
  assert.equal(isAgentInMemberLists(agent("bot", { managedByAppInstallId: "i1", inMemberLists: true })), true);
  assert.equal(isAgentInMemberLists(agent("removed-bot", { managedByAppInstallId: "i2", inMemberLists: false })), false);
  assert.equal(isAgentInMemberLists(agent("gone", { deletedAt: "2026-10-01T00:00:00.000Z" })), false);
});

test("isAgentInMemberLists: a personal assistant is its owner's, never a member, even from a record without the marking", () => {
  assert.equal(isAgentInMemberLists(agent("assistant", { assistantOwnerUserId: "u1", inMemberLists: false })), false);
  assert.equal(isAgentInMemberLists(agent("assistant-created", { assistantOwnerUserId: "u1" })), false, "agent:created carries no inMemberLists");
  assert.equal(isRemovedAppBot(agent("assistant", { assistantOwnerUserId: "u1", inMemberLists: false })), false, "its DM stays writable");
});

test("a Bot removed or re-added is a changed directory row, so member lists re-render on the reload", () => {
  const listed = agent("bot", { managedByAppInstallId: "i1", inMemberLists: true });
  const [removed] = reconcileAgentsList([listed], [{ ...listed, inMemberLists: false }]);
  assert.notStrictEqual(removed, listed);
  assert.equal(isAgentInMemberLists(removed!), false);
  const [readded] = reconcileAgentsList([removed!], [{ ...removed!, inMemberLists: true }]);
  assert.notStrictEqual(readded, removed);
  assert.equal(isAgentInMemberLists(readded!), true);
});

test("isRemovedAppBot: only an App Bot out of member lists; its DM and the DM's threads go read-only", () => {
  assert.equal(isRemovedAppBot(agent("removed-bot", { managedByAppInstallId: "i2", inMemberLists: false })), true);
  assert.equal(isRemovedAppBot(agent("bot", { managedByAppInstallId: "i1", inMemberLists: true })), false, "a listed Bot answers");
  assert.equal(isRemovedAppBot(agent("plain")), false, "an ordinary agent is never a removed Bot");
  assert.equal(isRemovedAppBot(agent("gone", { deletedAt: "2026-10-01T00:00:00.000Z" })), false, "nor is a deleted ordinary agent");
  assert.equal(isRemovedAppBot(undefined), false, "no peer agent (not an agent DM, or not loaded yet)");
});

test("isSearchableAgent: search and pickers offer the viewer's own assistant, never another person's", () => {
  assert.equal(isSearchableAgent(agent("plain"), "u1"), true);
  assert.equal(isSearchableAgent(agent("plain"), null), true);
  assert.equal(isSearchableAgent(agent("gone", { deletedAt: "2026-10-01T00:00:00.000Z" }), "u1"), false);
  assert.equal(isSearchableAgent(agent("mine", { assistantOwnerUserId: "u1" }), "u1"), true, "the owner finds their own");
  assert.equal(isSearchableAgent(agent("theirs", { assistantOwnerUserId: "u2" }), "u1"), false, "another person's never shows");
  assert.equal(isSearchableAgent(agent("theirs", { assistantOwnerUserId: "u2" }), null), false, "nor before the viewer is known");
});
