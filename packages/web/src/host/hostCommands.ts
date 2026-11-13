// The web's half of the host's command channel (RaftDesktopBridge.commands):
// native input the web cannot receive itself — the desktop app's menus,
// trackpad swipe, mouse side buttons, raft:// links and notification clicks —
// arrives as one typed HostCommand, and the web executes it here with its own
// router, history and stores. The shell only translates input; it never knows
// a route, a store or a DOM node.

import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import type { NavigateFunction } from "react-router-dom";
import { desktopRouteFromPath } from "@botiverse/raft-shared";
import type { HostCommand } from "@botiverse/raft-shared";
import { useServerStore } from "../store/serverStore";
import { useNotificationSettingsStore } from "../store/notificationSettingsStore";
import { pausedUntilForMinutes } from "../notifications/pause";
import { getDesktopBridge } from "../utils/desktopBridge";
import { markMessageLinkHandOff } from "../utils/messageLinkLanding";
import { getServerSwitcherTarget } from "../utils/serverSwitcherNavigation";
import { resolveServerSwitch } from "../utils/serverSwitchTarget";
import { hasOpenLayer } from "../components/topbar/layerGuard";
import { useHistoryStep, useHistoryTracker } from "../components/topbar/historyNavigation";
import { useMachineStore } from "../store/machineStore";
import { getLocalComputerSnapshot } from "../components/machine/localComputer/localComputerStore";
import { correlateSelfMachine } from "../components/machine/localComputer/localComputerLogic";
import { thisDevicePath } from "../components/machine/localComputer/thisDeviceRoute";

export interface HostCommandDeps {
  navigate: (to: string) => void;
  /** A guarded step to the nearest place (historyNavigation.ts). */
  stepHistory: (direction: "back" | "forward") => void;
  /** A dismiss-on-outside layer (dialog, menu) is open. */
  layerOpen: () => boolean;
}

/** Execute one host command. Unknown or malformed commands do nothing. */
export function executeHostCommand(command: HostCommand, deps: HostCommandDeps): void {
  switch (command?.type) {
    case "history":
      if (command.direction === "back" || command.direction === "forward") deps.stepHistory(command.direction);
      return;
    case "open-settings": {
      const slug = useServerStore.getState().current?.slug;
      if (slug) deps.navigate(`/s/${slug}/settings`);
      return;
    }
    case "switch-server": {
      // Menu accelerators fire even with a dialog / menu open (you can't click
      // the switcher then). Switching under a server-scoped dialog would leave
      // it acting on the new server, so an open layer owns the keyboard.
      if (deps.layerOpen()) return;
      const { servers, current } = useServerStore.getState();
      const target = resolveServerSwitch(servers, current?.id ?? null, command);
      // Let the URL be the source of truth; ServerResolver switches the current
      // server after the route changes (same as ServerSwitcherMenu).
      if (target) deps.navigate(getServerSwitcherTarget(target.slug));
      return;
    }
    case "open-route": {
      // The shell already checked the route against the shared prefixes; the
      // web checks again with the same function before navigating anywhere.
      const path = desktopRouteFromPath(command.path);
      if (!path) return;
      // A message link handed over from a browser lands like a fresh load
      // (deep links: the shared "Message not found" state, thread checks).
      markMessageLinkHandOff(path);
      deps.navigate(path);
      return;
    }
    case "pause-notifications": {
      // The tray's Pause notifications ▸ (Windows / Linux): the account setting,
      // so every device of this user goes quiet, not just this one.
      const until = pausedUntilForMinutes(command.minutes, new Date());
      if (until) void useNotificationSettingsStore.getState().patchAccount({ pausedUntil: until.toISOString() });
      return;
    }
    case "open-this-device": {
      // The tray / Dock menu's Open This Device…, Help › Raft Computer
      // Troubleshooting…, a Computer notification: this machine's panel on
      // the current server (its computer page when it is one of them).
      const slug = useServerStore.getState().current?.slug;
      if (!slug) return;
      const { machineIds, hostname } = getLocalComputerSnapshot();
      const machineId = correlateSelfMachine(useMachineStore.getState().machines, { machineIds, hostname })?.id ?? null;
      const section = command.section === "troubleshoot" ? command.section : null;
      deps.navigate(thisDevicePath(slug, machineId, section));
      return;
    }
    default:
      return;
  }
}

/**
 * Mount ONCE inside the router, for the app's whole life (HostIntegration): the
 * history tracker, the server list the host's Server menu names, and the one
 * subscription to the host's commands. Inert without a host bridge, except the
 * history tracker, which the top bar's own ‹ › read wherever a host asks for them.
 */
function useHostIntegration(): void {
  useHistoryTracker();
  const stepHistory = useHistoryStep();
  // useNavigate() changes identity on every location change; keep it in a ref
  // so the subscription registers once (a re-subscribe could replay nothing,
  // but it would churn the preload's listener set on every navigation).
  const navigate = useNavigate();
  const navigateRef = useRef<NavigateFunction>(navigate);
  navigateRef.current = navigate;
  const stepRef = useRef(stepHistory);
  stepRef.current = stepHistory;

  const servers = useServerStore((s) => s.servers);
  const currentId = useServerStore((s) => s.current?.id ?? null);
  useEffect(() => {
    getDesktopBridge()?.setServerList?.({ servers: servers.map((s) => ({ id: s.id, name: s.name })), currentId });
  }, [servers, currentId]);

  useEffect(() => {
    const bridge = getDesktopBridge();
    if (!bridge?.commands) return;
    const unsubscribe = bridge.commands.on((command) => executeHostCommand(command, {
      navigate: (to) => { void navigateRef.current(to); },
      stepHistory: (direction) => { stepRef.current(direction); },
      layerOpen: () => hasOpenLayer(document),
    }));
    return () => unsubscribe();
  }, []);
}

/** Renders nothing; see useHostIntegration. */
export function HostIntegration(): null {
  useHostIntegration();
  return null;
}
