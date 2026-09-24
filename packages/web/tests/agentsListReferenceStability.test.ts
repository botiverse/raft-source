import assert from "node:assert/strict";
import test from "node:test";
import { reconcileAgentsList } from "../src/store/agentStore.js";
import type { Agent } from "../src/store/agentStore.js";

// Structural sharing for the agents list. `loadAgents()` runs on a 60s periodic
// status reconcile (#2616 / CC-006 client) + focus refetch, each time building a
// brand-new array of brand-new objects. Without structural sharing that swaps the
// `agents` reference on every reconcile, churning ChatPanel's agents-derived
// selectors (mentionMap / agentById) → breaking MessageItem's memo → re-parsing
// the whole message list's markdown. These tests pin that a no-op reconcile keeps
// the prior reference while a real change still propagates.

function agent(id: string, over: Partial<Agent> = {}): Agent {
  return {
    id,
    name: id,
    displayName: null,
    avatarUrl: null,
    description: null,
    status: "active",
    model: "gpt-5",
    runtime: "codex",
    reasoningEffort: null,
    executionMode: "cloud",
    envVars: null,
    machineId: "m1",
    creatorType: null,
    creatorId: null,
    creator: null,
    createdAgents: [],
    deletedAt: null,
    createdAt: "1970-01-01T00:00:00.000Z",
    ...over,
  };
}

test("reconcileAgentsList returns the prior array reference when a reconcile fetches deep-equal data (no-op reconcile = no re-render)", () => {
  const prev = [agent("a"), agent("b"), agent("c")];
  const next = [agent("a"), agent("b"), agent("c")]; // fresh objects, identical data

  // Red/green discrimination: the raw fetched array IS a new reference (the bug
  // that churns agents-derived selectors); reconcile must collapse it back to prev.
  assert.notStrictEqual(next, prev);
  assert.notStrictEqual(next[0], prev[0]);

  const result = reconcileAgentsList(prev, next);
  assert.strictEqual(result, prev); // same reference -> zero re-render
});

test("reconcileAgentsList reuses unchanged element references and only swaps the changed agent", () => {
  const prev = [agent("a"), agent("b", { status: "active" }), agent("c")];
  const next = [agent("a"), agent("b", { status: "inactive" }), agent("c")]; // only b changed

  const result = reconcileAgentsList(prev, next);
  assert.notStrictEqual(result, prev); // the array changed
  assert.strictEqual(result[0], prev[0]); // a reused (same reference)
  assert.strictEqual(result[2], prev[2]); // c reused (same reference)
  assert.notStrictEqual(result[1], prev[1]); // b is the new object
  assert.equal(result[1].status, "inactive"); // b reflects the real change
});

test("reconcileAgentsList returns a new array when an agent is added", () => {
  const prev = [agent("a"), agent("b")];
  const result = reconcileAgentsList(prev, [agent("a"), agent("b"), agent("c")]);
  assert.notStrictEqual(result, prev);
  assert.equal(result.length, 3);
  assert.strictEqual(result[0], prev[0]); // existing rows still reused
});

test("reconcileAgentsList deep-compares nested fields (envVars) for reuse-vs-update", () => {
  const prev = [agent("a", { envVars: { X: "1" } })];
  // Same nested value via a fresh object -> deep-equal -> reuse prior reference.
  assert.strictEqual(reconcileAgentsList(prev, [agent("a", { envVars: { X: "1" } })]), prev);
  // Nested value changed -> must produce a new array reference.
  assert.notStrictEqual(reconcileAgentsList(prev, [agent("a", { envVars: { X: "2" } })]), prev);
});
