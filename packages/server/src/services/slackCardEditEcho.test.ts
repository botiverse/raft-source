// RFC 082 §4.6 "Our own echo" (§8 Echo): a verified edit event on a card
// message's copy is our echo only with its link at the current installation,
// workspace, channel and binding epoch, and Slack's sender fields naming this
// installation's bot. A copied card_revision marker, a wrong binding epoch and
// an unverifiable identity go through the safe inbound handling.
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";

import { dbTest as test } from "../test/integration/dbTest";
import { messages } from "../db/schema";
import { APP, CONVERSATION, seedSlackCardEditFixture, TEAM, TS } from "../test/slackCardEditFixture";
import { isSlackCardEditSenderOurBot, readSlackCardEditEchoLink } from "./slackCardEditEcho";
import { classifyVerifiedSlackInboundAuthor } from "./slackInboundAuthor";

const SELF = { providerAppId: APP, identityAvailable: true, selfBotIds: ["B_BOT"] };
const ours = { bot_id: "B_BOT", app_id: APP, bot_profile: { id: "B_BOT", app_id: APP } };
const copied = { bot_id: "B_COPYCAT", app_id: "A_COPYCAT", bot_profile: { id: "B_COPYCAT", app_id: "A_COPYCAT" },
  metadata: { event_type: "raft_message", event_payload: { card_revision: 3, delivery_id: "copied" } } };

test("Slack's own sender fields decide whether an edit is this installation's bot; content never does", () => {
  assert.equal(isSlackCardEditSenderOurBot({ message: ours, providerAppId: APP, selfBotId: "B_BOT" }), true);
  assert.equal(isSlackCardEditSenderOurBot({ message: { bot_id: "B_BOT" }, providerAppId: APP, selfBotId: "B_BOT" }), true);
  assert.equal(isSlackCardEditSenderOurBot({ message: copied, providerAppId: APP, selfBotId: "B_BOT" }), false,
    "a copied card_revision marker from another app or bot");
  assert.equal(isSlackCardEditSenderOurBot({ message: { app_id: APP }, providerAppId: APP, selfBotId: "B_BOT" }), false,
    "no bot identity reported");
  assert.equal(isSlackCardEditSenderOurBot({ message: ours, providerAppId: APP, selfBotId: null }), false,
    "the installation's bot identity cannot be verified");
  for (const conflicting of [{ ...ours, bot_profile: { id: "B_OTHER", app_id: APP } }, { ...ours, app_id: "A_OTHER" },
    { ...ours, bot_profile: "spoofed" }, { ...ours, bot_id: " B_BOT" }]) {
    assert.equal(isSlackCardEditSenderOurBot({ message: conflicting, providerAppId: APP, selfBotId: "B_BOT" }), false);
  }
});

test("a card edit is our echo only when proven; otherwise our own claimed identity is retained and a foreign bot is a bot", () => {
  const outbound = (ownEcho: boolean) => ({ exactMessageMatch: true, unresolvedCandidate: false, cardEdit: { ownEcho } });
  assert.deepEqual(classifyVerifiedSlackInboundAuthor({ message: ours, self: SELF, outbound: outbound(true) }), { kind: "self_echo" });
  for (const message of [ours, { bot_id: "B_BOT" }, { app_id: APP, bot_id: "B_NEW" }]) {
    assert.deepEqual(classifyVerifiedSlackInboundAuthor({ message, self: SELF, outbound: outbound(false) }),
      { kind: "wait", reason: "sender_identity_conflict" }, "never silently accepted as our echo");
  }
  assert.deepEqual(classifyVerifiedSlackInboundAuthor({ message: copied, self: SELF, outbound: outbound(false) }),
    { kind: "bot", providerBotId: "B_COPYCAT", providerUserId: null });
  assert.deepEqual(classifyVerifiedSlackInboundAuthor({ message: { bot_id: "B_X" }, self: SELF,
    outbound: { exactMessageMatch: true, unresolvedCandidate: false } }), { kind: "self_echo" },
  "an ordinary bridged message keeps its exact-receipt echo");
});

test("the card edit echo link: the original's stored link, at its current binding and connection epoch", async ({ db }) => {
  const fixture = await seedSlackCardEditFixture(db);
  const scope = { installId: fixture.install.id, providerAuthorityId: TEAM, providerConversationId: CONVERSATION,
    providerMessageId: TS, current: { bindingId: fixture.binding.id, bindingEpoch: 1, connectionEpoch: 1 } };
  assert.deepEqual(await readSlackCardEditEchoLink(db, scope), { currentEpoch: true });
  assert.deepEqual(await readSlackCardEditEchoLink(db, { ...scope, current: { ...scope.current, bindingEpoch: 2 } }),
    { currentEpoch: false }, "a wrong binding epoch is not our echo");
  assert.deepEqual(await readSlackCardEditEchoLink(db, { ...scope, current: { ...scope.current, connectionEpoch: 2 } }),
    { currentEpoch: false });
  assert.equal(await readSlackCardEditEchoLink(db, { ...scope, providerMessageId: "1793700000.000999" }), null,
    "another message (a copied marker on another bot's post) has no link");
  assert.equal(await readSlackCardEditEchoLink(db, { ...scope, providerConversationId: "C_OTHER" }), null);
  await db.update(messages).set({ actionMetadata: null }).where(eq(messages.id, fixture.message.id));
  assert.equal(await readSlackCardEditEchoLink(db, scope), null, "an ordinary message keeps the ordinary echo rule");
});
