import { forwardRef, useCallback, useRef, useState } from "react";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { Bell, ShieldAlert } from "lucide-react";
import { useIntl } from "react-intl";
import {
  AppRailItemAttention,
  IconTile,
  NotificationCenter,
  PopoverTrigger,
  Status,
} from "@botiverse/raft-ui";
import type { NotificationCenterProps } from "@botiverse/raft-ui";
import ConnectedNotificationCenter from "./NotificationCenter";
import Tooltip from "../ui/Tooltip";
import { useVisibleNotifications } from "./useSystemNotifications";
import { useFirstScreenDone } from "../../boot/deferredUi";
import type { NotificationEntry } from "./useSystemNotifications";

const MOBILE_TOOLTIP_CONTENT_PROPS = { side: "bottom" } as const;

/** The center's imperative actions (its popover's `close` and `unmount`). */
type NotificationCenterActions = NonNullable<NonNullable<NotificationCenterProps["actionsRef"]>["current"]>;

export interface NotificationTriggerProps {
  /** "top-bar": the desktop-width Bell in the top bar's right region (task #753). */
  flavor: "rail-bottom" | "mobile-navbar" | "top-bar";
  notifications?: NotificationEntry[];
}

/**
 * The notification centre's sources (joint invites, seat blocks, system
 * notifications, app permission updates, feedback) are read once the first
 * screen is done; until then the Bell shows as pending (boot/deferredUi).
 */
export default function NotificationTrigger(props: NotificationTriggerProps) {
  const firstScreenDone = useFirstScreenDone();
  if (!props.notifications && !firstScreenDone) return <PendingNotificationTrigger flavor={props.flavor} />;
  return <LiveNotificationTrigger {...props} />;
}

function LiveNotificationTrigger({
  flavor,
  notifications: notificationsProp,
}: NotificationTriggerProps) {
  // oxlint-disable-next-line react-doctor/no-event-handler -- flavor is static per mounted trigger.
  const liveNotifications = useVisibleNotifications(flavor === "mobile-navbar" ? "mobile" : "desktop");
  // oxlint-disable-next-line react-doctor/no-event-handler -- pre-existing prop-derived test override.
  const notifications = notificationsProp ?? liveNotifications;
  const [open, setOpen] = useState(false);
  const centerActions = useRef<NotificationCenterActions | null>(null);
  const closeCenter = useCallback(() => centerActions.current?.close(), []);
  const { formatMessage } = useIntl();
  const unreadCount = notifications.filter((notification) => notification.unread !== false).length;
  const hasUnread = unreadCount > 0;
  // An account-security entry (a two-step verification reset) is never read
  // or dismissed, so while it is listed there is always something unread.
  const securityAlert = notifications.some((notification) => notification.security);
  const ariaLabel = securityAlert
    ? formatMessage({ id: "layout.notifications.centerSecurityAria" }, { count: unreadCount })
    : hasUnread
      ? formatMessage({ id: "layout.notifications.centerActiveAria" }, { count: unreadCount })
      : formatMessage({ id: "layout.notifications.centerAria" });
  const handleOpenChange = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen) {
      for (const notification of notifications) {
        if (notification.unread !== false) notification.onSeen?.();
      }
    }
  }, [notifications]);

  const button = (
    <NotificationTriggerButton
      open={open}
      hasUnread={hasUnread}
      securityAlert={securityAlert}
      ariaLabel={ariaLabel}
      testId={flavor === "rail-bottom" ? "notification-trigger-rail" : flavor === "top-bar" ? "notification-trigger-top-bar" : "notification-trigger-mobile"}
      flavor={flavor}
      // Rail and top bar: a 40px frame item (36 in short windows) with the
      // rail's 20px glyph; phone home bar: a 44px frame icon button (22px glyph).
      // The rail's 40px item (36 in short windows), the top bar's 36px item,
      // the phone nav bar's 44px button.
      sizeClass={flavor === "mobile-navbar" ? "size-11" : flavor === "top-bar" ? "size-(--frame-item-height)" : "size-(--rail-item) [@media(max-height:600px)]:size-9"}
      icon={<Bell aria-hidden="true" className={flavor === "mobile-navbar" ? "size-[22px]" : "size-5"} />}
    />
  );

  return (
    <NotificationCenter open={open} onOpenChange={handleOpenChange} actionsRef={centerActions}>
      <div className={`relative ${flavor === "rail-bottom" ? "flex w-full justify-center" : "shrink-0"}`}>
        {flavor !== "rail-bottom" ? (
          <Tooltip
            content={formatMessage({ id: "layout.notifications.centerTooltip" })}
            contentProps={MOBILE_TOOLTIP_CONTENT_PROPS}
          >
            <PopoverTrigger render={button} />
          </Tooltip>
        ) : (
          // The generic raft-ui trigger keeps the rail-owned 40px Bell visual;
          // NotificationCenterTrigger is a complete orange button recipe.
          <PopoverTrigger openOnHover delay={0} closeDelay={120} render={button} />
        )}
        <ConnectedNotificationCenter
          notifications={notifications}
          flavor={flavor === "rail-bottom" ? "desktop" : flavor === "top-bar" ? "top-bar" : "mobile"}
          close={closeCenter}
        />
      </div>
    </NotificationCenter>
  );
}

/**
 * The Bell in its place while the server is still being resolved
 * (ShellPendingContext): the same button, with no notifications to read yet.
 */
export function PendingNotificationTrigger({ flavor }: { flavor: "top-bar" | "rail-bottom" | "mobile-navbar" }) {
  const { formatMessage } = useIntl();
  return (
    <div className={`relative ${flavor === "rail-bottom" ? "flex w-full justify-center" : "shrink-0"}`}>
      <NotificationTriggerButton
        open={false}
        hasUnread={false}
        securityAlert={false}
        ariaLabel={formatMessage({ id: "layout.notifications.centerAria" })}
        testId={flavor === "rail-bottom" ? "notification-trigger-rail" : flavor === "top-bar" ? "notification-trigger-top-bar" : "notification-trigger-mobile"}
        flavor={flavor}
        sizeClass={flavor === "mobile-navbar" ? "size-11" : flavor === "top-bar" ? "size-(--frame-item-height)" : "size-(--rail-item) [@media(max-height:600px)]:size-9"}
        icon={<Bell aria-hidden="true" className={flavor === "mobile-navbar" ? "size-[22px]" : "size-5"} />}
      />
    </div>
  );
}

type NotificationTriggerButtonProps = Omit<ComponentPropsWithoutRef<"button">, "children"> & {
  open: boolean;
  hasUnread: boolean;
  /** A security entry is listed: the shield marker instead of the unread dot. */
  securityAlert: boolean;
  ariaLabel: string;
  testId: string;
  flavor: "rail-bottom" | "mobile-navbar" | "top-bar";
  sizeClass: string;
  icon: ReactNode;
};

const NotificationTriggerButton = forwardRef<HTMLButtonElement, NotificationTriggerButtonProps>(function NotificationTriggerButton({
  open,
  hasUnread,
  securityAlert,
  ariaLabel,
  testId,
  flavor,
  sizeClass,
  icon,
  className = "",
  ...buttonProps
}, ref) {
  // Raft Design System: the bell always sits on the frame (the rail, the phone
  // Home bar, the top bar), so it is a frame item: on-frame ink, the frame's
  // pressed wash, and the white (dark: yellow) "you are here" sticker while
  // its list is open.
  const stateClass = open
    ? "border-line-frame-active bg-layer-frame-active text-foreground-on-frame-active"
    : "border-transparent text-foreground-on-frame hover:bg-fill-frame-medium active:bg-fill-frame-medium";
  return (
    <button
      {...buttonProps}
      ref={ref}
      type="button"
      aria-label={ariaLabel}
      data-state={open ? "open" : "closed"}
      data-has-unread={hasUnread ? "true" : "false"}
      data-security-alert={securityAlert ? "true" : "false"}
      data-testid={testId}
      className={`group relative inline-flex ${sizeClass} items-center justify-center rounded-control border-[1.5px] outline-none transition-colors focus-visible:shadow-focus ${stateClass} ${className}`}
    >
      <span className="relative inline-flex items-center justify-center">
        {icon}
        {securityAlert ? (
          // Account security (the two-step verification reset) reads without
          // opening the list: a shield on raft-ui's warning IconTile (Raft DS:
          // orange, never red, for warnings), on the Bell's corner where the
          // unread dot goes. The trigger's name says it ("security alert").
          <IconTile
            variant="warning"
            size="xs"
            className="pointer-events-none absolute -top-2 -end-2"
            data-testid={`${testId}-security-alert`}
          >
            <ShieldAlert />
          </IconTile>
        ) : hasUnread ? (
          flavor === "rail-bottom" ? (
            // task #720: the rail Bell's unread dot rides the SAME composite
            // every other rail item uses (AppRailItemAttention = indicator +
            // sr-only title) instead of a one-off Status
            // dot with a hand-set offset — same size, same position, same
            // theme mapping, same AT announcement, and it tracks future rail
            // recipe changes automatically.
            <AppRailItemAttention title={ariaLabel} />
          ) : (
            <Status
              aria-hidden
              size="md"
              variant="accent"
              className="pointer-events-none absolute -top-1 -end-1"
              data-testid={`${testId}-unread-dot`}
            />
          )
        ) : null}
      </span>
    </button>
  );
});
