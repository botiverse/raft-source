import assert from "node:assert/strict";
import { searchAgentKnowledgeDocs } from "./agentKnowledgeService";

// A Built-in agent on a custom gateway model is told in its system prompt that
// Raft defaulted its context window / max output and how to write the real
// values to `.builtin-runtime/models.json`. When it (or someone helping it)
// searches the Manual for that, the runtime topic's section is the answer.
for (const query of [
  "context window",
  "max tokens",
  "default limit",
  "models.json",
  "model limits",
  "max tokens default limit",
  "models.json context window",
  "custom gateway model context window",
]) {
  test(`manual search "${query}" finds the Built-in model limits section`, async () => {
    const results = await searchAgentKnowledgeDocs(query);
    assert.ok(
      results.slice(0, 3).some((result) => result.slug === "runtime"),
      `runtime should be among the top results, got ${results.slice(0, 3).map((result) => result.slug).join(", ")}`,
    );
  });
}
