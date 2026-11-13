/**
 * Classify a signed Slack message body, never the envelope's `api_app_id`
 * (which identifies the receiving App). The caller must first check exact
 * same-conversation outbound message/file evidence, and must revalidate all
 * authority and identity evidence before settling or materializing an event.
 *
 * `selfBotIds` must come from current installations' auth.test receipts,
 * scoped to this App and workspace. Do not add IDs observed in events.
 * `identityAvailable` requires current install identity, not a claim of
 * complete history. If a
 * no-App-ID bot might match an unresolved outbound, wait for reconciliation.
 * The Slack `user` field is never a self-echo proof.
 *
 * This helper is deliberately not wired into the inbound worker yet. In
 * particular, returning `self_echo` is not by itself authorization to discard
 * a signed receipt; the final decision must be rechecked under the same lock as
 * its evidence.
 */
export type SlackInboundAuthorDecision =
  | { kind: "self_echo" }
  | { kind: "human"; providerUserId: string }
  | { kind: "bot"; providerBotId: string; providerUserId: string | null }
  | { kind: "wait"; reason: "self_identity_unavailable" | "sender_identity_unavailable" | "sender_identity_conflict" | "outbound_result_pending" };

function id(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value === value.trim()
    && Buffer.byteLength(value, "utf8") <= 160 && !/[\p{Cc}\p{Cf}]/u.test(value) ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function invalidPresent(value: unknown): boolean {
  return value !== undefined && value !== null && id(value) === null;
}

export function classifyVerifiedSlackInboundAuthor(input: {
  message: { user?: unknown; bot_id?: unknown; bot_profile?: unknown; app_id?: unknown; subtype?: unknown };
  self: { providerAppId: unknown; identityAvailable: boolean; selfBotIds: readonly string[] };
  /** Exact same-channel message ts; file identity alone is not an exact message match. */
  outbound: {
    exactMessageMatch: boolean;
    unresolvedCandidate: boolean;
    /**
     * RFC 082 §4.6: the event edits a card message's bridged copy. Its echo
     * needs the link at its current epoch and Slack's sender fields naming
     * this installation's bot (slackCardEditEcho.ts), not the ts alone.
     */
    cardEdit?: { ownEcho: boolean };
  };
}): SlackInboundAuthorDecision {
  const cardEdit = input.outbound.cardEdit;
  if (cardEdit ? cardEdit.ownEcho : input.outbound.exactMessageMatch) return { kind: "self_echo" };
  // A card edit that is not provably ours is never our echo: claiming our own
  // App or bot without that proof is a conflict to retain, not a discard.
  const selfEcho = (): SlackInboundAuthorDecision => cardEdit
    ? { kind: "wait", reason: "sender_identity_conflict" } : { kind: "self_echo" };
  const selfAppId = id(input.self.providerAppId);
  if (!selfAppId) return { kind: "wait", reason: "self_identity_unavailable" };
  const profile = input.message.bot_profile == null ? null : record(input.message.bot_profile);
  if ((input.message.bot_profile != null && !profile) || invalidPresent(input.message.bot_id)
    || invalidPresent(input.message.app_id) || (profile && (invalidPresent(profile.id) || invalidPresent(profile.app_id)))) {
    return { kind: "wait", reason: "sender_identity_unavailable" };
  }
  const botId = id(input.message.bot_id);
  const profileBotId = id(profile?.id);
  const appId = id(input.message.app_id);
  const profileAppId = id(profile?.app_id);
  if ((botId && profileBotId && botId !== profileBotId) || (appId && profileAppId && appId !== profileAppId)) {
    return { kind: "wait", reason: "sender_identity_conflict" };
  }
  const senderBotId = botId ?? profileBotId;
  const senderAppId = appId ?? profileAppId;
  const botLike = Boolean(senderBotId || senderAppId || profile || input.message.subtype === "bot_message");
  if (!botLike) {
    const userId = id(input.message.user);
    return userId ? { kind: "human", providerUserId: userId }
      : { kind: "wait", reason: "sender_identity_unavailable" };
  }

  const selfIds = new Set(input.self.selfBotIds);
  if ([...selfIds].some((value) => !id(value))) {
    return { kind: "wait", reason: "self_identity_unavailable" };
  }
  const knownSelf = !!senderBotId && selfIds.has(senderBotId);
  if (senderAppId && senderAppId !== selfAppId && knownSelf) {
    return { kind: "wait", reason: "sender_identity_conflict" };
  }
  if (senderAppId === selfAppId) return selfEcho();
  if (knownSelf) return input.self.identityAvailable ? selfEcho()
    : { kind: "wait", reason: "self_identity_unavailable" };
  if (!senderBotId) return { kind: "wait", reason: "sender_identity_unavailable" };
  if (!senderAppId && (!input.self.identityAvailable || selfIds.size === 0)) {
    return { kind: "wait", reason: "self_identity_unavailable" };
  }
  if (!senderAppId && input.outbound.unresolvedCandidate) {
    return { kind: "wait", reason: "outbound_result_pending" };
  }
  return { kind: "bot", providerBotId: senderBotId, providerUserId: id(input.message.user) };
}
