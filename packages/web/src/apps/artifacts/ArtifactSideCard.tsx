import { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArtifactIcon } from "@botiverse/ricons";
import type { ComponentProps, ReactNode } from "react";
import { useIntl } from "react-intl";

import { importHandledLocally, lazyDeferred } from "../../boot/appChunkLoading";
import { useMediaQuery } from "../../hooks/effectPrimitives";
import { PHONE_QUERY, usePhoneHistoryEntry } from "./artifactPhoneHistory";
import { registerArtifactHost, registerArtifactShell, useArtifactViewerStore } from "./artifactViewerStore";
import type { RevealArtifactHost } from "./artifactViewerStore";
import { ArtifactChunkBoundary, useRetryableLazy } from "./artifactLazyChunk";
import { ArtifactSplashScope } from "./ArtifactLoadingSplash";
import type { LazyChunkSlot } from "./artifactLazyChunk";
import { rememberArtifactShownTitle } from "./artifactShownTitle";
import { loadArtifactViewer } from "./artifactViewerChunk";
import ArtifactViewerPlaceholder from "./ArtifactViewerPlaceholder";
import { useWorkspaceArtifactsEnabled } from "./useWorkspaceArtifactsEnabled";

// The viewer loads off the first screen (artifactViewerChunk.ts).
const ArtifactViewer = lazyDeferred(() => importHandledLocally(() => import("./ArtifactViewer")));
const viewerSlot: LazyChunkSlot<ArtifactViewerProps> = { current: ArtifactViewer };

type ArtifactViewerProps = ComponentProps<typeof ArtifactViewer>;

/**
 * The viewer, with ArtifactViewerPlaceholder while its code downloads and,
 * when the download fails, the same card with Try again (not the app's
 * RootErrorBoundary). Exported for its tests.
 */
export function DeferredArtifactViewer(props: ArtifactViewerProps) {
  const { Chunk, attempt, retry } = useRetryableLazy(viewerSlot, loadArtifactViewer);
  const placeholder = (onRetry?: () => void) => (
    <ArtifactViewerPlaceholder
      target={props.target}
      covering={props.covering}
      ownBack={props.ownBack}
      expanded={props.expanded}
      onToggleExpanded={props.onToggleExpanded}
      onClose={props.onClose}
      onRetry={onRetry}
    />
  );
  // One loading splash from the opening, across the placeholder and the viewer taking over (ArtifactLoadingSplash).
  return (
    <ArtifactSplashScope openingKey={`${props.target.id}@${props.target.version ?? "latest"}#${props.opening ?? ""}`} size="side">
      <ArtifactChunkBoundary resetKey={attempt} failed={placeholder(retry)}>
        <Suspense fallback={placeholder()}>
          <Chunk {...props} />
        </Suspense>
      </ArtifactChunkBoundary>
    </ArtifactSplashScope>
  );
}

/**
 * The card's width beside the messages while it is open (Noel, F41): an
 * Artifact is a document, and Task v2's 360px is a list's width. The column
 * shows at least this much, as far as the panel leaves the messages 360px,
 * without changing the width it remembers.
 */
export const ARTIFACT_CARD_MIN_WIDTH = 480;

/**
 * Where the channel's side column puts the card (Task v2's `ChannelSideColumn`,
 * its `SideColumnAppPlace`): beside the messages, floating over them, covering
 * the panel (a phone, a narrow panel), or expanded over the whole row.
 */
export interface ArtifactCardPlace {
  mode: "beside" | "float" | "overlay" | "expanded";
  canExpand: boolean;
}

/** The card the side column stacks above Tasks and Files (its `SideColumnApp`). */
export interface ArtifactSideCard {
  label: string;
  icon: ReactNode;
  openedAt: number;
  minWidth: number;
  splitLabel: string;
  expanded: boolean;
  render: (place: ArtifactCardPlace) => ReactNode;
}

/**
 * The Artifact open in this channel, as a card for the channel's side column
 * (F41): a Task v2 card on top of Tasks and Files, laid out by the column
 * (beside, floating, covering, stacked 3:2, tabs where they don't fit). Its
 * expand is the row's focus mode, as the thread's: it takes the whole row. Covering (a phone, a
 * narrow panel) it has Back instead of close: its own on a narrow desktop
 * panel, the channel header's on a phone (useArtifactHeaderBack), where it
 * also owns a history entry for the system Back.
 *
 * Where the page shows its conversation (its channel's or DM's page, Activity's
 * or Search's detail) the card is the page's address (`?artifact=<id>`,
 * `&version=<n>`: MainLayout's useArtifactViewerAddress, as `?thread=` is the
 * thread's; the shell's card and the dialog's cover too): opening it
 * pushes an entry, Back and its close take it away, a version picked
 * replaces `version`, and a reload or a copied address opens it again. On a
 * phone that entry is the card's page, so it pushes none of its own.
 *
 * Focus moves into the viewer when it opens and back to the card that opened
 * it when it closes (ArtifactViewer). Null with the flag off, in a panel that
 * doesn't host Artifacts (`channelId` null), or when what's open belongs to
 * another channel.
 */
export function useArtifactSideCard(channelId: string | null | undefined): ArtifactSideCard | null {
  const enabled = useWorkspaceArtifactsEnabled() && !!channelId;
  const addressed = useArtifactViewerStore((s) => !!channelId && s.addressed?.conversationId === channelId);
  return useArtifactCard(useArtifactViewerStore((s) => enabled && s.open !== null && s.open.conversationId === channelId), false, addressed);
}

/**
 * The Artifact the app shell shows (ArtifactPlace without a conversation or a
 * dialog: opened where no channel panel is, as from a thread Activity opened),
 * as the same card for the same side area: ShellArtifactHost puts it in the
 * row beside the main area, where it lays out, expands and covers on a phone
 * as beside a channel.
 */
export function useShellArtifactCard(): ArtifactSideCard | null {
  const enabled = useWorkspaceArtifactsEnabled();
  const addressed = useArtifactViewerStore((s) => s.addressed?.shell === true);
  return useArtifactCard(useArtifactViewerStore((s) => enabled && s.open !== null && s.open.conversationId === null && s.open.cover === null), true, addressed);
}

/**
 * The app shell's part in the opening rule (ShellArtifactHost, while
 * mounted): with it, an Artifact clicked anywhere in Raft opens in place
 * (findArtifactPlace). `page` names what the main area shows (its address):
 * when it changes, an Artifact the shell shows or one over a dialog closes,
 * as moving to another channel leaves that channel's behind.
 */
export function useArtifactShell(page: string): void {
  useEffect(() => registerArtifactShell(), []);
  const shown = useRef(page);
  useEffect(() => {
    if (shown.current === page) return;
    shown.current = page;
    const { open, close } = useArtifactViewerStore.getState();
    if (open && open.conversationId === null) close();
  }, [page]);
}

/**
 * `ownBack`: covering on a phone, Back is its own (no channel header above it to hold it). `addressed`: the
 * page's address holds the open (its history entry is the phone page's).
 */
function useArtifactCard(showing: boolean, ownBack: boolean, addressed = false): ArtifactSideCard | null {
  const { formatMessage } = useIntl();
  const open = useArtifactViewerStore((s) => s.open);
  const openedAt = useArtifactViewerStore((s) => s.openedAt);
  const expanded = useArtifactViewerStore((s) => s.expanded);
  const close = useArtifactViewerStore((s) => s.close);
  const showVersion = useArtifactViewerStore((s) => s.showVersion);
  const setExpanded = useArtifactViewerStore((s) => s.setExpanded);
  const phone = useMediaQuery(PHONE_QUERY);
  const id = showing && open ? open.id : null;
  const version = showing && open ? open.version : null;
  const source = showing && open ? open.source : null;
  const comments = showing && open ? open.comments ?? null : null;

  usePhoneHistoryEntry(showing && phone && !addressed, close);

  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const toggleExpanded = useCallback(() => setExpanded(!expandedRef.current), [setExpanded]);
  const label = formatMessage({ id: "artifacts.viewer.regionLabel" });
  const splitLabel = formatMessage({ id: "artifacts.viewer.resizeSplit" });

  const target = useMemo(() => (id === null ? null : { id, version }), [id, version]);
  // Kept for whoever names this Artifact while its viewer is off screen (useOpenArtifactTitle).
  const rememberTitle = useCallback((title: string | null) => {
    if (id !== null) rememberArtifactShownTitle(id, title);
  }, [id]);
  return useMemo(() => {
    if (target === null || source === null) return null;
    const { id, version } = target;
    return {
      label,
      icon: <ArtifactIcon />,
      openedAt,
      minWidth: ARTIFACT_CARD_MIN_WIDTH,
      splitLabel,
      expanded,
      render: (place: ArtifactCardPlace) => (
        <DeferredArtifactViewer
          key={`${id}@${version ?? "latest"}`}
          target={target}
          source={source}
          comments={comments}
          opening={openedAt}
          expanded={place.mode === "expanded"}
          covering={place.mode === "overlay"}
          ownBack={ownBack}
          onToggleExpanded={place.canExpand ? toggleExpanded : undefined}
          onShowVersion={showVersion}
          onShownTitle={rememberTitle}
          onClose={close}
          // Covering its channel (a phone, a narrow panel, expanded), it would hide the message it opened.
          onOpenedMessage={place.mode === "overlay" || place.mode === "expanded" ? close : undefined}
        />
      ),
    };
  }, [close, comments, expanded, label, openedAt, ownBack, rememberTitle, showVersion, source, splitLabel, target, toggleExpanded]);
}

/**
 * An Artifact opened in a dialog (a task's conversation): the viewer over
 * that dialog, covering it as a page with Back (on a phone it owns a history
 * entry too), and the dialog again when it closes. It closes with the dialog.
 */
export function ArtifactCoverViewer() {
  const enabled = useWorkspaceArtifactsEnabled();
  const open = useArtifactViewerStore((s) => (enabled && s.open?.conversationId === null ? s.open : null));
  const openedAt = useArtifactViewerStore((s) => s.openedAt);
  const close = useArtifactViewerStore((s) => s.close);
  const showVersion = useArtifactViewerStore((s) => s.showVersion);
  const phone = useMediaQuery(PHONE_QUERY);
  const cover = open?.cover ?? null;
  // Where the address holds it (over a task's dialog, `?task=`), its entry is the address's.
  const addressed = useArtifactViewerStore((s) => s.addressed?.dialog === true);
  usePhoneHistoryEntry(!!cover && phone && !addressed, close);
  // The dialog went (closed, or replaced): so does what covered it.
  useEffect(() => {
    if (!cover || typeof MutationObserver === "undefined") return;
    const gone = () => {
      if (!cover.isConnected) close();
    };
    const observer = new MutationObserver(gone);
    observer.observe(document.body, { childList: true, subtree: true });
    gone();
    return () => observer.disconnect();
  }, [close, cover]);
  // The cover is `absolute inset-0` inside the dialog: a dialog's card (raft-ui's DialogSurface) is not positioned, so
  // without this it would fill the window instead of the card.
  useLayoutEffect(() => {
    if (!cover) return;
    const position = getComputedStyle(cover).position;
    if (position && position !== "static") return;
    const before = cover.style.position;
    cover.style.position = "relative";
    return () => {
      cover.style.position = before;
    };
  }, [cover]);
  const target = useMemo(() => (open ? { id: open.id, version: open.version } : null), [open]);
  if (!cover || !open || !target) return null;
  return createPortal(
    <div className="absolute inset-0 z-cover flex bg-layer-canvas" data-testid="artifact-cover">
      <DeferredArtifactViewer
        key={`${target.id}@${target.version ?? "latest"}`}
        target={target}
        source={open.source}
        comments={open.comments ?? null}
        opening={openedAt}
        expanded={false}
        covering
        ownBack
        onShowVersion={showVersion}
        onClose={close}
        onOpenedMessage={close}
      />
    </div>,
    cover,
  );
}

/**
 * Runs `onClosed` with the channel when the Artifact open there is no longer
 * open there: closed, or replaced by one in another conversation. In the same
 * update as the change (a store subscription, not an effect after it), so
 * what it changes is on screen when focus goes back to the opener.
 */
export function useArtifactClosed(onClosed: (conversationId: string) => void): void {
  const onClosedRef = useRef(onClosed);
  onClosedRef.current = onClosed;
  useEffect(() => useArtifactViewerStore.subscribe((state, prev) => {
    const was = prev.open?.conversationId;
    if (was && was !== state.open?.conversationId) onClosedRef.current(was);
  }), []);
}

/**
 * Makes the channel panel's body (the part under its header) a place cards
 * open the viewer in, while it is mounted with the flag on; whether it is on
 * screen is read at click time (findArtifactPlace). `reveal` lets a click from
 * this channel's thread, where the thread covers the channel, bring the
 * channel forward (F41: the thread steps behind it). Returns the ref for the
 * body element.
 */
export function useArtifactHost(channelId: string | null | undefined, reveal?: RevealArtifactHost): (element: HTMLElement | null) => void {
  const enabled = useWorkspaceArtifactsEnabled() && !!channelId;
  const [element, setElement] = useState<HTMLElement | null>(null);
  const revealRef = useRef(reveal);
  revealRef.current = reveal;
  useEffect(() => {
    if (!enabled || !element || !channelId) return;
    return registerArtifactHost(element, channelId, (from) => revealRef.current?.(from) ?? false);
  }, [enabled, element, channelId]);
  return setElement;
}

/** The channel header's Back: on a phone it closes the viewer covering this channel first. */
export function useArtifactHeaderBack(channelId: string | null | undefined, back: (() => void) | undefined): (() => void) | undefined {
  const enabled = useWorkspaceArtifactsEnabled();
  const phone = useMediaQuery(PHONE_QUERY);
  const openHere = useArtifactViewerStore((s) => enabled && !!channelId && s.open?.conversationId === channelId);
  const close = useArtifactViewerStore((s) => s.close);
  return phone && openHere ? close : back;
}
