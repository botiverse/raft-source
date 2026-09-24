import "./helpers/domSetup";

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  RuntimeSelectControlForTest,
  commitRuntimeSelectValueForTest,
} from "../src/components/agent/RuntimeConfigFields";

const options = [
  { value: "available", label: "Available model" },
  { value: "persisted", label: "Persisted incompatible model", disabled: true },
] as const;

afterEach(cleanup);

test("a persisted incompatible runtime option renders disabled", async () => {
  let writes = 0;
  render(
    <RuntimeSelectControlForTest
      value="persisted"
      onValueChange={() => { writes += 1; }}
      options={options}
      placeholder="Model"
    />,
  );

  fireEvent.click(screen.getByRole("combobox"));
  const incompatible = await screen.findByRole("option", {
    name: "Persisted incompatible model",
  });

  assert.equal(
    incompatible.getAttribute("aria-disabled"),
    "true",
    "the persisted value may remain visible, but must be unavailable for selection",
  );
  assert.ok(
    incompatible.hasAttribute("data-disabled"),
    "the disabled styling/state hook must reach the rendered option",
  );

  fireEvent.pointerDown(incompatible);
  fireEvent.click(incompatible);
  assert.equal(writes, 0, "a disabled option must not reach the writer through normal UI input");
});

test("the select write boundary rejects an injected disabled or unknown value", () => {
  const writes: string[] = [];
  const write = (value: string) => { writes.push(value); };

  commitRuntimeSelectValueForTest(options, "persisted", write);
  commitRuntimeSelectValueForTest(options, "missing", write);
  commitRuntimeSelectValueForTest(options, null, write);
  assert.deepEqual(
    writes,
    [],
    "bypassing the visual layer must not submit a disabled, unknown, or empty value",
  );

  commitRuntimeSelectValueForTest(options, "available", write);
  assert.deepEqual(writes, ["available"], "the guard must preserve valid selection writes");
});
