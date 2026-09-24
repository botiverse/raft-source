import "./helpers/domSetup";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MASTER_DETAIL_COMPACT_PANEL_BOUNDS, resolveMasterDetailPanelWidth } from "../src/components/layout/masterDetailPanelSizing";
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

function CompactMasterPanel() {
  const { width, handleResizeStart, handleResizeMove, handleResizeEnd } = useResizablePanel({
    storageKey: "slock:searchPanelCompactWidth",
    ...MASTER_DETAIL_COMPACT_PANEL_BOUNDS,
  });

  return (
    <div>
      <output data-testid="compact-master-width">{width}</output>
      <button
        type="button"
        data-testid="compact-master-resize-handle"
        onPointerDown={handleResizeStart}
        onPointerMove={handleResizeMove}
        onPointerUp={handleResizeEnd}
      >
        Resize
      </button>
    </div>
  );
}

test("tablet breakpoint selects the compact Activity width while lg keeps the wide width", () => {
  assert.equal(resolveMasterDetailPanelWidth({
    isLargeViewport: false,
    isCompactLayout: false,
    wideWidth: 560,
    compactWidth: MASTER_DETAIL_COMPACT_PANEL_BOUNDS.defaultWidth,
  }), 320);

  assert.equal(resolveMasterDetailPanelWidth({
    isLargeViewport: true,
    isCompactLayout: false,
    wideWidth: 560,
    compactWidth: MASTER_DETAIL_COMPACT_PANEL_BOUNDS.defaultWidth,
  }), 560);

  assert.equal(resolveMasterDetailPanelWidth({
    isLargeViewport: true,
    isCompactLayout: true,
    wideWidth: 560,
    compactWidth: MASTER_DETAIL_COMPACT_PANEL_BOUNDS.defaultWidth,
  }), 320);
});

test("legacy persisted widths below the Activity action-row floor recover to 320px", () => {
  localStorage.setItem("slock:searchPanelCompactWidth", "240");

  render(<CompactMasterPanel />);

  assert.equal(screen.getByTestId("compact-master-width").textContent, "320");
});

test("dragging the Activity and chat divider cannot shrink the action row below 320px", () => {
  installPointerCaptureStub();
  render(<CompactMasterPanel />);

  const handle = screen.getByTestId("compact-master-resize-handle");
  fireEvent.pointerDown(handle, { clientX: 500, pointerId: 1 });
  fireEvent.pointerMove(handle, { clientX: 300, pointerId: 1 });
  fireEvent.pointerUp(handle, { pointerId: 1 });

  assert.equal(screen.getByTestId("compact-master-width").textContent, "320");
  assert.equal(localStorage.getItem("slock:searchPanelCompactWidth"), "320");
});
