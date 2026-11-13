import { readServerSurfaceMemory } from "../hooks/useTabRouteMemory";

export interface ServerSwitcherAuxClickEvent {
  button: number;
  preventDefault: () => void;
  stopPropagation: () => void;
}

export type ReadServerSurface = (serverSlug: string) => string | null;
export type OpenNewTab = (url: string, target: "_blank", features: "noopener,noreferrer") => unknown;

export function getServerSwitcherTarget(
  serverSlug: string,
  readSurface: ReadServerSurface = readServerSurfaceMemory,
): string {
  return readSurface(serverSlug) ?? `/s/${serverSlug}`;
}

export function openServerSwitcherAuxClickTarget(
  event: ServerSwitcherAuxClickEvent,
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
  openNewTab(targetHref ?? getServerSwitcherTarget(serverSlug, readSurface), "_blank", "noopener,noreferrer");
  return true;
}
