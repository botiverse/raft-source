import "./helpers/domSetup";

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import InlineBadgeEditor from "../src/components/InlineBadgeEditor";

afterEach(cleanup);

Object.defineProperty(window, "matchMedia", {
  configurable: true,
  value: () => ({ matches: true } as MediaQueryList),
});

function rect(input: Partial<DOMRect>): DOMRect {
  return {
    bottom: 0,
    height: 0,
    left: 0,
    right: 0,
    top: 0,
    width: 0,
    x: 0,
    y: 0,
    toJSON: () => ({}),
    ...input,
  };
}

function renderEditor(onRequestClose: () => void) {
  return render(
    <div data-testid="host">
      <InlineBadgeEditor
        displayValue="Todo"
        selectedId="todo"
        options={[
          { id: "todo", label: "Todo" },
          { id: "done", label: "Done" },
        ]}
        onSelect={() => undefined}
        open
        onToggle={() => undefined}
        onRequestClose={onRequestClose}
        badgeClassName="bg-white"
        buttonTestId="badge-trigger"
        dropdownTestId="badge-dropdown"
      />
    </div>,
  );
}

test("InlineBadgeEditor portals its measured dropdown to the body", async (t) => {
  t.mock.method(HTMLElement.prototype, "getBoundingClientRect", function (this: HTMLElement) {
    if (this.dataset.testid === "badge-trigger") {
      return rect({ bottom: 50, height: 20, left: 20, right: 100, top: 30, width: 80, x: 20, y: 30 });
    }
    if (this.dataset.testid === "badge-dropdown") {
      return rect({ bottom: 0, height: 80, left: 0, right: 0, top: 0, width: 120 });
    }
    return rect({});
  });

  const view = renderEditor(() => undefined);
  const host = screen.getByTestId("host");
  const dropdown = await screen.findByTestId("badge-dropdown");

  assert.equal(host.contains(dropdown), false, "dropdown must escape the host stacking context");
  assert.equal(dropdown.parentElement, document.body);
  await waitFor(() => assert.equal(dropdown.style.visibility, "visible"));
  assert.equal(dropdown.style.position, "fixed");
  assert.equal(dropdown.style.left, "20px");
  assert.equal(dropdown.style.top, "54px");
  assert.equal(dropdown.style.zIndex, "1000");
  view.unmount();
});

test("InlineBadgeEditor keeps trigger and portal clicks inside, then closes on an outside click", async (t) => {
  t.mock.method(HTMLElement.prototype, "getBoundingClientRect", () => rect({ height: 20, width: 80 }));
  let closeRequests = 0;

  renderEditor(() => { closeRequests += 1; });
  const trigger = screen.getByTestId("badge-trigger");
  const dropdown = await screen.findByTestId("badge-dropdown");

  fireEvent.mouseDown(trigger);
  fireEvent.mouseDown(dropdown);
  assert.equal(closeRequests, 0);

  fireEvent.mouseDown(document.body);
  assert.equal(closeRequests, 1);
});
