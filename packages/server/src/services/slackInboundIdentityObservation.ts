/** A deliberately identifier- and content-free sample of a verified message. */
export type SlackInboundIdentityObservation = {
  isRecognizedBot: boolean;
  userIdMatchesHistory: boolean;
  hasSenderAppId: boolean;
  senderAppIdMatches: boolean;
  senderAppIdsConflict: boolean;
  hasBotId: boolean;
  botIdMatchesHistory: boolean;
  hasText: boolean;
  hasFiles: boolean;
};

type Message = { user?: unknown; bot_id?: unknown; bot_profile?: unknown; app_id?: unknown;
  subtype?: unknown; text?: unknown; files?: unknown };

/**
 * Summarize only a verified, explicitly scoped test-channel message. The
 * caller establishes that scope; this helper neither stores nor emits data.
 * It does not use the envelope's api_app_id as a sender identity.
 */
export function summarizeSlackInboundIdentity(input: {
  message: Message;
  providerAppId: string;
  selfBotIds: readonly string[];
  selfUserIds: readonly string[];
}): SlackInboundIdentityObservation {
  const { message, providerAppId, selfBotIds, selfUserIds } = input;
  const profile = message.bot_profile && typeof message.bot_profile === "object" && !Array.isArray(message.bot_profile)
    ? message.bot_profile as Record<string, unknown> : null;
  const valid = (value: unknown): value is string => typeof value === "string" && value.length > 0
    && value === value.trim() && Buffer.byteLength(value, "utf8") <= 160 && !/[\p{Cc}\p{Cf}]/u.test(value);
  const botIds = [message.bot_id, profile?.id].filter(valid);
  const appIds = [message.app_id, profile?.app_id].filter(valid);
  const botLike = botIds.length > 0 || appIds.length > 0 || profile !== null || message.subtype === "bot_message"
    || (valid(message.user) && selfUserIds.includes(message.user));
  const distinctApps = new Set(appIds);
  return {
    isRecognizedBot: botLike,
    userIdMatchesHistory: valid(message.user) && selfUserIds.includes(message.user),
    hasSenderAppId: appIds.length > 0,
    senderAppIdMatches: valid(providerAppId) && appIds.length > 0 && appIds.every(id => id === providerAppId),
    senderAppIdsConflict: distinctApps.size > 1,
    hasBotId: botIds.length > 0,
    botIdMatchesHistory: botIds.length > 0 && botIds.some(id => selfBotIds.includes(id)),
    hasText: typeof message.text === "string" && message.text.trim().length > 0,
    hasFiles: Array.isArray(message.files) && message.files.length > 0,
  };
}

/** Explicit opt-in channel scope; the callback receives no message identifiers or body. */
export type SlackTestIdentityObserver = {
  providerConversationIds: readonly string[];
  record(observation: SlackInboundIdentityObservation): void | Promise<void>;
};
