import { test } from "vitest";
import assert from "node:assert/strict";
import { manualQueryNeedsEnglish, searchAgentKnowledgeDocs } from "./agentKnowledgeService.js";

// Search-layer fuzziness (Cindy asked 2026-09-01, #proj-docs thread 843fddc1).
// Fuzziness lives ONLY here, in discovery — `manual get` stays exact.

test("a non-English query returns nothing, so the caller is told to use English", async () => {
  // @cindyz, 2026-09-02: the Manual does not support Chinese for now; a clearly
  // non-English search should be answered with "search in English" rather than
  // translated. This replaces CJK_QUERY_TERM_TRANSLATIONS, which used to map
  // 频道 -> channel and friends.
  for (const query of ["频道", "附件", "任务", "提醒", "リマインダー", "알림", "напоминание"]) {
    assert.deepEqual(
      await searchAgentKnowledgeDocs(query),
      [],
      `${query} must not be translated into an English hit`,
    );
    assert.equal(manualQueryNeedsEnglish(query), true, `${query} must be flagged as non-English`);
  }
});

test("the language gate does not fire on English, or on English mixed with CJK", async () => {
  // The gate has two halves and both are load-bearing. Dropping the
  // "no usable English terms" half would reject the mixed query below, whose
  // English half is perfectly searchable; dropping the script half would fire
  // on plain English.
  assert.equal(manualQueryNeedsEnglish("reminder"), false);
  assert.equal(manualQueryNeedsEnglish("how do I archive a channel"), false);
  assert.equal(manualQueryNeedsEnglish("如何 create channel"), false, "mixed query keeps its English terms");

  const mixed = await searchAgentKnowledgeDocs("如何 create channel");
  assert.ok(mixed.length > 0, "the English half of a mixed query must still search");
});

test("the gate is about script, not about punctuation or digits", async () => {
  // A query of pure punctuation/digits returns nothing, but it is NOT a
  // language problem — telling that caller to "use English" would be wrong.
  assert.equal(manualQueryNeedsEnglish("!!! 123 ???"), false);
  assert.equal(manualQueryNeedsEnglish(""), false);
});

test("single-character typos still find the doc", async () => {
  const cases: Array<[string, string]> = [
    ["chanel", "channel"],
    ["attachmnt", "attachment"],
    ["remindr", "reminder"],
  ];
  for (const [typo, expectedSlug] of cases) {
    const results = await searchAgentKnowledgeDocs(typo);
    assert.ok(results.length > 0, `${typo} must return results`);
    assert.ok(
      results.some((r) => r.slug === expectedSlug),
      `${typo} must surface ${expectedSlug}`,
    );
  }
});

test("typo tolerance does not invent matches for junk", async () => {
  // Edit distance 1 is narrow enough that unrelated strings stay empty. If this
  // ever goes green-with-results, the fuzzy radius has been widened too far.
  for (const junk of ["zzzqqq", "xyzzyx", "qqqwwweee"]) {
    assert.deepEqual(await searchAgentKnowledgeDocs(junk), [], `${junk} must return nothing`);
  }
});

test("short terms are not fuzzed", async () => {
  // MIN_FUZZY_TERM_LENGTH guards the dangerous end: short tokens sit one edit
  // from many unrelated words. Specimen chosen by mutation, not by intuition —
  // an earlier version of this test used "dm", which matches exactly and so
  // never reaches the fuzzy path, leaving the guard untested. Lowering
  // MIN_FUZZY_TERM_LENGTH to 2 makes "tsk" match "ask" and "task"; this
  // assertion goes red then.
  assert.deepEqual(
    await searchAgentKnowledgeDocs("tsk"),
    [],
    "a 3-character near-miss must not fuzzy-match",
  );
});

test("results explain why they matched", async () => {
  const [top] = await searchAgentKnowledgeDocs("chanel");
  assert.ok(top, "typo query must return a result");
  assert.deepEqual(top.matchedTerms, ["chanel"], "matched terms are reported");
  assert.deepEqual(
    top.correctedTerms,
    [{ term: "chanel", matched: "channel" }],
    "the correction is reported as term -> doc token",
  );
});

test("the two match mechanisms are reported distinctly", async () => {
  // meichen's contract (#proj-docs:843fddc1): typo correction and ordinary
  // lexical matching must be tellable apart by a reader and by telemetry — not
  // collapsed into one "matched" blob. Concept expansion was the third
  // mechanism; it is gone with CJK query translation (@cindyz, 2026-09-02:
  // Manual is English-only for now).
  const [corrected] = await searchAgentKnowledgeDocs("chanel");
  assert.ok(corrected);
  assert.deepEqual(corrected.correctedTerms, [{ term: "chanel", matched: "channel" }]);

  const [plain] = await searchAgentKnowledgeDocs("reminder");
  assert.ok(plain);
  assert.deepEqual(plain.correctedTerms, []);
  assert.ok(plain.matchedTerms.includes("reminder"), "ordinary lexical match still reported");
});

test("exact queries report no corrections", async () => {
  const results = await searchAgentKnowledgeDocs("reminder");
  assert.ok(results.length > 0);
  for (const result of results) {
    assert.deepEqual(result.correctedTerms, [], "an exact query must not claim corrections");
    assert.ok(result.matchedTerms.includes("reminder"));
  }
});

test("KNOWN LIMITATION: typos that break a stemmed suffix still miss", async () => {
  // Content tokens are stemmed (`integration` -> `integrat`), so a typo that
  // survives stemming in the query but not the index sits at edit distance 2.
  // Pinned deliberately: this documents the boundary instead of leaving a
  // silent hole, and turns red if a future change closes it (then delete this).
  assert.deepEqual(await searchAgentKnowledgeDocs("integraton"), []);
});

test("a word the corpus knows is never typo-rewritten per document", async () => {
  // Holdout finding (task #140): `stage` is a legitimate word present in the
  // corpus, but the first implementation judged typo candidacy per DOCUMENT —
  // so in documents lacking it, it was "corrected" to `state`/`stale` and
  // produced unrelated hits. Candidacy is now corpus-wide. Removing the
  // corpusVocabulary guard turns this red.
  const results = await searchAgentKnowledgeDocs("stage environment config");
  for (const result of results) {
    assert.deepEqual(
      result.correctedTerms,
      [],
      `no term may be typo-rewritten here, got ${JSON.stringify(result.correctedTerms)} on ${result.slug}`,
    );
  }
});

test("a reported correction always names a token the caller actually typed", async () => {
  // Holdout finding (task #140): correcting the STEMMED token reports a word
  // the caller never wrote (`retention` -> stem `retent` -> `recent`), which
  // both drifts the concept and makes the reason line unreadable. Candidacy
  // and matching now use the raw token, so every reported `term` is one the
  // caller typed. Fuzzing the stemmed token instead turns this red: for
  // `attachmnts` it reports the stem `attachmnt`, which is not a query token.
  for (const query of ["attachmnts", "chanels", "reminderss"]) {
    const queryTokens = new Set(query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
    for (const result of await searchAgentKnowledgeDocs(query)) {
      for (const { term } of result.correctedTerms) {
        assert.ok(
          queryTokens.has(term),
          `reported correction "${term}" is not a token the caller typed (${query})`,
        );
      }
    }
  }
});
