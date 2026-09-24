import "./helpers/domSetup";
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import DraggableDevOverlay, { getDevOverlayStorageKey } from "../src/components/dev/DraggableDevOverlay";

const originalRect = HTMLElement.prototype.getBoundingClientRect;
beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
  HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
    if (this.dataset.testid === "overlay") {
      const left = Number.parseFloat(this.style.left) || 0;
      const top = Number.parseFloat(this.style.top) || 0;
      return { x: left, y: top, left, top, right: left + 80, bottom: top + 32, width: 80, height: 32, toJSON: () => ({}) };
    }
    return originalRect.call(this);
  };
});
afterEach(() => { cleanup(); localStorage.clear(); HTMLElement.prototype.getBoundingClientRect = originalRect; });

function Harness() {
  const [clicks, setClicks] = useState(0);
  return (
    <DraggableDevOverlay id="test-overlay" handleSelector="[data-drag-handle]" testId="overlay" collapsedChildren={<span data-testid="collapsed">*</span>}>
      <button type="button" data-drag-handle onClick={() => setClicks((value) => value + 1)} data-testid="handle">Move</button>
      <output data-testid="clicks">{clicks}</output>
    </DraggableDevOverlay>
  );
}

test("ordinary trigger click remains available", () => {
  render(<Harness />);
  fireEvent.click(screen.getByTestId("handle"));
  assert.equal(screen.getByTestId("clicks").textContent, "1");
});

test("saved edge placement restores responsively", async () => {
  localStorage.setItem(getDevOverlayStorageKey("test-overlay"), JSON.stringify({ edge: "left", ratio: 0.5, collapsed: true }));
  render(<Harness />);
  const overlay = screen.getByTestId("overlay");
  await waitFor(() => { assert.equal(overlay.dataset.devOverlayEdge, "left"); assert.equal(overlay.dataset.devOverlayCollapsed, "true"); assert.equal(overlay.style.left, "8px"); });
});
