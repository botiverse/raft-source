// The unified notification system's client runtime, for the signed-in app's
// whole life (App.tsx, beside DesktopNativeNotifications). Renders nothing.
//   - presence:activity (presenceReport.ts): the desktop flavour inside Raft
//     Desktop (the shell's window activity), the web flavour elsewhere;
//   - notification:retract (retractConsumer.ts): the shell's clearGroup, or
//     the service worker;
//   - the badge (badge.ts): setBadgeCount, or title / favicon / app badge;
//   - the account settings and server levels the badge needs, loaded on mount,
//     on every socket (re)connect, and for the current server when it changes.
// Not in Raft's own mobile app (host shell): it reports its own presence and
// badge natively, and reads the document title for its header.

import { useEffect } from "react";
import { isHostShell } from "../embed";
import { useNotificationSettingsStore } from "../store/notificationSettingsStore";
import { useServerStore } from "../store/serverStore";
import { useChannelStore } from "../store/channelStore";
import { useThreadStore } from "../store/threadStore";
import { getDesktopBridge } from "../utils/desktopBridge";
import { desktopBadgeRenderer, startNotificationBadge, webBadgeRenderer } from "./badge";
import { appSocketSource } from "./desktopNative/appSocketSource";
import { listenOnEverySocket } from "./desktopNative/followSocket";
import { startDesktopPresenceReport, startWebPresenceReport } from "./presenceReport";
import { desktopRetract, startRetractConsumer, webRetract } from "./retractConsumer";

export function startNotificationRuntime(): () => void {
  const bridge = getDesktopBridge();
  const stops: Array<() => void> = [];

  stops.push(bridge && typeof bridge.onWindowActivity === "function"
    ? startDesktopPresenceReport(bridge, { sockets: appSocketSource })
    : startWebPresenceReport({ sockets: appSocketSource }));

  stops.push(startRetractConsumer(
    appSocketSource,
    bridge && typeof bridge.notifications?.clearGroup === "function" ? desktopRetract(bridge) : webRetract(),
  ));

  stops.push(startNotificationBadge(
    bridge && typeof bridge.setBadgeCount === "function" ? desktopBadgeRenderer(bridge) : webBadgeRenderer(),
  ));

  const settings = () => useNotificationSettingsStore.getState();
  void settings().loadAccount();
  stops.push(listenOnEverySocket(appSocketSource, "connect", () => { void settings().loadAccount(); }));

  let serverId: string | null = null;
  const onServer = () => {
    const next = useServerStore.getState().current?.id ?? null;
    if (next === serverId) return;
    serverId = next;
    if (next) void settings().loadServerLevels(next);
  };
  onServer();
  stops.push(useServerStore.subscribe(onServer));

  // Channel and thread payloads carry their explicit `notificationLevel`.
  const seedChannels = () => {
    const id = useServerStore.getState().current?.id;
    if (!id) return;
    const { channels, dmChannels } = useChannelStore.getState();
    settings().seedLevelsFromPayloads(id, "channel", [...channels, ...dmChannels]);
  };
  const seedThreads = () => {
    const id = useServerStore.getState().current?.id;
    if (!id) return;
    settings().seedLevelsFromPayloads(id, "thread", useThreadStore.getState().followedThreads.map((t) => ({ id: t.threadChannelId, notificationLevel: t.notificationLevel })));
  };
  seedChannels();
  seedThreads();
  let lastChannels = useChannelStore.getState().channels;
  let lastDms = useChannelStore.getState().dmChannels;
  stops.push(useChannelStore.subscribe((state) => {
    if (state.channels === lastChannels && state.dmChannels === lastDms) return;
    lastChannels = state.channels;
    lastDms = state.dmChannels;
    seedChannels();
  }));
  let lastThreads = useThreadStore.getState().followedThreads;
  stops.push(useThreadStore.subscribe((state) => {
    if (state.followedThreads === lastThreads) return;
    lastThreads = state.followedThreads;
    seedThreads();
  }));

  return () => {
    for (const stop of stops.reverse()) stop();
    // Signed out (or another user): nothing of this account's settings stays.
    settings().reset();
  };
}

export default function NotificationRuntime(): null {
  useEffect(() => {
    if (isHostShell()) return;
    return startNotificationRuntime();
  }, []);
  return null;
}
