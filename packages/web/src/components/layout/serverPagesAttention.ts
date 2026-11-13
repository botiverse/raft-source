import { useIntl } from "react-intl";
import { useShallow } from "zustand/react/shallow";
import { useFeedbackUnread } from "../../feedback/useFeedbackUnread";
import { useComputerAttentionDot } from "../../hooks/useComputerAttentionDot";
import { useServerPermissions } from "../../hooks/useServerPermissions";
import { useAuthStore } from "../../store/authStore";
import { useServerStore } from "../../store/serverStore";
import { useMachineStore } from "../../store/machineStore";
import { countMachinesNeedingAttention } from "../../utils/computerUpgradeIndicator";
import { useAppPermissionUpdatesSummary } from "./useAppPermissionUpdates";

/**
 * What is new on the server's own pages, for their buttons in the phone server
 * tab's popover (Raft DS › MobileNav, "the server tab"): something new on one
 * of them dots that page's button, never the server tab's avatar, whose dot
 * means only "another server has unread items".
 *
 * - Computers: a computer attention state you have not seen yet (raft-design
 *   #620 "Attention dots"; opening Computers sees it). The desktop rail reads
 *   the same hook, so the two light and clear together. Guests: never.
 * - Apps: an App waits for an owner or admin (a permission update, or agent
 *   prompt text to confirm; `needsAdminReview` on GET
 *   /integrations/permission-updates, #proj-apps task #24). Owners and admins
 *   only; it goes out when that is handled, not when the page is opened.
 * - Settings: feedback has a new reply (the Bell's server-owned count,
 *   `useFeedbackUnread`); the Feedback row inside Settings carries it too.
 *
 * `label` names the dot for assistive tech, with the button's own name.
 */
export interface ServerPageAttention {
  lit: boolean;
  label: string;
}

export function useComputersPageAttention(): ServerPageAttention {
  const { formatMessage } = useIntl();
  const lit = useComputerAttentionDot();
  const [count, total] = useMachineStore(useShallow((s) => [
    countMachinesNeedingAttention(s.machines),
    s.machines.length,
  ] as const));
  return {
    lit,
    label: formatMessage(
      { id: "layout.mobileTabBar.serverPageAttention" },
      {
        page: formatMessage({ id: "layout.sidebar.headerComputers" }),
        what: formatMessage({ id: "layout.leftRail.computersNeedAttentionSummary" }, { count, total }),
      },
    ),
  };
}

export function useSettingsPageAttention(): ServerPageAttention {
  const { formatMessage } = useIntl();
  const feedbackUnread = useFeedbackUnread();
  return {
    lit: feedbackUnread > 0,
    label: formatMessage(
      { id: "layout.mobileTabBar.serverPageAttention" },
      {
        page: formatMessage({ id: "layout.sidebar.headerSettings" }),
        what: formatMessage({ id: "layout.systemNotifications.feedbackRepliesTitle" }),
      },
    ),
  };
}

export function useAppsPageAttention({ enabled = true }: { enabled?: boolean } = {}): ServerPageAttention {
  const { formatMessage } = useIntl();
  const serverId = useServerStore((s) => s.current?.id ?? null);
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const { capabilities } = useServerPermissions();
  const { needsAdminReview } = useAppPermissionUpdatesSummary(serverId, userId, enabled && capabilities.manageIntegrations);
  return {
    lit: needsAdminReview,
    label: formatMessage(
      { id: "layout.mobileTabBar.serverPageAttention" },
      {
        page: formatMessage({ id: "apps.page.title" }),
        what: formatMessage({ id: "apps.page.needsReviewSummary" }),
      },
    ),
  };
}
