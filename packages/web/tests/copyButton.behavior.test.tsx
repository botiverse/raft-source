import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import "./helpers/domSetup";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import CopyButton from "../src/components/ui/CopyButton";
import type { CopyTextController } from "../src/hooks/useCopyText";

afterEach(cleanup);

test("CopyButton preserves the caller's exact button DOM and can share a controller", async () => {
  const copiedTexts: string[] = [];
  const controller: CopyTextController = {
    copied: false,
    pending: false,
    async copyText(text) {
      copiedTexts.push(text);
    },
    reset() {},
  };
  const view = render(
    <CopyButton controller={controller} text="diagnostic" enabled={false}>
      {({ copied, disabled, onClick }) => (
        <button type="button" className="original-shell" disabled={disabled} onClick={onClick}>
          {copied ? "Copied" : "Copy info"}
        </button>
      )}
    </CopyButton>,
  );

  assert.equal(view.container.children.length, 1, "CopyButton must not add a wrapper element");
  assert.equal(view.container.firstElementChild?.tagName, "BUTTON");
  assert.equal(view.container.firstElementChild?.className, "original-shell");
  assert.equal(screen.getByRole("button", { name: "Copy info" }).hasAttribute("disabled"), true);
  fireEvent.click(screen.getByRole("button", { name: "Copy info" }));
  assert.deepEqual(copiedTexts, [], "disabled behavior must not change the visual shell");

  controller.pending = true;
  view.rerender(
    <CopyButton controller={controller} text={() => "diagnostic"}>
      {({ copied, disabled, onClick }) => (
        <button type="button" className="original-shell" disabled={disabled} onClick={onClick}>
          {copied ? "Copied" : "Copy info"}
        </button>
      )}
    </CopyButton>,
  );
  assert.equal(screen.getByRole("button", { name: "Copy info" }).hasAttribute("disabled"), true,
    "a shared pending operation must disable every visible trigger");
  fireEvent.click(screen.getByRole("button", { name: "Copy info" }));
  assert.deepEqual(copiedTexts, [], "pending triggers must not start another clipboard write");

  controller.pending = false;
  controller.copied = true;
  view.rerender(
    <CopyButton controller={controller} text={() => "diagnostic"}>
      {({ copied, disabled, onClick }) => (
        <button type="button" className="original-shell" disabled={disabled} onClick={onClick}>
          {copied ? "Copied" : "Copy info"}
        </button>
      )}
    </CopyButton>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Copied" }));
  await waitFor(() => assert.deepEqual(copiedTexts, ["diagnostic"]));
});

test("CopyButton keeps the first click focusable but owns repeated mouse-down selection", () => {
  const controller: CopyTextController = {
    copied: false,
    pending: false,
    async copyText() {},
    reset() {},
  };
  render(
    <CopyButton controller={controller} text="selection-free">
      {({ onClick, onMouseDown }) => (
        <button type="button" onClick={onClick} onMouseDown={onMouseDown}>
          Copy
        </button>
      )}
    </CopyButton>,
  );

  const copy = screen.getByRole("button", { name: "Copy" });
  const firstMouseDown = new MouseEvent("mousedown", { bubbles: true, cancelable: true, detail: 1 });
  copy.dispatchEvent(firstMouseDown);
  assert.equal(firstMouseDown.defaultPrevented, false,
    "the ordinary first click keeps native button focus behavior");

  const repeatedMouseDown = new MouseEvent("mousedown", { bubbles: true, cancelable: true, detail: 2 });
  copy.dispatchEvent(repeatedMouseDown);
  assert.equal(repeatedMouseDown.defaultPrevented, true,
    "the second click must not let the browser select nearby content");
});
