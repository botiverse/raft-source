/**
 * Raft Design System › Alignment › The ends of a header
 * (raft-design design/foundations/alignment.md#the-ends-of-a-header): the
 * icon buttons at the two ends of a header put their icon box, not the button,
 * on the column's content margin (16px on a phone, 20px from 768px and in a
 * dialog), at every button size. The rest of the button is empty, so its hit
 * area hangs outward past the margin; the two ends mirror.
 *
 * A raft-ui head (PanelHeader, ThreadPanelHeader, DrawerHeader, DialogHeader,
 * LightboxToolbar, ...) places its own edge buttons. These pulls are for the
 * bars and dialog cards slock draws itself: pad the bar by its margin, then
 * pull its first / last frameless icon button out by the button's icon inset,
 * (button - icon) / 2. Never write the pull as a nudge to a number you measured.
 */

/** The icon inset of a 32px icon button with an 18px icon (raft-ui Button `icon-md`). */
export const ICON_SM_START_PULL = "-ml-[calc((32px-18px)/2)]";
export const ICON_SM_END_PULL = "-mr-[calc((32px-18px)/2)]";

/**
 * The icon inset of a control-height icon button (raft-ui PanelAction, Button
 * `icon-lg`): 7px with a mouse, 11px on a phone and a touch screen. It reads
 * the control tokens, so it follows them wherever they switch.
 */
export const CONTROL_START_PULL = "-ml-[calc((var(--control-height)-var(--control-icon-size))/2)]";
export const CONTROL_END_PULL = "-mr-[calc((var(--control-height)-var(--control-icon-size))/2)]";

/**
 * A 32px `icon-md` button drawn as a bar button with a mouse on a desktop
 * (raft-ui `barButtonDesktop`, the DialogClose and PanelAction metrics):
 * 28px (`bar-button-size`) at `bar-button-radius` (6px), keeping a 44px hit
 * area through its ::after. A phone and a touch screen keep the 32px button.
 */
export const BAR_BUTTON_DESKTOP =
  "md:pointer-fine:size-(--bar-button-size) md:pointer-fine:rounded-(--bar-button-radius) md:pointer-fine:after:-inset-[calc((var(--control-height)+2*var(--control-hit-inset)-var(--bar-button-size))/2+1.5px)]";

/** ICON_SM_END_PULL for a button that is a bar button with a mouse (BAR_BUTTON_DESKTOP): 7px, 5px on a desktop. */
export const ICON_BAR_END_PULL = `${ICON_SM_END_PULL} md:pointer-fine:-mr-[calc((var(--bar-button-size)-18px)/2)]`;
