// Every catalog id a `feedback:submit` card's form (FeedbackCardForm.tsx) and
// the mobile feedback page around it show. The app's dialog reads them through
// react-intl; the standalone page, which has no react-intl, gets them built in
// (vite.feedback.config.ts adds this list to its copy).
// No imports: the feedback build config loads this file.

export const FEEDBACK_CARD_COPY_IDS = [
  "actionCard.feedback.dialogTitle",
  "actionCard.feedback.dialogDescription",
  "actionCard.field.feedbackType",
  "actionCard.feedbackType.idea",
  "actionCard.feedbackType.problem",
  "actionCard.field.feedback",
  "actionCard.feedback.error.alreadySent",
  "actionCard.feedback.error.changed",
  "actionCard.feedback.error.unavailable",
  "actionCard.feedback.error.notAllowed",
  "actionCard.feedback.sendFailed",
  "actionCard.feedback.submit",
  "common.confirm.cancel",
  "common.loading",
] as const;

export type FeedbackCardCopyId = (typeof FEEDBACK_CARD_COPY_IDS)[number];

/** The text for a copy id, in the reader's locale. */
export type FeedbackCardCopy = (id: FeedbackCardCopyId) => string;
