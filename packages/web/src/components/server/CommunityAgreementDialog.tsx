import { Button, Card, Dialog, DialogBody, DialogClose, DialogFooter, DialogHeader, DialogTitle, ScrollArea } from "@botiverse/raft-ui";
import { useCallback, useRef, useState } from "react";
import { useIntl } from "react-intl";
import Banner from "../ui/Banner";
import AgreementBody from "./AgreementBody";
import { DialogActions, DialogCommit, NarrowDialogContent, useNarrowPresentation } from "../ui/NarrowDialog";

export interface CommunityAgreement {
  id: string;
  title: string;
  bodyMarkdown: string;
  version: number;
}

export default function CommunityAgreementDialog({
  agreement,
  onClose,
  onAgree,
}: {
  agreement: CommunityAgreement;
  onClose: () => void;
  onAgree: (agreementId: string) => Promise<void>;
}) {
  const { formatMessage } = useIntl();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const narrow = useNarrowPresentation("sheet");
  const popupRef = useRef<HTMLDivElement | null>(null);

  const handleAgree = useCallback(async () => {
    setSubmitting(true);
    setError("");
    try {
      await onAgree(agreement.id);
    } catch (err: any) {
      const response = err?.response?.data;
      setError(
        response?.error === "agreement_changed"
          ? formatMessage({ id: "server.communityAgreement.updated" })
          : formatMessage({ id: "server.communityAgreement.failedToJoin" }),
      );
    } finally {
      setSubmitting(false);
    }
  }, [agreement.id, formatMessage, onAgree]);

  const handleOpenChange = useCallback((open: boolean) => { if (!open) onClose(); }, [onClose]);
  const version = formatMessage({ id: "server.communityAgreement.version" }, { version: agreement.version });
  const closeLabel = formatMessage({ id: "common.close" });

  return (
    // DS Dialog: Base UI owns Esc, the focus trap and focus return. No scrim
    // press, as the old Modal (closeOnBackdrop off). On a phone, the sheet:
    // a long text and Agree, the version line opening the body.
    // disablePointerDismissal is deliberate: joining needs an explicit choice, Agree or Cancel.
    <Dialog open disablePointerDismissal onOpenChange={handleOpenChange}>
      <NarrowDialogContent
        ref={popupRef}
        narrow="sheet"
        // Focus starts on the dialog itself, as the old Modal: not on ×.
        initialFocus={popupRef}
        className="max-w-lg"
        title={agreement.title}
        closeLabel={closeLabel}
        header={(
          <DialogHeader>
            <div className="min-w-0">
              <DialogTitle>{agreement.title}</DialogTitle>
              <div className="mt-1 font-mono text-mono-meta text-foreground-hint">{version}</div>
            </div>
            <DialogClose aria-label={closeLabel} />
          </DialogHeader>
        )}
      >
        <DialogBody>
          {narrow && <div className="mb-3 font-mono text-mono-meta text-foreground-hint">{version}</div>}
          {/* The card frames the agreement; it scrolls in a raft-ui ScrollArea
              inside, padded on its content so the scrollbar sits at the edge. */}
          <Card className="text-callout text-foreground-muted">
            <ScrollArea className="max-h-[50vh] min-h-0" contentClassName="p-4">
              <AgreementBody source={agreement.bodyMarkdown} />
            </ScrollArea>
          </Card>

          {error && (
            <Banner intent="warning" density="sm" className="mt-4">
              {error}
            </Banner>
          )}
        </DialogBody>

        <DialogActions as={DialogFooter}>
          <Button size="lg"
            variant="ghost"
            type="button"
            onClick={onClose}
            disabled={submitting}
          >
            {formatMessage({ id: "server.communityAgreement.cancel" })}
          </Button>
          <DialogCommit>
            {(inHead) => (
              <Button size={inHead ? "md" : "lg"}
                variant="primary"
                type="button"
                onClick={handleAgree}
                disabled={submitting}
              >
                {submitting
                  ? formatMessage({ id: "server.communityAgreement.joining" })
                  : formatMessage({ id: "server.communityAgreement.agreeContinue" })}
              </Button>
            )}
          </DialogCommit>
        </DialogActions>
      </NarrowDialogContent>
    </Dialog>
  );
}
