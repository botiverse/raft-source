// #wg-rbac:#57: every server site that reads or serializes an agent's runtime
// error text must be classified (projected / manager-only / internal) in
// RUNTIME_ERROR_DETAIL_CLASSIFICATION, and every classified site must exist.
import assert from "node:assert/strict";

import { RUNTIME_ERROR_DETAIL_CLASSIFICATION } from "./runtimeErrorDetailClassification";
import { scanRuntimeErrorDetailSites } from "./runtimeErrorDetailSites";

const VALID = /^(?:projected:\S.*|manager-only: \S.*|internal: \S.*)$/;

test("every runtime error text site in packages/server/src is classified, and every classified site exists", () => {
  const sites = scanRuntimeErrorDetailSites();
  assert.ok(sites.size > 20, "the scan finds the known sites");
  const unlisted = [...sites.keys()].filter((key) => !(key in RUNTIME_ERROR_DETAIL_CLASSIFICATION)).sort();
  assert.deepEqual(unlisted, [], "classify each new site in src/test/runtimeErrorDetailClassification.ts: route it through agentRuntimeErrorVisibility's projection, or say why it is manager-only or internal");
  const stale = Object.keys(RUNTIME_ERROR_DETAIL_CLASSIFICATION).filter((key) => !sites.has(key)).sort();
  assert.deepEqual(stale, [], "remove classified sites that no longer exist");
  for (const [key, why] of Object.entries(RUNTIME_ERROR_DETAIL_CLASSIFICATION)) {
    assert.match(why, VALID, `${key}: a classification is projected:<helper>, manager-only: <why> or internal: <why>`);
  }
});

test("every projected route and push names the projection, and the REST and socket entry points are projected", () => {
  for (const key of [
    "routes/agents.ts#agentRouter.GET /:id",
    "routes/agents.ts#buildAgentListItems",
    "services/agentOrchestrator.ts#AgentOrchestrator.emitActivity",
    "routes/channels.ts#buildChannelMembersView",
    "routes/internal.ts#toServerInfoAgentSummary",
    "routes/internal.ts#buildAgentProfileView",
  ]) {
    assert.match(RUNTIME_ERROR_DETAIL_CLASSIFICATION[key] ?? "", /^projected:/, key);
  }
});
