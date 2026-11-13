import { TIMELINE_ROW_INSET, TIMELINE_START_ABOVE_ROW } from "../../components/message/composerHost";

// The origin message sits on the paper with a content hairline under it
// (Raft Design System › Panel: thread origin). On the timeline rhythm its
// first line sits a section step under the panel's head (the row brings its
// own lead) and its last line a section step above the hairline, which is a
// boundary like a date line. The top also holds raft-ui's hover toolbar,
// which rides 18px above a message's highlight; less and the scroller clips
// it under the head.
export const THREAD_PANEL_PARENT_CLASS_NAME = `border-b border-line-hairline bg-layer-canvas ${TIMELINE_ROW_INSET} ${TIMELINE_START_ABOVE_ROW} pb-timeline-end`;
export const THREAD_CHROME_LAYER_CLASS_NAME = "relative z-chrome shrink-0";
// The thread header is the shared paper PanelHeader (its seam comes from the
// recipe); the container only joins the chrome z-stack layer.
export const THREAD_HEADER_CONTAINER_CLASS_NAME = THREAD_CHROME_LAYER_CLASS_NAME;
// Thread header subtitle: where the thread lives, then how many replies.
export const THREAD_HEADER_SUBTITLE_CLASS_NAME = "truncate";
// Back acts on finger lift (raft-ui 0.38, DS Navigation › Switching on finger
// lift; task #proj-raft-ui:#168): a tap that stops the replies' momentum
// scroll still goes back, on the first try.
export const THREAD_MOBILE_BACK_PROPS = { "data-testid": "thread-mobile-back", activateOnTouchEnd: true } as const;
export const THREAD_CHROME_CONTAINER_PROPS = { className: THREAD_HEADER_CONTAINER_CLASS_NAME } as const;
