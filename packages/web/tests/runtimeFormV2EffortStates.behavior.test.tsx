import assert from "node:assert/strict";
import "./helpers/domSetup";
import { cleanup, render } from "@testing-library/react";
import type { RuntimeFormV2Field, RuntimeFormV2Option, RuntimeFormV2Sources } from "@botiverse/raft-runtime-form";
import { RuntimeFormV2FieldControl } from "../src/components/agent/RuntimeFormV2FieldControl";
import { TestIntlProvider } from "./helpers/intl";

// The reasoning-effort field (a derived_select over the selected model's
// efforts) never disappears when the Computer says why a model has none
// (triage #492): "doesn't support" for a model that takes none, "can't read"
// plus the runtime's reason when the levels could not be read. A model an
// older Computer reported with no effort information stays hidden, as before.

afterEach(() => cleanup());

const EFFORT_FIELD = {
  key: "reasoningEffort",
  kind: "derived_select",
  required: false,
  advanced: false,
  label: "Reasoning effort",
  derivedFrom: { key: "model", attribute: "supportedReasoningEfforts", defaultAttribute: "defaultReasoningEffort" },
  visibleWhen: [],
} as RuntimeFormV2Field;

function renderEffortField(model: RuntimeFormV2Option) {
  const sources: RuntimeFormV2Sources = {
    model: { sourceId: "model", kind: "select", pointer: "/model", options: [model], defaultValue: model.value } as RuntimeFormV2Sources[string],
  };
  return render(
    <TestIntlProvider>
      <RuntimeFormV2FieldControl
        field={EFFORT_FIELD}
        sources={sources}
        values={{ model: model.value, reasoningEffort: "" }}
        onChange={() => {}}
        error={undefined}
        editing={false}
        retryingSourceIds={[]}
      />
    </TestIntlProvider>,
  );
}

const trigger = (container: HTMLElement) => container.querySelector<HTMLElement>('[data-testid="runtime-form-v2-reasoningEffort"]');

test("a model with effort levels shows the picker, changeable", () => {
  const { container } = renderEffortField({ value: "gemini-pro", label: "Gemini Pro", supportedReasoningEfforts: ["low", "high"] });
  const control = trigger(container);
  assert.ok(control, "the effort picker is shown");
  assert.ok(!control.hasAttribute("data-disabled") && !control.hasAttribute("disabled"), "the picker can be changed");
  const text = container.textContent ?? "";
  assert.ok(!text.includes("doesn't support adjusting effort"));
  assert.ok(!text.includes("Can't read the effort levels"));
});

test("a model that takes no effort (explicit empty list) shows the field, not adjustable", () => {
  const { container } = renderEffortField({ value: "gemini-flash", label: "Gemini Flash", supportedReasoningEfforts: [], reasoningEffortNone: true });
  const control = trigger(container);
  assert.ok(control, "the field stays visible");
  assert.ok(control.hasAttribute("data-disabled") || control.hasAttribute("disabled"), "the control cannot be changed");
  assert.ok((container.textContent ?? "").includes("This model doesn't support adjusting effort."));
  assert.ok((container.textContent ?? "").includes("Reasoning effort"));
});

test("a model whose levels could not be read shows the field with the runtime's reason as text", () => {
  const reason = "Native catalog did not expose this model's <b>effort</b> menu.";
  const { container } = renderEffortField({ value: "gemini-ultra", label: "Gemini Ultra", supportedReasoningEfforts: [], reasoningEffortUnavailableReason: reason });
  const control = trigger(container);
  assert.ok(control, "the field stays visible");
  assert.ok(control.hasAttribute("data-disabled") || control.hasAttribute("disabled"), "the control cannot be changed");
  assert.ok((container.textContent ?? "").includes(`Can't read the effort levels: ${reason}`));
  // Provider text is rendered as text, never as markup.
  assert.ok(container.querySelector("b") === null, "the reason's markup is not rendered");
  assert.ok(!(container.textContent ?? "").includes("doesn't support adjusting effort"));
});

test("an older Computer's model with no effort information keeps today's hidden field", () => {
  // OAR 0.107 read only the default model's levels: the others arrive with an
  // empty list and no explanation, which is "not reported", not "none".
  const { container } = renderEffortField({ value: "gemini-ultra", label: "Gemini Ultra", supportedReasoningEfforts: [] });
  assert.ok(trigger(container) === null, "the effort field stays hidden");
  const text = container.textContent ?? "";
  assert.ok(!text.includes("doesn't support adjusting effort"));
  assert.ok(!text.includes("Can't read the effort levels"));
});
