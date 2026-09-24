import Banner from "../ui/Banner";

export type ConnectedAppsErrorSurface = "none" | "page" | "listing" | "form" | "modal";

export const CONNECTED_APPS_ERROR_PAGE = "page";
export const CONNECTED_APPS_ERROR_LISTING = "listing";
export const CONNECTED_APPS_ERROR_FORM = "form";

export function getConnectedAppsErrorSurface(
  error: string,
  selectedListing: unknown,
  selectedBuiltInApp: unknown,
  showRegisterDrawer: boolean,
  deleteClientTarget: unknown,
  offlineRequestTarget: unknown,
  marketplaceUninstallTarget: unknown,
): ConnectedAppsErrorSurface {
  if (!error) return "none";
  if (selectedListing) return "listing";
  if (showRegisterDrawer) return "form";
  if (selectedBuiltInApp || deleteClientTarget || offlineRequestTarget || marketplaceUninstallTarget) return "modal";
  return "page";
}

export function ConnectedAppsErrorBanner({
  surface,
  target,
  error,
}: {
  surface: ConnectedAppsErrorSurface;
  target: ConnectedAppsErrorSurface;
  error: string;
}) {
  if (surface !== target) return null;
  return <Banner intent="warning" density="sm" className="font-bold">{error}</Banner>;
}
