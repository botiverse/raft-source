/**
 * A borderless button on the frame (the top bar, like the rail): on-frame ink
 * and the frame's pressed wash for hover, press and an open menu. Frame items
 * use raft-ui Button `variant="on-frame"`; this is left only for the workspace
 * strip's avatar buttons, which keep Button `icon-md` (32px by touch, 34 with a
 * mouse), because on the frame raft-ui makes every icon size the frame item.
 */
export const ON_FRAME_GHOST_BUTTON =
  "text-foreground-on-frame hover:bg-fill-frame-medium active:bg-fill-frame-medium aria-expanded:bg-fill-frame-medium";
