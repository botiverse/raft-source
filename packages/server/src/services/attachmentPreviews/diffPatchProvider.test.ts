import assert from "node:assert/strict";
import { test } from "vitest";
import { buildDiffPatchPreview, diffPatchPreviewProvider, isDiffPatchAttachment } from "./providers/diffPatch.js";

test("isDiffPatchAttachment detects diff and patch filenames", () => {
  assert.equal(isDiffPatchAttachment("changes.diff", "application/octet-stream"), true);
  assert.equal(isDiffPatchAttachment("fix.PATCH", "text/plain"), true);
  assert.equal(isDiffPatchAttachment("notes.txt", "text/plain"), false);
});

test("isDiffPatchAttachment detects diff and patch MIME types", () => {
  assert.equal(isDiffPatchAttachment("attachment", "text/x-diff"), true);
  assert.equal(isDiffPatchAttachment("attachment", "application/x-patch; charset=utf-8"), true);
});

test("buildDiffPatchPreview counts unified diff stats", () => {
  const preview = buildDiffPatchPreview(`diff --git a/src/app.ts b/src/app.ts
index 111..222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,4 @@
 import x from "x";
-old line
+new line
+another line
 context
@@ -12,2 +13,1 @@
-old second
+new second
diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1 +1 @@
-old readme
+new readme
`);

  assert.deepEqual(preview, {
    kind: "diff",
    stats: {
      files: 2,
      hunks: 3,
      additions: 4,
      deletions: 3,
    },
  });
});

test("buildDiffPatchPreview returns null for plain text", () => {
  assert.equal(buildDiffPatchPreview("hello world"), null);
});


test("diff patch provider returns diff preview data", async () => {
  const preview = await diffPatchPreviewProvider.buildPreview({
    attachment: { filename: "changes.patch", mimeType: "text/x-patch" } as never,
    buffer: Buffer.from("@@ -1 +1 @@\n-old\n+new\n", "utf8"),
    truncated: false,
  });
  assert.deepEqual(preview, {
    kind: "diff",
    stats: { files: 1, hunks: 1, additions: 1, deletions: 1 },
  });
});
