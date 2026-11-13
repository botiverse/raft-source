import { forwardRef, useCallback } from "react";
import { CheckCircle2 } from "lucide-react";
import { useIntl } from "react-intl";
import {
  EmptyStateContent,
  EmptyStateDescription,
  EmptyStateIcon,
  EmptyStateTitle,
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
} from "@botiverse/raft-ui";
import type { NotificationAction, NotificationEntry } from "./useSystemNotifications";
import { useDismissedNotificationStore } from "./dismissedNotificationStore";

export interface NotificationCenterProps {
  notifications: NotificationEntry[];
  /** "top-bar": the desktop-width panel, hung under the top bar's Bell instead of beside the rail. */
  flavor: "desktop" | "mobile" | "top-bar";
  /** Closes the center (its popover's own `close`), before an action that opens a dialog. */
  close?: () => void;
}

function initialFocusForKeyboardOpen(openType: string) {
  return openType === "keyboard";
}

const NotificationCenter = forwardRef<HTMLDivElement, NotificationCenterProps>(
  function NotificationCenter({ notifications, flavor, close }, ref) {
    const { formatMessage } = useIntl();
    const dismiss = useDismissedNotificationStore((state) => state.dismiss);

    return (
      <NotificationCenterPopup
        ref={ref}
        data-testid="notification-center"
        viewport={flavor === "mobile" ? "mobile" : "desktop"}
        size="md"
        // The desktop panel stays 320px. On a phone raft-ui sizes it to the
        // screen, 8px from each edge like the server list (at most 480px,
        // for landscape), which a fixed 320px would break.
        className={flavor === "mobile" ? undefined : "w-80"}
        side={flavor === "desktop" ? "right" : "bottom"}
        align="end"
        sideOffset={8}
        initialFocus={initialFocusForKeyboardOpen}
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
            // NotificationCenterEmptyState is raft-ui's EmptyState root; the
            // popup is narrow, so it keeps the tighter padding it had.
            <NotificationCenterEmptyState className="px-4 py-8">
              <EmptyStateIcon>
                <CheckCircle2 />
              </EmptyStateIcon>
              <EmptyStateContent>
                <EmptyStateTitle>{formatMessage({ id: "ui.notificationCenter.emptyTitle" })}</EmptyStateTitle>
                <EmptyStateDescription>{formatMessage({ id: "ui.notificationCenter.emptyBody" })}</EmptyStateDescription>
              </EmptyStateContent>
            </NotificationCenterEmptyState>
          ) : (
            <NotificationCenterList aria-label={formatMessage({ id: "ui.notificationCenter.listAriaLabel" })}>
              {notifications.map((entry) => (
                // pl-3, not px-3: px-3 overrode raft-ui's end padding for the
                // unread mark (pr-[37px]), so a title long enough ran under it.
                <NotificationCenterItem key={entry.id} className="pl-3 py-3">
                  <NotificationCenterItemRow>
                    <NotificationCenterItemIcon status={entry.kind}>
                      {entry.icon}
                    </NotificationCenterItemIcon>
                    <NotificationCenterItemContent>
                      <NotificationCenterItemTitle>{entry.title}</NotificationCenterItemTitle>
                      {entry.body ? (
                        // raft-ui clamps a body to two lines; a security alert's
                        // (until when a reset can finish, what to do if it isn't
                        // you) is never cut off.
                        <NotificationCenterItemBody className={entry.security ? "line-clamp-none" : undefined}>
                          {entry.body}
                        </NotificationCenterItemBody>
                      ) : null}
                      <NotificationActions entry={entry} dismiss={dismiss} close={close} />
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
  close,
}: {
  entry: NotificationEntry;
  dismiss: (key: string) => void;
  close?: () => void;
}) {
  const { formatMessage } = useIntl();
  const { dismissalKey } = entry;
  const handleDismiss = useCallback(() => {
    if (dismissalKey) dismiss(dismissalKey);
  }, [dismiss, dismissalKey]);
  // In-row actions all look the same (raft-ui's outline button); order says
  // which comes first.
  const actions = [entry.action, entry.secondaryAction].filter(
    (action): action is NotificationAction => action != null,
  );

  if (actions.length === 0 && !dismissalKey) return null;
  return (
    <NotificationCenterItemActions className="mt-2 ml-0 flex-wrap justify-start">
      {actions.map((action) => (
        <NotificationActionButton key={action.label} action={action} close={close} />
      ))}
      {dismissalKey ? (
        <NotificationCenterActionButton
          type="button"
          onClick={handleDismiss}
        >
          {formatMessage({ id: "common.announcement.dismiss" })}
        </NotificationCenterActionButton>
      ) : null}
    </NotificationCenterItemActions>
  );
}

/** One row action; one that opens a dialog closes the center first. */
function NotificationActionButton({ action, close }: { action: NotificationAction; close?: () => void }) {
  const { onClick, opensDialog } = action;
  const handleClick = useCallback(() => {
    if (opensDialog) close?.();
    onClick();
  }, [close, onClick, opensDialog]);
  return (
    <NotificationCenterActionButton type="button" onClick={handleClick} disabled={action.disabled}>
      {action.label}
    </NotificationCenterActionButton>
  );
}
