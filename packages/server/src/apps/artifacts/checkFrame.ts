// A publish check's ticket (task #proj-workspace:#130; docs/development/
// workspace-artifacts.md, "Publish check"): the url the check Worker's
// headless browser opens one version with, top-level (Tenny's design change,
// #proj-workspace:#130 2c321879: no check host page, nothing frames it).
//
// Tenny's rule: only the server's durable task signs this ticket; nothing a
// user or an agent can call signs one. So this module is imported by the
// check's durable task alone (checkTask.ts, which hands the url to the check
// Worker in a lease's answer), and checkFrame.structure.test.ts refuses every
// other importer, as it refuses any module but this one naming
// contentWorker.ts signCheckContentFrame. The frame routes sign with
// contentWorker.ts signContentFrame, which refuses a check viewer or subject.
//
// The ticket: viewer `system:check` (shared ARTIFACT_CONTENT_CHECK_VIEWER),
// subject `v1:check:<artifact>:<version>` (contentWorker.ts
// checkContentSubject), no ancestor (no ticket names one; the shared signer
// refuses one), on the Artifact's own content origin, 60 s, opened once, like
// a reader's. Authorize allows it only for that version while its check runs
// (contentRoutes.ts decideCheck). The url carries the ticket: never log it.
import { artifactFileType, isArtifactCheckedKind, isArtifactFramedKind } from "@botiverse/raft-shared";
import { signCheckContentFrame } from "./contentWorker";
import type { ArtifactItemRow, ArtifactVersionRow } from "./schema";

/**
 * A check's ticket: `url` (`<origin>/_raft/open?ticket=…`) and the Artifact's
 * content `origin` it opens on; or why there is none: a kind the shell draws
 * (nothing to check), a framed kind a check doesn't open (shared
 * ARTIFACT_CHECKED_KINDS: Markdown, PDF for now), the content origin not configured,
 * or a signature that failed (`errorClass`, our bug).
 */
export type ArtifactCheckFrame =
  | { kind: "signed"; url: string; origin: string }
  | { kind: "not_framed" }
  | { kind: "not_checked" }
  | { kind: "not_configured" }
  | { kind: "failed"; errorClass: string };

/**
 * The ticket for `version` of `item`, signed here with no call to any Worker.
 * The caller (the check's durable task) has just leased the check row for
 * this version; whether it may run is authorize's to decide on every load.
 */
export async function signCheckFrame(
  item: Pick<ArtifactItemRow, "id">,
  version: Pick<ArtifactVersionRow, "id" | "itemId" | "entry">,
): Promise<ArtifactCheckFrame> {
  if (version.itemId !== item.id) throw new Error("signCheckFrame: the version is not the item's");
  const kind = artifactFileType(version.entry).kind;
  if (!isArtifactFramedKind(kind)) return { kind: "not_framed" };
  if (!isArtifactCheckedKind(kind)) return { kind: "not_checked" };
  const issued = await signCheckContentFrame({ artifact: item.id, version: version.id });
  switch (issued.outcome) {
    case "issued":
      return { kind: "signed", url: issued.frame!.url, origin: issued.frame!.origin };
    case "not_configured":
      return { kind: "not_configured" };
    case "failed":
      return { kind: "failed", errorClass: issued.errorClass ?? "Error" };
  }
}
