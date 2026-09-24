import "./helpers/domSetup";

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render } from "@testing-library/react";

import Modal from "../src/components/Modal";

const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
const originalScrollIntoView = Element.prototype.scrollIntoView;

afterEach(() => {
  cleanup();
  globalThis.requestAnimationFrame = originalRequestAnimationFrame;
  Element.prototype.scrollIntoView = originalScrollIntoView ?? (() => undefined);
});

test("shared Modal exposes its own full-height scrollport and centered content", () => {
  const { getByRole } = render(
    <Modal onClose={() => undefined}>
      <section aria-label="Tall form">Tall form</section>
    </Modal>,
  );

  const content = getByRole("region", { name: "Tall form" });
  const center = content.parentElement;
  const fullHeight = center?.parentElement;
  const scrollport = fullHeight?.parentElement;
  assert.ok(center && fullHeight && scrollport);
  assert.ok(center.classList.contains("m-auto"));
  assert.ok(fullHeight.classList.contains("min-h-full"));
  assert.ok(scrollport.classList.contains("fixed"));
  assert.ok(scrollport.classList.contains("inset-0"));
  assert.ok(scrollport.classList.contains("overflow-y-auto"));
});

test("focusing a field scrolls it into the mounted Modal scrollport", () => {
  const calls: Array<{ target: Element; options?: ScrollIntoViewOptions | boolean }> = [];
  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  }) as typeof requestAnimationFrame;
  Element.prototype.scrollIntoView = function scrollIntoView(
    options?: ScrollIntoViewOptions | boolean,
  ) {
    calls.push({ target: this, options });
  };

  const { getByRole } = render(
    <Modal onClose={() => undefined}>
      <input aria-label="Computer name" />
    </Modal>,
  );
  const input = getByRole("textbox", { name: "Computer name" });
  fireEvent.focus(input);

  assert.deepEqual(calls, [{
    target: input,
    options: { block: "nearest", inline: "nearest" },
  }]);
});
