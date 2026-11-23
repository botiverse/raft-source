import { isModalLayerOpen } from "../../features/shortcuts";
import { docOf } from "../../utils/ownerDocument";

/**
 * A key an input method takes while it composes text (Chinese, Japanese, Korean): Esc cancels
 * its text, Enter confirms it, the arrows choose a candidate. Never the field's or the
 * viewer's. Safari's Enter that confirms the text comes after composition ends, so
 * `isComposing` is already false on it; its keyCode is still 229.
 */
export function isInputMethodKey(event: { keyCode: number; nativeEvent: { isComposing: boolean } }): boolean {
  return event.nativeEvent.isComposing || event.keyCode === 229;
}

/**
 * An Esc the artifact surface must leave alone: one something already took, an input method's,
 * or one a modal over the surface (a raft-ui Dialog such as a draft's delete confirmation) closes
 * on, even before the focus reaches it. The modal is looked for in the document the key was
 * typed in (its target's): a surface drawn in an object window has its own (#337 PR3), and a
 * dialog open in the main window is not over it.
 */
export function isEscapeTakenElsewhere(event: { defaultPrevented: boolean; keyCode: number; nativeEvent: { isComposing: boolean }; target?: EventTarget | null }): boolean {
  return event.defaultPrevented || isInputMethodKey(event) || isModalLayerOpen(docOf(event.target));
}
