import { useIntl } from "react-intl";
import type { Message } from "../store/messageStore";
import { DelegatedReceiptCard } from "./DelegatedReceiptCard";
import { joinedChannelsOf, joinedNotForwardedOf } from "./delegatedReceipt";
import type { DelegatedReceipt } from "./delegatedReceipt";

/**
 * RFC 077: a delegated receipt's lines. A single send has one; a forward
 * receipt (forwardAsOwner, one per request) has a card per destination, each
 * retractable on its own, and names the public channels the assistant joined
 * for its owner so they can leave them, including one where the forward then
 * did not go through (such a receipt may have no card at all).
 */
export function DelegatedReceiptLines({ message, receipts, time }: {
  message: Pick<Message, "id" | "channelId" | "actionMetadata" | "content">;
  receipts: DelegatedReceipt[];
  time: string;
}) {
  const { formatMessage } = useIntl();
  const joinedChannels = joinedChannelsOf(message.actionMetadata);
  const joinedNotForwarded = joinedNotForwardedOf(message.actionMetadata);
  return (
    <>
      {receipts.map((receipt) => (
        <DelegatedReceiptCard key={receipt.messageId} message={message} receipt={receipt} time={time} />
      ))}
      {joinedChannels.length > 0 ? (
        <p className="py-1 text-sm text-foreground-hint" data-testid="delegated-receipt-joined">
          {formatMessage(
            { id: "assistant.receipt.joined" },
            { channels: joinedChannels.map((channel) => `#${channel.name}`).join(", "), count: joinedChannels.length },
          )}
        </p>
      ) : null}
      {joinedNotForwarded.map((channel) => (
        <p key={channel.channelId} className="py-1 text-sm text-foreground-hint" data-testid="delegated-receipt-joined-not-forwarded">
          {formatMessage({ id: "assistant.receipt.joinedNotForwarded" }, { channel: `#${channel.name}` })}
        </p>
      ))}
    </>
  );
}
