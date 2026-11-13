import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ComponentProps, ComponentType, HTMLAttributes, ReactElement, ReactNode, RefObject } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cn, DialogClose, DialogContent, DialogFooter, DialogTitle, PanelAction, PanelHeader, PanelHeaderContent, PanelTitle, ScrollArea } from "@botiverse/raft-ui";
import { useMediaQuery } from "../../hooks/effectPrimitives";
import { narrowSurfaceClass, useNarrowKeyboardBox } from "./narrowSheet";
import { keepEscapeTakenInside, useOverlayLayer } from "./useOverlayLayer";

/**
 * How a dialog presents on a phone (< 768px). Desktop and tablet always get
 * the centred card; nothing changes there.
 *
 * - `centered`: the centred card, as on a desktop: a statement and buttons,
 *   a few fixed choices, or one input or textarea (at most beside a simple
 *   toggle). While the on-screen keyboard is open it moves up, under the
 *   phone's top bar, so the keyboard opens below it (raft-ui 0.83 does this
 *   for every centred DialogContent).
 * - `sheet`: a bottom sheet 90% of the screen tall over the scrim (the top of
 *   the page shows dimmed above it) that slides up. Head: × on the left, the
 *   title, the dialog's own commit button at the end (small). No bottom
 *   button row: × is Cancel. For several fields, a pick from a long list,
 *   steps, or a body taller than the screen.
 *
 * Decisions (stdrc, Artea, 2026-10-21) and how to opt in:
 * docs/frontend/narrow-dialogs.md.
 */
export type DialogNarrow = "centered" | "sheet";
/** A presentation that replaces the card (only the sheet today). */
export type NarrowPresentation = "sheet";

/** The web's phone breakpoint (MainLayout, the forward composer, …). */
export const PHONE_MEDIA_QUERY = "(max-width: 767px)";

/** The presentation to draw now: `null` means the centred card. */
export function useNarrowPresentation(narrow: DialogNarrow = "centered"): NarrowPresentation | null {
  const phone = useMediaQuery(PHONE_MEDIA_QUERY);
  return phone && narrow === "sheet" ? "sheet" : null;
}

/** The scrolling body under the head (a raft-ui ScrollArea), and its content
 *  on the phone's 16px margin: the padding is inside, so the scrollbar stays
 *  at the sheet's edge. */
export const NARROW_BODY_CLASS = "min-h-0 flex-1";
const NARROW_BODY_CONTENT_CLASS = "px-4 pt-4 pb-[max(16px,env(safe-area-inset-bottom,0px))]";

type NarrowScope = { presentation: NarrowPresentation | null; slot: HTMLElement | null };
const NO_NARROW_SCOPE: NarrowScope = { presentation: null, slot: null };
const NarrowScopeContext = createContext<NarrowScope>(NO_NARROW_SCOPE);

/** True inside a phone sheet: the bottom button row is hidden. */
function useNarrowSheet() {
  return useContext(NarrowScopeContext).presentation === "sheet";
}

/**
 * The sheet's head and body on a phone. The head is a pushed page's head
 * (raft-ui PanelHeader: 56 tall, white, seam under it, 44px targets, title on
 * the left), with × as its first button and a slot at its end that the
 * dialog's `DialogCommit` moves into.
 * The ends follow the header-edge rule by themselves: PanelHeader pulls the
 * leading icon button's hit area outward so its icon box sits on 16px, and the
 * filled commit button ends on 16px by its edge.
 */
export function NarrowDialogLayout({
  presentation,
  title,
  titleId,
  onClose,
  closeLabel,
  closeDisabled = false,
  closeable = true,
  baseUi = false,
  wrapBody = true,
  testId,
  children,
}: {
  presentation: NarrowPresentation;
  title: ReactNode;
  titleId?: string;
  onClose?: () => void;
  closeLabel: string;
  closeDisabled?: boolean;
  /** A blocking flow (onboarding) has no way out today and gets no ×. */
  closeable?: boolean;
  /** Inside a raft-ui (Base UI) Dialog: the title is its DialogTitle, so it
   *  stays the dialog's name, and × is its DialogClose, the dialog's own
   *  close path (discard checks included), instead of `onClose`. */
  baseUi?: boolean;
  /** Wrap children in the scrolling 16px body. A raft-ui dialog brings its
   *  own DialogBody, so it passes false. */
  wrapBody?: boolean;
  testId?: string;
  children: ReactNode;
}) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const headRef = useRef<HTMLDivElement | null>(null);
  useRevealNewAlerts(headRef);
  const scope = useMemo<NarrowScope>(() => ({ presentation, slot }), [presentation, slot]);
  const icon = <X />;
  const close = !closeable ? null : baseUi ? (
    <DialogClose
      disabled={closeDisabled}
      render={<PanelAction aria-label={closeLabel} data-testid="narrow-dialog-close" />}
    >
      {icon}
    </DialogClose>
  ) : (
    <PanelAction onClick={onClose} disabled={closeDisabled} aria-label={closeLabel} data-testid="narrow-dialog-close">
      {icon}
    </PanelAction>
  );
  return (
    <NarrowScopeContext value={scope}>
      <PanelHeader ref={headRef} render={<header />} data-testid={testId ? `${testId}-narrow-header` : "narrow-dialog-header"}>
        {close}
        <PanelHeaderContent>
          <PanelTitle render={baseUi ? <DialogTitle id={titleId}>{title}</DialogTitle> : <h2 id={titleId}>{title}</h2>} />
        </PanelHeaderContent>
        <div ref={setSlot} className="flex shrink-0 items-center" data-slot="narrow-dialog-commit" />
      </PanelHeader>
      {wrapBody ? (
        <ScrollArea className={NARROW_BODY_CLASS} contentClassName={NARROW_BODY_CONTENT_CLASS} data-testid={testId}>
          {children}
        </ScrollArea>
      ) : children}
    </NarrowScopeContext>
  );
}

/**
 * The commit is at the top of a phone sheet, so an error that a failed
 * commit adds near the bottom of a long form would appear out of sight. A
 * problem added under the head after it opens (an alert, or a raft-ui
 * warning / destructive Banner) is scrolled into view.
 */
const NEW_PROBLEM_SELECTOR = "[role=alert], [data-slot=banner][data-status=warning], [data-slot=banner][data-status=destructive]";
function useRevealNewAlerts(headRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const surface = headRef.current?.parentElement;
    if (!surface || typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue;
          const alert = node.matches(NEW_PROBLEM_SELECTOR) ? node : node.querySelector(NEW_PROBLEM_SELECTOR);
          if (alert) {
            alert.scrollIntoView?.({ block: "nearest" });
            return;
          }
        }
      }
    });
    observer.observe(surface, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [headRef]);
}

/**
 * A dialog's bottom button row (Cancel, then the commit). Unchanged on a
 * desktop; hidden in a phone sheet, where × is Cancel and the
 * commit sits in the head.
 */
export function DialogActions({
  as: Row = "div",
  children,
  ...props
}: HTMLAttributes<HTMLDivElement> & Record<`data-${string}`, string | undefined> & {
  /** The row's element when it is not a plain div: raft-ui's DialogFooter
   *  (or, for a head drawn inside a form, its DialogHeader). */
  as?: "div" | ComponentType<HTMLAttributes<HTMLDivElement> & { bar?: boolean }>;
  bar?: boolean;
}) {
  const sheet = useNarrowSheet();
  return <Row {...props} hidden={sheet || props.hidden || undefined}>{children}</Row>;
}

/**
 * The footer of a dialog card that pads itself by 20px (DialogCard, or a
 * hand-built DialogSurface card): raft-ui's DialogFooter as the card's
 * DialogActions, so it is hidden in a phone sheet the same way. Cancel first
 * (ghost, calling the card's close handler), the commit last (dialog.md,
 * "The footer"). The card pads the dialog already, so the footer adds no
 * padding of its own; it sits one gap of the card's content under it.
 */
export function DialogCardFooter({ className, ...props }: Omit<ComponentProps<typeof DialogActions>, "as">) {
  return <DialogActions as={DialogFooter} className={cn("px-0 pb-0 first:pt-0", className)} {...props} />;
}

/**
 * A Cancel or Close in a row that keeps other buttons on a phone (a wizard's
 * Back): as is on a desktop, gone in a phone's sheet, where × is the way
 * out.
 */
export function DialogCancel({ children }: { children: ReactElement }) {
  const { presentation } = useContext(NarrowScopeContext);
  return presentation ? null : children;
}

/**
 * Marks the dialog's one commit button. Its child is a function of where it
 * is drawn: in the bottom row (`inHead` false: as on a desktop) or, in a phone
 * sheet, at the end of the head (`inHead` true), where it is the
 * same button (variant, label, disabled and loading state) at size `md`:
 *
 *   <DialogCommit>{(inHead) => <Button size={inHead ? "md" : "lg"} …>Save</Button>}</DialogCommit>
 *
 * The head is outside the dialog's form in the DOM, so the moved button is
 * tied back to the form it was written in with the `form` attribute. It is
 * then that form's default button, natively: a click submits it, Enter / Go
 * in any field submits it (implicit submission), and while the button is
 * disabled neither does, exactly as when it sat inside the form.
 */
let unnamedFormCount = 0;

export function DialogCommit({ children }: { children: (inHead: boolean) => ReactNode }) {
  const { slot } = useContext(NarrowScopeContext);
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const portalRef = useRef<HTMLSpanElement | null>(null);
  // Every render: the button the child function draws can be a new element.
  useLayoutEffect(() => {
    const form = anchorRef.current?.closest("form");
    const button = portalRef.current?.querySelector<HTMLButtonElement>("button[type=submit]");
    if (!form || !button || button.form === form) return;
    // A form the caller did not name gets an id React does not manage.
    // (No useId: a hook id here would renumber every desktop id after it.)
    if (!form.id) form.id = `narrow-form-${++unnamedFormCount}`;
    button.setAttribute("form", form.id);
  });
  if (!slot) return children(false);
  return (
    <>
      <span ref={anchorRef} hidden />
      {createPortal(<span ref={portalRef} className="contents">{children(true)}</span>, slot)}
    </>
  );
}

/** Drawn inside the popup, so the layer is pushed only while the dialog is open (Base UI mounts the popup then). */
function OpenOverlayLayer() {
  useOverlayLayer();
  return null;
}

/**
 * raft-ui DialogContent with a phone presentation, for dialogs built on the
 * Base UI Dialog (focus trap, Escape and close stay Base UI's). On a desktop
 * it is `<DialogContent>{header}{children}</DialogContent>`, exactly the
 * dialog as written (raft-ui moves the card up on a phone while the keyboard
 * is open). On a phone `sheet` is the bottom sheet over the dialog's scrim with `header` swapped for the
 * narrow head; the title stays the DialogTitle (the
 * dialog's accessible name) and × is a DialogClose, so it closes the way
 * Escape does, discard checks included. While mounted it is a modal layer
 * of the shortcut registry (useOverlayLayer), and an Esc something inside
 * already took doesn't close it.
 */
/**
 * raft-ui (0.83) lifts a centred DialogContent while the keyboard is open
 * (`data-soft-keyboard`: top under the top bar, a max height). This sheet is a
 * DialogContent too but keeps its own keyboard box (useNarrowKeyboardBox), so
 * it overrides that lift; tailwind-merge drops raft-ui's classes for these.
 */
const NARROW_SHEET_NO_LIFT_CLASS = "data-soft-keyboard:top-auto data-soft-keyboard:max-h-none data-soft-keyboard:translate-none";

export function NarrowDialogContent({
  narrow,
  header,
  title,
  titleId,
  closeLabel,
  closeDisabled,
  closeable,
  wrapBody = false,
  testId,
  className,
  onKeyDown,
  children,
  ...contentProps
}: Omit<ComponentProps<typeof DialogContent>, "title"> & {
  narrow: DialogNarrow;
  /** The desktop head, as the dialog had it. */
  header: ReactNode;
  title: ReactNode;
  /** The DialogTitle's id, when the content names itself with aria-labelledby. */
  titleId?: string;
  closeLabel: string;
  closeDisabled?: boolean;
  closeable?: boolean;
  /** In the sheet, wrap children in the scrolling 16px body (NarrowDialogLayout), for content with no DialogBody of
   *  its own (DialogCard). */
  wrapBody?: boolean;
  /** The card's test id on a desktop; in the sheet, the body's, and `${testId}-narrow-header` on its head. */
  testId?: string;
}) {
  const presentation = useNarrowPresentation(narrow);
  const keyboardBox = useNarrowKeyboardBox(presentation === "sheet");
  const handleKeyDown = useCallback<NonNullable<typeof onKeyDown>>((event) => {
    // Read before the dialog's own onKeyDown: an Esc it marks handled (to keep it from the surface under the dialog)
    // is still the dialog's to close on; only one taken further inside isn't.
    const takenInside = event.defaultPrevented;
    onKeyDown?.(event);
    if (takenInside) keepEscapeTakenInside(event);
  }, [onKeyDown]);
  if (!presentation) {
    return (
      <DialogContent className={className} {...contentProps} {...(testId ? { "data-testid": testId } : null)} onKeyDown={handleKeyDown}>
        {/* A nested card owns its actions; never borrow the parent sheet's slot. */}
        <NarrowScopeContext value={NO_NARROW_SCOPE}>
          <OpenOverlayLayer />
          {header}
          {children}
        </NarrowScopeContext>
      </DialogContent>
    );
  }
  return (
    // The sheet keeps the dialog's scrim above it.
    <DialogContent
      {...contentProps}
      onKeyDown={handleKeyDown}
      className={`${narrowSurfaceClass()} ${NARROW_SHEET_NO_LIFT_CLASS}`}
      style={keyboardBox}
      data-narrow={presentation}
    >
      <NarrowDialogLayout
        presentation={presentation}
        title={title}
        titleId={titleId}
        closeLabel={closeLabel}
        closeDisabled={closeDisabled}
        closeable={closeable}
        baseUi
        wrapBody={wrapBody}
        testId={testId}
      >
        <OpenOverlayLayer />
        {children}
      </NarrowDialogLayout>
    </DialogContent>
  );
}

/** The popup unframed on a desktop: the step inside is the visible card. */
const FRAMED_STEP_POPUP_CLASS = "overflow-visible rounded-none bg-transparent shadow-none ring-0";
/** `scrollsInWindow`: the popup is the whole window, as the old Modal's backdrop was, and raft-ui's centring, size
 *  cap and keyboard lift are off; the card scrolls in it (FRAMED_STEP_SCROLL_*). */
const FRAMED_STEP_WINDOW_CLASS = [
  "inset-0 top-0 left-0 h-full max-h-none w-full max-w-none translate-none",
  "data-soft-keyboard:top-0 data-soft-keyboard:max-h-none data-soft-keyboard:translate-none",
].join(" ");
const FRAMED_STEP_SCROLL_CLASS = "h-full w-full";
const FRAMED_STEP_SCROLL_CONTENT_CLASS = "flex min-h-full w-full p-4";

/**
 * raft-ui DialogContent around content that brings its own framed card (a DialogSurface: onboarding's setup steps,
 * SetupStepFrame in the billing dialogs). On a desktop the popup is unframed and the card inside is what shows;
 * `className` sizes the popup there. On a phone `sheet` is the bottom sheet over the dialog's scrim with the card
 * stretched in it, unframed (narrowSurfaceClass), and the sheet keeps its own keyboard box. As NarrowDialogContent:
 * a modal layer of the shortcut registry while open (⌘K stops under it), and an Esc something inside already took
 * doesn't close it.
 */
export function FramedDialogContent({
  narrow,
  className,
  style,
  onKeyDown,
  scrollsInWindow = false,
  modalLayer = true,
  children,
  ...contentProps
}: ComponentProps<typeof DialogContent> & {
  narrow: DialogNarrow;
  /** On a desktop (and a centred phone card) the popup is the whole window and the card is centred in a scroller, so
   *  a card taller than a short window (a phone in landscape) scrolls instead of spilling off-screen, as it did in the
   *  old Modal's backdrop. For a card with a fixed minimum height (onboarding's setup steps). */
  scrollsInWindow?: boolean;
  /** Push the modal shortcut layer (default). False for a dialog that pushes a layer of its own: the task dialog, a
   *  workspace whose conversation keeps its own commands (TaskDialogShell). */
  modalLayer?: boolean;
}) {
  const presentation = useNarrowPresentation(narrow);
  const keyboardBox = useNarrowKeyboardBox(presentation === "sheet");
  const handleKeyDown = useCallback<NonNullable<typeof onKeyDown>>((event) => {
    const takenInside = event.defaultPrevented;
    onKeyDown?.(event);
    if (takenInside) keepEscapeTakenInside(event);
  }, [onKeyDown]);
  const mergedStyle = useMemo(() => (keyboardBox ? { ...style, ...keyboardBox } : style), [keyboardBox, style]);
  return (
    <DialogContent
      {...contentProps}
      onKeyDown={handleKeyDown}
      className={presentation
        ? `${narrowSurfaceClass()} ${NARROW_SHEET_NO_LIFT_CLASS}`
        : cn(FRAMED_STEP_POPUP_CLASS, scrollsInWindow ? FRAMED_STEP_WINDOW_CLASS : null, className)}
      style={mergedStyle}
      data-narrow={presentation ?? undefined}
    >
      {modalLayer ? <OpenOverlayLayer /> : null}
      {scrollsInWindow && !presentation ? (
        <ScrollArea className={FRAMED_STEP_SCROLL_CLASS} contentClassName={FRAMED_STEP_SCROLL_CONTENT_CLASS} data-testid="framed-dialog-scroller">
          <div className="m-auto flex w-full justify-center">{children}</div>
        </ScrollArea>
      ) : children}
    </DialogContent>
  );
}
