import { LOCATED_MS } from "@botiverse/raft-ui";

/** The pending end of each element's located highlight. */
const locatedTimers = new WeakMap<HTMLElement, number>();

/**
 * Put raft-ui's located highlight on an element outside React
 * (design/foundations/states.md#located) for LOCATED_MS: a region of a file a
 * comment is anchored to, a setting a Settings link or search opened. Jumping
 * to it again while it shows restarts it: the attribute comes off, a reflow
 * lets the animation end, and it goes back on.
 */
export function locateElement(el: HTMLElement): void {
  const pending = locatedTimers.get(el);
  if (pending !== undefined) window.clearTimeout(pending);
  el.removeAttribute("data-located");
  void el.offsetWidth;
  el.setAttribute("data-located", "");
  locatedTimers.set(el, window.setTimeout(() => {
    el.removeAttribute("data-located");
    locatedTimers.delete(el);
  }, LOCATED_MS));
}
