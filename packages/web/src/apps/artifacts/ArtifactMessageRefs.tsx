import { useMemo } from "react";
import type { ArtifactCard, ArtifactReference } from "@botiverse/raft-shared";

import type { ObjectSummaryResult } from "../../objects/objectSummaryLoader";

import { artifactDeletedOf } from "./artifactFacts";
import type { ArtifactDeletedShown } from "./artifactFacts";
import { artifactLinkTarget, useArtifactAppHosts } from "./artifactLinks";
import type { ArtifactLinkTarget } from "./artifactLinks";
import ArtifactMessageCard, { ArtifactDeletedCard, ArtifactMessageCardLoading } from "./ArtifactMessageCard";
import { useWorkspaceArtifactsEnabled } from "./useWorkspaceArtifactsEnabled";

const NO_TARGETS: ReadonlyMap<string, ArtifactLinkTarget> = new Map();

/**
 * The Artifacts among a message's visible bare links (`urls`: shared
 * `messageBareLinks`, as core's per-message link-card hook reads them once),
 * by each link's href, on the app hosts (useArtifactAppHosts: split again
 * when the server's list arrives). None with workspace_artifacts_v0 off:
 * then the links are plain links, read for App previews like any other.
 */
export function useArtifactLinkTargets(urls: readonly string[]): ReadonlyMap<string, ArtifactLinkTarget> {
  const enabled = useWorkspaceArtifactsEnabled();
  const hosts = useArtifactAppHosts();
  return useMemo(() => {
    if (!enabled || urls.length === 0) return NO_TARGETS;
    const targets = new Map<string, ArtifactLinkTarget>();
    for (const url of urls) {
      const target = artifactLinkTarget(url, hosts);
      if (target) targets.set(url, target);
    }
    return targets.size ? targets : NO_TARGETS;
  }, [enabled, urls, hosts]);
}

/** How one Artifact link of a message stands: `loading` until its read answers. */
export type ArtifactLinkState = "loading" | "ok" | "deleted" | "unavailable" | "error";

/**
 * One Artifact link of a message as core's per-message link-card hook
 * (components/message/useMessageLinkCards.ts) answers it: the chip in the
 * text and the card under the message are drawn from this one answer. `ok`
 * always carries the summary and `deleted` what is shown of the deleted
 * Artifact (to a viewer who could see it before); nothing else does.
 */
export type ArtifactLink =
  | { state: "ok"; data: { objectKind: "artifact"; target: ArtifactLinkTarget; summary: ArtifactCard } }
  | { state: "deleted"; data: { objectKind: "artifact"; target: ArtifactLinkTarget; summary: null; deleted: ArtifactDeletedShown } }
  | { state: Exclude<ArtifactLinkState, "ok" | "deleted">; data: { objectKind: "artifact"; target: ArtifactLinkTarget; summary: null } };

/**
 * What an Artifact link shows for its read's answer (`result`; none yet:
 * `loading`). The one place a deleted answer is read (artifactDeletedOf):
 * `deleted` only with a title, else `unavailable`, as is any status this
 * client doesn't know.
 */
export function artifactLinkOf(target: ArtifactLinkTarget, result: ObjectSummaryResult<"artifact"> | undefined): ArtifactLink {
  const base = { objectKind: "artifact" as const, target };
  if (!result) return { state: "loading", data: { ...base, summary: null } };
  if (result.status === "ok") return { state: "ok", data: { ...base, summary: result.summary } };
  if (result.status === "deleted") {
    const deleted = artifactDeletedOf(result.deleted);
    return deleted ? { state: "deleted", data: { ...base, summary: null, deleted } } : { state: "unavailable", data: { ...base, summary: null } };
  }
  return { state: result.status === "error" ? "error" : "unavailable", data: { ...base, summary: null } };
}

type DrawnRef =
  | { key: string; reference: ArtifactReference; deleted: null }
  | { key: string; reference: null; deleted: ArtifactDeletedShown };

/**
 * The cards under a message for the Artifacts its text links to (MessageEmbed
 * in the embedded slot), one per Artifact reference in order (`links`, from
 * the message's one link-card read: the same answers as the chips in its
 * text; nothing is asked here). While any is loading, one Skeleton in the
 * card's shape. `ok` is its card; `deleted` the gray deleted card (title,
 * who deleted it and when; nothing opens), only ever sent to a viewer who
 * could see it before; `unavailable` or `error` adds nothing: the
 * link in the text is all a viewer who can't see it gets (F11). Behind
 * workspace_artifacts_v0: with the flag off a message has no Artifact links
 * (useArtifactLinkTargets), so nothing is drawn and the links stay plain.
 */
export default function ArtifactMessageRefs({ links }: { links: readonly ArtifactLink[] }) {
  // What is drawn, keyed by the link's reference (and place: a repeat is drawn again).
  const drawn = useMemo(() => links.flatMap((link, index): DrawnRef[] => {
    const key = `${link.data.target.id}@${link.data.target.version ?? "latest"}#${index}`;
    if (link.state === "ok") return [{ key, reference: { status: "ok", card: link.data.summary }, deleted: null }];
    if (link.state === "deleted") return [{ key, reference: null, deleted: link.data.deleted }];
    return [];
  }), [links]);
  if (links.length === 0) return null;
  // Both roots are this viewer's view of the Artifacts: a share image never
  // includes them (selectScreenshot.ts, viewer-only previews).
  if (links.some((link) => link.state === "loading")) {
    return <div className="mt-2 flex min-w-0 flex-col gap-2" data-select-screenshot-viewer-only="true"><ArtifactMessageCardLoading /></div>;
  }
  if (drawn.length === 0) return null;
  return (
    <div className="mt-2 flex min-w-0 flex-col gap-2" data-testid="artifact-message-refs" data-select-screenshot-viewer-only="true">
      {drawn.map(({ key, reference, deleted }) => (
        reference ? <ArtifactMessageCard key={key} reference={reference} /> : <ArtifactDeletedCard key={key} deleted={deleted} />
      ))}
    </div>
  );
}
