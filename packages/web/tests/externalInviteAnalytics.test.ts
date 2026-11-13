import assert from "node:assert/strict";
import "./helpers/domSetup";
import { EXTERNAL_INVITE_SEND_ERROR_CODES, validateProductEvent } from "@botiverse/raft-shared";
import {
  createExternalInviteTracker,
  externalInviteEmailsBucket,
  externalInviteSendErrorCode,
  externalInviteSendResult,
  externalInviteServersBucket,
} from "../src/analytics/externalInvites";
import { flushProductEvents, resetProductEventsForTest, setProductEventServerIdGetter } from "../src/analytics/track";
import { ERROR_MESSAGE_IDS } from "../src/components/channel/externalInvites";

// The host's invite-people-outside flow (#wg-rbac:db8d6e83): counts leave as
// buckets, error codes as the fixed list, and one opening closes once.

test("emails and servers are sent as buckets, never as counts", () => {
  assert.deepEqual([0, 1, 2, 5, 6, 20].map(externalInviteEmailsBucket), ["0", "1", "2-5", "2-5", "6-20", "6-20"]);
  assert.equal(externalInviteEmailsBucket(-1), "0");
  assert.deepEqual([0, 1, 2, 7].map(externalInviteServersBucket), ["0", "1", "2+", "2+"]);
});

test("a send that answered is partial when a server was refused or the connect failed as a whole", () => {
  assert.equal(externalInviteSendResult({}), "sent");
  assert.equal(externalInviteSendResult({ servers: [{ state: "connected" }, { state: "connecting" }] }), "sent");
  assert.equal(externalInviteSendResult({ servers: [{ state: "connected" }, { state: "refused" }] }), "partial");
  assert.equal(externalInviteSendResult({ serversFailed: true, servers: [] }), "partial");
});

test("error codes: the ones the dialog has a sentence for, anything else is other", () => {
  assert.deepEqual([...EXTERNAL_INVITE_SEND_ERROR_CODES].sort(), [...Object.keys(ERROR_MESSAGE_IDS), "other"].sort(), "the registry lists the dialog's codes");
  for (const code of Object.keys(ERROR_MESSAGE_IDS)) assert.equal(externalInviteSendErrorCode(code), code);
  assert.equal(externalInviteSendErrorCode("joint_party_limit"), "other");
  assert.equal(externalInviteSendErrorCode("other"), "other");
  assert.equal(externalInviteSendErrorCode(null), "other");
  assert.equal(externalInviteSendErrorCode(undefined), "other");
});

type Sent = { event: string; properties: Record<string, unknown> };

async function recorded(run: () => void): Promise<Sent[]> {
  const batches: Sent[][] = [];
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: (key: string) => (key === "slock_access_token" ? "token-1" : null) },
  });
  resetProductEventsForTest(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/product-events/config")) return new Response(JSON.stringify({ clientEventsAllowed: true }), { status: 200 });
    batches.push((JSON.parse(String(init?.body)) as { events: Sent[] }).events);
    return new Response(JSON.stringify({ accepted: 1 }), { status: 202 });
  });
  setProductEventServerIdGetter(() => "server-1");
  try {
    run();
    await flushProductEvents();
  } finally {
    resetProductEventsForTest();
    setProductEventServerIdGetter(() => undefined);
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  }
  return batches.flat().map(({ event, properties }) => ({ event, properties }));
}

test("one opening: opened once, each review and send, and one close saying where and whether anything was sent", async () => {
  const events = await recorded(() => {
    const tracker = createExternalInviteTracker("existing_channel");
    tracker.opened("members_page_button");
    tracker.opened("add_members_row");
    tracker.reviewed({ emails: 3, servers: 2, historyWarningShown: true, becomesPrivate: false });
    tracker.sendFailed("free_external_limit", true);
    tracker.sendFailed("some_new_code", false);
    tracker.sendSucceeded({ servers: [{ state: "refused" }] });
    tracker.backToInput();
    tracker.closed();
    tracker.closed();
  });
  assert.deepEqual(events, [
    { event: "external_invite_opened", properties: { flow: "existing_channel", entry: "members_page_button" } },
    { event: "external_invite_reviewed", properties: { flow: "existing_channel", emails: "2-5", servers: "2+", history_warning_shown: true, becomes_private: false } },
    { event: "external_invite_send_finished", properties: { flow: "existing_channel", result: "failed", error_code: "free_external_limit", upgrade_offered: true } },
    { event: "external_invite_send_finished", properties: { flow: "existing_channel", result: "failed", error_code: "other", upgrade_offered: false } },
    { event: "external_invite_send_finished", properties: { flow: "existing_channel", result: "partial", upgrade_offered: false } },
    { event: "external_invite_closed", properties: { flow: "existing_channel", stage: "input", sent: true } },
  ]);
  for (const { event, properties } of events) {
    assert.deepEqual(validateProductEvent(event, properties, "web"), { ok: true, event }, "the registry takes what the tracker sends");
  }
});

test("Create Channel: nothing closes for a dialog that never showed External, and its own step is the stage", async () => {
  const events = await recorded(() => {
    createExternalInviteTracker("create_channel").closed("details");
    const tracker = createExternalInviteTracker("create_channel");
    tracker.opened("create_channel_visibility");
    tracker.reviewed({ emails: 0, servers: 1, historyWarningShown: false, becomesPrivate: false });
    tracker.closed("people");
  });
  assert.deepEqual(events, [
    { event: "external_invite_opened", properties: { flow: "create_channel", entry: "create_channel_visibility" } },
    { event: "external_invite_reviewed", properties: { flow: "create_channel", emails: "0", servers: "1", history_warning_shown: false, becomes_private: false } },
    { event: "external_invite_closed", properties: { flow: "create_channel", stage: "people", sent: false } },
  ]);
});
