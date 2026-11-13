import { test } from "vitest";
import assert from "node:assert/strict";
import { PointerSensor } from "@dnd-kit/core";
import type { PointerEvent as ReactPointerEvent } from "react";
import { NonTouchPointerSensor } from "../src/lib/dndSensors";

function pointerDown(pointerType: string) {
  return { nativeEvent: { pointerType, isPrimary: true, button: 0 } } as unknown as ReactPointerEvent;
}

const activate = NonTouchPointerSensor.activators[0];

test("a finger touch never activates the pointer sensor (scrolling must not start a drag)", () => {
  let activated = 0;
  const handled = activate.handler(pointerDown("touch"), { onActivation: () => { activated += 1; } });
  assert.equal(handled, false);
  assert.equal(activated, 0);
});

test("mouse and pen keep PointerSensor's activation", () => {
  for (const pointerType of ["mouse", "pen"]) {
    let activated = 0;
    const handled = activate.handler(pointerDown(pointerType), { onActivation: () => { activated += 1; } });
    assert.equal(handled, true);
    assert.equal(activated, 1);
  }
  assert.equal(activate.eventName, PointerSensor.activators[0].eventName);
});
