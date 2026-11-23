// DOM nodes never go to node:assert as values (tests/assertionNullCompareGuard.test.ts).
import assert from "node:assert/strict";
import "./helpers/domSetup";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { TestIntlProvider } from "./helpers/intl";
import MessageSelectionShortcut from "../src/components/message/MessageSelectionShortcut";

function mockRect(left: number, top: number, width: number, height: number): DOMRect {
  const box = { x: left, y: top, width, height, top, left, right: left + width, bottom: top + height };
  return { ...box, toJSON: () => box } as DOMRect;
}

const origGetClientRects = Range.prototype.getClientRects;
const origGetBoundingClientRect = Range.prototype.getBoundingClientRect;
const origGetSelection = window.getSelection;
const origInnerWidth = window.innerWidth;

afterEach(() => {
  cleanup();
  Range.prototype.getClientRects = origGetClientRects;
  Range.prototype.getBoundingClientRect = origGetBoundingClientRect;
  Object.defineProperty(window, "getSelection", { writable: true, configurable: true, value: origGetSelection });
  Object.defineProperty(window, "innerWidth", { writable: true, configurable: true, value: origInnerWidth });
});

function setupSelection(body: HTMLElement, textNode: Text, rectRef: { top: number; width: number }) {
  Range.prototype.getClientRects = function getClientRects() {
    return [mockRect(120, rectRef.top, rectRef.width, 18)] as unknown as DOMRectList;
  };
  Range.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return mockRect(120, rectRef.top, rectRef.width, 18);
  };
  const range = document.createRange();
  range.setStart(textNode, 0);
  range.setEnd(textNode, textNode.data.length);
  const selection = {
    isCollapsed: false,
    rangeCount: 1,
    anchorNode: textNode,
    anchorOffset: 0,
    focusNode: textNode,
    focusOffset: textNode.data.length,
    toString: () => textNode.data,
    getRangeAt: () => range,
    removeAllRanges: () => {},
  } as unknown as Selection;
  Object.defineProperty(window, "getSelection", { writable: true, configurable: true, value: () => selection });
  Object.defineProperty(window, "innerWidth", { writable: true, configurable: true, value: 1280 });
  return { selection, body };
}

test("MessageSelectionShortcut mounts inside PopoverContent with dismiss-layer marker, closes on outside primary pointerdown, and closes when row detaches", async () => {
  const rectRef = { top: 240, width: 140 };
  const view = render(
    <TestIntlProvider>
      <div data-testid="outside">outside</div>
      <div data-testid="list" data-virtual-timeline="">
        <div data-testid="row">
          <div data-testid="msg" data-message-selectable="true" data-quote-channel-id="ch-1" data-message-id="m-1">
            selectable message text
          </div>
        </div>
      </div>
      <MessageSelectionShortcut />
    </TestIntlProvider>,
  );

  const msg = screen.getByTestId("msg");
  const textNode = msg.firstChild as Text;
  setupSelection(msg, textNode, rectRef);

  // Triple click triggers immediate target capture.
  fireEvent.click(msg, { detail: 3 });

  await waitFor(() => {
    const popup = document.querySelector('[data-slot="popover-content"]');
    assert.equal(popup !== null, true, "PopoverContent keeps data-slot='popover-content' for layerGuard");
    assert.equal(popup?.getAttribute("data-dismiss-layer"), "", "declares dismiss-layer marker");
    assert.equal(screen.queryByRole("toolbar") !== null, true);
  });

  // Right-click outside keeps toolbar open for context menu over selection.
  fireEvent.pointerDown(screen.getByTestId("outside"), { button: 2 });
  assert.equal(screen.queryByRole("toolbar") !== null, true);

  // Left-click / drag-start outside closes immediately on pointerdown.
  fireEvent.pointerDown(screen.getByTestId("outside"), { button: 0 });
  await waitFor(() => {
    assert.equal(screen.queryByRole("toolbar") === null, true);
  });

  // Re-open, then simulate virtualizer unmounting the enclosing row ancestor without any scroll event:
  // the subtree MutationObserver must close the toolbar immediately rather than teleporting to (8, 8).
  fireEvent.click(msg, { detail: 3 });
  await waitFor(() => {
    assert.equal(screen.queryByRole("toolbar") !== null, true);
  });

  act(() => {
    screen.getByTestId("row").remove();
  });
  await waitFor(() => {
    assert.equal(screen.queryByRole("toolbar") === null, true);
  });
  view.unmount();
});
