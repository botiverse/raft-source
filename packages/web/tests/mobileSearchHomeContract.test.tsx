import assert from "node:assert/strict";
import { isValidElement } from "react";

import { __testInternals } from "../src/components/layout/MainLayout";

test("Search agent and human profile pages return to their owning result list", () => {
  const closeSlot = () => {};

  const agent = __testInternals.renderContentSlot(
    { kind: "agent", id: "agent-1" },
    closeSlot,
  );
  assert.ok(isValidElement<{ agentId: string; onBack: () => void }>(agent));
  assert.equal(agent.props.agentId, "agent-1");
  assert.equal(agent.props.onBack, closeSlot);

  const human = __testInternals.renderContentSlot(
    { kind: "human", id: "user-1" },
    closeSlot,
  );
  assert.ok(isValidElement<{ userId: string; onBack: () => void }>(human));
  assert.equal(human.props.userId, "user-1");
  assert.equal(human.props.onBack, closeSlot);
});
