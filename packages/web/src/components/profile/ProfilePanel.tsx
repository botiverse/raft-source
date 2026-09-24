import { useCallback, useState, useEffect } from "react";
import { useIntl } from "react-intl";
import { X } from "lucide-react";
import { useProfileStore } from "../../store/profileStore";
import { useAgentStore } from "../../store/agentStore";
import type { Agent } from "../../store/agentStore";
import { useServerStore } from "../../store/serverStore";
import { useResizablePanel } from "../../hooks/useResizablePanel";
import { useMobileBack } from "../../hooks/useAppNavigate";
import AgentDetailPanel from "../agent/AgentDetailPanel";
import HumanDetailPanel from "../member/HumanDetailPanel";
import type { HumanProfile } from "../member/HumanDetailPanel";
import PanelHeader from "../ui/PanelHeader";
import Button from "../ui/Button";
import { resolveHumanProfile } from "../member/resolveHumanProfile";
import api from "../../api/client";
import { canRenderAgentDetail, isRemoteAgentProjection } from "../agent/agentDetailAvailability";
import AgentUnavailablePanel from "../agent/AgentUnavailablePanel";
import {
  getCachedAgentProfile,
  getCachedHumanProfile,
  setCachedAgentProfile,
  setCachedHumanProfile,
} from "./profileFallbackCache";

export interface ProfilePanelTarget {
  type: "agent" | "human";
  id: string;
}

export default function ProfilePanel({
  target,
  presentation = "overlay",
  onBack,
  onClose,
  onOpenProfile,
}: {
  /** A controlled target keeps the profile inside its owning page stack
   *  instead of opening the global right-panel overlay. */
  target?: ProfilePanelTarget;
  presentation?: "overlay" | "embedded";
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
  const closeProfile = useProfileStore((s) => s.closeProfile);
  const profileType = target?.type ?? storeProfileType;
  const profileId = target?.id ?? storeProfileId;
  const closePanel = onClose ?? closeProfile;
  const embedded = presentation === "embedded";

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
  const humanFallbackKey = humanFallbackId
    ? `${currentServerId}:${humanFallbackId}`
    : null;
  const cachedHuman = humanFallbackId && currentServerId
    ? getCachedHumanProfile(currentServerId, humanFallbackId)
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
          const fallback = data as Agent & { activity?: string; activityDetail?: string };
          setCachedAgentProfile(currentServerId, fallback);
          setAgentFallbackResult({ key: agentFallbackKey, value: fallback, complete: true });
          if (typeof fallback.activity === "string") {
            updateAgentActivity(fallback.id, fallback.activity, fallback.activityDetail || "");
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

    void api.get(`/servers/${currentServerId}/members/${humanFallbackId}/profile`)
      .then(({ data }) => {
        if (!cancelled) {
          const fallback = data as HumanProfile;
          setCachedHumanProfile(currentServerId, fallback);
          setHumanFallbackResult({ key: humanFallbackKey, value: fallback });
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
  }, [currentServerId, humanFallbackId, humanFallbackKey]);

  const { width, handleResizeStart, handleResizeMove, handleResizeEnd } = useResizablePanel({
    storageKey: "slock:profilePanelWidth",
    min: 300,
    max: 600,
    defaultWidth: 380,
    direction: "left",
  });

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

  // Close on Escape
  useEffect(() => {
    // Embedded profiles live inside a modal Drawer; its owner handles Escape
    // and the unsaved-draft guard. A second document listener here would race
    // the Drawer and could both close the page and dismiss its parent.
    if (embedded) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") closePanel();
    };
    // keydown-global-exempt: docked panel non-modal, Escape is convenience close, parent surface owns focus
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [closePanel, embedded]);

  const resolvedAgent = profileType === "agent" ? agent ?? fallbackAgent : null;

  // Match the back-fallback used by the loaded HumanDetailPanel / AgentDetailPanel
  // (their `useMobileBack(onClose ?? <route>)`). For the loading skeleton we
  // hand the same `closeProfile` so the chevron behaves identically once the
  // panel hydrates — overlay close, no skipping past the underlying surface.
  const skeletonMobileBack = useMobileBack(closePanel);
  const headerBack = onBack ?? skeletonMobileBack;
  const containerClassName = embedded
    ? "flex min-h-0 min-w-0 flex-1 flex-col bg-white"
    : "absolute inset-0 z-30 flex min-h-0 min-w-0 flex-col bg-white lg:relative lg:inset-auto lg:z-auto lg:border-l-2 lg:border-black";
  const containerStyle = !embedded && isDesktop ? { width } : undefined;

  // Render order:
  // 1. Loaded agent → AgentDetailPanel
  // 2. Loaded human → HumanDetailPanel
  // 3. profileType+profileId set but data not yet resolved → skeleton with
  //    PanelHeader (back chevron). Without this, the panel returned `null`
  //    while serverStore.members hydrated / the fallback /profile fetch
  //    landed, which (a) flashed an empty viewport for users hitting a
  //    cold-start `?profile=...` deep link, and (b) raced
  //    `getByTestId("human-mobile-back")` / `agent-mobile-back` past the 5s
  //    Playwright expect timeout in CI (back-navigation.spec.ts flake,
  //    task #18 #proj-frontend:4224cf76 2026-05-28).

  if (profileType === "agent" && canRenderAgentDetail(resolvedAgent, currentServerId)) {
    return (
      <div
        data-testid="profile-panel"
        data-presentation={presentation}
        className={containerClassName}
        style={containerStyle}
      >
        {/* Resize handle (desktop only) */}
        {!embedded && (
          <div
            className="hidden md:block absolute left-0 top-0 bottom-0 w-2 -ml-1 z-10 cursor-col-resize touch-none select-none"
            onPointerDown={handleResizeStart}
            onPointerMove={handleResizeMove}
            onPointerUp={handleResizeEnd}
            onPointerCancel={handleResizeEnd}
          />
        )}
        <AgentDetailPanel
          agent={resolvedAgent}
          onBack={onBack}
          onClose={closePanel}
          onOpenProfile={onOpenProfile}
        />
      </div>
    );
  }

  if (profileType === "agent" && profileId && (resolvedAgent || agentFallbackComplete)) {
    return (
      <div
        data-testid="profile-panel"
        className="absolute inset-0 z-30 flex min-h-0 min-w-0 flex-col bg-white lg:relative lg:inset-auto lg:z-auto lg:border-l-2 lg:border-black"
        style={isDesktop ? { width } : undefined}
      >
        <div
          className="hidden md:block absolute left-0 top-0 bottom-0 w-2 -ml-1 z-10 cursor-col-resize touch-none select-none"
          onPointerDown={handleResizeStart}
          onPointerMove={handleResizeMove}
          onPointerUp={handleResizeEnd}
          onPointerCancel={handleResizeEnd}
        />
        <AgentUnavailablePanel onClose={closeProfile} />
      </div>
    );
  }

  const resolvedHuman: HumanProfile | null = profileType === "human"
    ? resolveHumanProfile(human, fallbackHuman)
    : null;

  if (profileType === "human" && resolvedHuman) {
    return (
      <div
        data-testid="profile-panel"
        data-presentation={presentation}
        className={containerClassName}
        style={containerStyle}
      >
        {/* Resize handle (desktop only) */}
        {!embedded && (
          <div
            className="hidden md:block absolute left-0 top-0 bottom-0 w-2 -ml-1 z-10 cursor-col-resize touch-none select-none"
            onPointerDown={handleResizeStart}
            onPointerMove={handleResizeMove}
            onPointerUp={handleResizeEnd}
            onPointerCancel={handleResizeEnd}
          />
        )}
        <HumanDetailPanel
          human={resolvedHuman}
          onBack={onBack}
          onClose={closePanel}
          onOpenProfile={onOpenProfile}
        />
      </div>
    );
  }

  // Skeleton: overlay is open (profileType+profileId set) but the live store
  // row and the fallback fetch are both still pending. Render the panel
  // chrome — including the back chevron with its matching testid — so the
  // user (and e2e) can interact with the overlay immediately. Body is a
  // quiet loading placeholder; the real panel takes over as soon as
  // resolvedAgent / resolvedHuman flips non-null in the next render.
  if (profileType && profileId) {
    const testid = profileType === "agent" ? "agent-mobile-back" : "human-mobile-back";
    return (
      <div
        data-testid="profile-panel"
        data-presentation={presentation}
        className={containerClassName}
        style={containerStyle}
      >
        {!embedded && (
          <div
            className="hidden md:block absolute left-0 top-0 bottom-0 w-2 -ml-1 z-10 cursor-col-resize touch-none select-none"
            onPointerDown={handleResizeStart}
            onPointerMove={handleResizeMove}
            onPointerUp={handleResizeEnd}
            onPointerCancel={handleResizeEnd}
          />
        )}
        <PanelHeader
          title=""
          onMobileBack={headerBack}
          backButtonVisibility={onBack ? "always" : "responsive"}
          mobileBackProps={{
            "data-testid": testid,
            title: formatMessage({ id: "common.announcement.back" }),
          }}
          actions={onClose ? (
            <Button
              shape="icon"
              onClick={closePanel}
              title={formatMessage({ id: "common.close" })}
              aria-label={formatMessage({ id: "common.close" })}
            >
              <X size={14} />
            </Button>
          ) : undefined}
        />
        <div className="flex flex-1 items-center justify-center text-sm text-black/40 font-display">
          {formatMessage({ id: "common.loading" })}
        </div>
      </div>
    );
  }

  return null;
}
