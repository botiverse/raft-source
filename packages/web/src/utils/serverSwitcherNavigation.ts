import { readServerSurfaceMemory } from "../hooks/useTabRouteMemory";
import { openDesktopServerWindow, supportsDesktopServerWindowOpen } from "../desktopServerWindow";

export interface ServerSwitcherAuxClickEvent {
  button: number;
  preventDefault: () => void;
  stopPropagation: () => void;
}

export type ReadServerSurface = (serverSlug: string) => string | null;
export type OpenNewTab = (url: string, target: "_blank", features: "noopener,noreferrer") => unknown;

export function getDesktopServerBootstrapTarget(
  search: string,
  servers: ReadonlyArray<{ id: string; slug: string }>,
  readSurface: ReadServerSurface = readServerSurfaceMemory,
): string | null {
  const serverId = new URLSearchParams(search).get("raftDesktopServerId");
  if (!serverId) return null;
  const server = servers.find((candidate) => candidate.id === serverId);
  return server ? getServerSwitcherTarget(server.slug, readSurface) : null;
}

export function openServerSwitcherDesktopTarget(serverId: string): boolean {
  if (!supportsDesktopServerWindowOpen()) return false;
  void openDesktopServerWindow(serverId).catch((error) => {
    console.error("[Raft Desktop] server-window open failed", error);
  });
  return true;
}

export function getServerSwitcherTarget(
  serverSlug: string,
  readSurface: ReadServerSurface = readServerSurfaceMemory,
): string {
  return readSurface(serverSlug) ?? `/s/${serverSlug}`;
}

export function openServerSwitcherAuxClickTarget(
  event: ServerSwitcherAuxClickEvent,
  serverId: string,
  serverSlug: string,
  {
    readSurface = readServerSurfaceMemory,
    openNewTab = window.open,
    targetHref,
  }: {
    readSurface?: ReadServerSurface;
    openNewTab?: OpenNewTab;
    targetHref?: string;
  } = {},
): boolean {
  if (event.button !== 1) return false;
  event.preventDefault();
  event.stopPropagation();
  if (openServerSwitcherDesktopTarget(serverId)) return true;
  openNewTab(targetHref ?? getServerSwitcherTarget(serverSlug, readSurface), "_blank", "noopener,noreferrer");
  return true;
}
