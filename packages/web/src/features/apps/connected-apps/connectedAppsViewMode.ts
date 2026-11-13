import type { ConnectedAppsViewMode } from "./connectedAppTypes";

export const CONNECTED_APPS_VIEW_MODE_STORAGE_KEY = "raft:connected-apps:view-mode";

export function getInitialConnectedAppsViewMode(): ConnectedAppsViewMode {
  if (typeof window === "undefined") return "grid";
  try {
    return window.localStorage.getItem(CONNECTED_APPS_VIEW_MODE_STORAGE_KEY) === "list" ? "list" : "grid";
  } catch {
    return "grid";
  }
}

export function connectedAppsCollectionClassName(viewMode: ConnectedAppsViewMode) {
  return viewMode === "grid" ? "grid gap-3 md:grid-cols-2" : "stack-y-2";
}
