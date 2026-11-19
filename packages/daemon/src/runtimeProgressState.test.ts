import assert from "node:assert/strict";
import { RuntimeProgressState } from "./runtimeProgressState";

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

test("runtime progress state: stall age anchors on turn start, last-event age does not", () => {
  const state = new RuntimeProgressState(0);
  state.noteRuntimeEvent("turn_end", 1_000);
  state.noteTurnStarted(100_000);

  assert.equal(state.ageMs(100_500), 500, "stall age counts from the later turn start");
  assert.equal(state.lastEventAgeMs(100_500), 99_500, "last_event_age_* telemetry keeps its literal meaning");

  state.noteRuntimeEvent("tool_output", 200_000);
  assert.equal(state.ageMs(200_100), 100, "a newer runtime event wins over an older turn start");
  assert.equal(state.lastEventAgeMs(200_100), 100);
});

test("runtime progress state: turn progress lasts until the turn's end or the next turn start", () => {
  const state = new RuntimeProgressState(100);
  assert.equal(state.takeTurnProgressAtTurnEnd(), false, "the first turn (riding the spawn) had none");

  state.noteTurnProgress();
  assert.equal(state.turnProgressObserved, true);
  assert.equal(state.takeTurnProgressAtTurnEnd(), true);
  assert.equal(state.takeTurnProgressAtTurnEnd(), false, "a second, bare turn end had none");

  state.noteTurnProgress();
  state.noteTurnStarted(200);
  assert.equal(state.turnProgressObserved, false, "a new turn starts without");
});
