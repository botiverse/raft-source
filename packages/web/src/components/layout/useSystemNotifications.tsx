import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { AlertTriangle, Download, HardDrive, Monitor, WifiOff } from "lucide-react";
import { FeedbackIcon, JoinJointChannelIcon } from "@botiverse/ricons";
import { PLAN_CONFIG, currentTimeMs } from "@botiverse/raft-shared";
import type { RuntimeAccountUsageProvider } from "@botiverse/raft-shared";
import { resetWhen } from "../machine/rack/rackResetText";
import { machineDiskLowPresentation } from "../../utils/machineDiskPresentation";
import { showsPlanDowngradeNotice } from "../../utils/planDowngrade";
import { useFeedbackUnread } from "../../feedback/useFeedbackUnread";
import { useServerStore } from "../../store/serverStore";
import { useAgentStore } from "../../store/agentStore";
import { useMachineStore } from "../../store/machineStore";
import { useAuthStore } from "../../store/authStore";
import { useChannelStore } from "../../store/channelStore";
import { useAppNavigate } from "../../hooks/useAppNavigate";
import { usePaywallUpgrade } from "../../hooks/usePaywallUpgrade";
import { PaywallShown } from "../../analytics/paywall";
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
import {
  machinesNeedingReinstall,
  machinesNeedingUpgradeByDeadline,
} from "../../utils/computersNeedingReinstall";
import { computerVersionNotificationEntries } from "./computerVersionNotifications";
import { isJointChannelReadOnly, jointInviteAcceptErrorMessage } from "../../utils/jointChannelLimit";
import { useUsageLimitAttention } from "./useUsageLimitAttention";
import { useSeatJoinBlocks } from "./useSeatJoinBlocks";
import { openSeatJoinDialog } from "../billing/SeatJoinDialog";
import { usePendingJointInvites } from "./usePendingJointInvites";
import { useAppPermissionUpdates } from "./useAppPermissionUpdates";
import { useSecondFactorRecoveryNotification } from "../auth/useSecondFactorRecoveryNotification";
import api from "../../api/client";
import { showToast } from "../toastBridge";

/** A usage-limit notice's provider, as its title names it ("Claude used up"). */
const USAGE_LIMIT_PROVIDER_NAMES: Record<RuntimeAccountUsageProvider, string> = {
  claude: "Claude",
  codex: "Codex",
  kimi: "Kimi",
  grok: "Grok",
  antigravity: "Antigravity",
};
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
  /** It opens a dialog: the notification center closes first, so it isn't left open behind it. */
  opensDialog?: boolean;
}

export interface NotificationEntry {
  id: string;
  kind: NotificationKind;
  icon?: ReactNode;
  title: string;
  body: ReactNode;
  action?: NotificationAction;
  secondaryAction?: NotificationAction;
  /** Server-backed unread state. Omitted entries retain the legacy behavior
   *  of appearing unread while visible. */
  unread?: boolean;
  /** Called when the Notification Center opens; must be idempotent. */
  onSeen?: () => void;
  /** When set, the row gets a Dismiss action that hides this notification until the
   *  fingerprint changes. The fingerprint must encode every dimension of
   *  the notification's state — e.g. for machine-offline include the sorted
   *  ids of currently-offline machines, so the notification re-surfaces when
   *  a *different* machine drops. See dismissedNotificationStore.ts. */
  dismissalKey?: string;
  /** An account-security alert (a two-step verification reset on this
   *  account): listed first, and while it is there the Bell wears the
   *  security marker instead of the unread dot (NotificationTrigger). */
  security?: boolean;
}

export type SystemNotificationSurface = "desktop" | "mobile";

export function useSystemNotifications(surface: SystemNotificationSurface = "desktop"): NotificationEntry[] {
  const { formatMessage, formatDate, locale } = useIntl();
  const server = useServerStore((s) => s.current);
  const machines = useMachineStore((s) => s.machines);
  const machineLoading = useMachineStore((s) => s.loading);
  const allAgents = useAgentStore((s) => s.agents);
  const agentLoading = useAgentStore((s) => s.loading);
  const channelsList = useChannelStore((s) => s.channels);
  const currentUserId = useAuthStore((s) => s.user?.id ?? null);
  const dismissedNotificationKeys = useDismissedNotificationStore((s) => s.dismissedKeys);
  const { capabilities } = useServerPermissions();
  const nav = useAppNavigate();
  const paywallUpgrade = usePaywallUpgrade();
  const feedbackUnread = useFeedbackUnread();
  const usageLimitAttention = useUsageLimitAttention();
  const { blocks: seatJoinBlocks, usage: seatJoinUsage } = useSeatJoinBlocks();
  const { invites: pendingJointInvites, refresh: refreshPendingJointInvites } = usePendingJointInvites();
  const secondFactorRecovery = useSecondFactorRecoveryNotification();
  const [acceptingJointInviteId, setAcceptingJointInviteId] = useState<string | null>(null);

  const serverId = server?.id ?? null;
  const appPermissionUpdates = useAppPermissionUpdates(serverId, currentUserId, capabilities.manageIntegrations);
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

  // Same endpoint as the email link (App.tsx `?jointInvite=`), so accept
  // authority and limit checks are identical on both paths.
  const acceptJointInvite = useCallback(async (inviteId: string) => {
    if (!serverId) return;
    setAcceptingJointInviteId(inviteId);
    try {
      const { data } = await api.post(`/channels/joint-invites/${encodeURIComponent(inviteId)}/accept`, undefined, {
        headers: { "X-Server-Id": serverId },
      });
      const channelId = typeof data?.id === "string" ? data.id : null;
      if (channelId) {
        await useChannelStore.getState().ensureChannel(channelId);
        nav.toChannel(channelId);
      }
    } catch (err) {
      showToast({ title: jointInviteAcceptErrorMessage(err, formatMessage, server?.name), type: "error" });
    } finally {
      setAcceptingJointInviteId(null);
      void refreshPendingJointInvites();
    }
  }, [formatMessage, nav, refreshPendingJointInvites, server?.name, serverId]);

  return useMemo<NotificationEntry[]>(() => {
    const out: NotificationEntry[] = [];

    // ── Account security first: a two-step verification reset on this account.
    if (secondFactorRecovery) out.push(secondFactorRecovery);

    if (appPermissionUpdates > 0) {
      out.push({
        id: "app-permission-updates",
        kind: "warning",
        title: formatMessage({ id: "layout.systemNotifications.appPermissionUpdatesTitle" }),
        body: formatMessage({ id: "layout.systemNotifications.appPermissionUpdatesBody" }, { count: appPermissionUpdates }),
        action: {
          label: formatMessage({ id: "settings.connectedApps.viewPermissionUpdates" }),
          onClick: () => nav.toApps("?permission_updates=1"),
        },
      });
    }

    // ── 0a. Pending joint channel invites (RFC 075 §4.5) ─────────────────
    for (const invite of pendingJointInvites) {
      out.push({
        id: `joint-invite:${invite.id}`,
        kind: "info",
        icon: <JoinJointChannelIcon width={16} height={16} className="text-foreground" />,
        dismissalKey: `joint-invite:${invite.id}`,
        title: formatMessage({ id: "layout.systemNotifications.jointInviteTitle" }, { channel: invite.channelName }),
        body: (
          <span className="text-foreground-muted">
            {formatMessage({ id: "layout.systemNotifications.jointInviteBody" }, { server: invite.fromServerName })}
          </span>
        ),
        action: {
          label: formatMessage({ id: "layout.systemNotifications.jointInviteAccept" }),
          onClick: () => void acceptJointInvite(invite.id),
          variant: "primary",
          disabled: acceptingJointInviteId !== null,
        },
      });
    }

    // ── 0. Authoritative runtime-account usage limits ───────────────────
    // These rows come from the durable server projection. Never infer them
    // from Agent error strings: only a newer normalized usage snapshot may
    // activate or silently resolve an incident.
    for (const notification of usageLimitAttention.notifications) {
      const provider = USAGE_LIMIT_PROVIDER_NAMES[notification.provider] ?? notification.provider;
      // Relative, as the usage card and cell say it: "Back in 6 days".
      const reset = resetWhen(notification.resetsAt, locale, currentTimeMs());
      out.push({
        id: `usage-limit:${notification.id}`,
        kind: "warning",
        icon: <AlertTriangle size={16} className="text-foreground" />,
        unread: notification.seenAt === null,
        onSeen: () => { void usageLimitAttention.markSeen(notification.id); },
        title: formatMessage(
          { id: "layout.systemNotifications.usageLimitTitle" },
          { provider },
        ),
        body: (
          <span className="text-foreground-muted">
            {formatMessage(
              { id: reset
                ? "layout.systemNotifications.usageLimitBodyWithReset"
                : "layout.systemNotifications.usageLimitBody" },
              {
                count: notification.affectedAgentIds.length,
                computer: notification.machine.name,
                reset,
              },
            )}
          </span>
        ),
        action: {
          label: formatMessage({ id: "layout.systemNotifications.view" }),
          onClick: () => nav.toComputer(notification.machine.id),
          variant: "primary",
        },
        secondaryAction: {
          label: formatMessage({ id: "common.announcement.dismiss" }),
          onClick: () => { void usageLimitAttention.dismiss(notification.id); },
          variant: "secondary",
        },
      });
    }

    // ── 0b. Someone a full invite or join link turned away (task #10) ────
    // The server lists them for owners, admins and the link's creator, and
    // only while the seats are full: once a seat is added (or they join) the
    // entry goes. An owner adds the seat; anyone else asks an owner for it.
    // Dismissed per notice: a new one (the person turned away again later) shows.
    for (const block of seatJoinBlocks) {
      out.push({
        id: `seat-join-blocked:${block.id}`,
        kind: "warning",
        title: formatMessage(
          { id: "layout.systemNotifications.seatJoinBlockedTitle" },
          { server: server?.name ?? "", name: block.name },
        ),
        body: (
          <span className="text-foreground-muted">
            {formatMessage({ id: "layout.systemNotifications.seatJoinBlockedBody" }, { name: block.name })}
          </span>
        ),
        action: {
          label: formatMessage({
            id: capabilities.manageBilling
              ? "layout.systemNotifications.seatJoinAddSeats"
              : "layout.systemNotifications.seatJoinAskOwner",
          }),
          onClick: () => void openSeatJoinDialog(block, seatJoinUsage),
          variant: "primary",
          opensDialog: true,
        },
        dismissalKey: `seat-join-blocked:${block.id}`,
      });
    }

    // ── 1. Plan downgrade ────────────────────────────────────────────────
    // For a week after the server went back to Free, everyone on it is told
    // what that took away. Only an owner, who can pay, gets the Upgrade button;
    // the sentence stays within the item's two lines.
    if (server && showsPlanDowngradeNotice(server)) {
      const canUpgrade = capabilities.manageBilling;
      out.push({
        id: "plan-downgrade",
        kind: "warning",
        icon: <AlertTriangle size={16} className="text-foreground" />,
        // A later downgrade is a new notice, even after this one was dismissed.
        dismissalKey: `plan-downgrade:${server.planDowngradedAt}`,
        title: formatMessage({ id: "billing.downgraded.title" }, { server: server.name }),
        body: (
          <span>
            {canUpgrade && <PaywallShown gate="plan_downgraded" />}
            {formatMessage(
              { id: "billing.downgraded.whatChanged" },
              { days: PLAN_CONFIG.free.limits.messageHistoryDays },
            )}
          </span>
        ),
        ...(canUpgrade
          ? {
              action: {
                label: formatMessage({ id: "layout.systemNotifications.upgrade" }),
                onClick: () => paywallUpgrade("plan_downgraded"),
                variant: "primary" as const,
              },
            }
          : {}),
      });
    }

    // ── 1b. Joint channels over the free-server limit (contract v0.3 §18.8) ──
    // Admins who are members of the joint get one entry per joint per round;
    // the dismissal key includes the deadline, so the next round resurfaces.
    // Members see the in-channel banner regardless of role.
    if (server?.role === "owner" || server?.role === "admin") {
      for (const joint of channelsList) {
        if (joint.type !== "joint" || !joint.jointOverLimitGraceEndsAt || joint.archivedAt) continue;
        const locked = isJointChannelReadOnly(joint);
        const deadline = formatDate(new Date(joint.jointOverLimitGraceEndsAt), { dateStyle: "medium", timeStyle: "short" });
        out.push({
          id: `joint-over-limit:${joint.id}`,
          kind: locked ? "error" : "warning",
          icon: <AlertTriangle size={16} className="text-foreground" />,
          dismissalKey: `joint-over-limit:${joint.id}:${joint.jointOverLimitGraceEndsAt}:${locked ? "locked" : "grace"}`,
          title: formatMessage(
            { id: locked ? "layout.systemNotifications.jointOverLimitLockedTitle" : "layout.systemNotifications.jointOverLimitTitle" },
            { channel: joint.name },
          ),
          body: (
            <span>
              <PaywallShown gate={locked ? "joint_channel_read_only" : "joint_channel_over_limit"} />
              {formatMessage(
                { id: locked ? "message.chatPanel.jointLocked" : "message.chatPanel.jointOverLimitGrace" },
                { deadline },
              )}
            </span>
          ),
          action: {
            label: formatMessage({ id: "layout.systemNotifications.upgrade" }),
            onClick: () => paywallUpgrade(locked ? "joint_channel_read_only" : "joint_channel_over_limit"),
            variant: "primary",
          },
        });
      }
    }

    // ── 2. Machine state notifications ─────────────────────────────────────────
    if (capabilities.viewMachines && !machineLoading && !agentLoading) {
      const reinstallMachines = machinesNeedingReinstall(machines, currentUserId, capabilities);
      // Computers the web can still upgrade, below a floor whose deadline is
      // set (#proj-o11y:#19): their own entry on both surfaces, so the date is
      // seen by people who never open a Computer page.
      const upgradeByDeadline = machinesNeedingUpgradeByDeadline(machines, currentUserId, capabilities);
      const reinstallIds = new Set([...reinstallMachines, ...upgradeByDeadline].map((m) => m.id));
      // A machine listed in computer-reinstall or computer-upgrade-deadline is
      // not counted again in the phone's computer-attention aggregate.
      const computerAttention = summarizeComputerAttention(
        reinstallIds.size > 0 ? machines.filter((m) => !reinstallIds.has(m.id)) : machines,
      );
      const offlineMachines = machines.filter((m) => !m.isComputer && m.status === "offline");
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
          icon: <Monitor size={16} className="text-foreground" />,
          dismissalKey: `computer-attention:${versionFingerprint}:${problemIds}:${computerAttention.upgradeCount}:${computerAttention.offlineCount}`,
          title: formatMessage({ id: "layout.systemNotifications.computersNeedAttention" }),
          body: <span className="text-foreground-muted">{counts}</span>,
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

      out.push(...computerVersionNotificationEntries({
        machines,
        reinstallMachines,
        upgradeByDeadline,
        currentUserId,
        capabilities,
        dismissedNotificationKeys,
        formatMessage,
        formatDate,
        toComputer: nav.toComputer,
      }));

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
          icon: <WifiOff size={16} className="text-foreground" />,
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
              <span className="text-foreground-muted">
                {formatMessage(
                  { id: "layout.systemNotifications.machineOfflineActiveAgentsBody" },
                  { count: activeAgentsOnOffline.length },
                )}
              </span>
            ) : (
              <span className="text-foreground-muted">
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

      // Low disk space is a machine-wide condition agents cannot fix, so it
      // goes to the person who attached the Computer. Dismissal holds until
      // another Computer joins or the free space drops into a worse band.
      const diskLowMachines = machines.flatMap((machine) => {
        if (!machine.isComputer || !machine.computerAttachedByCurrentUser) return [];
        const diskLow = machineDiskLowPresentation(machine, formatMessage);
        return diskLow ? [{ machine, diskLow }] : [];
      });
      if (diskLowMachines.length > 0) {
        const first = diskLowMachines[0]!;
        out.push({
          id: "machine-disk-low",
          kind: "warning",
          icon: <HardDrive size={16} className="text-foreground" />,
          dismissalKey: `machine-disk-low:${diskLowMachines
            .map(({ machine, diskLow }) => `${machine.id}=${diskLow.band}`)
            .sort()
            .join(",")}`,
          title: formatMessage(
            { id: "layout.systemNotifications.machineDiskLowTitle" },
            { count: diskLowMachines.length },
          ),
          body: (
            <span className="text-foreground-muted">
              {formatMessage(
                { id: "layout.systemNotifications.machineDiskLowBody" },
                { free: first.diskLow.free, total: first.diskLow.total },
              )}
            </span>
          ),
          action: {
            label: formatMessage({ id: "layout.systemNotifications.view" }),
            onClick: () => nav.toMachine(first.machine.id),
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
        icon: <Download size={16} className="text-foreground" />,
        title: formatMessage({ id: "layout.systemNotifications.installRaftTitle" }),
        body: <span className="text-foreground-muted">{formatMessage({ id: "layout.systemNotifications.installRaftBody" })}</span>,
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

    if (server && feedbackUnread > 0) {
      out.push({
        id: "feedback-replies",
        kind: "info",
        icon: <FeedbackIcon width={16} height={16} />,
        title: formatMessage({ id: "layout.systemNotifications.feedbackRepliesTitle" }),
        body: formatMessage({ id: "layout.systemNotifications.feedbackRepliesBody" }, { count: feedbackUnread }),
        action: {
          label: formatMessage({ id: "layout.systemNotifications.feedbackRepliesView" }),
          onClick: () => nav.toSettings("feedback"),
        },
      });
    }

    return out;
  }, [
    secondFactorRecovery,
    appPermissionUpdates,
    feedbackUnread,
    server,
    machines,
    machineLoading,
    allAgents,
    agentLoading,
    channelsList,
    capabilities,
    currentUserId,
    dismissedNotificationKeys,
    nav,
    paywallUpgrade,
    pwaInstallVisible,
    pwaInstallBusy,
    handlePwaInstall,
    handleDismissPwaInstall,
    surface,
    formatMessage,
    formatDate,
    locale,
    usageLimitAttention,
    seatJoinBlocks,
    seatJoinUsage,
    pendingJointInvites,
    acceptingJointInviteId,
    acceptJointInvite,
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
