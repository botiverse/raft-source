// The personal assistant's entry on the composer (Kirby's prototype v13; RFC
// 075 §4.3): an otter lying on the top edge of the composer the person used
// last, its lower body behind the frame and two paws on the edge. Its face
// says what the assistant is doing; a press opens the assistant over the page
// (a popover on a desktop, a bottom sheet on a phone). Its Expand opens the
// assistant page instead, which can shrink back here (assistantExpand.ts).
//
// Shown only where the assistant is "ready" with an assistant whose DM exists
// (useMyAssistant: the flag, the API's `enabled`, never for guests), and
// never on the assistant's own DM or a thread in it. Hosts: ChatPanel's and
// ThreadPanel's MessageInput (`frameEdge`). It floats over the bottom-right
// corner of that conversation's message list and takes no room in it, so the
// list never moves for it: not when it pops in, changes mood, or goes to the
// other composer (#proj-assistant #20, option a). Where it would cover the
// list's end (the last message's text under it, or the pointer on the last
// message, whose toolbar then shows) it sinks into the composer head first
// instead (useOtterSink), as while the person types.
//
// Dragged (#proj-assistant:#24), it snaps to the nearest edge of a pane
// (assistantOtterDock.ts) and lies there on this device, over the page in a
// layer of its own; dropped on its composer's top edge, it goes back to it.
// Docked, it neither sinks nor goes into the composer while the person types.
//
// Motion (Raft DS › Motion; Artea #24 asked for more): one pop-in when it
// appears; the slide into the composer while the person types, it sinks, or
// the panel is open; asleep (nothing new) it breathes and z's float up; a new
// place is reached along an arc with a small squash on landing; something new
// pops it out from behind its edge with two small bobs, never a sideways sway
// (assistantOtterEdgeArt.tsx). With reduced motion nothing moves and it
// appears as it is.

import type { ComponentProps, CSSProperties, PointerEvent as ReactPointerEvent, RefObject } from "react";
import { Suspense, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useIntl } from "react-intl";
import { useLocation, useNavigate } from "react-router-dom";
import { Drawer, DrawerContent, Popover, PopoverContent, PopoverTrigger } from "@botiverse/raft-ui";
import { useMediaQuery } from "../hooks/effectPrimitives";
import { usePhoneHistoryEntry } from "../apps/artifacts";
import { PHONE_MEDIA_QUERY } from "../components/ui/NarrowDialog";
import { dismissLayerProps } from "../components/ui/dismissLayer";
import { useLayerAbovePanel } from "./assistantOtterLayers";
import { useServerStore } from "../store/serverStore";
import { useMyAssistant } from "./assistantClient";
import type { AssistantOwnerSettings, AssistantRecord } from "./assistantClient";
import { useAssistantPause } from "./AssistantPaused";
import { activateOtterHost, otterHostOrder, useAssistantOtterMood, useOtterHost, useOtterShown } from "./assistantOtterState";
import { composerFrameOf, composerNoticesOf, composerTopEdge, contentBand, findDockPane, placeDock, readPaneBoxes, setOtterDock, snapOtter, useOtterDock, viewportBox } from "./assistantOtterDock";
import type { DockPlacement, OtterDock, OtterSize, SnapTarget } from "./assistantOtterDock";
import type { OtterMood } from "./assistantOtterState";
import type { AssistantOrigin } from "./AssistantContextChip";
import { carryAssistantOpen, currentHistoryIdx, rememberAssistantExpandOrigin, takeAssistantCarry, takeAssistantReopen } from "./assistantExpand";
import confusedUrl from "./otter/confused.webp";
import curiousUrl from "./otter/curious.webp";
import pawUrl from "./otter/paw.svg";
import runningUrl from "./otter/running.webp";
import sleepyUrl from "./otter/sleepy.webp";
import thinkingUrl from "./otter/thinking.webp";
import waveUrl from "./otter/wave.webp";
import { lazyPanel } from "../boot/deferredUi";
import { useOtterSink } from "./useOtterSink";
import { TOWARD_EDGE, edgeArtBox, edgeArtFor, playOtterFlight } from "./assistantOtterEdgeArt";
import { EdgeArtImage } from "./AssistantOtterEdgeArtImage";
import { AssistantPanelResize } from "./AssistantPanelResize";
import { PANEL_COLLISION_PADDING, PANEL_DEFAULT, clampPanelSize, usePanelSize } from "./assistantPanelSize";

const AssistantOtterPanel = lazyPanel(() => import("./AssistantOtterPanel"));

type PopoverChangeDetails = Parameters<NonNullable<ComponentProps<typeof Popover>["onOpenChange"]>>[1];

/** A channel or DM row in the sidebar (ChannelRow, DmRow, AgentDmRow, AgentLoungeRow). */
const SIDEBAR_CONVERSATION_ROW = "[data-sidebar-channel-id]";

/**
 * Each pose, cut where the frame's top edge crosses the otter: its size and
 * the x of its head's middle, in CSS px (the files are 2x).
 */
const POSES = {
  curious: { src: curiousUrl, w: 89, h: 60, cx: 47 },
  wave: { src: waveUrl, w: 96, h: 52, cx: 47 },
  thinking: { src: thinkingUrl, w: 87, h: 62, cx: 44 },
  confused: { src: confusedUrl, w: 93, h: 66, cx: 50 },
  sleepy: { src: sleepyUrl, w: 135, h: 71, cx: 65 },
  running: { src: runningUrl, w: 109, h: 60, cx: 63 },
} as const;
type Pose = (typeof POSES)[keyof typeof POSES];

// Nothing new: it sleeps (Artea, #24); it wakes for something new.
const MOOD_POSE: Record<OtterMood, Pose> = {
  idle: POSES.sleepy,
  working: POSES.thinking,
  new: POSES.wave,
  confirm: POSES.confused,
  away: POSES.sleepy,
};

/** Paws on the edge, by their left x from the head's middle: the waving one has only its right paw down; asleep, none. */
const BOTH_PAWS = [-37, 15] as const;
const MOOD_PAWS: Record<OtterMood, readonly number[]> = {
  idle: [],
  working: BOTH_PAWS,
  new: [15],
  confirm: BOTH_PAWS,
  away: [],
};

const MOOD_STATE_ID = {
  working: "assistant.otter.state.working",
  new: "assistant.otter.state.new",
  confirm: "assistant.otter.state.confirm",
  away: "assistant.otter.state.away",
} as const;

/** The pop-in's length (index.css `assistant-otter-pop`): the running pose shows this long. */
export const OTTER_ENTRY_MS = 620;
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
/** Thread panels and phones: 80%. */
const SMALL_SCALE = 0.8;
/** The window around the head that clips the otter at the frame's edge (CSS px). */
const CLIP_HALF_WIDTH = 160;

// Whole literals (tailwindClassScan): the anchor point, 76px in from the
// frame's right end (over the send button's side); on a phone 52px.
const ANCHOR_CLASS = "pointer-events-none absolute bottom-full right-19 z-float size-0 max-md:right-13 max-md:scale-80";
const ANCHOR_SMALL_CLASS = "scale-80";
// The otter goes into the composer (`translate`) while there is text in it,
// while it sinks (`data-sunk`, useOtterSink), or while the panel is open; the
// paws and the bubble go with it.
const BUTTON_CLASS = [
  // touch-none: a finger on the otter drags it rather than scrolling the page.
  "pointer-events-auto absolute bottom-[-1px] block touch-none rounded-control p-0 outline-none focus-visible:shadow-focus",
  "transition-[translate] duration-200 ease-slide motion-reduce:transition-none",
  "group-data-[composing]/composer-frame:translate-y-[58%] group-data-[sunk]/otter:translate-y-[58%]",
  "data-[open]:!translate-y-[105%]",
].join(" ");
const ENTERING_CLASS = "assistant-otter-pop";
const EDGE_EXTRA_CLASS = [
  "transition-opacity duration-150 motion-reduce:transition-none",
  "group-data-[composing]/composer-frame:opacity-0 group-data-[sunk]/otter:opacity-0 group-data-[otter-open]/otter:opacity-0",
].join(" ");

/**
 * MessageInput's `frameEdge` for one conversation's composer. `hostId` names
 * the composer among the otter's hosts (useOtterHost). `channelId` is the
 * conversation's (a thread's parent channel): the assistant's own DM has no
 * otter. A thread's composer also names the thread: opened from here, the
 * assistant's DM attaches this conversation (AssistantContextChip).
 */
export function AssistantOtterAnchor({ hostId, channelId, threadParentMessageId = null, threadParentText = null, scale = 1, fallback = false }: {
  hostId: string;
  /** Null on a page with no conversation (AssistantPageOtter). */
  channelId: string | null;
  /** In a thread: its parent message's id, and that message's text while the panel has it. */
  threadParentMessageId?: string | null;
  threadParentText?: string | null;
  /** 0.8 in a thread panel; phones are 0.8 anyway. */
  scale?: 1 | 0.8;
  /** Behind every composer host (useOtterHost). */
  fallback?: boolean;
}) {
  const mine = useMyAssistant();
  const ready = mine.status === "ready" ? mine : null;
  const assistant = ready?.assistant ?? null;
  const dmChannelId = assistant?.dmChannelId ?? null;
  // Turned off in the assistant's settings, or hidden for now by its shortcut (#proj-assistant:#21).
  const shown = useOtterShown();
  const eligible = shown && assistant !== null && dmChannelId !== null && channelId !== dmChannelId;
  const active = useOtterHost(hostId, eligible, fallback);
  const anchorRef = useRef<HTMLSpanElement>(null);
  // One object per conversation, so the otter's props stay stable across renders.
  const origin = useMemo(
    () => ({ channelId, threadParentMessageId, threadParentText }),
    [channelId, threadParentMessageId, threadParentText],
  );

  // Focus anywhere in this frame: the person is using this composer.
  useEffect(() => {
    if (!eligible) return;
    const frame = anchorRef.current?.closest("[data-composer-frame-edge]");
    if (!frame) return;
    const onFocusIn = () => activateOtterHost(hostId);
    frame.addEventListener("focusin", onFocusIn);
    return () => frame.removeEventListener("focusin", onFocusIn);
  }, [eligible, hostId]);

  const lift = useNoticesLift(anchorRef, eligible);

  if (!ready || !assistant || !dmChannelId || !eligible) return null;
  return (
    <span
      ref={anchorRef}
      className={scale === SMALL_SCALE ? `${ANCHOR_CLASS} ${ANCHOR_SMALL_CLASS}` : ANCHOR_CLASS}
      style={lift > 0 ? { marginBottom: lift } : undefined}
    >
      {active ? (
        <AssistantOtter
          hostId={hostId}
          anchorRef={anchorRef}
          assistant={assistant}
          dmChannelId={dmChannelId}
          settings={ready.settings}
          origin={origin}
        />
      ) : null}
    </span>
  );
}

/**
 * How far above its frame the otter lies on a composer: over the notices on
 * it (the notification banner), so it covers none of their buttons (Artea,
 * #24). Measured again when they come, go or change size.
 */
function useNoticesLift(anchorRef: RefObject<HTMLSpanElement | null>, eligible: boolean): number {
  const [lift, setLift] = useState(0);
  useLayoutEffect(() => {
    if (!eligible) return;
    const frame = composerFrameOf(anchorRef.current);
    if (!frame) return;
    const measure = () => {
      const next = Math.max(0, Math.round(frame.getBoundingClientRect().top - composerTopEdge(frame)));
      setLift((prev) => (prev === next ? prev : next));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    for (const notices of composerNoticesOf(frame)) observer.observe(notices);
    return () => observer.disconnect();
  }, [anchorRef, eligible]);
  return lift;
}

function AssistantOtter({ hostId, anchorRef, assistant, dmChannelId, settings, origin }: {
  hostId: string;
  /** The anchor on its composer (or page edge): a drag back onto that composer's top edge undocks it. */
  anchorRef: RefObject<HTMLSpanElement | null>;
  assistant: AssistantRecord;
  dmChannelId: string;
  settings: AssistantOwnerSettings;
  origin: AssistantOrigin;
}) {
  const { formatMessage } = useIntl();
  const phone = useMediaQuery(PHONE_MEDIA_QUERY);
  const reducedMotion = useMediaQuery(REDUCED_MOTION_QUERY);
  const mood = useAssistantOtterMood(assistant);
  const paused = useAssistantPause(assistant.agentId) !== null;
  const [open, setOpenState] = useState(false);
  // Opened by a hand-off (below): the hosts on screen then. Null once closed.
  const handedOpenAmong = useRef<readonly string[] | null>(null);
  const setOpen = useCallback((next: boolean) => {
    if (!next) handedOpenAmong.current = null;
    setOpenState(next);
  }, []);
  // First appearance on this composer: it runs in and pops up, then settles.
  const [entering, setEntering] = useState(() => !reducedMotion);
  useEffect(() => {
    if (!entering) return;
    const timer = setTimeout(() => setEntering(false), OTTER_ENTRY_MS);
    return () => clearTimeout(timer);
  }, [entering]);
  const collapse = useCallback(() => setOpen(false), [setOpen]);
  const openSheet = useCallback(() => setOpen(true), [setOpen]);
  // On a phone the sheet is a layer over the conversation: Back closes it
  // first and stays here, as the Artifact viewer does (usePhoneHistoryEntry).
  usePhoneHistoryEntry(open && phone, collapse);

  const pose = entering ? POSES.running : MOOD_POSE[mood];
  const paws = entering ? BOTH_PAWS : MOOD_PAWS[mood];
  // Docked: where on the page, while its pane is on screen; else on its composer.
  // On a phone it stays on the composer for now (Artea, #24): one pane at a time, no edges to choose from.
  const savedDock = useOtterDock(phone);
  const dock = phone ? null : savedDock;
  const dockScale = phone ? SMALL_SCALE : 1;
  const size = useMemo<OtterSize>(() => ({ w: pose.w * dockScale, h: pose.h * dockScale }), [pose.w, pose.h, dockScale]);
  const placement = useDockPlacement(dock, size, anchorRef);
  const dropAt = useRef<{ x: number; y: number } | null>(null);
  const drag = useOtterDrag({ phone, anchorRef, size, dropAt });
  // Docked on a vertical edge or under a top edge: its own pose there, upright or hanging.
  const edge = placement ? edgeArtFor(placement.facing, mood) : null;
  const facing = placement?.facing ?? "up";
  const layerRef = useRef<HTMLSpanElement>(null);
  useOtterMotion({ layerRef, anchorRef, dock, placement, dropAt, facing, entering });
  // Something new: it pops out from behind its edge, then bobs twice (index.css), once per waking.
  const awake = !entering && (mood === "new" || mood === "confirm");
  const [towardX, towardY] = TOWARD_EDGE[facing];

  // Expand: the assistant page in the popover's place, remembering this
  // page, so the assistant page can shrink back to it (assistantExpand.ts).
  const navigate = useNavigate();
  const { pathname, search, hash } = useLocation();
  const path = `${pathname}${search}${hash}`;
  const serverId = useServerStore((s) => s.current?.id ?? null);
  const serverSlug = useServerStore((s) => s.current?.slug ?? null);
  const expand = useCallback(() => {
    if (!serverId || !serverSlug) return;
    rememberAssistantExpandOrigin({ serverId, path, historyIdx: currentHistoryIdx() });
    setOpen(false);
    // On a phone the page takes the open sheet's history entry over, so its
    // Back returns to this page rather than to the sheet's leftover entry.
    navigate(`/s/${serverSlug}/assistant`, { replace: phone });
  }, [navigate, path, phone, serverId, serverSlug, setOpen]);
  // Back from the assistant page to this page, or a conversation picked in
  // the sidebar while the popover was open: open as it was left.
  // A composer that appears after that (a thread panel mounting beside the
  // channel just after the channel's composer took the hand-off) takes the
  // otter over: the open popover goes with it, rather than staying with the
  // otter it leaves.
  useEffect(() => {
    if (takeAssistantReopen(serverId, path) || takeAssistantCarry(serverId)) {
      handedOpenAmong.current = otterHostOrder();
      setOpenState(true);
    }
  }, [serverId, path]);
  // Not on a phone: the sheet it leaves steps its history entry back
  // (usePhoneHistoryEntry) after the new one has pushed its own, and would
  // close it again.
  useEffect(() => {
    if (phone) return;
    return function passOnHandedOpen() {
      const among = handedOpenAmong.current;
      const order = otterHostOrder();
      const next = order.at(-1);
      // Still on screen but no longer the otter's, to a composer that was not there yet.
      const lostToNewHost = order.includes(hostId) && next !== undefined && next !== hostId && among !== null && !among.includes(next);
      if (serverId && lostToNewHost) carryAssistantOpen(serverId);
    };
  }, [hostId, phone, serverId]);
  const layerAbove = useLayerAbovePanel(open && !phone);
  // A press outside closes the popover, except on a conversation's sidebar row (switching
  // conversations keeps it open, now attaching that one) or a layer above it (useLayerAbovePanel).
  const onPopoverOpenChange = useCallback((next: boolean, details: PopoverChangeDetails) => {
    // The press that ended a drag is not a press on the otter.
    if (next && drag.consumeClick()) return;
    if (!next && serverId && (details.reason === "outside-press" || details.reason === "focus-out")) {
      const event = details.event as Event & { relatedTarget?: EventTarget | null };
      const target = details.reason === "focus-out" ? event.relatedTarget : event.target;
      if (target instanceof Element && target.closest(SIDEBAR_CONVERSATION_ROW)) {
        details.cancel();
        carryAssistantOpen(serverId);
        return;
      }
    }
    if (!next && layerAbove.keepsOpen(details)) return;
    setOpen(next);
  }, [drag, layerAbove, serverId, setOpen]);
  const onPhonePress = useCallback(() => {
    if (!drag.consumeClick()) openSheet();
  }, [drag, openSheet]);
  // Its popover's size, as the person last resized it on this device (assistantPanelSize.ts), inside this window.
  const savedPanelSize = usePanelSize();
  const viewport = viewportBox();
  const fitted = clampPanelSize(savedPanelSize ?? PANEL_DEFAULT, { width: viewport.right, height: viewport.bottom });
  const panelSize = useMemo(() => ({ width: fitted.width, height: fitted.height }), [fitted.width, fitted.height]);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const restRef = useRef<HTMLSpanElement>(null);
  const bubbleRef = useRef<HTMLSpanElement>(null);

  const stateLabel = mood === "idle" ? null : formatMessage({ id: MOOD_STATE_ID[mood] });
  const label = stateLabel
    ? formatMessage({ id: "assistant.otter.openWithState" }, { state: stateLabel })
    : formatMessage({ id: "assistant.otter.open" });
  // Leaning out of a vertical edge the bubble would read sideways: its face and the label say it there.
  const bubble = !entering && (mood === "new" || mood === "confirm") && (!placement || placement.facing === "up") ? stateLabel : null;
  const sunk = useOtterSink(restRef, bubbleRef, `${pose.src} ${bubble ?? ""}`);

  const triggerProps = {
    type: "button" as const,
    "aria-label": label,
    "aria-haspopup": "dialog" as const,
    "aria-expanded": open,
    "data-testid": "assistant-otter",
    "data-mood": entering ? "entering" : mood,
    "data-open": open ? "" : undefined,
    "data-docked": placement ? "" : undefined,
    onPointerDown: drag.onPointerDown,
    className: `${edge ? EDGE_BUTTON_CLASS : entering ? `${BUTTON_CLASS} ${ENTERING_CLASS}` : BUTTON_CLASS}${awake ? ` ${WAKE_CLASS}` : ""}`,
    style: { ...(edge ? edgeArtBox(edge) : { left: CLIP_HALF_WIDTH - pose.cx }), ["--otter-tx" as string]: `${towardX}px`, ["--otter-ty" as string]: `${towardY}px` } as CSSProperties,
    children: edge ? <EdgeArtImage art={edge} /> : (
      <img src={pose.src} width={pose.w} height={pose.h} alt="" draggable={false} className={`pointer-events-none block select-none ${mood === "idle" || mood === "away" ? BREATHE_CLASS : ""}`} />
    ),
  };
  const panel = (
    <Suspense fallback={null}>
      <AssistantOtterPanel
        assistant={assistant}
        dmChannelId={dmChannelId}
        settings={settings}
        mood={mood}
        paused={paused}
        onCollapse={collapse}
        onExpand={expand}
        origin={origin}
      />
    </Suspense>
  );

  const otter = (
    <span
      ref={layerRef}
      className="group/otter absolute inset-0 data-[dragging]:opacity-0"
      data-otter-open={open ? "" : undefined}
      data-sunk={sunk && !placement ? "" : undefined}
      data-dragging={drag.state ? "" : undefined}
    >
      {/* The clip: nothing of the otter shows below the frame's top edge. An edge pose is drawn whole, from the edge point. */}
      <span
        className={edge ? "absolute" : "absolute bottom-[-1px] h-[200px] overflow-hidden"}
        style={edge ? undefined : { left: -CLIP_HALF_WIDTH, width: CLIP_HALF_WIDTH * 2 }}
      >
        {/* Where the otter rests: the popover keeps to this, not to the otter going in. */}
        <span ref={restRef} aria-hidden="true" className={edge ? "absolute" : "absolute bottom-0"} style={edge ? edgeArtBox(edge) : { left: CLIP_HALF_WIDTH - pose.cx, width: pose.w, height: pose.h }} />
        {phone ? (
          <button ref={buttonRef} onClick={onPhonePress} {...triggerProps} />
        ) : (
          <Popover open={open} onOpenChange={onPopoverOpenChange}>
            <PopoverTrigger ref={buttonRef} {...triggerProps} />
            {open ? (
              <PopoverContent
                anchor={restRef}
                side="top"
                align="end"
                sideOffset={8}
                collisionPadding={PANEL_COLLISION_PADDING}
                finalFocus={buttonRef}
                aria-label={assistant.name}
                className="flex max-h-(--available-height) max-w-(--available-width) flex-col overflow-hidden p-0"
                style={panelSize}
                ref={layerAbove.panelRef}
                data-testid="assistant-otter-popover"
                {...dismissLayerProps}
              >
                {panel}
                <AssistantPanelResize size={panelSize} />
              </PopoverContent>
            ) : null}
          </Popover>
        )}
      </span>
      {(edge ? [] : paws).map((x) => (
        <img
          key={x}
          src={pawUrl}
          width={22}
          height={15}
          alt=""
          aria-hidden="true"
          draggable={false}
          data-testid="assistant-otter-paw"
          // max-w-none: the anchor is 0 wide, so preflight's `max-width: 100%` would shrink a paw to nothing.
          className={`absolute bottom-[-9px] max-w-none ${EDGE_EXTRA_CLASS}`}
          style={{ left: x }}
        />
      ))}
      {!edge && (mood === "idle" || mood === "away") && !entering ? <OtterZzz right={pose.cx - pose.w + 18} bottom={pose.h - 14} /> : null}
      {bubble ? (
        // Beside its head, over the list's corner with it (useOtterSink measures it too).
        <span
          ref={bubbleRef}
          aria-hidden="true"
          data-testid="assistant-otter-bubble"
          className={`absolute bottom-3 flex items-center gap-1.5 whitespace-nowrap rounded-control border border-line-strong bg-layer-popover px-2 py-1 text-footnote text-foreground shadow-float ${EDGE_EXTRA_CLASS}`}
          style={{ right: pose.cx + 6 }}
        >
          {mood === "new" ? <span className="size-1.5 shrink-0 rounded-[2px] bg-attention" /> : null}
          {bubble}
        </span>
      ) : null}
      {phone ? (
        <Drawer open={open} onOpenChange={setOpen}>
          <DrawerContent
            aria-label={assistant.name}
            finalFocus={buttonRef}
            className="[--drawer-content-height:82vh]"
            data-testid="assistant-otter-sheet"
          >
            {open ? panel : null}
          </DrawerContent>
        </Drawer>
      ) : null}
    </span>
  );
  const ghost = drag.state ? <OtterDragGhost src={pose.src} size={size} cx={pose.cx * dockScale} at={drag.state} mood={mood} /> : null;
  if (!placement) return <>{otter}{ghost}</>;
  return (
    <>
      {createPortal(
        <span
          className={DOCK_CLASS}
          style={{ left: placement.x, top: placement.y, transform: dockTransform(placement, dockScale) }}
          data-testid="assistant-otter-dock"
          data-facing={placement.facing}
        >
          {otter}
        </span>,
        document.body,
      )}
      {ghost}
    </>
  );
}

// ---- Docked and dragged (#proj-assistant:#24) ------------------------------------

/** The anchor of a docked otter: a point on its pane's edge, over the page and under popovers and dialogs. */
const DOCK_CLASS = "pointer-events-none fixed z-app size-0";
const DRAG_THRESHOLD_PX = 6;

/** At a phone's 80%. Never turned: every edge has its own upright pose (assistantOtterEdgeArt.tsx). */
function dockTransform(_placement: DockPlacement, scale: number): string {
  return `scale(${scale})`;
}

/** The trigger over an edge pose: only the visible otter takes the pointer, not its canvas. */
const EDGE_BUTTON_CLASS = "pointer-events-auto absolute block touch-none rounded-control p-0 outline-none focus-visible:shadow-focus";
/** Asleep it breathes (index.css; nothing with reduced motion). */
const BREATHE_CLASS = "assistant-otter-breathe";
/** Waking for something new (index.css; nothing with reduced motion). */
const WAKE_CLASS = "assistant-otter-wake";

/** Asleep on a composer: three z's float up from its head (index.css; one still z with reduced motion). */
function OtterZzz({ right, bottom }: { right: number; bottom: number }) {
  return (
    <span aria-hidden="true" data-testid="assistant-otter-zzz" className={`assistant-otter-zzz pointer-events-none absolute font-mono font-bold text-muted-foreground ${EDGE_EXTRA_CLASS}`} style={{ left: -right, bottom }}>
      <span className="text-[10px]" />
      <span className="text-[12px]" />
      <span className="text-[15px]" />
    </span>
  );
}

/**
 * Its moves, played on its layer (whose origin is the edge point): a new
 * place (dropped, back to the composer when its pane closes, back to its
 * edge when it opens again, another composer) is reached along an arc from
 * where it was, or from the hand after a drop, then a squash on landing.
 * Nothing with reduced motion.
 */
function useOtterMotion({ layerRef, anchorRef, dock, placement, dropAt, facing, entering }: {
  layerRef: RefObject<HTMLSpanElement | null>;
  anchorRef: RefObject<HTMLSpanElement | null>;
  dock: OtterDock | null;
  placement: DockPlacement | null;
  dropAt: RefObject<{ x: number; y: number } | null>;
  facing: DockPlacement["facing"];
  entering: boolean;
}) {
  // Only a new place flies: another dock, docked or not (its pane closed or
  // opened), another composer. A pane or the window resizing just follows.
  const last = useRef<{ x: number; y: number; dock: OtterDock | null; docked: boolean; anchor: Element | null } | null>(null);
  useLayoutEffect(() => {
    const anchorEl = anchorRef.current;
    const anchor = anchorEl?.getBoundingClientRect();
    const point = placement ? { x: placement.x, y: placement.y } : anchor ? { x: anchor.left, y: anchor.top } : null;
    if (!point) return;
    const prev = last.current;
    const moved = prev !== null && (prev.dock !== dock || prev.docked !== (placement !== null) || prev.anchor !== anchorEl);
    const from = dropAt.current ?? (moved ? prev : null);
    dropAt.current = null;
    last.current = { ...point, dock, docked: placement !== null, anchor: anchorEl };
    if (from && !entering) playOtterFlight(layerRef.current, from.x - point.x, from.y - point.y, facing);
  });
}

/**
 * Where a dock puts the otter now: null while its pane is not on screen (it
 * then lies on its composer). Measured again when the pane or the window
 * changes size, and after a layout transition (a sidebar sliding).
 */
function useDockPlacement(dock: OtterDock | null, size: OtterSize, anchorRef: RefObject<HTMLSpanElement | null>): DockPlacement | null {
  const [placement, setPlacement] = useState<DockPlacement | null>(null);
  useLayoutEffect(() => {
    let pane = dock ? findDockPane(dock.pane) : null;
    const place = (): DockPlacement | null => {
      if (!dock) return null;
      if (!pane || !pane.isConnected) pane = findDockPane(dock.pane);
      return pane ? placeDock(dock, pane.getBoundingClientRect(), size, contentBand(anchorRef.current)) : null;
    };
    const measure = () => {
      const next = place();
      setPlacement((prev) => (prev === next || (prev && next && prev.x === next.x && prev.y === next.y && prev.facing === next.facing) ? prev : next));
    };
    measure();
    if (!dock) return;
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    if (pane) observer?.observe(pane);
    observer?.observe(document.documentElement);
    window.addEventListener("resize", measure);
    document.addEventListener("transitionend", measure, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      document.removeEventListener("transitionend", measure, true);
    };
  }, [dock, size, anchorRef]);
  return placement;
}

/** Under the pointer now, the edge a drop there lands on, and where on it the otter would lie. */
type DragState = { x: number; y: number; target: SnapTarget | null; landing: DockPlacement | null };

/**
 * A press on the otter that moves past a few px drags it: it follows the
 * pointer, the edge it would snap to shows, and the drop docks it there
 * (or, on its composer's top edge, back on the composer): the nearest edge,
 * however far. Only Escape leaves it where it was. The press that ends a drag
 * doesn't open the assistant (`consumeClick`).
 */
function useOtterDrag({ phone, anchorRef, size, dropAt }: { phone: boolean; anchorRef: RefObject<HTMLSpanElement | null>; size: OtterSize; dropAt: RefObject<{ x: number; y: number } | null> }) {
  const [state, setState] = useState<DragState | null>(null);
  const press = useRef<{ id: number; x: number; y: number; active: boolean } | null>(null);
  const swallowClick = useRef(false);
  const cleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanup.current?.(), []);

  const snapAt = useCallback((x: number, y: number): SnapTarget | null => {
    const frame = composerFrameOf(anchorRef.current);
    const box = frame?.getBoundingClientRect();
    // Its top edge is over the notices on it, where the otter lies (composerTopEdge).
    const composer = frame && box ? { left: box.left, top: composerTopEdge(frame), right: box.right, bottom: box.bottom } : null;
    return snapOtter({ x, y }, readPaneBoxes(), composer, viewportBox(), size, contentBand(anchorRef.current));
  }, [anchorRef, size]);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    // Not dragged on a phone (see AssistantOtter): a press there only opens it.
    if (phone || event.button !== 0 || !event.isPrimary) return;
    cleanup.current?.();
    press.current = { id: event.pointerId, x: event.clientX, y: event.clientY, active: false };
    // After a drop, the dragged otter stays two frames more, until the otter
    // on its new edge is drawn: it must not blink out between them (#24).
    const end = (settle = false) => {
      press.current = null;
      if (settle && typeof requestAnimationFrame !== "undefined") requestAnimationFrame(() => requestAnimationFrame(() => setState(null)));
      else setState(null);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", onKey, true);
      cleanup.current = null;
    };
    const cancel = () => end();
    const onMove = (ev: PointerEvent) => {
      const p = press.current;
      if (!p || ev.pointerId !== p.id) return;
      if (!p.active && Math.hypot(ev.clientX - p.x, ev.clientY - p.y) < DRAG_THRESHOLD_PX) return;
      p.active = true;
      ev.preventDefault();
      const target = snapAt(ev.clientX, ev.clientY);
      setState({ x: ev.clientX, y: ev.clientY, target, landing: landingOf(target, anchorRef.current, size) });
    };
    const onUp = (ev: PointerEvent) => {
      const p = press.current;
      if (!p || ev.pointerId !== p.id) return;
      if (p.active) {
        // The click this release makes, if it lands on the otter, is the drop's.
        swallowClick.current = true;
        setTimeout(() => { swallowClick.current = false; }, 0);
        const target = snapAt(ev.clientX, ev.clientY);
        // It flies from the hand to where it lands (useOtterMotion).
        if (target) dropAt.current = { x: ev.clientX, y: ev.clientY };
        if (target?.kind === "composer") setOtterDock(phone, null);
        else if (target) setOtterDock(phone, target.dock);
        end(true);
        return;
      }
      end();
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape" || !press.current?.active) return;
      ev.stopPropagation();
      end();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", cancel);
    // keydown-global-exempt: Escape cancels an otter drag in progress; listened only from the press until the drop
    window.addEventListener("keydown", onKey, true);
    cleanup.current = cancel;
  }, [phone, snapAt, anchorRef, size, dropAt]);

  const consumeClick = useCallback(() => {
    if (!swallowClick.current) return false;
    swallowClick.current = false;
    return true;
  }, []);

  return useMemo(() => ({ state, onPointerDown, consumeClick }), [state, onPointerDown, consumeClick]);
}

/** The otter under the pointer while it is dragged, and the edge it would snap to. */
/**
 * Where a drop on `target` puts the otter, shown while dragging (Cody, #24):
 * on a pane's edge as placeDock puts it, on its composer at its own spot there.
 */
function landingOf(target: SnapTarget | null, anchor: HTMLElement | null, size: OtterSize): DockPlacement | null {
  if (!target) return null;
  if (target.kind === "composer") {
    if (!anchor) return null;
    const r = anchor.getBoundingClientRect();
    return { x: r.left, y: r.top, facing: "up" };
  }
  const pane = readPaneBoxes().find((box) => box.pane === target.dock.pane);
  return pane ? placeDock(target.dock, pane, size, contentBand(anchor)) : null;
}

function OtterDragGhost({ src, size, cx, at, mood }: { src: string; size: OtterSize; cx: number; at: DragState; mood: OtterMood }) {
  const landingArt = at.landing ? edgeArtFor(at.landing.facing, mood) : null;
  // Its composer's top edge shows too: a drop there is a place like any other (Cody, #24).
  const line = at.target ? at.target.line : null;
  return createPortal(
    <>
      {line ? (
        <span
          aria-hidden="true"
          data-testid="assistant-otter-snap-line"
          // The design system's drop place (DropPlaceholder: 1.5px dashed line-strong), drawn as the edge itself.
          className={line.x1 === line.x2
            ? "pointer-events-none fixed z-app w-0 border-l-[1.5px] border-dashed border-line-strong"
            : "pointer-events-none fixed z-app h-0 border-t-[1.5px] border-dashed border-line-strong"}
          style={line.x1 === line.x2
            ? { left: line.x1 - 0.75, top: line.y1, height: line.y2 - line.y1 }
            : { left: line.x1, top: line.y1 - 0.75, width: line.x2 - line.x1 }}
        />
      ) : null}
      {at.landing ? (
        // Where it will lie: faint, cut at the edge as it will be.
        <span
          aria-hidden="true"
          data-testid="assistant-otter-landing"
          className="pointer-events-none fixed z-app size-0 opacity-50"
          style={{ left: at.landing.x, top: at.landing.y, transform: dockTransform(at.landing, 1) }}
        >
          {landingArt ? (
            <span className="absolute" style={edgeArtBox(landingArt)}>
              <EdgeArtImage art={landingArt} />
            </span>
          ) : (
            <span className="absolute bottom-0 h-[200px] overflow-hidden" style={{ left: -CLIP_HALF_WIDTH, width: CLIP_HALF_WIDTH * 2 }}>
              <img
                src={src}
                width={size.w}
                height={size.h}
                alt=""
                draggable={false}
                className="absolute bottom-0 max-w-none select-none"
                style={{ left: CLIP_HALF_WIDTH - cx }}
              />
            </span>
          )}
        </span>
      ) : null}
      {landingArt ? (
        // Carried toward an edge with its own pose, it already takes that pose (Artea, #24).
        <span
          aria-hidden="true"
          data-testid="assistant-otter-drag"
          className="pointer-events-none fixed z-app drop-shadow-lg"
          style={{ ...edgeArtBox(landingArt), left: at.x - edgeArtBox(landingArt).width / 2, top: at.y - edgeArtBox(landingArt).height / 2 }}
        >
          <EdgeArtImage art={landingArt} />
        </span>
      ) : (
        <img
          src={src}
          width={size.w}
          height={size.h}
          alt=""
          aria-hidden="true"
          draggable={false}
          data-testid="assistant-otter-drag"
          className="pointer-events-none fixed z-app max-w-none select-none drop-shadow-lg"
          style={{ left: at.x - size.w / 2, top: at.y - size.h / 2 }}
        />
      )}
    </>,
    document.body,
  );
}

/**
 * The otter on a main page with no composer (Activity with nothing open,
 * Tasks, Members on a desktop, Search; #17 item 3): the same anchor and placement as on a
 * composer, lying on the page's bottom edge instead of the composer's top
 * edge. Opened here it attaches no conversation. A fallback host: a composer
 * on the page (a conversation opened beside the Activity list) takes it.
 *
 * It takes no room on the page (#proj-assistant:#24): no band below the page
 * for it, only the otter itself over the page's bottom-right corner, as on a
 * composer it lies over the message list's.
 */
export function AssistantPageOtter() {
  const hostId = useId();
  return (
    <div className="relative h-0 w-full shrink-0" data-testid="assistant-page-otter-edge">
      <div className="absolute inset-x-0 bottom-0 h-0">
        <AssistantOtterAnchor hostId={hostId} channelId={null} fallback />
      </div>
    </div>
  );
}
