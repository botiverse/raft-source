import { useCallback, useRef } from "react";
import type { RefCallback } from "react";

/** Set on the group while its controls show only their icons. */
export const ICONS_ONLY_ATTRIBUTE = "data-icons-only";

/**
 * The group's CSS: while it shows icons only, a word marked `data-toolbar-label`
 * is `sr-only` (it stays the button's name, and its tooltip: ToolbarLabelTooltip),
 * and an icon marked `data-toolbar-icon-only` (Clear's ×, hidden otherwise) shows.
 */
export const ICONS_ONLY_GROUP_CLASS = "data-icons-only:**:data-[toolbar-label]:sr-only data-icons-only:**:data-[toolbar-icon-only]:block";

/**
 * A wrapping filter row gives up its words before it gives up its line
 * (#proj-workspace:dc3c9fc9, xxchan: in a narrow window fewer words on the
 * buttons reads better than a second line), in the order of Raft DS ›
 * Responsive layout › "When a row runs out of room": first its secondary
 * buttons show only their icons, each label kept as the accessible name and
 * the tooltip (step 1: here, ToolbarLabelTooltip); the main control, the view
 * switch, keeps its words beside them (its own `iconsOnlyBelow` gives them up
 * in a phone's bar); only when even the icons don't fit does the row wrap.
 *
 * Put the returned ref on the `flex-wrap` group: while its controls, laid out
 * with their words, would run onto a second line, the group carries
 * `data-icons-only`, and its CSS (ICONS_ONLY_GROUP_CLASS) hides the words it
 * marks. The same decision as raft-ui's `iconsOnlyBelow="auto"`, for buttons
 * raft-ui has no such option on (PickerTriggerButton): measured in the worded
 * layout whatever the group shows now, the attribute off for the read and back
 * before anything paints, so the answer depends only on the room the group has
 * (its width doesn't follow its content) and can't flap. A group that is
 * `display: contents` (Tasks' narrow toolbar) is measured by its children
 * against its parent's width.
 */
export function useIconsOnlyWhenWrapped<T extends HTMLElement>(): RefCallback<T> {
  const cleanup = useRef<(() => void) | undefined>(undefined);

  return useCallback((node: T | null) => {
    cleanup.current?.();
    cleanup.current = undefined;
    const view = node?.ownerDocument.defaultView;
    if (!node || !view || !("ResizeObserver" in view)) return;

    // Only the row's own controls count: a child out of the flow is not on a
    // line. An open popover's focus guards (Base UI puts fixed 1px spans
    // beside its trigger) sit at the window's top and used to read as a
    // wrapped row, so every filter lost its word while one was open.
    const controls = () => Array.from(node.children).filter((child) => {
      const position = view.getComputedStyle(child).position;
      return position !== "fixed" && position !== "absolute";
    });
    const controlBoxes = () => controls()
      .map((child) => child.getBoundingClientRect())
      .filter((box) => box.width > 0 && box.height > 0);
    const update = () => {
      const iconsOnly = node.hasAttribute(ICONS_ONLY_ATTRIBUTE);
      if (iconsOnly) {
        node.removeAttribute(ICONS_ONLY_ATTRIBUTE);
      }
      const boxes = controlBoxes();
      // A control starting below the bottom of another is on a later line.
      const firstBottom = Math.min(...boxes.map((box) => box.bottom));
      const wrapped = boxes.some((box) => box.top >= firstBottom - 1);
      if (wrapped) node.setAttribute(ICONS_ONLY_ATTRIBUTE, "");
      else if (iconsOnly) node.removeAttribute(ICONS_ONLY_ATTRIBUTE);
    };
    // The row's room (the group, or its parent for a `contents` group) and
    // each control (a filter's value comes or goes) resize; a control added
    // or removed (Clear) is caught by the mutation observer.
    const resize = new view.ResizeObserver(update);
    const observeAll = () => {
      resize.disconnect();
      resize.observe(node);
      if (node.parentElement) resize.observe(node.parentElement);
      for (const child of Array.from(node.children)) resize.observe(child);
    };
    const mutation = new view.MutationObserver(() => {
      observeAll();
      update();
    });
    mutation.observe(node, { childList: true });
    observeAll();
    update();
    void node.ownerDocument.fonts?.ready.then(update);
    cleanup.current = () => {
      resize.disconnect();
      mutation.disconnect();
    };
  }, []);
}
