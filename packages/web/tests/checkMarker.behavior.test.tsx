import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import "./helpers/domSetup";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";

import Checkbox from "../src/components/ui/Checkbox";
import CheckMarker from "../src/components/ui/CheckMarker";

afterEach(cleanup);

test("CheckMarker renders square, circle, black-fill, and yellow-fill states", () => {
  const view = render(
    <div>
      <CheckMarker data-testid="form" checked size="md" tone="black-fill" />
      <CheckMarker data-testid="list" checked size="lg" tone="yellow-fill" />
      <CheckMarker data-testid="message" checked shape="circle" size="lg" tone="yellow-fill" />
    </div>,
  );

  assert.match(view.getByTestId("form").className, /size-4/);
  assert.match(view.getByTestId("form").className, /bg-black text-white/);
  assert.match(view.getByTestId("list").className, /size-5/);
  assert.match(view.getByTestId("list").className, /bg-soft-signal text-black/);
  assert.match(view.getByTestId("message").className, /rounded-full/);
  assert.match(view.getByTestId("message").className, /bg-soft-signal text-black/);
});

function CheckboxHarness({ disabled = false }: { disabled?: boolean }) {
  const [checked, setChecked] = useState(false);
  return (
    <label>
      Choose item
      <Checkbox
        aria-label="Choose item"
        checked={checked}
        disabled={disabled}
        onChange={(event) => setChecked(event.currentTarget.checked)}
      />
    </label>
  );
}

test("Checkbox keeps native checked semantics and a shared black-fill marker", () => {
  const view = render(<CheckboxHarness />);
  const input = screen.getByRole("checkbox", { name: "Choose item" }) as HTMLInputElement;
  const marker = view.container.querySelector(".check-marker-brutal");
  assert.ok(marker);

  assert.equal(input.checked, false);
  assert.match(marker.className, /bg-white text-transparent/);
  assert.equal(marker.querySelector("svg"), null);

  fireEvent.click(input);
  assert.equal(input.checked, true);
  assert.match(marker.className, /bg-black text-white/);
  assert.ok(marker.querySelector("svg"));
});

test("disabled Checkbox does not toggle its native value or marker", () => {
  const view = render(<CheckboxHarness disabled />);
  const input = screen.getByRole("checkbox", { name: "Choose item" }) as HTMLInputElement;
  const marker = view.container.querySelector(".check-marker-brutal");
  assert.ok(marker);

  input.click();
  assert.equal(input.checked, false);
  assert.match(marker.className, /bg-white text-transparent/);
  assert.match(marker.className, /opacity-50/);
});
