import assert from "node:assert/strict";
import { parseVerifiedSlackMessage, parseVerifiedSlackReaction } from "./slackVerifiedIngressNormalize";

const event = (body: Record<string, unknown>) => ({ type: "event_callback", api_app_id: "A_RECEIVER",
  team_id: "T_TEST", event_id: "Ev_TEST", event: { type: "message", channel: "C_TEST", ...body } });

test("message time retains Slack milliseconds while its identity keeps the full timestamp", () => {
  const parsed = parseVerifiedSlackMessage(event({ user: "U_HUMAN", ts: "1785931200.123456", text: "hello" }));
  assert.equal(parsed?.createdAt, new Date(1785931200123).toISOString());
  assert.equal(parsed?.providerMessageId, "1785931200.123456");
});

test("an edit containing files is retained for recovery instead of silently ignoring its file set", () => {
  const edited = event({ subtype: "message_changed", event_ts: "1785931205.000999", message: {
    user: "U_HUMAN", ts: "1785931200.123456", text: "edited", edited: { ts: "1785931205.000999" },
    files: [{ id: "F_NEW" }],
  } });
  assert.equal(parseVerifiedSlackMessage(edited), null);
});

test("parses text, thread and file inputs without using the recipient App as author", () => {
  const human = parseVerifiedSlackMessage(event({ user: "U_HUMAN", ts: "1785931200.000100",
    thread_ts: "1785931100.000001", text: "hello <!subteam^SAGENT123|@build-bot>" }));
  assert.ok(human);
  assert.equal(human.providerThreadId, "1785931100.000001");
  assert.deepEqual(human.providerAgentMentions, [{ providerUsergroupId: "SAGENT123", handle: "build-bot" }]);
  assert.equal(human.author.api_app_id, undefined);
  const root = parseVerifiedSlackMessage(event({ user: "U_HUMAN", ts: "1785931200.000100",
    thread_ts: "1785931200.000100", text: "root", files: [] }));
  assert.ok(root);
  assert.equal(root.providerThreadId, null);
  const bot = parseVerifiedSlackMessage(event({ subtype: "bot_message", bot_id: "B_FOREIGN", app_id: "A_FOREIGN",
    ts: "1785931201.000101", files: [{ id: "F_ONE" }] }));
  assert.ok(bot);
  assert.equal(bot.content, "[Attachment]");
  assert.deepEqual(bot.providerFileIds, ["F_ONE"]);
});

test("a text-only edit keeps the original message and thread", () => {
  const result = parseVerifiedSlackMessage(event({ subtype: "message_changed", event_ts: "1785931205.000999",
    message: { user: "U_HUMAN", ts: "1785931200.000100", thread_ts: "1785931100.000001", text: "new text",
      edited: { ts: "1785931205.000999" } } }));
  assert.ok(result);
  assert.equal(result.providerMessageId, "1785931200.000100");
  assert.equal(result.providerThreadId, "1785931100.000001");
  assert.equal(result.providerEditedTs, "1785931205.000999");
  assert.deepEqual(result.providerFileIds, []);
});

test("malformed or unsupported events return no normalized message instead of dropping custody", () => {
  for (const body of [ { subtype: "message_deleted", ts: "1785931200.000100" },
    { subtype: "file_share", ts: "1785931200.000100", text: "missing file" },
    { ts: "bad", text: "body" }, { ts: "1785931200.000100", thread_ts: "bad", text: "body" },
    { ts: "1785931200.000100", files: [{ id: "F_ONE" }, { id: "F_ONE" }] },
    { subtype: "message_changed", message: { ts: "1785931200.000100", text: "edited" } },
  ]) assert.equal(parseVerifiedSlackMessage(event(body)), null);
});

test("parses added and removed reactions with the original event clock", () => {
  const reaction = (type: string, extra: Record<string, unknown> = {}) => ({ type: "event_callback", event: {
    type, user: "U_HUMAN", reaction: "thumbsup", event_ts: "1785931205.001234",
    item: { type: "message", channel: "C_TEST", ts: "1785931200.000100" }, ...extra,
  } });
  const added = parseVerifiedSlackReaction(reaction("reaction_added"));
  assert.deepEqual(added, { kind: "reaction", operation: "add", providerMessageId: "1785931200.000100",
    externalActorId: "U_HUMAN", providerReactionKey: "thumbsup",
    eventOccurredAt: new Date(1785931205001).toISOString(), eventSequence: 1785931205001234 });
  assert.equal(parseVerifiedSlackReaction(reaction("reaction_removed"))?.operation, "remove");
  for (const extra of [ { item: { type: "file", channel: "C_TEST", ts: "1785931200.000100" } },
    { item: { type: "message", ts: "1785931200.000100" } }, { user: "" }, { reaction: "bad emoji" },
    { event_ts: "bad" }, { event_ts: "9999999999.999999" } ]) {
    assert.equal(parseVerifiedSlackReaction(reaction("reaction_added", extra)), null);
  }
});
