// @ts-nocheck
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");
const read = (path: string) => readFileSync(resolve(repoRoot, path), "utf8");

test("left rail and mobile sidebar use the notification trigger", () => {
  const leftRail = read("src/components/layout/LeftRail.tsx");
  const sidebar = read("src/components/layout/Sidebar.tsx");

  assert.match(leftRail, /import NotificationTrigger from "\.\/NotificationTrigger";/);
  assert.match(sidebar, /import NotificationTrigger from "\.\/NotificationTrigger";/);
  assert.doesNotMatch(leftRail, /WarningTrigger/);
  assert.doesNotMatch(sidebar, /WarningTrigger/);
});

test("notification center exposes notification test ids and wording", () => {
  const trigger = read("src/components/layout/NotificationTrigger.tsx");
  const adapter = read("src/components/layout/NotificationCenter.tsx");
  const primitive = read("src/components/ui/NotificationCenter.tsx");
  const enCatalog = read("src/i18n/messages/en.ts");
  const zhCatalog = read("src/i18n/messages/zh-cn.ts");

  assert.match(trigger, /testId=\{flavor === "rail-bottom" \? "notification-trigger-rail" : "notification-trigger-mobile"\}/);
  assert.match(trigger, /import Tooltip from "\.\.\/ui\/Tooltip";/);
  assert.match(trigger, /id: "layout\.notifications\.centerTooltip"/);
  assert.match(trigger, /<Tooltip\s+content=\{formatMessage\(\{ id: "layout\.notifications\.centerTooltip" \}\)\}/);
  assert.match(trigger, /contentProps=\{\{ side: "bottom", className: "bg-white" \}\}/);
  assert.doesNotMatch(trigger, /contentProps=\{\{ side: "right", className: "bg-white" \}\}/);
  assert.doesNotMatch(trigger, /title=/);
  assert.match(enCatalog, /"layout\.notifications\.centerTooltip": "Notifications"/);
  assert.match(zhCatalog, /"layout\.notifications\.centerTooltip": "通知"/);
  assert.match(trigger, /import \{ Bell \} from "lucide-react";/);
  assert.match(trigger, /bg-brutal-pink/);
  assert.match(trigger, /data-state=\{open \? "open" : "closed"\}/);
  assert.match(trigger, /data-has-unread=\{hasUnread \? "true" : "false"\}/);
  assert.match(trigger, /-end-1/);
  assert.doesNotMatch(trigger, /-(?:left|right)-1[^0-9]/);
  assert.doesNotMatch(trigger, /notifications\.length === 0 && !open/);
  assert.doesNotMatch(trigger, /if \(open && notifications\.length === 0\)/);
  assert.doesNotMatch(trigger, /AlertTriangle|KIND_BUTTON_BG|KIND_DOT_BG|bg-brutal-orange/);
  assert.match(adapter, /data-testid="notification-center"/);
  assert.match(adapter, /id: "ui\.notificationCenter\.title"/);
  assert.match(primitive, /id: "ui\.notificationCenter\.title"/);
  assert.match(enCatalog, /"ui\.notificationCenter\.title": "Notifications"/);
  assert.match(primitive, /import EmptyState from "\.\/EmptyState";/);
  assert.doesNotMatch(trigger, /warning-trigger-/);
  assert.doesNotMatch(adapter, /warning-center/);
  assert.doesNotMatch(primitive, /warning-center/);
});

test("notification center primitive keeps desktop fixed and mobile content-capped", () => {
  const primitive = read("src/components/ui/NotificationCenter.tsx");

  assert.match(primitive, /desktop:\s*\{\s*compact: "h-56",\s*regular: "h-72",\s*large: "h-96"/);
  assert.match(primitive, /mobile:\s*\{\s*compact: "max-h-\[min\(64dvh,224px\)\]"/);
  assert.match(primitive, /regular: "max-h-\[min\(72dvh,288px\)\]"/);
  assert.match(primitive, /large: "max-h-\[min\(80dvh,384px\)\]"/);
  assert.match(primitive, /overflow-y-auto overscroll-contain/);
});

test("system notification entries use kind, not warning severity", () => {
  const notifications = read("src/components/layout/useSystemNotifications.tsx");
  const kind = read("src/components/layout/notificationKind.ts");

  assert.match(notifications, /export interface NotificationEntry \{/);
  assert.match(notifications, /kind: NotificationKind;/);
  assert.doesNotMatch(notifications, /severity: WarningSeverity/);
  assert.match(kind, /export type NotificationKind = "error" \| "warning" \| "info";/);
});

test("joint channel invites are accepted from email links, not notification center rows", () => {
  const notifications = read("src/components/layout/useSystemNotifications.tsx");
  const app = read("src/App.tsx");

  assert.doesNotMatch(notifications, /joint-invites/);
  assert.doesNotMatch(notifications, /Joint channel invite/);
  assert.match(app, /jointInvite/);
  assert.match(app, /\/channels\/joint-invites\/\$\{encodeURIComponent\(jointInviteId\)\}\/accept/);
});

test("rail Help and Notification use raft-ui hover triggers", () => {
  const leftRail = read("src/components/layout/LeftRail.tsx");
  const trigger = read("src/components/layout/NotificationTrigger.tsx");

  assert.match(leftRail, /import \{ Popover, PopoverContent, PopoverTrigger \} from "raft-ui";/);
  assert.match(leftRail, /<PopoverTrigger\s+openOnHover\s+delay=\{0\}\s+closeDelay=\{120\}/);
  assert.match(leftRail, /forwardRef<HTMLButtonElement, RailTabButtonProps>/);
  assert.match(leftRail, /<button\s+\{\.\.\.buttonProps\}/);
  assert.match(trigger, /NotificationCenter as RaftNotificationCenter/);
  assert.match(trigger, /<PopoverTrigger openOnHover delay=\{0\} closeDelay=\{120\}/);
  assert.doesNotMatch(leftRail, /setTimeout|document\.addEventListener/);
  assert.doesNotMatch(trigger, /setTimeout|document\.addEventListener|useViewportClamp/);
});

test("slock system notifications are rendered with raft-ui notification-center primitives", () => {
  const adapter = read("src/components/layout/NotificationCenter.tsx");

  assert.match(adapter, /NotificationCenterPopup/);
  assert.match(adapter, /NotificationCenterItem/);
  assert.match(adapter, /from "raft-ui";/);
  assert.match(adapter, /dismissedNotificationStore/);
  assert.doesNotMatch(adapter, /KIND_DOT_BG/);
  assert.doesNotMatch(adapter, /DEFAULT_KIND_ICON/);
});

test("dismissed notification fingerprints persist per server across refresh", () => {
  const store = read("src/components/layout/dismissedNotificationStore.ts");
  const notifications = read("src/components/layout/useSystemNotifications.tsx");

  assert.match(store, /STORAGE_PREFIX = "slock:notification-center:dismissed"/);
  assert.match(store, /loadForServer: \(serverId: string \| null\) => void/);
  assert.match(store, /window\.localStorage\.setItem\(storageKey, JSON\.stringify/);
  assert.match(notifications, /loadDismissedNotifications\(serverId\)/);
  assert.doesNotMatch(notifications, /resetDismissedNotifications\(\)/);
});
