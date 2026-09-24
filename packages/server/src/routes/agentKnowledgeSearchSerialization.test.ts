import { test } from "vitest";
import assert from "node:assert/strict";
import { serializeKnowledgeSearch } from "./agentKnowledge.js";
import type { AgentKnowledgeSearchResult } from "../services/agentKnowledgeService.js";

const result: AgentKnowledgeSearchResult = {
  slug: "channel",
  title: "Channels",
  firstScreen: "About channels.",
  docVersion: "sha256:deadbeef",
  docState: "published",
  matchedTerms: ["chanel"],
  correctedTerms: [{ term: "chanel", matched: "channel" }],
};

test("the agent-facing search payload carries the match reasons", () => {
  // The defect this pins: the service computed matchedTerms/correctedTerms
  // while this serializer destructured only slug/title/firstScreen, so no
  // agent ever saw a reason. Deleting either field from the serializer turns
  // this red.
  const payload = serializeKnowledgeSearch("chanel", null, [result]);
  assert.equal(payload.results.length, 1);
  const [served] = payload.results;
  assert.deepEqual(served.matchedTerms, ["chanel"]);
  assert.deepEqual(served.correctedTerms, [{ term: "chanel", matched: "channel" }]);
});

test("the payload does not leak internal scoring fields", () => {
  // Additive, not indiscriminate: docVersion/docState stay internal to the
  // search surface, so a blanket spread would be caught here.
  const [served] = serializeKnowledgeSearch("chanel", null, [result]).results;
  assert.deepEqual(
    Object.keys(served).sort(),
    ["correctedTerms", "firstScreen", "matchedTerms", "slug", "title"],
  );
});
