// DOM nodes never go to node:assert as values (tests/assertionNullCompareGuard.test.ts).
import assert from "node:assert/strict";
import "./helpers/domSetup";
import { act, cleanup, render, screen } from "@testing-library/react";
import { useRef } from "react";
import type { OtterDock, OtterSize } from "../src/assistant/assistantOtterDock";
import { useDockPlacement } from "../src/assistant/useOtterDockPlacement";

const origResizeObserver = globalThis.ResizeObserver;

afterEach(() => {
  cleanup();
  globalThis.ResizeObserver = origResizeObserver;
});

function mockRect(left: number, top: number, width: number, height: number): DOMRect {
  const box = { x: left, y: top, width, height, top, left, right: left + width, bottom: top + height };
  return { ...box, toJSON: () => box } as DOMRect;
}

const SIZE: OtterSize = { w: 80, h: 48 };
const DOCK: OtterDock = { pane: "conversation", side: "left", t: 0.5, facing: "right" };

function DockProbe({ dock }: { dock: OtterDock | null }) {
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const placement = useDockPlacement(dock, SIZE, anchorRef);
  return (
    <>
      <span ref={anchorRef} />
      <output data-testid="placement">{placement ? `${placement.x},${placement.y}` : "none"}</output>
    </>
  );
}

test("useDockPlacement tracks sibling pane resize and stops observing detached panes on unmount", async () => {
  const callbacks: Array<() => void> = [];
  let observedTargets: Element[] = [];
  let roInstances = 0;

  class FakeResizeObserver {
    constructor(cb: ResizeObserverCallback) {
      roInstances += 1;
      callbacks.push(() => cb([], this as unknown as ResizeObserver));
    }
    observe(target: Element) {
      observedTargets.push(target);
    }
    unobserve() {}
    disconnect() {
      observedTargets = [];
    }
  }
  globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;

  // Null dock allocates no ResizeObserver.
  const idle = render(<DockProbe dock={null} />);
  assert.equal(roInstances, 0);
  assert.equal(screen.getByTestId("placement").textContent, "none");
  idle.unmount();

  let conversationLeft = 240;
  const view = render(
    <div data-testid="shell">
      <div data-testid="sidebar" data-otter-dock="sidebar" />
      <div data-testid="conversation" data-otter-dock="conversation" />
      <DockProbe dock={DOCK} />
    </div>,
  );
  const sidebar = screen.getByTestId("sidebar");
  const conversation = screen.getByTestId("conversation");
  conversation.getBoundingClientRect = () => mockRect(conversationLeft, 0, 600, 800);

  // Trigger initial layout observation & sibling sidebar resize shifting conversation.left without changing its width.
  act(() => {
    for (const cb of callbacks) cb();
  });
  assert.equal(observedTargets.includes(sidebar), true, "observes sibling pane");
  assert.equal(screen.getByTestId("placement").textContent, "240,400");

  conversationLeft = 320;
  act(() => {
    for (const cb of callbacks) cb();
  });
  assert.equal(screen.getByTestId("placement").textContent, "320,400");

  // Remove the docked pane: placement clears and the detached element is NOT re-observed.
  await act(async () => {
    conversation.remove();
    await Promise.resolve();
  });
  assert.equal(screen.getByTestId("placement").textContent, "none");
  assert.equal(observedTargets.includes(conversation), false, "detached pane is not re-observed");
  view.unmount();
});
