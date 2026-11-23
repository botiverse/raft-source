import { useCallback, useEffect, useEffectEvent, useMemo } from "react";
import { useNavigate } from "react-router-dom";

import { openObjectWindowInMain, raiseMainWindow, registerObjectWindowKind, setObjectWindowTitle } from "../../features/objectWindows";
import type { ObjectWindowRenderProps } from "../../features/objectWindows";
import { useServerStore } from "../../store/serverStore";
import { useArtifactsAppName } from "./ArtifactLinkPreview";
import { artifactOpenPath } from "./artifactLinks";
import type { ArtifactLinkTarget } from "./artifactLinks";
import { ARTIFACT_OBJECT_WINDOW_KIND, artifactWindowPayloadOf } from "./artifactWindowOpening";
import { openArtifact } from "./artifactOpenEarly";
import { artifactSource } from "./artifactSource";
import { DeferredArtifactViewer } from "./ArtifactSideCard";

/**
 * The version each Artifact window shows now, by its payload (the store's object: the same across a reload, another
 * on a replacement): a version picked in the window (its history, Back to Latest; null: the latest) is what Open in
 * main window opens, not the one it was opened at (read before the window closes). Forgotten as the window's view
 * goes.
 */
const shownVersions = new WeakMap<object, number | null>();
/** The key of a payload that is no object (never an Artifact window's: it draws nothing). */
const NO_PAYLOAD = {};

/**
 * The server whose Artifacts home the main window opens it in, as the canonical link's page decides it
 * (ArtifactPermalink): `open`'s `opensIn`, the Artifact's own server, for a member reading it there (its answer's
 * frame ticket kept for the viewer about to open, artifactOpenEarly); a public one read as an outsider, here; `open`'s
 * one 404, for an Artifact of a joint channel the reader sees from another of their servers, where `locate` finds it
 * seen from. The current server when nothing else is known.
 */
async function mainServerSlug(target: ArtifactLinkTarget): Promise<string | null> {
  const current = useServerStore.getState().current;
  try {
    const { opensIn } = await openArtifact(target);
    return opensIn?.slug ?? current?.slug ?? null;
  } catch (error) {
    if (!current) return null;
    if ((error as { status?: unknown } | null)?.status !== 404) return current.slug;
    try {
      const location = await artifactSource().locate(target.id, { id: current.id, slug: current.slug });
      return location.serverArtifactsOff ? current.slug : location.serverSlug;
    } catch {
      return current.slug;
    }
  }
}

/**
 * Registers the Artifact kind of object window (#337 PR3): what its window
 * draws (ArtifactWindowView), and Open in main window (its head's button and
 * Window › Open in Main Window), which raises the main window and shows the
 * Artifact, at the version the window shows, in the Artifacts home's viewer
 * (`?artifact=`, `&version=` when pinned: its full-window viewer, Remy's
 * design: "the main window opens it where it opens there") of the server it
 * opens in (mainServerSlug). Mounted once by the layout beside
 * ObjectWindowsHost (core imports no app; the layout already imports
 * Artifacts' entry). Renders nothing.
 */
export function ArtifactObjectWindows() {
  const navigate = useNavigate();
  const openInMain = useEffectEvent((payload: unknown) => {
    // Read now, with the window and its view still there (openObjectWindowInMain closes it once this returns).
    const artifact = artifactWindowPayloadOf(payload);
    if (!artifact) return;
    const known = typeof payload === "object" && payload !== null && shownVersions.has(payload);
    const target = { id: artifact.target.id, version: known ? shownVersions.get(payload as object) ?? null : artifact.target.version };
    void raiseMainWindow();
    void mainServerSlug(target).then((slug) => {
      // `from=other`: not a search hit (the address's default); the window's own opening was counted already.
      if (slug) void navigate(`/s/${encodeURIComponent(slug)}${artifactOpenPath(target.id, target.version, "other")}`);
    });
  });
  useEffect(() => registerObjectWindowKind<unknown>(ARTIFACT_OBJECT_WINDOW_KIND, ArtifactWindowView, {
    openInMain: (payload) => openInMain(payload),
  }), []);
  return null;
}

/**
 * An Artifact's object window: the viewer the main window shows (the same
 * component, its comments, versions, find and ⋯), filling the window, in its
 * window mode (ArtifactViewer `inWindow`): its head is the window's title bar
 * (clear of the traffic lights or the caption buttons, the drag region), with
 * Copy link, ⋯ (Open in system browser its first item) and Open in main
 * window in place of Expand and Close (the window's own close or ⌘W closes
 * it, never Esc). Its links and its navigation act in the main window
 * (features/objectWindows); the window keeps its Artifact. The window's title
 * is the Artifact's once it has loaded (the app's name for one it can't show). A replaced Artifact remounts this
 * (the host keys the render by revision): a new viewer, a new frame.
 */
function ArtifactWindowView({ name, payload, close }: ObjectWindowRenderProps<unknown>) {
  const artifact = useMemo(() => artifactWindowPayloadOf(payload), [payload]);
  const openInMain = useCallback(() => openObjectWindowInMain(name), [name]);
  const inWindow = useMemo(() => ({ onOpenInMain: openInMain }), [openInMain]);
  // Its title: the Artifact's once loaded; the app's name for one that can't be shown (never the one it showed
  // before). Only while this payload is the window's: the view a replacement unmounts names nothing any more.
  const appName = useArtifactsAppName();
  const showTitle = useCallback((title: string | null) => setObjectWindowTitle(name, title ?? appName, payload), [name, appName, payload]);
  const keyed: object = typeof payload === "object" && payload !== null ? payload : NO_PAYLOAD;
  // Forgotten as this view goes (a reload's view shows the payload's version again); read before that by Open in main
  // window, which closes the window first.
  useEffect(() => () => {
    shownVersions.delete(keyed);
  }, [keyed]);
  const showVersion = useCallback((version: number | null) => {
    shownVersions.set(keyed, version);
  }, [keyed]);
  if (!artifact) return null;
  return (
    <div className="flex h-dvh min-h-0 flex-col bg-layer-canvas" data-testid="artifact-object-window">
      <DeferredArtifactViewer
        target={artifact.target}
        source={artifact.source}
        expanded
        covering={false}
        onClose={close}
        onShownTitle={showTitle}
        onShowVersion={showVersion}
        inWindow={inWindow}
      />
    </div>
  );
}
