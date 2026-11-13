import { useCallback, useEffect, useRef, useState } from "react";
import type { ComponentProps, FormEventHandler, ReactNode } from "react";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogFooter,
  DialogHeader,
  DialogNav,
  DialogTitle,
  ScrollArea,
  SidebarItem,
  SidebarItemContent,
  SidebarItemTitle,
} from "@botiverse/raft-ui";
import { DialogActions, NarrowDialogContent, useNarrowPresentation } from "./NarrowDialog";
import type { DialogNarrow } from "./NarrowDialog";

export type FormDialogSection = {
  /** The id of the FormSection it scrolls to (unique in the document). */
  id: string;
  label: ReactNode;
};

/**
 * A bigger form edited in one go, as a wide centred dialog (raft-ui Dialog
 * `size="wide"`): it dims the page and does not animate, like every centred
 * modal. Its anatomy is raft-ui's:
 * - a 56px head with the title and ×, like every other dialog (no sticker
 *   or logo); nothing that commits;
 * - an optional slot under the head for what must stay in view (a form-level
 *   error, a secret shown once);
 * - the body: the section list (DialogNav, sidebar rows; the one you are
 *   reading is the yellow "you are here") beside the scrolling sections
 *   (raft-ui FormSection), the list hidden on a phone;
 * - a footer with the commit: Cancel, then the screen's one pink button.
 *
 * Outside presses do not dismiss it (a half-filled form is not thrown away by
 * a stray click); × / Escape / Cancel do.
 *
 * `narrow="sheet"`: on a phone it is the bottom sheet (NarrowDialog); wrap
 * the footer's commit in DialogCommit and it moves to the head. `top`: the
 * same dialog with its footer, in the upper part of a phone screen.
 */
export function FormDialog({
  title,
  closeLabel,
  onClose,
  onSubmit,
  notice,
  footer,
  sections,
  navLabel,
  children,
  testId,
  bodyTestId,
  navTestId,
  narrow = "centered",
  initialSectionId,
}: {
  title: ReactNode;
  /** aria-label for ×. */
  closeLabel: string;
  onClose: () => void;
  onSubmit: FormEventHandler<HTMLFormElement>;
  /** Kept in view under the head: a form-level error, a value shown once. */
  notice?: ReactNode;
  /** The commit row: Cancel, then the primary action. */
  footer: ReactNode;
  /** The sections, in order, for the section list. */
  sections: readonly FormDialogSection[];
  navLabel: string;
  children: ReactNode;
  testId?: string;
  bodyTestId?: string;
  navTestId?: string;
  /** Phone presentation (< 768px). Default: the centred dialog. */
  narrow?: DialogNarrow;
  /**
   * Opens scrolled to this section, once it is drawn (a form that loads its
   * content first gets there when it arrives). Read on open only.
   */
  initialSectionId?: string;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [current, setCurrent] = useState(sections[0]?.id);
  // On a phone the DialogBody already sits on the 16px margin. The padding
  // is on the ScrollArea's content, so its scrollbar stays at the edge.
  const presentation = useNarrowPresentation(narrow);
  const scrollPadding = presentation ? undefined : "px-(--surface-inset)";

  const handleOpenChange = useCallback<NonNullable<ComponentProps<typeof Dialog>["onOpenChange"]>>(
    (nextOpen) => {
      if (!nextOpen) onClose();
    },
    [onClose],
  );

  const scrollToSection = useCallback((id: string) => {
    setCurrent(id);
    const scroller = scrollRef.current;
    const target = scroller?.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
    if (!scroller || !target) return;
    const top = target.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    scroller.scrollTo?.({ top, behavior: "smooth" });
  }, []);

  const pendingInitialSectionRef = useRef(initialSectionId);
  useEffect(() => {
    const id = pendingInitialSectionRef.current;
    if (!id || !scrollRef.current?.querySelector(`#${CSS.escape(id)}`)) return;
    pendingInitialSectionRef.current = undefined;
    scrollToSection(id);
  });

  // The list follows the reading position: the last section whose top has
  // reached the body's top edge, or the last one once the body is scrolled
  // to its end.
  const syncCurrentFromScroll = useCallback(() => {
    const scroller = scrollRef.current;
    if (!scroller || sections.length === 0) return;
    let next = sections[0]!.id;
    if (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 2) {
      next = sections[sections.length - 1]!.id;
    } else {
      const line = scroller.getBoundingClientRect().top + 16;
      for (const section of sections) {
        const target = scroller.querySelector<HTMLElement>(`#${CSS.escape(section.id)}`);
        if (!target || target.getBoundingClientRect().top > line) break;
        next = section.id;
      }
    }
    setCurrent((previous) => (previous === next ? previous : next));
  }, [sections]);

  return (
    <Dialog open onOpenChange={handleOpenChange} disablePointerDismissal>
      <NarrowDialogContent
        narrow={narrow}
        size="wide"
        render={<form onSubmit={onSubmit} data-testid={testId} />}
        title={title}
        closeLabel={closeLabel}
        header={(
          <DialogHeader bar>
            <DialogTitle className="min-w-0 flex-1 truncate">{title}</DialogTitle>
            <DialogClose aria-label={closeLabel} />
          </DialogHeader>
        )}
      >
        {notice ? <div className="shrink-0 stack-y-2 border-b border-line-hairline px-(--surface-inset) py-3">{notice}</div> : null}
        <DialogBody bar>
          {sections.length > 1 ? (
            <DialogNav aria-label={navLabel} data-testid={navTestId}>
              {sections.map((section) => (
                <FormDialogNavItem
                  key={section.id}
                  section={section}
                  active={current === section.id}
                  onSelect={scrollToSection}
                />
              ))}
            </DialogNav>
          ) : null}
          <ScrollArea
            ref={scrollRef}
            onScroll={syncCurrentFromScroll}
            className="min-w-0 flex-1"
            contentClassName={scrollPadding}
            data-testid={bodyTestId}
          >
            {children}
          </ScrollArea>
        </DialogBody>
        <DialogActions as={DialogFooter} bar data-testid={testId ? `${testId}-footer` : undefined}>{footer}</DialogActions>
      </NarrowDialogContent>
    </Dialog>
  );
}

function FormDialogNavItem({
  section,
  active,
  onSelect,
}: {
  section: FormDialogSection;
  active: boolean;
  onSelect: (id: string) => void;
}) {
  const handleClick = useCallback(() => onSelect(section.id), [onSelect, section.id]);
  return (
    <SidebarItem
      active={active}
      aria-current={active ? "true" : undefined}
      data-form-dialog-section={section.id}
      onClick={handleClick}
    >
      <SidebarItemContent className="items-center">
        <SidebarItemTitle>{section.label}</SidebarItemTitle>
      </SidebarItemContent>
    </SidebarItem>
  );
}
