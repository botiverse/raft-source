import { LINK_LABEL_LIMITS } from "@botiverse/porthole";
import type { LinkLabel } from "@botiverse/porthole";
import type { ArtifactContentLink } from "@botiverse/raft-shared";

/**
 * A framed page's bare links to other Artifacts, shown with each target's live title
 * (#proj-workspace:#336): the version's links as the links route answers them (shared
 * ArtifactWebLinks; the server decides what each target is for this reader) made into Porthole's
 * link labels (P151, `linkLabels` on the frame). The page reads every label, so only what the
 * route says this reader may see goes in: a title for `ok`, a word of Raft's for `deleted` and
 * `unavailable`, never more.
 *
 * - Only `bare` links (their text is their own address): the shell would label no other.
 * - Only where the version's author sees the target now (`authorSees`; absent reads as no): the
 *   page's scripts are its author's and read every label, so a label may say only what the author
 *   could know too (Porthole's THREAT_MODEL: what the reader may see AND the page may learn). Not
 *   even "No access": the link stays as the page wrote it.
 * - `ok`: the title, with ` · v<n>` for a link that pins a version; none for a pinned version the
 *   reader can't open (`versionExists: false`), so the page shows the address it wrote.
 * - Tags (`data-porthole-label`, which the Markdown page's styles draw as a chip): `artifact-<kind>`,
 *   `artifact-deleted`, `artifact-unavailable`.
 * - One label per address (the first that makes one), at most Porthole's 500; a title is cut to
 *   fit Porthole's 300 characters with its suffix, as a longer one would be dropped.
 */

/** The words for a target the reader can't open, in the reader's language (the caller's catalog). */
export interface ArtifactLinkLabelWords {
  deleted: string;
  unavailable: string;
}

const TAG_PREFIX = "artifact-";
/** Porthole's tag: `[a-z0-9-]{1,32}` (LINK_LABEL_TAG). */
const TAG_MAX = 32;

/** The tag for a target of `kind`: `artifact-<kind>`, held to Porthole's tag characters. */
export function artifactLinkTag(kind: string): string {
  const name = kind.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, TAG_MAX - TAG_PREFIX.length);
  return `${TAG_PREFIX}${name || "other"}`;
}

/** `title` and `suffix` within Porthole's longest text, the title cut (with an ellipsis) where it must be. */
function fitted(title: string, suffix: string): string {
  const room = LINK_LABEL_LIMITS.text - suffix.length;
  if (title.length <= room) return `${title}${suffix}`;
  let cut = title.slice(0, room - 1);
  // Never half a surrogate pair.
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut}…${suffix}`;
}

/** One link's label, or null for a link the viewer leaves as the page wrote it. */
export function artifactLinkLabel(link: ArtifactContentLink, words: ArtifactLinkLabelWords): LinkLabel | null {
  if (!link.bare || link.authorSees !== true) return null;
  const { href, target } = link;
  switch (target.state) {
    case "deleted":
      return { href, text: words.deleted, tag: "artifact-deleted" };
    case "unavailable":
      return { href, text: words.unavailable, tag: "artifact-unavailable" };
    case "ok": {
      if (target.versionExists === false) return null;
      const title = target.title.trim();
      if (!title) return null;
      return { href, text: fitted(title, link.version === null ? "" : ` · v${link.version}`), tag: artifactLinkTag(target.kind) };
    }
    default:
      return null;
  }
}

/** The labels for a version's links: one per address, at most Porthole's limit. */
export function artifactLinkLabels(links: readonly ArtifactContentLink[], words: ArtifactLinkLabelWords): LinkLabel[] {
  const labels: LinkLabel[] = [];
  const labelled = new Set<string>();
  for (const link of links) {
    if (labels.length >= LINK_LABEL_LIMITS.labels) break;
    if (labelled.has(link.href)) continue;
    const label = artifactLinkLabel(link, words);
    if (!label) continue;
    labelled.add(link.href);
    labels.push(label);
  }
  return labels;
}
