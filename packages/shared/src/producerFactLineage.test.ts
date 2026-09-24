import assert from "node:assert/strict";
import test from "node:test";
import {
  assertSurfaceProducerFactLineage,
  collectSurfaceProducerFactIds,
  formatProducerFactLineageBracket,
  formatProducerFactLineageNote,
  stripSurfaceProducerFactLineage,
} from "./producerFactLineage.js";

test("surface producer-fact lineage assertion covers object attrs and canonical text", () => {
  const surface = {
    entries: [{ producerFactId: "fact-object", text: "visible" }],
    traceAttrs: { message_producer_fact_id: "fact-trace" },
    text: "Lineage: producerFactId=fact-text.",
  };

  assert.deepEqual(collectSurfaceProducerFactIds(surface), ["fact-object", "fact-text", "fact-trace"]);
  assertSurfaceProducerFactLineage(surface, ["fact-object", "fact-text", "fact-trace"], "mixed surface");
});

test("producer-fact lineage text formatters share the extractor grammar", () => {
  assert.equal(formatProducerFactLineageBracket(" fact-bracket "), " [producerFactId=fact-bracket]");
  assert.equal(formatProducerFactLineageNote("fact-note"), "\nLineage: producerFactId=fact-note.");
  assert.equal(formatProducerFactLineageBracket(""), "");
  assert.equal(formatProducerFactLineageNote(undefined), "");

  const surface = `${formatProducerFactLineageBracket("fact-bracket")}${formatProducerFactLineageNote("fact-note")}`;
  assert.deepEqual(collectSurfaceProducerFactIds(surface), ["fact-bracket", "fact-note"]);
});

test("strip-red fixture fails the shared surface lineage assertion", () => {
  const surface = {
    entries: [{ producerFactId: "fact-object", text: "visible" }],
    text: "[producerFactId=fact-text]",
  };

  const stripped = stripSurfaceProducerFactLineage(surface);
  assert.deepEqual(collectSurfaceProducerFactIds(stripped), []);
  assert.throws(
    () => assertSurfaceProducerFactLineage(stripped, ["fact-object", "fact-text"], "stripped surface"),
    /producerFactId mismatch/,
  );
});
