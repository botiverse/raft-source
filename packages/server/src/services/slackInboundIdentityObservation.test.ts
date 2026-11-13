import assert from "node:assert/strict";
import { summarizeSlackInboundIdentity } from "./slackInboundIdentityObservation";

test("observation contains only booleans and distinguishes text from file bot events", () => {
  const input = { providerAppId: "A_SELF", selfBotIds: ["B_SELF"], selfUserIds: ["U_SELF"] };
  const summary = summarizeSlackInboundIdentity({ ...input, message: {
    subtype: "bot_message", bot_id: "B_SELF", app_id: "A_SELF", text: "private body",
  } });
  assert.deepEqual(summary, { isRecognizedBot: true, userIdMatchesHistory: false, hasSenderAppId: true, senderAppIdMatches: true, senderAppIdsConflict: false,
    hasBotId: true, botIdMatchesHistory: true, hasText: true, hasFiles: false });
  assert.ok(Object.values(summary!).every(value => typeof value === "boolean"));
  assert.deepEqual(summarizeSlackInboundIdentity({ ...input, message: { bot_profile: { id: "B_OTHER", app_id: "A_OTHER" }, files: [{}] } }),
    { isRecognizedBot: true, userIdMatchesHistory: false, hasSenderAppId: true, senderAppIdMatches: false, senderAppIdsConflict: false,
      hasBotId: true, botIdMatchesHistory: false, hasText: false, hasFiles: true });
  assert.equal(summarizeSlackInboundIdentity({ ...input, message: { user: "U_HUMAN", text: "body" } }).isRecognizedBot, false);
  const bareSelf = summarizeSlackInboundIdentity({ ...input, message: { user: "U_SELF", text: "body" } });
  assert.equal(bareSelf.isRecognizedBot, true);
  assert.equal(bareSelf.userIdMatchesHistory, true);
  assert.equal(bareSelf.hasSenderAppId, false);
  assert.equal(bareSelf?.hasBotId, false);
  const conflict = summarizeSlackInboundIdentity({ ...input, message: { bot_id: "B_SELF", app_id: "A_SELF",
    bot_profile: { id: "B_SELF", app_id: "A_OTHER" } } });
  assert.equal(conflict?.senderAppIdsConflict, true);
  assert.equal(conflict?.senderAppIdMatches, false);
});
