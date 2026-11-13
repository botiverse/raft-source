// RFC 082 §4.6 "Our own echo": a `message_changed` event on a card message's
// bridged copy is our own edit's echo only when (1) Slack's signature verified
// the event (the verified ingress path; the caller), (2) it matches the
// original's stored link at its current installation, workspace, channel and
// binding epoch, and (3) Slack's own sender fields for it (bot / app identity,
// not anything inside the message) are this installation's bot. The ts and the
// `card_revision` metadata are content anyone can copy: they only help match.
// Anything else goes through the inbound path's existing safe handling, which
// leaves card messages alone.

import { isMessageCardMetadata } from "@botiverse/raft-shared";
import { and, eq } from "drizzle-orm";
import type { DatabaseExecutor } from "../db/index";
import { externalMessageLinks, messages } from "../db/schema";

/** The accepted outbound link for this exact Slack message, when it is a card message's copy. */
export async function readSlackCardEditEchoLink(executor: DatabaseExecutor, input: {
  installId: string;
  providerAuthorityId: string;
  providerConversationId: string;
  providerMessageId: string;
  current: { bindingId: string; bindingEpoch: number; connectionEpoch: number };
}): Promise<{ currentEpoch: boolean } | null> {
  const rows = await executor.select({
    bindingId: externalMessageLinks.bindingId,
    bindingEpoch: externalMessageLinks.bindingEpoch,
    connectionEpoch: externalMessageLinks.connectionEpoch,
    actionMetadata: messages.actionMetadata,
  }).from(externalMessageLinks)
    .innerJoin(messages, eq(messages.id, externalMessageLinks.raftMessageId))
    .where(and(
      eq(externalMessageLinks.provider, "slack"),
      eq(externalMessageLinks.installId, input.installId),
      eq(externalMessageLinks.providerAuthorityId, input.providerAuthorityId),
      eq(externalMessageLinks.providerConversationId, input.providerConversationId),
      eq(externalMessageLinks.providerMessageId, input.providerMessageId),
      eq(externalMessageLinks.firstDirection, "raft_outbound"),
      eq(externalMessageLinks.outcomeState, "accepted"),
    )).limit(2);
  if (rows.length !== 1 || !isMessageCardMetadata(rows[0]!.actionMetadata)) return null;
  const link = rows[0]!;
  return {
    currentEpoch: link.bindingId === input.current.bindingId && link.bindingEpoch === input.current.bindingEpoch
      && link.connectionEpoch === input.current.connectionEpoch,
  };
}

function id(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value === value.trim() && value.length <= 160 ? value : null;
}

/**
 * Whether Slack's sender fields for a verified edit event are this
 * installation's bot: the bot id Slack reports (message `bot_id` or
 * `bot_profile.id`, which must agree) is the installation's current bot, and
 * any app id Slack reports is this App's. Text, metadata and `user` count for
 * nothing. No current bot identity: never our echo.
 */
export function isSlackCardEditSenderOurBot(input: {
  message: { bot_id?: unknown; bot_profile?: unknown; app_id?: unknown };
  providerAppId: string;
  selfBotId: string | null;
}): boolean {
  if (!input.selfBotId) return false;
  const profile = input.message.bot_profile && typeof input.message.bot_profile === "object" && !Array.isArray(input.message.bot_profile)
    ? input.message.bot_profile as Record<string, unknown> : null;
  // Malformed sender evidence is never proof.
  if ((input.message.bot_profile != null && !profile) || (input.message.bot_id != null && !id(input.message.bot_id))
    || (input.message.app_id != null && !id(input.message.app_id))
    || (profile && ((profile.id != null && !id(profile.id)) || (profile.app_id != null && !id(profile.app_id))))) return false;
  const botIds = [id(input.message.bot_id), id(profile?.id)].filter((value): value is string => value !== null);
  const appIds = [id(input.message.app_id), id(profile?.app_id)].filter((value): value is string => value !== null);
  return botIds.length > 0 && botIds.every((botId) => botId === input.selfBotId)
    && appIds.every((appId) => appId === input.providerAppId);
}
