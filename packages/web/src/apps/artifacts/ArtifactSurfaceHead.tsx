import { useCallback } from "react";
import { PanelTitle } from "@botiverse/raft-ui";

import { ArtifactBacklinksChip } from "./ArtifactBacklinks";
import { ArtifactMetaRow } from "./ArtifactMetaRow";
import ArtifactOriginLink from "./ArtifactOriginLink";
import { ArtifactPresence } from "./ArtifactPresence";
import ArtifactScopeLabel from "./ArtifactScopeLabel";
import { ArtifactShownFilePath } from "./ArtifactShownFilePath";
import { useArtifactSurface } from "./ArtifactSurface";
import { ArtifactVersionTag } from "./ArtifactVersionHistory";
import { ArtifactSettledTag } from "./ArtifactSettledParts";
import { useArtifactBacklinksHere } from "./useArtifactBacklinks";

/**
 * The header's parts every shell places (ArtifactSurface's, as its actions are): the title, the version tag and,
 * where a head has a line under its title (a phone's, the App's toolbar), the meta line. A desktop head is one line:
 * its title opens the details instead (ArtifactDetailsTitle), where the meta line's parts are.
 */

/**
 * The header's title, the same in every shell: text only (#proj-workspace:#169:
 * ⋯'s Rename renames it, in its dialog). `pageHeading`: the title is the
 * page's h1 (the Artifact's own page).
 */
export function ArtifactSurfaceTitle({ pageHeading = false, testId }: { pageHeading?: boolean; testId: string }) {
  const { data } = useArtifactSurface(), { title } = data.card;
  const heading = pageHeading ? <PanelTitle render={<h1>{title}</h1>} data-testid={testId} /> : <PanelTitle data-testid={testId}>{title}</PanelTitle>;
  return <>{heading}<ArtifactShownFilePath data={data} /></>;
}

/**
 * The header's version tag beside the title, the same in every shell: with
 * more than one version it switches versions (a menu on a desktop, the
 * version sheet on a phone), as ⋯'s Version history does. After it, while the
 * Artifact is settled (#334), the Settled tag (its tooltip: who, when, which
 * version); then, on a desktop's one-line head, "Linked from N" while
 * something links it (#proj-workspace:#336 step 2: ArtifactBacklinksChip; a
 * phone's is in its meta line); the head stays one line.
 */
export function ArtifactSurfaceVersionTag() {
  const { data, phone, pickVersion, setVersionsOpen } = useArtifactSurface();
  const openVersions = useCallback(() => setVersionsOpen(true), [setVersionsOpen]);
  const tag = <ArtifactVersionTag data={data} phone={phone} onPick={pickVersion} onOpenSheet={openVersions} />;
  const linked = useArtifactBacklinksHere() !== null && !phone;
  const { settled } = data.card;
  if (!settled && !linked) return tag;
  return (
    <span className="flex min-w-0 items-center gap-1" data-testid="artifact-head-status">
      {tag}
      {settled ? <ArtifactSettledTag settled={settled} /> : null}
      {linked ? <ArtifactBacklinksChip /> : null}
    </span>
  );
}

/**
 * The header's meta line where a head has one (a phone's, the App's toolbar): where it lives (the
 * visibility chip, which offers its options where the capabilities allow),
 * its original message (into the server, to it), "Linked from N" where
 * something links it (ArtifactBacklinksChip), then who else is here and
 * who read it (ArtifactPresence), the same at every width (stdrc's option A,
 * #proj-raft-ui:7531279d). Laid out by ArtifactMetaRow: the text part
 * truncates, the readers sit beside it and never shrink. The shell renders
 * it under the title as it is (it holds its own PanelMeta).
 */
export function ArtifactSurfaceMeta({ replace = false, onOpened, testId, scopeInMenu = false }: {
  /** The visibility chip folded into ⋯ (a phone's head with no room; #189 rule 6): not here. */
  scopeInMenu?: boolean;
  /** Opening the original message replaces this history entry (the viewer on a phone is a page with its own). */
  replace?: boolean;
  /** After the original message opened (the side card closes where it covers its channel). */
  onOpened?: () => void;
  testId?: string;
}) {
  const { data, actions, chipRef, presence, phone } = useArtifactSurface();
  return (
    <ArtifactMetaRow
      testId={testId}
      text={(
        <>
          {/* A narrowing dialog gives focus back to the chip. */}
          {scopeInMenu ? null : <ArtifactScopeLabel home={data.card.home} fromAnotherServer={data.card.fromAnotherServer} visibility={actions.visibility} triggerRef={chipRef} />}
          <ArtifactOriginLink origin={data.origin} replace={replace} onOpened={onOpened} />
          {/* "Linked from N" (#proj-workspace:#336 step 2): here where the head has this line, beside the title on a desktop's. */}
          {phone ? <ArtifactBacklinksChip /> : null}
        </>
      )}
      readers={<ArtifactPresence presence={presence} facesOnly={phone} />}
    />
  );
}
