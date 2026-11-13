import type { ArtifactId, ArtifactViewerData } from "@botiverse/raft-shared";
import { isArtifactFramedKind } from "@botiverse/raft-shared";

import { copyTextToClipboard } from "../../utils/selectMarkdown";
import { readsAsOutsider } from "./artifactOwnServer";

/**
 * ⋯'s Embed (#proj-workspace:#260): the HTML that puts a public Artifact on
 * any website, an iframe of its embed page on this deployment's embed host
 * (the server's `artifactsEmbedOrigin`: store/artifactsEmbedOrigin.ts),
 * `<origin>/pt_<uuid>`, built from the id, never from a URL in a payload.
 * The embed page shows the current version while the Artifact is public
 * (the content Worker asks Raft on every load), so the code never names a
 * version.
 */

/** Text as an HTML attribute value takes it (double-quoted). */
function escapeAttribute(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** The embed page's address: the id must be an Artifact id, or null. */
export function artifactEmbedUrl(origin: string, id: ArtifactId): string | null {
  return /^pt_[0-9a-z-]+$/i.test(id) ? `${origin}/${id}` : null;
}

/** The code ⋯'s Embed copies: the embed page in a full-width iframe, named by the Artifact's title. */
export function artifactEmbedCode(origin: string, id: ArtifactId, title: string): string | null {
  const url = artifactEmbedUrl(origin, id);
  if (url === null) return null;
  return `<iframe src="${escapeAttribute(url)}" title="${escapeAttribute(title)}" width="100%" height="600" style="border:0" loading="lazy"></iframe>`;
}

/**
 * Whether ⋯ offers Embed: embeds are on for this deployment (an origin), the
 * version shown is a kind the embed page frames (HTML, Markdown, PDF; any
 * other kind is the embed host's one 404), and the Artifact is public, or
 * this reader may make it public (`capabilities.changeHome`, the permission
 * that offers Anyone with the link in Who can see: artifactVisibility), in
 * which case Embed asks first to turn on link sharing.
 *
 * Only to a member of the Artifact's own server (xxchan, the Artifacts feature
 * matrix, D1): another server's reader of a public one is not offered it
 * (readsAsOutsider), as the public page offers none. Nothing stops them: the
 * embed page of a public Artifact loads for anyone who writes the iframe
 * themselves. The entry is the server's own.
 */
export function offersEmbed(origin: string | null, data: Pick<ArtifactViewerData, "card" | "capabilities">): "copy" | "share-first" | null {
  if (origin === null || !isArtifactFramedKind(data.card.kind) || readsAsOutsider(data.card)) return null;
  if (data.card.home.kind === "public") return "copy";
  return data.capabilities.changeHome ? "share-first" : null;
}

/** How a copy whose text comes later went: copied, not wanted after all (the text was null), or refused by the browser. */
export type LaterCopy = "copied" | "skipped" | "failed";

/**
 * Copies text known only after a server round trip (the embed code once link sharing is on), from
 * inside the click that asked for it. Safari and iOS take a clipboard write only within the user's
 * gesture, which the round trip outlives; so the write starts now, synchronously, with
 * `ClipboardItem`'s promise of the text (Safari, Chrome and Firefox take one), and resolves when the
 * text does. Where that isn't there or is refused, it falls back to writing the text once known (a
 * browser without the gesture rule takes that). `text` resolves null when nothing is to be copied
 * (the server refused): then nothing is written, and `skipped`. Never rejects.
 */
export async function copyTextLater(text: Promise<string | null>): Promise<LaterCopy> {
  const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
  if (typeof clipboard?.write === "function" && typeof ClipboardItem !== "undefined") {
    let skipped = false;
    const blob = text.then((value) => {
      if (value === null) {
        skipped = true;
        throw new Error("nothing to copy");
      }
      return new Blob([value], { type: "text/plain" });
    });
    try {
      // Called before any await: still inside the click.
      await clipboard.write([new ClipboardItem({ "text/plain": blob })]);
      return "copied";
    } catch {
      if (skipped) return "skipped";
      // A browser that refused the promise form: the plain write below, once the text is known.
    }
  }
  const value = await text;
  if (value === null) return "skipped";
  try {
    await copyTextToClipboard(value);
    return "copied";
  } catch {
    return "failed";
  }
}
