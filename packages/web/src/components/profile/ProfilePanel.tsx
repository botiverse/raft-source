import Tooltip from "../ui/Tooltip";
import { Suspense, useCallback, useMemo, useRef, useState, useEffect } from "react";
import type { ReactNode } from "react";
import type { RuntimeErrorCode } from "@botiverse/raft-shared";
import { useIntl } from "react-intl";
import { MonitorX, X } from "lucide-react";
import {
  PanelAction,
  PanelHeading,
  PanelMeta,
  PanelTitle,
  ProfilePanel,
  ProfilePanelBody,
  Skeleton,
} from "@botiverse/raft-ui";
import { useProfileStore } from "../../store/profileStore";
import { useAgentStore } from "../../store/agentStore";
import type { Agent } from "../../store/agentStore";
import { useServerStore } from "../../store/serverStore";
import { useColumnWidth } from "../../store/columnWidthStore";
import { PROFILE_PANEL_OVERLAY_CLASS, profilePanelDesktopStyle } from "./profilePanelGeometry";
import ColumnResizeHandle from "../ui/ColumnResizeHandle";
import { useMobileBack } from "../../hooks/useAppNavigate";
import { useFocusRestore } from "../../hooks/useFocusRestore";
import { AgentDetailPanel } from "../../features/agent/AgentDetailPanel";
import HumanDetailPanel from "../member/HumanDetailPanel";
import type { HumanProfile } from "../member/HumanDetailPanel";
import PanelHeader, { PROFILE_HANDLE_FONT_CLASS } from "../ui/PanelHeader";
import { SkeletonTextBar } from "../ui/Skeleton";
import { TabBarRow } from "../../boot/bootSkeletons";
import { resolveHumanProfile } from "../member/resolveHumanProfile";
import api from "../../api/client";
import { canRenderAgentDetail, isRemoteAgentProjection } from "../agent/agentDetailAvailability";
import AgentUnavailablePanel from "../agent/AgentUnavailablePanel";
import ExternalIdentityDetailPanel from "./ExternalIdentityDetailPanel";
import {
  getCachedAgentProfile,
  getCachedHumanProfile,
  setCachedAgentProfile,
  setCachedHumanProfile,
} from "./profileFallbackCache";
import { recordProfileOpenE2eEvent } from "../../utils/profileOpenE2eTimeline";
import { ContentLoading } from "../ui/ContentLoading";
import AppEmptyState from "../ui/EmptyState";
import { useMachineStore } from "../../store/machineStore";
import type { Machine } from "../../store/machineStore";
import { deferredPanel } from "../../boot/deferredUi";
import { loadMachineDetailPanel } from "../../features/computer/machineDetailChunk";
import MachinePanelHeader from "../machine/MachinePanelHeader";
import { RowExpandAction } from "../layout/RowExpandAction";
import { RowMoveMenu } from "../layout/ColumnMoveMenu";
import { RowRegionBody } from "../layout/RowRegionBody";
import { isCoveredByShortcutHelp } from "../../features/keyboard-shortcuts/shortcutHelpStore";
import { useShortcutLayer } from "../../features/shortcuts/useShortcutLayer";

recordProfileOpenE2eEvent({ kind: "module-evaluated", module: "profile-panel" });

// A computer's detail is its own download (machineDetailChunk), usually
// fetched before anyone opens one; a failed download offers Try again here.
const MachineDetailPanel = deferredPanel(loadMachineDetailPanel);
// A computer this server doesn't have (or not yet): a nameless head.
const UNKNOWN_COMPUTER = { name: "" };

/**
 * A computer in the profile panel (Raft DS › Navigation, "Opening an item"):
 * its head comes from the computer the list already has, outside the
 * detail's download, so it is drawn at once, does not move when the detail
 * arrives, and keeps × and Back if that download fails. Opening a computer
 * moves focus into the panel; closing it gives focus back to what opened it
 * (a card's name on the wall), if focus would otherwise fall to the page.
 */
function ComputerProfile({
  machineId,
  onClose,
}: {
  machineId: string;
  onClose: () => void;
}) {
  const { formatMessage } = useIntl();
  const machine = useMachineStore(
    useCallback((s) => s.machines.find((m: Machine) => m.id === machineId), [machineId]),
  );
  const machinesLoading = useMachineStore((s) => s.loadStatus === "loading");
  const rootRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  // Another card that took the panel holds focus already; only a close (×,
  // Esc) leaves it on the page.
  const restoreFocus = useFocusRestore(openerRef, { preventScroll: true });
  useEffect(() => {
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    rootRef.current?.focus({ preventScroll: true });
    return restoreFocus;
  }, [machineId, restoreFocus]);
  const loading = (
    <ProfilePanelBody className="flex flex-1 items-center justify-center">
      <ContentLoading>{formatMessage({ id: "common.loading" })}</ContentLoading>
    </ProfilePanelBody>
  );
  let body: ReactNode;
  if (machine) {
    body = (
      <Suspense fallback={loading}>
        <MachineDetailPanel key={machine.id} machine={machine} hideHeader />
      </Suspense>
    );
  } else if (machinesLoading) {
    body = loading;
  } else {
    body = <AppEmptyState className="flex-1" icon={<MonitorX />} title={formatMessage({ id: "layout.main.computerNotFound" })} />;
  }
  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      className="flex min-h-0 min-w-0 flex-1 flex-col outline-none"
      data-testid="computer-profile"
    >
      <MachinePanelHeader machine={machine ?? UNKNOWN_COMPUTER} onClose={onClose} />
      <RowRegionBody>{body}</RowRegionBody>
    </div>
  );
}

export interface ProfilePanelTarget {
  type: "agent" | "human";
  id: string;
}

const humanProfileUrl = (serverId: string, userId: string) => `/servers/${serverId}/members/${userId}/profile`;

/** The panel's props, for the lazy wrappers that load it (boot/deferredUi lazyPanel). */
export type ProfilePanelProps = NonNullable<Parameters<typeof ConnectedProfilePanel>[0]>;

export default function ConnectedProfilePanel({
  target,
  channelId: targetChannelId,
  presentation = "overlay",
  onBack,
  onClose,
  onOpenProfile,
}: {
  /** A controlled target keeps the profile inside its owning page stack
   *  instead of opening the global right-panel overlay. */
  target?: ProfilePanelTarget;
  /** With `target`: the channel its stack belongs to (a channel's members
   *  page, a task's conversation). A person's profile names their servers in
   *  it. Without `target` the store's `profileChannelId` is used. */
  channelId?: string | null;
  /** `column`: a column of the planned row (#189 rule 7: a side section like Tasks), sized and seamed by its column. */
  presentation?: "overlay" | "embedded" | "column";
  /** Embedded page-stack back: reveal the previous page in the same shell. */
  onBack?: () => void;
  /** Explicitly close the owning shell. Global overlays default to closeProfile. */
  onClose?: () => void;
  /** Keep nested creator/created-agent navigation inside the owning stack. */
  onOpenProfile?: (type: "agent" | "human", id: string) => void;
} = {}) {
  const { formatMessage } = useIntl();
  const storeProfileType = useProfileStore((s) => s.profileType);
  const storeProfileId = useProfileStore((s) => s.profileId);
  const storeProfileChannelId = useProfileStore((s) => s.profileChannelId);
  const externalProfile = useProfileStore((s) => s.externalProfile);
  const closeProfile = useProfileStore((s) => s.closeProfile);
  const profileType = target?.type ?? storeProfileType;
  const profileId = target?.id ?? storeProfileId;
  const profileChannelId = (target ? targetChannelId : storeProfileChannelId) ?? null;
  const closePanel = onClose ?? closeProfile;
  const embedded = presentation === "embedded";
  // Its box is its host's: the drawer it is embedded in, or its column in the row (#189).
  const framed = embedded || presentation === "column";

  const agent = useAgentStore(
    useCallback((s) => s.agents.find((a) => a.id === profileId), [profileId])
  );
  const updateAgentActivity = useAgentStore((s) => s.updateActivity);
  const members = useServerStore((s) => s.members);
  const currentServerId = useServerStore((s) => s.current?.id);
  const human = profileType === "human" ? members.find((m) => m.userId === profileId) : undefined;
  const agentFallbackId = profileType === "agent" && profileId && !agent ? profileId : null;
  const agentFallbackKey = agentFallbackId
    ? `${currentServerId ?? "no-server"}:${agentFallbackId}`
    : null;
  const cachedAgent = agentFallbackId
    ? getCachedAgentProfile(currentServerId, agentFallbackId)
    : null;
  const [agentFallbackResult, setAgentFallbackResult] = useState<{
    key: string;
    value: Agent | null;
    complete: boolean;
  } | null>(null);
  // Keyed async results make an old profile response invisible as soon as the
  // controlled target changes. This preserves the page-stack transition
  // without effect-driven "reset" state writes during the next render.
  const fallbackAgent = agentFallbackResult?.key === agentFallbackKey
    ? agentFallbackResult.value
    : cachedAgent;
  const agentFallbackComplete = agentFallbackResult?.key === agentFallbackKey
    ? agentFallbackResult.complete
    : isRemoteAgentProjection(cachedAgent, currentServerId);

  const humanFallbackId = profileType === "human" && profileId && currentServerId ? profileId : null;
  // Keyed per channel too: the same person opened from two channels may be
  // from different servers in each (#wg-rbac:#58).
  const humanFallbackKey = humanFallbackId
    ? `${currentServerId}:${profileChannelId ?? ""}:${humanFallbackId}`
    : null;
  const cachedHuman = humanFallbackId && currentServerId
    ? getCachedHumanProfile(currentServerId, humanFallbackId, profileChannelId)
    : null;
  const [humanFallbackResult, setHumanFallbackResult] = useState<{
    key: string;
    value: HumanProfile | null;
  } | null>(null);
  const fallbackHuman = humanFallbackResult?.key === humanFallbackKey
    ? humanFallbackResult.value
    : cachedHuman;

  // Async-loader: agent fallback when not in members list. Results are keyed
  // by viewer server + profile target, so target changes need no state reset.
  // Each async completion takes one mutually exclusive success/failure path.
  // oxlint-disable-next-line react-doctor/no-cascading-set-state
  useEffect(() => {
    let cancelled = false;
    if (!agentFallbackKey || !agentFallbackId) return;

    // Peer agents exposed through an active joint-channel membership are
    // intentionally bounded profile projections. The current server cannot
    // authoritatively fill their runtime/model/private fields, and its
    // `/agents/:id` endpoint correctly returns 404 for those foreign ids.
    if (isRemoteAgentProjection(cachedAgent, currentServerId)) {
      return;
    }
    void api.get(`/agents/${agentFallbackId}`)
      .then(({ data }) => {
        if (!cancelled) {
          const fallback = data as Agent & { activity?: string; activityDetail?: string; activityErrorCode?: RuntimeErrorCode };
          setCachedAgentProfile(currentServerId, fallback);
          setAgentFallbackResult({ key: agentFallbackKey, value: fallback, complete: true });
          if (typeof fallback.activity === "string") {
            updateAgentActivity(fallback.id, fallback.activity, fallback.activityDetail || "", undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, fallback.activityErrorCode);
          }
        }
      })
      .catch(() => {
        if (!cancelled) {
          setAgentFallbackResult({ key: agentFallbackKey, value: null, complete: true });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [agentFallbackId, agentFallbackKey, cachedAgent, currentServerId, updateAgentActivity]);

  // Async-loader: human fallback when not in members list. The keyed result
  // follows the same stale-target protection as the agent loader above.
  // Each async completion takes one mutually exclusive success/failure path.
  // oxlint-disable-next-line react-doctor/no-cascading-set-state
  useEffect(() => {
    let cancelled = false;
    if (!humanFallbackKey || !humanFallbackId || !currentServerId) return;

    // Opened from a channel, the server names the person's servers in that
    // channel (`servers`, an empty list included); the panel shows exactly
    // what it answers, never servers derived here.
    void api.get(humanProfileUrl(currentServerId, humanFallbackId), profileChannelId ? { params: { channelId: profileChannelId } } : undefined)
      .then(({ data }) => {
        if (!cancelled) {
          const fetched = data as HumanProfile;
          setCachedHumanProfile(currentServerId, fetched, profileChannelId);
          setHumanFallbackResult({ key: humanFallbackKey, value: fetched });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setHumanFallbackResult({ key: humanFallbackKey, value: null });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [currentServerId, humanFallbackId, humanFallbackKey, profileChannelId]);

  // Shared with the legacy task panel: both are the right-hand detail column.
  const width = useColumnWidth("detail");

  // Track desktop vs mobile
  const [isDesktop, setIsDesktop] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia("(min-width: 1024px)").matches : true
  );
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const handler = (e: MediaQueryListEvent) => setIsDesktop(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  // Close on Escape: a docked panel layer (the registry's stack, so an overlay opened over it takes Esc first).
  // Embedded profiles live inside a modal Drawer; its owner handles Escape and the unsaved-draft guard. A field in the
  // panel that takes Escape itself (cancelling a rename) marks it handled, which the layer respects; an input method's
  // Esc never reaches it (the dispatcher's IME guard). Under the keyboard shortcuts panel the profile is covered: it
  // comes back on close.
  useShortcutLayer("panel", !embedded, { onEscape: () => (isCoveredByShortcutHelp() ? false : void closePanel()) });

  const resolvedAgent = profileType === "agent" ? agent ?? fallbackAgent : null;

  // Match the back-fallback used by the loaded HumanDetailPanel / AgentDetailPanel
  // (their `useMobileBack(onClose ?? <route>)`). For the loading skeleton we
  // hand the same `closeProfile` so the chevron behaves identically once the
  // panel hydrates — overlay close, no skipping past the underlying surface.
  const skeletonMobileBack = useMobileBack(closePanel);
  const headerBack = onBack ?? skeletonMobileBack;
  // The divider between this pane and its left neighbour belongs to this
  // pane's own box, applied in index.css only when a neighbour exists (the
  // sidebar already draws its own edge). The resize handle stays transparent:
  // it sits over the neighbour, so anything stacked above it there (the
  // composer bar) would hide a line drawn on it (#proj-frontend task #683).
  const containerClassName = framed
    ? "flex min-h-0 flex-1 flex-col"
    : PROFILE_PANEL_OVERLAY_CLASS;
  const containerEdge = framed ? "inset" : "attached";
  const containerStyle = useMemo(
    () => (!framed && isDesktop ? profilePanelDesktopStyle(width) : undefined),
    [framed, isDesktop, width],
  );
  const agentDetailStyle = useMemo(() => (isDesktop && !framed ? { width } : undefined), [framed, isDesktop, width]);
  const skeletonBackTestId = profileType === "agent"
    ? "agent-mobile-back"
    : profileType === "external"
      ? "external-mobile-back"
      : "human-mobile-back";
  const skeletonMobileBackProps = useMemo(() => ({
    "data-testid": skeletonBackTestId,
    title: formatMessage({ id: "common.announcement.back" }),
  }), [formatMessage, skeletonBackTestId]);

  // Render order:
  // 1. External message author → provider identity detail in this same panel
  // 2. Loaded agent → AgentDetailPanel
  // 3. Loaded human → HumanDetailPanel
  // 4. profileType+profileId set but data not yet resolved → skeleton with
  //    PanelHeader (back chevron). Without this, the panel returned `null`
  //    while serverStore.members hydrated / the fallback /profile fetch
  //    landed, which (a) flashed an empty viewport for users hitting a
  //    cold-start `?profile=...` deep link, and (b) raced
  //    `getByTestId("human-mobile-back")` / `agent-mobile-back` past the 5s
  //    Playwright expect timeout in CI (back-navigation.spec.ts flake,
  //    task #18 #proj-frontend:4224cf76 2026-05-28).

  if (profileType === "external" && profileId && externalProfile) {
    return (
      <ProfilePanel
        data-testid="profile-panel"
        data-otter-dock="profile"
        data-presentation={presentation}
        edge={containerEdge}
        className={containerClassName}
        style={containerStyle}
      >
        {!framed && (
          <ColumnResizeHandle column="detail" edge="left" visibleFrom="lg" />
        )}
        <ExternalIdentityDetailPanel
          profile={externalProfile}
          onBack={onBack}
          onClose={closePanel}
        />
      </ProfilePanel>
    );
  }

  if (profileType === "computer" && profileId) {
    return (
      <ProfilePanel
        data-testid="profile-panel"
        data-otter-dock="profile"
        data-presentation={presentation}
        data-profile-type="computer"
        edge={containerEdge}
        className={containerClassName}
        style={containerStyle}
      >
        {!framed && (
          <ColumnResizeHandle column="detail" edge="left" visibleFrom="lg" />
        )}
        <ComputerProfile machineId={profileId} onClose={closePanel} />
      </ProfilePanel>
    );
  }

  if (profileType === "agent" && canRenderAgentDetail(resolvedAgent, currentServerId)) {
    return (
      <ProfilePanel
        data-testid="profile-panel"
        data-otter-dock="profile"
        data-presentation={presentation}
        edge={containerEdge}
        className={containerClassName}
        style={containerStyle}
      >
        {/* Resize handle (desktop only) */}
        {!framed && (
          <ColumnResizeHandle column="detail" edge="left" visibleFrom="lg" />
        )}
        <AgentDetailPanel
          agent={resolvedAgent}
          onBack={onBack}
          onClose={closePanel}
          onOpenProfile={onOpenProfile}
        />
      </ProfilePanel>
    );
  }

  if (profileType === "agent" && profileId && (resolvedAgent || agentFallbackComplete)) {
    return (
      <ProfilePanel
        data-testid="profile-panel"
        data-otter-dock="profile"
        edge="inset"
        className={framed ? "flex min-h-0 min-w-0 flex-1 flex-col bg-layer-canvas" : "absolute inset-0 z-cover flex min-h-0 min-w-0 flex-col bg-layer-canvas lg:relative lg:inset-auto lg:z-auto"}
        style={agentDetailStyle}
      >
        {framed ? null : <ColumnResizeHandle column="detail" edge="left" visibleFrom="lg" />}
        <AgentUnavailablePanel onClose={closeProfile} />
      </ProfilePanel>
    );
  }

  const resolvedHuman: HumanProfile | null = profileType === "human"
    ? resolveHumanProfile(human, fallbackHuman)
    : null;

  if (profileType === "human" && resolvedHuman) {
    return (
      <ProfilePanel
        data-testid="profile-panel"
        data-otter-dock="profile"
        data-presentation={presentation}
        edge={containerEdge}
        className={containerClassName}
        style={containerStyle}
      >
        {/* Resize handle (desktop only) */}
        {!framed && (
          <ColumnResizeHandle column="detail" edge="left" visibleFrom="lg" />
        )}
        <HumanDetailPanel
          key={resolvedHuman.userId}
          human={resolvedHuman}
          onBack={onBack}
          onClose={closePanel}
          onOpenProfile={onOpenProfile}
        />
      </ProfilePanel>
    );
  }

  // Skeleton: overlay is open (profileType+profileId set) but the live store
  // row and the fallback fetch are both still pending. Render the panel
  // chrome — including the back chevron with its matching testid — so the
  // user (and e2e) can interact with the overlay immediately. Body is a
  // quiet loading placeholder; the real panel takes over as soon as
  // resolvedAgent / resolvedHuman flips non-null in the next render.
  if (profileType && profileId) {
    return (
      <ProfilePanel
        data-testid="profile-panel"
        data-otter-dock="profile"
        data-presentation={presentation}
        edge={containerEdge}
        className={containerClassName}
        style={containerStyle}
      >
        {!framed && (
          <ColumnResizeHandle column="detail" edge="left" visibleFrom="lg" />
        )}
        {/* The profile's head, tab bar (an agent's) and hero in their own
            parts, with bars for what is not known yet, so the loaded profile
            lands where they were (skeleton-vs-layout audit round 2: an empty
            head over a centred "Loading…"). */}
        <PanelHeader
          title=""
          iconSlot={<Skeleton aria-hidden="true" className="size-[35px] md:pointer-fine:size-[27px]" />}
          iconAlwaysVisible
          iconKind="avatar"
          titleSlot={(
            <>
              <PanelHeading><PanelTitle render={<div />}><SkeletonTextBar className="w-32" /></PanelTitle></PanelHeading>
              <PanelMeta render={<div />} className={PROFILE_HANDLE_FONT_CLASS}><SkeletonTextBar className="w-20" /></PanelMeta>
            </>
          )}
          onMobileBack={headerBack}
          backButtonVisibility={onBack ? "always" : "responsive"}
          mobileBackProps={skeletonMobileBackProps}
          actions={onClose ? (
            <>
              {/* The profile's Expand (#189 rule 5), a window control against Close; none outside the planned row. */}
              <RowMoveMenu />
              <RowExpandAction />
              <Tooltip content={formatMessage({ id: "common.close" })}>
                <PanelAction
                  onClick={closePanel}
                  aria-label={formatMessage({ id: "common.close" })}
                >
                  <X size={22} aria-hidden="true" />
                </PanelAction>
              </Tooltip>
            </>
          ) : undefined}
        />
        <RowRegionBody>
          <ProfilePanelBody className="flex min-h-0 flex-1 flex-col bg-layer-canvas font-sans" aria-busy="true" data-testid="profile-panel-loading">
            <span className="sr-only" role="status">{formatMessage({ id: "common.loading" })}</span>
            {profileType === "agent" ? <TabBarRow /> : null}
            {/* The hero (AgentDetailPanel's, HumanDetailPanel's): the 99px
                avatar, the name and the handle. */}
            <div className="flex items-start gap-4 px-(--surface-inset) py-5" aria-hidden="true" data-testid="profile-hero-skeleton">
              <Skeleton className="size-[99px] shrink-0" />
              <div className="min-w-0 flex-1 pt-1">
                <PanelTitle render={<div />}><SkeletonTextBar className="w-36" /></PanelTitle>
                <div className={`text-mono-meta ${PROFILE_HANDLE_FONT_CLASS}`}><SkeletonTextBar className="w-24" /></div>
              </div>
            </div>
          </ProfilePanelBody>
        </RowRegionBody>
      </ProfilePanel>
    );
  }

  return null;
}
