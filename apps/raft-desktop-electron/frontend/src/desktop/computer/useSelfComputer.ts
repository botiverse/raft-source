// Desktop-only "this machine" identity.
//
// The Raft Desktop app is also the local Computer host. This hook answers "which
// row in the server-derived machine list is the machine THIS app runs on?" so
// the self-card can BE that computer (merged, pinned, marked "This device")
// instead of appearing twice — once as a generic self-card and once as a normal
// row. It is inert on web (no bridge) and returns null when nothing correlates.
//
// Correlation prefers the local attachment's machineId (authoritative), then
// falls back to OS hostname — which covers older (pre-machineId) attachments,
// exactly the case that made kabi and "This Computer" look like two things.
//
// This lives in the desktop app (not packages/web): the web/mobile bundle is
// shared and stays free of desktop-only concerns; the desktop reuses the web's
// stores via the @web alias.
import { useEffect, useMemo, useState } from "react";
import { useMachineStore, type Machine } from "@web/store/machineStore";
import { correlateSelfMachine } from "./thisComputerLogic";

export interface ComputerBridge {
  hostCapable: boolean;
  getLocalInfo?: () => Promise<{ hostname: string }>;
  getStatus: () => Promise<unknown>;
  onStatus: (handler: (status: unknown) => void) => () => void;
  enable: (input: {
    serverSlug: string;
    serverUrl: string;
    accessToken: string;
    refreshToken: string;
    name?: string;
  }) => Promise<unknown>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  restart: () => Promise<void>;
  getUpgradeInfo?: () => Promise<{ latestVersion: string | null }>;
  upgrade?: () => Promise<void>;
  upgradeViaFreshInstall?: (version: string) => Promise<void>;
  getManagement?: () => Promise<{ model: "app" | "standalone" | "unknown" }>;
}

export function getComputerBridge(): ComputerBridge | null {
  const bridge = (globalThis as { raftDesktop?: { computer?: ComputerBridge } }).raftDesktop?.computer;
  return bridge?.hostCapable ? bridge : null;
}

interface LocalStatusShape {
  servers?: { machineId?: string | null }[];
}

/**
 * The machineStore machine this app is running on, or null. Reactive to both the
 * local host status (attachment machineIds) and the live machine list.
 */
export function useSelfMachine(): Machine | null {
  const machines = useMachineStore((s) => s.machines);
  const bridge = getComputerBridge();
  const [localMachineIds, setLocalMachineIds] = useState<string[]>([]);
  const [hostname, setHostname] = useState<string | null>(null);

  useEffect(() => {
    if (!bridge) return;
    let alive = true;
    void bridge.getLocalInfo?.().then((info) => {
      if (alive) setHostname(info?.hostname ?? null);
    }).catch(() => {});
    const apply = (status: unknown) => {
      const rows = (status as LocalStatusShape | null)?.servers ?? [];
      if (alive) setLocalMachineIds(rows.map((r) => r.machineId).filter((id): id is string => typeof id === "string" && id.length > 0));
    };
    void bridge.getStatus().then(apply).catch(() => {});
    const unsubscribe = bridge.onStatus(apply);
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [bridge]);

  return useMemo(() => {
    if (!bridge) return null;
    return correlateSelfMachine(machines, localMachineIds, hostname);
  }, [bridge, machines, localMachineIds, hostname]);
}
