import assert from "node:assert/strict";
import { claudeLimitResetsNotSupportedHere, claudeLimitResetsNotSupportedMessageId } from "../src/features/computer/claudeLimitResetCopy";

// #otter-lounge:#1: Claude Code answering "Unknown command: /limit-reset"
// (`endpoint_unavailable`) is the account, not the Computer: say where it can reset.
test("an account without the command is told to reset on claude.ai, Desktop or mobile; other refusals keep their sentence", () => {
  const notEnabled = { kind: "unsupported", reason: "endpoint_unavailable" } as const;
  assert.equal(claudeLimitResetsNotSupportedHere(notEnabled), true);
  assert.equal(claudeLimitResetsNotSupportedMessageId(notEnabled), "machine.runtimeUsage.claudeReset.notEnabledForAccount");
  assert.equal(claudeLimitResetsNotSupportedMessageId({ kind: "unsupported", reason: "unsupported_platform" }), "machine.runtimeUsage.claudeReset.notSupportedHere");
});
