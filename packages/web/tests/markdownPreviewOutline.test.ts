import assert from "node:assert/strict";
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

// The outline reads headings with the parser the preview renders with, so a
// heading in the outline is a heading on the page and nothing else is.
test("markdown outline lists exactly the headings the preview renders", () => {
  const outline = extractMarkdownOutline([
    "Setext title",
    "============",
    "",
    "- ```",
    "  # inside a fence in a list",
    "  ```",
    "",
    "> ## Quoted heading",
    "",
    "## Rate `a*b` is 5 \\* 3",
    "",
    "    # indented code, not a heading",
    "",
    "### <kbd>Ctrl</kbd> + K",
  ].join("\n"));

  assert.deepEqual(outline, [
    { id: "setext-title", level: 1, sourceLine: 1, title: "Setext title" },
    { id: "quoted-heading", level: 2, sourceLine: 8, title: "Quoted heading" },
    { id: "rate-a-b-is-5-3", level: 2, sourceLine: 10, title: "Rate a*b is 5 * 3" },
    { id: "ctrl-k", level: 3, sourceLine: 14, title: "Ctrl + K" },
  ]);
});
