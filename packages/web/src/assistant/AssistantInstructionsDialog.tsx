import { useCallback, useId, useRef, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import { useIntl } from "react-intl";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogBody,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Banner,
  Button,
  Dialog,
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  FieldError,
  Textarea,
  TextareaCounter,
} from "@botiverse/raft-ui";
import { DialogActions, DialogCommit, NarrowDialogContent } from "../components/ui/NarrowDialog";
import {
  ASSISTANT_OWNER_NOTES_MAX_LENGTH,
  AssistantOwnerNotesTooLongError,
  saveAssistantOwnerNotes,
} from "./assistantClient";

/** The counter shows from here on (DS Textarea: a counter for a limit; shown near it). */
const COUNTER_FROM = Math.floor(ASSISTANT_OWNER_NOTES_MAX_LENGTH * 0.9);

type SaveError = "tooLong" | "failed" | null;

/**
 * Extra Instructions (RFC 077, #10762): the owner's own notes for their
 * assistant, sent after Raft's fixed instructions. Only the owner can read or
 * change them. Mounted per opening (keyed by its parent), so the draft starts
 * from the saved notes. Save is not optimistic: the dialog stays with the
 * draft until the server answers, closes on success, and shows a failure as an
 * orange banner inside it (DS Feedback). Closing with unsaved edits asks first,
 * as Edit Profile does (DS Overlays: discarding unsaved edits is an
 * AlertDialog).
 */
export default function AssistantInstructionsDialog({
  open,
  name,
  savedNotes,
  onDone,
}: {
  open: boolean;
  name: string;
  /** The saved notes, `""` for none. */
  savedNotes: string;
  onDone: () => void;
}) {
  const { formatMessage } = useIntl();
  const ids = { title: useId(), description: useId(), counter: useId(), error: useId() };
  // oxlint-disable-next-line react-doctor/no-derived-useState -- the dialog mounts per opening and snapshots the saved notes as the draft; the owner's edits must not be overwritten.
  const [draft, setDraft] = useState(savedNotes);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<SaveError>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const fieldRef = useRef<HTMLTextAreaElement>(null);

  const trimmedLength = draft.trim().length;
  const tooLong = trimmedLength > ASSISTANT_OWNER_NOTES_MAX_LENGTH;
  const dirty = draft.trim() !== savedNotes.trim();
  const title = formatMessage({ id: "assistant.settings.instructions" });
  const limitMessage = formatMessage(
    { id: "assistant.instructions.tooLong" },
    { max: ASSISTANT_OWNER_NOTES_MAX_LENGTH },
  );

  const requestClose = useCallback(() => {
    if (saving) return;
    if (dirty) setConfirmDiscard(true);
    else onDone();
  }, [dirty, onDone, saving]);
  const handleOpenChange = useCallback((next: boolean) => {
    if (!next) requestClose();
  }, [requestClose]);
  const handleChange = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => {
    setDraft(event.target.value);
    setSaveError(null);
  }, []);
  const handleSubmit = useCallback((event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!dirty || tooLong || saving) return;
    setSaving(true);
    setSaveError(null);
    saveAssistantOwnerNotes(draft).then(onDone, (error: unknown) => {
      setSaveError(error instanceof AssistantOwnerNotesTooLongError ? "tooLong" : "failed");
    }).finally(() => setSaving(false));
  }, [dirty, draft, onDone, saving, tooLong]);
  const handleDiscardOpenChange = useCallback((next: boolean) => {
    if (!next) setConfirmDiscard(false);
  }, []);
  const handleDiscard = useCallback(() => {
    setConfirmDiscard(false);
    onDone();
  }, [onDone]);

  const showCounter = trimmedLength >= COUNTER_FROM;
  // The dialog's description already describes the dialog; the field adds
  // only what changes as the owner types.
  const describedBy = [tooLong ? ids.error : null, showCounter ? ids.counter : null].filter(Boolean).join(" ") || undefined;

  return (
    <>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <NarrowDialogContent
          // A description, a tall textarea and the buttons don't fit above the
          // keyboard on a small phone: the sheet, like the feedback card.
          narrow="sheet"
          className="max-w-lg"
          aria-labelledby={ids.title}
          data-testid="assistant-instructions-dialog"
          title={title}
          titleId={ids.title}
          closeLabel={formatMessage({ id: "common.close" })}
          closeDisabled={saving}
          header={null}
        >
          <form onSubmit={handleSubmit} noValidate>
            <DialogActions as={DialogHeader}>
              <DialogTitle id={ids.title}>{title}</DialogTitle>
            </DialogActions>
            <DialogBody className="grid gap-4">
              <DialogDescription id={ids.description} data-testid="assistant-instructions-description">
                {formatMessage({ id: "assistant.instructions.description" }, { name })}
              </DialogDescription>
              <Field invalid={tooLong}>
                {/* Named by the dialog's title: one field, and the title says what it is. */}
                <Textarea
                  ref={fieldRef}
                  rows={8}
                  value={draft}
                  onChange={handleChange}
                  readOnly={saving}
                  autoFocus
                  placeholder={formatMessage({ id: "assistant.instructions.placeholder" })}
                  aria-labelledby={ids.title}
                  aria-describedby={describedBy}
                  data-invalid={tooLong || undefined}
                  data-testid="assistant-instructions-input"
                />
                {tooLong || showCounter ? (
                  <div className="flex items-start justify-between gap-3">
                    {tooLong ? (
                      <FieldError match id={ids.error} data-testid="assistant-instructions-too-long">{limitMessage}</FieldError>
                    ) : <span />}
                    {showCounter ? (
                      <TextareaCounter
                        id={ids.counter}
                        value={draft.trim()}
                        limit={ASSISTANT_OWNER_NOTES_MAX_LENGTH}
                        data-testid="assistant-instructions-counter"
                      />
                    ) : null}
                  </div>
                ) : null}
              </Field>
              {saveError ? (
                <Banner status="warning" size="sm" role="alert" data-testid="assistant-instructions-error">
                  {saveError === "tooLong" ? limitMessage : formatMessage({ id: "assistant.instructions.saveFailed" })}
                </Banner>
              ) : null}
            </DialogBody>
            <DialogActions as={DialogFooter}>
              <Button type="button" variant="ghost" size="lg" disabled={saving} onClick={requestClose} data-testid="assistant-instructions-cancel">
                {formatMessage({ id: "assistant.settings.cancel" })}
              </Button>
              <DialogCommit>
                {(inHead) => (
                  <Button
                    type="submit"
                    variant="primary"
                    size={inHead ? "md" : "lg"}
                    loading={saving}
                    disabled={!dirty || tooLong}
                    data-testid="assistant-instructions-save"
                  >
                    {formatMessage({ id: "assistant.instructions.save" })}
                  </Button>
                )}
              </DialogCommit>
            </DialogActions>
          </form>
        </NarrowDialogContent>
      </Dialog>

      <AlertDialog open={confirmDiscard} onOpenChange={handleDiscardOpenChange}>
        {/* Keep Editing returns to the field, not to the menu behind the dialog. */}
        <AlertDialogContent finalFocus={fieldRef} data-testid="assistant-instructions-discard">
          <AlertDialogHeader>
            <AlertDialogTitle>{formatMessage({ id: "message.chatPanel.overflow.unsavedTitle" })}</AlertDialogTitle>
          </AlertDialogHeader>
          <AlertDialogBody>{formatMessage({ id: "agent.detail.editProfile.discardBody" })}</AlertDialogBody>
          <AlertDialogFooter>
            <AlertDialogCancel size="lg" data-testid="assistant-instructions-keep-editing">
              {formatMessage({ id: "message.chatPanel.overflow.keepEditing" })}
            </AlertDialogCancel>
            <AlertDialogAction variant="danger" size="lg" onClick={handleDiscard} data-testid="assistant-instructions-discard-action">
              {formatMessage({ id: "message.chatPanel.overflow.discardChanges" })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
