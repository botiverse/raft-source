// ⋯'s Share (artifactShareFile.ts, #proj-workspace:#346): which file of the version is handed to the system share
// sheet and by what name, when the browser is asked whether it shares it, and that a cancelled sheet is no failure.
import assert from "node:assert/strict";
import { test } from "vitest";
import { asArtifactId } from "@botiverse/raft-shared";
import type { ArtifactViewerData } from "@botiverse/raft-shared";

import {
  ARTIFACT_SHARE_MAX_BYTES,
  artifactShareFile,
  artifactShareTarget,
  offersArtifactShare,
  shareArtifactFile,
} from "../src/apps/artifacts/artifactShareFile";
import { canShareFiles, isShareAbort } from "../src/apps/artifacts/webShareFiles";
import type { FileShareNavigator } from "../src/apps/artifacts/webShareFiles";

const ID = asArtifactId("pt_3c10b4ed-d947-49df-9031-91ae837f010a");

function shown(title: string, files: Array<{ path: string; entry?: boolean; sizeBytes?: number }>): Pick<ArtifactViewerData, "card" | "files"> {
  return {
    card: { id: ID, version: 3, title },
    files: files.map((file) => ({ path: file.path, entry: file.entry ?? false, sizeBytes: file.sizeBytes ?? 1024, kind: "other" })),
  } as unknown as Pick<ArtifactViewerData, "card" | "files">;
}

/** A navigator whose canShare answers `answer` and records what it was asked. */
function sharing(answer: boolean | (() => boolean)): FileShareNavigator & { asked: File[][]; shared: ShareData[] } {
  const asked: File[][] = [];
  const shared: ShareData[] = [];
  return {
    asked,
    shared,
    canShare: (data: ShareData) => {
      asked.push([...(data.files ?? [])]);
      return typeof answer === "function" ? answer() : answer;
    },
    share: async (data: ShareData) => {
      shared.push(data);
    },
  };
}

test("a version of one file shares it by the title with its extension, typed by the extension", () => {
  assert.deepEqual(artifactShareTarget(shown("周计划", [{ path: "report.pdf", entry: true }])), {
    path: "report.pdf",
    name: "周计划.pdf",
    type: "application/pdf",
  });
  // The served type's parameters are not part of a file's type.
  assert.deepEqual(artifactShareTarget(shown("Weekly plan", [{ path: "index.html", entry: true }])), {
    path: "index.html",
    name: "Weekly plan.html",
    type: "text/html",
  });
});

test("a version of several files shares its entry file by the file's own name", () => {
  const data = shown("Site", [{ path: "style.css" }, { path: "pages/home.html", entry: true }, { path: "logo.png" }]);
  assert.deepEqual(artifactShareTarget(data), { path: "pages/home.html", name: "home.html", type: "text/html" });
  // None marked: the first, as Download takes it.
  assert.equal(artifactShareTarget(shown("Site", [{ path: "a.md" }, { path: "b.md" }]))?.path, "a.md");
});

test("no file, or one above the cap, has nothing to share", () => {
  assert.equal(artifactShareTarget(shown("Empty", [])), null);
  assert.equal(artifactShareTarget(shown("Big", [{ path: "movie.mp4", entry: true, sizeBytes: ARTIFACT_SHARE_MAX_BYTES + 1 }])), null);
  assert.notEqual(artifactShareTarget(shown("Fits", [{ path: "movie.mp4", entry: true, sizeBytes: ARTIFACT_SHARE_MAX_BYTES }])), null);
});

test("Share is offered only where share and canShare exist and canShare takes such a file", () => {
  const target = { path: "report.pdf", name: "Plan.pdf", type: "application/pdf" };
  assert.equal(offersArtifactShare(target, undefined), false);
  assert.equal(offersArtifactShare(target, {}), false);
  assert.equal(offersArtifactShare(target, { canShare: () => true }), false, "no share");
  assert.equal(offersArtifactShare(target, { share: async () => {} }), false, "no canShare");
  assert.equal(offersArtifactShare(target, sharing(false)), false, "canShare says no");
  assert.equal(offersArtifactShare(target, sharing(() => {
    throw new TypeError("not allowed");
  })), false, "canShare throws");

  const nav = sharing(true);
  assert.equal(offersArtifactShare(target, nav), true);
  // Asked of one file with the name and type the shared one will have.
  assert.equal(nav.asked.length, 1);
  assert.equal(nav.asked[0]!.length, 1);
  assert.equal(nav.asked[0]![0]!.name, "Plan.pdf");
  assert.equal(nav.asked[0]![0]!.type, "application/pdf");
  assert.equal(nav.shared.length, 0, "asking shares nothing");
});

test("the file shared has the bytes read, the target's name and its type", async () => {
  const file = artifactShareFile({ path: "report.pdf", name: "周计划.pdf", type: "application/pdf" }, new Blob(["%PDF-1.7"]));
  assert.equal(file.name, "周计划.pdf");
  assert.equal(file.type, "application/pdf");
  assert.equal(await file.text(), "%PDF-1.7");
});

test("share is called before the first await, with the file alone", async () => {
  const file = new File(["bytes"], "Plan.pdf", { type: "application/pdf" });
  const nav = sharing(true);
  const result = shareArtifactFile(file, nav);
  // Already called: nothing awaited before it, so the click's user activation still covers it.
  assert.equal(nav.shared.length, 1);
  assert.deepEqual(Object.keys(nav.shared[0]!), ["files"]);
  assert.equal(nav.shared[0]!.files![0], file);
  assert.equal(await result, "shared");
});

test("a cancelled share sheet (AbortError) resolves quietly; any other failure rejects", async () => {
  const file = new File(["bytes"], "Plan.pdf", { type: "application/pdf" });
  const rejecting = (error: unknown): FileShareNavigator => ({ canShare: () => true, share: () => Promise.reject(error) });
  assert.equal(await shareArtifactFile(file, rejecting(new DOMException("Share canceled", "AbortError"))), "cancelled");
  // A web view's own share may reject with a plain error of that name.
  assert.equal(await shareArtifactFile(file, rejecting(Object.assign(new Error("cancelled"), { name: "AbortError" }))), "cancelled");
  await assert.rejects(shareArtifactFile(file, rejecting(new DOMException("No activation", "NotAllowedError"))), { name: "NotAllowedError" });
  // One that throws rather than rejects is the same.
  const throwing: FileShareNavigator = {
    canShare: () => true,
    share: () => {
      throw new DOMException("Share canceled", "AbortError");
    },
  };
  assert.equal(await shareArtifactFile(file, throwing), "cancelled");
  await assert.rejects(shareArtifactFile(file, {}), TypeError);
});

test("canShareFiles and isShareAbort, as select mode's screenshots use them too", () => {
  const files = [new File(["png"], "page.png", { type: "image/png" })];
  assert.equal(canShareFiles(files, undefined), false);
  assert.equal(canShareFiles(files, sharing(true)), true);
  assert.equal(canShareFiles(files, sharing(false)), false);
  assert.equal(isShareAbort(new DOMException("x", "AbortError")), true);
  assert.equal(isShareAbort(new DOMException("x", "NotAllowedError")), false);
  assert.equal(isShareAbort("AbortError"), false);
  assert.equal(isShareAbort(null), false);
});
