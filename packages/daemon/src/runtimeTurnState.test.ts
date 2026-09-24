import assert from "node:assert/strict";
import { test } from "vitest";
import { RuntimeTurnState } from "./runtimeTurnState.js";

test("runtime turn state allows busy steering during an active turn", () => {
  const state = new RuntimeTurnState();

  state.markTurnStarted("turn-1");

  assert.equal(state.activeTurnId, "turn-1");
  assert.equal(state.canSteerBusy, true);
});

test("runtime turn state does not allow busy steering from an accepted turn response", () => {
  const state = new RuntimeTurnState();

  state.noteTurnAccepted("turn-1");

  assert.equal(state.activeTurnId, null);
  assert.equal(state.canSteerBusy, false);

  state.markTurnStarted("turn-1");

  assert.equal(state.activeTurnId, "turn-1");
  assert.equal(state.canSteerBusy, true);
});

test("runtime turn state blocks stale active-turn steering while a new turn is pending", () => {
  const state = new RuntimeTurnState();
  state.markTurnStarted("turn-1");

  state.noteTurnAccepted("turn-2");

  assert.equal(state.activeTurnId, "turn-1");
  assert.equal(state.canSteerBusy, false);

  state.markTurnStarted("turn-2");

  assert.equal(state.activeTurnId, "turn-2");
  assert.equal(state.canSteerBusy, true);
});

test("runtime turn state gates busy steering after a tool boundary until progress", () => {
  const state = new RuntimeTurnState();
  state.markTurnStarted("turn-1");

  state.markToolBoundary();

  assert.equal(state.activeTurnId, "turn-1");
  assert.equal(state.canSteerBusy, false);

  state.markProgress();

  assert.equal(state.activeTurnId, "turn-1");
  assert.equal(state.canSteerBusy, true);
});

test("runtime turn state clears turn and gate on completion", () => {
  const state = new RuntimeTurnState();
  state.markTurnStarted("turn-1");
  state.markToolBoundary();

  state.markTurnCompleted();

  assert.equal(state.activeTurnId, null);
  assert.equal(state.canSteerBusy, false);
});

test("runtime turn state resets fully between Codex process spawns", () => {
  const state = new RuntimeTurnState();
  state.markTurnStarted("turn-1");
  state.markToolBoundary();

  state.reset();

  assert.equal(state.activeTurnId, null);
  assert.equal(state.canSteerBusy, false);
});
