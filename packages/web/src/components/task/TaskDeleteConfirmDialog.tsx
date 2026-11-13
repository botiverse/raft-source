import { useCallback, useId, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { OctagonAlert, TriangleAlert } from "lucide-react";
import {
  Banner,
  BannerDescription,
  Button,
  Dialog,
  DialogBody,
  DialogClose,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@botiverse/raft-ui";

import { NarrowDialogContent } from "../ui/NarrowDialog";

/**
 * Deleting tasks asks first (Raft DS › Feedback › Confirming: deletes are
 * confirmed): a `size="sm"` Dialog, not an AlertDialog (Raft Chat keeps those
 * for two other confirmations). What can't be undone is in a red banner, and
 * the red confirm button keeps its object (Delete task). The button shows
 * `loading` while the delete runs; a delete that fails says so in an orange
 * banner here and the dialog stays open, to try again (Feedback › Errors, by
 * scope). Used by the task dialog's Delete task and the Tasks page's batch
 * Delete.
 */
export function TaskDeleteConfirmDialog({ open, onOpenChange, title, count, confirmLabel, onConfirm, testId }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The question: Delete task #25? */
  title: string;
  /** How many tasks it deletes, for the banner's wording. */
  count: number;
  /** The red button: the verb with its object (Delete task). */
  confirmLabel: string;
  /** Deletes. Resolves to null once done (the caller closes the dialog), or
   *  to the sentence that says what went wrong, shown in the dialog. */
  onConfirm: () => Promise<string | null>;
  /** On the card; `${testId}-action` on the red button, `${testId}-error` on a failure. */
  testId: string;
}) {
  const { formatMessage } = useIntl();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const consequenceId = useId();

  const changeOpen = useCallback((next: boolean) => {
    // Nothing closes it while the delete runs.
    if (!next && busy) return;
    if (!next) setError(null);
    onOpenChange(next);
  }, [busy, onOpenChange]);
  const cancel = useCallback(() => changeOpen(false), [changeOpen]);

  const run = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setError(await onConfirm());
    } finally {
      setBusy(false);
    }
  }, [onConfirm]);
  const confirm = useCallback(() => void run(), [run]);

  const closeLabel = formatMessage({ id: "common.confirm.closeDialog" });
  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <NarrowDialogContent
        narrow="centered"
        size="sm"
        initialFocus={cancelRef}
        title={title}
        closeLabel={closeLabel}
        closeDisabled={busy}
        header={(
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogClose disabled={busy} aria-label={closeLabel} />
          </DialogHeader>
        )}
        aria-describedby={consequenceId}
        aria-busy={busy}
        testId={testId}
      >
        <DialogBody className="grid gap-3 font-normal">
          {/* role="note": the title is what is announced; the consequence is its description, not an alert. */}
          <Banner status="destructive" size="sm" role="note">
            <OctagonAlert aria-hidden />
            <BannerDescription id={consequenceId}>
              {formatMessage({ id: "task.delete.confirmBody" }, { count })}
            </BannerDescription>
          </Banner>
          {error === null ? null : (
            <Banner status="warning" size="sm" role="alert" data-testid={`${testId}-error`}>
              <TriangleAlert aria-hidden />
              <BannerDescription>{error}</BannerDescription>
            </Banner>
          )}
        </DialogBody>
        <DialogFooter>
          <Button ref={cancelRef} variant="ghost" size="lg" disabled={busy} onClick={cancel}>
            {formatMessage({ id: "common.confirm.cancel" })}
          </Button>
          <Button
            variant="danger"
            size="lg"
            loading={busy}
            loadingLabel={formatMessage({ id: "common.confirm.processing" })}
            onClick={confirm}
            data-testid={`${testId}-action`}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </NarrowDialogContent>
    </Dialog>
  );
}
