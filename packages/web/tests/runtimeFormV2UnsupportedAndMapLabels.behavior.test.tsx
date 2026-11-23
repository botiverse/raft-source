import assert from "node:assert/strict";
import "./helpers/domSetup";
import { cleanup, render } from "@testing-library/react";
import { parseRuntimeFormV2, RUNTIME_FORM_V3_PROTOCOL_VERSION } from "@botiverse/raft-runtime-form";
import RuntimeConfigFields from "../src/components/agent/RuntimeConfigFields";
import { TestIntlProvider } from "./helpers/intl";

// Two things Lagoon's generated "big form" screenshots showed
// (#wg-runtime-form:#29): a required field this build cannot render (a
// number) said "Update Raft to edit this setting." twice, once as the field
// and again as its validation error; and a key/value field was always titled
// "Environment variables", whatever the form called it.

afterEach(() => cleanup());

const UPDATE = "Update Raft to edit this setting.";

const form = parseRuntimeFormV2({
  protocolVersion: RUNTIME_FORM_V3_PROTOCOL_VERSION,
  dataSchema: {
    type: "object",
    properties: {
      maxTurns: { type: "integer", title: "Max turns" },
      headers: { type: "object", title: "Request headers", additionalProperties: { type: "string" } },
    },
    required: ["maxTurns"],
  },
  uiSchema: {},
});

function renderForm() {
  assert.ok(form, "the form parses");
  return render(
    <TestIntlProvider>
      <RuntimeConfigFields
        runtime="builtin"
        onRuntimeChange={() => {}}
        runtimeOptions={[{ value: "builtin", label: "Built-in" }]}
        runtimeFormV2={{ state: { status: "ready", form, sources: {} }, values: {}, onChange: () => {}, editing: false }}
        showValidationErrors
      />
    </TestIntlProvider>,
  );
}

test("a required field this build cannot render says to update Raft once, even with validation errors shown", () => {
  const text = renderForm().container.textContent ?? "";
  assert.equal(text.split(UPDATE).length - 1, 1, text);
});

test("a key/value field carries the form's own title", () => {
  const text = renderForm().container.textContent ?? "";
  assert.ok(text.includes("Request headers"), text);
  assert.ok(!text.includes("Environment variables"), text);
});
