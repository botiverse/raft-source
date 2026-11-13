// The page a file opens as in its version's frame (artifactFiles.ts artifactFramedPagePath): one
// rule for the server, which signs a frame's `page` from it, and the content Worker, which makes
// its pages at it (packages/content-worker holds its own made pages to the same rule).
import assert from "node:assert/strict";
import { artifactFileType, artifactFramedPagePath } from "./artifactFiles";

test("an HTML page opens as itself; a Markdown file or a PDF as the page made beside it; no other kind opens in a frame", () => {
  for (const path of ["index.html", "docs/about us.html", "OLD.HTM"]) assert.equal(artifactFramedPagePath(path), path, path);
  assert.equal(artifactFramedPagePath("notes.md"), "notes.md.html");
  assert.equal(artifactFramedPagePath("docs/Release Notes.MARKDOWN"), "docs/Release Notes.MARKDOWN.html");
  assert.equal(artifactFramedPagePath("reports/q3 summary.pdf"), "reports/q3 summary.pdf.html");
  for (const path of ["data.csv", "notes.txt", "chart.svg", "photo.png", "clip.mp4", "build.zip", "app.js", "README", ".md"]) {
    assert.equal(artifactFramedPagePath(path), null, path);
  }
  // The made page is itself a page: a frame can open at it.
  for (const path of ["notes.md", "report.pdf"]) assert.equal(artifactFileType(artifactFramedPagePath(path)!).kind, "html", path);
});
