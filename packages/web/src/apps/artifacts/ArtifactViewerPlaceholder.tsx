import { useCallback, useContext, useEffect, useMemo, useRef } from "react";
import type { KeyboardEvent } from "react";
import { useIntl } from "react-intl";
import { ArrowLeft, FileX, Maximize2, Minimize2, RefreshCw, X } from "lucide-react";
import {
  Button,
  Panel,
  PanelAction,
  PanelActions,
  PanelHeader,
  PanelHeaderContent,
  PanelHeading,
  PanelStatus,
  PanelTitle,
  PanelToggleAction,
} from "@botiverse/raft-ui";
import EmptyState from "../../components/ui/EmptyState";
import Tooltip from "../../components/ui/Tooltip";
import { PanelHeadLeadContext, RowExpandAction, useRowInRow } from "../../components/layout/appPanelHead";
import { requestFocus } from "../../utils/focusRequest";
import { artifactCardSeed } from "./artifactOpenIntent";
import type { ArtifactLinkTarget } from "./artifactLinks";
import { ArtifactLoadingArea, ArtifactSplashMetaPlaceholder, ArtifactSplashTitlePlaceholder } from "./ArtifactLoadingSplash";
import { ArtifactVersionBadge } from "./ArtifactMessageCard";
import { ArtifactMetaRow } from "./ArtifactMetaRow";
import ArtifactScopeLabel from "./ArtifactScopeLabel";
import { artifactHostOf, artifactOpenFocusReason, returnArtifactFocus, useArtifactViewerStore } from "./artifactViewerStore";
import { WINDOW_TITLE_BAR } from "./artifactWindowTitleBar";

/**
 * The side card while the viewer's code downloads (its first open before the
 * background fetch), or when that download failed. The same panel and 56px
 * head as the viewer's own loading state (ArtifactViewer's ViewerFrame): the
 * card it opened from as the title where it is known (still placeholders where
 * it isn't), the loading splash in the body, Back (shown on a phone
 * only with `ownBack`, as the viewer's) or Close, expand, Escape closes, focus
 * back to the opener on close; so nothing moves when the viewer takes over.
 */
export default function ArtifactViewerPlaceholder({
  target,
  covering,
  ownBack = false,
  expanded = false,
  onToggleExpanded,
  onClose,
  onRetry,
  inWindow = false,
}: {
  target: ArtifactLinkTarget;
  covering: boolean;
  ownBack?: boolean;
  expanded?: boolean;
  onToggleExpanded?: () => void;
  onClose: () => void;
  /** Set when the download failed: the body offers to try again. */
  onRetry?: () => void;
  /** An Artifact's object window (ArtifactViewer `inWindow`): its head is the window's title bar, with no Expand or Close. */
  inWindow?: boolean;
}) {
  const { formatMessage } = useIntl();
  const seed = useMemo(() => artifactCardSeed(target), [target]);
  const closeLabel = formatMessage({ id: "artifacts.viewer.close" });
  const expandLabel = formatMessage({ id: expanded ? "artifacts.viewer.restore" : "artifacts.viewer.expand" });
  const inRow = useRowInRow("artifact") && !inWindow;
  // As the viewer's head: the side window's switch chip, where the built-in browser is open behind it.
  const lead = useContext(PanelHeadLeadContext);
  const panelRef = useRef<HTMLElement | null>(null);
  // As the viewer's frame: focus in on open (not from a text field or dialog the person went to since their press: focus
  // plan rule 2, artifactOpenFocusReason), back to the opener on close (not when the viewer takes over).
  useEffect(() => {
    requestFocus(() => panelRef.current, { reason: artifactOpenFocusReason() });
    // An object window gives focus back itself, in the main window.
    if (inWindow) return;
    const host = artifactHostOf(panelRef.current, useArtifactViewerStore.getState().open?.conversationId);
    return () => {
      if (useArtifactViewerStore.getState().open === null) returnArtifactFocus(host);
    };
  }, [inWindow]);
  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLElement>) => {
    // An object window is not closed by Esc: its own close and ⌘W close it (ArtifactViewer `inWindow`).
    if (event.key !== "Escape" || event.defaultPrevented || inWindow) return;
    event.preventDefault();
    onClose();
  }, [onClose, inWindow]);
  const failed = onRetry !== undefined;
  return (
    <Panel
      ref={panelRef}
      edge="inset"
      aria-label={seed?.title ?? formatMessage({ id: "artifacts.viewer.regionLabel" })}
      aria-busy={failed ? undefined : true}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      className="flex size-full min-h-0 flex-col outline-none"
      data-testid="artifact-viewer-placeholder"
      data-side-card-focus=""
    >
      <PanelHeader {...(inWindow ? WINDOW_TITLE_BAR : null)}>
        {covering ? (
          <PanelAction aria-label={closeLabel} onClick={onClose} className={ownBack ? undefined : "max-md:hidden"} data-testid="artifact-viewer-placeholder-back">
            <ArrowLeft />
          </PanelAction>
        ) : null}
        {lead?.node}
        <PanelHeaderContent>
          {seed ? (
            <PanelHeading>
              <PanelTitle>{seed.title}</PanelTitle>
              <PanelStatus><ArtifactVersionBadge version={seed.version} /></PanelStatus>
            </PanelHeading>
          ) : failed ? null : (
            // As the viewer's own loading header with nothing known: still placeholders (ArtifactLoadingSplash).
            <PanelHeading><ArtifactSplashTitlePlaceholder /></PanelHeading>
          )}
          {seed ? (
            // The viewer's own meta row on a phone, as tall as the readers' stack, so nothing moves when it takes over;
            // a desktop head is one line.
            <ArtifactMetaRow text={<ArtifactScopeLabel home={seed.home} fromAnotherServer={seed.fromAnotherServer} />} phoneOnly />
          ) : failed ? null : <ArtifactMetaRow text={<ArtifactSplashMetaPlaceholder />} phoneOnly />}
        </PanelHeaderContent>
        <PanelActions>
          {/* A column of the planned row (#189): the row's Expand (rule 5). */}
          {inRow ? <RowExpandAction region="artifact" /> : onToggleExpanded ? (
            <Tooltip content={expandLabel}>
              <PanelToggleAction aria-label={expandLabel} pressed={expanded} onPressedChange={onToggleExpanded} className="max-md:hidden">
                {expanded ? <Minimize2 /> : <Maximize2 />}
              </PanelToggleAction>
            </Tooltip>
          ) : null}
          {covering || inWindow ? null : (
            <Tooltip content={closeLabel}>
              <PanelAction aria-label={closeLabel} onClick={onClose} data-testid="artifact-viewer-placeholder-close">
                <X />
              </PanelAction>
            </Tooltip>
          )}
        </PanelActions>
      </PanelHeader>
      {failed ? (
        <div role="status" className="flex flex-1 items-center justify-center p-6" data-testid="artifact-viewer-chunk-failed">
          <EmptyState
            icon={<FileX size={36} />}
            title={formatMessage({ id: "artifacts.frame.failedTitle" })}
            action={(
              <Button variant="outline" size="md" onClick={onRetry} data-testid="artifact-viewer-chunk-retry">
                <RefreshCw />
                {formatMessage({ id: "artifacts.frame.retry" })}
              </Button>
            )}
          />
        </div>
      ) : (
        // The opening's loading splash, the viewer's own once it takes over (DeferredArtifactViewer's ArtifactSplashScope).
        <ArtifactLoadingArea kind={seed?.kind ?? null} testId="artifact-viewer-loading" />
      )}
    </Panel>
  );
}
