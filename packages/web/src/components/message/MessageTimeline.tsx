// MessageTimeline is the rendering primitive for any chronologically ordered,
// real-time-updated list of messages: channel, DM, thread and public-page
// surfaces all consume it. It is VirtualMessageTimeline (raft-ui VirtualList:
// only the rows near the view are mounted); its contract (props, handle,
// contexts, rows, scroll memory) lives in messageTimelineShared. Import from
// here.
export {
  MessageTimelineKeepMessageVisibleContext,
  MessageTimelinePreserveViewportContext,
  MessageTimelineRowMessageIdContext,
  messageTimelineRowKey,
  recallPersistedScrollMessageId,
} from "./messageTimelineShared";
export type {
  MessageTimelineBoundaryVariant,
  MessageTimelineHandle,
  MessageTimelineLeadingRow,
  MessageTimelineProps,
  MessageTimelineRow,
  MessageTimelineSource,
} from "./messageTimelineShared";
export { default } from "./VirtualMessageTimeline";
