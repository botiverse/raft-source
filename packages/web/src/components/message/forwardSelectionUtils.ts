import type { IntlShape } from "react-intl";

import type { Channel } from "../../store/channelStore";
import type { Message } from "../../store/messageStore";
import { buildMessagePermalink } from "../../hooks/useAppNavigate";

type FormatMessage = IntlShape["formatMessage"];

export function canForwardFromSource(channel: Pick<Channel, "type"> | null | undefined): boolean {
  return Boolean(channel);
}

export function getForwardDisabledReason(
  channel: Pick<Channel, "type"> | null | undefined,
  formatMessage: FormatMessage,
): string | null {
  if (!canForwardFromSource(channel)) {
    return formatMessage({ id: "message.forward.unsupportedSource" });
  }
  return null;
}
export function getForwardableMessages<T extends Message>(messages: readonly T[]) {
  let nestedForwardCount = 0;
  let actionCardCount = 0;
  let systemMessageCount = 0;
  const forwardable = messages.filter((message) => {
    const meta = message.actionMetadata as { kind?: string } | null | undefined;
    if (meta?.kind === "forwarded-bundle") {
      nestedForwardCount += 1;
      return false;
    }
    if (message.messageType === "system") {
      systemMessageCount += 1;
      return false;
    }
    if (meta?.kind) {
      actionCardCount += 1;
      return false;
    }
    return true;
  });
  return {
    messages: forwardable,
    skippedCount: messages.length - forwardable.length,
    nestedForwardCount,
    actionCardCount,
    systemMessageCount,
  };
}

export function formatForwardSelectionBlockedMessage(formatMessage: IntlShape["formatMessage"], {
  forwardableCount,
  nestedForwardCount,
  actionCardCount,
  systemMessageCount,
}: {
  forwardableCount: number;
  nestedForwardCount: number;
  actionCardCount: number;
  systemMessageCount: number;
}): string {
  const blockedKinds = [nestedForwardCount, actionCardCount, systemMessageCount].filter((count) => count > 0).length;

  if (forwardableCount > 0) {
    if (blockedKinds > 1) {
      return formatMessage({ id: "message.forwardSelection.mixedPartial" });
    }
    if (nestedForwardCount > 0) {
      return formatMessage({ id: "message.forwardSelection.nestedPartial" });
    }
    if (actionCardCount > 0) {
      return formatMessage({ id: "message.forwardSelection.actionPartial" });
    }
    return formatMessage({ id: "message.forwardSelection.systemPartial" });
  }

  if (blockedKinds > 1) {
    return formatMessage({ id: "message.forwardSelection.mixedAll" });
  }
  if (nestedForwardCount > 0) {
    return formatMessage({ id: "message.forwardSelection.nestedAll" });
  }
  if (actionCardCount > 0) {
    return formatMessage({ id: "message.forwardSelection.actionAll" });
  }
  if (systemMessageCount > 0) {
    return formatMessage({ id: "message.forwardSelection.systemAll" });
  }
  return formatMessage({ id: "message.forwardSelection.unsupportedAll" });
}

export function buildSelectedMessagePermalinks({
  serverSlug,
  channel,
  messages,
  threadParentMessageId = null,
}: {
  serverSlug: string;
  channel: Pick<Channel, "id" | "type">;
  messages: readonly Message[];
  threadParentMessageId?: string | null;
}) {
  const routeKind = channel.type === "dm" ? "dm" : "channel";
  return messages.map((message) =>
    buildMessagePermalink(serverSlug, channel.id, message.id, {
      routeKind,
      threadParentMessageId,
    })
  );
}

export function formatCopyLinksToast(count: number, formatMessage: FormatMessage) {
  return formatMessage({ id: "message.forward.linkCopied" }, { count });
}

export function formatForwardSentToast(
  destination: Pick<Channel, "type" | "name">,
  formatMessage: FormatMessage,
) {
  const destinationLabel = destination.type === "dm"
    ? formatMessage({ id: "message.forward.dmLabel" })
    : `#${destination.name}`;
  return formatMessage({ id: "message.forward.sentToast" }, { destination: destinationLabel });
}
