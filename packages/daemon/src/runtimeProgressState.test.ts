import assert from "node:assert/strict";
import { test } from "vitest";
import { RuntimeProgressState } from "./runtimeProgressState.js";

test("runtime progress state records runtime events and clears stale latch", () => {
  const state = new RuntimeProgressState(100);
  state.markStale(200);

  state.noteRuntimeEvent("tool_output", 300);

  assert.equal(state.lastEventAt, 300);
  assert.equal(state.lastEventKind, "tool_output");
  assert.equal(state.staleSince, null);
  assert.equal(state.isStale, false);
});

test("runtime progress state records internal progress without changing last event kind", () => {
  const state = new RuntimeProgressState(100);
  state.noteRuntimeEvent("tool_output", 200);
  state.markStale(300);

  state.noteInternalProgress(350);

  assert.equal(state.lastEventAt, 350);
  assert.equal(state.lastEventKind, "tool_output");
  assert.equal(state.staleSince, null);
});

test("runtime progress state preserves first stale timestamp", () => {
  const state = new RuntimeProgressState(100);

  assert.equal(state.markStale(200), 200);
  assert.equal(state.markStale(300), 200);
  assert.equal(state.staleSince, 200);
});

test("runtime progress state computes age from last event", () => {
  const state = new RuntimeProgressState(100);

  assert.equal(state.ageMs(350), 250);
});
