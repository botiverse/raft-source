import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import "./helpers/domSetup";
import { act, cleanup, render as rtlRender } from "@testing-library/react";
import ServerSetupComputerRuntimeStep, {
  startConnectionMotion,
} from "../src/components/onboarding/ServerSetupComputerRuntimeStep";
import { TestIntlProvider } from "./helpers/intl";

afterEach(() => cleanup());

const render: typeof rtlRender = (ui, options) => rtlRender(ui, { wrapper: TestIntlProvider, ...options });

/**
 * Pins the connection-motion schedule of Screen B/C runtime.
 *
 * Why this exists: the step used to carry a third `flash` phase (a 1560ms timer
 * plus a CSS class) that had no visual, no state effect, no render branch and no
 * timing dependency — dead weight nobody could tell was dead without reading the
 * whole reducer. It was removed. These assertions pin what actually matters and
 * was previously unguarded: `settle` — the moment the step stops animating and
 * hands the screen back — still arrives 2040ms after start, and `handoff` still
 * arrives at 1400ms.
 *
 * Each assertion is bounded and specific (a named action at a named tick), so a
 * regression fails rather than hangs.
 */

type Action = { type: string };

function collect(reducedMotion: boolean) {
  const seen: { type: string; at: number }[] = [];
  let now = 0;
  const dispatch = (action: Action) => seen.push({ type: action.type, at: now });
  const advance = (t: { mock: { timers: { tick: (ms: number) => void } } }, ms: number) => {
    now += ms;
    t.mock.timers.tick(ms);
  };
  return { seen, dispatch, advance, start: () => startConnectionMotion(dispatch, reducedMotion) };
}

test("settle arrives 2040ms after start, and handoff at 1400ms", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { seen, advance, start } = collect(false);
  const stop = start();

  assert.deepEqual(seen.map((s) => s.type), ["start"], "start dispatches immediately");

  advance(t, 1_399);
  assert.deepEqual(seen.map((s) => s.type), ["start"], "nothing lands before 1400ms");

  advance(t, 1);
  assert.deepEqual(
    seen.map((s) => ({ type: s.type, at: s.at })).filter((s) => s.type === "handoff"),
    [{ type: "handoff", at: 1_400 }],
    "handoff lands exactly at 1400ms",
  );

  advance(t, 639);
  assert.equal(seen.some((s) => s.type === "settle"), false, "settle has not landed before 2040ms");

  advance(t, 1);
  assert.deepEqual(
    seen.filter((s) => s.type === "settle"),
    [{ type: "settle", at: 2_040 }],
    "settle lands exactly at 2040ms",
  );

  // Exactly three dispatches: start, handoff, settle. A reintroduced intermediate
  // phase (or a duplicated timer) fails here rather than passing silently.
  assert.deepEqual(seen.map((s) => s.type), ["start", "handoff", "settle"]);

  stop();
});

test("reduced motion skips straight to settled and schedules no timers", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { seen, advance, start } = collect(true);
  const stop = start();

  assert.deepEqual(seen.map((s) => s.type), ["skip"], "reduced motion resolves immediately");

  advance(t, 5_000);
  assert.deepEqual(
    seen.map((s) => s.type),
    ["skip"],
    "no timer fires later under reduced motion",
  );

  stop();
});

/**
 * Connects the scheduler assertions above to what the page actually renders.
 * The three tests above pin that `settle` is DISPATCHED at 2040ms; this one pins
 * that the component ends up in the settled state. Without it, the reducer or the
 * effect wiring could break while the schedule stayed green (@Bugen's point: the
 * primitive's green and the page's green are two different greens).
 */
test("the step reaches data-motion-state=settled once the schedule completes", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });

  const props = {
    runtimeStatus: "checking" as const,
    runtimeOptions: [],
    onNext: () => undefined,
  };
  const offlineComputer = {
    id: "computer-1",
    name: "Wenyi's MacBook Pro",
    status: "offline" as const,
    runtimeIds: [],
    isComputer: true,
  };

  // The motion is driven by the offline -> online edge, so it must be crossed.
  const { container, rerender } = render(
    <ServerSetupComputerRuntimeStep {...props} computer={offlineComputer} />,
  );
  // Re-render the same instance (RTL re-applies the wrapper). Re-wrapping by hand
  // would remount it, which resets the refs and skips the edge entirely.
  act(() => {
    rerender(<ServerSetupComputerRuntimeStep {...props} computer={{ ...offlineComputer, status: "online" }} />);
  });

  const motionState = () => container.querySelector("[data-motion-state]")?.getAttribute("data-motion-state");
  assert.notEqual(motionState(), "settled", "still animating before the schedule completes");

  act(() => {
    t.mock.timers.tick(2_040);
  });

  assert.equal(motionState(), "settled", "the step is settled once settle lands at 2040ms");
});

test("cleanup cancels pending phases", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { seen, advance, start } = collect(false);
  const stop = start();

  stop();
  advance(t, 5_000);

  assert.deepEqual(
    seen.map((s) => s.type),
    ["start"],
    "no phase lands after cleanup",
  );
});
