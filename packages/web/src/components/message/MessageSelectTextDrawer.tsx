import { useCallback, useId, useLayoutEffect, useRef } from "react";
import { Check, Copy, TextQuote } from "lucide-react";
import { useIntl } from "react-intl";
import {
  Button,
  Drawer,
  DrawerActions,
  DrawerBody,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  ScrollArea,
  ScrollAreaTextarea,
} from "@botiverse/raft-ui";
import CopyButton from "../ui/CopyButton";
import { emitSelectedTextQuote } from "./selectedTextQuote";
import { hasTouchToSearch } from "./touchToSearch";

/**
 * The part of the sheet's text the reader has selected, or "" when nothing
 * is. A field keeps its selection range after it loses focus, though the
 * selection is no longer shown, so only the focused field's range counts.
 */
function selectedTextIn(field: HTMLTextAreaElement | null): string {
  if (!field || field.ownerDocument.activeElement !== field) return "";
  const text = field.value.slice(field.selectionStart, field.selectionEnd);
  return text.trim() ? text : "";
}

/** The locked field's guard: every edit (paste, cut, drop, undo, typing) is cancelled before it lands. */
function blockEdits(field: HTMLTextAreaElement) {
  const cancel = (event: Event) => event.preventDefault();
  field.addEventListener("beforeinput", cancel);
  return () => field.removeEventListener("beforeinput", cancel);
}

/** field-sizing: content where supported (Chrome 123+); elsewhere fit to the text by hand. */
function fitToText(field: HTMLTextAreaElement | null) {
  if (!field || (typeof CSS !== "undefined" && CSS.supports?.("field-sizing", "content"))) return;
  field.style.height = "auto";
  if (field.scrollHeight > 0) field.style.height = `${field.scrollHeight}px`;
}

/** The value is controlled: an edit that isn't cancelable (IME) is reverted. */
function keepText() {}

export interface MessageSelectTextDrawerProps {
  open: boolean;
  /** The drawer asked to close (×, swipe, scrim, Esc, or a footer action). */
  onClose: () => void;
  /** The close finished animating; the parent can unmount the drawer. */
  onClosed: () => void;
  senderName: string;
  /** The message's time as its header shows it. */
  time: string;
  /** The message's Markdown source: shown as plain text, copied and quoted whole. */
  markdown: string;
  /** The composer a quote lands in (MessageItem's quoteComposerChannelId). */
  quoteChannelId: string;
}

/**
 * "Select Text" on a touch screen (long-press menu): a bottom sheet holding
 * just the message's text with native selection, so a part of it can be
 * copied or quoted. With nothing selected, Copy and Quote take the whole
 * message.
 */
/** How long after its pointerdown a click still belongs to that press (a tap, a slow tap). */
const PRESS_CLICK_WINDOW_MS = 1000;

export function MessageSelectTextDrawer({
  open,
  onClose,
  onClosed,
  senderName,
  time,
  markdown,
  quoteChannelId,
}: MessageSelectTextDrawerProps) {
  const { formatMessage } = useIntl();
  const hintId = useId();
  const textRef = useRef<HTMLTextAreaElement | null>(null);
  // A tap on a footer button can collapse the selection before its click
  // fires (touch browsers clear a field's selection on the tap), so read it
  // at pointerdown.
  // Only that press's click may use it: a press that never became a click
  // (the finger slid off) must not hand its selection to a later keyboard or
  // screen-reader activation, which has no pointerdown of its own.
  const pressSelectionRef = useRef<{ text: string | null; at: number } | null>(null);
  // A quote focuses the composer, so the drawer mustn't hand focus back.
  const quotedRef = useRef(false);
  // Where Touch to Search exists (Chrome on Android), the text field is
  // editable to the browser but its text never changes: Chrome raises its
  // bar over the sheet's footer for a selection in page text or in a
  // read-only field (Blink's HitTestResult::IsContentEditable is false for a
  // readonly textarea), and not for one in an editable field. No keyboard
  // (inputMode none), edits blocked. Everywhere else the field is plainly
  // read-only: an editable one would get the editing menu (iOS: Cut / Paste /
  // Replace…), whose edits do nothing.
  const lockedEditable = hasTouchToSearch(typeof navigator === "undefined" ? undefined : navigator);

  const attachText = useCallback((field: HTMLTextAreaElement | null) => {
    if (!field) return;
    textRef.current = field;
    const unblock = lockedEditable ? blockEdits(field) : undefined;
    return () => {
      unblock?.();
      textRef.current = null;
    };
  }, [lockedEditable]);

  // Fit when the text changes, and again once the sheet has opened (a
  // measure taken mid-mount can read 0).
  useLayoutEffect(() => fitToText(textRef.current), [markdown]);

  const takeSelection = useCallback(() => {
    const press = pressSelectionRef.current;
    pressSelectionRef.current = null;
    if (press && Date.now() - press.at < PRESS_CLICK_WINDOW_MS) return press.text;
    return selectedTextIn(textRef.current);
  }, []);

  const handleFooterPointerDown = useCallback(() => {
    pressSelectionRef.current = { text: selectedTextIn(textRef.current), at: Date.now() };
  }, []);

  const copySource = useCallback(() => takeSelection() || markdown, [markdown, takeSelection]);

  // Sent from the tap itself, not once the sheet has closed: the composer
  // focuses as it takes the quote, and iOS only raises the keyboard for a
  // focus inside the tap.
  const handleQuote = useCallback(() => {
    // A second tap while the sheet slides out mustn't quote again.
    if (quotedRef.current) return;
    quotedRef.current = emitSelectedTextQuote(quoteChannelId, takeSelection() || markdown);
    onClose();
  }, [markdown, onClose, quoteChannelId, takeSelection]);

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    if (!nextOpen) onClose();
  }, [onClose]);

  const handleOpenChangeComplete = useCallback((nextOpen: boolean) => {
    if (nextOpen) {
      // Reset on open, not on close: the focus return reads finalFocus as
      // the sheet unmounts, after this close callback.
      quotedRef.current = false;
      fitToText(textRef.current);
      return;
    }
    onClosed();
  }, [onClosed]);

  // After a quote the composer has focus; otherwise focus goes back as usual.
  const finalFocus = useCallback(() => !quotedRef.current, []);

  return (
    <Drawer open={open} onOpenChange={handleOpenChange} onOpenChangeComplete={handleOpenChangeComplete}>
      <DrawerContent finalFocus={finalFocus} data-message-select-text="true">
        <DrawerHeader>
          {/* Title and × on one row, as in the mockup; raft-ui's bottom-sheet
              header stacks its children. The × keeps its hit area but not its
              height, so the hint stays under the title. */}
          <div className="flex items-center justify-between gap-2">
            <DrawerTitle>{formatMessage({ id: "message.messageItem.selectText" })}</DrawerTitle>
            <DrawerClose className="-my-2" aria-label={formatMessage({ id: "common.close" })} />
          </div>
          <DrawerDescription id={hintId}>{formatMessage({ id: "message.messageItem.selectTextHint" })}</DrawerDescription>
        </DrawerHeader>
        {/* The body is a raft-ui ScrollArea (DrawerBody's padding on it),
            the sender line and the text a column in its content. The text
            is the focus target and scrolls itself: the body is no tab stop. */}
        <DrawerBody render={<ScrollArea tabIndex={-1} contentClassName="flex flex-col gap-1" />} className="min-h-0">
          <p className="m-0 text-footnote text-foreground-muted">
            {senderName} · {time}
          </p>
          {/* raft-ui ScrollAreaTextarea: the native textarea with the overlay
              scrollbar of the other scroll areas, in a wrapper that holds both. */}
          <ScrollAreaTextarea
            ref={attachText}
            data-message-select-text-body="true"
            aria-label={formatMessage({ id: "message.messageItem.selectTextBody" }, { sender: senderName })}
            aria-describedby={hintId}
            readOnly={!lockedEditable}
            inputMode={lockedEditable ? "none" : undefined}
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            value={markdown}
            onChange={keepText}
            // Sized to the text up to half the screen, then it scrolls itself (ScrollAreaTextarea
            // gives it its overflow).
            className="m-0 block max-h-[50dvh] w-full resize-none field-sizing-content rounded-control border-0 bg-transparent p-0 text-body text-foreground wrap-break-word whitespace-pre-wrap outline-none transition-shadow duration-90 ease-out select-text [-webkit-touch-callout:default] focus-visible:shadow-focus"
          />
        </DrawerBody>
        <DrawerFooter onPointerDownCapture={handleFooterPointerDown}>
          {/* Side by side, not stacked: two short words, and more room for the text. */}
          <DrawerActions className="flex-row *:flex-1">
            <CopyButton text={copySource} resetKey={markdown}>
              {({ copied, disabled, onClick, onMouseDown }) => (
                <Button variant="outline" size="lg" disabled={disabled} onClick={onClick} onMouseDown={onMouseDown}>
                  {copied ? <Check /> : <Copy />}
                  {formatMessage({ id: copied ? "message.selectionShortcut.copied" : "message.selectionShortcut.copy" })}
                </Button>
              )}
            </CopyButton>
            <Button variant="outline" size="lg" onClick={handleQuote}>
              <TextQuote />
              {formatMessage({ id: "message.selectionShortcut.quote" })}
            </Button>
          </DrawerActions>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
