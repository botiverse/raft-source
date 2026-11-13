import { useCallback, useState } from "react";
import { useIntl } from "react-intl";
import { Send, User } from "lucide-react";
import { channelIconComponent } from "../components/channel/channelIconComponent";
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
  Button,
  MessageActionCard,
  MessageActionCardActions,
  MessageActionCardCollapseTrigger,
  MessageActionCardContent,
  MessageActionCardHeader,
  MessageActionCardHeaderDescription,
  MessageActionCardHeaderIcon,
  MessageActionCardHeaderTitle,
  MessageActionCardProperties,
  MessageActionCardProperty,
  MessageActionCardPropertyLabel,
  MessageActionCardPropertyValue,
  MessageActionCardStatus,
  toast,
} from "@botiverse/raft-ui";
import { MessageIcon } from "@botiverse/ricons";
import { DELEGATED_RECEIPT_KIND } from "@botiverse/raft-shared";
import api from "../api/client";
import { ReferenceChip } from "../components/message/ReferenceChip";
import { useAppNavigate } from "../hooks/useAppNavigate";
import { useChannelStore } from "../store/channelStore";
import { findStoredChannel } from "../store/storedChannel";
import { useMessageStore } from "../store/messageStore";
import type { Message } from "../store/messageStore";
import type { DelegatedReceipt } from "./delegatedReceipt";
import { useServerStore } from "../store/serverStore";
import { retractDelegatedMessage } from "./assistantClient";

// RFC 077: after each message an assistant sends as its owner, Raft (not the
// assistant) posts a receipt in the owner's DM with the assistant: a system
// message whose `actionMetadata` is the shared `DelegatedReceiptMetadata`.
// `retractable` is computed by the server when it serves the receipt (false
// once retracted or deleted, or when the owner can no longer see where it
// went); Retract shows only when it is true, so an older server without it
// shows none. The card fields (conversationRef, conversationType, parent ids,
// preview) are absent on older receipts: the place falls back to the channel
// store and the receipt's own text.

/**
 * The server's own receipt text, `Sent for you in #qa-x: "first line"` (or
 * `in a thread in #qa-x`, or `in dm:@alice`): read only for what the metadata
 * doesn't carry yet (older servers).
 */
const RECEIPT_TEXT = /^Sent for you (in a thread in|in) (#[^\s:]+|dm:@[^\s:]+): "([\s\S]*)"$/;

type Place = { kind: "channel" | "dm"; name: string; inThread: boolean; channelId: string | null };

function useReceiptPlace(receipt: DelegatedReceipt, content: string): { place: Place | null; preview: string | null } {
  const parsed = RECEIPT_TEXT.exec(content);
  const target = receipt.parentChannelId ?? receipt.channelId;
  const known = useChannelStore((s) => findStoredChannel(s, target) ?? null);
  const inThread = receipt.parentChannelId !== null || parsed?.[1] === "in a thread in";
  const preview = receipt.preview ?? parsed?.[3] ?? null;
  if (known && known.type !== "thread") {
    return {
      place: {
        kind: known.type === "dm" ? "dm" : "channel",
        // A DM reads as the peer's handle, `@alice`, as the receipt's own text does.
        name: known.type === "dm" ? (known.peerName || known.peerDisplayName || known.name) : known.name,
        inThread,
        channelId: known.id,
      },
      preview,
    };
  }
  const where = receipt.conversationRef ?? parsed?.[2] ?? null;
  if (where && (where.startsWith("#") || where.startsWith("dm:@"))) {
    // Not in this client's store (a DM it hasn't loaded): a name, without a link
    // unless the receipt says which conversation it is.
    const channelId = receipt.parentChannelId ?? (receipt.conversationRef && !inThread ? receipt.channelId : null);
    return {
      place: where.startsWith("#")
        ? { kind: "channel", name: where.slice(1), inThread, channelId }
        : { kind: "dm", name: where.slice("dm:@".length), inThread, channelId },
      preview,
    };
  }
  return { place: null, preview };
}

type Canonical = { channelId?: string; targetMessageId?: string; canonicalTarget?: { kind: string; channelId: string; threadParentMessageId: string } };

/**
 * The receipt as a card (DS MessageActionCard: the record of something done
 * for a person, with the one action they can still take). Its title says
 * where the message went, with the channel as a link; the message's first
 * line is under it, with Open Message. While the server says it can still be
 * retracted, Retract Message asks first: retracting can't be undone, so the
 * dialog is red (DS AlertDialog). Once retracted the card folds to its header,
 * marked Retracted, and stays as the record.
 */
export function DelegatedReceiptCard({ message, receipt, time }: {
  message: Pick<Message, "id" | "channelId" | "actionMetadata" | "content">;
  receipt: DelegatedReceipt;
  time: string;
}) {
  const { formatMessage } = useIntl();
  const nav = useAppNavigate();
  const { place, preview } = useReceiptPlace(receipt, message.content);
  const [confirming, setConfirming] = useState(false);
  const [retracting, setRetracting] = useState(false);
  const [retractFailed, setRetractFailed] = useState(false);
  const retracted = receipt.deletedAt !== null;

  const openChannel = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    if (!place?.channelId) return;
    if (place.kind === "dm") nav.toDm(place.channelId);
    else nav.toChannel(place.channelId);
  }, [nav, place]);

  const openMessage = useCallback(async () => {
    const parentChannelId = receipt.parentChannelId;
    const parentMessageId = receipt.parentMessageId;
    const routeKind = place?.kind === "dm" ? "dm" : "channel";
    if (parentChannelId && parentMessageId) {
      nav.toThreadMessage(parentChannelId, parentMessageId, receipt.messageId, routeKind);
      return;
    }
    if (!place?.inThread && place?.channelId) {
      if (place.kind === "dm") nav.toDmMessage(place.channelId, receipt.messageId);
      else nav.toMessage(place.channelId, receipt.messageId);
      return;
    }
    // A thread reply from a server that doesn't send its parent yet: ask
    // where it lives, as a pasted permalink does.
    const { serverEpoch } = useServerStore.getState();
    try {
      const { data } = await api.get<Canonical>(`/messages/context/${encodeURIComponent(receipt.messageId)}`, {
        params: { channelId: receipt.channelId },
      });
      if (useServerStore.getState().serverEpoch !== serverEpoch) return;
      const target = data.canonicalTarget;
      if (target?.kind === "thread") {
        nav.toThreadMessage(target.channelId, target.threadParentMessageId, data.targetMessageId ?? receipt.messageId, routeKind);
      } else if (data.channelId && routeKind === "dm") {
        nav.toDmMessage(data.channelId, data.targetMessageId ?? receipt.messageId);
      } else if (data.channelId) {
        nav.toMessage(data.channelId, data.targetMessageId ?? receipt.messageId);
      } else {
        toast.error(formatMessage({ id: "assistant.receipt.openFailed" }));
      }
    } catch {
      toast.error(formatMessage({ id: "assistant.receipt.openFailed" }));
    }
  }, [formatMessage, nav, place, receipt]);
  const handleOpenMessage = useCallback(() => { void openMessage(); }, [openMessage]);

  const openConfirm = useCallback(() => {
    setRetractFailed(false);
    setConfirming(true);
  }, []);
  const handleConfirmOpenChange = useCallback((next: boolean) => {
    if (!next && !retracting) setConfirming(false);
  }, [retracting]);
  const { id, channelId, actionMetadata } = message;
  const handleRetract = useCallback(() => {
    setRetracting(true);
    setRetractFailed(false);
    retractDelegatedMessage(receipt.messageId).then(({ deletedAt }) => {
      // Shown at once; `message:updated` brings the same state. Only this
      // line: a forward receipt's other destinations stay as they are.
      const current = actionMetadata as { delegatedReceipt?: Record<string, unknown>; delegatedReceipts?: unknown } | null | undefined;
      const mark = (entry: Record<string, unknown> | undefined) => entry?.messageId === receipt.messageId
        ? { ...entry, deletedAt, retractable: false }
        : entry;
      const single = current?.delegatedReceipt;
      useMessageStore.getState().updateMessage({
        id,
        channelId,
        actionMetadata: {
          ...(current ?? {}),
          kind: DELEGATED_RECEIPT_KIND,
          delegatedReceipt: single ? mark(single) : { deletedAt, retractable: false },
          ...(Array.isArray(current?.delegatedReceipts)
            ? { delegatedReceipts: current.delegatedReceipts.map((entry) => mark(entry as Record<string, unknown>)) }
            : {}),
        },
      });
      setConfirming(false);
    }, () => {
      // Said in the dialog, which stays open to try again (DS Feedback: an
      // error inside a dialog is a banner in it); the card is unchanged.
      setRetractFailed(true);
    }).finally(() => setRetracting(false));
  }, [actionMetadata, channelId, id, receipt.messageId]);

  // A DM peer reads as a handle, `@alice`, as the DM reference chip does.
  const placeLabel = place?.kind === "dm" ? `@${place.name}` : place?.name ?? "";
  const placeChip = place ? (
    <ReferenceChip
      key="place"
      icon={place.kind === "dm" ? User : channelIconComponent(place.channelId)}
      variant="accent"
      label={placeLabel}
      as={place.channelId ? "a" : "span"}
      href={place.channelId ? "#" : undefined}
      onClick={place.channelId ? openChannel : undefined}
      data-message-affordance="delegated-receipt-channel"
    />
  ) : null;
  const titleId = place
    ? place.inThread ? "assistant.receipt.titleThread" : "assistant.receipt.title"
    : "assistant.receipt.titleUnknown";

  return (
    <div className="py-1" data-testid="delegated-receipt" data-message-id={message.id}>
      <MessageActionCard defaultOpen={!retracted} key={retracted ? "retracted" : "live"}>
        <MessageActionCardHeader>
          <MessageActionCardHeaderIcon><Send /></MessageActionCardHeaderIcon>
          <MessageActionCardHeaderTitle>
            <span data-testid="delegated-receipt-title">
              {formatMessage({ id: titleId }, { place: placeChip })}
            </span>
            <MessageActionCardHeaderDescription>
              {time}
            </MessageActionCardHeaderDescription>
          </MessageActionCardHeaderTitle>
          {retracted ? (
            <>
              <MessageActionCardStatus variant="muted" data-testid="delegated-receipt-retracted">
                {formatMessage({ id: "assistant.receipt.retracted" })}
              </MessageActionCardStatus>
              <MessageActionCardCollapseTrigger aria-label={formatMessage({ id: "actionCard.toggleDetails" })} />
            </>
          ) : null}
        </MessageActionCardHeader>
        <MessageActionCardContent>
          {preview ? (
            <MessageActionCardProperties>
              <MessageActionCardProperty>
                <MessageActionCardPropertyLabel>{formatMessage({ id: "assistant.receipt.messageLabel" })}</MessageActionCardPropertyLabel>
                <MessageActionCardPropertyValue className={retracted ? "text-foreground-hint" : undefined} data-testid="delegated-receipt-preview">
                  {preview}
                </MessageActionCardPropertyValue>
              </MessageActionCardProperty>
            </MessageActionCardProperties>
          ) : null}
          {retracted ? null : (
            <MessageActionCardActions>
              <Button size="md" variant="ghost" onClick={handleOpenMessage} data-testid="delegated-receipt-open">
                <MessageIcon />
                {formatMessage({ id: "assistant.receipt.open" })}
              </Button>
              {receipt.retractable ? (
                <Button size="md" onClick={openConfirm} data-testid="delegated-receipt-retract">
                  {formatMessage({ id: "assistant.receipt.retract" })}
                </Button>
              ) : null}
            </MessageActionCardActions>
          )}
        </MessageActionCardContent>
      </MessageActionCard>

      <AlertDialog open={confirming} onOpenChange={handleConfirmOpenChange}>
        <AlertDialogContent data-testid="delegated-receipt-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>{formatMessage({ id: "assistant.receipt.retractTitle" })}</AlertDialogTitle>
          </AlertDialogHeader>
          <AlertDialogBody className="grid gap-3">
            {retractFailed ? (
              <Banner status="warning" size="sm" role="alert" data-testid="delegated-receipt-retract-error">
                {formatMessage({ id: "assistant.receipt.retractFailed" })}
              </Banner>
            ) : null}
            <Banner status="destructive" size="sm">
              <AlertDialogDescription>{formatMessage({ id: "assistant.receipt.retractBody" })}</AlertDialogDescription>
            </Banner>
          </AlertDialogBody>
          <AlertDialogFooter>
            <AlertDialogCancel size="lg" disabled={retracting}>
              {formatMessage({ id: "assistant.receipt.cancel" })}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="danger"
              size="lg"
              disabled={retracting}
              onClick={handleRetract}
              data-testid="delegated-receipt-retract-confirm"
            >
              {formatMessage({ id: retracting ? "assistant.receipt.retracting" : "assistant.receipt.confirmRetract" })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
