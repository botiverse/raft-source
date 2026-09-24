import { forwardRef, useState } from "react";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { Bell } from "lucide-react";
import { useIntl } from "react-intl";
import {
  NotificationCenter as RaftNotificationCenter,
  PopoverTrigger,
} from "raft-ui";
import NotificationCenter from "./NotificationCenter";
import Tooltip from "../ui/Tooltip";
import { useVisibleNotifications } from "./useSystemNotifications";
import type { NotificationEntry } from "./useSystemNotifications";

export interface NotificationTriggerProps {
  flavor: "rail-bottom" | "mobile-navbar";
  notifications?: NotificationEntry[];
}

export default function NotificationTrigger({
  flavor,
  notifications: notificationsProp,
}: NotificationTriggerProps) {
  // oxlint-disable-next-line react-doctor/no-event-handler -- flavor is static per mounted trigger.
  const liveNotifications = useVisibleNotifications(flavor === "mobile-navbar" ? "mobile" : "desktop");
  // oxlint-disable-next-line react-doctor/no-event-handler -- pre-existing prop-derived test override.
  const notifications = notificationsProp ?? liveNotifications;
  const [open, setOpen] = useState(false);
  const { formatMessage } = useIntl();
  const hasUnread = notifications.length > 0;
  const ariaLabel = hasUnread
    ? formatMessage({ id: "layout.notifications.centerActiveAria" }, { count: notifications.length })
    : formatMessage({ id: "layout.notifications.centerAria" });

  const button = (
    <NotificationTriggerButton
      open={open}
      hasUnread={hasUnread}
      ariaLabel={ariaLabel}
      testId={flavor === "rail-bottom" ? "notification-trigger-rail" : "notification-trigger-mobile"}
      sizeClass={flavor === "rail-bottom" ? "size-10" : "size-8"}
      icon={<Bell size={flavor === "rail-bottom" ? 18 : 16} className="text-black" />}
    />
  );

  return (
    <RaftNotificationCenter open={open} onOpenChange={setOpen}>
      <div className={`relative ${flavor === "rail-bottom" ? "flex h-11 w-full items-center justify-center" : "shrink-0"}`}>
        {flavor === "mobile-navbar" ? (
          <Tooltip
            content={formatMessage({ id: "layout.notifications.centerTooltip" })}
            contentProps={{ side: "bottom", className: "bg-white" }}
          >
            <PopoverTrigger render={button} />
          </Tooltip>
        ) : (
          // The generic raft-ui trigger keeps the rail-owned 40px Bell visual;
          // NotificationCenterTrigger is a complete orange button recipe.
          <PopoverTrigger openOnHover delay={0} closeDelay={120} render={button} />
        )}
        <NotificationCenter
          notifications={notifications}
          flavor={flavor === "rail-bottom" ? "desktop" : "mobile"}
        />
      </div>
    </RaftNotificationCenter>
  );
}

type NotificationTriggerButtonProps = Omit<ComponentPropsWithoutRef<"button">, "children"> & {
  open: boolean;
  hasUnread: boolean;
  ariaLabel: string;
  testId: string;
  sizeClass: string;
  icon: ReactNode;
};

const NotificationTriggerButton = forwardRef<HTMLButtonElement, NotificationTriggerButtonProps>(function NotificationTriggerButton({
  open,
  hasUnread,
  ariaLabel,
  testId,
  sizeClass,
  icon,
  className = "",
  ...buttonProps
}, ref) {
  return (
    <button
      {...buttonProps}
      ref={ref}
      type="button"
      aria-label={ariaLabel}
      data-state={open ? "open" : "closed"}
      data-has-unread={hasUnread ? "true" : "false"}
      data-testid={testId}
      className={`relative inline-flex ${sizeClass} items-center justify-center border-2 transition-colors ${
        open
          ? "border-black bg-white shadow-brutal-sm"
          : "border-transparent bg-transparent hover:border-black hover:bg-white"
      } ${className}`}
    >
      <span className="relative inline-flex items-center justify-center">
        {icon}
        {hasUnread ? (
          <span
            className="pointer-events-none absolute -top-1 -end-1 size-2.5 rounded-full border border-black bg-brutal-pink"
            data-testid={`${testId}-unread-dot`}
            aria-hidden="true"
          />
        ) : null}
      </span>
    </button>
  );
});
