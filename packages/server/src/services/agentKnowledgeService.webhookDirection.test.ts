import assert from "node:assert/strict";

import { resolveAgentKnowledgeDoc } from "./agentKnowledgeService";

// The page used to say "No API for external services to subscribe to Raft
// events", which App Notifications (Raft -> App, signed webhooks) contradicts.
// The true absence is the other direction: nothing outside a Raft App can POST
// in to wake an agent. The two directions are guarded separately so that fixing
// one sentence cannot silently erase the other.
test("what-raft-doesnt-have separates inbound and outbound webhooks", async () => {
  const doc = await resolveAgentKnowledgeDoc("what-raft-doesnt-have");
  assert.ok(doc, "the topic must resolve");

  assert.doesNotMatch(doc.content, /No API for external services to subscribe to Raft events/,
    "App Notifications is exactly such an API; the old absence claim must not return");
  assert.match(doc.content, /No public inbound webhook\./,
    "the real absence (external system -> agent) must still be stated");
  assert.match(doc.content, /Agent Events API/,
    "the inbound path that does exist must be named");
  assert.match(doc.content, /neither scope is granted by default/,
    "live is not default-on: the scope request must be stated");
  assert.match(doc.content, /Raft sends signed App Notifications webhooks/,
    "the outbound direction must be stated as present");
});
