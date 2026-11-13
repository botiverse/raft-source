import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { isSlackVerifiedIngressAad, serializeSlackVerifiedEvent, SLACK_VERIFIED_INGRESS_MAX_BYTES, type SlackVerifiedIngressAad } from "./slackVerifiedIngressContracts";
import { openSlackVerifiedIngress, sealSlackVerifiedIngress } from "./slackVerifiedIngressCrypto";

const aad: SlackVerifiedIngressAad = {
  purpose: "slack-verified-ingress",
  version: 1,
  registrationId: "registration-1",
  environment: "test",
  providerAppId: "A123",
  providerAuthorityId: "T123",
  providerEventId: "Ev123",
  providerConversationId: "C123",
};
const key = Buffer.alloc(32, 7);

test("verified request bytes round-trip without plaintext in storage, through the existing body limit", () => {
  const bytes = randomBytes(SLACK_VERIFIED_INGRESS_MAX_BYTES);
  const envelope = sealSlackVerifiedIngress({ bytes, key, aad });
  assert.deepEqual(openSlackVerifiedIngress({ envelope, key, aad }), bytes);
  const smaller = Buffer.from("private message body with non-ASCII: 中文\0");
  const smallEnvelope = sealSlackVerifiedIngress({ bytes: smaller, key, aad });
  assert.ok(!smallEnvelope.includes("private message body"));
  assert.deepEqual(openSlackVerifiedIngress({ envelope: smallEnvelope, key, aad }), smaller);
  assert.notEqual(smallEnvelope, sealSlackVerifiedIngress({ bytes: smaller, key, aad }));
  assert.throws(() => sealSlackVerifiedIngress({ bytes: Buffer.alloc(SLACK_VERIFIED_INGRESS_MAX_BYTES + 1), key, aad }));
});

test("verified request ciphertext is bound to every authority coordinate and rejects tampering", () => {
  const envelope = sealSlackVerifiedIngress({ bytes: Buffer.from("private"), key, aad });
  for (const changed of [
    { ...aad, registrationId: "registration-2" },
    { ...aad, environment: "production" as const },
    { ...aad, providerAppId: "A456" },
    { ...aad, providerAuthorityId: "T456" },
    { ...aad, providerEventId: "Ev456" },
    { ...aad, providerConversationId: "C456" },
    { ...aad, providerConversationId: null },
  ]) assert.throws(() => openSlackVerifiedIngress({ envelope, key, aad: changed }));
  assert.throws(() => openSlackVerifiedIngress({ envelope, key: Buffer.alloc(32, 8), aad }));
  const parsed = JSON.parse(envelope) as { ciphertext: string };
  const bytes = Buffer.from(parsed.ciphertext, "base64url");
  bytes[0] ^= 1;
  parsed.ciphertext = bytes.toString("base64url");
  assert.throws(() => openSlackVerifiedIngress({ envelope: JSON.stringify(parsed), key, aad }));
  assert.throws(() => openSlackVerifiedIngress({ envelope: envelope.slice(0, -1), key, aad }));
});

test("authority validation rejects missing, extra and malformed event coordinates", () => {
  assert.equal(isSlackVerifiedIngressAad(aad), true);
  assert.equal(isSlackVerifiedIngressAad(null), false);
  assert.equal(isSlackVerifiedIngressAad({ ...aad, providerEventId: "" }), false);
  assert.equal(isSlackVerifiedIngressAad({ ...aad, providerConversationId: "C\n123" }), false);
  assert.equal(isSlackVerifiedIngressAad({ ...aad, bindingId: "invented" }), false);
  assert.equal(isSlackVerifiedIngressAad({ ...aad, providerConversationId: null }), true);
});

test("stored event strips Slack's verification token and rejects identity mismatches", () => {
  const event = { type: "event_callback", api_app_id: "A123", team_id: "T123", event_id: "Ev123",
    token: "legacy-secret", event: { type: "message", channel: "C123", text: "private body" } };
  const bytes = serializeSlackVerifiedEvent(event, aad);
  assert.equal(bytes.includes("legacy-secret"), false);
  assert.equal((JSON.parse(bytes.toString("utf8")) as { event: { text: string } }).event.text, "private body");
  assert.throws(() => serializeSlackVerifiedEvent({ ...event, team_id: "T456" }, aad));
  assert.throws(() => serializeSlackVerifiedEvent({ ...event, event: { ...event.event, channel: "C456" } }, aad));
  assert.throws(() => serializeSlackVerifiedEvent({ ...event, event_id: "Ev456" }, aad));
  const encrypted = sealSlackVerifiedIngress({ bytes, key, aad });
  assert.ok(!encrypted.includes("legacy-secret") && !encrypted.includes("private body"));
});

test("file_shared retains its verified channel and rejects conflicting channel identities", () => {
  const event = { type: "event_callback", api_app_id: "A123", team_id: "T123", event_id: "Ev123",
    event: { type: "file_shared", channel_id: "C123", file_id: "F123" } };
  assert.ok(serializeSlackVerifiedEvent(event, aad).length > 0);
  assert.throws(() => serializeSlackVerifiedEvent({ ...event, event: { ...event.event, channel: "C_OTHER" } }, aad));
  assert.throws(() => serializeSlackVerifiedEvent(event, { ...aad, providerConversationId: null }));
});
