// Deferred focus (a composer that mounts late, a failed send restoring its
// draft) must not take focus the user already put somewhere else: the top
// search box, another text field, or an open dialog (#triage:#278).

import { isTextEditableElement } from "./keyboardShortcuts";

/** An open dialog or modal layer (Base UI popovers and sheets are dialogs too). */
export const OVERLAY = "[role='dialog'], [role='alertdialog'], [aria-modal='true']";

/** Whether `target` may take focus now without stealing it from the user. */
export function mayTakeFocus(target: Element | null | undefined, doc: Document = document): boolean {
  if (!target) return false;
  const active = doc.activeElement;
  if (!active || active === doc.body || active === target || target.contains(active)) return true;
  if (active.closest(OVERLAY) && !target.closest(OVERLAY)) return false;
  return !isTextEditableElement(active);
}

/** A dialog's own popup: what a press on its blank space focuses, the page of a dialog. */
const POPUP = "[role='dialog'], [role='alertdialog']";

/**
 * Focus fell to nowhere for `target`: nothing holds it, <body> does, or an element that has left the document does
 * (the surface that held it closed). A dialog's popup holding focus itself (a press on its blank space) is nowhere only
 * for a target inside that dialog: focus never leaves an open dialog for the page behind it (rule 1). Focus anywhere
 * else is somewhere the person put it.
 */
export function focusLost(target?: Element | null, doc: Document = document): boolean {
  const active = doc.activeElement;
  if (!active || active === doc.body || !active.isConnected) return true;
  return active.matches(POPUP) && !!target && active.contains(target);
}

/**
 * `target` sits behind an open modal layer, where even a person's own request must not put focus (rule 1): raft-ui's
 * modal Dialog / Drawer (Base UI) hides the page behind it (`aria-hidden`), an `inert` region is out of reach, and a
 * hand-rolled `aria-modal` layer holding focus keeps it from anything outside itself. Base UI also hides the page while
 * a context menu, or a combobox list driven from an input outside it, is open; focus is not put there either, as
 * nothing hidden from assistive tech should take it. A popover or dropdown menu hides nothing.
 */
export function behindModalLayer(target: Element, doc: Document = document): boolean {
  if (target.closest("[inert], [aria-hidden='true']")) return true;
  const layer = doc.activeElement?.closest("[aria-modal='true']");
  return !!layer && !layer.contains(target);
}
