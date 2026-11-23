import assert from "node:assert/strict";

import { resolveAgentKnowledgeDoc } from "./agentKnowledgeService";

// `raft proc` (#proj-raft-computer:#114): the standing prompt's Background
// jobs entry sends agents to "the `proc` Manual topic", so it must resolve
// under every documented form (AGENT_KNOWLEDGE_SOURCE_PATHS) and the
// section-qualified one its links use (legacy group map, agent-substrate).
test("proc resolves under its id, the path forms and the section-qualified form", async () => {
  for (const path of ["proc", "agent-knowledge/proc", "manual/agent-knowledge/proc", "agent-knowledge/agent-substrate/proc"]) {
    const doc = await resolveAgentKnowledgeDoc(path);
    assert.ok(doc, `expected ${path} to resolve`);
    assert.equal(doc.docId, "proc", `expected ${path} to resolve to doc_id proc`);
  }
});
