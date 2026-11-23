import assert from "node:assert/strict";
import type { IntlShape } from "react-intl";
import { claudeLimitResetRefusal, claudeLimitResetsNotSupportedHere } from "../src/features/computer/claudeLimitResetCopy";

// OAR 0.114: Claude Code stopped at a first-run page the Computer does not
// complete. The Computer can still use resets once Claude Code is opened there,
// so the card keeps offering them and the person is told what to do, not
// "try again" (nothing would change) and not "not supported here".
test("an unfinished first-run setup asks the person to open Claude Code once on the Computer, and keeps resets offered", () => {
  const onboarding = { kind: "unsupported", reason: "onboarding_required" } as const;
  assert.equal(claudeLimitResetsNotSupportedHere(onboarding), false);
  const formatMessage = (({ id }: { id: string }) => id) as unknown as IntlShape["formatMessage"];
  for (const atFiveHourLimit of [false, true]) {
    assert.equal(claudeLimitResetRefusal(formatMessage, "weekly", onboarding, atFiveHourLimit), "machine.runtimeUsage.claudeReset.onboardingRequired");
  }
  assert.equal(claudeLimitResetRefusal(formatMessage, "weekly", { kind: "unsupported", reason: "not_attempted" }, false), "machine.runtimeUsage.claudeReset.notAttempted");
});
