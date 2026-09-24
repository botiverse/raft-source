import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import Lightbox from "../src/components/ui/Lightbox";

afterEach(() => {
  cleanup();
});

function TestLightbox({ onClose }: { onClose: () => void }) {
  return (
    <Lightbox onClose={onClose} data-testid="lightbox-root">
      <div data-testid="lightbox-content">Preview text</div>
    </Lightbox>
  );
}

test("Lightbox backdrop dismiss requires the press to start on the backdrop", () => {
  const closeCalls: string[] = [];
  render(<TestLightbox onClose={() => closeCalls.push("close")} />);

  const root = screen.getByTestId("lightbox-root");
  const content = screen.getByTestId("lightbox-content");

  fireEvent.pointerDown(content);
  fireEvent.click(root);
  assert.deepEqual(closeCalls, [], "drag-select gestures that begin in content must not dismiss on final backdrop click");

  fireEvent.pointerDown(root);
  fireEvent.click(root);
  assert.deepEqual(closeCalls, ["close"], "true backdrop clicks still dismiss");
});
