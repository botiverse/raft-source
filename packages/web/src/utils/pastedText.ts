type PastedTextSource = Pick<DataTransfer, "types" | "getData"> | null | undefined;

/** The plain text a paste carries, with line breaks as a textarea keeps them,
 *  or "" when it carries none. */
export function pastedPlainText(source: PastedTextSource): string {
  if (!source || !Array.from(source.types ?? []).includes("text/plain")) return "";
  return source.getData("text/plain").replace(/\r\n?/g, "\n");
}

/** As much of text as fits in field's maxlength in place of its selection,
 *  never ending inside a surrogate pair. */
function fitToMaxLength(field: HTMLTextAreaElement, text: string): string {
  const max = field.maxLength;
  if (max < 0) return text;
  const kept = field.value.length - (field.selectionEnd - field.selectionStart);
  const room = Math.max(0, max - kept);
  if (text.length <= room) return text;
  let fitted = text.slice(0, room);
  const last = fitted.charCodeAt(fitted.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) fitted = fitted.slice(0, -1);
  return fitted;
}

/** Ends the undo step typing has open in field, keeping its selection: a
 *  caret move ends it. insertText counts as typing, so without this a paste
 *  joins what was typed around it in one undo step; a native paste is a step
 *  of its own. */
function endTypingStep(field: HTMLTextAreaElement) {
  const { selectionStart: start, selectionEnd: end, selectionDirection: direction } = field;
  if (field.value.length === 0) return;
  const elsewhere = start > 0 ? start - 1 : 1;
  field.setSelectionRange(elsewhere, elsewhere);
  field.setSelectionRange(start, end, direction ?? undefined);
}

/**
 * Inserts the plain text of a paste into field from the paste event's own
 * data, as typing it would (undo works, an input event fires), so the browser
 * does not read the clipboard a second time to insert (task #777). Returns
 * whether it handled the paste; the caller then cancels the default.
 */
export function insertPastedText(field: HTMLTextAreaElement, source: PastedTextSource): boolean {
  if (field.disabled || field.readOnly) return false;
  const pasted = pastedPlainText(source);
  if (!pasted) return false;
  const text = fitToMaxLength(field, pasted);
  if (!text) return true;
  endTypingStep(field);
  if (document.execCommand("insertText", false, text)) {
    endTypingStep(field);
    return true;
  }
  // No execCommand (or it refused): write the text and announce it the way
  // the browser's own paste would, so React's onChange still sees it.
  field.setRangeText(text, field.selectionStart, field.selectionEnd, "end");
  field.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertFromPaste", data: text }));
  return true;
}
