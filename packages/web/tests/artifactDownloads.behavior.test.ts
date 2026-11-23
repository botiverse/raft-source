// Saving an Artifact's files (artifactDownloads.ts): the names a download is saved as (the server's
// Content-Disposition names them the same way), its bytes a blob read through the API client.
import assert from "node:assert/strict";
import "./helpers/domSetup";
import { afterEach, test } from "vitest";
import { asArtifactId } from "@botiverse/raft-shared";
import type { ArtifactViewerData } from "@botiverse/raft-shared";

import { artifactFileDownloadName, artifactZipName, downloadArtifactFile, downloadArtifactZip } from "../src/apps/artifacts/artifactDownloads";
import { setArtifactSourceForTests } from "../src/apps/artifacts/artifactSource";
import type { ArtifactSource } from "../src/apps/artifacts/artifactSource";

const ID = asArtifactId("pt_3c10b4ed-d947-49df-9031-91ae837f010a");

function shown(title: string, paths: string[]): ArtifactViewerData {
  return {
    card: { id: ID, version: 3, title },
    files: paths.map((path, index) => ({ path, entry: index === 0 })),
  } as unknown as ArtifactViewerData;
}

const originalClick = HTMLAnchorElement.prototype.click;
const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

/** Every link clicked: its address and the name it downloads as. */
function recordClicks(): Array<{ href: string; download: string }> {
  const clicks: Array<{ href: string; download: string }> = [];
  HTMLAnchorElement.prototype.click = function click() {
    clicks.push({ href: this.href, download: this.download });
  };
  return clicks;
}

/** A source that answers bytes and counts its reads. */
function countingSource(): { reads: string[] } {
  const reads: string[] = [];
  setArtifactSourceForTests({
    readBytes: async (file: { path: string }) => {
      reads.push(`file:${file.path}`);
      return new Blob(["bytes"]);
    },
    readZip: async () => {
      reads.push("zip");
      return new Blob(["zip"]);
    },
  } as unknown as ArtifactSource);
  return { reads };
}

afterEach(() => {
  HTMLAnchorElement.prototype.click = originalClick;
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
  setArtifactSourceForTests(null);
});

test("a version of one file downloads it named by the title with its extension; several files keep their names", () => {
  assert.equal(artifactFileDownloadName(shown("周计划", ["index.html"]), "index.html"), "周计划.html");
  assert.equal(artifactFileDownloadName(shown("Q3: plan / draft", ["report.pdf"]), "report.pdf"), "Q3 plan draft.pdf");
  // The title already ends in the file's extension: not added again.
  assert.equal(artifactFileDownloadName(shown("Notes.MD", ["notes.md"]), "notes.md"), "Notes.MD");
  // No title left: the file's own name.
  assert.equal(artifactFileDownloadName(shown("...", ["index.html"]), "index.html"), "index.html");
  const site = shown("周计划", ["index.html", "img/logo (1).png"]);
  assert.equal(artifactFileDownloadName(site, "index.html"), "index.html");
  assert.equal(artifactFileDownloadName(site, "img/logo (1).png"), "logo (1).png");
});

test("Download all's zip keeps a title's letters in any script, as the server names it", () => {
  assert.equal(artifactZipName("周计划", 3), "周计划 v3.zip");
  assert.equal(artifactZipName("Q3 notes: «draft»/final", 2), "Q3 notes «draft» final v2.zip");
  assert.equal(artifactZipName("a\\b*c?d\"e<f>g|h", 1), "a b c d e f g h v1.zip");
  for (const empty of ["", "  ", "..", "/?*"]) assert.equal(artifactZipName(empty, 4), "artifact v4.zip", JSON.stringify(empty));
});

test("a download is a blob read through the API client, saved by its name", async () => {
  const { reads } = countingSource();
  const clicks = recordClicks();
  URL.createObjectURL = (() => "blob:artifact") as typeof URL.createObjectURL;
  URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL;
  await downloadArtifactFile(shown("周计划", ["index.html"]), "index.html");
  await downloadArtifactZip({ id: ID, version: 3, title: "周计划" });
  assert.deepEqual(reads, ["file:index.html", "zip"]);
  assert.deepEqual(clicks, [{ href: "blob:artifact", download: "周计划.html" }, { href: "blob:artifact", download: "周计划 v3.zip" }]);
});
