import { test } from "vitest";
import assert from "node:assert/strict";
import { searchAgentKnowledgeDocs, resolveAgentKnowledgeDoc } from "./agentKnowledgeService.js";

// Regression: `raft manual search 联合频道` returned knowledge_not_found in production while
// `raft manual get 联合频道` resolved, for the same alias in the same served build.
//
// Root cause was NOT the alias. `tokenizeSearchText` splits on /[^a-z0-9]+/ and drops parts
// shorter than 3 chars, so a CJK / emoji / <=2-char query tokenizes to ZERO terms. The
// relevance floor then requires `matchedTerms.size >= 1` before any score survives, so it
// discarded the exact-alias hit (+1000) — a perfect identifier match and a total non-match
// were indistinguishable to that gate. `get` never hits the scorer, which is why it worked.
//
// The class is wider than CJK: any query tokenizing to zero terms (Japanese, Korean, emoji,
// pure punctuation, or terms of <=2 chars such as "ci"/"db"/"ux").
//
// These assertions run through the real search entrypoint, not the scoring helper: deleting
// the `!hasExactMatch &&` bypass in scoreKnowledgeEntry must turn the first test RED.

test("search: a zero-token exact alias hit is not discarded by the relevance floor", async () => {
  const results = await searchAgentKnowledgeDocs("联合频道");
  assert.ok(results.length > 0, "an exact alias match must survive the relevance floor");
  assert.equal(
    results[0].slug,
    "joint-channel",
    "the exactly-matched doc must rank first, not merely appear",
  );
});

// The get path already worked; pinning it keeps the two surfaces from silently diverging
// again — the whole defect was one serving this alias while the other did not.
test("search and get agree on the same zero-token alias", async () => {
  const doc = await resolveAgentKnowledgeDoc("联合频道");
  const results = await searchAgentKnowledgeDocs("联合频道");
  assert.ok(doc, "get must resolve the alias");
  assert.equal(results[0]?.slug, doc.docId, "search and get must return the same doc");
});

// Negative controls. The bypass must not become a hole: a query that tokenizes to zero terms
// AND matches no alias/docId/title must still miss. Without these, the fix could be "return
// everything for any unparseable query" and the positive test above would not notice.
test("search: zero-token queries that match nothing still miss", async () => {
  for (const query of ["完全不存在的主题词", "🚀🚀", "zz", "。。。"]) {
    const results = await searchAgentKnowledgeDocs(query);
    assert.equal(
      results.length,
      0,
      `${query} tokenizes to zero terms and matches no identifier, so it must return nothing`,
    );
  }
});

// The relevance floor must still gate ordinary non-exact queries.
test("search: the relevance floor still rejects multi-token nonsense", async () => {
  const results = await searchAgentKnowledgeDocs("zzzz qqqq wwww");
  assert.equal(results.length, 0, "the floor must still reject non-matching tokenized queries");
});

// English alias-only discovery must keep working — this is the control that proved the exact
// -alias branch was alive in production while the CJK query missed. "hermes" appears only in
// the alias table, so a hit here cannot come from title or content token matching.
test("search: an alias-only English term still resolves (no regression on the working path)", async () => {
  const results = await searchAgentKnowledgeDocs("hermes");
  assert.ok(results.length > 0, "hermes must still return a result");
  assert.equal(results[0].slug, "external-agent", "hermes is an alias of external-agent");
});
