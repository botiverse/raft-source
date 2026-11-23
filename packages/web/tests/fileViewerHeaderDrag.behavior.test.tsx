import assert from "node:assert/strict";
import { cleanup, render, screen } from "@testing-library/react";

import { FileViewerHeader } from "../src/components/FileViewerShell";
import { OVERLAY_TITLEBAR_NO_DRAG_ATTR } from "../src/components/topbar/overlayTitleBar";
import { TestIntlProvider } from "./helpers/intl";

afterEach(cleanup);

// Desktop: the file viewer's header is the window's title bar. Its file name
// opts out of dragging (for the full-name tooltip); grown to fill the row, it
// left nothing to drag the window by (#triage:#537). A spacer takes the row
// instead: it keeps the actions at the end and is the drag handle.
test("the file name's no-drag block is as wide as the name; a draggable spacer takes the rest of the row", () => {
  render(
    <TestIntlProvider>
      <FileViewerHeader filename="gta@2x.png" index={1} count={3} onDownload={() => {}} onClose={() => {}} />
    </TestIntlProvider>,
  );
  const header = screen.getByTestId("file-viewer-header");
  const noDrag = header.querySelectorAll<HTMLElement>(`[${OVERLAY_TITLEBAR_NO_DRAG_ATTR}]`);
  assert.equal(noDrag.length, 1, "only the file name opts out (buttons opt out by tag)");
  const name = noDrag[0]!;
  assert.ok(name.textContent?.includes("gta@2x.png"));
  const nameClasses = name.className.split(/\s+/);
  assert.ok(nameClasses.includes("flex-initial"), name.className);
  assert.ok(!nameClasses.includes("flex-1"), `the no-drag block must not grow: ${name.className}`);

  const spacer = screen.getByTestId("file-viewer-header-spacer");
  assert.ok(spacer.className.split(/\s+/).includes("flex-1"), "the spacer takes the free space");
  assert.ok(spacer.closest(`[${OVERLAY_TITLEBAR_NO_DRAG_ATTR}]`) === null, "the spacer stays draggable");
  assert.ok(spacer.parentElement === header, "a direct child of the header row");
  // Order: name, spacer, then the counter and the actions at the end.
  const children = [...header.children];
  const counter = screen.getByText("2 / 3");
  const close = screen.getByRole("button", { name: /close/i });
  assert.ok(children.indexOf(spacer) > children.indexOf(name));
  assert.ok(spacer.compareDocumentPosition(counter) & Node.DOCUMENT_POSITION_FOLLOWING);
  assert.ok(spacer.compareDocumentPosition(close) & Node.DOCUMENT_POSITION_FOLLOWING);
});
