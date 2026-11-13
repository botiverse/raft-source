import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { ArrowLeft } from "lucide-react";
import { Panel, PanelAction, PanelHeader, PanelHeaderContent, PanelHeading } from "@botiverse/raft-ui";

import { hasHostBack, isChromeless, isHostShell } from "../../embed";
import Tooltip from "../../components/ui/Tooltip";
import { artifactLinkWaitStart, noteArtifactLinkWaitShown } from "./artifactLinkWait";
import { ArtifactLoadingSplash, ArtifactSplashMetaPlaceholder, ArtifactSplashScope, ArtifactSplashTitlePlaceholder } from "./ArtifactLoadingSplash";
import { ArtifactMetaRow } from "./ArtifactMetaRow";
import { HOST_TOOLBAR_ROOM } from "./artifactHostToolbar";
import { requestArtifactHostClose } from "./artifactPageOpening";

/**
 * Back at the start of the App's toolbar, with `back=host` (embed.ts; #proj-workspace:#264): the App
 * draws no title bar over the page, so the page's Back asks it to close the page (`#host=close`,
 * a hashchange the App watches). The header's Back as everywhere else: the bar's icon button (a 44px
 * target on a phone), the arrow, on finger lift. Nothing without `back=host`, but where the page draws the only bar
 * (`ownBar`: the App declared `hostMenu`, and drops its bar once the page's is up), which needs Back as well.
 */
export function ArtifactHostBack({ ownBar = false }: { ownBar?: boolean } = {}) {
  const { formatMessage } = useIntl();
  if (!hasHostBack() && !ownBar) return null;
  const label = formatMessage({ id: "artifacts.page.back" });
  return (
    <Tooltip content={label}>
      <PanelAction aria-label={label} onClick={requestArtifactHostClose} activateOnTouchEnd data-testid="artifact-page-host-back">
        <ArrowLeft />
      </PanelAction>
    </Tooltip>
  );
}

/**
 * The Artifact's own page while nothing is known of it: its layout with what is known (Back where
 * there is a page behind), still placeholders for the title and the meta line, and `children` (the
 * loading splash) over the content area. In the App only the toolbar row (its native title bar is
 * above); chromeless, the content alone. The canonical link's screen and the page's own first stage
 * (ArtifactStandalonePage) are this one layout, so the page taking over moves nothing.
 */
export function ArtifactPageLoadingLayout({ hostShell, onGoBack, testId, children }: { hostShell: boolean; onGoBack?: () => void; testId: string; children: ReactNode }) {
  const { formatMessage } = useIntl();
  const backLabel = formatMessage({ id: "artifacts.page.back" });
  const meta = <ArtifactMetaRow text={<ArtifactSplashMetaPlaceholder />} />;
  return (
    <main className="flex min-h-0 flex-1 flex-col bg-layer-canvas font-display safe-top safe-bottom" aria-busy="true" data-testid={testId}>
      <Panel edge="inset" aria-label={formatMessage({ id: "artifacts.viewer.regionLabel" })} className="flex min-h-0 flex-1 flex-col">
        {isChromeless() ? null : hostShell ? (
          <PanelHeader className={`border-b border-line-seam ${HOST_TOOLBAR_ROOM}`} data-embed-shell="host">
            <ArtifactHostBack />
            <PanelHeaderContent>{meta}</PanelHeaderContent>
          </PanelHeader>
        ) : (
          <PanelHeader className="border-b border-line-seam" data-boot-artifact-head="">
            {onGoBack ? (
              <Tooltip content={backLabel}>
                <PanelAction aria-label={backLabel} onClick={onGoBack} data-testid="artifact-page-back">
                  <ArrowLeft />
                </PanelAction>
              </Tooltip>
            ) : null}
            <PanelHeaderContent>
              <PanelHeading><ArtifactSplashTitlePlaceholder /></PanelHeading>
              {meta}
            </PanelHeaderContent>
          </PanelHeader>
        )}
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
      </Panel>
    </main>
  );
}

/**
 * What the canonical link (`/artifacts/<id>`, `/v/<n>`) shows until it knows
 * what to show: the Artifact's page as it loads (ArtifactPageLoadingLayout)
 * with the loading splash (ArtifactLoadingSplash, the trial of
 * #proj-workspace:#145) and "Loading Artifact" as its line, never a bare spinner or the app's
 * generic "Loading…". The same from the first frame on: the boot shell
 * prerenders it into index.html (boot/prerenderShell, shown under
 * `html.boot-artifact`; `prerender`: the complete icon, held hidden by the
 * shell's CSS for the first second), and the app keeps it through its own
 * boot (auth), the page's chunk, the page's `open` and the signed-out public
 * view's read, so nothing changes on screen until the answer does.
 *
 * It is the same cover the page continues: every link screen of one wait and
 * the page after it count from when the wait began (artifactLinkWait: the
 * navigation, for the first one of a page load), so a page that comes after
 * the first second shows the icon at once, mid-cycle, where it was, and no
 * placeholder is swapped for another.
 *
 * Says nothing of the Artifact (its title, server, kind or whether it
 * exists): the same for every link until the answer comes.
 */
/** `onGoBack`: Back, where there is an in-app page behind the link (as the page that takes over draws it). */
export default function ArtifactLinkLoading({ testId = "artifact-link-loading", prerender = false, onGoBack }: { testId?: string; prerender?: boolean; onGoBack?: () => void }) {
  const { formatMessage } = useIntl();
  const [startedAt] = useState(() => (prerender ? 0 : artifactLinkWaitStart()));
  const initialStart = useCallback(() => startedAt, [startedAt]);
  useEffect(() => noteArtifactLinkWaitShown(), []);
  // Its own line ("Loading Artifact", in every locale): it says nothing yet of what it opens.
  const splash = <ArtifactLoadingSplash stage="getting" kind={null} label={formatMessage({ id: "artifacts.viewer.loading" })} startedAt={startedAt} prerendered={prerender} testId="artifact-link-loading-status" />;
  const page = <ArtifactPageLoadingLayout hostShell={!prerender && isHostShell()} onGoBack={onGoBack} testId={testId}>{splash}</ArtifactPageLoadingLayout>;
  // Prerendered, the placeholders stay empty (no clock in index.html); live, they follow the wait's start.
  return prerender ? page : <ArtifactSplashScope openingKey="link" initialStart={initialStart}>{page}</ArtifactSplashScope>;
}
