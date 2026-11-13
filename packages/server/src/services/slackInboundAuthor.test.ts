import assert from "node:assert/strict";
import { classifyVerifiedSlackInboundAuthor as classifyImpl } from "./slackInboundAuthor";

const classify = (input: Omit<Parameters<typeof classifyImpl>[0], "outbound"> & Partial<Pick<Parameters<typeof classifyImpl>[0], "outbound">>) =>
  classifyImpl({ ...input, outbound: input.outbound ?? { exactMessageMatch: false, unresolvedCandidate: false } });

const self = { providerAppId: "A_SELF", identityAvailable: true,
  selfBotIds: ["B_CURRENT", "B_SECOND_INSTALL"] };
const wait = (reason: "self_identity_unavailable" | "sender_identity_unavailable" | "sender_identity_conflict" | "outbound_result_pending") => ({ kind: "wait", reason });

test("sender App ID identifies self and foreign bots, including profile-only IDs", () => {
  for (const message of [
    { subtype: "bot_message", app_id: "A_SELF", bot_id: "B_NEW" },
    { subtype: "bot_message", bot_profile: { app_id: "A_SELF", id: "B_NEW" } },
    { subtype: "bot_message", app_id: "A_SELF" },
  ]) assert.deepEqual(classify({ self, message }), { kind: "self_echo" });
  for (const message of [
    { subtype: "bot_message", app_id: "A_OTHER", bot_id: "B_OTHER" },
    { subtype: "bot_message", bot_profile: { app_id: "A_OTHER", id: "B_OTHER" } },
  ]) assert.deepEqual(classify({ self, message }), { kind: "bot", providerBotId: "B_OTHER", providerUserId: null });
});

test("no-App-ID bots use current installation receipts, never user or IDs observed in messages", () => {
  for (const botId of ["B_CURRENT", "B_SECOND_INSTALL"]) {
    assert.deepEqual(classify({ self, message: { bot_id: botId, user: "U_DIFFERENT" } }), { kind: "self_echo" });
  }
  assert.deepEqual(classify({ self, message: { bot_id: "B_OTHER", user: "U_OLD" } }),
    { kind: "bot", providerBotId: "B_OTHER", providerUserId: "U_OLD" });
  // A retired installation's uncorrelated bot may deliberately be treated as
  // foreign. Without an App ID or an outbound receipt it can duplicate a
  // historic self message, but event observations do not expand the set.
  assert.deepEqual(classify({ self, message: { bot_id: "B_RETIRED" } }),
    { kind: "bot", providerBotId: "B_RETIRED", providerUserId: null });
  assert.deepEqual(classify({ self: { ...self, identityAvailable: false }, message: { bot_id: "B_OTHER" } }), wait("self_identity_unavailable"));
  assert.deepEqual(classify({ self: { ...self, selfBotIds: [] }, message: { bot_id: "B_OTHER" } }), wait("self_identity_unavailable"));
  assert.deepEqual(classify({ self: { ...self, identityAvailable: false }, message: { bot_id: "B_CURRENT" } }), wait("self_identity_unavailable"));
  assert.deepEqual(classify({ self: { ...self, identityAvailable: false }, message: { app_id: "A_SELF" } }), { kind: "self_echo" });
});

test("independently verified conflicting or malformed sender evidence is retained", () => {
  for (const message of [
    { app_id: "A_OTHER", bot_id: "B_CURRENT" },
    { bot_id: "B_ONE", bot_profile: { id: "B_TWO" } },
    { app_id: "A_ONE", bot_profile: { app_id: "A_TWO" } },
  ]) assert.deepEqual(classify({ self, message }), wait("sender_identity_conflict"));
  for (const message of [{ bot_id: " " }, { app_id: "\u200f" }, { bot_profile: "bad" }, { subtype: "bot_message" }, { app_id: "A_OTHER" }]) {
    assert.deepEqual(classify({ self, message }), wait("sender_identity_unavailable"));
  }
  assert.deepEqual(classify({ self: { ...self, providerAppId: "" }, message: { bot_id: "B_OTHER" } }), wait("self_identity_unavailable"));
  assert.deepEqual(classify({ self: { ...self, selfBotIds: [" "] }, message: { bot_id: "B_OTHER" } }), wait("self_identity_unavailable"));
});

test("human messages remain human; a bot user field is display-only metadata", () => {
  assert.deepEqual(classify({ self, message: { user: "U_HUMAN" } }), { kind: "human", providerUserId: "U_HUMAN" });
  assert.deepEqual(classify({ self, message: { user: "" } }), wait("sender_identity_unavailable"));
  assert.deepEqual(classify({ self, message: { bot_id: "B_OTHER", app_id: "A_OTHER", user: "\u200f" } }),
    { kind: "bot", providerBotId: "B_OTHER", providerUserId: null });
});


test("exact outbound message wins, but a pending ambiguous send retains only no-App-ID unknown bots", () => {
  const pending = { exactMessageMatch: false, unresolvedCandidate: true };
  assert.deepEqual(classify({ self, outbound: { exactMessageMatch: true, unresolvedCandidate: true }, message: { bot_id: "B_OTHER" } }), { kind: "self_echo" });
  assert.deepEqual(classify({ self, outbound: pending, message: { bot_id: "B_SECOND_INSTALL" } }), { kind: "self_echo" });
  assert.deepEqual(classify({ self, outbound: pending, message: { app_id: "A_SELF", bot_id: "B_CURRENT" } }), { kind: "self_echo" });
  assert.deepEqual(classify({ self, outbound: pending, message: { app_id: "A_OTHER", bot_id: "B_OTHER" } }),
    { kind: "bot", providerBotId: "B_OTHER", providerUserId: null });
  assert.deepEqual(classify({ self, outbound: pending, message: { bot_id: "B_OTHER" } }), wait("outbound_result_pending"));
  assert.deepEqual(classify({ self, outbound: { exactMessageMatch: false, unresolvedCandidate: false }, message: { bot_id: "B_OTHER" } }),
    { kind: "bot", providerBotId: "B_OTHER", providerUserId: null });
});
