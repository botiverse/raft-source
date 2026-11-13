// RFC 082 §4.6: the chat.update a card edit sends, how Slack's answer is
// classified, and the read-back by ts (slackProviderAdapter.ts). No network.
import assert from "node:assert/strict";
import {
  buildSlackCardEditRequest,
  classifySlackCardEditResult,
  readBackSlackCardRevision,
  renderSlackCardEditText,
  SLACK_BRIDGE_CREDENTIAL_LEASE_SCHEMA,
  slackBridgeTextWithinSendRule,
  type SlackBridgeCredentialHandle,
  type SlackJsonObject,
  type SlackProviderAuthorityFence,
  type SlackWebApiRequest,
  type SlackWebApiTransportResult,
} from "./slackProviderAdapter";

const TS = "1793700000.000100";
const authority: SlackProviderAuthorityFence = {
  installId: "install-1", providerAppId: "A_CARD", providerAuthorityId: "T_CARD", providerConversationId: "C_CARD",
  connectionEpoch: 3, credentialRevision: 2, bindingId: "binding-1", bindingEpoch: 4,
};
const credentialHandle: SlackBridgeCredentialHandle = {
  schema: SLACK_BRIDGE_CREDENTIAL_LEASE_SCHEMA, leaseId: "lease-1", installId: "install-1", providerAppId: "A_CARD",
  providerAuthorityId: "T_CARD", connectionEpoch: 3, credentialRevision: 2, leaseExpiresAt: new Date(Date.now() + 60_000),
};
const original = {
  deliveryId: "delivery-1", reconciliationMarker: "M".repeat(43), sourceMessageId: "message-1",
  sourcePermalink: "https://app.slock.ai/s/acme/channel/channel-1?msg=message-1", senderType: "agent" as const,
  connectionEpoch: 3, bindingEpoch: 4,
};

const EVERY_MENTION = "Ready @alice, @here @channel @everyone <@U123ABC> <@W99|bob> <!subteam^S123ABC> <!subteam^S9|team>"
  + " <!here> <!channel> <!everyone> <!here|here> & <https://evil.example|click> done";

test("a card edit renders every mention form as plain text, and no attention survives anywhere in the payload", () => {
  const text = renderSlackCardEditText(EVERY_MENTION);
  assert.equal(text.replaceAll("⁠", ""), EVERY_MENTION.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
    "nothing visible changes beyond Slack's own escaping");
  const request = buildSlackCardEditRequest({ credentialHandle, authority, providerMessageId: TS, content: EVERY_MENTION,
    cardRevision: 5, original });
  assert.ok(request);
  assert.equal(request.method, "chat.update");
  const payload = JSON.stringify(request.body);
  for (const attention of ["<@", "<!", "@alice", "@here", "@channel", "@everyone", "<https://"]) {
    assert.ok(!payload.includes(attention), `no ${attention} anywhere in the chat.update body`);
  }
  assert.deepEqual(Object.keys(request.body).sort(), ["channel", "link_names", "metadata", "parse", "text", "ts"],
    "text plus metadata: no blocks, attachments, files, username or icon");
  assert.deepEqual(request.body.metadata, {
    event_type: "raft_message",
    event_payload: {
      delivery_id: "delivery-1", reconciliation_marker: "M".repeat(43), source_message_id: "message-1",
      source_permalink: original.sourcePermalink, source_sender_type: "agent", connection_epoch: 3, binding_epoch: 4,
      card_revision: 5,
    },
  });
  assert.equal(request.body.channel, "C_CARD");
  assert.equal(request.body.ts, TS);
});

test("the send path's Slack length rule applies to the new fallback; no request is built past it", () => {
  assert.equal(slackBridgeTextWithinSendRule("x".repeat(40_000)), true);
  assert.equal(slackBridgeTextWithinSendRule("x".repeat(40_001)), false);
  assert.equal(slackBridgeTextWithinSendRule("é".repeat(20_001)), false, "UTF-8 bytes, as the send path counts them");
  assert.equal(slackBridgeTextWithinSendRule("a\0b"), false);
  assert.equal(buildSlackCardEditRequest({ credentialHandle, authority, providerMessageId: TS, content: "x".repeat(40_001),
    cardRevision: 2, original }), null);
  assert.equal(buildSlackCardEditRequest({ credentialHandle, authority, providerMessageId: "guessed", content: "x",
    cardRevision: 2, original }), null, "never a guessed Slack id");
  assert.equal(buildSlackCardEditRequest({ credentialHandle, authority, providerMessageId: TS, content: "x",
    cardRevision: 1, original }), null, "revision 1 is the original's frozen text, never an edit");
});

function response(body: SlackJsonObject, status = 200, observedAuthority = { providerAppId: "A_CARD", providerAuthorityId: "T_CARD" }): SlackWebApiTransportResult {
  return { kind: "response", status, headers: { "retry-after": "7" }, body, observedAuthority };
}

test("Slack's answer to chat.update: only a matching receipt succeeds, msg_too_long is a refusal, unknown stays unknown", () => {
  const expected = { authority, providerMessageId: TS };
  const kind = (result: SlackWebApiTransportResult) => classifySlackCardEditResult(result, expected);
  assert.deepEqual(kind(response({ ok: true, channel: "C_CARD", ts: TS })), { kind: "succeeded" });
  assert.equal(kind(response({ ok: true, channel: "C_CARD", ts: "1793700000.000200" })).kind, "unknown");
  assert.equal(kind(response({ ok: true, channel: "C_OTHER", ts: TS })).kind, "unknown");
  assert.deepEqual(kind(response({ ok: false, error: "msg_too_long" })), { kind: "refused", reason: "msg_too_long" });
  assert.deepEqual(kind(response({ ok: false, error: "message_not_found" })), { kind: "message_not_found" });
  assert.deepEqual(kind(response({ ok: false, error: "cant_update_message" })), { kind: "identity_changed", reason: "slack_cant_update_message" });
  assert.equal(kind(response({ ok: true, channel: "C_CARD", ts: TS }, 200, { providerAppId: "A_OTHER", providerAuthorityId: "T_CARD" })).kind,
    "identity_changed", "another App answered: never ours");
  for (const [error, reason] of [["channel_not_found", "slack_channel_not_found"], ["not_in_channel", "slack_not_in_channel"],
    ["missing_scope", "slack_permission_missing"], ["no_permission", "slack_permission_missing"], ["is_archived", "slack_channel_archived"],
    ["invalid_auth", "provider_credential_revoked"], ["is_inactive", "slack_channel_inactive"],
    ["restricted_action_read_only_channel", "slack_channel_restricted"], ["ekm_access_denied", "slack_permission_missing"]] as const) {
    assert.deepEqual(kind(response({ ok: false, error })), { kind: "kept", reason }, `${error}: a recoverable state, never a refusal`);
  }
  for (const error of ["msg_too_long", "no_text", "invalid_metadata_format", "msg_blocks_too_long"]) {
    assert.deepEqual(kind(response({ ok: false, error })), { kind: "refused", reason: error }, `${error}: a content-level refusal`);
  }
  assert.deepEqual(kind(response({ ok: false, error: "ratelimited" }, 429)), { kind: "not_sent", reason: "slack_rate_limited", retryAfterMs: 7_000 });
  assert.equal(kind({ kind: "transport_failure", phase: "before_send", code: "dns" }).kind, "not_sent");
  for (const phase of ["after_send", "unknown"] as const) {
    assert.equal(kind({ kind: "transport_failure", phase, code: "timeout" }).kind, "unknown", phase);
  }
  for (const error of ["internal_error", "fatal_error", "something_new"]) {
    assert.equal(kind(response({ ok: false, error })).kind, "unknown", error);
  }
  assert.equal(kind(response({ ok: false, error: "invalid_arguments" }, 503)).kind, "unknown");
});

function readBackTransport(result: SlackWebApiTransportResult) {
  const calls: SlackWebApiRequest[] = [];
  return { calls, transport: { evidence: "double" as const, async call(request: SlackWebApiRequest) { calls.push(request); return result; } } };
}

const shown = (message: SlackJsonObject) => response({ ok: true, messages: [message] });
const ours = (payload: SlackJsonObject) => ({ ts: TS, app_id: "A_CARD", text: "x",
  metadata: { event_type: "raft_message", event_payload: { delivery_id: "delivery-1", ...payload } } });

test("a read-back by ts says which card_revision Slack shows, and only for the bridge App's own message", async () => {
  const read = async (result: SlackWebApiTransportResult, thread: string | null = null) => {
    const double = readBackTransport(result);
    const outcome = await readBackSlackCardRevision({ transport: double.transport, credentialHandle, authority,
      providerMessageId: TS, providerThreadId: thread, deliveryId: "delivery-1" });
    return { outcome, request: double.calls[0]! };
  };
  const top = await read(shown(ours({ card_revision: 4 })));
  assert.deepEqual(top.outcome, { kind: "shown", revision: 4 });
  assert.equal(top.request.method, "conversations.history");
  assert.deepEqual(top.request.body, { channel: "C_CARD", latest: TS, oldest: TS, inclusive: true, limit: 1, include_all_metadata: true });
  const reply = await read(response({ ok: true, messages: [{ ts: "1793690000.000001", app_id: "A_CARD" }, ours({ card_revision: 2 })] }),
    "1793690000.000001");
  assert.deepEqual(reply.outcome, { kind: "shown", revision: 2 });
  assert.equal(reply.request.method, "conversations.replies");
  assert.equal(reply.request.body.ts, "1793690000.000001");
  assert.deepEqual((await read(shown(ours({})))).outcome, { kind: "shown", revision: 1 }, "no card_revision: the original's first text");
  assert.deepEqual((await read(shown({ ...ours({ card_revision: 4 }), app_id: "A_OTHER" }))).outcome,
    { kind: "unreadable", reason: "readback_author_conflict" }, "metadata anyone can copy is not proof; Slack's app_id is");
  assert.deepEqual((await read(shown({ ts: TS, app_id: "A_CARD", metadata: { event_type: "raft_message",
    event_payload: { delivery_id: "another", card_revision: 4 } } }))).outcome, { kind: "unreadable", reason: "readback_delivery_conflict" });
  assert.deepEqual((await read(response({ ok: true, messages: [] }))).outcome, { kind: "unreadable", reason: "readback_message_missing" });
  assert.deepEqual((await read(shown({ ts: TS, app_id: "A_CARD" }))).outcome, { kind: "unreadable", reason: "readback_metadata_missing" });
  assert.deepEqual((await read(response({ ok: false, error: "channel_not_found" }))).outcome,
    { kind: "unreadable", reason: "readback_channel_not_found" });
  assert.deepEqual((await read(response({ ok: false, error: "ratelimited" }, 429))).outcome,
    { kind: "retry", reason: "readback_rate_limited", retryAfterMs: 7_000 });
});
