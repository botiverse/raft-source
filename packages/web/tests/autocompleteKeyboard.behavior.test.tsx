import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import "./helpers/domSetup";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { KeyboardEvent } from "react";
import { useAutocomplete } from "../src/hooks/useAutocomplete";

afterEach(cleanup);

function keyboardEvent(key: string, shiftKey = false) {
  let prevented = 0;
  const event = {
    key,
    shiftKey,
    preventDefault() {
      prevented += 1;
    },
  } as unknown as KeyboardEvent;
  return { event, prevented: () => prevented };
}

test("autocomplete leaves Shift+Enter to the composer while plain Enter selects", () => {
  const hook = renderHook(() => useAutocomplete(/@([^\s@]*)$/, "@"));

  act(() => {
    assert.equal(hook.result.current.detect("@", 1), true);
  });
  assert.equal(hook.result.current.show, true);

  let selected = 0;
  const shifted = keyboardEvent("Enter", true);
  let consumed = true;
  act(() => {
    consumed = hook.result.current.handleKeyDown(shifted.event, 1, () => {
      selected += 1;
    });
  });
  assert.equal(consumed, false, "Shift+Enter must remain available for a newline");
  assert.equal(shifted.prevented(), 0, "Shift+Enter must not prevent the textarea default");
  assert.equal(selected, 0, "Shift+Enter must not choose an autocomplete item");

  const plain = keyboardEvent("Enter");
  act(() => {
    consumed = hook.result.current.handleKeyDown(plain.event, 1, () => {
      selected += 1;
    });
  });
  assert.equal(consumed, true);
  assert.equal(plain.prevented(), 1);
  assert.equal(selected, 1);
});
