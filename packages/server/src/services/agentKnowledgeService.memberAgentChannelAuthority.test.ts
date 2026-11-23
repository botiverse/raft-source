import assert from "node:assert/strict";
import { canAddChannelMembers, hasServerCapability } from "@botiverse/raft-shared";
import { resolveAgentKnowledgeDoc } from "./agentKnowledgeService";

// Four pages told a member-role agent it cannot create a channel or add
// members, and pointed it at an action card instead. The server disagrees:
// createPublicChannels / createPrivateChannels are member capabilities, and canAddChannelMembers admits any
// current member of that channel. The shared mistake was treating "server
// admin" and "channel admin" as one tier (Josh's sweep, 2026-09-23).

test("implementation keeps both operations reachable for a member", () => {
  assert.equal(hasServerCapability("member", "createPublicChannels"), true);
  assert.equal(hasServerCapability("member", "createPrivateChannels"), true);
  assert.equal(
    canAddChannelMembers({
      serverRole: "member",
      admissionClass: "current_member",
      isChannelMember: true,
      channelType: "channel",
      channelName: "general",
      archived: false,
      deleted: false,
    }),
    true,
  );
});

// Each page gets an assertion against ITS OWN old sentence. The first version
// of this file looped one pair of regexes over all four pages, which read like
// four-page coverage but matched only two of them: agent-draft-human-commit and
// membership could have been reverted in full and stayed green. A negative
// assertion that can never fail on the page it names is worse than none, since
// the loop advertises the coverage (Cat, 2026-09-23).
const REVERTED_CLAIM: Record<string, RegExp> = {
  "action-cards": /can't create channels or add members directly/i,
  "common-worked-patterns": /member-role agent wants to create a channel[^.]*doesn't have direct CLI authority/i,
  "agent-draft-human-commit": /for a \*\*member\*\* agent that includes creating a channel or adding members/i,
  "membership": /an agent with server-admin authority does have `raft channel add-member`/i,
};

test("no Manual page tells a member agent it cannot create a channel or add members", async () => {
  for (const [docId, reverted] of Object.entries(REVERTED_CLAIM)) {
    const doc = await resolveAgentKnowledgeDoc(docId);
    assert.ok(doc, `${docId} must resolve`);
    assert.doesNotMatch(doc.content, reverted,
      `${docId} must not go back to deciding channel authority by server role`);
  }
});

test("every page that defers on this question still points at the per-operation rule", async () => {
  // Structural, so a rewording survives it: each of these pages stopped ruling
  // on channel authority itself and now hands the question to one page. If that
  // link goes, the page is ruling again and this goes red.
  for (const docId of Object.keys(REVERTED_CLAIM)) {
    const doc = await resolveAgentKnowledgeDoc(docId);
    assert.ok(doc, `${docId} must resolve`);
    assert.match(doc.content, /permission-matrix/,
      `${docId} must keep the link to the per-operation rule`);
  }
});

test("action-cards does not tie archive to a server-admin agent anywhere on the page", async () => {
  const doc = await resolveAgentKnowledgeDoc("action-cards");
  assert.ok(doc);
  // The page said this three times; the first version of this test named two of
  // them. Bound to the shape of the claim instead: any sentence that puts an
  // admin agent and archiving together.
  for (const line of doc.content.split("\n")) {
    if (!/archiv/i.test(line)) continue;
    assert.doesNotMatch(line, /admin[- ]role agent|admin agent/i,
      "archiving is reachable through the channel-admin role, so no line may make it an admin agent's power");
  }
  assert.match(doc.content, /channel-admin role in that channel/i,
    "the real condition must be named");
});
