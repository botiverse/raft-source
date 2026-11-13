import assert from "node:assert/strict";
import { resolveAgentKnowledgeDoc } from "./agentKnowledgeService";

// A natural Manual query ("can a custom Connected App send agent-event to wake
// an agent", meichen digest 9/19) ranks the integration topic first, but the
// answer lived only on what-raft-doesnt-have. The integration page must carry
// the answer itself: no public inbound webhook, the App + Agent Events path,
// and the scope gate.
test("integration topic answers how an outside system can wake an agent", async () => {
  const doc = await resolveAgentKnowledgeDoc("integration");
  assert.ok(doc, "the topic must resolve");
  assert.match(doc.content, /Can an outside system \(CI, a GitHub Action, a webhook\) wake or notify an agent\?/);
  assert.match(doc.content, /Raft has no public inbound webhook for arbitrary external systems/);
  assert.match(doc.content, /through the Agent Events API \(experimental\); neither scope is granted by default/);
  assert.match(doc.content, /raft message read --target 'agent-event:<id>'/);
});
