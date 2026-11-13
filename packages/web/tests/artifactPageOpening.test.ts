import assert from "node:assert/strict";
import { artifactHashForPanel, artifactPageOpening, artifactPanelFromHash } from "../src/apps/artifacts/artifactPageOpening";

test("the Artifact page's address: ?panel= opens a list, ?comment= lands on a comment (#proj-workspace:#127)", () => {
  assert.deepEqual(artifactPageOpening(""), { panel: null, comment: null });
  assert.deepEqual(artifactPageOpening("?panel=comments"), { panel: "comments", comment: null });
  assert.deepEqual(artifactPageOpening("?panel=versions&shown=3"), { panel: "versions", comment: null });
  // The Files panel (#proj-workspace:#239).
  assert.deepEqual(artifactPageOpening("?panel=files"), { panel: "files", comment: null });
  assert.deepEqual(
    artifactPageOpening("?embed=raft-settings-v1&shell=host&comment=c_0a15bfae-7fb0-41a5-8990-693be88d87ef"),
    { panel: null, comment: "c_0a15bfae-7fb0-41a5-8990-693be88d87ef" },
  );
  // A comment copied from raft-artifacts.com.
  assert.equal(artifactPageOpening("?comment=lc_42").comment, "lc_42");
  // Anything else is ignored, never an error.
  assert.deepEqual(artifactPageOpening("?panel=folders&comment=<script>"), { panel: null, comment: null });
  assert.equal(artifactPageOpening(`?comment=c_${"a".repeat(200)}`).comment, null);
});

test("#panel= is the list open now, written by the App and by the page; other hashes are left alone", () => {
  assert.equal(artifactPanelFromHash("#panel=comments"), "comments");
  assert.equal(artifactPanelFromHash("#panel=versions"), "versions");
  assert.equal(artifactPanelFromHash("#panel=files"), "files");
  assert.equal(artifactPanelFromHash("#panel=none"), "none");
  for (const other of ["", "#", "#panel=folders", "#comment-1", "#panel=comments&x=1", "#host=close"]) assert.equal(artifactPanelFromHash(other), null, other);
  assert.equal(artifactHashForPanel("comments"), "#panel=comments");
  assert.equal(artifactHashForPanel("versions"), "#panel=versions");
  assert.equal(artifactHashForPanel("files"), "#panel=files");
  assert.equal(artifactHashForPanel("none"), "", "none open is no hash");
});
