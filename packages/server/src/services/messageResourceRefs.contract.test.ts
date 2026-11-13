import assert from "node:assert/strict";
import { extractRaftMentionHandles, extractRaftRefTargets } from "@botiverse/raft-shared";
import { renderAgentVisibleMessageContent, summarizeForSystemMessage } from "./messageService";

// composer_resource_references_v0 was dropped (#13599). Text that looks like a
// Computer or App reference is ordinary text: it never stops a message from
// sending, and nothing on the content path chokes on it or reads a mention
// out of it.
const COMPUTER_ID = "550e8400-e29b-41d4-a716-446655440000";
const LOOKALIKES = [
  "see <app:…> here",
  "use <app:key/ref> as a placeholder",
  "bad [@Desk](<computer:not-a-uuid>)",
  `[@Desk](<computer:${COMPUTER_ID}>)`,
  "[@Reminder](<app:system.reminder>)",
  `<computer:${COMPUTER_ID}> and <app:system.reminder>`,
  "literal \\<app:not-valid>",
];

test("text that looks like a Computer or App reference passes the content path untouched", () => {
  for (const content of LOOKALIKES) {
    assert.doesNotThrow(() => extractRaftRefTargets(content), content);
    assert.deepEqual(extractRaftMentionHandles(content), [], `${content}: no mention is read out of it`);
    assert.equal(summarizeForSystemMessage(content, 1000), content, content);
    assert.equal(
      renderAgentVisibleMessageContent({ senderType: "user", content }, content),
      content,
      `${content}: agents read it as typed`,
    );
  }
});

test("ordinary prose, mentions and code spans are unaffected", () => {
  assert.deepEqual(extractRaftMentionHandles("hello @Alice in #general"), ["Alice"]);
  assert.deepEqual(extractRaftMentionHandles(`\`<computer:${COMPUTER_ID}>\``), []);
});
