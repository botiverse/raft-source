import assert from "node:assert/strict";

import { createFailureMessage } from "../src/components/task/createTaskForm";

// The create's refusals a person can act on show in their language. The
// server answers the source message's send refusals with the send's codes
// (services/humanPostAdmission.ts HUMAN_POST_REFUSALS); servers before that
// answered the admission's own names, so both read the same.

const formatMessage = ((descriptor: { id: string }) => descriptor.id) as unknown as Parameters<typeof createFailureMessage>[1];
const refused = (code: string, error = "The server's sentence") => ({ response: { data: { code, error } } });

test("a create refused for membership or a read-only plan shows the translated line, by the current code and the older one", () => {
  assert.equal(createFailureMessage(refused("channel_membership_required"), formatMessage), "task.create.error.joinFirst");
  assert.equal(createFailureMessage(refused("membership_required"), formatMessage), "task.create.error.joinFirst");
  assert.equal(createFailureMessage(refused("channel_read_only"), formatMessage), "task.create.error.readOnly");
  assert.equal(createFailureMessage(refused("quota_read_only"), formatMessage), "task.create.error.readOnly");
});

test("a code the form has no line for shows the server's sentence", () => {
  assert.equal(createFailureMessage(refused("channel_not_found", "Channel not found"), formatMessage), "Channel not found");
});
