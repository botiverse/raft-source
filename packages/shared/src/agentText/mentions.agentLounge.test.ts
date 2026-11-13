// Agent Lounge (#proj-chat:#15): an agent mentioned in another agent's lounge
// is never deliverable, so the send result offers no recovery for it.
import assert from "node:assert/strict";

import { AGENT_LOUNGE_EXCLUDED_MENTION_REASON, formatAgentPendingMentionActions } from "./mentions";

test("a lounge-excluded mention says why and offers no notify", () => {
  const id = "00000000-1111-2222-3333-444444444444";
  const text = formatAgentPendingMentionActions([
    { resolutionId: id, messageId: "m-1", targetType: "agent", targetHandle: "bob", reason: AGENT_LOUNGE_EXCLUDED_MENTION_REASON, availableActions: [], expiresAt: null },
  ], { source: "send" });
  assert.ok(text.includes("- @bob — status=not_queued\n  reason: lounge_agent_excluded\n"), text);
  assert.ok(text.includes("  pending action: none; only this lounge's own agent takes part here"), text);
  assert.ok(!text.includes(id), "no pending action id to act on");
});
