// The page a file opens as in its version's frame (artifactFiles.ts artifactFramedPagePath): one
// rule for the server, which signs a frame's `page` from it, and the content Worker, which makes
// its pages at it (packages/content-worker holds its own made pages to the same rule).
import assert from "node:assert/strict";
import { ARTIFACT_FILE_NAME_MAX_CHARS, artifactDownloadFileName, artifactFileType, artifactFramedPagePath, artifactSafeFileName } from "./artifactFiles";

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

// The name a download is saved as (artifactSafeFileName, artifactDownloadFileName): one rule for the
// server's Content-Disposition and the web's own blob downloads.
test("a title as a file name keeps its letters in any script and drops only what no file name may hold", () => {
  assert.equal(artifactSafeFileName("周计划"), "周计划");
  assert.equal(artifactSafeFileName("Q3 notes: draft / final?"), "Q3 notes draft final");
  assert.equal(artifactSafeFileName('a\\b*c"d<e>f|g'), "a b c d e f g");
  assert.equal(artifactSafeFileName("  Launch\tplan,\nsecond   draft  "), "Launch plan, second draft");
  assert.equal(artifactSafeFileName("Résumé — 2026 (v2) #1"), "Résumé — 2026 (v2) #1");
  // NFC, never NFKD: a composed letter stays one letter, a full-width one stays as written.
  assert.equal(artifactSafeFileName("Re\u0301sume\u0301"), "R\u00e9sum\u00e9");
  assert.equal(artifactSafeFileName("ＡＢＣ２０２６"), "ＡＢＣ２０２６");
  // Control characters and the marks that would reorder how a name reads.
  assert.equal(artifactSafeFileName("bad\u0000name\u007f"), "bad name");
  assert.equal(artifactSafeFileName("photo\u202egpj.exe"), "photogpj.exe");
  // Leading and trailing spaces and dots trimmed (a hidden file, a name Windows cuts).
  assert.equal(artifactSafeFileName(" ..hidden. . "), "hidden");
  for (const empty of ["", "   ", "...", "/:*?", "\u0001"]) assert.equal(artifactSafeFileName(empty), "", JSON.stringify(empty));
});

test("a title as a file name is at most so many code points, never half a surrogate pair", () => {
  assert.equal(artifactSafeFileName("x".repeat(200)), "x".repeat(ARTIFACT_FILE_NAME_MAX_CHARS));
  const emoji = "😀".repeat(100);
  const cut = artifactSafeFileName(emoji);
  assert.equal(Array.from(cut).length, ARTIFACT_FILE_NAME_MAX_CHARS);
  assert.equal(cut, "😀".repeat(ARTIFACT_FILE_NAME_MAX_CHARS));
  assert.ok(!/[\ud800-\udbff]$/.test(cut), "no lone high surrogate at the end");
  // The cut never leaves a trailing space or dot.
  assert.equal(artifactSafeFileName(`${"a".repeat(ARTIFACT_FILE_NAME_MAX_CHARS - 1)}. tail`), "a".repeat(ARTIFACT_FILE_NAME_MAX_CHARS - 1));
});

test("a version of one file downloads it named by the title with the file's own extension; several files keep their names", () => {
  assert.equal(artifactDownloadFileName({ title: "周计划", fileCount: 1, path: "index.html" }), "周计划.html");
  assert.equal(artifactDownloadFileName({ title: "Q3: plan", fileCount: 1, path: "docs/report.PDF" }), "Q3 plan.PDF");
  // The title already ends in the extension: not added again (any case).
  assert.equal(artifactDownloadFileName({ title: "notes.md", fileCount: 1, path: "notes.md" }), "notes.md");
  assert.equal(artifactDownloadFileName({ title: "Report.HTML", fileCount: 1, path: "index.html" }), "Report.HTML");
  // No extension: the title alone.
  assert.equal(artifactDownloadFileName({ title: "Read me", fileCount: 1, path: "README" }), "Read me");
  assert.equal(artifactDownloadFileName({ title: "Env", fileCount: 1, path: ".env" }), "Env");
  // Nothing left of the title: the file's own name.
  assert.equal(artifactDownloadFileName({ title: "???", fileCount: 1, path: "site/index.html" }), "index.html");
  // Several files: each its own name, whatever the title.
  assert.equal(artifactDownloadFileName({ title: "周计划", fileCount: 3, path: "index.html" }), "index.html");
  assert.equal(artifactDownloadFileName({ title: "周计划", fileCount: 2, path: "img/logo (1).png" }), "logo (1).png");
});
