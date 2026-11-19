import { useIntl } from "react-intl";
import { TriangleAlert } from "lucide-react";
import {
  Banner,
  BannerDescription,
  Button,
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@botiverse/raft-ui";

/**
 * Disconnect WeChat? from the connection view (Assistant Settings ›
 * WeChat). Disconnecting stops the bridge and Raft forgets its token, but
 * scanning again connects it back, so the confirm is orange (DS Dialog at
 * size sm: interrupts, can be recovered; AlertDialog is only for the
 * confirmations Raft Chat lists). A failed disconnect is said here, in the
 * dialog, which stays open to try again (DS Feedback › Errors by scope).
 *
 * The connected notice in the DM disconnects without it: a protective
 * disconnect, for a QR code someone else scanned first, goes in one click
 * (Tenny; Kirby adds the rule to the design system).
 */
export function WeChatDisconnectConfirm({ open, name, busy, failed, onOpenChange, onConfirm }: {
  open: boolean;
  /** The assistant's name (Ottie). */
  name: string;
  busy: boolean;
  failed: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const { formatMessage } = useIntl();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm" data-testid="wechat-disconnect-confirm">
        <DialogHeader>
          <DialogTitle>{formatMessage({ id: "assistant.wechat.disconnectTitle" })}</DialogTitle>
          <DialogClose disabled={busy} aria-label={formatMessage({ id: "common.confirm.closeDialog" })} />
        </DialogHeader>
        <DialogBody className="grid gap-3">
          {failed ? (
            <Banner status="warning" size="sm" data-testid="wechat-disconnect-error">
              <TriangleAlert />
              <BannerDescription>{formatMessage({ id: "assistant.wechat.disconnectFailed" })}</BannerDescription>
            </Banner>
          ) : null}
          <DialogDescription>{formatMessage({ id: "assistant.wechat.disconnectBody" }, { name })}</DialogDescription>
        </DialogBody>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" size="lg" />} disabled={busy}>
            {formatMessage({ id: "assistant.wechat.cancel" })}
          </DialogClose>
          <Button
            variant="warning"
            size="lg"
            loading={busy}
            loadingLabel={formatMessage({ id: "assistant.wechat.disconnecting" })}
            onClick={onConfirm}
            data-testid="wechat-disconnect-confirm-action"
          >
            {formatMessage({ id: "assistant.wechat.disconnect" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
