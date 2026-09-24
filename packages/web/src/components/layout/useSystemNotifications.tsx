import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { AlertTriangle, ArrowUpCircle, Download, Monitor, WifiOff } from "lucide-react";
import {
  PLAN_CONFIG,
  DOWNGRADE_GRACE_PERIOD_DAYS,
  getEffectiveLimits,
  getFinitePlanLimitExcess,
  isDaemonOutdated,
} from "@botiverse/raft-shared";
import { useServerStore } from "../../store/serverStore";
import { useAgentStore } from "../../store/agentStore";
import { useMachineStore } from "../../store/machineStore";
import { useChannelStore } from "../../store/channelStore";
import { useAppNavigate } from "../../hooks/useAppNavigate";
import { useServerPermissions } from "../../hooks/useServerPermissions";
import {
  PWA_INSTALL_ELIGIBLE_DAILY_KEY,
  PWA_INSTALL_OPEN_EVENT,
  PWA_INSTALL_SESSION_COUNT_KEY,
  PWA_INSTALL_SESSION_DISMISSED_KEY,
  PWA_INSTALL_SESSION_SEEN_KEY,
  getCooldownState,
  getPwaInstallDisplayMode,
  getPwaInstallPlatform,
  getSessionCountBucket,
  isPwaStandalone,
  readNumberStorage,
  recordPwaInstallEvent,
  shouldShowPwaInstallPrompt,
} from "../../utils/pwaInstall";
import type {
  BeforeInstallPromptEvent,
  PwaInstallCooldownState,
  PwaInstallPlatform,
  PwaInstallSurface,
} from "../../utils/pwaInstall";
import type { NotificationKind } from "./notificationKind";
import { useDismissedNotificationStore } from "./dismissedNotificationStore";
import {
  formatComputerAttentionCounts,
  summarizeComputerAttention,
} from "../../utils/computerUpgradeIndicator";
export { compareNotificationKind, topNotificationKind } from "./notificationKind";
export type { NotificationKind } from "./notificationKind";

// Originating direction: stdrc 2026-05-02 #proj-uiux:f87f6eb9 (task #94).
//
// Single hook that aggregates everything we'd previously surface as a top
// banner stack into one ordered list of system notifications. The
// Notification Center popup renders this list verbatim. Kinds are ordered
// "error > warning > info" so the worst kind wins for indicator color and
// inbox-style sort.
//
// Adding a new notification source is two steps: build a `NotificationEntry`
// for the new condition and append it to the array returned by this hook. Do
// NOT duplicate kind ordering or default icon decisions in the trigger.

export interface NotificationAction {
  label: string;
  onClick: () => void;
  variant?: "primary" | "secondary";
  disabled?: boolean;
}

export interface NotificationEntry {
  id: string;
  kind: NotificationKind;
  icon?: ReactNode;
  title: string;
  body: ReactNode;
  action?: NotificationAction;
  secondaryAction?: NotificationAction;
  /** When set, the row gets a Dismiss action that hides this notification until the
   *  fingerprint changes. The fingerprint must encode every dimension of
   *  the notification's state — e.g. for machine-offline include the sorted
   *  ids of currently-offline machines, so the notification re-surfaces when
   *  a *different* machine drops. See dismissedNotificationStore.ts. */
  dismissalKey?: string;
}

export type SystemNotificationSurface = "desktop" | "mobile";

export function useSystemNotifications(surface: SystemNotificationSurface = "desktop"): NotificationEntry[] {
  const { formatMessage } = useIntl();
  const server = useServerStore((s) => s.current);
  const machines = useMachineStore((s) => s.machines);
  const machineLoading = useMachineStore((s) => s.loading);
  const latestDaemonVersion = useMachineStore((s) => s.latestDaemonVersion);
  const allAgents = useAgentStore((s) => s.agents);
  const agentLoading = useAgentStore((s) => s.loading);
  const channelsList = useChannelStore((s) => s.channels);
  const { capabilities } = useServerPermissions();
  const nav = useAppNavigate();

  const serverId = server?.id ?? null;
  const [pwaPlatform, setPwaPlatform] = useState<PwaInstallPlatform>("other");
  const [pwaSessionCount, setPwaSessionCount] = useState(1);
  const [pwaCooldownState, setPwaCooldownState] = useState<PwaInstallCooldownState>("not_dismissed");
  const [pwaStandalone, setPwaStandalone] = useState(false);
  const [pwaDeferredPrompt, setPwaDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [pwaInstallBusy, setPwaInstallBusy] = useState(false);
  const pwaShownRef = useRef(false);
  const pwaEligibleRef = useRef(false);

  // Load dismissed notifications per server. Dismissal keys are fingerprints,
  // so a changed notification state still resurfaces after reload.
  const loadDismissedNotifications = useDismissedNotificationStore((s) => s.loadForServer);
  useEffect(() => {
    loadDismissedNotifications(serverId);
  }, [serverId, loadDismissedNotifications]);

  const trackPwaInstall = useCallback(
    (
      event: Parameters<typeof recordPwaInstallEvent>[0]["event"],
      surface: PwaInstallSurface,
      extra: Partial<Parameters<typeof recordPwaInstallEvent>[0]> = {},
    ) => {
      if (typeof window === "undefined") return;
      recordPwaInstallEvent({
        event,
        platform: pwaPlatform,
        surface,
        trigger: "supported_browser",
        displayMode: getPwaInstallDisplayMode(window),
        sessionCountBucket: getSessionCountBucket(pwaSessionCount),
        cooldownState: pwaCooldownState,
        ...extra,
      });
    },
    [pwaCooldownState, pwaPlatform, pwaSessionCount],
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    // oxlint-disable-next-line react-doctor/no-initialize-state -- YMNNE-family: pre-existing non-bug site grandfathered; rule now gates new code (see docs/frontend/render-cost-contract.md)
    setPwaPlatform(getPwaInstallPlatform(window.navigator.userAgent));
    // oxlint-disable-next-line react-doctor/no-initialize-state -- YMNNE-family: pre-existing non-bug site grandfathered; rule now gates new code (see docs/frontend/render-cost-contract.md)
    setPwaStandalone(isPwaStandalone(window));

    const alreadySeen = window.sessionStorage.getItem(PWA_INSTALL_SESSION_SEEN_KEY) === "1";
    const current = readNumberStorage(window.localStorage, PWA_INSTALL_SESSION_COUNT_KEY) ?? 0;
    const next = alreadySeen ? Math.max(current, 1) : current + 1;
    if (!alreadySeen) {
      window.sessionStorage.setItem(PWA_INSTALL_SESSION_SEEN_KEY, "1");
      window.localStorage.setItem(PWA_INSTALL_SESSION_COUNT_KEY, String(next));
    }
    // oxlint-disable-next-line react-doctor/no-initialize-state -- YMNNE-family: pre-existing non-bug site grandfathered; rule now gates new code (see docs/frontend/render-cost-contract.md)
    setPwaSessionCount(Math.max(next, 1));
    // oxlint-disable-next-line react-doctor/no-initialize-state -- YMNNE-family: pre-existing non-bug site grandfathered; rule now gates new code (see docs/frontend/render-cost-contract.md)
    setPwaCooldownState(
      window.sessionStorage.getItem(PWA_INSTALL_SESSION_DISMISSED_KEY) === "1"
        ? "dismissed_active"
        : getCooldownState(Date.now(), null),
    );
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setPwaDeferredPrompt(event as BeforeInstallPromptEvent);
    };
    const onAppInstalled = () => {
      setPwaStandalone(true);
      recordPwaInstallEvent({
        event: "pwa_install_appinstalled",
        platform: pwaPlatform,
        surface: "notification_center",
        trigger: "supported_browser",
        displayMode: getPwaInstallDisplayMode(window),
        sessionCountBucket: getSessionCountBucket(pwaSessionCount),
        cooldownState: pwaCooldownState,
      });
    };
    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    window.addEventListener("appinstalled", onAppInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      window.removeEventListener("appinstalled", onAppInstalled);
    };
  }, [pwaCooldownState, pwaPlatform, pwaSessionCount]);

  const pwaInstallVisible = shouldShowPwaInstallPrompt({
    platform: pwaPlatform,
    standalone: pwaStandalone,
    cooldownState: pwaCooldownState,
    hasNativePrompt: !!pwaDeferredPrompt,
  });

  useEffect(() => {
    if (!pwaInstallVisible || pwaEligibleRef.current || typeof window === "undefined") return;
    // oxlint-disable-next-line react-doctor/no-event-handler -- YMNNE-family: pre-existing non-bug site grandfathered; rule now gates new code (see docs/frontend/render-cost-contract.md)
    const key = `${new Date().toISOString().slice(0, 10)}:${pwaPlatform}`;
    if (window.localStorage.getItem(PWA_INSTALL_ELIGIBLE_DAILY_KEY) !== key) {
      trackPwaInstall("pwa_install_eligible", "notification_center");
      window.localStorage.setItem(PWA_INSTALL_ELIGIBLE_DAILY_KEY, key);
    }
    pwaEligibleRef.current = true;
  }, [pwaInstallVisible, pwaPlatform, trackPwaInstall]);

  useEffect(() => {
    if (!pwaInstallVisible || pwaShownRef.current) return;
    pwaShownRef.current = true;
    trackPwaInstall("pwa_install_cta_shown", "notification_center");
  }, [pwaInstallVisible, trackPwaInstall]);

  const handleDismissPwaInstall = useCallback(() => {
    if (typeof window !== "undefined") {
      window.sessionStorage.setItem(PWA_INSTALL_SESSION_DISMISSED_KEY, "1");
    }
    setPwaCooldownState("dismissed_active");
  }, []);

  const handlePwaInstall = useCallback(async () => {
    if (pwaPlatform === "android_chromium" || pwaPlatform === "desktop_chromium") {
      if (!pwaDeferredPrompt) return;
      setPwaInstallBusy(true);
      trackPwaInstall("pwa_install_cta_clicked", "notification_center");
      try {
        await pwaDeferredPrompt.prompt();
        const choice = await pwaDeferredPrompt.userChoice;
        trackPwaInstall("pwa_install_native_prompt_result", "notification_center", { outcome: choice.outcome });
        setPwaDeferredPrompt(null);
        if (choice.outcome === "dismissed") handleDismissPwaInstall();
      } finally {
        setPwaInstallBusy(false);
      }
      return;
    }

    window.dispatchEvent(new CustomEvent(PWA_INSTALL_OPEN_EVENT, { detail: { source: "notification_center" } }));
  }, [handleDismissPwaInstall, pwaDeferredPrompt, pwaPlatform, trackPwaInstall]);

  return useMemo<NotificationEntry[]>(() => {
    const out: NotificationEntry[] = [];

    // ── 1. Plan downgrade ────────────────────────────────────────────────
    if (server && server.plan === "free" && server.planDowngradedAt) {
      const downgradedAt = new Date(server.planDowngradedAt);
      const graceEnd = new Date(downgradedAt);
      graceEnd.setDate(graceEnd.getDate() + DOWNGRADE_GRACE_PERIOD_DAYS);
      const now = new Date();
      const graceExpired = now >= graceEnd;
      const daysLeft = graceExpired
        ? 0
        : Math.ceil((graceEnd.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

      const limits = getEffectiveLimits("free");
      const liveAgents = allAgents.filter((a) => !a.deletedAt);
      const excessAgents = getFinitePlanLimitExcess(liveAgents.length, limits.maxAgents);
      const excessMachines = getFinitePlanLimitExcess(machines.length, limits.maxMachines);
      const excessChannels = getFinitePlanLimitExcess(channelsList.length, limits.maxChannels);

      out.push({
        id: "plan-downgrade",
        kind: graceExpired ? "error" : "warning",
        icon: <AlertTriangle size={16} className="text-black" />,
        // Dismissal fingerprint: anchor on which phase + how much of an excess
        // remains so the notification re-surfaces if the user adds more resources
        // or grace expires.
        dismissalKey: `plan-downgrade:${graceExpired ? "expired" : "grace"}:${excessAgents}:${excessMachines}:${excessChannels}`,
        title: formatMessage({
          id: graceExpired
            ? "layout.systemNotifications.planDowngradeExpiredTitle"
            : "layout.systemNotifications.planDowngradeTitle",
        }),
        body: graceExpired ? (
          <span>{formatMessage({ id: "layout.systemNotifications.planDowngradeExpiredBody" })}</span>
        ) : (
          <span>
            {excessAgents > 0 && (
              <>
                {formatMessage({ id: "layout.systemNotifications.planAgentsOverLimit" }, { count: excessAgents })}{" "}
              </>
            )}
            {excessMachines > 0 && (
              <>
                {formatMessage({ id: "layout.systemNotifications.planComputersOverLimit" }, { count: excessMachines })}{" "}
              </>
            )}
            {excessChannels > 0 && (
              <>
                {formatMessage({ id: "layout.systemNotifications.planChannelsOverLimit" }, { count: excessChannels })}{" "}
              </>
            )}
            <span>
              {formatMessage(
                { id: "layout.systemNotifications.planDaysLeft" },
                { daysLeft, b: (chunks) => <span key="b" className="font-bold">{chunks}</span> },
              )}
            </span>
          </span>
        ),
        action: {
          label: formatMessage({ id: "layout.systemNotifications.upgrade" }),
          onClick: () => nav.toSettings("billing"),
          variant: "primary",
        },
      });

      // Keep the configured plan name visible somewhere in the codebase so
      // a future refactor doesn't drop the dependency without noticing.
      void PLAN_CONFIG;
    }

    // ── 2. Machine state notifications ─────────────────────────────────────────
    if (capabilities.viewMachines && !machineLoading && !agentLoading) {
      const computerAttention = summarizeComputerAttention(machines);
      const offlineMachines = machines.filter((m) => !m.isComputer && m.status === "offline");
      const outdatedMachines = machines.filter(
        (m) => !m.isComputer && m.status === "online" && isDaemonOutdated(m.daemonVersion, latestDaemonVersion),
      );
      const liveAgents = allAgents.filter((a) => !a.deletedAt);

      if (surface === "mobile" && computerAttention.status !== "none") {
        const counts = formatComputerAttentionCounts(computerAttention, formatMessage);
        const problemIds = computerAttention.problemComputers.map((m) => m.id).sort().join(",");
        const versionFingerprint = computerAttention.problemComputers
          .map((machine) => [
            machine.id,
            machine.computerBroadcastPolicy?.policyRevision ?? "unknown-policy",
            machine.computerBroadcastPolicy?.targetVersion ?? "no-target",
          ].join(":"))
          .sort()
          .join(",");
        out.push({
          id: "computer-attention",
          kind: "warning",
          icon: <Monitor size={16} className="text-black" />,
          dismissalKey: `computer-attention:${versionFingerprint}:${problemIds}:${computerAttention.upgradeCount}:${computerAttention.offlineCount}`,
          title: formatMessage({ id: "layout.systemNotifications.computersNeedAttention" }),
          body: <span className="text-black/60">{counts}</span>,
          action: {
            label: formatMessage({ id: "layout.systemNotifications.view" }),
            onClick: () => {
              if (computerAttention.problemComputers.length === 1) {
                nav.toComputer(computerAttention.problemComputers[0].id);
                return;
              }
              nav.toComputers({ filter: "attention" });
            },
            variant: "primary",
          },
        });
      }

      if (offlineMachines.length > 0) {
        // Kind follows impact, not status: an offline machine without
        // any *active* agents is a warning-level notification the user can clean up later; one
        // carrying agents the user expects to be running blocks live work
        // and is escalated to error. Per stdrc 2026-05-02
        // #proj-uiux:f87f6eb9 msg=fc60d1c2 ("Machine 掉线如果有 active 任务
        // 确实应该是 error") — only `status === "active"` counts; `stopped`
        // / `inactive` agents already aren't running, so them being on an
        // offline machine doesn't change anything for the user right now.
        const offlineIds = new Set(offlineMachines.map((m) => m.id));
        const activeAgentsOnOffline = liveAgents.filter(
          (a) =>
            a.machineId &&
            offlineIds.has(a.machineId) &&
            a.status === "active",
        );
        const offlineKind: NotificationKind =
          activeAgentsOnOffline.length > 0 ? "error" : "warning";
        const names = offlineMachines.map((m) => m.name).join(", ");
        const sortedIds = [...offlineIds].sort().join(",");
        out.push({
          id: "machine-offline",
          kind: offlineKind,
          icon: <WifiOff size={16} className="text-black" />,
          // Fingerprint = which machines are offline. If a different set goes
          // offline (different machine id, or the count changes), the
          // dismissal no longer matches and the notification shows again.
          dismissalKey: `machine-offline:${sortedIds}`,
          title: formatMessage(
            { id: "layout.systemNotifications.machineOfflineTitle" },
            { names, count: offlineMachines.length },
          ),
          body:
            activeAgentsOnOffline.length > 0 ? (
              <span className="text-black/60">
                {formatMessage(
                  { id: "layout.systemNotifications.machineOfflineActiveAgentsBody" },
                  { count: activeAgentsOnOffline.length },
                )}
              </span>
            ) : (
              <span className="text-black/60">
                {formatMessage({ id: "layout.systemNotifications.machineOfflineNoActiveAgentsBody" })}
              </span>
            ),
          action: {
            label: formatMessage({ id: "layout.systemNotifications.view" }),
            onClick: () => nav.toMachine(offlineMachines[0].id),
            variant: "primary",
          },
        });
      }

      if (outdatedMachines.length > 0) {
        const names = outdatedMachines.map((m) => m.name).join(", ");
        const outdatedIds = outdatedMachines.map((m) => m.id).sort().join(",");
        // Fingerprint also includes the latest target version so a freshly
        // released daemon resurfaces the notification even if the same machine
        // set was previously dismissed.
        const versionFingerprint = `${latestDaemonVersion ?? "unknown"}:${outdatedIds}`;
        out.push({
          id: "machine-outdated",
          kind: "warning",
          icon: <ArrowUpCircle size={16} className="text-black" />,
          dismissalKey: `machine-outdated:${versionFingerprint}`,
          title: formatMessage(
            { id: "layout.systemNotifications.machineOutdatedTitle" },
            { names, count: outdatedMachines.length },
          ),
          body: <span className="text-black/60">{formatMessage({ id: "layout.systemNotifications.machineOutdatedBody" })}</span>,
          action: {
            label: formatMessage({ id: "layout.systemNotifications.view" }),
            onClick: () => nav.toMachine(outdatedMachines[0].id),
            variant: "primary",
          },
        });
      }

      // "No computer connected" / "No agents yet" used to live here, but per
      // stdrc 2026-05-02 #proj-uiux:f87f6eb9 msg=fc60d1c2 the OwnerOnboarding
      // modal already handles that surface; surfacing the same condition in
      // the notification center is duplicate noise. Don't add them back without
      // first removing the modal.
    }

    // ── 3. PWA install prompt ───────────────────────────────────────────
    if (pwaInstallVisible) {
      out.push({
        id: "pwa-install",
        kind: "info",
        icon: <Download size={16} className="text-black" />,
        title: formatMessage({ id: "layout.systemNotifications.installRaftTitle" }),
        body: <span className="text-black/60">{formatMessage({ id: "layout.systemNotifications.installRaftBody" })}</span>,
        action: {
          label: formatMessage({ id: pwaInstallBusy ? "layout.systemNotifications.opening" : "layout.systemNotifications.install" }),
          onClick: () => {
            if (!pwaInstallBusy) void handlePwaInstall();
          },
          variant: "primary",
          disabled: pwaInstallBusy,
        },
        secondaryAction: {
          label: formatMessage({ id: "common.announcement.dismiss" }),
          onClick: handleDismissPwaInstall,
          disabled: pwaInstallBusy,
        },
      });
    }

    return out;
  }, [
    server,
    machines,
    machineLoading,
    latestDaemonVersion,
    allAgents,
    agentLoading,
    channelsList,
    capabilities.viewMachines,
    nav,
    pwaInstallVisible,
    pwaInstallBusy,
    handlePwaInstall,
    handleDismissPwaInstall,
    surface,
    formatMessage,
  ]);
}

/**
 * Filtered version of useSystemNotifications: drops entries whose dismissalKey is
 * in the session-scoped dismissed set. The notification badge reads this so
 * dismissals immediately quiet the trigger.
 */
export function useVisibleNotifications(surface: SystemNotificationSurface = "desktop"): NotificationEntry[] {
  const all = useSystemNotifications(surface);
  const dismissed = useDismissedNotificationStore((s) => s.dismissedKeys);
  return useMemo(
    () => all.filter((w) => !w.dismissalKey || !dismissed.has(w.dismissalKey)),
    [all, dismissed],
  );
}
