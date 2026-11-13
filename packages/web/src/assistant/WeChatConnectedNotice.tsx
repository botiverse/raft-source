import { useCallback, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { Smartphone } from "lucide-react";
import {
  Button,
  MessageActionCard,
  MessageActionCardActions,
  MessageActionCardActionsNote,
  MessageActionCardContent,
  MessageActionCardHeader,
  MessageActionCardHeaderDescription,
  MessageActionCardHeaderIcon,
  MessageActionCardHeaderTitle,
  MessageActionCardStatus,
  toast,
} from "@botiverse/raft-ui";
import type { Message } from "../store/messageStore";
import { useMyAssistant } from "./assistantClient";
import { disconnectWeChat, useWeChatStatus } from "./wechatClient";
import { weChatNoticeBindingId } from "./wechatNotice";

/**
 * The connected notice in the owner's DM with their assistant (Tenny's
 * condition for the WeChat bridge): the server's notice that WeChat was
 * connected, as a card with a one-click Disconnect WeChat, so a QR code
 * someone else scanned first is undone right where it is noticed (DELETE
 * /binding; no confirmation: a protective disconnect, and scanning again
 * connects it back; Kirby adds the rule to the design system). The card is
 * the receipt pattern of this DM (DelegatedReceiptCard, DS MessageActionCard:
 * the record of something done for the person, with the one action left).
 *
 * The button shows while this DM is the viewer's own assistant DM and the
 * status's connection is the one this notice names (or the status could not
 * be read). Disconnect names that binding, so it never removes a newer
 * connection (Tenny, #12750): one made since answers 409 and the card ends.
 * Ended, the card is its header, marked Disconnected (DS MessageActionCard ›
 * States: Done is the header and its result).
 *
 * Until the assistant and the status are known, the card is drawn with its
 * button, not yet pressable, so it doesn't grow under the reader when they
 * arrive (DS Responsive › The first frame is the settled one); an ended
 * notice then loses the row once. After a disconnect focus moves to the
 * card's title, as the button it was on goes away.
 */
export function WeChatConnectedNotice({ message, time }: {
  message: Pick<Message, "id" | "channelId" | "createdAt"> & Partial<Pick<Message, "randomId">>;
  time: string;
}) {
  const { formatMessage } = useIntl();
  const mine = useMyAssistant();
  const ownDm = mine.status === "ready" && mine.assistant?.dmChannelId === message.channelId;
  // Known not to be the viewer's own assistant DM: a record, nothing to do.
  const notMine = mine.status === "off" || (mine.status === "ready" && !ownDm);
  const status = useWeChatStatus({ ask: ownDm });
  const [busy, setBusy] = useState(false);
  const titleRef = useRef<HTMLSpanElement | null>(null);

  const noticeBinding = weChatNoticeBindingId(message.randomId);
  const live = ownDm && noticeBinding !== null && (
    status.status === "error"
    || (status.status === "ready" && status.value.binding?.bindingId === noticeBinding)
  );
  const ended = ownDm && status.status === "ready" && !live;
  const pending = noticeBinding !== null && !notMine && !live && !ended;

  const handleDisconnect = useCallback(() => {
    if (!noticeBinding) return;
    setBusy(true);
    disconnectWeChat(noticeBinding).then((outcome) => {
      if (outcome === "disconnected") toast.success(formatMessage({ id: "assistant.wechat.disconnected" }));
      else toast.info(formatMessage({ id: "assistant.wechat.notice.endedBody" }));
      // The button goes with the connection: focus stays on the card, never on the document.
      titleRef.current?.focus();
    }, () => {
      // DS MessageActionCard: a failed action is a toast; the card stays as it was.
      toast.error(formatMessage({ id: "assistant.wechat.disconnectFailed" }));
    }).finally(() => setBusy(false));
  }, [formatMessage, noticeBinding]);

  return (
    <div className="py-1" data-testid="wechat-connected-notice" data-message-id={message.id} data-state={live ? "live" : ended ? "ended" : pending ? "pending" : "record"}>
      <MessageActionCard>
        <MessageActionCardHeader>
          <MessageActionCardHeaderIcon><Smartphone /></MessageActionCardHeaderIcon>
          <MessageActionCardHeaderTitle>
            <span ref={titleRef} tabIndex={-1} data-testid="wechat-notice-title">
              {formatMessage({ id: "assistant.wechat.notice.title" })}
            </span>
            <MessageActionCardHeaderDescription>{time}</MessageActionCardHeaderDescription>
          </MessageActionCardHeaderTitle>
          {ended ? (
            <MessageActionCardStatus variant="muted" data-testid="wechat-notice-ended">
              {formatMessage({ id: "assistant.wechat.notice.disconnected" })}
            </MessageActionCardStatus>
          ) : null}
        </MessageActionCardHeader>
        {live || pending ? (
          <MessageActionCardContent>
            <MessageActionCardActions>
              <MessageActionCardActionsNote>{formatMessage({ id: "assistant.wechat.notice.note" })}</MessageActionCardActionsNote>
              <Button
                type="button"
                size="md"
                disabled={pending}
                loading={busy}
                loadingLabel={formatMessage({ id: "assistant.wechat.disconnecting" })}
                onClick={handleDisconnect}
                data-testid="wechat-notice-disconnect"
              >
                {formatMessage({ id: "assistant.wechat.notice.disconnect" })}
              </Button>
            </MessageActionCardActions>
          </MessageActionCardContent>
        ) : null}
      </MessageActionCard>
    </div>
  );
}
