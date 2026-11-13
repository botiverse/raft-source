import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { isRetractedPreview } from "../src/components/message/delegatedMessage";

// RFC 077: one-line previews (Activity, search) know a message was retracted
// only by the server's placeholder text. If the server's copy changes, this
// fails so the web helper changes with it (or the previews get a flag).
test("the web's retracted-preview check matches the server's placeholder", () => {
  const source = readFileSync(resolve(__dirname, "../../server/src/services/assistantSendAsOwnerService.ts"), "utf8");
  const match = /RETRACTED_DELEGATED_MESSAGE_CONTENT = "([^"]+)"/.exec(source);
  assert.ok(match, "the server constant is still declared");
  assert.equal(isRetractedPreview(match[1]), true);
  assert.equal(isRetractedPreview("This message was retracted"), false);
});
