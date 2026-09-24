import assert from "node:assert/strict";
import test from "node:test";
import { extractMarkdownOutline } from "../src/components/markdown/MarkdownOutline";

test("markdown outline extracts h1-h3 headings with stable duplicate ids", () => {
  const outline = extractMarkdownOutline([
    "# Title",
    "",
    "```",
    "# ignored code heading",
    "```",
    "## Usage `API`",
    "### [Usage API](https://example.com)",
    "#### Too deep",
    "## Usage API",
  ].join("\n"));

  assert.deepEqual(outline, [
    { id: "title", level: 1, sourceLine: 1, title: "Title" },
    { id: "usage-api", level: 2, sourceLine: 6, title: "Usage API" },
    { id: "usage-api-2", level: 3, sourceLine: 7, title: "Usage API" },
    { id: "usage-api-3", level: 2, sourceLine: 9, title: "Usage API" },
  ]);
});
