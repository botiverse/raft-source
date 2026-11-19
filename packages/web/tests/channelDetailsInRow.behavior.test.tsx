/**
 * The channel details stand in the conversation's row (ChannelSideArea's "details" section), even when the channel
 * panel mounts in the same commit as the row's side area: a window opened straight onto a channel (the desktop app
 * restoring its last channel, a reload on a channel URL). MainLayout renders the routes before the side area, so a
 * check of the DOM while the channel panel first renders found no side area yet; the details then stood alone,
 * fixed at the window's right edge over the conversation and under the host title bar, for the whole session.
 * Absence is asserted as booleans, never with a DOM node inside node:assert.
 */
import assert from "node:assert/strict";
import "./helpers/domSetup";
import { cleanup, render, screen } from "@testing-library/react";
import { TestIntlProvider } from "./helpers/intl";
import { stubDesktopWidth } from "./helpers/desktopWidth";
import { ChannelDetailsSurface } from "../src/components/channel/ChannelDetailsSurface";
import ChannelSideArea from "../src/components/task/ChannelSideArea";

let restoreWidth: () => void = () => {};

beforeEach(() => {
  restoreWidth = stubDesktopWidth();
});

afterEach(() => {
  cleanup();
  restoreWidth();
});

function Row({ open }: { open: boolean }) {
  // MainLayout's order: the routes (the channel panel and its details) first, the side area after them.
  return (
    <TestIntlProvider>
      <div data-testid="thread-layout-container">
        <ChannelDetailsSurface open={open} onClose={() => {}}>
          <p>details body</p>
        </ChannelDetailsSurface>
        <div className="contents" data-testid="channel-side-slot"><ChannelSideArea /></div>
      </div>
    </TestIntlProvider>
  );
}

test("details opened after a cold mount stand in the row, not alone over the conversation", () => {
  const { rerender } = render(<Row open={false} />);
  rerender(<Row open />);
  assert.equal(screen.queryByTestId("channel-details-standalone") === null, true);
  assert.equal(screen.queryAllByTestId("channel-details").length, 1);
  const slot = screen.getByTestId("channel-side-slot");
  assert.equal(slot.contains(screen.getByTestId("channel-details")), true);
});
