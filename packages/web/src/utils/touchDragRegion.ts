import { TouchSensor } from "@dnd-kit/core";

/**
 * Touch-drag regions: where a dnd-kit touch drag may start.
 *
 * dnd-kit's `TouchSensor.setup()` adds a `touchmove` listener with
 * `passive: false` to `window` for as long as any DndContext using the sensor
 * is mounted (the Sidebar, the chat panel's sortable tabs, ...). It is a no-op
 * whose only job is to make touch sequences cancelable, so the move listener
 * dnd-kit attaches after a long press can call preventDefault() on iOS. But a
 * non-passive listener on `window` makes EVERY touch on the page synchronous:
 * WebKit then waits for the main thread before it scrolls, so scrolling the
 * chat stalls behind any busy frame.
 *
 * WebKit decides sync vs async per touch from where the touch starts, so the
 * listener only has to cover the elements a drag can start from. The app
 * therefore drops the window-wide setup (below, on import) and every drag
 * surface marks its own region with the `touchDragRegion` ref callback:
 * touches that start inside stay cancelable for dnd-kit, touches anywhere
 * else (the message list) stay asynchronous.
 *
 * Every component that mounts a TouchSensor (directly, or through raft-ui's
 * SortableTabsList) must give its drag surface this ref; the source contract
 * in tests/touchDragRegion.behavior.test.tsx (removed in the 2026-11 web DOM test prune) enforces that. Once raft-ui's
 * sortable components scope their own region, they can drop that duty.
 */

function preventableTouchMove() {
  // Intentionally empty: registering it is what makes the touch cancelable.
}

/** Ref callback for the element that contains a drag surface's draggables. */
export function touchDragRegion(node: HTMLElement | null): (() => void) | undefined {
  if (!node) return undefined;
  // oxlint-disable-next-line react-doctor/client-passive-event-listeners -- intentional: non-passive is the point (see above), scoped to the drag surface instead of window
  node.addEventListener("touchmove", preventableTouchMove, { passive: false });
  return () => node.removeEventListener("touchmove", preventableTouchMove);
}

function noTeardown() {}

/** Replaces dnd-kit's window-wide touchmove setup. Idempotent. */
export function installScopedTouchSensorSetup(): void {
  TouchSensor.setup = function scopedTouchSensorSetup() {
    return noTeardown;
  };
}

installScopedTouchSensorSetup();
