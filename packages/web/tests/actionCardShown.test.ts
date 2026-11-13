import assert from "node:assert/strict";
import "./helpers/domSetup";
import { createElement, useRef } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, test, vi } from "vitest";

// `action_card_shown` is the base of the action card funnel: once per card per
// page load, when half of a card is on screen and this person can act on it.

const tracked = vi.hoisted(() => [] as Array<{ event: string; props: unknown; options: unknown }>);
vi.mock("../src/analytics/track", () => ({
  trackEvent: (event: string, props: unknown, options: unknown) => { tracked.push({ event, props, options }); },
}));

const { resetActionCardShownForTest, useActionCardShown } = await import("../src/analytics/actionCards");

/** An observer the test drives: `show(ratio)` reports every observed card with that share on screen. */
const observers: Array<{ callback: IntersectionObserverCallback; targets: Element[]; disconnected: boolean }> = [];
class TestIntersectionObserver {
  private readonly entry: (typeof observers)[number];
  constructor(callback: IntersectionObserverCallback) {
    this.entry = { callback, targets: [], disconnected: false };
    observers.push(this.entry);
  }
  observe(target: Element) { this.entry.targets.push(target); }
  unobserve() {}
  disconnect() { this.entry.disconnected = true; }
  takeRecords() { return []; }
}
function show(ratio = 0.5): void {
  for (const observer of observers) {
    if (observer.disconnected) continue;
    const entries = observer.targets.map((target) => ({ isIntersecting: ratio > 0, intersectionRatio: ratio, target }) as unknown as IntersectionObserverEntry);
    observer.callback(entries, observer as unknown as IntersectionObserver);
  }
}

function Card(props: { messageId: string; actionable: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useActionCardShown(ref, { messageId: props.messageId, actionType: "channel:create", actionable: props.actionable, serverId: "server-1" });
  return createElement("div", { ref });
}

const original = globalThis.IntersectionObserver;
beforeEach(() => {
  tracked.length = 0;
  observers.length = 0;
  resetActionCardShownForTest();
  globalThis.IntersectionObserver = TestIntersectionObserver as unknown as typeof IntersectionObserver;
});
afterEach(() => {
  cleanup();
  globalThis.IntersectionObserver = original;
});

test("a card is reported when half of it is on screen, once per page load", () => {
  render(createElement(Card, { messageId: "m1", actionable: true }));
  assert.equal(tracked.length, 0, "not before it is on screen");
  // The first callback comes on observe whatever the threshold: a sliver is not a sighting.
  act(() => show(0.1));
  assert.equal(tracked.length, 0, "not for a sliver");
  act(() => show());
  act(() => show());
  // The same card again (a thread showing its parent message) is not a second sighting.
  render(createElement(Card, { messageId: "m1", actionable: true }));
  act(() => show());
  assert.deepEqual(tracked, [{ event: "action_card_shown", props: { action_type: "channel:create" }, options: { serverId: "server-1" } }]);
});

test("a card this person cannot act on is not reported", () => {
  render(createElement(Card, { messageId: "m2", actionable: false }));
  act(() => show());
  assert.equal(observers.length, 0);
  assert.equal(tracked.length, 0);
});

test("a card becomes reportable when this person can act on it", () => {
  const view = render(createElement(Card, { messageId: "m3", actionable: false }));
  act(() => show());
  view.rerender(createElement(Card, { messageId: "m3", actionable: true }));
  act(() => show());
  assert.deepEqual(tracked.map((entry) => entry.event), ["action_card_shown"]);
});
