import { useCallback, useId, useState } from "react";
import { useIntl } from "react-intl";
import { CircleCheck, TriangleAlert } from "lucide-react";
import {
  Banner,
  BannerAction,
  BannerDescription,
  BannerTitle,
  Button,
  DescriptionDetails,
  DescriptionItem,
  DescriptionList,
  DescriptionTerm,
  DialogBody,
  DialogFooter,
  ListRow,
  ListRowBody,
  ListRowDescription,
  ListRowGroup,
  ListRowTitle,
  Status,
  toast,
} from "@botiverse/raft-ui";
import { DialogActions, DialogCommit } from "../components/ui/NarrowDialog";
import { useTimeFormatter } from "../hooks/useTimeFormatter";
import { disconnectWeChat } from "./wechatClient";
import type { WeChatBinding } from "./wechatClient";
import { useWeChatConnectWebUrl } from "./wechatConnectHere";
import type { WeChatConnectBlock } from "./wechatConnectHere";
import { WeChatDisconnectConfirm } from "./WeChatDisconnectConfirm";

const RECONNECT_BODY_IDS = {
  desktop: "assistant.wechat.reconnectBodyDesktop",
  phone: "assistant.wechat.reconnectBodyPhone",
} as const;

/**
 * WeChat › the connection (design "微信接入 Ottie"): its state and since when
 * (the server names no WeChat account: no id or nickname ever reaches the
 * browser) and what it does. The view is read, so its one button is a pink
 * Done (DS Dialog › The footer); Disconnect is a row in the body, the
 * description on the left and its button on the right (DS Forms: an action
 * in a section is an ordinary row), confirmed in orange
 * (WeChatDisconnectConfirm). A connection that stopped working (WeChat
 * refused its token) says so, with Reconnect where connecting works; in the
 * desktop app and on a phone it says where to reconnect instead, and the
 * desktop app opens the web app for it.
 */
export function WeChatConnectionView({
  name,
  binding,
  justConnected,
  available,
  block,
  onReconnect,
  onClose,
}: {
  name: string;
  /** Null right after connecting when the status could not be read again. */
  binding: WeChatBinding | null;
  /** Reached by scanning just now: says so, once. */
  justConnected: boolean;
  /** Connecting is offered to this person here (GET /status `available`). */
  available: boolean;
  /** Where connecting can't finish (wechatConnectHere). */
  block: WeChatConnectBlock;
  onReconnect: () => void;
  onClose: () => void;
}) {
  const { formatMessage } = useIntl();
  const { formatMediumDateTime } = useTimeFormatter();
  const webUrl = useWeChatConnectWebUrl();
  const openInBrowser = formatMessage({ id: "assistant.wechat.openInBrowser" });
  const rowDescriptionId = useId();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const stopped = binding?.state === "reconnect_required";
  const since = binding?.connectedAt ? formatMediumDateTime(binding.connectedAt) : "";

  const openConfirm = useCallback(() => {
    setFailed(false);
    setConfirming(true);
  }, []);
  const handleConfirmOpenChange = useCallback((next: boolean) => {
    if (!next && !busy) setConfirming(false);
  }, [busy]);
  const handleDisconnect = useCallback(() => {
    if (!binding) return;
    setBusy(true);
    setFailed(false);
    // The connection this view shows: a newer one made meanwhile stays.
    disconnectWeChat(binding.bindingId).then((outcome) => {
      setConfirming(false);
      if (outcome === "disconnected") {
        toast.success(formatMessage({ id: "assistant.wechat.disconnected" }));
        onClose();
      } else {
        toast.info(formatMessage({ id: "assistant.wechat.notice.endedBody" }));
      }
    }, () => {
      // Said in the dialog, which stays open to try again (DS Feedback).
      setFailed(true);
    }).finally(() => setBusy(false));
  }, [binding, formatMessage, onClose]);

  return (
    <>
      <DialogBody className="grid gap-4" data-testid="wechat-connection">
        {justConnected ? (
          <Banner status="success" size="sm" data-testid="wechat-connected-banner">
            <CircleCheck />
            <BannerTitle>{formatMessage({ id: "assistant.wechat.connectedNow" })}</BannerTitle>
            <BannerDescription>{formatMessage({ id: "assistant.wechat.tryIt" }, { name })}</BannerDescription>
          </Banner>
        ) : stopped ? (
          <Banner status="warning" size="sm" data-testid="wechat-reconnect-banner">
            <TriangleAlert />
            <BannerTitle>{formatMessage({ id: "assistant.wechat.reconnectTitle" })}</BannerTitle>
            <BannerDescription>
              {formatMessage({ id: available && block ? RECONNECT_BODY_IDS[block] : "assistant.wechat.reconnectBody" }, { name })}
            </BannerDescription>
            {available && block === null ? (
              <BannerAction>
                <Button type="button" size="md" variant="default" onClick={onReconnect} data-testid="wechat-reconnect">
                  {formatMessage({ id: "assistant.wechat.reconnect" })}
                </Button>
              </BannerAction>
            ) : available && block === "desktop" && webUrl ? (
              <BannerAction>
                <Button
                  size="md"
                  variant="default"
                  // Handed to the system browser by the desktop shell (window.open → openInBrowser).
                  render={<a href={webUrl} target="_blank" rel="noopener noreferrer" aria-label={openInBrowser} />}
                  data-testid="wechat-reconnect-open-browser"
                >
                  {openInBrowser}
                </Button>
              </BannerAction>
            ) : null}
          </Banner>
        ) : null}
        {binding ? (
          <DescriptionList direction="horizontal">
            <DescriptionItem>
              <DescriptionTerm>{formatMessage({ id: "assistant.wechat.statusLabel" })}</DescriptionTerm>
              <DescriptionDetails data-testid="wechat-connection-state">
                <Status variant={stopped ? "warning" : "success"} className="lead-dot" aria-hidden="true" />
                {formatMessage({ id: stopped ? "assistant.wechat.statusStopped" : "assistant.wechat.statusActive" })}
              </DescriptionDetails>
            </DescriptionItem>
            {since ? (
              <DescriptionItem>
                <DescriptionTerm>{formatMessage({ id: "assistant.wechat.sinceLabel" })}</DescriptionTerm>
                <DescriptionDetails className="font-mono" data-testid="wechat-connection-since">{since}</DescriptionDetails>
              </DescriptionItem>
            ) : null}
          </DescriptionList>
        ) : null}
        <p className="text-subhead text-foreground-muted">{formatMessage({ id: "assistant.wechat.connectedBody" }, { name })}</p>
        {binding ? (
          <ListRowGroup>
            <ListRow variant="plain" interactive={false} data-testid="wechat-disconnect-row">
              <ListRowBody>
                <ListRowTitle>{formatMessage({ id: "assistant.wechat.disconnectRowTitle" })}</ListRowTitle>
                <ListRowDescription id={rowDescriptionId} wrap>
                  {formatMessage({ id: "assistant.wechat.disconnectRowBody" }, { name })}
                </ListRowDescription>
              </ListRowBody>
              <Button
                type="button"
                variant="default"
                size="md"
                onClick={openConfirm}
                aria-describedby={rowDescriptionId}
                data-testid="wechat-disconnect"
              >
                {formatMessage({ id: "assistant.wechat.disconnect" })}
              </Button>
            </ListRow>
          </ListRowGroup>
        ) : null}
      </DialogBody>
      <DialogActions as={DialogFooter}>
        <DialogCommit>
          {(inHead) => (
            <Button type="button" variant="primary" size={inHead ? "md" : "lg"} onClick={onClose} data-testid="wechat-done">
              {formatMessage({ id: "assistant.settings.done" })}
            </Button>
          )}
        </DialogCommit>
      </DialogActions>

      <WeChatDisconnectConfirm
        open={confirming}
        name={name}
        busy={busy}
        failed={failed}
        onOpenChange={handleConfirmOpenChange}
        onConfirm={handleDisconnect}
      />
    </>
  );
}
