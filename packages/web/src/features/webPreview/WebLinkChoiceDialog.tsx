import { useCallback } from "react";
import { useIntl } from "react-intl";
import { Button, Dialog, DialogBody, DialogClose, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@botiverse/raft-ui";
import type { WebLinkOpenPreference } from "../../store/webLinkOpenPreference";

/**
 * Asked once, on the first click of a plain web link in a message in Raft
 * Desktop: open web links beside the conversation, or in the browser? A
 * decision the person makes now, so a `size="sm"` Dialog (DS Dialog › When to
 * use). Each button is a choice that is remembered; Esc, × and the scrim
 * choose nothing (`onDismiss`: the link opens in the browser this time and
 * the next click asks again). The footer is the DS's: the way out first and
 * frameless, the pink button last.
 */
export function WebLinkChoiceDialog({ onChoose, onDismiss }: {
  onChoose: (preference: WebLinkOpenPreference) => void;
  onDismiss: () => void;
}) {
  const { formatMessage } = useIntl();
  const handleOpenChange = useCallback((open: boolean) => {
    if (!open) onDismiss();
  }, [onDismiss]);
  const chooseBrowser = useCallback(() => onChoose("browser"), [onChoose]);
  const chooseBeside = useCallback(() => onChoose("beside"), [onChoose]);
  return (
    <Dialog open onOpenChange={handleOpenChange}>
      <DialogContent size="sm" data-testid="web-link-choice-dialog">
        <DialogHeader>
          <DialogTitle>{formatMessage({ id: "webPreview.linkChoice.title" })}</DialogTitle>
          <DialogClose aria-label={formatMessage({ id: "common.confirm.closeDialog" })} />
        </DialogHeader>
        <DialogBody>{formatMessage({ id: "webPreview.linkChoice.body" })}</DialogBody>
        <DialogFooter>
          <Button variant="ghost" size="lg" onClick={chooseBrowser} data-testid="web-link-choice-browser">
            {formatMessage({ id: "webPreview.linkChoice.browser" })}
          </Button>
          <Button variant="primary" size="lg" onClick={chooseBeside} data-testid="web-link-choice-beside">
            {formatMessage({ id: "webPreview.linkChoice.beside" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
