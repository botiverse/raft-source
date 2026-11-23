import { placeFor } from "../hooks/placeMemory";

export interface ServerSwitcherAuxClickEvent {
  button: number;
  preventDefault: () => void;
  stopPropagation: () => void;
}

export type ReadServerPlace = (serverSlug: string) => string;
export type OpenNewTab = (url: string, target: "_blank", features: "noopener,noreferrer") => unknown;

/** A server switch lands on that server's place (placeMemory): its last tab's page, without a pane. */
export function getServerSwitcherTarget(
  serverSlug: string,
  readPlace: ReadServerPlace = placeFor,
): string {
  return readPlace(serverSlug);
}

export function openServerSwitcherAuxClickTarget(
  event: ServerSwitcherAuxClickEvent,
  serverSlug: string,
  {
    readPlace = placeFor,
    openNewTab = window.open,
    targetHref,
  }: {
    readPlace?: ReadServerPlace;
    openNewTab?: OpenNewTab;
    targetHref?: string;
  } = {},
): boolean {
  if (event.button !== 1) return false;
  event.preventDefault();
  event.stopPropagation();
  openNewTab(targetHref ?? getServerSwitcherTarget(serverSlug, readPlace), "_blank", "noopener,noreferrer");
  return true;
}
