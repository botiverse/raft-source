// The form a `feedback:submit` card's button opens (Raft Design System,
// MessageActionCard "Review": the card is a summary, its primary button opens
// the ordinary form prefilled). It has the in-app feedback form's fields — the
// Idea / Problem choice and the message — prefilled with the agent's draft,
// and sends it (sendFeedbackCard) as the person who sends it. The server
// completes the card from the Hands receipt.
//
// Shared by the app's dialog (components/actions/FeedbackCardDialog.tsx) and
// the mobile feedback page (standalone/actionCard.tsx). The page may import
// only src/feedback/** and has no react-intl, so this uses raft-ui alone and
// takes its copy as a function. Each caller lays the fields and the submit
// button out in its own frame, around a <form> given `handleSubmit`.

import { useCallback, useId, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import {
  Banner,
  Button,
  Field,
  FieldLabel,
  SegmentedControl,
  SegmentedControlItem,
  SegmentedControlLabel,
  Textarea,
  TextareaCounter,
} from "@botiverse/raft-ui";
import type { ButtonProps } from "@botiverse/raft-ui";
// The zod-free leaf: the standalone page's bundle must not pull the schemas in.
import { FEEDBACK_SUBMIT_MESSAGE_MAX_LENGTH } from "@botiverse/raft-shared/src/feedbackSubmit";
import type { FeedbackSubmitType } from "@botiverse/raft-shared/src/feedbackSubmit";
import type { FeedbackCardCompletion } from "./agentFeedbackCard";
import type { FeedbackCardCopy, FeedbackCardCopyId } from "./feedbackCardCopy";

/** Server refusal codes with their own copy; `terminal` ones can't succeed on a retry. */
const SEND_REFUSALS: Record<string, { id: FeedbackCardCopyId; terminal: boolean }> = {
  STATE_MISMATCH: { id: "actionCard.feedback.error.alreadySent", terminal: true },
  feedback_card_already_sent: { id: "actionCard.feedback.error.alreadySent", terminal: true },
  NOT_FEEDBACK_CARD: { id: "actionCard.feedback.error.unavailable", terminal: true },
  FEATURE_DISABLED: { id: "actionCard.feedback.error.unavailable", terminal: true },
  NOT_A_MEMBER: { id: "actionCard.feedback.error.notAllowed", terminal: true },
  CONFIRMATION_VERSION_MISMATCH: { id: "actionCard.feedback.error.changed", terminal: true },
  action_card_reconfirmation_required: { id: "actionCard.feedback.error.changed", terminal: true },
  CONFIRMATION_VERSION_REQUIRED: { id: "actionCard.feedback.error.changed", terminal: true },
  action_card_conversion_frozen: { id: "actionCard.feedback.error.changed", terminal: true },
};

/** What the person sends: their (possibly edited) draft. */
export type FeedbackCardSubmission = { type: FeedbackSubmitType; message: string; submissionId: string };

/** A sent card: the ticket when Hands named it, and the card when the server could complete it. */
export type FeedbackCardSent = { ticketId: string | null; actionCard: FeedbackCardCompletion | null };

export type FeedbackCardFormState = ReturnType<typeof useFeedbackCardForm>;

export function useFeedbackCardForm({
  prefilledType,
  prefilledMessage,
  copy,
  send,
  onSubmitted,
  onSubmitStart,
  onSubmitError,
}: {
  /** The agent's draft, editable here. */
  prefilledType: FeedbackSubmitType;
  prefilledMessage: string;
  copy: FeedbackCardCopy;
  send: (submission: FeedbackCardSubmission) => Promise<{ id: string; actionCard: FeedbackCardCompletion | null }>;
  onSubmitted: (sent: FeedbackCardSent) => void;
  onSubmitStart?: () => void;
  onSubmitError?: (error: unknown) => void;
}) {
  // oxlint-disable-next-line react-doctor/no-derived-useState -- the form mounts per open and snapshots the agent's draft; the person's edits must not be overwritten.
  const [feedbackType, setFeedbackType] = useState<FeedbackSubmitType>(prefilledType);
  // oxlint-disable-next-line react-doctor/no-derived-useState -- same per-open draft snapshot as the type above.
  const [message, setMessage] = useState(prefilledMessage);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A refusal no retry can fix (already sent, card changed, turned off).
  const [blocked, setBlocked] = useState(false);
  // One id per form: a retry after a lost response files no second ticket.
  const [submissionId] = useState(() => crypto.randomUUID());
  const trimmedLength = message.trim().length;
  const tooLong = trimmedLength > FEEDBACK_SUBMIT_MESSAGE_MAX_LENGTH;
  const canSend = trimmedLength > 0 && !tooLong && !sending && !blocked;

  const handleMessageChange = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => {
    setMessage(event.target.value);
  }, []);

  const handleSubmit = useCallback((event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSend) return;
    setSending(true);
    setError(null);
    onSubmitStart?.();
    send({ type: feedbackType, message: message.trim(), submissionId })
      .then((out) => onSubmitted({ ticketId: out.id, actionCard: out.actionCard }))
      .catch((err: unknown) => {
        const data = (err as { response?: { data?: { code?: unknown; action_card?: { message_id: string; metadata: FeedbackCardCompletion["metadata"] } } } } | null)?.response?.data;
        // Hands already had this person's feedback for this card: the server
        // completed the card, so this is done rather than an error.
        if (data?.code === "feedback_card_already_sent" && data.action_card) {
          onSubmitted({ ticketId: null, actionCard: { messageId: data.action_card.message_id, metadata: data.action_card.metadata } });
          return;
        }
        onSubmitError?.(err);
        const code = data?.code;
        const refusal = typeof code === "string" ? SEND_REFUSALS[code] : undefined;
        setError(copy(refusal?.id ?? "actionCard.feedback.sendFailed"));
        if (refusal?.terminal) setBlocked(true);
        setSending(false);
      });
  }, [canSend, copy, feedbackType, message, onSubmitError, onSubmitStart, onSubmitted, send, submissionId]);

  return { feedbackType, setFeedbackType, message, handleMessageChange, tooLong, sending, canSend, error, handleSubmit };
}

/** The type choice, the message with its counter, and a refusal, if any. */
export function FeedbackCardFields({ form, copy }: { form: FeedbackCardFormState; copy: FeedbackCardCopy }) {
  const messageFieldId = useId();
  const counterId = useId();
  return (
    <>
      {/* Labelled by aria-label, as on the in-app form: inside a Field the
          Field label would name each option instead of the group. */}
      <SegmentedControl<FeedbackSubmitType>
        value={form.feedbackType}
        onValueChange={form.setFeedbackType}
        aria-label={copy("actionCard.field.feedbackType")}
        disabled={form.sending}
      >
        <SegmentedControlItem value="idea">
          <SegmentedControlLabel>{copy("actionCard.feedbackType.idea")}</SegmentedControlLabel>
        </SegmentedControlItem>
        <SegmentedControlItem value="problem">
          <SegmentedControlLabel>{copy("actionCard.feedbackType.problem")}</SegmentedControlLabel>
        </SegmentedControlItem>
      </SegmentedControl>
      <Field>
        <FieldLabel size="md" htmlFor={messageFieldId}>{copy("actionCard.field.feedback")}</FieldLabel>
        <Textarea
          id={messageFieldId}
          className="w-full resize-y"
          rows={6}
          value={form.message}
          onChange={form.handleMessageChange}
          readOnly={form.sending}
          aria-invalid={form.tooLong ? true : undefined}
          aria-describedby={counterId}
        />
        <div className="flex justify-end">
          <TextareaCounter id={counterId} value={form.message.trim()} limit={FEEDBACK_SUBMIT_MESSAGE_MAX_LENGTH} />
        </div>
      </Field>
      {form.error ? <Banner status="warning" size="sm" role="alert">{form.error}</Banner> : null}
    </>
  );
}

export function FeedbackCardSubmitButton({
  form,
  copy,
  ...buttonProps
}: { form: FeedbackCardFormState; copy: FeedbackCardCopy } & Pick<ButtonProps, "size">) {
  return (
    <Button type="submit" variant="primary" size="lg" {...buttonProps} loading={form.sending} disabled={!form.canSend}>
      {copy("actionCard.feedback.submit")}
    </Button>
  );
}
