// Reconciler step 11 (Tenny's decision 2): pushed configs are ordered by
// revision; a held push applies only when newer than the start that registers.
//
// RED proof: accept a push equal to the current revision and the duplicate
// applies; let a start without a revision pass a held push and it applies over
// a start whose config may be newer.

import assert from "node:assert/strict";
import type { AgentConfig } from "@botiverse/raft-shared";
import { AgentConfigRevisions } from "./agentConfigRevisions";

const config = { model: "m" } as AgentConfig;

test("two pushes out of order: the newer one wins, the stale and the repeated one are dropped", () => {
  const revisions = new AgentConfigRevisions();
  assert.equal(revisions.acceptPush("agent", 5), true);
  assert.equal(revisions.acceptPush("agent", 4), false, "older, arrived later");
  assert.equal(revisions.acceptPush("agent", 5), false, "the same revision again");
  assert.equal(revisions.acceptPush("agent", 6), true);
  assert.equal(revisions.current("agent"), 6);
  assert.equal(revisions.acceptPush("other", 1), true, "per agent");
  assert.equal(revisions.acceptPush("agent", Number.NaN), false);
});

test("a start's configRevision orders pushes too, and never lowers the current one", () => {
  const revisions = new AgentConfigRevisions();
  revisions.noteStart("agent", 7);
  assert.equal(revisions.acceptPush("agent", 7), false);
  revisions.noteStart("agent", 3);
  assert.equal(revisions.current("agent"), 7);
  revisions.noteStart("agent", undefined);
  assert.equal(revisions.acceptPush("agent", 8), true);
});

test("a held push applies at registration only when newer than the latest start; a start with no revision drops it", () => {
  const revisions = new AgentConfigRevisions();
  revisions.noteStart("agent", 4);
  revisions.holdPush("agent", { config, revision: 5 });
  assert.deepEqual(revisions.takeHeldPush("agent"), { push: { config, revision: 5 }, applies: true });
  assert.equal(revisions.takeHeldPush("agent"), null, "taken once");

  revisions.noteStart("agent", 6);
  revisions.holdPush("agent", { config, revision: 5 });
  assert.equal(revisions.takeHeldPush("agent")!.applies, false, "the start is newer");

  revisions.noteStart("agent", undefined);
  revisions.holdPush("agent", { config, revision: 9 });
  assert.equal(revisions.takeHeldPush("agent")!.applies, false, "no revision on the start: dropped");

  revisions.holdPush("agent", { config, revision: 10 });
  revisions.forgetHeldPush("agent");
  assert.equal(revisions.takeHeldPush("agent"), null);
});

test("a start older than the applied revision is marked stale and is not the start a held push is compared with", () => {
  const revisions = new AgentConfigRevisions();
  revisions.noteStart("agent", 4, { model: "r4" } as AgentConfig);
  assert.equal(revisions.acceptPush("agent", 6), true);
  revisions.holdPush("agent", { config, revision: 6 });
  const r5 = { model: "r5" } as AgentConfig;
  revisions.noteStart("agent", 5, r5);
  assert.equal(revisions.isStaleStart(r5), true);
  assert.equal(revisions.current("agent"), 6);
  assert.equal(revisions.takeHeldPush("agent")!.applies, true, "compared with r4, not the stale r5");
  const r6 = { model: "r6" } as AgentConfig;
  revisions.noteStart("agent", 6, r6);
  assert.equal(revisions.isStaleStart(r6), false, "equal: the start's config is taken");
  // A stale start rebinding into a newer one leaves the newer one as the start a held push meets.
  revisions.holdPush("agent", { config, revision: 6 });
  revisions.noteStart("agent", 7, { model: "r7" } as AgentConfig);
  revisions.noteStart("agent", 5, { model: "r5-again" } as AgentConfig);
  assert.equal(revisions.takeHeldPush("agent")!.applies, false, "r6 is older than the r7 start");
  const copy = { ...r5 };
  revisions.carryStaleMark(r5, copy);
  assert.equal(revisions.isStaleStart(copy), true);
});
