import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { ArrowUpRight } from "lucide-react";
import {
  Button,
  Dialog,
  DialogBody,
  DialogClose,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  ScrollArea,
} from "@botiverse/raft-ui";
import type { ConfirmRequest } from "@botiverse/porthole";
import { ARM_DELAY_MS } from "@botiverse/porthole/react";
import type { ConfirmActions } from "@botiverse/porthole/react";

import { DialogActions, DialogCommit, NarrowDialogContent } from "../../components/ui/NarrowDialog";
import { confirmWords } from "./artifactConfirmWords";

/** Each request its own dialog: a new one at the head of Porthole's queue starts unarmed, on Cancel. */
const keys = new WeakMap<ConfirmRequest, number>();
let lastKey = 0;
function keyOf(request: ConfirmRequest): number {
  let key = keys.get(request);
  if (key === undefined) {
    lastKey += 1;
    key = lastKey;
    keys.set(request, key);
  }
  return key;
}

interface Props {
  request: ConfirmRequest;
  answer: ConfirmActions;
}

/**
 * Raft's dialog for a framed page's gated call (Porthole's `renderConfirm`, #proj-workspace:#252),
 * in place of Porthole's default: a raft-ui Dialog at `sm`, centered on a phone too (narrow
 * dialogs: a decision), over the app's scrim. Porthole keeps the queue and runs the call inside
 * the accept's click (a link's new tab is the person's).
 *
 * - Title and accept are Porthole's words; the first line says which Artifact asks (Kirby). It is
 *   data, not helper text: in ink, not in DialogDescription, and still the dialog's description
 *   for assistive tech (aria-describedby).
 * - The body is the call's whole effect (artifactConfirmWords), never cut silently: it scrolls
 *   when long, and a detail past Porthole's bounds says only part is shown. A link is its full
 *   address with the host in bold (Jasper: against look-alikes, in place of "It opens <host>.").
 * - Cancel is focused on open; Esc, × and Cancel decline (a scrim press doesn't, as Raft's other
 *   confirms). Accept ignores presses for Porthole's ARM_DELAY_MS after it opens, so a click meant
 *   for the page can't land on it.
 */
export function ArtifactFrameConfirm({ request, answer }: Props) {
  return <FrameConfirmDialog key={keyOf(request)} request={request} answer={answer} />;
}

function FrameConfirmDialog({ request, answer }: Props) {
  const { formatMessage } = useIntl();
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const answered = useRef(false);
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setArmed(true), ARM_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);
  const words = useMemo(() => confirmWords(request, formatMessage), [request, formatMessage]);
  const closeLabel = formatMessage({ id: "common.confirm.closeDialog" });
  const sourceId = useId();

  const decline = useCallback(() => {
    if (answered.current) return;
    answered.current = true;
    answer.decline();
  }, [answer]);
  const accept = useCallback(() => {
    if (!armed || answered.current) return;
    answered.current = true;
    answer.accept();
  }, [armed, answer]);
  const onOpenChange = useCallback((open: boolean) => { if (!open) decline(); }, [decline]);

  return (
    <Dialog open disablePointerDismissal onOpenChange={onOpenChange}>
      <NarrowDialogContent
        narrow="centered"
        size="sm"
        initialFocus={cancelRef}
        title={words.title}
        closeLabel={closeLabel}
        header={(
          <DialogHeader>
            <DialogTitle>{words.title}</DialogTitle>
            <DialogClose aria-label={closeLabel} />
          </DialogHeader>
        )}
        aria-describedby={sourceId}
        data-testid="artifact-frame-confirm"
        data-capability={request.capability}
      >
        <DialogBody className="flex flex-col gap-3 font-normal">
          <p id={sourceId} className="text-subhead text-foreground [overflow-wrap:anywhere]" data-testid="artifact-frame-confirm-source">
            {formatMessage({ id: "artifacts.confirm.source" }, { title: request.display.title })}
          </p>
          {words.summary === undefined ? null : (
            <p className="text-subhead font-semibold text-foreground [overflow-wrap:anywhere]" data-testid="artifact-frame-confirm-summary">{words.summary}</p>
          )}
          <ScrollArea
            className="max-h-60 rounded-container bg-fill-muted"
            contentClassName="px-3 py-2.5 text-subhead text-foreground whitespace-pre-wrap [overflow-wrap:anywhere]"
            data-testid="artifact-frame-confirm-detail"
          >
            {words.link === undefined ? words.detail : (
              <>
                {words.link.before}
                <strong className="font-semibold" data-testid="artifact-frame-confirm-host">{words.link.host}</strong>
                {words.link.after}
              </>
            )}
          </ScrollArea>
          {words.partial ? <p className="text-footnote text-foreground-muted">{formatMessage({ id: "artifacts.confirm.partial" })}</p> : null}
        </DialogBody>
        <DialogActions as={DialogFooter}>
          <Button ref={cancelRef} onClick={decline} size="lg" variant="ghost" className="whitespace-nowrap">
            {formatMessage({ id: "common.confirm.cancel" })}
          </Button>
          <DialogCommit>
            {(inHead) => (
              <Button
                onClick={accept}
                size={inHead ? "md" : "lg"}
                variant="primary"
                className="whitespace-nowrap"
                data-testid="artifact-frame-confirm-accept"
                data-armed={String(armed)}
              >
                {words.accept}
                {words.leavesRaft ? <ArrowUpRight data-icon="inline-end" aria-hidden="true" focusable="false" className="shrink-0" /> : null}
              </Button>
            )}
          </DialogCommit>
        </DialogActions>
      </NarrowDialogContent>
    </Dialog>
  );
}
