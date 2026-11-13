import assert from "node:assert/strict";
import { ARTIFACT_EXCERPT_BLOCKS_MAX_ROWS, ARTIFACT_EXCERPT_CODE_MAX_LINES, ARTIFACT_EXCERPT_IMAGES_MAX_COUNT, ARTIFACT_EXCERPT_TABLE_MAX_ROWS, parseArtifactExcerptBlocks } from "./artifactExcerptBlocks";

// The boundary of a card's rich excerpt (#proj-workspace:#220): what the Server
// stores and a client draws. Anything else is null, and a client draws `text`.
const spans = [{ text: "words" }];

test("every block a card draws passes as it is", () => {
  const blocks = [
    { type: "heading", level: 2, spans },
    { type: "paragraph", spans: [{ text: "a", bold: true }, { text: "b", italic: true }, { text: "c", code: true }] },
    { type: "quote", spans },
    { type: "list", items: [{ level: 0, spans }, { level: 1, order: 3, spans }, { level: 0, checked: true, spans }] },
    { type: "code", lines: ["a", ""] },
    { type: "table", header: [spans, []], rows: [[spans, []]] },
    { type: "image", alt: "" },
    { type: "images", count: 2 },
    { type: "diagram" },
    { type: "rule" },
  ];
  assert.deepEqual(parseArtifactExcerptBlocks(blocks), blocks);
});

test("not a list of blocks: null, whole, so a client falls back to the text", () => {
  for (const value of [
    undefined, null, "words", 3, {}, [], [null], ["words"], [{}],
    [{ type: "video", url: "https://evil.test" }],
    [{ type: 3 }], [{ type: "paragraph", spans }, { type: 3 }],
    [{ type: "paragraph", spans }, { type: "image" }],
    [{ type: "paragraph" }], [{ type: "paragraph", spans: [] }], [{ type: "paragraph", spans: [{ text: "" }] }], [{ type: "paragraph", spans: [{ text: 1 }] }],
    [{ type: "paragraph", spans: [{ text: "a", bold: "yes" }] }],
    [{ type: "heading", level: 7, spans }], [{ type: "heading", level: 0, spans }],
    [{ type: "list", items: [] }], [{ type: "list", items: [{ level: 2, spans }] }], [{ type: "list", items: [{ level: 0, order: -1, spans }] }],
    [{ type: "code", lines: [] }], [{ type: "code", lines: Array.from({ length: ARTIFACT_EXCERPT_CODE_MAX_LINES + 1 }, () => "a") }],
    [{ type: "table", header: [], rows: [] }], [{ type: "table", header: [spans], rows: Array.from({ length: ARTIFACT_EXCERPT_TABLE_MAX_ROWS + 1 }, () => [spans]) }],
    [{ type: "image" }], [{ type: "image", alt: "a".repeat(1000) }],
    [{ type: "images" }], [{ type: "images", count: 1 }], [{ type: "images", count: 2.5 }], [{ type: "images", count: "2" }], [{ type: "images", count: ARTIFACT_EXCERPT_IMAGES_MAX_COUNT + 1 }],
    Array.from({ length: ARTIFACT_EXCERPT_BLOCKS_MAX_ROWS + 1 }, () => ({ type: "rule" })),
  ]) {
    assert.equal(parseArtifactExcerptBlocks(value), null, JSON.stringify(value)?.slice(0, 80));
  }
});

test("a block type added later doesn't fail the card: it is left out, and the rest is drawn", () => {
  const paragraph = { type: "paragraph", spans };
  assert.deepEqual(parseArtifactExcerptBlocks([paragraph, { type: "from-a-newer-server", anything: 1 }, { type: "rule" }]), [paragraph, { type: "rule" }]);
  assert.equal(parseArtifactExcerptBlocks([{ type: "from-a-newer-server" }]), null, "nothing left to draw");
  assert.equal(parseArtifactExcerptBlocks([{ type: "toString" }]), null, "an Object.prototype name is no block type");
});

test("a field added later doesn't fail a block: it is dropped, and the block is drawn", () => {
  assert.deepEqual(parseArtifactExcerptBlocks([{ type: "rule", weight: 2 }]), [{ type: "rule" }]);
  assert.deepEqual(parseArtifactExcerptBlocks([{ type: "paragraph", spans: [{ text: "a", href: "https://evil.test" }] }]), [{ type: "paragraph", spans: [{ text: "a" }] }]);
});
