// The dialog a `feedback:submit` card's button opens: the shared card form
// (feedback/FeedbackCardForm.tsx) in a dialog, sent through the app's api
// client with the desktop facts, like the in-app feedback form.

import { useCallback, useId } from "react";
import { useIntl } from "react-intl";
import {
  Button,
  Dialog,
  DialogBody,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@botiverse/raft-ui";
import type { ActionCardMetadata, FeedbackSubmitType } from "@botiverse/raft-shared";
import api from "../../api/client";
import { sendFeedbackCard } from "../../feedback/agentFeedbackCard";
import { desktopFeedbackMetadata } from "../../feedback/agentIssueTicket";
import { FeedbackCardFields, FeedbackCardSubmitButton, useFeedbackCardForm } from "../../feedback/FeedbackCardForm";
import type { FeedbackCardSent, FeedbackCardSubmission } from "../../feedback/FeedbackCardForm";
import type { FeedbackCardCopyId } from "../../feedback/feedbackCardCopy";
import { DialogActions, DialogCommit, NarrowDialogContent } from "../ui/NarrowDialog";

export function FeedbackCardDialog({
  prefilledType,
  prefilledMessage,
  messageId,
  confirmationVersion,
  onClose,
  onSubmitted,
  onSubmitStart,
  onSubmitError,
}: {
  /** The agent's draft, editable here. */
  prefilledType: FeedbackSubmitType;
  prefilledMessage: string;
  messageId: string;
  confirmationVersion?: number;
  onClose: () => void;
  /** The completed card, when the server could mark it (it also arrives over realtime). */
  onSubmitted: (actionCard: { messageId: string; metadata: ActionCardMetadata } | null) => void;
  onSubmitStart?: () => void;
  onSubmitError?: (error: unknown) => void;
}) {
  const { formatMessage } = useIntl();
  const titleId = useId();
  const copy = useCallback((id: FeedbackCardCopyId) => formatMessage({ id }), [formatMessage]);
  const send = useCallback(async (submission: FeedbackCardSubmission) => sendFeedbackCard(api, {
    ...submission,
    messageId,
    confirmationVersion,
    metadata: await desktopFeedbackMetadata(),
  }), [confirmationVersion, messageId]);
  const handleSent = useCallback((sent: FeedbackCardSent) => onSubmitted(sent.actionCard), [onSubmitted]);
  const form = useFeedbackCardForm({
    prefilledType,
    prefilledMessage,
    copy,
    send,
    onSubmitted: handleSent,
    onSubmitStart,
    onSubmitError,
  });
  const { sending } = form;

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    if (!nextOpen && !sending) onClose();
  }, [onClose, sending]);

  return (
    <Dialog open onOpenChange={handleOpenChange} disablePointerDismissal>
      <NarrowDialogContent
        // A toggle, a tall textarea and a hint: too tall for a raised card above the
        // keyboard on a small phone (iPhone SE), so the sheet.
        narrow="sheet"
        aria-labelledby={titleId}
        render={<form onSubmit={form.handleSubmit} />}
        data-testid="feedback-card-dialog"
        title={formatMessage({ id: "actionCard.feedback.dialogTitle" })}
        titleId={titleId}
        closeLabel={formatMessage({ id: "common.close" })}
        closeDisabled={sending}
        header={(
          <DialogHeader>
            {/* A dialog opened by a button takes that button's label, in sentence case. */}
            <DialogTitle id={titleId}>{formatMessage({ id: "actionCard.feedback.dialogTitle" })}</DialogTitle>
            <DialogClose aria-label={formatMessage({ id: "common.close" })} />
          </DialogHeader>
        )}
      >
        <DialogBody className="grid gap-4">
          <DialogDescription>{formatMessage({ id: "actionCard.feedback.dialogDescription" })}</DialogDescription>
          <FeedbackCardFields form={form} copy={copy} />
        </DialogBody>
        <DialogActions as={DialogFooter}>
          <Button type="button" variant="ghost" size="lg" onClick={onClose} disabled={sending}>
            {formatMessage({ id: "common.confirm.cancel" })}
          </Button>
          <DialogCommit>
            {(inHead) => (
              <FeedbackCardSubmitButton size={inHead ? "md" : "lg"} form={form} copy={copy} />
            )}
          </DialogCommit>
        </DialogActions>
      </NarrowDialogContent>
    </Dialog>
  );
}
