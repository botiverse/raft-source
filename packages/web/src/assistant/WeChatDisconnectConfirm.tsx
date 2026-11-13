import { useIntl } from "react-intl";
import { TriangleAlert } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogBody,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Banner,
  BannerDescription,
} from "@botiverse/raft-ui";

/**
 * Disconnect WeChat? from the connection view (Assistant Settings ›
 * WeChat). Disconnecting stops the bridge and Raft forgets its token, but
 * scanning again connects it back, so the confirm is orange (DS AlertDialog:
 * interrupts, can be recovered). A failed disconnect is said here, in the
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
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent data-testid="wechat-disconnect-confirm">
        <AlertDialogHeader>
          <AlertDialogTitle>{formatMessage({ id: "assistant.wechat.disconnectTitle" })}</AlertDialogTitle>
        </AlertDialogHeader>
        <AlertDialogBody className="grid gap-3">
          {failed ? (
            <Banner status="warning" size="sm" data-testid="wechat-disconnect-error">
              <TriangleAlert />
              <BannerDescription>{formatMessage({ id: "assistant.wechat.disconnectFailed" })}</BannerDescription>
            </Banner>
          ) : null}
          <AlertDialogDescription>{formatMessage({ id: "assistant.wechat.disconnectBody" }, { name })}</AlertDialogDescription>
        </AlertDialogBody>
        <AlertDialogFooter>
          <AlertDialogCancel size="lg" disabled={busy}>
            {formatMessage({ id: "assistant.wechat.cancel" })}
          </AlertDialogCancel>
          <AlertDialogAction
            variant="warning"
            size="lg"
            loading={busy}
            loadingLabel={formatMessage({ id: "assistant.wechat.disconnecting" })}
            onClick={onConfirm}
            data-testid="wechat-disconnect-confirm-action"
          >
            {formatMessage({ id: "assistant.wechat.disconnect" })}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
