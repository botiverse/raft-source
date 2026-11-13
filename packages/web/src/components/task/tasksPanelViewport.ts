import { LIST_TOOLBAR_AIR_CLASS } from "../ui/listToolbar";

// The Tasks viewport's classes (TasksPanel): a raft-ui ScrollArea and its content.

/** On the phone tab root the filter row is the scroller's first child and
 *  pins under the bar (`sticky top-0`; the content drops its top padding,
 *  `PHONE_ROOT_VIEWPORT_CLASS`) and to the left edge while a board scrolls
 *  sideways. It is as wide as the panel (`100cqw` of `@container/tasks`), so
 *  it can stay at `left-0` of the ScrollArea while the wider board scrolls
 *  under it, and it bleeds over both of the content's side paddings
 *  (`-ml-*` and `-mr-*`), so its margin box is the content box: the content
 *  (`fit-content`, at least the panel's width, in a `both` ScrollArea) is then
 *  exactly as wide as the panel unless the board is wider. A left bleed only
 *  would leave the margin box one padding narrower than the panel and push the
 *  content one padding wider than it (a sideways scroll in List view). The
 *  padding follows the panel's own width (raft-ui 0.23: 16px below 28rem of
 *  `@container/tasks`, 20px from it, e.g. a phone in landscape), so the bleed
 *  does too. Activity's filter row does the same (ThreadsInbox). */
/** The filter row of the status board (TasksPanel, the Tasks page with task
 *  v2 off): its FitToolbar is one line, the filters scrolling in it; with a
 *  fine pointer and 40rem of panel the line makes the header height, 44px with
 *  the seam: the header's air above a control and that less the seam below. */
export const TOOLBAR_CLASS = "md:pointer-fine:@min-[40rem]/tasks:pt-(--header-air) md:pointer-fine:@min-[40rem]/tasks:pb-[calc(var(--header-air)-1px)]";
/** The Tasks page's (TasksPageToolbar): a line of the toolbar over a list, 44px with a mouse and 49px by touch
 *  (LIST_TOOLBAR_AIR_CLASS), at the panel's sides; its FitToolbar decides what gives way. */
export const TASKS_PAGE_TOOLBAR_CLASS = `px-4 @min-md/tasks:px-(--surface-inset) ${LIST_TOOLBAR_AIR_CLASS}`;
export const PHONE_ROOT_TOOLBAR_CLASS = "sticky top-0 left-0 z-chrome -ml-4 -mr-4 mb-4 w-[100cqw] @min-md/tasks:-ml-(--surface-inset) @min-md/tasks:-mr-(--surface-inset)";
export const PHONE_ROOT_VIEWPORT_CLASS = " pt-0";
/** The viewport's frame (raft-ui TasksPanelViewport's, but its padding goes
 *  to the ScrollArea's content so the scrollbars stay at the panel's edges). */
export const VIEWPORT_CLASS = "min-h-0 flex-1 bg-layer-canvas";
export const VIEWPORT_CONTENT_CLASS = "flex min-h-full flex-col px-(--surface-inset) py-4 safe-bottom @max-md/tasks:px-4";
