import type { FeedbackSessionRecordAnswer } from "./feedbackTranscriptOutcome";

/**
 * Socket push of what the agent's computer answered about the session record
 * of a feedback report (feedbackTranscriptOutcome.ts,
 * feedbackSessionRecordAnswer). The request that asks for the record answers
 * 202 before the computer does anything, so the answer follows on its own.
 * Sent only to the reporter's own connections (`user:<id>`), once, and only
 * when the computer gave a typed answer: no event means nothing is known.
 * Additive: a client that doesn't know the event ignores it.
 */
export const FEEDBACK_REPORT_SESSION_RECORD_EVENT = "feedback_report:session_record" as const;

/** The whole payload: which report, and the answer. Nothing of the record itself. */
export interface FeedbackReportSessionRecordEvent {
  feedbackReportId: string;
  sessionRecord: FeedbackSessionRecordAnswer;
}
