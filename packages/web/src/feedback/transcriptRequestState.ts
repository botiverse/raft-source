// task #1228 ①: what the Report Issue dialog may say about the session-record
// request.
// - `pending`, `requested`, `request_failed`, `request_unconfirmed` are about
//   the browser's own request and claim nothing about the record: the browser
//   only learns the HTTP result of that request, and the server answers 202
//   before the agent's computer does anything.
// - `attached` and `not_attached` say what the agent's computer answered.
//   They never come from the HTTP request: the server pushes the answer on
//   the socket (`feedback_report:session_record`, shared
//   feedbackReportSessionRecord.ts) when the computer gives a typed one. No
//   push means nothing is known, and the request state stays: `requested` is
//   also where the dialog rests when no answer ever comes (an older computer,
//   a collection that timed out, a socket that was down).

import { isFeedbackSessionRecordAnswer } from "@botiverse/raft-shared";
import type { FeedbackReportSessionRecordEvent, FeedbackSessionRecordAnswer } from "@botiverse/raft-shared";

export type TranscriptRequestState =
  | "pending"
  | "requested"
  | "request_failed"
  | "request_unconfirmed"
  | FeedbackSessionRecordAnswer;

/** Measured from the START of the request; the report never waits on it. */
export const TRANSCRIPT_REQUEST_CONFIRM_CAP_MS = 10_000;

function httpStatusOf(err: unknown): number | null {
  const status = (err as { response?: { status?: unknown } } | null)?.response?.status;
  return typeof status === "number" ? status : null;
}

/**
 * Start the request now and report its state. `pending` immediately; after
 * the cap without an answer, `request_unconfirmed`; a later answer still
 * updates the state. `settled` resolves with the final state and NEVER rejects
 * (a synchronous throw from `send` included), so no unhandled rejection can
 * come from here.
 */
export function startTranscriptRequest(
  send: () => Promise<unknown>,
  onState: (state: TranscriptRequestState) => void,
  capMs: number = TRANSCRIPT_REQUEST_CONFIRM_CAP_MS,
): { settled: Promise<TranscriptRequestState> } {
  onState("pending");
  let answered = false;
  const timer = setTimeout(() => {
    if (!answered) onState("request_unconfirmed");
  }, capMs);
  // `send` runs synchronously so the request starts before anything the
  // caller does next (e.g. filing the ticket); a synchronous throw becomes a
  // rejection like any other failure.
  let sent: Promise<unknown>;
  try {
    sent = Promise.resolve(send());
  } catch (err) {
    sent = Promise.reject(err);
  }
  const settled = sent
    .then(
      (): TranscriptRequestState => "requested",
      // An HTTP status means the server answered non-2xx; no status means the
      // answer never arrived (network, aborted) and the outcome is unknown.
      (err: unknown): TranscriptRequestState => (httpStatusOf(err) !== null ? "request_failed" : "request_unconfirmed"),
    )
    .then((state) => {
      answered = true;
      clearTimeout(timer);
      onState(state);
      return state;
    });
  return { settled };
}

/**
 * The answer a `feedback_report:session_record` push carries for the report
 * whose session record this dialog requested. Null for another report, for no
 * requested report, and for a payload that is not one of the known answers.
 */
export function sessionRecordAnswerFor(
  payload: Partial<FeedbackReportSessionRecordEvent> | null | undefined,
  requestedReportId: string | null,
): FeedbackSessionRecordAnswer | null {
  if (!requestedReportId || payload?.feedbackReportId !== requestedReportId) return null;
  return isFeedbackSessionRecordAnswer(payload.sessionRecord) ? payload.sessionRecord : null;
}

/**
 * The state after `incoming` arrives. An answer from the agent's computer is
 * final: the push can arrive before the browser has processed its own
 * request's 202 (or before the cap fires), and a request state that comes
 * after it must not replace it.
 */
export function nextTranscriptRequestState(
  current: TranscriptRequestState | null,
  incoming: TranscriptRequestState,
): TranscriptRequestState {
  return isFeedbackSessionRecordAnswer(current) && !isFeedbackSessionRecordAnswer(incoming) ? current : incoming;
}
