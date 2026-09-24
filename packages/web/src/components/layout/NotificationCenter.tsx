import { forwardRef } from "react";
import { CheckCircle2 } from "lucide-react";
import { useIntl } from "react-intl";
import {
  NotificationCenterActionButton,
  NotificationCenterCount,
  NotificationCenterEmptyState,
  NotificationCenterHeader,
  NotificationCenterItem,
  NotificationCenterItemActions,
  NotificationCenterItemBody,
  NotificationCenterItemContent,
  NotificationCenterItemIcon,
  NotificationCenterItemRow,
  NotificationCenterItemTitle,
  NotificationCenterList,
  NotificationCenterPopup,
  NotificationCenterScroller,
  NotificationCenterTitle,
} from "raft-ui";
import type { NotificationAction, NotificationEntry } from "./useSystemNotifications";
import { useDismissedNotificationStore } from "./dismissedNotificationStore";

export interface NotificationCenterProps {
  notifications: NotificationEntry[];
  flavor: "desktop" | "mobile";
}

const NotificationCenter = forwardRef<HTMLDivElement, NotificationCenterProps>(
  function NotificationCenter({ notifications, flavor }, ref) {
    const { formatMessage } = useIntl();
    const dismiss = useDismissedNotificationStore((state) => state.dismiss);

    return (
      <NotificationCenterPopup
        ref={ref}
        data-testid="notification-center"
        viewport={flavor}
        size="md"
        className="w-80"
        side={flavor === "desktop" ? "right" : "bottom"}
        align="end"
        sideOffset={8}
        initialFocus={(openType) => openType === "keyboard"}
        aria-label={formatMessage({ id: "ui.notificationCenter.ariaLabel" })}
      >
        <NotificationCenterHeader className="px-3">
          <NotificationCenterTitle>
            {formatMessage({ id: "ui.notificationCenter.title" })}
          </NotificationCenterTitle>
          <NotificationCenterCount>
            {notifications.length === 0
              ? formatMessage({ id: "ui.notificationCenter.countAllClear" })
              : formatMessage({ id: "ui.notificationCenter.countItems" }, { count: notifications.length })}
          </NotificationCenterCount>
        </NotificationCenterHeader>
        <NotificationCenterScroller>
          {notifications.length === 0 ? (
            <NotificationCenterEmptyState>
              <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
                <CheckCircle2 size={36} />
                <div className="font-bold">{formatMessage({ id: "ui.notificationCenter.emptyTitle" })}</div>
                <div className="text-sm text-black/60">{formatMessage({ id: "ui.notificationCenter.emptyBody" })}</div>
              </div>
            </NotificationCenterEmptyState>
          ) : (
            <NotificationCenterList aria-label={formatMessage({ id: "ui.notificationCenter.listAriaLabel" })}>
              {notifications.map((entry) => (
                <NotificationCenterItem key={entry.id} className="px-3 py-3">
                  <NotificationCenterItemRow>
                    <NotificationCenterItemIcon status={entry.kind}>
                      {entry.icon}
                    </NotificationCenterItemIcon>
                    <NotificationCenterItemContent>
                      <NotificationCenterItemTitle>{entry.title}</NotificationCenterItemTitle>
                      {entry.body ? <NotificationCenterItemBody>{entry.body}</NotificationCenterItemBody> : null}
                      <NotificationActions entry={entry} dismiss={dismiss} />
                    </NotificationCenterItemContent>
                  </NotificationCenterItemRow>
                </NotificationCenterItem>
              ))}
            </NotificationCenterList>
          )}
        </NotificationCenterScroller>
      </NotificationCenterPopup>
    );
  },
);

export default NotificationCenter;

function NotificationActions({
  entry,
  dismiss,
}: {
  entry: NotificationEntry;
  dismiss: (key: string) => void;
}) {
  const { formatMessage } = useIntl();
  const actions: Array<{ action: NotificationAction; variant: "primary" | "secondary" }> = [];
  if (entry.action) actions.push({ action: entry.action, variant: "primary" });
  if (entry.secondaryAction) actions.push({ action: entry.secondaryAction, variant: "secondary" });

  if (actions.length === 0 && !entry.dismissalKey) return null;
  return (
    <NotificationCenterItemActions className="mt-2 ml-0 flex-wrap justify-start">
      {actions.map(({ action, variant }) => (
        <NotificationCenterActionButton
          key={action.label}
          type="button"
          variant={variant}
          onClick={action.onClick}
          disabled={action.disabled}
        >
          {action.label}
        </NotificationCenterActionButton>
      ))}
      {entry.dismissalKey ? (
        <NotificationCenterActionButton
          type="button"
          variant="secondary"
          onClick={() => entry.dismissalKey && dismiss(entry.dismissalKey)}
        >
          {formatMessage({ id: "common.announcement.dismiss" })}
        </NotificationCenterActionButton>
      ) : null}
    </NotificationCenterItemActions>
  );
}
