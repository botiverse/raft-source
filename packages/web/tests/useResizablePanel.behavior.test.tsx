import "./helpers/domSetup";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useResizablePanel } from "../src/hooks/useResizablePanel";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function installPointerCaptureStub() {
  if (!HTMLElement.prototype.setPointerCapture) {
    HTMLElement.prototype.setPointerCapture = () => {};
  }
}

function LeftEdgeResizablePanel({ measuredStartWidth }: { measuredStartWidth: number }) {
  const { width, handleResizeStart, handleResizeMove, handleResizeEnd } = useResizablePanel({
    storageKey: "test:threadPanelWidth",
    min: 360,
    max: 960,
    defaultWidth: 400,
    direction: "left",
    getDragStartWidth: () => measuredStartWidth,
  });

  return (
    <div>
      <output data-testid="width">{width}</output>
      <button
        data-testid="handle"
        type="button"
        onPointerDown={handleResizeStart}
        onPointerMove={handleResizeMove}
        onPointerUp={handleResizeEnd}
      >
        Resize
      </button>
    </div>
  );
}

test("left-edge resize starts from the CSS-clamped visible width", () => {
  installPointerCaptureStub();
  localStorage.setItem("test:threadPanelWidth", "800");

  render(<LeftEdgeResizablePanel measuredStartWidth={660} />);

  const handle = screen.getByTestId("handle");
  fireEvent.pointerDown(handle, { clientX: 1000, pointerId: 1 });
  fireEvent.pointerMove(handle, { clientX: 1050, pointerId: 1 });

  assert.equal(
    screen.getByTestId("width").textContent,
    "610",
    "a 50px rightward drag after 800px is CSS-clamped to 660px should immediately shrink to 610px",
  );
});
