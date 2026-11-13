/**
 * Identity of a Slack request already verified against the active endpoint and
 * signing secret. This is deliberately independent of a binding or installation:
 * those mutable authorities are resolved when the event is processed.
 */
export interface SlackVerifiedIngressAad {
  purpose: "slack-verified-ingress";
  version: 1;
  registrationId: string;
  environment: "test" | "production";
  providerAppId: string;
  providerAuthorityId: string;
  providerEventId: string;
  providerConversationId: string | null;
}

export interface SlackVerifiedIngressPayloadCrypto {
  seal(input: { bytes: Buffer; aad: SlackVerifiedIngressAad }): Promise<{ encryptedPayload: string; envelopeKeyId: string }>;
  open(input: { encryptedPayload: string; envelopeKeyId: string; aad: SlackVerifiedIngressAad }): Promise<Buffer>;
}

// Match the existing Express raw-body limit rather than the smaller normalized
// message limit. The caller verifies the signature first and removes the
// deprecated top-level verification token before serializing these bytes.
export const SLACK_VERIFIED_INGRESS_MAX_BYTES = 1024 * 1024;

function validCoordinate(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0
    && !/[\r\n\0]/u.test(value) && Buffer.byteLength(value, "utf8") <= max;
}

export function isSlackVerifiedIngressAad(value: unknown): value is SlackVerifiedIngressAad {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const aad = value as Record<string, unknown>;
  if (Object.keys(aad).sort().join(",") !== "environment,providerAppId,providerAuthorityId,providerConversationId,providerEventId,purpose,registrationId,version") return false;
  return aad.purpose === "slack-verified-ingress"
    && aad.version === 1
    && (aad.environment === "test" || aad.environment === "production")
    && validCoordinate(aad.registrationId, 320)
    && validCoordinate(aad.providerAppId, 160)
    && validCoordinate(aad.providerAuthorityId, 160)
    && validCoordinate(aad.providerEventId, 320)
    && (aad.providerConversationId === null || validCoordinate(aad.providerConversationId, 160));
}

/**
 * Serialize an envelope whose raw HTTP bytes have already passed signature
 * verification. The deprecated top-level verification token is a credential,
 * not event content, and must never enter durable custody.
 */
export function serializeSlackVerifiedEvent(value: unknown, aad: SlackVerifiedIngressAad): Buffer {
  if (!isSlackVerifiedIngressAad(aad) || !value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid verified Slack event");
  }
  const envelope = value as Record<string, unknown>;
  const authorityId = typeof envelope.team_id === "string" && envelope.team_id.trim()
    ? envelope.team_id : envelope.enterprise_id;
  if (envelope.type !== "event_callback" || envelope.api_app_id !== aad.providerAppId
    || envelope.event_id !== aad.providerEventId || authorityId !== aad.providerAuthorityId
    || !envelope.event || typeof envelope.event !== "object" || Array.isArray(envelope.event)) {
    throw new Error("Invalid verified Slack event identity");
  }
  const event = envelope.event as Record<string, unknown>;
  const item = event.item && typeof event.item === "object" && !Array.isArray(event.item)
    ? event.item as Record<string, unknown> : null;
  if (typeof event.channel === "string" && typeof item?.channel === "string"
    && event.channel !== item.channel) throw new Error("Invalid verified Slack event identity");
  const fileChannel = event.type === "file_shared" && typeof event.channel_id === "string" ? event.channel_id : null;
  if (fileChannel && ((typeof event.channel === "string" && event.channel !== fileChannel)
    || (typeof item?.channel === "string" && item.channel !== fileChannel))) throw new Error("Invalid verified Slack event identity");
  const conversationId = typeof event.channel === "string" ? event.channel
    : typeof item?.channel === "string" ? item.channel : fileChannel;
  if (conversationId !== aad.providerConversationId) throw new Error("Invalid verified Slack event identity");
  const { token: _deprecatedToken, ...credentialFree } = envelope;
  let serialized: string;
  try {
    serialized = JSON.stringify(credentialFree);
  } catch {
    throw new Error("Invalid verified Slack event payload");
  }
  const bytes = Buffer.from(serialized, "utf8");
  if (!bytes.length || bytes.length > SLACK_VERIFIED_INGRESS_MAX_BYTES) {
    throw new Error("Invalid verified Slack event payload");
  }
  return bytes;
}
