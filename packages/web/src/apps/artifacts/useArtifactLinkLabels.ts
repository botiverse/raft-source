import { useEffect, useMemo, useState } from "react";
import { useIntl } from "react-intl";
import type { LinkLabel } from "@botiverse/porthole";
import type { ArtifactContentLink, ArtifactId, ArtifactWebLinks } from "@botiverse/raft-shared";

import { artifactLinkLabels } from "./artifactLinkLabels";
import { artifactSource } from "./artifactSource";

/**
 * Where a version's links to other Artifacts come from: the signed-in links route
 * (`artifactWebPaths.links`, ArtifactSource `links`), or the public one for a signed-out page
 * (`artifactPublicPaths.links`, the current version's only).
 */
export type ArtifactLinksLoader = (id: ArtifactId, version: number) => Promise<ArtifactWebLinks>;

/** The signed-in links route, through the Artifacts source; a source without it (the fake) labels nothing. */
export const signedInArtifactLinks: ArtifactLinksLoader = (id, version) =>
  artifactSource().links?.(id, version) ?? Promise.resolve({ version, links: [] });

const NONE: readonly LinkLabel[] = [];

/**
 * The frame's link labels for version `version` of `id` (artifactLinkLabels; #proj-workspace:#336):
 * asked once per version, and `[]` until its answer is in, as Porthole asks (a label held from the
 * last content would reach the new one). An answer for another version (the public route answers
 * the current one, which a push may have moved), a refusal or a failure labels nothing: the page
 * shows its links as written. `load` null (a PDF, which has no links to label): nothing is asked.
 * `load` is a stable function (a module's): a new one asks again.
 */
export function useArtifactLinkLabels(id: ArtifactId, version: number, load: ArtifactLinksLoader | null): readonly LinkLabel[] {
  const { formatMessage } = useIntl();
  const key = `${id}@${version}`;
  const [answer, setAnswer] = useState<{ key: string; links: readonly ArtifactContentLink[] } | null>(null);
  useEffect(() => {
    if (!load) return;
    let cancelled = false;
    load(id, version).then((links) => {
      if (cancelled || links.version !== version || !Array.isArray(links.links)) return;
      setAnswer({ key: `${id}@${version}`, links: links.links });
    }, () => {
      // No labels: the links stay as the page wrote them.
    });
    return () => { cancelled = true; };
  }, [id, version, load]);
  const deleted = formatMessage({ id: "artifacts.frame.linkDeleted" });
  const unavailable = formatMessage({ id: "artifacts.frame.linkNoAccess" });
  const links = answer?.key === key ? answer.links : null;
  return useMemo(() => (links ? artifactLinkLabels(links, { deleted, unavailable }) : NONE), [links, deleted, unavailable]);
}
