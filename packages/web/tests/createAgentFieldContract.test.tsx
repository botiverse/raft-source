import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import "./helpers/domSetup";
import { cleanup, render as rtlRender } from "@testing-library/react";
import StableField from "../src/components/agent/StableField";
import { TestIntlProvider } from "./helpers/intl";

afterEach(() => cleanup());
const render: typeof rtlRender = (ui, o) => rtlRender(ui, { wrapper: TestIntlProvider, ...o });

/**
 * The field contract for the Create Agent dialog.
 *
 * These assert BEHAVIOUR, not markup shape: earlier guards in this area pinned
 * the exact hand-rolled `<label>`/`<p>` and had to be rewritten three times as
 * the implementation moved, each time proving nothing about whether the field
 * actually worked. What matters is that a control is adopted and wired, that a
 * misconfigured field fails visibly rather than silently, and that state
 * reaches the control.
 *
 * Geometry (16px gaps, stable dialog height) is deliberately NOT asserted here:
 * jsdom does no layout, so every measurement would read 0 and the test would
 * pass vacuously. Those live in the browser-measured evidence instead — a green
 * assertion that cannot fail is worse than no assertion.
 */

const ctl = (c: HTMLElement | null) => c?.querySelector("input,textarea,button");

test("the control is adopted and wired: it gets an id and an aria-describedby", () => {
  const { container } = render(
    <StableField label="Name" required hint="pick something short">
      <input data-testid="c" />
    </StableField>,
  );
  const control = ctl(container) as HTMLInputElement;
  assert.ok(control.id, "the library assigns the control an id");
  assert.ok(
    control.getAttribute("aria-describedby"),
    "the control points at its description, so the message row is announced",
  );
});

test("the label is associated with the control, so clicking it focuses the control", () => {
  const { container } = render(
    <StableField label="Name" required><input /></StableField>,
  );
  const label = container.querySelector("label");
  const control = ctl(container) as HTMLInputElement;
  // Base UI wires this by id rather than `for`: the label carries an id and the
  // control references it. Asserting `for` specifically would pin one mechanism
  // and fail on an equivalent, correct one.
  const via = label?.getAttribute("for") === control.id
    || control.getAttribute("aria-labelledby") === label?.id;
  assert.ok(via, `label and control are associated (for=${label?.getAttribute("for")}, aria-labelledby=${control.getAttribute("aria-labelledby")}, labelId=${label?.id}, controlId=${control.id})`);
});

test("a field with NO control fails closed: visibly invalid, not silently unwired", () => {
  const { container } = render(<StableField label="Broken">{null}</StableField>);
  const field = container.querySelector("[data-field-config-error]");
  assert.ok(field, "the misconfiguration is surfaced rather than rendered as if fine");
  assert.equal(field?.getAttribute("data-invalid"), "true", "and the field renders as invalid");
  assert.equal(
    container.querySelector("[data-field-config-error]")?.getAttribute("data-field-config-error"),
    "0",
    "the attribute records how many controls were found, for assertions and debugging",
  );
});

test("a field with TWO controls fails closed the same way", () => {
  const { container } = render(
    <StableField label="Broken"><input /><input /></StableField>,
  );
  assert.ok(container.querySelector("[data-field-config-error]"));
  assert.equal(
    container.querySelector("[data-field-config-error]")?.getAttribute("data-field-config-error"),
    "2",
  );
});

test("a control beside a non-interactive sibling still adopts and wires", () => {
  // The realistic shape: a control plus an explanatory notice. Counting the
  // notice as a second control made the field look misconfigured and cost it
  // the library's id / aria wiring.
  const { container } = render(
    <StableField label="Computer" required>
      <input />
      <p>only online computers can run agents</p>
    </StableField>,
  );
  assert.equal(container.querySelector("[data-field-config-error]"), null, "not treated as broken");
  const control = ctl(container) as HTMLInputElement;
  assert.ok(control.id, "the control is still adopted");
  assert.ok(control.getAttribute("aria-describedby"), "and still wired");
});

test("two genuinely interactive children still fail closed", () => {
  const { container } = render(
    <StableField label="Broken"><input /><textarea /></StableField>,
  );
  assert.ok(container.querySelector("[data-field-config-error]"), "0/2 fail-closed is preserved");
});

test("a composite field declares itself and is not treated as broken", () => {
  const { container } = render(
    <StableField label="Env vars" adopt={false}><input /><input /></StableField>,
  );
  assert.equal(
    container.querySelector("[data-field-config-error]"),
    null,
    "`adopt={false}` is an explicit declaration, not a silent fallthrough",
  );
});

test("error replaces hint in the same row rather than stacking a second one", () => {
  const { container } = render(
    <StableField label="Name" hint="the hint" error="the error"><input /></StableField>,
  );
  const text = container.textContent ?? "";
  assert.match(text, /the error/);
  assert.doesNotMatch(text, /the hint/, "hint and error never occupy the row together");
});

test("the message row is present even with nothing to say, so height cannot depend on content", () => {
  const { container } = render(<StableField label="Name"><input /></StableField>);
  const desc = container.querySelector('[data-slot="field-description"]');
  assert.ok(desc, "the row is rendered, not unmounted, when empty");
  assert.ok(
    desc?.querySelector(".invisible"),
    "it is hidden rather than removed, so the field keeps its height",
  );
});

test("the counter keeps its place whether or not a message occupies the row", () => {
  const withMsg = render(<StableField label="D" error="bad" counter="7/10"><input /></StableField>);
  assert.match(withMsg.container.textContent ?? "", /7\/10/);
  cleanup();
  const without = render(<StableField label="D" counter="7/10"><input /></StableField>);
  assert.match(without.container.textContent ?? "", /7\/10/);
});

test("required and optional both render their marker through the library", () => {
  const req = render(<StableField label="Name" required><input /></StableField>);
  assert.match(req.container.textContent ?? "", /\*/, "required renders the asterisk");
  cleanup();
  const opt = render(<StableField label="Name" optional><input /></StableField>);
  assert.match(opt.container.textContent ?? "", /optional/i, "optional renders its word");
});
