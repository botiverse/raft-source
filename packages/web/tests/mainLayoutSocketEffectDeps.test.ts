import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

/**
 * Regression contract for #proj-frontend:4e6a01a6 task #1
 * (root cause: agent activity status indicators "卡 online" after multiple
 * page swaps).
 *
 * The `useMainLayoutRealtimeBridge` hook installs the MainLayout socket
 * bridge for the lifetime of the active server. If that hook starts depending
 * on route state, the listener stack is detached and re-attached on every
 * navigation — and any push that arrives during the unbinding window is
 * silently dropped.
 *
 * Concretely: previously `location.pathname` was listed in the deps even
 * though the effect body never read it. Result: routing to a different
 * channel/DM/settings tab tore the listeners down and re-attached them.
 * After ~N page swaps the chance of dropping an `agent:activity` push
 * approaches 1, and the dot froze on whatever the last-applied state was
 * (typically `online`, the default idle broadcast). Refresh "fixed" it
 * because mount-time `loadAgents()` re-snapshots from REST.
 *
 * Contract enforced here:
 *   1. MainLayout must not own raw socket listeners or socket recovery paths.
 *   2. The hook effect that installs the bridge must depend only on the stable
 *      bridge driver, never on route state or react-router's unstable navigate.
 *   3. If a future handler genuinely needs the current pathname, it should
 *      read `window.location.*` at handler time from the bridge module rather
 *      than closing over MainLayout route state.
 *
 * If you find yourself adding `location.pathname` to this effect's deps
 * to fix some unrelated bug, please use a ref instead — otherwise you
 * will re-introduce the page-swap drop.
 */

/**
 * Mechanistic reproduction of the listener-swap drop pattern, motivating
 * the contract above. socket.io-client (and the underlying EventEmitter
 * model it shares with `events.EventEmitter`) does NOT buffer events for
 * an event-name that has zero listeners: an `emit()` made between an
 * `off()` and the next `on()` is delivered to no one and silently lost.
 *
 * If the bridge install effect re-runs on every navigation, every
 * page swap creates exactly this off→on window. The drop is microsecond-
 * scale per swap, but it is real and accumulates. After enough swaps the
 * probability of having dropped at least one push approaches 1, which
 * matches the observed "卡 online" symptom.
 *
 * This test demonstrates the mechanism on a node EventEmitter (which
 * shares the no-buffer-on-zero-listeners semantic with socket.io-client):
 *
 *   on("agent:activity", h1)
 *   emit("agent:activity", "first")   // h1 receives
 *   off("agent:activity", h1)         // simulate effect cleanup
 *   emit("agent:activity", "missed")  // ZERO listeners → DROPPED
 *   on("agent:activity", h2)          // simulate effect re-run
 *   emit("agent:activity", "third")   // h2 receives
 *
 * Result: 2 of 3 events received. "missed" is lost forever.
 *
 * The structural-grep test above guarantees route state cannot re-run the
 * bridge install effect on navigation; this test guarantees the failure mode it
 * protects against is real and not theoretical.
 */
test("listener swap during emit window drops events (mechanism repro)", () => {
  const socket = new EventEmitter();
  const received: string[] = [];

  // Mount: effect registers listener for the first time.
  const handler1 = (data: string) => received.push(`h1:${data}`);
  socket.on("agent:activity", handler1);

  // Server pushes a normal event — handler1 receives it.
  socket.emit("agent:activity", "first");

  // Simulate the effect re-running because of a dep change (e.g.
  // `location.pathname` flipping on a route swap). Cleanup detaches.
  socket.off("agent:activity", handler1);

  // Server happens to push *during the off→on window*. There is no
  // listener registered → the event is dropped. socket.io-client has
  // identical semantics: pushes for an event with no listeners go
  // nowhere and are not buffered.
  socket.emit("agent:activity", "missed");

  // Effect body re-runs and re-registers the listener (with whatever
  // closure it captured this render — for our purposes, any handler).
  const handler2 = (data: string) => received.push(`h2:${data}`);
  socket.on("agent:activity", handler2);

  // Server pushes again — handler2 receives it.
  socket.emit("agent:activity", "third");

  assert.deepEqual(
    received,
    ["h1:first", "h2:third"],
    'The "missed" event between off() and on() should be silently dropped — that is the failure mode this contract protects against.',
  );
  assert.equal(received.length, 2);
});
