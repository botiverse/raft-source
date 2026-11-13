import { PointerSensor } from "@dnd-kit/core";
import type { KeyboardSensorOptions, PointerSensorOptions } from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import type { PointerEvent as ReactPointerEvent } from "react";

/**
 * PointerSensor that ignores finger touches. dnd-kit's PointerSensor also
 * activates on touch pointers, and pointerdown fires before touchstart, so in
 * lists that pair it with a long-press TouchSensor a 6px finger scroll started
 * a drag before the long press could apply (#triage:c05ee3a4). Mouse and pen
 * keep the PointerSensor path; touch is left to the TouchSensor.
 */
export class NonTouchPointerSensor extends PointerSensor {
  static activators = [{
    eventName: "onPointerDown" as const,
    handler: (event: ReactPointerEvent, options: PointerSensorOptions) => {
      if (event.nativeEvent.pointerType === "touch") return false;
      return PointerSensor.activators[0].handler(event, options);
    },
  }];
}

/**
 * The keyboard path of a sortable list (Raft DS › Accessibility: drag is a
 * shortcut, never the only way): Space picks the focused row up, the arrow
 * keys move it, Space drops it and Escape puts it back, as task cards. Enter
 * is left to the row's own action (switching to that server), so it never
 * starts a drag.
 */
export const SORTABLE_KEYBOARD_SENSOR_OPTIONS: KeyboardSensorOptions = {
  coordinateGetter: sortableKeyboardCoordinates,
  keyboardCodes: { start: ["Space"], cancel: ["Escape"], end: ["Space"] },
};
