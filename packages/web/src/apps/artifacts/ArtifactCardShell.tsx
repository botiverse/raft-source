import { useId } from "react";
import type { ReactNode } from "react";
import {
  cn,
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  Popover,
  PopoverContent,
} from "@botiverse/raft-ui";
import type { DrawerContentProps, PopoverContentProps } from "@botiverse/raft-ui";

import { SHEET_NOTIFY_CLASS, SheetNotifyContext, useSheetNotify } from "./artifactSheetNotify";

/**
 * What a floating Artifact comment card is drawn on, written once (xxchan, #proj-workspace:
 * "该复用的就好好复用"): a new comment's card however it was started (a selection or a picked
 * block in comment mode, a selection in a file's view, the page's own button), a thread's card,
 * and a draft's view. Before this each of the three had a Popover and a sheet of its own, and they
 * had drifted: two widths for the same new comment's card, its padding twice on a phone.
 *
 * - On a desktop, a raft-ui Popover beside `popover.anchor`, one width for every card (a new
 *   comment's card becomes its thread's card in place once sent, so the two are the same width).
 * - On a phone, a bottom sheet: its title, under it who its box's Send notifies (a touch screen
 *   has no tooltip; names are data, so a line in ink, the sheet's description for assistive tech),
 *   then the card.
 *
 * It draws and nothing else. When it closes is the dismissal layer's (`onOpenChange` is
 * `useDismissable`'s `change`), where it sits and where the focus goes are its caller's, which
 * knows what opened it: `popover` and `sheet` are raft-ui's own props, passed on.
 *
 * Two things about those props (Kirby, on #14254):
 * - They are spread over this shell's defaults, so a key that is there counts even when its value
 *   is `undefined`: `initialFocus: undefined` is Base UI's own default (it moves focus into the
 *   card), not this shell's "no focus". A caller that wants no focus leaves the key out, or says
 *   `false`.
 * - On a phone the sheet is inert exactly while `armed`: `sheet` has no `inert` of its own, where
 *   `popover.inert` can say otherwise on a desktop. A caller that arms for a move (`moveArmed`,
 *   SelectionBox) never moves on a phone, so there the two are the same.
 */
export function ArtifactCardShell({ phone, open, onOpenChange, label, testId, armed, surface = "card", hidden = false, popover, sheet, children }: {
  phone: boolean;
  open: boolean;
  onOpenChange: (open: boolean, details?: { reason?: string; event?: Event }) => void;
  /** The sheet's title, and the popover's name (unless `popover` gives its own). */
  label: string;
  testId: string;
  /** Armed against presses (useArmed): marked, and inert unless `popover.inert` says otherwise. */
  armed: boolean;
  /**
   * What is in it: a card that pads itself (raft-ui's CommentCard: a thread, a draft), one the
   * surface pads (`padded`: a new comment's), or something that is no card and draws its own
   * surface (`none`: the Comment button at a selection, which becomes the card in place).
   */
  surface?: "card" | "padded" | "none";
  /** Not drawn, but kept, words and focus and all (a composer whose selection is out of view). */
  hidden?: boolean;
  popover: Omit<PopoverContentProps, "children" | "className" | "sideOffset">;
  sheet?: Pick<DrawerContentProps, "ref" | "initialFocus" | "onPointerDownCapture">;
  children: ReactNode;
}) {
  const [notify, setNotify] = useSheetNotify();
  const notifyId = useId();
  if (phone) {
    const said = surface === "none" ? null : notify;
    return (
      <Drawer open={open} onOpenChange={onOpenChange}>
        {/* No focus, so no keyboard, until the person taps into the box (co-design S2), unless `sheet` says where. */}
        <DrawerContent
          initialFocus={false}
          {...sheet}
          aria-label={label}
          aria-describedby={said ? notifyId : undefined}
          inert={armed || undefined}
          data-testid={testId}
          data-armed={armed || undefined}
        >
          <DrawerHeader>
            <DrawerTitle>{label}</DrawerTitle>
            {said ? <p id={notifyId} className={SHEET_NOTIFY_CLASS} data-testid="artifact-sheet-notify">{said}</p> : null}
          </DrawerHeader>
          {surface === "none" ? children : <DrawerBody><SheetNotifyContext.Provider value={setNotify}>{children}</SheetNotifyContext.Provider></DrawerBody>}
        </DrawerContent>
      </Drawer>
    );
  }
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverContent
        align="start"
        initialFocus={false}
        aria-label={label}
        inert={armed || undefined}
        {...popover}
        sideOffset={8}
        className={cn(SURFACE[surface], hidden && "invisible")}
        data-testid={testId}
        data-armed={armed || undefined}
        data-hidden={hidden || undefined}
      >
        {children}
      </PopoverContent>
    </Popover>
  );
}

/** One width for every card; never wider than a narrow window leaves it. */
const CARD = "w-[320px] max-w-[calc(100vw-2rem)]";
const SURFACE = {
  card: `${CARD} p-0`,
  padded: `${CARD} p-3`,
  // raft-ui's TextSelectionToolbar is the surface (its docs place it in a PopoverContent by
  // `anchor`, with no surface variant), so the popover draws none of its own.
  none: "min-w-0 overflow-visible bg-transparent shadow-none ring-0",
} as const;
