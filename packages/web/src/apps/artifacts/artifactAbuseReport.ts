/** Where "Report abuse" writes to: the contact address the site already uses (xxchan). */
export const ARTIFACT_ABUSE_EMAIL = "contact@raft.build";

/**
 * What "Report abuse" opens: a mail to the contact address, its subject Raft's own words and its
 * body the Artifact's link, so whoever reads it knows which one. One copy for the two places it
 * is offered: the public page's ⋯ (PublicArtifactPage) and, for a reader from another server, the
 * viewer's ⋯ (ArtifactViewerMenu). A member of the Artifact's own server has its people to tell.
 */
export function artifactAbuseHref(url: string, subject: string): string {
  return `mailto:${ARTIFACT_ABUSE_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(url)}`;
}
