import { isSlackBotFallbackLabel } from "@botiverse/raft-shared";
import type { ExternalActorKind, ExternalMessageAuthorProjection } from "@botiverse/raft-shared";
import type { IntlShape } from "react-intl";
import type { MessageId } from "../../i18n/messages";

export const EXTERNAL_ACTOR_KIND_MESSAGE_IDS: Record<ExternalActorKind, MessageId> = {
  human: "message.externalIdentity.kind.human",
  guest: "message.externalIdentity.kind.guest",
  remote: "message.externalIdentity.kind.remote",
  bot: "message.externalIdentity.kind.app",
  unknown: "message.externalIdentity.kind.unknown",
};

export function formatExternalProviderLabel(
  provider: string | null | undefined,
  formatMessage: IntlShape["formatMessage"],
): string | null {
  const normalized = provider?.trim();
  if (!normalized) return null;
  if (normalized.toLowerCase() === "slack") {
    return formatMessage({ id: "message.externalIdentity.provider.slack" });
  }
  return normalized;
}

/** Only replace the synthetic Slack bot label after a verified profile was returned. */
export function externalSenderPresentation(author: ExternalMessageAuthorProjection | null | undefined) {
  const fallback = author?.provider === "slack" && author.actorKind === "bot"
    && isSlackBotFallbackLabel(author.displayName, author.externalActorId);
  return { displayName: (fallback ? author?.profileDisplayName : undefined) || author?.displayName,
    avatarUrl: (fallback ? author?.profileAvatarUrl : undefined) ?? author?.avatarUrl ?? null };
}
